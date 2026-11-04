import {
  isClosedTradeOutcome,
  normalizeClosedPnlPercent,
  type ClosedTradeOutcomeRow,
} from "./raw-pnl.js";
import type {
  AltBulletAnalysisGroup,
  AltBulletVerdict,
} from "./altbullet-indicator.js";
import { ALT_BULLET_MIN_CLOSED_SNAPSHOTS } from "./altbullet-indicator.js";

export type AltBulletAnalysisRow = ClosedTradeOutcomeRow & {
  verdict: AltBulletVerdict | string | null | undefined;
  snapshotStatus: string | null | undefined;
  indicatorVersion?: string | null;
  sentimentKey?: string | null;
  checks?: Record<string, boolean | "pass" | "fail" | "unknown"> | null;
  context?: Record<string, unknown> | null;
  entryPrice?: number | null;
  peakPrice?: number | null;
  isShort?: boolean | null;
  drawdownMinPct?: number | null;
  trajectorySamples?: Array<{
    elapsedMs: number;
    pctFromEntry: number;
    snapshotAt?: Date | string;
    status?: string;
  }> | null;
};
export type AltBulletTrajectoryMetrics = {
  available: boolean;
  sampleTrajectoryAvailable: boolean;
  finalSummaryAvailable: boolean;
  mfe: number | null;
  mae: number | null;
  firstSignificantMovementMs: number | null;
  targetBeforeStop:
    | "target_before_stop"
    | "stop_before_target"
    | "unknown"
    | "ambiguous";
  targetBeforeStopReason: string;
};

/** Uses only persisted observations. It never infers event ordering from a final
 * status or coarse interval sample, since that would invent a target/stop time. */
export function calculateAltBulletTrajectory(
  row: AltBulletAnalysisRow,
): AltBulletTrajectoryMetrics {
  const measurable = isClosedTradeOutcome({
    status: row.status,
    cancelReason: row.cancelReason,
    exitPrice: row.exitPrice,
    pnlPercent: row.pnlPercent,
  });
  if (!measurable) {
    return {
      available: false,
      sampleTrajectoryAvailable: false,
      finalSummaryAvailable: false,
      mfe: null,
      mae: null,
      firstSignificantMovementMs: null,
      targetBeforeStop: "unknown",
      targetBeforeStopReason:
        "Траектория показывается только для измеримого закрытого outcome.",
    };
  }
  const direction = row.isShort ? -1 : 1;
  const mfe =
    row.entryPrice &&
    row.entryPrice > 0 &&
    row.peakPrice != null &&
    Number.isFinite(row.peakPrice)
      ? ((row.peakPrice - row.entryPrice) / row.entryPrice) * 100 * direction
      : null;
  const mae =
    row.drawdownMinPct != null && Number.isFinite(row.drawdownMinPct)
      ? row.drawdownMinPct
      : null;
  const movement = (row.trajectorySamples ?? [])
    .filter(
      (sample) =>
        Number.isFinite(sample.pctFromEntry) &&
        Math.abs(sample.pctFromEntry) >= 3,
    )
    .sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  return {
    available: mfe != null || mae != null || !!movement,
    sampleTrajectoryAvailable: (row.trajectorySamples?.length ?? 0) > 0,
    finalSummaryAvailable: mfe != null || mae != null,
    mfe,
    mae,
    firstSignificantMovementMs: movement?.elapsedMs ?? null,
    targetBeforeStop: "unknown",
    targetBeforeStopReason:
      "Нет точных timestamp событий target/stop; интервальные samples не устанавливают порядок.",
  };
}

export type AltBulletTrajectorySummary = {
  total: number; // measurable closed outcomes only
  available: number;
  sampleTrajectoryAvailable: number;
  finalSummaryAvailable: number;
  mfeAverage: number | null;
  maeAverage: number | null;
  firstSignificantMovementAverageMs: number | null;
  targetBeforeStop: {
    targetBeforeStop: number;
    stopBeforeTarget: number;
    unknown: number;
    ambiguous: number;
  };
};

