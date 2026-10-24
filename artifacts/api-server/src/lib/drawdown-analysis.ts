import { isIncludedInCurrentPatternStats } from "./impulse-buy-stats-cohort.js";

export const DRAWDOWN_OUTCOME_STATUSES = [
  "stop_loss",
  "profit",
  "breakeven",
  "expired",
  "bu_stop",
] as const;

export type DrawdownOutcomeStatus = (typeof DRAWDOWN_OUTCOME_STATUSES)[number];

export const DRAWDOWN_RISK_MIN_SAMPLE = 20;
export const DRAWDOWN_RISK_MIN_BIN_SAMPLE = 5;
export const DRAWDOWN_FORWARD_MIN_SAMPLE = 100;
export const DRAWDOWN_FORWARD_THRESHOLDS = [6, 8, 10] as const;
export type DrawdownForwardThreshold =
  (typeof DRAWDOWN_FORWARD_THRESHOLDS)[number];

const STOP_LOSS_RISK_RATE = 50;
const STOP_LOSS_RISK_LIFT_PP = 15;

export const DRAWDOWN_RATIO_BINS = [
  { key: "0_25", label: "0–25%", min: 0, max: 0.25 },
  { key: "25_50", label: "25–50%", min: 0.25, max: 0.5 },
  { key: "50_75", label: "50–75%", min: 0.5, max: 0.75 },
  { key: "75_100", label: "75–100%", min: 0.75, max: 1 },
  { key: "over_100", label: ">100%", min: 1, max: null },
] as const;

export interface DrawdownAnalysisRow {
  signalId?: number;
  sentimentKey: string | null;
  status: string;
  minPctFromEntry: number | null;
  stopLossPct: number | null;
  minObservedAt?: Date | string | null;
  detectedAt?: Date | string | null;
  finalPnlPct?: number | null;
  trajectory?: readonly DrawdownTrajectoryPoint[];
}

export interface DrawdownTrajectoryPoint {
  snapshotAt: Date | string;
  peakPct: number | null;
}

export interface DrawdownForwardOutcomeCounts {
  reachedPlus5: number;
  reachedPlus10: number;
  recoveredToBreakeven: number;
  closedNegative: number;
}

export interface DrawdownForwardThresholdAnalysis extends DrawdownForwardOutcomeCounts {
  thresholdPct: DrawdownForwardThreshold;
  reachedDrawdown: number;
  trajectoryObserved: number;
  trajectoryMissing: number;
}

export interface DrawdownReplay {
  stopPct: 8 | 10;
  reachedDrawdown: number;
  preventedLosses: number;
  preventedLossPp: number;
  lostRecoveries: number;
  lostRecoveryPp: number;
}

export interface DrawdownReplayComparison {
  additionalPreventedLossesAt8: number;
  additionalPreventedLossPpAt8: number;
  additionalLostRecoveriesAt8: number;
  additionalLostRecoveryPpAt8: number;
  netPpAt8Vs10: number;
}

export interface DrawdownForwardAnalysis {
  eligible: number;
  minimumEligible: number;
  sufficient: boolean;
  thresholds: DrawdownForwardThresholdAnalysis[];
  replay: {
    stop8: DrawdownReplay;
    stop10: DrawdownReplay;
    comparison: DrawdownReplayComparison;
  };
  decision:
    | "insufficient_forward_sample"
    | "insufficient_pattern_sample"
    | "retain_10_review"
    | "candidate_8_review";
}

export interface DrawdownOutcomeCounts {
  stopLoss: number;
  profit: number;
  breakeven: number;
  expired: number;
  buStop: number;
}

export interface DrawdownRatioBin extends DrawdownOutcomeCounts {
  key: string;
  label: string;
  total: number;
  ordinaryOutcomes: number;
  stopLossRate: number | null;
  buStopRate: number | null;
}

export interface DrawdownRiskZone {
  state: "observed" | "not_observed" | "insufficient_sample";
  fromRatioPct: number | null;
  toRatioPct: number | null;
  label: string | null;
  stopLossRate: number | null;
  sampleSize: number;
  liftPp: number | null;
}

