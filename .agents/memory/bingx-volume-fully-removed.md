---
name: BingX volume fully removed
description: Owner banned any BingX volume/OI/OB fallback; all volume now CoinGlass aggregated, including analytics candles
---
Owner (2026-10-14, repeatedly, angry): no BingX fallbacks for volume, OI, order book. BingX = price/time/candle structure only.
Candle volume in analytics goes through withAggregatedKlineVolume (aggregated USD / close, "NaN" when CoinGlass has none). 24h volume: coinglass_vol24h (OI / OI-volume ratio from coins-markets).
**Why:** the user asked, many times; earlier sweeps missed paths where volume rode inside candle arrays.
**How to apply:** any new candle/volume use must wrap BingX klines with the helper; grep `.volume` and `quoteVolume` after changes. Ticker-collision check still uses BingX OI as a validator only. Historical DB rows keep old BingX volumes.
