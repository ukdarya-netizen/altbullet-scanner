import { getAggregatedFuturesTakerNetBuyPct15m } from "./coinglass_taker.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { normalizeImpulseTakerNetBuyPct } from "./scanner-patterns.js";

/**
 * Owner rule: no aggregated data, no signal. Used by every fire path that does
 * not go through the main scanner gate (OI Watch, LC fire cycle). Returns the
 * list of missing aggregated inputs; empty means the signal may fire.
 */
export async function missingAggregatedFireData(
  symbol: string,
): Promise<string[]> {
  const missing: string[] = [];
  const rawTaker = await getAggregatedFuturesTakerNetBuyPct15m(
    symbol,
    7000,
  ).catch(() => null);
  const futTaker = normalizeImpulseTakerNetBuyPct(rawTaker ?? undefined);
  if (futTaker === null) missing.push("fut_taker");
  const cvd = await getSpotCvdMtf(symbol, {
    priority: "high",
  }).catch(() => null);
  if (cvd?.available !== true) missing.push("spot_cvd");
  return missing;
}
