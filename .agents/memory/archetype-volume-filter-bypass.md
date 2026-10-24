---
name: Archetype pattern volume filter bypass
description: Archetype patterns were silently skipped by volume filter; fix requires adding bypass flag similar to isCgFallbackConfirming
---

## Rule

Any confirmed-fire pattern that bypasses `anyOiPass` (added to the `!arch` list at line ~4144) **MUST ALSO** be added to the `_isArchetypeBypass` flag at the volume filter (~line 4382), otherwise it silently hits `break symbolBlock` before reaching its fire block.

**Why:** When `anyOiPass=false`, all OI trigger booleans (t30/t1h/t4h/t24h) are false → `isBullishSlowAccum=false` → `volThreshold=2.5x`. Archetype patterns have much lower vol requirements (0.5-0.8x or none). The volume filter at line ~4377 runs `break symbolBlock` at line ~4458, skipping the fire blocks at lines 4918+. The patterns appear to be checked (PDB counter increments in the block at ~4112) but the DB write itself also failed (dbWriteBestEffort silent), masking the problem entirely.

**How to apply:** When adding a new confirmed-fire archetype pattern:
1. Add boolean variable computed before anyOiPass gate
2. Add `!is<Pattern>` to the anyOiPass bypass condition at line ~4144
3. Add `is<Pattern>` to `_isArchetypeBypass` at volume filter line ~4382
4. Add `_pdbCheck/Pass/Reject` instrumentation in the PDB block
5. Add fire block (`if (!det && is<Pattern>)`) at lines ~4918+
6. Add pattern key to noOiNoVol bypass list (separate location)
7. This is now a **7-location checklist** (not 6 as previously documented)

## Diagnostic infrastructure lessons

- `dbWriteBestEffort` NEVER throws → errors are invisible; use direct try/catch for diagnostic tables (pattern_debug_log, scan_reject_log)
- `persistSymRejectLog` had splice-before-write: `_symRejLog.splice(0)` before the async write → data permanently lost on any Neon failure. Fix: copy rows, write, splice only on success
- Both functions were called at **scan start** when Neon pool is under pressure from prescan. Moved to **scan end** when pool is idle
- Add a direct logger.info of archetype stats at end of scan as a fallback visibility mechanism (pattern_debug_log DB writes may still fail occasionally)
