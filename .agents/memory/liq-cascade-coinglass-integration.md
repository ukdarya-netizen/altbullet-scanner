---
name: liq-cascade CoinGlass integration
description: Liquidation coin-list/exhaustion/global-ratio/large-orders wiring — LOG-ONLY launch, collision defense, negative caching convention
---

# liq_cascade CoinGlass data integration (2026-07-14)

- All new scanner gates (liquidation_cascade + flush_reversal) launched **LOG-ONLY**: pattern had zero fires in 6 days, so blocking gates would guarantee zero data. Look for "🧪 … LOG-ONLY liq-контекст" log lines; wouldBlockNoLiq / wouldBlockStillRunning / wouldBlockCrowdLong(≥75%) are computed and logged but never enforced. Promote to real gates only after enough logged stats.
- **Why:** enforcement before data collection makes it impossible to tell whether a gate helps or just suppresses everything.
- Collision defense: CoinGlass liq24h > 2× BingX vol24h → treat as ticker collision, return null (same class of bug as the US-USDT CoinGlass collision).
- Gate stat of record is **longLiq24h** (not 4h) per architect planning review.
- Two different "exhausted" definitions coexist: DB `liq_exhausted` = current 1h < 30% of at-detect (watcher); scanner-side getLiqExhaustion = latest 30m candle < 50% of 4h peak. Frontend badge shows the DB one — remember when interpreting log-only stats.
- Negative-caching convention for per-symbol Binance-backed CoinGlass endpoints (global ratio, large orders): cache `null` 10 min on HTTP 4xx / empty data ("pair not on Binance"), do NOT cache 429 or network timeouts (transient). BingX-exclusive tokens otherwise re-hit CG every watcher cycle.
- CoinGlass liq coin-list field names: long/short `liquidation_usd_1h/4h/12h/24h`, symbol = base (BTC); per-symbol endpoints use BTCUSDT (strip dash). large-limit-order `order_side` docs 404 — infer bids via limit_price < currentPrice.
