---
name: SpotCVD circuit breaker (2026-07-10)
description: Root cause of a 42-min scan cycle and the fix — CoinGlass SpotCVD path had no circuit breaker, unlike OI.
---

`getCoinglassOI`/`batchGetCoinglassOI` had a circuit breaker (6 consecutive timeouts → skip rest), but `getSpotCvdMtf` in `coinglass_spot_cvd.ts` did not. It's called sequentially per-symbol (250+ times) in the main scan loop with no batching/concurrency wrapper.

During a real CoinGlass outage that coincided with a deploy restart (2026-07-10 ~13:05 UTC), every SpotCVD call burned ~16s (8s request + 300ms + 8s retry with a different key) with no way to bail early — this alone stretched one scan cycle from the normal 10-14 min to ~42 min, even though the OI circuit breaker tripped correctly within ~2 min.

**Why:** any per-symbol CoinGlass call path that runs in the main sequential scan loop needs its own circuit breaker — having one on OI doesn't protect other endpoints (SpotCVD, Taker, etc.) called the same way.

**How to apply:** fixed by adding a module-level circuit breaker to `coinglass_spot_cvd.ts` (6 consecutive failures → 2-min cooldown, shorter than OI's since SpotCVD is non-blocking/advisory for signals). If `coinglass_taker.ts`'s `getCoinglassTaker`-style per-symbol retry-with-different-key pattern ever shows the same symptom (long scan stretches during CG outages), apply the identical breaker there too — check `logger.warn(...".*retry с другим ключом.*")` call sites for candidates.