export interface DrawdownPatternAnalysis {
  sentimentKey: string;
  eligible: number;
  counts: DrawdownOutcomeCounts;
  ordinaryOutcomes: number;
  stopLossRate: number | null;
  buStopRate: number | null;
  riskZone: DrawdownRiskZone;
  bins: DrawdownRatioBin[];
  forward: DrawdownForwardAnalysis;
}

export interface DrawdownAnalysis {
  observationOnly: true;
  basis: "signal_drawdown_extrema";
  statuses: readonly DrawdownOutcomeStatus[];
  sample: {
    closedOutcomes: number;
    observedWithExtrema: number;
    missingExtrema: number;
    withStopLossPct: number;
    missingStopLossPct: number;
    eligible: number;
    minimumEligible: number;
    sufficient: boolean;
  };
  summary: {
    eligible: number;
    counts: DrawdownOutcomeCounts;
    ordinaryOutcomes: number;
    stopLossRate: number | null;
    buStopRate: number | null;
    riskZone: DrawdownRiskZone;
  };
  bins: DrawdownRatioBin[];
  byPattern: DrawdownPatternAnalysis[];
  forward: DrawdownForwardAnalysis;
  definition: string;
}

export interface DrawdownAnalysisOptions {
  forwardMinimumEligible?: number;
  forwardCohortSufficient?: boolean;
}

function emptyCounts(): DrawdownOutcomeCounts {
  return { stopLoss: 0, profit: 0, breakeven: 0, expired: 0, buStop: 0 };
}

function countStatus(
  counts: DrawdownOutcomeCounts,
  status: DrawdownOutcomeStatus,
) {
  if (status === "stop_loss") counts.stopLoss += 1;
  else if (status === "profit") counts.profit += 1;
  else if (status === "breakeven") counts.breakeven += 1;
  else if (status === "expired") counts.expired += 1;
  else counts.buStop += 1;
}

function ordinaryOutcomes(counts: DrawdownOutcomeCounts) {
  return counts.stopLoss + counts.profit + counts.breakeven + counts.expired;
}

function stopLossRate(counts: DrawdownOutcomeCounts) {
  const total = ordinaryOutcomes(counts);
  return total > 0 ? (counts.stopLoss / total) * 100 : null;
}

function buStopRate(counts: DrawdownOutcomeCounts, total: number) {
  return total > 0 ? (counts.buStop / total) * 100 : null;
}

function makeBin(
  definition: (typeof DRAWDOWN_RATIO_BINS)[number],
): DrawdownRatioBin {
  return {
    key: definition.key,
    label: definition.label,
    total: 0,
    stopLoss: 0,
    profit: 0,
    breakeven: 0,
    expired: 0,
    buStop: 0,
    ordinaryOutcomes: 0,
    stopLossRate: null,
    buStopRate: null,
  };
}

function finishBins(bins: DrawdownRatioBin[]) {
  for (const bin of bins) {
    bin.ordinaryOutcomes = bin.stopLoss + bin.profit + bin.breakeven;
    bin.stopLossRate = stopLossRate(bin);
    bin.buStopRate = buStopRate(bin, bin.total);
  }
  return bins;
}

function ratioBinIndex(ratio: number) {
  const index = DRAWDOWN_RATIO_BINS.findIndex(
    (bin) => ratio >= bin.min && (bin.max == null || ratio < bin.max),
  );
  return index >= 0 ? index : DRAWDOWN_RATIO_BINS.length - 1;
}

