---
name: Fast-fail helper for non-critical DB writes
description: dbWriteBestEffort in dbWriteFast.ts — short-timeout, low-retry wrapper for best-effort writes (debug logs, heartbeats, missed-signal logging).
---

Several non-critical DB writes (pattern-debug diagnostics, missed_signals_log
inserts, lastScanAt heartbeat) used a manual "retry once after 1000ms" pattern
with no per-attempt timeout, so each failed attempt could block for the full
Neon pool `connectionTimeoutMillis` (15s) — worst case ~31s per call. Because
several of these are called synchronously in the scan's hot path (or
concurrently many times per cycle via fire-and-forget), this contributed to
scan-duration blowups during Neon degradation.

**Why:** These writes are explicitly non-critical — losing a debug row or a
heartbeat update is fine, but tying up a pool connection slot for 15-30s while
other, more important reads/writes are waiting is not. The fix targets latency
*per call*, not correctness — data loss on failure was already acceptable.

**How to apply:** Use `dbWriteBestEffort(label, fn, opts)` from
`artifacts/api-server/src/lib/dbWriteFast.ts` for any new best-effort/optional
DB write. Default: 2 attempts, 2500ms per-attempt timeout (via Promise.race,
does not actually cancel the underlying query), 400ms retry delay. Pass
`{ attempts: 1 }` for pure fire-and-forget heartbeats where even one retry
isn't worth it. This is the write-side counterpart to `dbReadWithRetry` in
watcher.ts (see `db-read-retry-helper.md`), which intentionally does the
opposite — longer retries — because a skipped critical read starves an entire
cycle of data, whereas a skipped non-critical write just loses one row.
