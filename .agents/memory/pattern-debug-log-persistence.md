---
name: pattern_debug_log persistence design
description: How the in-memory per-cycle pattern check/pass/reject counter was made durable for week-long trend analysis
---

`lastPatternDebug` (scanner.ts) is an in-memory map reset every `performScan()` cycle (~10 min), so gate-rejection trends per pattern were unobservable beyond the current cycle.

**Decision:** persist a snapshot to a new `pattern_debug_log` table right before the reset, one row per (pattern, cycle): `checked`, `passed` as integer columns, `rejectedAt` serialized as JSON text (same convention as `missed_signals_log.gapDetails` — avoids a jsonb column + keeps schema simple). Insert is best-effort (wrapped in try/catch, logs a warning on failure) so a DB hiccup never breaks the scan cycle itself — consistent with how other logging tables in this app are treated as non-critical side effects.

**Why:** matches the existing `exhausted_pump_log`/`missed_signals_log` pattern already used in this codebase for turning ephemeral in-memory counters into queryable history, rather than inventing a new persistence convention.

**How to apply:** history is read back via `GET /scanner/pattern-debug/history?days=N` (aggregates in JS, not SQL, since rejectedAt is a JSON string column not native jsonb — merging it in SQL would need a custom aggregate). The original `GET /scanner/pattern-debug` (raw in-memory current-cycle snapshot) is unchanged and still exists side by side.

**Note:** new tables only take effect in production after the next Publish — dev `drizzle-kit push` only touches the dev database, per the `dev-prod-split-brain` memory. Production schema changes apply through the Publish flow's automatic diff, not manual scripts.
