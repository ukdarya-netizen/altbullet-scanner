---
name: market_cap_cache concurrent-upsert deadlock
description: Pre-existing (since 2026-06-24), non-blocking Postgres deadlock on market_cap_cache upserts — not a new regression, safe to ignore for now.
---

`forceReloadAllMarketCaps` (whale_watch_v2.ts) fires 3 `persistMarketCapsToDB` calls (coinglass/coingecko/coinpaprika) via `Promise.all` — each does a chunked `insert ... on conflict do update` into the same `market_cap_cache` table. When two sources' batches touch overlapping symbols in different row order, Postgres can deadlock between the two concurrent transactions.

**Why this surfaces:** runs at every server startup and every 6h refresh; confirmed present in logs on 2026-07-10 restart, but the underlying code is unchanged since 2026-06-24 — this is not a new regression, just never investigated/documented before (attention was on scanner/pattern work).

**Impact:** non-blocking. Call is wrapped in try/catch; failure just logs a `warn` ("MarketCap DB persist failed — пропускаем") and skips that one source's persist for the cycle. Does not affect scan cycles or signal creation.

**How to apply:** if asked to fix, replace `Promise.all([...persistJobs])` with sequential `await` of the three `persistMarketCapsToDB` calls (not parallel) to remove the concurrent-write path entirely. Low priority — cosmetic log noise, not a functional bug, but real to check that the deploy timeline lines up before dismissing as unrelated to a different set of changes.
