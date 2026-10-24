---
name: Trailing activation IS NULL race bug
description: Trailing activation and notification dedup must use a verified durable peak; a persisted stop alone is not activation proof.
---

## The bug

In `watcher.ts` FastCycle loop, there are two writes to `trailingStopLevel`:

1. **Early update** (~line 2064): runs whenever `peakChanged && trailingActive`. Uses `WHERE id = tracked.id` (no IS NULL guard). Sets `trailingStopLevel = peak * (1 - gap%)`.

2. **trailingJustActivated block** (~line 2866): fires when `prevPeakPnl < trailingActivation && peakPnlNow >= trailingActivation`. Used `WHERE id = tracked.id AND trailingStopLevel IS NULL` as dedup guard.

Since `trailingJustActivated` is always true together with `peakChanged && trailingActive`, the early update always runs first and sets `trailingStopLevel`. By the time the trailingJustActivated block's DB update runs, `trailingStopLevel IS NULL` is false → 0 rows returned → `continue` → **message never sent**.

**Confirmed on BANK-USDT**: `last_milestone=20` (20% came), `trailing_stop_level` set, but +15% MILESTONE15_IMG never delivered.

## Fix (2026-07-21)

Changed the WHERE guard from:
```sql
AND trailingStopLevel IS NULL
```
to:
```sql
AND (lastMilestone IS NULL OR lastMilestone < trailingActivation)
```

Also added `lastMilestone: trailingActivation` to the SET clause, so:
- Future cycles see `lastMilestone >= trailingActivation` → dedup works correctly
- `nextMilestone(15, pnl)` still correctly finds 20 as the next MILESTONES value

**Why:** `lastMilestone` is not touched by the early update — only by explicit milestone/trailing-activation SET. Safe atomic lock across two worker processes.

**How to apply:** Any future notification blocks that need a "send exactly once" guard should use `lastMilestone` (not `trailingStopLevel`) as the dedup column, because the early peak update unconditionally writes `trailingStopLevel` on every peak change while trailing is active.

## Hard trailing exit ordering

Once a trailing level is reached, its close must run before pending-milestone retry or other non-economic work. The state transition to `profit` and the Telegram outbox event must be created by the same transactional claim.

**Why:** A pending notification retry can otherwise `continue` the fast-cycle iteration indefinitely while price is already below the trailing level. Closing first and sending later loses the alert; sending first can lose the exit. The outbox transaction is the required synchronization point.

**How to apply:** Do not gate a reached trailing exit on Telegram network delivery. Atomically claim the tracked signal and enqueue its outbox event; dispatch happens after commit with the event identity as dedup protection across workers.

## Monotonic trailing levels

A long-position trailing level is a protected price floor: it may rise with a new peak but must never decrease.

**Why:** With more than one worker, one cycle can read an older peak after another has already persisted a higher trailing level. A plain update would overwrite that protection and later record the exit below the intended floor.

**How to apply:** Derive the in-memory stop from the higher of the calculated and persisted values, and use an atomic database maximum for every trailing-level update and the final trailing exit price.

## Durable activation across workers

A persisted trailing level is not sufficient proof of activation. Activation requires the durable peak to have reached the pattern's configured threshold; only then may the persisted level supply the monotonic boundary. `lastMilestone` remains the notification dedup lock.

**Why:** Older first-target, startup, and milestone paths wrote provisional trailing levels before activation. Trusting any positive level produced false +15% alerts and trailing closes below the threshold, including a negative result recorded as `PROFIT`.

**How to apply:** Fast-cycle, startup recovery, realtime monitoring, pending retry, and recipient-ledger recovery must all verify the durable peak first. Abandon below-threshold trailing deliveries and reject trailing-profit closes with a negative protected PnL.
