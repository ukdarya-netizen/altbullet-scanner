---
name: Shared dbReadWithRetry helper for Neon pool timeouts
description: Systemic fix for background jobs failing on transient Neon connection-pool exhaustion at cycle start
---

Multiple independent background jobs (watcher/fast cycles, price-backfill trackers for exhausted_pump_log, missed_signals_log, whale_futures_watchlist spot price) each did a single unprotected initial SELECT at the start of their cycle. Under Neon connection-pool exhaustion, some had zero retry (one timeout = entire cycle/backfill window permanently skipped, no recovery until next scheduled run), while one (`runInRunFastCycle`) had already grown its own ad-hoc 3-attempt/5s retry loop.

**Why:** A scoped SQL investigation showed this was NOT isolated to one table/job — it was a recurring pattern across ~6 call sites, all vulnerable to the same class of transient failure. Symptom-patching one call site would leave the others exposed to the next Neon blip.

**How to apply:** `dbReadWithRetry(label, fn, attempts=3, delayMs=5000)` in `watcher.ts` wraps the initial fetch in each affected job, returning `{ok:true,value}` or `{ok:false}` so callers can skip gracefully instead of throwing. Any NEW background job that does an initial DB read at cycle start should use this helper rather than writing its own retry loop or leaving it unprotected. Applied at: `runWatcherCycle`, `runWhaleFuturesCycle`, `runWhaleWatchSpotPriceTracking`, `runExhaustedPumpPriceTracking`, `runMissedSignalsPriceTracking`, `runInRunFastCycle`.
