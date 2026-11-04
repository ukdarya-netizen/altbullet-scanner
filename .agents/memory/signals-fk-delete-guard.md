---
name: signals FK delete guard
description: Deleting rows from the signals table requires excluding rows referenced by child FK tables.
---

Any DELETE from `signals` must exclude rows referenced by child tables, or Postgres throws FK violations and the whole delete rolls back.

**Why:** one-shot dead-pattern cleanup failed on first dev run — `tracked_signals.signal_id` and `signal_whale_seeds.signal_id` both reference `signals.id` with no ON DELETE action.

**How to apply:** add `id NOT IN (SELECT signal_id FROM tracked_signals WHERE signal_id IS NOT NULL)` and the same for `signal_whale_seeds` to any signals cleanup/purge query. Referenced rows are intentionally kept (journal/whale-seed history depends on them).
