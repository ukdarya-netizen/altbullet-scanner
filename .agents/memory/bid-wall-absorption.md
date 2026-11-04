---
name: Bid Wall Layer 9 (orderbook heatmap)
description: Current design of Layer 9 bid wall detection — CoinGlass futures orderbook heatmap, pool tables, and the 1000x-ticker mcap lookup pitfall.
---

# Bid Wall Layer 9 — heatmap-based design (since 2026-07-14)

Source is CoinGlass **futures orderbook heatmap** (Binance instrument), not the old spot orderbook large-limit-order aggregation (module deleted).

Gate: largestBid ≥ 0.05% of mcap (floor $20K, ceil $500K) AND bid/ask ratio ≥ 2x within ±6% price zone. The live large-limit-order check is a **fail-open confirmation only** — stored (`largeOrderConfirmed`, `largeOrderBidUsd`) but never gated on; missing data must not block detection.

Detected candidates go into `bid_wall_pool` (24h expiry, statuses watching/expired) mirrored in-memory; every scan cycle updates live multi-TF metrics on pool rows and appends per-cycle history to `bid_wall_watch_log`. Pool entries only inject symbols into the scan via Layer 9 — they never fire signals directly.

**Why:** the old spot-orderbook absorption events were noisy and covered only ~51% of the prescan pool; the heatmap gives a direct view of resting futures bids and allows a data-collection phase (watch log) before deciding if this becomes a signal pattern.

**How to apply:**
- Prod tables are created via `runStartupMigration` (CREATE TABLE IF NOT EXISTS) — `drizzle push` is forbidden in this repo (would drop unrelated tables).
- 1000x-ticker pitfall: `market_cap_cache.symbol` stores the un-prefixed base (PEPE, not 1000PEPE). Any mcap lookup for normalized tickers must query both the prefixed and stripped base and prefer the exact match — a naive prefix loop silently falls back to the $20K floor, making the wall gate far too lenient for large caps.
- Expired `bid_wall_pool` / old `bid_wall_watch_log` rows are not pruned yet (API reads limit 100); add pruning if tables grow.
