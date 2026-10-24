/**
 * Decision-time spatial summary of a liquidation heatmap. "Above" and "below"
 * describe price levels, NOT long/short liquidation direction.
 */
export function buildLiqHeatmapShadow(
  prices: readonly number[],
  values: readonly number[],
  entryPrice: number,
  fetchedAt: string,
  source = "coinglass_aggregated_heatmap_model2_3d",
): Record<string, unknown> {
  const base = { version: 1, source, fetchedAt, entryPrice };
  if (
    !(entryPrice > 0) ||
    prices.length === 0 ||
    prices.length !== values.length ||
    !prices.every((price) => Number.isFinite(price) && price > 0) ||
    entryPrice < Math.min(...prices) * 0.8 ||
    entryPrice > Math.max(...prices) * 1.2
  ) {
    return { ...base, available: false, reason: "price_range_mismatch" };
  }

  const bands = {
    below0to5: 0,
    below5to10: 0,
    below10to20: 0,
    above0to5: 0,
    above5to10: 0,
    above10to20: 0,
  };
  const below: { price: number; distancePct: number; value: number }[] = [];
  const above: { price: number; distancePct: number; value: number }[] = [];

  for (let i = 0; i < prices.length; i++) {
    const price = prices[i]!;
    const value = values[i]!;
    if (!Number.isFinite(value) || value <= 0) continue;
    const distancePct = ((price - entryPrice) / entryPrice) * 100;
    const distance = Math.abs(distancePct);
    if (distance < 0.01 || distance > 20) continue;
    const side = distancePct < 0 ? below : above;
    side.push({
      price,
      distancePct: Number(distancePct.toFixed(3)),
      value,
    });
    const band =
      distance < 5
        ? distancePct < 0
          ? "below0to5"
          : "above0to5"
        : distance < 10
          ? distancePct < 0
            ? "below5to10"
            : "above5to10"
          : distancePct < 0
            ? "below10to20"
            : "above10to20";
    bands[band] += value;
  }

  const top = (items: typeof below) =>
    items.sort((a, b) => b.value - a.value).slice(0, 3);
  return {
    ...base,
    available: true,
    bands,
    belowBinCount: below.length,
    aboveBinCount: above.length,
    topBelow: top(below),
    topAbove: top(above),
  };
}
