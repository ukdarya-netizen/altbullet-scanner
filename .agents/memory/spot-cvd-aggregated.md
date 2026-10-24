---
name: Spot CVD rewrite — aggregated endpoint
description: CoinGlass /spot/aggregated-cvd/history quirks, symbol format, plan requirement, new SpotCvdResult numeric fields.
---

# Spot CVD — aggregated endpoint

**Why:** Old coinglass_spot_cvd.ts used /spot/taker-buy-sell-volume/history × 4 exchanges (bool buy>sell, not real CVD). Rewrote to real running CVD.

## Critical quirks

- **symbol format**: `BTC` not `BTCUSDT`. Sending `BTCUSDT` returns `{"code":"0","data":[]}` silently — no error.
- **Plan requirement**: Standard+ only. Hobbyist returns empty `data:[]` silently (no error code). We are on Standard.
- **exchange_list**: comma-separated string `"Binance,Bybit,Bitget,OKX"` — aggregates across all 4 exchanges server-side. 1 call per symbol vs 4 previously.
- **"aggregated" means pairs within exchange** per docs, but in practice it sums volumes across the listed exchanges — confirmed by testing.

## Response fields (new endpoint)
```
agg_taker_buy_vol  — aggregated buy volume
agg_taker_sell_vol — aggregated sell volume
cum_vol_delta      — running CVD (cumulative sum of buy-sell from window start)
```

## SpotCvdResult new numeric fields
- `cvdStrength5m` — (buy-sell)/(buy+sell) last 5m candle ∈ [-1,+1]
- `cvdStrength1h` — (buy-sell)/(buy+sell) last 12 candles ∈ [-1,+1]
- `cvdStrength4h` — cum_vol_delta[last] / total_volume ∈ [-1,+1]
- `cvdDelta4h`    — raw cum_vol_delta last candle (USD)

All boolean fields (cvd5m, cvd15m_3of4, cvd1h, cvd4h, hardBlocked, scalpOnly, isGolden) unchanged — backward-compatible.

**How to apply:** Any future change to spot CVD fetching must use base ticker (`BTC`) not full pair (`BTCUSDT`). getCoinglassSpotVolume24h also migrated to same endpoint (limit=288).
