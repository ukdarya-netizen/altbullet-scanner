/**
 * Impulse Buy: Lucy's VSA on the 30m signal candle (owner 2026-11-18, «внедряем VSA»).
 *
 * No Impulse Buy when the closed 30m candle the signal is judged on is a climax bar on Lucy's VSA — orange, purple
 * or white (above its 20-bar average by more than 2σ / 3σ / 4σ, and not under the 120-bar average). IB review
 * 09.11–18.11 (reports/ib-review-1118), the live signals that passed the 24h-growth and Wyckoff rules: the climax
 * candles HANA 09.11, JCT 11.11, GUN, UAI, ON — 0 of 5 reached +10% before −8%; blue 4 of 5; grey 2 of 5.
 *
 * Volume = Lucy's VSA total: aggregated futures + aggregated spot USD (CoinGlass, all exchanges; spot missing counts
 * as 0, as on the indicator). The 30m bar is the sum of its two 15m bars. Futures missing for any of the 120 bars →
 * no reading → no signal (owner rule: aggregated data only, no fallbacks).
 */
import { lucyColour, LUCY_LONG_BARS } from "./abneon-volume-gate.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { getAggSpotVolumeByInterval } from "./coinglass_spot_taker.js";

const M15 = 15 * 60_000;
const M30 = 30 * 60_000;
/**
 * Owner 2026-11-18 (ZIL 17:00–17:30 Dubai: orange on her Lucy's VSA, the IB still fired): CoinGlass keeps adding
 * to a bar for a few minutes after its close. The colour is read only from 5 minutes after the candle's close, on
 * fresh (uncached) data; earlier the IB waits (no signal yet, the next scan reads it again).
 */
export const IB_VSA_SETTLE_MS = 5 * 60_000;
export const IB_CLIMAX_COLOURS: ReadonlySet<string> = new Set(["O", "M", "W"]);

/** 30m volume of the candle opening at `start`: both 15m halves required (spot halves → 0 when missing). */
function bar30(fut15: ReadonlyMap<number, number>, spot15: ReadonlyMap<number, number> | null, start: number): number | null {
  const a = fut15.get(start), b = fut15.get(start + M15);
  if (a == null || b == null) return null;
  const sa = spot15?.get(start), sb = spot15?.get(start + M15);
  const spot = sa != null && sb != null ? sa + sb : 0;
  return a + b + spot;
}

/** Lucy's VSA colour of the 30m candle opening at `candleStart` (null when the 120 bars are not all there). */
export function lucyColour30m(fut15: ReadonlyMap<number, number>, spot15: ReadonlyMap<number, number> | null, candleStart: number): string | null {
  const vol: number[] = [];
  for (let k = LUCY_LONG_BARS - 1; k >= 0; k--) {
    const v = bar30(fut15, spot15, candleStart - k * M30);
    if (v === null) return null;
    vol.push(v);
  }
  return lucyColour(vol, vol.length - 1);
}

export type IbCandleVsa = { colour: string | null; climax: boolean; reason: string | null };

/** Reads the colour for the IB gate; fetches 15m aggregated futures and spot (cached closed bars for futures). */
export async function ibSignalCandleVsa(symbol: string, candleStart: number, nowMs = Date.now()): Promise<IbCandleVsa> {
  if (nowMs < candleStart + M30 + IB_VSA_SETTLE_MS) return { colour: null, climax: false, reason: "volume_not_settled" };
  const bars = LUCY_LONG_BARS * 2 + 8;
  const [fut, spot] = await Promise.all([
    getAggFuturesVolumeByInterval(symbol, "15m", bars, nowMs, "high", 15_000, true).catch(() => null),
    getAggSpotVolumeByInterval(symbol, "15m", bars).catch(() => null),
  ]);
  if (!fut) return { colour: null, climax: false, reason: "no_aggregated_futures_volume" };
  const colour = lucyColour30m(fut, spot, candleStart);
  if (colour === null) return { colour: null, climax: false, reason: "short_aggregated_history" };
  return { colour, climax: IB_CLIMAX_COLOURS.has(colour), reason: null };
}
