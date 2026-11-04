---
name: Whale Futures retired
description: whale_watch (Whale Futures OB-bounce) removed from live scanning; history and open-position closing preserved
---
Whale Futures (`whale_watch`) no longer scans, fires, or shows a candidates tab. It sits in PRESERVED_DECOMMISSIONED_PATTERN_KEYS (not DEAD_PATTERN_KEYS).

**Why:** owner wanted a shorter scan cycle; no destructive cleanup of history.
**How to apply:** keep its label, exit profile, cancellation policy and OB-timeframe badge for old trades; never restore the scan, sampler or `whaleWatchStagesJson` writers. Whale Index (per-token metric) is unrelated and stays.
