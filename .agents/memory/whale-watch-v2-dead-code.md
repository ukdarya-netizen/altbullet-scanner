---
name: Whale Watch 2.0 (whale_watch_v2.ts) is fully orphaned
description: runWhaleScan/checkWhaleSmartCancel/broadcastWhaleWatchV2Alert exist but have zero call sites — explains empty whale_watchlist table.
---

Confirmed via grep across the whole `api-server/src` tree: `runWhaleScan()`, `checkWhaleSmartCancel()` (both in `whale_watch_v2.ts`), and `broadcastWhaleWatchV2Alert()` (`telegram.ts`, wraps `formatWhaleWatchV2Alert`) have no callers anywhere outside their own definitions. Only unrelated helpers from the same file (`fetchMarketCap`, `getWhaleWatchlist`, `expireStaleWatchlist`, `batchFetchMarketCap`) are actually wired into `scanner.ts`/`watcher.ts`/`routes/subscribers.ts`.

**Why it matters:** `whale_watchlist` table is empty (0 rows ever) not because of a bug in the insert logic, but because the function that would insert into it is never invoked. Even if it were, the alert broadcaster is also disconnected — no Telegram message would go out either.

**Decision (2026-07-04):** User chose to leave this as dead code — `whale_futures_watchlist` (the newer OI+taker-flow based tracker) already covers the same "watch for whale accumulation" purpose and is actively running. Do not re-wire Whale Watch 2.0 without an explicit request; removing the dead code itself is a separate, deferred task.
