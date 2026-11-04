---
name: Spot data missing in fast-cycle signals
description: trackSignal had no universal spot data enrichment; daily_oi_accum AlphaResult hardcoded null; fixed 2026-07-16
---

## The problem
Three independent gaps caused spot data to be null in signals:

1. **entrySpotVolMult** in `trackSignal` was `params.entrySpotVolMult ?? null` — no prescanEntry fallback.
   Main scanner loop passes it via `_spotVolMultMapScan` bridge, but fast-cycle paths (daily_oi_accum, whale_futures, whale_alert) never did.

2. **entrySpotVol24h / entrySpotMcapPct** in `trackSignal` were `params.xxx ?? null` — no auto-fetch from CoinGlass at all.
   `getCoinglassSpotVolume24h` has a 30-min cache so fetching in trackSignal is cheap.

3. **daily_oi_accum_experiment** fire path (`runDailyOiAccumSignalCycle`) had `spotVol24h: null` hardcoded in AlphaResult, so the Telegram alert showed no spot data regardless of what trackSignal stored.

## Fix applied (2026-07-16)

**trackSignal universal enrichment block:**
- Added `entrySpotVolMult` from prescanE fallback: `lastSpotVol1h / spotVolAvg1h`
- Added `getCoinglassSpotVolume24h` to the parallel Promise.all (skipped if already provided via params)
- mcapUsd auto-resolved via `getSpotPoolEntry` if not in params
- `entrySpotMcapPct` computed if spotVol24h and mcapUsd both available

**runDailyOiAccumSignalCycle:**
- Fetches `getCoinglassSpotVolume24h` + `getSpotPoolEntry` before building AlphaResult
- Passes `entrySpotVol24h`, `entrySpotMcapPct`, `marketCapUsd` to trackSignal (prevents double-fetch)
- AlphaResult uses real values instead of null

**Why:**
- `daily_oi_accum_experiment` fires via a separate fast-cycle queue, not through the main scan loop
- The `_spotVolMultMapScan` Map bridge (loop1→loop2) is only populated inside `performScan()`
- Any signal that fires outside `performScan()` (whale_alert, whale_futures, daily_oi_accum) is blind to spot data unless it fetches independently

**How to apply:**
Any new signal fire path outside `performScan()` must either:
a) Fetch spot data explicitly before calling trackSignal (preferred — avoids double fetch), OR
b) Rely on the universal enrichment now in trackSignal (getCoinglassSpotVolume24h + prescanE fallback)
