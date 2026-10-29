/**
 * Owner 2026-10-29: an ABNeon bounce must not be empty — volume ×4 alone can
 * be a selling climax. Two direction checks at fire time (logic, not yet
 * backtested; aggregated data only, unknown data = no signal):
 *  1) futures takers bought on the reaction 1H candle: sum of aggregated
 *     taker buy − sell over its four closed 15m bars > 0;
 *  2) spot buyers in the last hour: aggregated spot CVD 1h > 0.
 */
export type NeonFlowGate =
  | { pass: true; takerNetUsd: number; spotCvd1h: true }
  | { pass: false; reason: "taker_unknown" | "taker_net_sell" | "spot_cvd_unknown" | "spot_cvd_negative";
      takerNetUsd: number | null; spotCvd1h: boolean | null };

const M15 = 15 * 60 * 1000;
const H1 = 60 * 60 * 1000;

/** Taker net (buy − sell, USD) over the reaction 1H candle; null unless all 4 closed 15m bars exist. */
export function reactionTakerNetUsd(
  bars: readonly { time: number; buy: number; sell: number }[] | null,
  reactionCandleTime: number,
  now: number,
): number | null {
  if (!bars) return null;
  const inside = bars.filter((b) => b.time >= reactionCandleTime && b.time < reactionCandleTime + H1 && b.time + M15 <= now);
  if (inside.length !== 4) return null;
  return inside.reduce((sum, b) => sum + b.buy - b.sell, 0);
}

export function evaluateNeonFlowGate(input: {
  takerNetUsd: number | null;
  spotCvd1h: boolean | null | undefined;
}): NeonFlowGate {
  const spot = input.spotCvd1h ?? null;
  if (input.takerNetUsd == null) return { pass: false, reason: "taker_unknown", takerNetUsd: null, spotCvd1h: spot };
  if (!(input.takerNetUsd > 0)) return { pass: false, reason: "taker_net_sell", takerNetUsd: input.takerNetUsd, spotCvd1h: spot };
  if (spot == null) return { pass: false, reason: "spot_cvd_unknown", takerNetUsd: input.takerNetUsd, spotCvd1h: null };
  if (!spot) return { pass: false, reason: "spot_cvd_negative", takerNetUsd: input.takerNetUsd, spotCvd1h: false };
  return { pass: true, takerNetUsd: input.takerNetUsd, spotCvd1h: true };
}