export type AltBulletAnalysisAggregates = {
  groups: AltBulletAnalysisGroup[];
  closedSnapshots: number;
  totalSnapshots: number;
  readySnapshots: number;
  unavailableSnapshots: number;
  byVersion: AltBulletDimensionGroup[];
  byCheckState: AltBulletDimensionGroup[];
  byPattern: AltBulletDimensionGroup[];
  byBtcRegime: AltBulletDimensionGroup[];
  trajectory: AltBulletTrajectorySummary;
};
export type AltBulletDimensionGroup = {
  key: string;
  total: number;
  closed: number;
  successful: number;
  successRate: number | null;
  averagePnl: number | null;
  lowSample: boolean;
};

const VERDICTS: readonly AltBulletVerdict[] = [
  "confirmed",
  "partial_conflict",
  "strong_conflict",
];
const SUCCESSFUL_STATUSES = new Set(["profit", "bu_stop"]);

/**
 * Aggregates only immutable AltBullet snapshots joined to their tracked signal.
 * Cancellations are outcomes only when both a real exit price and finite PnL
 * were recorded; administrative or unknown-outcome cancellations are omitted
 * from coverage and success-rate denominators.
 */
export function aggregateAltBulletAnalysis(
  rows: readonly AltBulletAnalysisRow[],
): AltBulletAnalysisAggregates {
  type Bucket = {
    verdict: AltBulletVerdict;
    total: number;
    closed: number;
    successful: number;
    pnlSum: number;
    pnlCount: number;
  };
  const empty = (verdict: AltBulletVerdict): Bucket => ({
    verdict,
    total: 0,
    closed: 0,
    successful: 0,
    pnlSum: 0,
    pnlCount: 0,
  });
  const buckets = new Map<AltBulletVerdict, Bucket>(
    VERDICTS.map((verdict) => [verdict, empty(verdict)]),
  );
  let totalSnapshots = 0;
  let readySnapshots = 0;
  let unavailableSnapshots = 0;
  const trajectory = {
    total: 0,
    available: 0,
    mfe: [] as number[],
    mae: [] as number[],
    movement: [] as number[],
    sampleAvailable: 0,
    summaryAvailable: 0,
    targetBeforeStop: 0,
    stopBeforeTarget: 0,
    unknown: 0,
    ambiguous: 0,
  };
  const dimensions = {
    byVersion: new Map<string, Bucket>(),
    byCheckState: new Map<string, Bucket>(),
    byPattern: new Map<string, Bucket>(),
    byBtcRegime: new Map<string, Bucket>(),
  };
  const add = (
    map: Map<string, Bucket>,
    key: string,
    row: AltBulletAnalysisRow,
  ) => {
    const bucket = map.get(key) ?? empty("confirmed");
    map.set(key, bucket);
    bucket.total += 1;
    if (
      isClosedTradeOutcome({
        status: row.status,
        cancelReason: row.cancelReason,
        exitPrice: row.exitPrice,
        pnlPercent: row.pnlPercent,
      })
    ) {
      bucket.closed += 1;
      if (SUCCESSFUL_STATUSES.has(row.status ?? "")) bucket.successful += 1;
      const pnl = normalizeClosedPnlPercent(row.status, row.pnlPercent);
      if (pnl != null) {
        bucket.pnlSum += pnl;
        bucket.pnlCount += 1;
      }
    }
  };

  for (const row of rows) {
    totalSnapshots += 1;
    if (row.snapshotStatus === "ready") readySnapshots += 1;
    else if (row.snapshotStatus === "unavailable") unavailableSnapshots += 1;
    if (row.snapshotStatus !== "ready") continue;
    if (!row.verdict || !VERDICTS.includes(row.verdict as AltBulletVerdict))
      continue;
    const metrics = calculateAltBulletTrajectory(row);
    if (
      isClosedTradeOutcome({
        status: row.status,
        cancelReason: row.cancelReason,
        exitPrice: row.exitPrice,
        pnlPercent: row.pnlPercent,
      })
    ) {
      trajectory.total += 1;
      if (metrics.available) trajectory.available += 1;
      if (metrics.sampleTrajectoryAvailable) trajectory.sampleAvailable += 1;
      if (metrics.finalSummaryAvailable) trajectory.summaryAvailable += 1;
      if (metrics.mfe != null) trajectory.mfe.push(metrics.mfe);
      if (metrics.mae != null) trajectory.mae.push(metrics.mae);
      if (metrics.firstSignificantMovementMs != null)
        trajectory.movement.push(metrics.firstSignificantMovementMs);
      if (metrics.targetBeforeStop === "target_before_stop")
        trajectory.targetBeforeStop += 1;
      else if (metrics.targetBeforeStop === "stop_before_target")
        trajectory.stopBeforeTarget += 1;
      else if (metrics.targetBeforeStop === "ambiguous")
        trajectory.ambiguous += 1;
      else trajectory.unknown += 1;
    }

    const verdict = row.verdict as AltBulletVerdict;
    const bucket = buckets.get(verdict)!;
    bucket.total += 1;
    if (
      isClosedTradeOutcome({
        status: row.status,
        cancelReason: row.cancelReason,
        exitPrice: row.exitPrice,
        pnlPercent: row.pnlPercent,
      })
    ) {
      bucket.closed += 1;
      if (SUCCESSFUL_STATUSES.has(row.status ?? "")) bucket.successful += 1;
      const pnl = normalizeClosedPnlPercent(row.status, row.pnlPercent);
      if (pnl != null) {
        bucket.pnlSum += pnl;
        bucket.pnlCount += 1;
      }
    }
    add(dimensions.byVersion, row.indicatorVersion ?? "unknown", row);
    add(dimensions.byPattern, row.sentimentKey ?? "unknown", row);
    add(
      dimensions.byBtcRegime,
      String(row.context?.btcRegime ?? "unknown"),
      row,
    );
    for (const [check, rawState] of Object.entries(row.checks ?? {})) {
      const state =
        rawState === true ? "pass" : rawState === false ? "fail" : rawState;
      add(dimensions.byCheckState, `${check}:${state}`, row);
    }
  }

  const groups = [...buckets.values()].map(
    (bucket): AltBulletAnalysisGroup => ({
      verdict: bucket.verdict,
      total: bucket.total,
      closed: bucket.closed,
      successful: bucket.successful,
      successRate:
        bucket.closed > 0 ? (bucket.successful / bucket.closed) * 100 : null,
      averagePnl: bucket.pnlCount > 0 ? bucket.pnlSum / bucket.pnlCount : null,
    }),
  );

  const dimensionGroups = (
    map: Map<string, Bucket>,
  ): AltBulletDimensionGroup[] =>
    [...map.entries()].map(([key, bucket]) => ({
      key,
      total: bucket.total,
      closed: bucket.closed,
      successful: bucket.successful,
      successRate: bucket.closed
        ? (bucket.successful / bucket.closed) * 100
        : null,
      averagePnl: bucket.pnlCount ? bucket.pnlSum / bucket.pnlCount : null,
      lowSample: bucket.closed < ALT_BULLET_MIN_CLOSED_SNAPSHOTS,
    }));
  return {
    groups,
    closedSnapshots: groups.reduce((sum, group) => sum + group.closed, 0),
    totalSnapshots,
    readySnapshots,
    unavailableSnapshots,
    byVersion: dimensionGroups(dimensions.byVersion),
    byCheckState: dimensionGroups(dimensions.byCheckState),
    byPattern: dimensionGroups(dimensions.byPattern),
    byBtcRegime: dimensionGroups(dimensions.byBtcRegime),
    trajectory: {
      total: trajectory.total,
      available: trajectory.available,
      sampleTrajectoryAvailable: trajectory.sampleAvailable,
      finalSummaryAvailable: trajectory.summaryAvailable,
      mfeAverage: trajectory.mfe.length
        ? trajectory.mfe.reduce((a, b) => a + b, 0) / trajectory.mfe.length
        : null,
      maeAverage: trajectory.mae.length
        ? trajectory.mae.reduce((a, b) => a + b, 0) / trajectory.mae.length
        : null,
      firstSignificantMovementAverageMs: trajectory.movement.length
        ? trajectory.movement.reduce((a, b) => a + b, 0) /
          trajectory.movement.length
        : null,
      targetBeforeStop: {
        targetBeforeStop: trajectory.targetBeforeStop,
        stopBeforeTarget: trajectory.stopBeforeTarget,
        unknown: trajectory.unknown,
        ambiguous: trajectory.ambiguous,
      },
    },
  };
}
