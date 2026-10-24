---
name: Entry-metrics backfill — universal coverage
description: refreshNullEntryMetrics covers BW/SpBW + recently-closed signals; fast cycle must not null-overwrite
---

Fire-time CG fetches routinely time out at end of heavy scans → NULL entry columns. The durable fix is the backfill job, not longer fire-time timeouts.

Rules (2026-07-31):
- `refreshNullEntryMetrics` scope = open statuses OR detected_at > 48h ago (any status) — signals often close before a slow backfill reaches them, and history rows must be complete too.
- Cadence 10 min (first run 18 min), limit 10 candidates, 6s per-call timeouts.
- largeBidUsd: CG Binance futures → BingX OB largestBidWallUsd fallback (fallback must fire even when CG fetch fails entirely, not only on empty result).
- spotBidUsd: CG Binance spot only — NULL for BingX-exclusive tokens by design.
- Fast cycle bid-wall refresh: write to map ONLY when at least one source responded; otherwise a CG timeout overwrites a good DB value with null.

**Why:** 7-day prod audit showed spot_bid_usd 1/130, large_bid_usd 10/130, spotTaker 55% — all three causes above.
**How to apply:** any new entry_* column must be added to refreshNullEntryMetrics SELECT + isNull OR + fetch + patch, or it will be NULL for every load-window fire.
