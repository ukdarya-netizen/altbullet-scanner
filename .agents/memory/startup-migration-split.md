---
name: runStartupMigration Part1/Part2 split
description: Why migration was split into two try/catch blocks and what goes where
---

## Rule
`runStartupMigration` is split into two independent `try/catch` blocks (index.ts):

- **Part 1** — legacy ALTERs, `pattern_debug_log` DELETE (60K rows → slow under Neon load), old `growth_leader_log` entry_* columns, `oiChangePercent` update.
- **Part 2** — new accumulation-table CREATE IF NOT EXISTS (`whale_event_tracking`, `periodic_collection_log`, `cg_liq_heatmap_snapshot`, `cg_netflow_snapshot`) + `growth_leader_log` v3 ALTERs.

**Why:** Part 1 can time-out on the large DELETE under Neon pool contention. Before the split, this aborted the whole function, silently skipping Part 2 table creation → 4 tables missing from prod after deploy.

**How to apply:** Any new CREATE TABLE or ALTER TABLE for an accumulation/collection table goes into Part 2. Anything touching existing data (DELETE, UPDATE WHERE) stays in Part 1 with its own error.
