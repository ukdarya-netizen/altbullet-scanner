import {
  detectAutoRangePine,
  detectAutoRangePine1d,
  detectAutoRangePine1h,
  detectAutoRangePine15m,
  type AutoRangeCandle,
  type AutoRangePineResult,
} from "./auto-range-pine.js";

/**
 * Observational Range-lower-boundary + deviation context captured per signal.
 *
 * Criteria recorded for each of 1D / 4H / 1H:
 *  1. an active confirmed Auto Range exists (its lower/upper bounds), and
 *  2. a deviation: a closed 15m bar probed below the range lower bound and a
 *     closed 15m bar later closed back at/above it (within the last 24h).
 * Never changes an entry decision. Stored in decision_metrics.rangeDeviation.
 */
export const RANGE_DEVIATION_VERSION = "range_deviation_ctx:v1" as const;

const M15 = 15 * 60 * 1000;
const DEVIATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 3;

export interface RawCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface CandleReaction {
  /** Open time of the closed 15m candle with the largest lower wick. */
  time: number;
  low: number;
  close: number;
  /** (min(open, close) - low) / low, in %. */
  lowerWickPct: number;
  /** (close - low) / low, in %: how far the close recovered from the low. */
  recoveryPct: number;
  /** Volume vs the prior 20 closed 15m candles; null when unavailable. */
  volumeRatio: number | null;
  turnoverUsd: number | null;
}

/**
 * The closed 15m candle with the largest lower wick in the window. Works
 * without any Range, so rebounds that have no Range/deviation stay comparable.
 */
export function findCandleReaction(
  candles15m: readonly RawCandle[] | null,
  now: number,
  sinceMs: number = now - DEVIATION_WINDOW_MS,
): CandleReaction | null {
  const closed = (candles15m ?? [])
    .filter((c) => Number.isFinite(c.time) && c.time + M15 <= now)
    .sort((a, b) => a.time - b.time);
  let best: { index: number; wick: number } | null = null;
  closed.forEach((c, index) => {
    if (c.time + M15 <= sinceMs || !(c.low > 0)) return;
    const wick = ((Math.min(c.open, c.close) - c.low) / c.low) * 100;
    if (Number.isFinite(wick) && (!best || wick > best.wick))
      best = { index, wick };
  });
  if (!best) return null;
  const { index, wick } = best as { index: number; wick: number };
  const c = closed[index]!;
  const prior = closed.slice(Math.max(0, index - 20), index);
  const hasVolume =
    prior.length === 20 &&
    Number.isFinite(c.volume) &&
    (c.volume ?? 0) > 0 &&
    prior.every((p) => Number.isFinite(p.volume) && (p.volume ?? 0) > 0);
  const mean = hasVolume
    ? prior.reduce((sum, p) => sum + (p.volume ?? 0), 0) / 20
    : null;
  return {
    time: c.time,
    low: c.low,
    close: c.close,
    lowerWickPct: wick,
    recoveryPct: ((c.close - c.low) / c.low) * 100,
    volumeRatio: mean ? (c.volume ?? 0) / mean : null,
    turnoverUsd: Number.isFinite(c.volume) ? (c.volume ?? 0) * c.close : null,
  };
}

export interface DeviationEvent {
  probeAt: number;
  reclaimAt: number;
  /** Deepest probe below the range lower bound, % of the lower bound. */
  depthPct: number;
  reclaimClose: number;
}

export interface RangeTimeframeContext {
  hasRange: boolean;
  /** broken_* = no active range; using the most recently broken range. */
  rangeState: "active" | "broken_up" | "broken_down" | "none";
  brokenAt: number | null;
  reason: string;
  upper: number | null;
  lower: number | null;
  openedAt: number | null;
  position: "inside" | "below" | "above" | null;
  distToLowerPct: number | null;
  /** Closed-below the lower bound at `now` with no reclaim yet. */
  belowUnreclaimed: boolean;
  deviations: DeviationEvent[];
}

export interface RangeDeviationContext {
  version: typeof RANGE_DEVIATION_VERSION;
  source: "fire_time" | "backfilled_as_of_fire_time";
  capturedAt: number;
  entryPrice: number;
  /** Largest-lower-wick 15m candle in the 24h before the signal. */
  candleReaction: CandleReaction | null;
  tf1d: RangeTimeframeContext;
  tf4h: RangeTimeframeContext;
  tf1h: RangeTimeframeContext;
  /** Observation only; absent on contexts captured before 2026-10-06. */
  tf15m?: RangeTimeframeContext;
}

