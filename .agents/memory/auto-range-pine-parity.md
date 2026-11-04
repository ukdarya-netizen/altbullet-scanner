---
name: Auto Range Pine parity
description: How the TS port of QuantAlgo Auto Range Detector was verified against the real indicator
---
Port matches the real Pine source (owner pasted it) only with: percentile = linear interpolation at 1-based rank p/100*N+0.5 (NOT (N-1)*p), and percentrank over the previous 500 values excluding the current bar.
**Why:** with the old (N-1) percentile a borderline 40-bar window qualified and a stale range lived for days; IO/USDT 1H boxes (3.43%, 5.53%) on Binance spot now reproduce exactly.
**How to apply:** verify any detector change by replaying Binance spot 1H (data-api.binance.vision works; api.binance.com/bybit are geo-blocked) against owner's TradingView screenshots. Owner's indicator settings are all defaults.