function findRiskZone(
  bins: DrawdownRatioBin[],
  eligible: number,
): DrawdownRiskZone {
  if (eligible < DRAWDOWN_RISK_MIN_SAMPLE) {
    return {
      state: "insufficient_sample",
      fromRatioPct: null,
      toRatioPct: null,
      label: null,
      stopLossRate: null,
      sampleSize: eligible,
      liftPp: null,
    };
  }

  let previousRate: number | null = null;
  for (const bin of bins) {
    if (
      bin.ordinaryOutcomes < DRAWDOWN_RISK_MIN_BIN_SAMPLE ||
      bin.stopLossRate == null
    ) {
      continue;
    }
    const liftPp =
      previousRate == null ? null : bin.stopLossRate - previousRate;
    if (
      bin.stopLossRate >= STOP_LOSS_RISK_RATE &&
      (previousRate == null || (liftPp ?? 0) >= STOP_LOSS_RISK_LIFT_PP)
    ) {
      const definition = DRAWDOWN_RATIO_BINS.find(
        (candidate) => candidate.key === bin.key,
      )!;
      return {
        state: "observed",
        fromRatioPct: definition.min * 100,
        toRatioPct: definition.max == null ? null : definition.max * 100,
        label: definition.label,
        stopLossRate: bin.stopLossRate,
        sampleSize: bin.ordinaryOutcomes,
        liftPp,
      };
    }
    previousRate = bin.stopLossRate;
  }

  return {
    state: "not_observed",
    fromRatioPct: null,
    toRatioPct: null,
    label: null,
    stopLossRate: null,
    sampleSize: eligible,
    liftPp: null,
  };
}

function analyzeGroup(
  entries: Array<{
    status: DrawdownOutcomeStatus;
    ratio: number;
  }>,
) {
  const counts = emptyCounts();
  const bins = DRAWDOWN_RATIO_BINS.map(makeBin);
  for (const entry of entries) {
    countStatus(counts, entry.status);
    const bin = bins[ratioBinIndex(entry.ratio)]!;
    bin.total += 1;
    countStatus(bin, entry.status);
  }
  finishBins(bins);
  const eligible = entries.length;
  return {
    eligible,
    counts,
    ordinaryOutcomes: ordinaryOutcomes(counts),
    stopLossRate: stopLossRate(counts),
    buStopRate: buStopRate(counts, eligible),
    riskZone: findRiskZone(bins, eligible),
    bins,
  };
}

function emptyForwardCounts(): DrawdownForwardOutcomeCounts {
  return {
    reachedPlus5: 0,
    reachedPlus10: 0,
    recoveredToBreakeven: 0,
    closedNegative: 0,
  };
}

