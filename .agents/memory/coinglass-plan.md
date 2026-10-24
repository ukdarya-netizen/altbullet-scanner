---
name: CoinGlass plan — Standard (Aug 2026)
description: CoinGlass switched to Standard plan Aug 2026. Audit of all spot + futures endpoints against official docs.
---

## Current plan: Standard (since 2026-08-15)

**New key active** in dev. Production picks it up after next deploy.

**Rate limit:** 300 req/min (was 1200 on Professional — 4× reduction, acceptable with current batching).

## Spot endpoints — ALL ✅ on Standard

| Endpoint | Used in | Notes |
|---|---|---|
| `/api/spot/aggregated-cvd/history` | `coinglass_spot_cvd.ts` | symbol=BTC, exchange_list=Binance,Bybit,Bitget,OKX |
| `/api/spot/cvd/history` | debug route only | per-pair, BingX returns 400 (pair not found) |
| `/api/spot/taker-buy-sell-volume/history` | `spot-netflow-cache.ts` (batch fallback) | exchange+symbol=BTCUSDT |
| `/api/spot/aggregated-taker-buy-sell-volume/history` | debug route | exchange_list+symbol=BTC |
| `/api/spot/netflow-list` | `spot-netflow-cache.ts` | 3 pages × 200 symbols |
| `/api/spot/coin/netflow` | `spot-netflow-cache.ts` (per-symbol supplement) | symbol=BTC, exchange_list=Binance,Bybit,OKX,Bitget,Gate |

## ❌ Professional-only (broken on Standard)

| Endpoint | Code location | Fallback |
|---|---|---|
| `/api/liquidation/aggregated-heatmap/model2` | `coinglass_liq_heatmap.ts`, watcher.ts ~586/605/698 | null → config defaults |
| `/api/liquidation/heatmap/model2` | same | null |
| `/api/liquidation/map` | same | null |
| `/api/liquidation/max-pain` | same | null |
| `/api/hyperliquid/long-short-account-ratio-by-tag` | `coinglass_hl_ls_tag.ts` | **dead code — never called** |

**Why getLiqLevels() returns null is OK:** watcher.ts has explicit null-checks that fall through to config-based stop/take defaults.

## SpotCVD 575 consecutive failures (root cause)

Old Professional key was revoked when plan changed. `coinglass_spot_cvd.ts` circuit breaker (`consecutiveFailures`) was never reset on trip — accumulated to 575. **Fix shipped:** reset to 0 on trip. New Standard key fixes API access after deploy.

## How to apply
When evaluating any CoinGlass endpoint, check the table above. Liq heatmap = ❌. Everything else spot/futures = ✅.
