---
name: L14 v2 — Spot Orderbook Imbalance
description: L14 replaced (on-chain outflow → spot OB bid/ask imbalance). Job, table, route, UI all updated.
---

## Rule
L14 is now `spot-orderbook-job.ts` (CoinGlass `aggregated-ask-bids-history`).
Old `inflow-outflow-job.ts` is dead code — retained for historical `inflow_outflow_l14_pool` data, NOT imported anywhere.

## Design
- Endpoint: `GET /api/spot/orderbook/aggregated-ask-bids-history`
- Params: `exchange_list=Binance,OKX,Bybit,Bitget`, `interval=1h`, `limit=2`, `range=2`
- Symbol mapping: BingX "1000PEPE-USDT" → CG "PEPE" (strip "-USDT", strip "1000" prefix via `/^1000[A-Z]/`)
- Gate: `bids_usd ≥ $200K` AND `bids/asks ratio ≥ 1.5x`
- Scan scope: top 300 BingX symbols by 24h volume (concurrency 15)
- Pool TTL: 24h. Dedup: 4h per symbol
- Run: every 30 min, first run at t+7 min after server start

## DB
- New table: `spot_ob_pool` (schema in `lib/db/src/schema/signals.ts`, `spotObPoolTable`)
- Migration in `runStartupMigration` Part 3 (prod only via NODE_ENV gate)
- Dev DB: create manually with `psql $DATABASE_URL` (as done 2026-07-20)

## Files
- `artifacts/api-server/src/lib/spot-orderbook-job.ts` — job (runSpotOrderbookJob, loadSpotObPoolFromDb, getSpotObSnapshot)
- Route: `/api/scanner/inflow-outflow` (URL unchanged) returns new pool shape: bidsUsd/asksUsd/bidAskRatio
- UI: candidates.tsx tab "L14 OB", columns: Биды/Аски/Ratio/Цена входа/Рост/Статус/Обнаружен/Истекает

**Why:** On-chain CG outflow data was unreliable (API frequent empty responses, $2M threshold excluded most altcoins); spot OB imbalance is a direct real-time buy-pressure signal.

**How to apply:** If L14 OB fires 0 tokens, check: (1) CG API key working, (2) ratio/bids thresholds maybe too strict, (3) BingX-exclusive tokens naturally return empty from CG.
