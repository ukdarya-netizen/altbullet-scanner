---
name: No absolute dollar thresholds
description: owner rule — turnover/volume/liquidation thresholds are % of market cap; Auto Range history must not depend on BingX listing age
---
Thresholds on turnover, volume or liquidation size must be a share of market cap (fetchMarketCap), never absolute $. Unknown mcap = gate skipped + reason recorded. Reference calibration: old $ values at $500M mcap (turnover-threshold.ts).
**Why:** owner repeated it many times ("везде в процентах").
**How to apply:** any new threshold; remaining non-token $ params (CoinGlass API min order filter, orderbook sanity floor) are not per-token.
Auto Range history: BingX short history is extended from Binance spot (auto-range-deep-history.ts); listing age must not block signals.

Generic deepNeg gate (p24h < -8%) removed for ALL patterns by owner decision 2026-10-13; raw check showed ~50/50 +10%/-10% first-hit on rejected tokens (no edge either way). Do not re-add as a global gate.

Neon Support zone rule (owner 2026-10-13): 1H bounce candle must touch an SRv2 zone that coincides with a zone of another timeframe (1H/4H/1D); single-TF zone never fires (reason no_srv2_confluence).

Owner repeated this many times (angry, 2026-10-13): ANY dollar threshold — gates, penalties, API filters, display tiers — must be % of market cap. Convert proactively wherever a new $ number appears; grep for `_000` before finishing any pattern work. Remaining by design: CoinGlass liquidation-stream `min_liquidation_amount` ($10k) is a global transport filter, not per-symbol.

## Volume is aggregated everywhere, Stealth included (2026-10-14)
Owner repeated: no BingX single-exchange volume anywhere, and the Stealth BingX-only exception is revoked. Scanner volMult, Impulse Buy, Whale Futures OB trigger, scout/OI-watch volMult and Stealth 1H/4H breakout-candle volume all use CoinGlass aggregated futures taker buy+sell USD (`getAggregatedFuturesVolumeSeries30m`, `getAggFuturesVolumeByInterval`). Candle `volumeUsd` is the only gate volume; BingX is price only.
**Why:** the owner demanded it after the Impulse Buy volume was found on BingX candles.
**How to apply:** never read `candle.volume` from BingX klines for gates; missing aggregate = explicit unavailable reason, no fallback.
