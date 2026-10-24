---
name: CoinGlass ticker-collision cross-validation
description: Short/generic tickers (e.g. US-USDT) can silently match the wrong instrument in CoinGlass's symbol-based API, producing OI values off by 80-100x. How the fix works and where it's wired.
---

## Root cause

`coinglass_oi.ts` resolves a BingX symbol to a CoinGlass symbol purely by string match (`toBaseSymbol` + `cgSymbolCandidates`, e.g. "US" → tries "US" then "USUSDT"). CoinGlass's legacy v2 endpoint (`open_interest?symbol=US`) has no stronger identity check than that string — for short/generic tickers (US=Talus, AI, etc.) it can return data for a different/larger instrument entirely. Discovered via US-USDT: our snapshot showed OI ~$1.5-2B vs real (Coinalyze) ~$19M, while price matched closely — the giveaway that only OI, not price, was wrong.

This is a **general symbol-resolution risk**, not a one-off bad ticker — any new short/ambiguous ticker BingX lists could hit it silently, corrupting `oi24h_accum` and other OI-based patterns for that symbol without any error being thrown (CoinGlass returns 200 with "valid-looking" data).

## Fix — magnitude cross-validation against an independent source

Per-symbol ticker aliasing (`CG_SYMBOL_ALIAS`) can't fix this — the collision isn't a *missing* alias, it's CoinGlass returning data for the wrong asset under a technically-valid symbol match. Instead, `getCoinglassOI(symbol, priceUsd?)` now optionally cross-checks the returned aggregate OI (USD) against BingX's own direct OI endpoint (`getOpenInterest` × price, cached 5min, separate from the CoinGlass response — i.e. an independent source, not another read of the same possibly-mismatched CoinGlass data). If the ratio exceeds 30x either direction, the result is discarded (`available:false`) and logged as a suspected collision, rather than silently feeding corrupted magnitude data downstream.

30x tolerance is deliberately generous — CoinGlass's "All" row aggregates OI across many exchanges while BingX is one venue, so legitimate multi-exchange majors can show real ratios of several x. 80-100x (the observed case) is far outside any legitimate aggregation difference.

**How to apply:** any new call site of `getCoinglassOI`/`batchGetCoinglassOI` should pass the current price (`priceUsd` param / `priceMap`) when cheaply available, to get this protection for free. As of 2026-07-09, ALL call sites are wired: `scanner.ts`'s main OI Universe Discovery batch call (feeds every pattern via the shared `coinglassOIMap`), plus every `watcher.ts` call site (accum scout OI drain/build checks, stale-cancel NetChange guard, smart-cancel OI 4h guard, volume_breakout stale-hold, OI Watch fill/confirm, market-health digests) — each passes `currentPrice`/`priceMap.get(symbol)` already in local scope. No known unprotected OI read remains.

## Follow-up fixes (2026-07-10, POWER-USDT case)

Two bugs let a real collision (POWER-USDT, CoinGlass ~$204-240M vs real ~$1.8-17M) still fire an `oi24h_accumulation` signal even after the above fix was live — see [BingX OI unit bug](bingx-oi-usd-unit-bug.md) for the unit-multiplication root cause. Separately, `available:false` was being treated as generic "unavailable, don't block" everywhere, including in the oi24h_accum live re-check — this fails open on a genuinely detected collision, not just on real API outages. Fixed by adding a distinct `collisionSuspected` flag on `CoinglassOIResult`, separate from plain unavailability, and making the oi24h_accum live-recheck treat `collisionSuspected` as a hard block instead of falling through the `catch`. Any future consumer of `getCoinglassOI` that currently fails open on `available:false` should check `collisionSuspected` too before assuming "just missing data."

## Structural gap: the cross-check never re-validates already-stored history

Manually diffing `oi_daily_snapshots` against live BingX OI (2026-07-10) found RSR-USDT, AKE-USDT, TAC-USDT sitting with impossible absolute OI values (ratio 1600x-38000x vs real BingX OI) for at least 5 consecutive days, undetected the whole time — because day-to-day deltas looked smooth even though the absolute magnitude was nonsense, and the `OI_MISMATCH_RATIO` check only runs against *freshly fetched* data at request time (write path in `saveDailyOiSnapshots`, or the live re-check at signal-fire time). It never re-validates rows already sitting in the table. Any row written before the check existed, or during a request that hit a plain timeout (not a rejected collision — a different code path with no magnitude check at all), permanently poisons downstream growth calculations for that symbol until manually cleaned.

**How to apply:** don't treat "the write path has a validator" as sufficient — a startup/periodic job (`cleanupOiCollisionArtifacts` in watcher.ts) that diffs recent stored snapshots against a fresh live-OI cross-check is needed as a safety net, since corrupted history can enter through timeout gaps or pre-fix data and then sit silently.
