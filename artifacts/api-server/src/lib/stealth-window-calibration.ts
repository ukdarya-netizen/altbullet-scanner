import type { BreakoutCandle } from "./breakout-analysis.js";

export const STEALTH_WINDOW_VERSION = "stealth-30m-hold-v1" as const;
export const STEALTH_WINDOW_MIN_COMPLETED = 20;

export type StealthWindowOutcome =
  | "profit"
  | "bu_stop"
  | "breakeven"
  | "stop_loss"
  | "expired";

export type StealthWindowReplayRow = {
  entryAt: number;
  entryPrice: number;
  closedAt: number;
  outcome: StealthWindowOutcome;
  pnlPct?: number | null;
  candles: readonly BreakoutCandle[];
};

export type StealthWindowStopReport = {
  stopPct: 6 | 8 | 10;
  favorableActualTurnedIntoStops: number;
  eventualActualStopsImproved: number;
  candidateStops: number;
};

export type StealthWindowCalibrationReport = {
  decision: "insufficient_cohort" | "ready_for_decision";
  version: typeof STEALTH_WINDOW_VERSION;
  minimumCompleted: number;
  completed: number;
  signalFrequency: { total: number; perDay: number | null };
  outcomes: {
    profit: number;
    bu: number;
    breakeven: number;
    stop: number;
    expired: number;
  };
  avgPnlPct: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
  stops: StealthWindowStopReport[];
};

function round(value: number | null): number | null {
  return value == null ? null : Number(value.toFixed(2));
}

/**
 * Replays a long-only hypothetical entry. Intrabar ambiguity is deliberately
 * conservative: a stop is resolved before a favorable move on the same candle.
 */
export function replayStealthWindowStop(
  row: Pick<
    StealthWindowReplayRow,
    "entryAt" | "closedAt" | "entryPrice" | "candles"
  >,
  stopPct: 6 | 8 | 10,
): {
  hit: boolean;
  hitAt: number | null;
  mfePct: number | null;
  maePct: number | null;
} {
  const horizonEnd = Math.min(row.closedAt, row.entryAt + 72 * 60 * 60 * 1000);
  const candles = row.candles
    .filter(
      (candle) =>
        Number.isFinite(candle.time) &&
        candle.time >= row.entryAt &&
        candle.time <= horizonEnd,
    )
    .sort((left, right) => left.time - right.time);
  const entry = row.entryPrice;
  if (!(entry > 0) || candles.length === 0) {
    return { hit: false, hitAt: null, mfePct: null, maePct: null };
  }
  let mfe = -Infinity;
  let mae = Infinity;
  const stop = entry * (1 - stopPct / 100);
  for (const candle of candles) {
    mfe = Math.max(mfe, (candle.high / entry - 1) * 100);
    mae = Math.min(mae, (candle.low / entry - 1) * 100);
    if (candle.low <= stop) {
      return {
        hit: true,
        hitAt: candle.time,
        mfePct: round(mfe),
        maePct: round(mae),
      };
    }
  }
  return {
    hit: false,
    hitAt: null,
    mfePct: round(mfe === -Infinity ? null : mfe),
    maePct: round(mae === Infinity ? null : mae),
  };
}

export function analyzeStealthWindowCalibration(
  rows: readonly StealthWindowReplayRow[],
): StealthWindowCalibrationReport {
  const ordered = [...rows].sort((left, right) => left.entryAt - right.entryAt);
  const outcomes = { profit: 0, bu: 0, breakeven: 0, stop: 0, expired: 0 };
  let pnl = 0;
  let pnlCount = 0;
  let mfe = 0;
  let mae = 0;
  let metricRows = 0;
  const stops = ([6, 8, 10] as const).map((stopPct) => {
    let favorableActualTurnedIntoStops = 0;
    let eventualActualStopsImproved = 0;
    let candidateStops = 0;
    for (const row of ordered) {
      const replay = replayStealthWindowStop(row, stopPct);
      if (replay.hit) candidateStops++;
      if (
        (row.outcome === "profit" ||
          row.outcome === "bu_stop" ||
          row.outcome === "breakeven") &&
        replay.hit
      ) {
        favorableActualTurnedIntoStops++;
      }
      if (row.outcome === "stop_loss" && replay.hit)
        eventualActualStopsImproved++;
    }
    return {
      stopPct,
      favorableActualTurnedIntoStops,
      eventualActualStopsImproved,
      candidateStops,
    };
  });
  for (const row of ordered) {
    const key =
      row.outcome === "bu_stop"
        ? "bu"
        : row.outcome === "stop_loss"
          ? "stop"
          : row.outcome;
    outcomes[key]++;
    const pathEnd = Math.min(row.closedAt, row.entryAt + 72 * 60 * 60 * 1000);
    const path = row.candles.filter(
      (candle) => candle.time >= row.entryAt && candle.time <= pathEnd,
    );
    const replay = replayStealthWindowStop(row, 10);
    if (row.pnlPct != null && Number.isFinite(row.pnlPct)) {
      pnl += row.pnlPct;
      pnlCount++;
    }
    const pathMfe =
      path.length > 0
        ? Math.max(
            ...path.map((candle) => (candle.high / row.entryPrice - 1) * 100),
          )
        : null;
    const pathMae =
      path.length > 0
        ? Math.min(
            ...path.map((candle) => (candle.low / row.entryPrice - 1) * 100),
          )
        : null;
    if (pathMfe != null && pathMae != null && replay) {
      mfe += pathMfe;
      mae += pathMae;
      metricRows++;
    }
  }
  const durationDays =
    ordered.length > 1
      ? (ordered[ordered.length - 1]!.entryAt - ordered[0]!.entryAt) /
        86_400_000
      : null;
  return {
    decision:
      ordered.length < STEALTH_WINDOW_MIN_COMPLETED
        ? "insufficient_cohort"
        : "ready_for_decision",
    version: STEALTH_WINDOW_VERSION,
    minimumCompleted: STEALTH_WINDOW_MIN_COMPLETED,
    completed: ordered.length,
    signalFrequency: {
      total: ordered.length,
      perDay:
        durationDays && durationDays > 0
          ? round(ordered.length / durationDays)
          : null,
    },
    outcomes,
    avgPnlPct: pnlCount > 0 ? round(pnl / pnlCount) : null,
    avgMfePct: metricRows > 0 ? round(mfe / metricRows) : null,
    avgMaePct: metricRows > 0 ? round(mae / metricRows) : null,
    stops,
  };
}
