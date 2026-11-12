/**
 * ABNeon bounce from a fresh low (owner 2026-11-11: KNOTS 9.11, SI 9.11, GANG 6.11 must be caught).
 *
 * At a new low there is no ABNeon zone yet: a zone is built from pivots, and a pivot low is confirmed only
 * 6 closed 4H candles (a day) later — the bounce is over by then. So the bounce from the low is taken
 * without a zone:
 *   1. The low candle: a closed 4H candle whose low is below every low of the previous 60 4H candles
 *      (10 days; a coin with less history — of all its candles, at least 30).
 *   2. The trigger: within the low candle and the next 6 closed 4H candles (no lower low in between),
 *      the first 4H candle that closes green (close > open), above the low candle's close (the low candle
 *      itself counts when it closes green), with not-grey Welkin volume on CoinGlass aggregated futures
 *      volume (A / Y / O / M / W — the same volume rule as the touch of a zone).
 *   3. The entry is not more than 25% above the low.
 *   4. Owner 2026-11-11 (7 of the first 10 live signals were low bounces on falling coins with grey / blue
 *      volume at the low; KNOTS and SI had orange): the low candle itself has bright aggregated volume —
 *      Welkin O / M / W (≥ average + 2σ), a capitulation low.
 * The low is the level: stop under it (−1%, 3…15% from entry), cancel on a 4H close under it.
 * No aggregated volume for the bars = no signal (aggregated data only).
 */
import { welkinColour } from "./abneon-volume-gate.js";

const H4 = 4 * 3_600_000;
export const LOW_BOUNCE_LOOKBACK = 60;
export const LOW_BOUNCE_MIN_HISTORY = 30;
export const LOW_BOUNCE_WINDOW = 6;
export const LOW_BOUNCE_MAX_ABOVE_LOW = 0.25;
const AVG_BARS = 20;
const NOT_GREY = new Set(["A", "Y", "O", "M", "W"]);
const BRIGHT = new Set(["O", "M", "W"]);

type Bar = { time: number; open: number; high: number; low: number; close: number };

export type LowBounce = {
  lowTime: number;
  low: number;
  lowClose: number;
  lowColour: string;
  triggerTime: number;
  triggerClose: number;
  colour: string;
};

/** The low candle for a trigger at index t (closed candles, oldest first), or -1. */
function lowCandleFor(cs: readonly Bar[], t: number): number {
  let li = -1;
  for (let k = Math.max(0, t - LOW_BOUNCE_WINDOW); k <= t; k++) {
    if (li < 0 || cs[k]!.low < cs[li]!.low) li = k;
  }
  if (li < LOW_BOUNCE_MIN_HISTORY) return -1;
  for (let k = Math.max(0, li - LOW_BOUNCE_LOOKBACK); k < li; k++) {
    if (cs[k]!.low <= cs[li]!.low) return -1;
  }
  return li;
}

function isTrigger(cs: readonly Bar[], li: number, k: number): boolean {
  const c = cs[k]!;
  return c.close > c.open && (k === li || c.close > cs[li]!.close);
}

/**
 * Price-only pre-check (no CoinGlass request): the last closed 4H candle may be a low-bounce trigger.
 * `candles4h` = closed candles, oldest first.
 */
export function lowBouncePriceCandidate(candles4h: readonly Bar[]): boolean {
  const t = candles4h.length - 1;
  if (t < 0) return false;
  const li = lowCandleFor(candles4h, t);
  if (li < 0 || !isTrigger(candles4h, li, t)) return false;
  return candles4h[t]!.close <= candles4h[li]!.low * (1 + LOW_BOUNCE_MAX_ABOVE_LOW);
}

/**
 * The low bounce whose trigger is the last closed 4H candle, or null.
 * `agg4hUsdByTime` = CoinGlass aggregated futures volume, USD, by 4H candle open time.
 */
export function findLowBounce(input: {
  candles4h: readonly Bar[];
  agg4hUsdByTime: ReadonlyMap<number, number>;
}): LowBounce | null {
  const cs = input.candles4h;
  const t = cs.length - 1;
  if (!lowBouncePriceCandidate(cs)) return null;
  const li = lowCandleFor(cs, t);
  const colourAt = (k: number): string | null => {
    if (k - (AVG_BARS - 1) < 0) return null;
    const vol: number[] = [];
    for (let q = k - (AVG_BARS - 1); q <= k; q++) {
      if (q > k - (AVG_BARS - 1) && cs[q]!.time - cs[q - 1]!.time !== H4) return null;
      const usd = input.agg4hUsdByTime.get(cs[q]!.time);
      if (!(usd != null && usd > 0 && cs[q]!.close > 0)) return null;
      vol.push(usd / cs[q]!.close);
    }
    return welkinColour(vol, vol.length - 1);
  };
  const lowColour = colourAt(li);
  if (lowColour === null || !BRIGHT.has(lowColour)) return null;
  // The first trigger only: an earlier candle of the same low that already qualified fired then.
  for (let k = li; k < t; k++) {
    if (!isTrigger(cs, li, k)) continue;
    const ck = colourAt(k);
    if (ck !== null && NOT_GREY.has(ck)) return null;
  }
  const colour = colourAt(t);
  if (colour === null || !NOT_GREY.has(colour)) return null;
  return {
    lowTime: cs[li]!.time,
    low: cs[li]!.low,
    lowClose: cs[li]!.close,
    lowColour,
    triggerTime: cs[t]!.time,
    triggerClose: cs[t]!.close,
    colour,
  };
}

/**
 * ABNeon stop (owner 2026-11-12): −6% from the entry, with room for a sweep of the level (liquidity grab).
 * Replaces the stop under the level (stopUnderLevel, kept for the studies of 2026-11-11/12) for new signals.
 */
export const ABNEON_STOP_PCT = 6;
export function abneonStop(entryPrice: number): number | null {
  return entryPrice > 0 ? entryPrice * (1 - ABNEON_STOP_PCT / 100) : null;
}

/** Stop under a level: level −1%, at least 3% and at most 15% from the entry (owner 2026-11-11). */
export function stopUnderLevel(entryPrice: number, levelBottom: number): number | null {
  if (!(entryPrice > 0) || !(levelBottom > 0)) return null;
  const raw = levelBottom * 0.99;
  const pct = Math.min(15, Math.max(3, (1 - raw / entryPrice) * 100));
  return entryPrice * (1 - pct / 100);
}
