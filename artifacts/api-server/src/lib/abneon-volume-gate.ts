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
// Owner 2026-11-07: loosened from 11 to 10 of 12.
export const ABNEON_PRE_TOUCH_BLUE_MIN = 10;
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

/**
 * ABNeon touch volume (owner 2026-11-10, replaces the pre-touch gate as the blocking rule): the 4H candle
 * of the first touch of the zone or one of the next two 4H candles — only those already closed — is not
 * grey on Welkin VSA (volume above its 20-bar average, or ≥ 1.25× the previous bar), on CoinGlass
 * aggregated futures volume. No aggregated volume for those bars → no signal (aggregated data only).
 * Welkin colours as on the owner's charts: W > avg+4σ, M > +3σ, O > +2σ, A > avg, Y ≥ 1.25× previous, N grey.
 */
const H4 = 4 * H1;
export type TouchVolume =
  | { ok: true; colours: string[]; firstTouchTime: number }
  | { ok: false; reason: "no_trigger" | "no_aggregated_volume" | "short_history" | "touch_bar_not_closed" | "touch_volume_grey"; colours: string[] };

/** First closed 1H candle after the arm whose low reached the zone top (+0.2%) — as the pre-touch gate. */
export function firstTouchTime(candles1h: readonly Bar[], armCandleTime: number, triggerCandleTime: number, zoneTop: number): number | null {
  const cs = [...candles1h].sort((a, b) => a.time - b.time);
  const ti = cs.findIndex((c) => c.time === triggerCandleTime);
  if (ti < 0) return null;
  let w0 = ti;
  while (w0 - 1 >= 0 && cs[w0 - 1]!.time + H1 > armCandleTime) w0--;
  for (let k = w0; k <= ti; k++) if (cs[k]!.low <= zoneTop * 1.002) return cs[k]!.time;
  return cs[w0]!.time;
}

export function welkinColour(vol: readonly number[], j: number): string {
  let s = 0;
  for (let q = j - AVG_BARS + 1; q <= j; q++) s += vol[q]!;
  const avg = s / AVG_BARS;
  let v2 = 0;
  for (let q = j - AVG_BARS + 1; q <= j; q++) v2 += (vol[q]! - avg) ** 2;
  const sd = Math.sqrt(v2 / AVG_BARS);
  const v = vol[j]!;
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  const prev = j > 0 ? vol[j - 1]! : 0;
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}

export function touchVolumeNotGrey(input: {
  candles1h: readonly Bar[];
  candles4h: readonly Bar[];
  /** CoinGlass aggregated futures volume, USD, by 4H candle open time. */
  agg4hUsdByTime: ReadonlyMap<number, number>;
  armCandleTime: number;
  triggerCandleTime: number;
  zoneTop: number;
  nowMs: number;
}): TouchVolume {
  const touch = firstTouchTime(input.candles1h, input.armCandleTime, input.triggerCandleTime, input.zoneTop);
  if (touch === null) return { ok: false, reason: "no_trigger", colours: [] };
  const cs = [...input.candles4h].sort((a, b) => a.time - b.time);
  let j0 = -1;
  for (let j = 0; j < cs.length; j++) if (cs[j]!.time <= touch) j0 = j;
  if (j0 < 0) return { ok: false, reason: "short_history", colours: [] };
  const from = j0 - (AVG_BARS - 1);
  if (from < 0) return { ok: false, reason: "short_history", colours: [] };
  const vol: number[] = [];
  const colours: string[] = [];
  for (let j = from; j < cs.length && j <= j0 + 2; j++) {
    const c = cs[j]!;
    if (c.time + H4 > input.nowMs) break; // only closed 4H candles
    if (j > from && c.time - cs[j - 1]!.time !== H4) return { ok: false, reason: "short_history", colours };
    const usd = input.agg4hUsdByTime.get(c.time);
    if (!(usd != null && usd > 0 && c.close > 0)) return { ok: false, reason: "no_aggregated_volume", colours };
    vol.push(usd / c.close);
    if (j >= j0) colours.push(welkinColour(vol, vol.length - 1));
  }
  if (!colours.length) return { ok: false, reason: "touch_bar_not_closed", colours };
  return colours.some((c) => c !== "N") ? { ok: true, colours, firstTouchTime: touch } : { ok: false, reason: "touch_volume_grey", colours };
}
