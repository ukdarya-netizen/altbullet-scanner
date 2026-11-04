---
name: CoinGlass backfill tables
description: 5 PostgreSQL tables for historical CG data; schema/dedup/collection notes
---

## Tables

- `cg_large_orders_futures` — PK on `id` (CG row id); Binance only (exchange param for BingX → 500 error)
- `cg_large_orders_spot` — same schema; spot orderbook large-order history
- `cg_liq_heatmap_snapshot` — `UNIQUE(symbol, range, snapshot_at)`; symbol is base only (BTC not BTCUSDT); must truncate snapshot_at to hour in Python before INSERT
- `cg_hl_whale_events` — `UNIQUE(user_address, symbol, create_time)`; API returns max 50 records (~3h depth, no pagination)
- `cg_hl_whale_positions` — `UNIQUE(user_address, symbol, snapshot_at)`; current snapshot only

## Key findings

- `date_trunc('hour', snapshot_at)` in UNIQUE index or GENERATED column → PostgreSQL ERROR: not IMMUTABLE. Fix: truncate in application code before INSERT.
- BingX-exclusive tokens (38/224 from market_snapshots) return empty from CG heatmap and large-orders — both use Binance as underlying exchange.
- CoinGlass header: `CG-API-KEY` (not `coinglassSecret`). Base URL: `https://open-api-v4.coinglass.com`
- Liq heatmap endpoint: `/api/futures/liquidation/aggregated-heatmap/model2`; symbol = base only (BTC); ~8 credits/call; Professional plan required.
- collection script: `scripts/backfill_cg.py` (full) + `scripts/backfill_cg_heatmap.py` (heatmap+HL only, resumable)

## Fill counts (2026-07-20)

- futures large orders: 5,971 rows (224 symbols, ~2d depth)
- spot large orders: 2,474 rows (224 symbols, ~7d depth)
- liq heatmap: 186 snapshots (186/224 symbols; 38 BingX-exclusive have no CG data)
- HL whale events: 50 records (~3h depth)
- HL whale positions: 970 records (current snapshot)

**Why:** reference data for future archetype detector features / pattern research.
**How to apply:** when querying heatmap, symbol = base (strip -USDT); when re-running collection, script is resumable (checks already-done symbols).
