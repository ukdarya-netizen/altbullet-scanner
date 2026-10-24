---
name: Pattern-pass symbol diagnostic (7 alphaScore-override patterns)
description: How to trace whether a pattern that passed its own internal gate actually fired, or was lost downstream (cooldown/chronic-token block), for low-frequency patterns.
---

## Problem

`pattern_debug_log` aggregate rows (from `_pdbCheck`/`_pdbPass`/`_pdbReject`) only
record a per-cycle count (`checked`, `passed`, `rejectedAt: {gate: count}`) with
`symbol IS NULL`. For low-frequency patterns (0–3 passes per cycle) this makes it
impossible to know whether a "pass" ever reached the `signals` table, or died in
one of the filters that run AFTER the pattern boolean-gate section but BEFORE
`candidates.push()` / loop2 alphaScore evaluation in `scanner.ts`:

- chronic-token 72h block ("SKIP: хронический токен" — 2+ cancelled accumulation
  patterns in 4 days without profit)
- repeat-signal 24h cooldown ("SKIP: cooldown 24ч" — symbol already got ANY
  signal in the last 24h and has no active position)
- the OI-negative post-check override
- `finalAlphaScore < 5` gate in loop2

This is the same bug class that was found for `spot_taker_lead` (passed gate,
never became a signal, root cause was a downstream filter, not the gate itself).

## Fix

Added `diagPatternPassed(pattern, symbol)` (fire-and-forget, same style as the
pre-existing `diagCvdIfOiRejected`) that inserts a per-symbol row into
`pattern_debug_log` with `cvdDiag: "passed_gate"` whenever the boolean gate for
one of the 7 override patterns fires: `4h_momentum`, `quiet_oi_accumulation`,
`volume_taker`, `bingx_exclusive`, `oi1h_breakout`, `spot_momentum_reversal`,
`spot_oi4h_build`. Deployed 2026-07-08.

**How to use it later:** query `pattern_debug_log WHERE cvd_diag = 'passed_gate'
AND pattern = ANY(...)` to get `(symbol, logged_at)` pairs, then cross-reference
against `signals`/`tracked_signals` for that symbol within a few minutes of
`logged_at` to see whether it fired, or check application logs near that
timestamp for "SKIP: cooldown"/"SKIP: хронический" for that symbol (log
retention is short, ~15 min, so DB cross-reference is the durable path).

**Why:** `_pdbPass` itself can't cheaply carry symbol without restructuring the
aggregate-row schema; a separate fire-and-forget diagnostic insert (same
pattern as `diagCvdIfOiRejected`) is the low-risk way to add symbol-level
traceability without touching gate behavior.
