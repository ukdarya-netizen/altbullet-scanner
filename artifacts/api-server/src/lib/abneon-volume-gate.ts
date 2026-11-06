/**
 * ABNeon pre-touch volume gate (owner 2026-11-06).
 *
 * A bounce is taken only when, of the 12 closed 1H candles BEFORE the first touch of the zone, at least
 * 11 had aggregated futures volume (CoinGlass, all exchanges) above their own 20-bar average (Welkin
 * "blue" or brighter: A / O / M / W). Backtest 07.09–06.11 (ABNeon v3, 558 coins, the bot's own signals):
 * 203 signals, +1.64% per trade, +1.89% / +1.38% in the two halves, vs −0.80% without the gate.
 * No aggregated data for those bars → no signal (owner rule: aggregated data only, no fallbacks).
 *
 * Volume of a bar = CoinGlass aggregated taker buy + sell USD / BingX close (same as the backtest).
 * The first touch = the first closed 1H candle after the arm whose low reached the zone top (+0.2%).
 */
const H1 = 3_600_000;
export const ABNEON_PRE_TOUCH_BLUE_MIN = 11;
export const ABNEON_PRE_TOUCH_BARS = 12;
const AVG_BARS = 20;

type Bar = { time: number; low: number; close: number };

export type PreTouchVolume =
  | { ok: true; blue: number; firstTouchTime: number }
  | { ok: false; reason: "no_trigger" | "no_aggregated_volume" | "short_history"; blue: null };

export function preTouchBlueCount(input: {
  candles1h: readonly Bar[];
  /** CoinGlass aggregated futures volume, USD, by 1H candle open time. */
  aggUsdByTime: ReadonlyMap<number, number>;
  armCandleTime: number;
  triggerCandleTime: number;
  zoneTop: number;
}): PreTouchVolume {
  const cs = [...input.candles1h].sort((a, b) => a.time - b.time);
  const ti = cs.findIndex((c) => c.time === input.triggerCandleTime);
  if (ti < 0) return { ok: false, reason: "no_trigger", blue: null };
  let w0 = ti;
  while (w0 - 1 >= 0 && cs[w0 - 1]!.time + H1 > input.armCandleTime) w0--;
  let first = w0;
  for (let k = w0; k <= ti; k++) {
    if (cs[k]!.low <= input.zoneTop * 1.002) {
      first = k;
      break;
    }
  }
  const from = first - ABNEON_PRE_TOUCH_BARS - (AVG_BARS - 1);
  if (from < 0) return { ok: false, reason: "short_history", blue: null };
  const vol: number[] = [];
  for (let k = from; k < first; k++) {
    const c = cs[k]!;
    // Consecutive hours only: a gap in BingX candles is missing data.
    if (k > from && c.time - cs[k - 1]!.time !== H1) return { ok: false, reason: "short_history", blue: null };
    const usd = input.aggUsdByTime.get(c.time);
    if (!(usd != null && usd > 0 && c.close > 0)) return { ok: false, reason: "no_aggregated_volume", blue: null };
    vol.push(usd / c.close);
  }
  let blue = 0;
  for (let j = AVG_BARS - 1; j < vol.length; j++) {
    let sum = 0;
    for (let q = j - AVG_BARS + 1; q <= j; q++) sum += vol[q]!;
    if (vol[j]! > sum / AVG_BARS) blue++;
  }
  return { ok: true, blue, firstTouchTime: cs[first]!.time };
}
