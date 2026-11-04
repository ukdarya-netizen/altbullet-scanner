---
name: Missed-signals "overheated" source
description: How the third missed_signals_log source (overheated) is wired across scanner gates; dedup pattern and column reuse.
---

`missed_signals_log.source` is a plain `text` column (no DB enum), so adding a third value ("overheated" alongside "near_miss"/"growth_leader") required zero schema changes — just insert with a different `source` string and add a frontend badge case for it.

**Why:** avoided a migration; kept the table shape shared across all three "why didn't this fire" audit trails.

**How to apply:** to log a new kind of skip reason into this table, reuse the existing columns (`reason` as a short stable gate code, `gapDetails` as a JSON array of `{metric, value, threshold}` for tooltip rendering) rather than adding new columns.

Dedup pattern for high-frequency gates: overheated-style gates (price24h/runaway/stale-move filters) fire on the same symbol every ~10min scan cycle, unlike near_miss/growth_leader which have no natural repeat. Used an in-memory `Map<"symbol:gate", timestamp>` with a 6h TTL (pruned when it exceeds ~5000 entries) inside the logging helper itself, so every call site can call the logger unconditionally without each site re-implementing dedup.

Scope note: in scanner.ts's main per-ticker deep-scan loop, `price24hChange` (declared once near the top of the loop) stays in scope through all nested blocks for that same symbol iteration, including the later OI-Watch-confirming sub-block — so it's safe to reuse directly rather than recomputing.
