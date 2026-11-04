---
name: Missed mover trajectory linkage
description: Missed movers need a durable parent-child link to their full prescan trajectory, not only an exit snapshot plus an unrelated symbol/time join.
---

`missed_movers` stores one exit snapshot, while `prescan_snapshots` stores all tokens per cycle. For analysis of what was missed before a token moved, the trajectory must be linked to the missed-mover record through a child table or equivalent durable foreign key, with an API that returns the parent and trajectory together.

**Why:** a symbol/time join is cumbersome and the two tables have different TTLs (missed movers 90 days, prescan snapshots 7 days), so older missed movers lose the very trajectory needed for calibration.

**How to apply:** keep normalized rows rather than a large JSON blob, but create `missed_mover_snapshots(missed_mover_id, cycle_at, metrics...)` and populate/backfill it when an un-fired prescan entry exits.