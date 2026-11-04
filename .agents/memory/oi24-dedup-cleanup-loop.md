---
name: OI24h dedup blocked by cleanup cancel loop
description: pre_spot_filter_cleanup cancelReason permanently blocked oi24h_accumulation re-fires; startup cleanup call must be one-shot, not run every restart.
---

Two related bugs found together, both must be fixed for `oi24h_accumulation` to ever fire again after a one-time data-cleanup:

1. **Dedup query didn't exclude cleanup cancellations.** The day-based dedup (`detectedAt::date = day3Date::date` in `runOi24hAccumulationCycle`, watcher.ts) checked for ANY prior `tracked_signals` row for that symbol/day, regardless of status. A one-time batch cancellation (`cancelReason = 'pre_spot_filter_cleanup'`, used to invalidate signals fired before a spot-volume gate existed) left rows in place that then permanently blocked legitimate re-fires for the same day3Date. Fix: dedup query now excludes rows with that specific cancelReason.

2. **The one-time cleanup function was wired into the startup sequence unconditionally**, so it ran on every deploy/restart, not just once — meaning it would keep re-cancelling any new legitimate `active`/`in_run` `oi24h_accumulation` signal with the same bogus reason forever. Fix: removed the `setTimeout` call from the startup sequence; the function is kept in code for reference but is no longer invoked automatically.

**Why:** any "one-time idempotent cleanup" that runs via a startup `setTimeout` needs to be truly idempotent in scope (only touch rows created before the fix), not blanket-match by sentimentKey/status — otherwise it silently keeps firing on every restart and nobody notices until much later.

**How to apply:** when adding a retroactive data-cleanup startup function, either (a) scope the WHERE clause with a hard date cutoff so it can't touch future-created rows, or (b) remove the startup call once confirmed it ran successfully in prod (check via read-only prod SQL), keeping the function itself as reference/manually-callable only.
