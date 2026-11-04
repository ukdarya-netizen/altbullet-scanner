---
name: OI confirming-queue DB timeout → 0 candidates
description: Why prod scanner produces 0 candidates every cycle even with 50 topActive tokens; root cause and fix.
---

## The Rule
When `oi_watch` confirming INSERTs fail (DB connection timeout), the catch block continues without adding the token to `candidates` and without incrementing `skipCount`. This causes 0 candidates indefinitely — the fix is an in-memory `confirmingWatchMap` fallback.

## Why
The CoinGlass batch phase takes ~8 minutes and saturates the pg-pool. By the time the scan inner loop runs its ~50 per-symbol DB queries, connections time out. The flow:
1. `evaluatePattern()` returns a valid signal for a token
2. Code tries `db.insert(oiWatchTable)` with `status="confirming"` (60-min confirmation window)
3. INSERT fails: "Connection terminated due to connection timeout"
4. catch block: `logger.warn(...)` + `continue` — token silently dropped, `skipCount.other` NOT incremented
5. Next scan: `confirmingEntry.length === 0` again → same failure → infinite dead loop
6. Prod log: `skipped={other:0}` but `candidates=0` — the discrepancy reveals this path

## Evidence
- `oi_watch` table in prod was completely empty (no confirming entries ever created)
- `Coinalyze batch DB guard failed` and `Failed to save prescan tracker to DB` in same scan cycle
- `No candidates this cycle marketsScanned=263 oiMovers=40 topActive=50 skipped={deepNeg:1, other:0}`

## How to Apply
The fix (scanner.ts):
- Module-level `confirmingWatchMap: Map<string, ConfirmingWatchEntry>` with TTL 90 min
- TTL cleanup runs at the top of each scan (before skipCount init)
- `confirmingEntry` read merges DB result with memory fallback (DB wins on duplicates)
- On successful INSERT: `confirmingWatchMap.delete(symbol)`
- On failed INSERT (catch): save to map + `skipCount.other++`
- On ghost pump expire / signal fired: `confirmingWatchMap.delete(symbol)`

**Why:** Memory map is per-process (lives for the server's lifetime), survives between scans within same process. Each process has its own map — fine since dual-process dedup happens at DB level for signal writes. The 60-min confirmation window still works correctly; it just reads from memory instead of DB when DB is unavailable.
