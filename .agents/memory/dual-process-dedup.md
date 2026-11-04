---
name: Dual-process broadcast dedup
description: Production runs 2 worker processes; pattern for preventing duplicate Telegram messages.
---

# Rule
All Telegram broadcasts in watcher.ts must use atomic `UPDATE ... WHERE condition RETURNING id` — broadcast only if `claimed.length > 0`.

**Why:** Production deployment (Reserved VM) uses 2 worker processes. Both processes run the same watcher cycles concurrently and would both send the same message without a DB-level lock.

**How to apply:**
- For status changes: `UPDATE ... WHERE id = X AND status = 'current_status' RETURNING id` → only winner sends message
- For one-time events (reminders, scouts): use a dedicated timestamp column as guard: `UPDATE ... WHERE id = X AND (col IS NULL OR col < threshold) RETURNING id`
- Never use in-memory Maps/Sets for cooldowns — they're not shared between processes
- Already-safe broadcasts use `.returning()` in existing code — don't add double guards

# Covered broadcasts (all fixed)
- runStartupReset: stop-loss, trailing/be-stop, near-stop warning (lastHourlyAt guard), missed move
- runWatcherCycle (accumulation): 7d breakeven, stop-loss, accum reminder (lastMilestone=-1 sentinel), thesis broken, vol building (lastVolBuildAt), OI building (lastOiBuildAt), re-entry
- runInRunFastCycle: no-price cancel, 7d breakeven, stale cancel, BE stop, stop-loss active, small loss in_run, 4h periodic update (lastPeriodicUpdateAt), → accum 48h, → accum 24h
