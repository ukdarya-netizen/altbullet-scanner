---
name: bid_wall_absorption + liq_magnet_squeeze patterns
description: Correct data sources and gates for both new patterns — key review lessons.
---

## bid_wall_absorption

**Data source:** `getLargeObHistory(symbol, price)` — `/api/futures/orderbook/large-limit-order/history` (10m cache).
- `order_state=2` = filled (absorbed by market); others = cancelled/spoof.
- `absorbed = filledBidUsd >= totalBidVol * 0.50`. Fail-open if API down.
- Do NOT use `getLargeObComparison` (in-memory snapshot compare — wrong, no history).

**Cycle persistence gate:** `_bidWallCandidateMap` (Map<symbol, entry>) not a Set.
- Entry comes from `getBidWallLayer9Candidates()` which includes `detectedAt` (ms timestamp).
- Check: `Date.now() - entry.detectedAt >= 10 * 60 * 1000` (≥1 full scan cycle ≈10min).
- This prevents misfires on brand-new wall detections (could be spoof that self-clears in <10min).

**CVD gate:** `spotCvd?.cvd1h === true || (_spotTaker?.netBuyPct ?? -99) >= 5`
- No price-change shortcut (`|| priceChange >= 0.5` was rejected).
- Both conditions are fail-open (null/missing = pass).

**Why:** Code review rejected first impl for using wrong comparison approach and a price shortcut that could fire without actual buy pressure.

## liq_magnet_squeeze

**Data source:** `getLiqMapClusters(symbol, price)` — `/api/futures/liquidation/map` (15m cache).
- Different TTL from `getShortLiqClusters` (uses `aggregated-heatmap/model2`, 10m).
- Response format same as heatmap (y_axis + liquidation_leverage_data); parsed with `extractClusters`.
- Cache key: per base symbol in `_liqMapCache` (separate from `_cache` used by `getLevels`).
- Sanity check: currentPrice must be within ±20% of heatmap y_axis range (ticker collision guard).

**Funding gate (lazy):** `getCoinglassAggregateFunding(symbol) <= 0.0001` (≤0.01%).
- If funding > 0.01%, longs are overleveraged → skip (risk/reward unfavorable).
- Fail-open: if null/error, gate passes.
- Same pattern as `flush_reversal` (line ~5677 in scanner.ts).

**SL:** −5% (not −8%). Short stop because liquidation cluster IS the target (magnet).

**Why:** Code review rejected using wrong endpoint (heatmap/model2 = different data freshness contract) and missing funding gate that is essential to filter overleveraged-long environments.
