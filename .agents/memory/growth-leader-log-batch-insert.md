---
name: growth_leader_log batch INSERT fix
description: Why saveGrowthLeadersToLog timed out and how it was fixed (Jul 2026)
---

## Rule

`saveGrowthLeadersToLog` must use a **15-second startup delay + batch INSERTs of ≤20 rows** — never a single 100-row INSERT immediately after end-of-scan.

**Why:** Commit 8702558f (Jul 18) disabled the function with the message "INSERT 100 строк стабильно падает с connection timeout без задержки". 100 rows × 47 columns = 4700 params. The Neon pool is exhausted after the heavy scan cycle (prescan_tracker UPSERT ~500 rows, pattern_debug_log flush). Even with `void` (fire-and-forget) the query timed out consistently for 3 days because the pool had no free connections.

**How to apply:** If ever re-implementing the write logic:
1. `await new Promise(r => setTimeout(r, 15_000))` before first INSERT — lets pool recover
2. Loop in chunks of 20 rows with `dbWriteBestEffort` and 500ms between batches
3. `perAttemptTimeoutMs: 15_000`, `retryDelayMs: 2_000` for each attempt
4. Log at `info` level (not debug) so "Growth leader log saved" is visible in prod logs

**Diagnosis method:** Data gap in growth_leader_log → check prescan_tracker `updated_at` and pattern_debug_log to confirm scanner IS running → if yes, the save function itself is failing silently.