function toClosed(
  rows: readonly RawCandle[] | null,
  barMs: number,
  now: number,
): AutoRangeCandle[] {
  if (!rows) return [];
  return rows
    .filter((c) => Number.isFinite(c.time) && c.time + barMs <= now)
    .sort((a, b) => a.time - b.time)
    .map((c) => ({ ...c, closed: true }));
}

export function findDeviations(
  candles15m: readonly RawCandle[] | null,
  lower: number,
  now: number,
  sinceMs: number = now - DEVIATION_WINDOW_MS,
): { events: DeviationEvent[]; belowUnreclaimed: boolean } {
  const closed = (candles15m ?? [])
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        c.time + M15 <= now &&
        c.time + M15 > sinceMs,
    )
    .sort((a, b) => a.time - b.time);
  const events: DeviationEvent[] = [];
  let probeAt: number | null = null;
  let minLow = Number.POSITIVE_INFINITY;
  for (const c of closed) {
    if (c.low < lower) {
      probeAt ??= c.time;
      minLow = Math.min(minLow, c.low);
    }
    if (c.close >= lower && probeAt != null) {
      events.push({
        probeAt,
        reclaimAt: c.time + M15,
        depthPct: ((lower - minLow) / lower) * 100,
        reclaimClose: c.close,
      });
      probeAt = null;
      minLow = Number.POSITIVE_INFINITY;
    }
  }
  return {
    events: events,
    belowUnreclaimed: probeAt != null,
  };
}

function timeframeContext(
  result: AutoRangePineResult,
  candles15m: readonly RawCandle[] | null,
  price: number,
  now: number,
): RangeTimeframeContext {
  const active = result.activeConfirmedRange;
  const up = result.latestUpsideBreakout ?? null;
  const down = result.latestDownsideBreakout ?? null;
  const broken =
    up && down
      ? up.breakoutCloseTime >= down.breakoutCloseTime
        ? up
        : down
      : (up ?? down);
  const range = active ?? broken;
  if (result.status !== "ready" || !range) {
    return {
      hasRange: false,
      rangeState: "none",
      brokenAt: null,
      reason: result.reason,
      upper: null,
      lower: null,
      openedAt: null,
      position: null,
      distToLowerPct: null,
      belowUnreclaimed: false,
      deviations: [],
    };
  }
  const { events, belowUnreclaimed } = findDeviations(
    candles15m,
    range.lower,
    now,
  );
  return {
    hasRange: true,
    rangeState: active
      ? "active"
      : broken === down
        ? "broken_down"
        : "broken_up",
    brokenAt: active ? null : (broken?.breakoutCloseTime ?? null),
    reason: result.reason,
    upper: range.upper,
    lower: range.lower,
    openedAt: range.openedAt,
    position:
      price < range.lower ? "below" : price > range.upper ? "above" : "inside",
    distToLowerPct: ((price - range.lower) / range.lower) * 100,
    belowUnreclaimed,
    deviations: events.slice(-MAX_EVENTS),
  };
}

export function buildRangeDeviationContext(input: {
  candles1d: readonly RawCandle[] | null;
  candles4h: readonly RawCandle[] | null;
  candles1h: readonly RawCandle[] | null;
  candles15m: readonly RawCandle[] | null;
  entryPrice: number;
  now: number;
  source?: RangeDeviationContext["source"];
}): RangeDeviationContext {
  const { now, entryPrice, candles15m } = input;
  const H = 60 * 60 * 1000;
  return {
    version: RANGE_DEVIATION_VERSION,
    source: input.source ?? "fire_time",
    capturedAt: now,
    entryPrice,
    candleReaction: findCandleReaction(candles15m, now),
    tf1d: timeframeContext(
      detectAutoRangePine1d(toClosed(input.candles1d, 24 * H, now)),
      candles15m,
      entryPrice,
      now,
    ),
    tf4h: timeframeContext(
      detectAutoRangePine(toClosed(input.candles4h, 4 * H, now)),
      candles15m,
      entryPrice,
      now,
    ),
    tf1h: timeframeContext(
      detectAutoRangePine1h(toClosed(input.candles1h, H, now)),
      candles15m,
      entryPrice,
      now,
    ),
    tf15m: timeframeContext(
      detectAutoRangePine15m(toClosed(candles15m, H / 4, now)),
      candles15m,
      entryPrice,
      now,
    ),
  };
}

/** 15m Range observation alone; used to enrich contexts captured earlier. */
export function buildRange15mContext(
  candles15m: readonly RawCandle[] | null,
  entryPrice: number,
  now: number,
): RangeTimeframeContext {
  return timeframeContext(
    detectAutoRangePine15m(toClosed(candles15m, 15 * 60 * 1000, now)),
    candles15m,
    entryPrice,
    now,
  );
}
