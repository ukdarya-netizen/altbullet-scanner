---
name: LIMIT N without ORDER BY starves old rows forever
description: Backfill/tracker queries that use LIMIT without ORDER BY + a completeness filter silently stop making progress once the table exceeds N rows.
---

## Pattern

Any recurring background job that does `SELECT ... WHERE <time range> LIMIT N` with:
- no `ORDER BY`, and
- the "still needs work" check done only in JS after the fetch (not in the SQL `WHERE`)

will, once the table grows past N total matching rows, keep re-fetching the same physical-order slice every cycle. Rows outside that slice — including ones that still need backfilling — become permanently unreachable. This isn't a transient failure; it doesn't self-heal by running longer.

**Why:** Found in two price-backfill trackers (`exhausted_pump_log`, `missed_signals_log`) in watcher.ts — both had `LIMIT 300` with no `ORDER BY` and filtered "already backfilled" only in JS. Once each table passed ~300 rows, the backlog beyond that stopped getting processed at all (64–85% of rows stuck).

**How to apply:** Any new or reviewed backfill/catch-up query needs `ORDER BY <age column> ASC` (oldest-first) AND the "not yet done" condition pushed into the SQL `WHERE` (e.g. `OR isNull(col1) OR isNull(col2) ...`), not just filtered in JS after the select. With this fix, no separate one-off catch-up script is needed — the existing cycle drains the backlog naturally over a few runs, because already-old rows immediately satisfy their time thresholds on the first pass.
