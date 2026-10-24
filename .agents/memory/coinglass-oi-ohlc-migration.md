---
name: CoinGlass OI OHLC migration
description: getCoinglassOI migrated from v2 snapshot to v4 aggregated-history OHLC; new fields; cycle-shift removed.
---

## Rule
`getCoinglassOI` now uses `/api/futures/open-interest/aggregated-history?interval=30m&limit=50` (v4 Professional, host `open-api-v4.coinglass.com`, header `CG-API-KEY`). The old v2 `/public/v2/open_interest` endpoint (header `coinglassSecret`) is gone.

**Why:** v2 was a legacy snapshot endpoint; OHLC history gives a time series from which we compute all deltas ourselves plus new trend/quality fields.

## New CoinglassOIResult fields
- `prevOi30m` — delta of candle[-2]; replaces the inter-cycle shift `pe.prevOi30m = pe.lastOi30m`
- `positiveCandles6h` — count of up-candles in last 12 × 30m (6h window)
- `oiConsecutiveUp` — streak of consecutive positive 30m candles from end
- `oi4hConsecFromOhlc` — consecutive 4h-periods of OI growth (from 30m candles, replaces per-cycle counter)

## Fields now always null
- `cgVolUsd` — OHLC has no volume data; L2 cgVolumeCache won't update from CoinGlass (falls back to BingX ticker volume, already handled)
- `bingxOiChange30m` — OHLC is aggregate-only, no per-exchange breakdown

## How to apply
- `batchGetCoinglassOI` concurrency raised: CONCURRENCY=5, MIN_SLOT_DELAY=400ms (Professional plan 600 req/min vs Standard 300).
- Collision detection still works: `oiUsd = candle[-1].close` (aggregate OI) vs BingX direct OI.
- Scanner cycle-shift removed: `pe.prevOi30m = cg.prevOi30m` (from API, not from previous cycle).
- `pe.oi4hConsecGrowth = cg.oi4hConsecFromOhlc` (OHLC truth, not scan-cycle proxy).
- Any inline `CoinglassOIResult` literal must include ALL new fields or TypeScript will error.
