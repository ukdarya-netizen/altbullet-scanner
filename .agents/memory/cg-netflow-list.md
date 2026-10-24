---
name: CoinGlass netflow-list batch endpoint
description: /api/futures/netflow-list returns taker buy/sell flow for ALL symbols in ONE request; Standard plan; not a drop-in replacement for per-symbol taker history but useful as pre-filter.
---

## Endpoint

`GET /api/futures/netflow-list` (CoinGlass v4 API, `open-api-v4.coinglass.com`)
- Returns ALL coins in one response (no `symbol` param)
- Available: ✅ Standard plan (confirmed)
- Data: taker buy/sell volume + net flow per symbol — snapshot (single period, not multi-candle history)

## Current architecture (coinglass_taker.ts)

`getCoinglassTakerFlow(symbol)` makes **10 HTTP calls per symbol**:
- 5 exchanges (Binance/Bybit/OKX/Bitget/BingX) × `interval=15m&limit=4` (4 candles = 1h history)
- 5 exchanges × `interval=5m&limit=3` (latest 5m candle)
- Aggregates across exchanges → `netBuyPct`, `cvdRising2`, `cvd5m`, `cycles[]`
- Cache: 3 min per symbol
- Called per-symbol inside deep scan loop (80–150 symbols per cycle)

## What netflow-list CAN replace

- Quick `netBuyPct` / `dominance` snapshot for all symbols at once → use as prescan pre-filter
- Eliminates 10 calls per symbol for the "is taker positive at all?" check

## What netflow-list CANNOT replace

- `cvdRising2`: requires 4×15m candle history (multi-candle trend) — netflow-list is snapshot only
- `cvd5m`: requires per-exchange 5m candle — separate call
- Per-exchange breakdown (BingX-specific taker)

## Proposed integration pattern (future)

1. **Batch pre-filter**: fetch netflow-list once at scan start → Map<symbol, netBuyPct>
2. **Gate**: skip per-symbol `getCoinglassTakerFlow()` if netflow netBuyPct < -10% (clearly sell-dominant) → avoid 10 wasted calls
3. **Full call**: only fetch per-symbol history for tokens that pass the batch pre-filter
4. Net reduction: ~40-60% fewer per-symbol taker calls on typical scans

## Why not yet implemented

Not yet implemented — needs verification of exact response schema (field names, period covered).
User will verify via own CoinGlass tools.