function asTimestamp(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function peakAfterMinimum(row: DrawdownAnalysisRow): number | null {
  const minimumAt = asTimestamp(row.minObservedAt);
  if (minimumAt == null || !row.trajectory?.length) return null;

  let peak: number | null = null;
  for (const point of row.trajectory) {
    const snapshotAt = asTimestamp(point.snapshotAt);
    if (
      snapshotAt == null ||
      snapshotAt < minimumAt ||
      point.peakPct == null ||
      !Number.isFinite(point.peakPct)
    ) {
      continue;
    }
    peak = peak == null ? point.peakPct : Math.max(peak, point.peakPct);
  }
  return peak;
}

function isClosedNegative(row: DrawdownAnalysisRow): boolean {
  if (row.status === "stop_loss") return true;
  return (
    row.finalPnlPct != null &&
    Number.isFinite(row.finalPnlPct) &&
    row.finalPnlPct < 0
  );
}

function replayForStop(
  entries: readonly {
    row: DrawdownAnalysisRow;
    peakAfterMinimum: number | null;
  }[],
  stopPct: 8 | 10,
): DrawdownReplay {
  let reachedDrawdown = 0;
  let preventedLosses = 0;
  let preventedLossPp = 0;
  let lostRecoveries = 0;
  let lostRecoveryPp = 0;

  for (const entry of entries) {
    const minPct = entry.row.minPctFromEntry;
    if (minPct == null || !Number.isFinite(minPct) || minPct > -stopPct) {
      continue;
    }
    reachedDrawdown += 1;

    const finalPnlPct = entry.row.finalPnlPct;
    if (
      finalPnlPct != null &&
      Number.isFinite(finalPnlPct) &&
      finalPnlPct < -stopPct
    ) {
      preventedLosses += 1;
      preventedLossPp += -finalPnlPct - stopPct;
    }

    if (entry.peakAfterMinimum != null && entry.peakAfterMinimum >= 0) {
      lostRecoveries += 1;
      if (finalPnlPct != null && Number.isFinite(finalPnlPct)) {
        lostRecoveryPp += Math.max(0, finalPnlPct) + stopPct;
      }
    }
  }

  return {
    stopPct,
    reachedDrawdown,
    preventedLosses,
    preventedLossPp,
    lostRecoveries,
    lostRecoveryPp,
  };
}

function buildForwardAnalysis(
  entries: readonly {
    row: DrawdownAnalysisRow;
    peakAfterMinimum: number | null;
  }[],
  minimumEligible = DRAWDOWN_FORWARD_MIN_SAMPLE,
  cohortSufficient = true,
): DrawdownForwardAnalysis {
  const thresholds = DRAWDOWN_FORWARD_THRESHOLDS.map((thresholdPct) => {
    const counts = emptyForwardCounts();
    let reachedDrawdown = 0;
    let trajectoryObserved = 0;

    for (const entry of entries) {
      const minPct = entry.row.minPctFromEntry;
      if (
        minPct == null ||
        !Number.isFinite(minPct) ||
        minPct > -thresholdPct
      ) {
        continue;
      }
      reachedDrawdown += 1;
      if (entry.peakAfterMinimum != null) {
        trajectoryObserved += 1;
        if (entry.peakAfterMinimum >= 5) counts.reachedPlus5 += 1;
        if (entry.peakAfterMinimum >= 10) counts.reachedPlus10 += 1;
        if (entry.peakAfterMinimum >= 0) {
          counts.recoveredToBreakeven += 1;
        }
      }
      if (isClosedNegative(entry.row)) counts.closedNegative += 1;
    }

    return {
      thresholdPct,
      reachedDrawdown,
      trajectoryObserved,
      trajectoryMissing: reachedDrawdown - trajectoryObserved,
      ...counts,
    };
  });

  const stop8 = replayForStop(entries, 8);
  const stop10 = replayForStop(entries, 10);
  const comparison: DrawdownReplayComparison = {
    additionalPreventedLossesAt8:
      stop8.preventedLosses - stop10.preventedLosses,
    additionalPreventedLossPpAt8:
      stop8.preventedLossPp - stop10.preventedLossPp,
    additionalLostRecoveriesAt8: stop8.lostRecoveries - stop10.lostRecoveries,
    additionalLostRecoveryPpAt8: stop8.lostRecoveryPp - stop10.lostRecoveryPp,
    netPpAt8Vs10:
      stop8.preventedLossPp -
      stop10.preventedLossPp -
      (stop8.lostRecoveryPp - stop10.lostRecoveryPp),
  };
  const eligible = entries.length;
  const ownSampleSufficient = eligible >= minimumEligible;
  const sufficient = cohortSufficient && ownSampleSufficient;
  const decision = !cohortSufficient
    ? "insufficient_forward_sample"
    : !ownSampleSufficient
      ? minimumEligible === DRAWDOWN_FORWARD_MIN_SAMPLE
        ? "insufficient_forward_sample"
        : "insufficient_pattern_sample"
      : comparison.netPpAt8Vs10 > 0
        ? "candidate_8_review"
        : "retain_10_review";

  return {
    eligible,
    minimumEligible,
    sufficient,
    thresholds,
    replay: { stop8, stop10, comparison },
    decision,
  };
}

export function buildDrawdownRiskAnalysis(
  rows: readonly DrawdownAnalysisRow[],
  options: DrawdownAnalysisOptions = {},
): DrawdownAnalysis {
  const validRows: Array<{
    row: DrawdownAnalysisRow;
    status: DrawdownOutcomeStatus;
    ratio: number;
    peakAfterMinimum: number | null;
  }> = [];
  let observedWithExtrema = 0;
  let withStopLossPct = 0;

  for (const row of rows) {
    if (!isIncludedInCurrentPatternStats(row)) continue;
    const status = DRAWDOWN_OUTCOME_STATUSES.includes(
      row.status as DrawdownOutcomeStatus,
    )
      ? (row.status as DrawdownOutcomeStatus)
      : null;
    if (status == null) continue;
    if (row.minPctFromEntry != null && Number.isFinite(row.minPctFromEntry)) {
      observedWithExtrema += 1;
    }
    if (
      row.stopLossPct != null &&
      Number.isFinite(row.stopLossPct) &&
      row.stopLossPct > 0
    ) {
      withStopLossPct += 1;
    }
    if (
      row.minPctFromEntry == null ||
      !Number.isFinite(row.minPctFromEntry) ||
      row.stopLossPct == null ||
      !Number.isFinite(row.stopLossPct) ||
      row.stopLossPct <= 0
    ) {
      continue;
    }
    validRows.push({
      row,
      status,
      ratio: Math.max(0, -row.minPctFromEntry) / row.stopLossPct,
      peakAfterMinimum: peakAfterMinimum(row),
    });
  }

  const overall = analyzeGroup(
    validRows.map(({ status, ratio }) => ({ status, ratio })),
  );
  const forward = buildForwardAnalysis(
    validRows,
    options.forwardMinimumEligible ?? DRAWDOWN_FORWARD_MIN_SAMPLE,
    options.forwardCohortSufficient ?? true,
  );
  const byPatternMap = new Map<
    string,
    Array<{
      row: DrawdownAnalysisRow;
      status: DrawdownOutcomeStatus;
      ratio: number;
      peakAfterMinimum: number | null;
    }>
  >();
  for (const { row, status, ratio, peakAfterMinimum } of validRows) {
    if (!row.sentimentKey) continue;
    const entries = byPatternMap.get(row.sentimentKey) ?? [];
    entries.push({ row, status, ratio, peakAfterMinimum });
    byPatternMap.set(row.sentimentKey, entries);
  }

  const byPattern = [...byPatternMap.entries()]
    .map(([sentimentKey, entries]) => ({
      sentimentKey,
      ...analyzeGroup(entries),
      forward: buildForwardAnalysis(
        entries,
        DRAWDOWN_RISK_MIN_SAMPLE,
        forward.sufficient,
      ),
    }))
    .sort(
      (a, b) =>
        b.eligible - a.eligible || a.sentimentKey.localeCompare(b.sentimentKey),
    );

  const closedOutcomes = rows.filter((row) =>
    DRAWDOWN_OUTCOME_STATUSES.includes(row.status as DrawdownOutcomeStatus),
  ).length;

  return {
    observationOnly: true,
    basis: "signal_drawdown_extrema",
    statuses: DRAWDOWN_OUTCOME_STATUSES,
    sample: {
      closedOutcomes,
      observedWithExtrema,
      missingExtrema: Math.max(0, closedOutcomes - observedWithExtrema),
      withStopLossPct,
      missingStopLossPct: Math.max(0, closedOutcomes - withStopLossPct),
      eligible: overall.eligible,
      minimumEligible: DRAWDOWN_RISK_MIN_SAMPLE,
      sufficient: overall.eligible >= DRAWDOWN_RISK_MIN_SAMPLE,
    },
    summary: {
      eligible: overall.eligible,
      counts: overall.counts,
      ordinaryOutcomes: overall.ordinaryOutcomes,
      stopLossRate: overall.stopLossRate,
      buStopRate: overall.buStopRate,
      riskZone: overall.riskZone,
    },
    bins: overall.bins,
    byPattern,
    forward,
    definition:
      "Риск-зона: только закрытые profit, stop_loss, breakeven и bu_stop с наблюдаемым минимумом из signal_drawdown_extrema и положительным персональным stop_loss_pct. Доля = max(0, −minPctFromEntry) / stopLossPct. Forward/replay: для сделок, чей минимум достиг −6/−8/−10%, цели +5%, +10% и BE считаются только по trajectory-снапшотам после времени минимума (включая close); closed_negative — по фактическому финальному PnL. Это наблюдение и replay, не изменение правила входа или выхода.",
  };
}
