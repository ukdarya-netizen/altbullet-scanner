---
name: PDB aggregate latestCycle from deleted patterns
description: endpoint showed patterns=[] because latestCycle pointed to cycles containing only deleted patterns
---

## The rule

`/scanner/pattern-debug/aggregate` must find `latestCycle` by querying the last cycle that has **at least one non-deleted, non-liqgate pattern**. Never use bare `ORDER BY cycleNumber DESC LIMIT 1` — that can land on a cycle containing only historically-tracked (now deleted) patterns, making `fromCycle` point to a window with zero live data.

**Why:** Old scan code tracked `flush_reversal` every cycle. After it was deleted and the pattern was added to `DELETED_PATTERNS`, cycles 76-96 contained *only* `flush_reversal`. The bare MAX query returned cycle 96 → `fromCycle=76` → all rows filtered → `patterns=[]` forever, even though cycles 1-25 had valid data.

**How to apply:**
- `latestRow` query in tracker.ts uses `not(inArray(pattern, DELETED_PATTERNS_ARRAY))` + `sql\`pattern NOT LIKE 'liqgate_%'\`` in WHERE, plus `ORDER BY cycleNumber DESC NULLS LAST`.
- `DELETED_PATTERNS_ARRAY` **must be defined before** the DB queries (it feeds the latestRow WHERE clause). Previously it was defined after → latestRow used the old unsafe query.
- Keep `DELETED_PATTERNS_ARRAY` (tracker.ts) and `DELETED_PATTERN_KEYS` (scanner.ts) in sync. When removing a pattern from the scanner, add it to BOTH sets immediately — or stale DB rows will pollute the endpoint window.
- `bingx_exclusive` was missing from both sets (added 2026-07-23).
