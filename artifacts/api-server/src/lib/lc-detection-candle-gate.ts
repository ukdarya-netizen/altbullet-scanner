import { getKlinesRange } from "./bingx.js";

/**
 * Liquidation Cascade speed filter (owner decision 2026-10-07): the closed 15m
 * candle that contains the liquidation detection time must be a large reaction
 * candle: full range >= 8% OR lower wick >= 4% (both relative to the open).
 *
 * Evidence (356 LC signals since 2026-09-01, detection candle fetched at the
 * watch detection time): reaching +5% within 4h happened for 16% of signals that
 * pass vs 3% of the rest; stuck below +2% at 4h: 53% vs 76%. Holds in both
 * Sep<28 and Sep28+. Thresholds are not a proven edge; flow reduction is
 * accepted by the owner. Missing candle data blocks (no data, no signal).
 */
export const LC_MIN_DETECTION_CANDLE_RANGE_PCT = 5.6;
// Owner 2026-10-27: capitulation entry. The closed detection candle must have
// range >= 5.6% AND a red body of at least 3.5% (close <= open * (1 - 3.5%));
// entry at once after its close (within LC_DETECTION_ENTRY_WINDOW_MS), stop -10%.
// Replay of 3778 watches since 2026-09-01 (candles, entry at the detection
// candle close, +10% before -10% within 72h): 260 trades, 46.5% (all watches
// 24%), take +10% sum +818%, positive in all three thirds (+221/+258/+339),
// without the 2026-10-15 crash day: 140 trades, 48.6%, +390%.
export const LC_MAX_DETECTION_CANDLE_BODY_PCT = -3.5;
export const LC_DETECTION_ENTRY_WINDOW_MS = 15 * 60 * 1000;
// Owner 2026-10-27: the bottom must be bought back: close at least 31% of the
// candle range above its low. Same replay: 104 trades (vs 260), 57% +10%
// before -10%, stops 13 (vs 42), take +5% sum +345% (+199% without
// 2026-10-15, vs +162%), positive in all three thirds.
export const LC_MIN_DETECTION_CANDLE_CLOSE_POS = 0.31;
// Owner 2026-10-23: only the CLOSED detection candle is judged. While it is
// still open the watch waits (reason "detection_candle_pending", non-terminal)
// and the gate is re-evaluated each cycle. Threshold 10% -> 6% (replay of
// 1672 watches: range>=6% = 47% champions / 17% stops vs 26% / 32% overall).

const M15 = 15 * 60 * 1000;

export interface LcDetectionCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type LcDetectionCandleDecision =
  | { pass: true; rangePct: number; lowerWickPct: number; bodyPct: number }
  | {
      pass: false;
      reason:
        | "detection_candle_unavailable"
        | "detection_candle_too_small"
        | "detection_candle_not_capitulation"
        | "detection_candle_bottom_not_bought"
        | "detection_candle_entry_window_passed"
        | "detection_candle_pending";
      rangePct: number | null;
      lowerWickPct: number | null;
      bodyPct: number | null;
    };

export function evaluateLcDetectionCandleGate(
  candles: readonly LcDetectionCandle[] | null,
  detectedAt: number,
  now: number,
): LcDetectionCandleDecision {
  const start = Math.floor(detectedAt / M15) * M15;
  if (start + M15 > now) {
    return {
      pass: false,
      reason: "detection_candle_pending",
      rangePct: null,
      lowerWickPct: null,
      bodyPct: null,
    };
  }
  const c = (candles ?? []).find((k) => k.time === start);
  const unavailable = {
    pass: false as const,
    reason: "detection_candle_unavailable" as const,
    rangePct: null,
    lowerWickPct: null,
    bodyPct: null,
  };
  if (
    !c ||
    c.time + M15 > now ||
    ![c.open, c.high, c.low, c.close].every(Number.isFinite) ||
    !(c.open > 0) ||
    !(c.low > 0) ||
    c.high < c.low
  ) {
    return unavailable;
  }
  const rangePct = ((c.high - c.low) / c.open) * 100;
  const lowerWickPct = ((Math.min(c.open, c.close) - c.low) / c.open) * 100;
  const bodyPct = ((c.close - c.open) / c.open) * 100;
  if (rangePct < LC_MIN_DETECTION_CANDLE_RANGE_PCT) {
    return {
      pass: false,
      reason: "detection_candle_too_small",
      rangePct,
      lowerWickPct,
      bodyPct,
    };
  }
  if (bodyPct > LC_MAX_DETECTION_CANDLE_BODY_PCT) {
    return {
      pass: false,
      reason: "detection_candle_not_capitulation",
      rangePct,
      lowerWickPct,
      bodyPct,
    };
  }
  if ((c.close - c.low) / (c.high - c.low) < LC_MIN_DETECTION_CANDLE_CLOSE_POS) {
    return {
      pass: false,
      reason: "detection_candle_bottom_not_bought",
      rangePct,
      lowerWickPct,
      bodyPct,
    };
  }
  // The edge is the entry at the detection candle close; a late fire is a
  // different trade, so the window is terminal.
  if (now > c.time + M15 + LC_DETECTION_ENTRY_WINDOW_MS) {
    return {
      pass: false,
      reason: "detection_candle_entry_window_passed",
      rangePct,
      lowerWickPct,
      bodyPct,
    };
  }
  return { pass: true, rangePct, lowerWickPct, bodyPct };
}

const cache = new Map<string, LcDetectionCandle[] | null>();

export async function loadLcDetectionCandle(
  symbol: string,
  detectedAt: number,
): Promise<LcDetectionCandle[] | null> {
  const start = Math.floor(detectedAt / M15) * M15;
  const key = `${symbol}:${start}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const rows = await Promise.race([
    getKlinesRange(symbol, "15m", start, start + M15),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]).catch(() => null);
  const candles = rows
    ? rows.map((k) => ({
        time: Number(k.time),
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
      }))
    : null;
  // Cache only a closed detection candle that was actually returned; an empty
  // or still-open result must be retried next cycle.
  if (
    candles &&
    candles.some((k) => k.time === start) &&
    start + M15 <= Date.now()
  ) {
    if (cache.size > 2000) cache.clear();
    cache.set(key, candles);
  }
  return candles;
}
