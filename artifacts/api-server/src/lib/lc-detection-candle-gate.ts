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
// Owner 2026-10-27: a red body deeper than 5.5% is a continuation, not an
// exhausted cascade. Our LC watches Jul 14 - Oct 24 (reports/full), take +5%,
// stop -10%: bodies -3.5..-5.5% positive in every month (Jul +9, Aug +4,
// Sep +64, Oct w/o 15.10 +145, 15.10 +381; 174 trades); deeper bodies negative
// in Jul, Aug and Sep. Stable for cut-offs -5.0..-6.0 with take +10%.
// Owner 2026-11-12: the −5.5% floor is removed (reports/lc-entry-variants: on the detection candle, no floor
// = 224 trades +246% / +1.10% avg, every month ≥ 0, vs 94 trades +182% with it). Kept for the shadow
// readings only; the gate no longer reads it.
export const LC_MIN_DETECTION_CANDLE_BODY_PCT = -5.5;
// Owner 2026-11-27: 30 min (was 15). The fire cycle is deferred while the main scanner runs, and the
// 15-minute window lost real passes (AKE 22.11: candle −11.3%, «entry window passed»).
export const LC_DETECTION_ENTRY_WINDOW_MS = 30 * 60 * 1000;
// Owner 2026-11-27 (reports/lc-final-1126, watches 12–26.11): the cascade is judged on the candles
// AROUND the detection — 3 before (the cascade often runs before the bot sees the liquidation spike:
// AKE 15.11 fell −6.6/−11.4/−6.1% before the watch) to 1 after. The largest-range candle of that window
// must be ≥ 5.6%; a red body is no longer required (a big candle with a buy-back did better: current rule
// 4 champions / 12 bad, any big candle in the window 37 / 49). Then the NEXT candle (rebound) must not
// keep falling: body ≥ −1% (on those 70 new candidates: 25 / 33 champions vs 16 / 37 bad pass). Entry
// after the rebound candle closes.
export const LC_CASCADE_WINDOW_BEFORE = 3;
export const LC_CASCADE_WINDOW_AFTER = 1;
export const LC_MIN_REBOUND_BODY_PCT = -1;

const M15 = 15 * 60 * 1000;

export interface LcDetectionCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type LcDetectionCandleDecision =
  | {
      pass: true;
      rangePct: number;
      lowerWickPct: number;
      bodyPct: number;
      cascadeCandleTime: number;
      reboundBodyPct: number;
    }
  | {
      pass: false;
      reason:
        | "detection_candle_unavailable"
        | "detection_candle_too_small"
        | "detection_candle_not_capitulation"
        | "detection_candle_no_rebound"
        | "detection_candle_entry_window_passed"
        | "detection_candle_pending";
      rangePct: number | null;
      lowerWickPct: number | null;
      bodyPct: number | null;
      cascadeCandleTime?: number | null;
      reboundBodyPct?: number | null;
    };

function validCandle(c: LcDetectionCandle | undefined): c is LcDetectionCandle {
  return (
    c !== undefined &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.open > 0 &&
    c.low > 0 &&
    c.high >= c.low
  );
}

/** Time by which every candle the gate may need is closed (window end). */
export function lcCascadeWindowClosesAt(detectedAt: number): number {
  const start = Math.floor(detectedAt / M15) * M15;
  return start + (LC_CASCADE_WINDOW_AFTER + 1) * M15;
}

export function evaluateLcDetectionCandleGate(
  candles: readonly LcDetectionCandle[] | null,
  detectedAt: number,
  now: number,
): LcDetectionCandleDecision {
  const pending = {
    pass: false as const,
    reason: "detection_candle_pending" as const,
    rangePct: null,
    lowerWickPct: null,
    bodyPct: null,
  };
  const start = Math.floor(detectedAt / M15) * M15;
  const windowClose = lcCascadeWindowClosesAt(detectedAt);
  if (windowClose > now) return pending;
  const unavailable = {
    pass: false as const,
    reason: "detection_candle_unavailable" as const,
    rangePct: null,
    lowerWickPct: null,
    bodyPct: null,
  };
  const byTime = new Map<number, LcDetectionCandle>();
  for (const k of candles ?? []) byTime.set(k.time, k);
  // The detection candle itself and the one after it are required; earlier ones may be missing on a
  // freshly listed coin.
  if (!validCandle(byTime.get(start)) || !validCandle(byTime.get(start + M15))) {
    return unavailable;
  }
  let cascade: LcDetectionCandle | null = null;
  let cascadeRange = -Infinity;
  for (let i = -LC_CASCADE_WINDOW_BEFORE; i <= LC_CASCADE_WINDOW_AFTER; i++) {
    const c = byTime.get(start + i * M15);
    if (!validCandle(c) || c.time + M15 > now) continue;
    const r = ((c.high - c.low) / c.open) * 100;
    if (r > cascadeRange) {
      cascadeRange = r;
      cascade = c;
    }
  }
  if (!cascade) return unavailable;
  const rangePct = cascadeRange;
  const lowerWickPct =
    ((Math.min(cascade.open, cascade.close) - cascade.low) / cascade.open) * 100;
  const bodyPct = ((cascade.close - cascade.open) / cascade.open) * 100;
  const base = { rangePct, lowerWickPct, bodyPct, cascadeCandleTime: cascade.time };
  if (rangePct < LC_MIN_DETECTION_CANDLE_RANGE_PCT) {
    return { pass: false, reason: "detection_candle_too_small", ...base, reboundBodyPct: null };
  }
  const reboundTime = cascade.time + M15;
  if (reboundTime + M15 > now) return { ...pending, ...base, reboundBodyPct: null };
  const rebound = byTime.get(reboundTime);
  if (!validCandle(rebound)) {
    return { ...unavailable, ...base, reboundBodyPct: null };
  }
  const reboundBodyPct = ((rebound.close - rebound.open) / rebound.open) * 100;
  if (reboundBodyPct < LC_MIN_REBOUND_BODY_PCT) {
    return { pass: false, reason: "detection_candle_no_rebound", ...base, reboundBodyPct };
  }
  // The edge is the entry right after the rebound (or the window end, whichever is later); a late fire
  // is a different trade, so the window is terminal.
  const readyAt = Math.max(windowClose, reboundTime + M15);
  if (now > readyAt + LC_DETECTION_ENTRY_WINDOW_MS) {
    return { pass: false, reason: "detection_candle_entry_window_passed", ...base, reboundBodyPct };
  }
  return { pass: true, ...base, reboundBodyPct };
}

const cache = new Map<string, LcDetectionCandle[] | null>();

export async function loadLcDetectionCandle(
  symbol: string,
  detectedAt: number,
): Promise<LcDetectionCandle[] | null> {
  const start = Math.floor(detectedAt / M15) * M15;
  // Window −3..+1 plus the rebound of the last window candle (+2).
  const from = start - LC_CASCADE_WINDOW_BEFORE * M15;
  const to = start + (LC_CASCADE_WINDOW_AFTER + 2) * M15;
  const key = `${symbol}:${start}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const rows = await Promise.race([
    getKlinesRange(symbol, "15m", from, to),
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
  // Cache only once every candle the gate may read is closed and returned; otherwise retry next cycle.
  if (
    candles &&
    candles.some((k) => k.time === start) &&
    candles.some((k) => k.time === to - M15) &&
    to <= Date.now()
  ) {
    if (cache.size > 2000) cache.clear();
    cache.set(key, candles);
  }
  return candles;
}
