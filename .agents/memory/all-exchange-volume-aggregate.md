---
name: All-exchange volume aggregate
description: Spot/futures 24h volume (FS metric, spot pool, 1% mcap gates) uses CoinGlass all-exchange aggregate; threshold recalibrated by cut share.
---
FS spot/fut 24h = spot pairs-markets (all exchanges) + aggregated futures taker (7 exch, 96×15m). Spot 24h/mcap gate (pre-gate, Pre-Breakout, confirmed-fire) uses one shared constant, 1.64% instead of 1%, chosen to keep the 42.8% cut share.
**Why:** owner ordered all volume metrics on the aggregate (2026-10-18); numerator grew ~1.56x median vs the 3-exchange source.
**How to apply:** one-day cross-section only (no 30-day history of the old numerator exists); recheck the cut share from scan_reject_log spot_fail_low after deploy. Spot CVD/SNF/stealth spot-fallback still use 5 exchanges (no all-exchange endpoint). -USDC contracts were already blocked on 2026-10-05.

Update 2026-10-18 (no-fallback rule): fallbacks removed — Stealth spot leg + Coinalyze, Coinalyze OI (impulse, scan, Layer 6c), prescan_stale OI, SpotPool last-known/optimistic pass, confirmed-fire MCap/spot-taker/spot-mult fallbacks, LC BingX order-book gate, liquidation stale >6 min. Spot CVD/taker/netflow now all 10 spot exchanges, liquidations all 28 futures (coinglass-exchanges.ts). Futures taker still 7 exchanges, mcap still has CoinGecko/Paprika fallback — flagged to owner, undecided.
**Why:** owner: "нет агрегата — нет сигнала". Threshold 1.64% rechecked on the full universe (1.632%), kept.
