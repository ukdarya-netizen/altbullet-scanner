---
name: Sweep firedAt false-fire bug
description: Expiry sweep stamping firedAt on cleanup made oi_watch rows look like they had fired when they hadn't.
---

## Symptom
A `confirming` oi_watch record appears to transition to `expired` but has `firedAt` set, looking like a signal fired and then got reverted. Easy to misdiagnose as a race condition between two worker processes.

## Root cause
The routine expiry-sweep UPDATE (which closes out stale `watching`/`confirming` rows past `expiresAt`) stamped `firedAt: new Date()` alongside `status: "expired"`. That timestamp is the moment of the *cleanup sweep*, not a real Telegram alert — `broadcastBatchAlert` is never called from that code path.

## How to confirm this pattern vs. an actual race
Check historical rows: if `fired_at ≈ expires_at + a few minutes/hours` across many rows, that's the sweep's next scan-cycle timing, not a fire event. A genuine fire sets `status = "fired"` (permanent, no code path reverts it back to `expired`), so any row with `status = 'expired' AND firedAt IS NOT NULL` is the bug artifact, not a legit signal — safe to treat uniformly without per-row judgment calls.

**Why:** Saved an incorrect "atomic-claim race" theory from being repeated — the simpler explanation (sweep bug) covered 100% of cases including the one that initially looked special.

**How to apply:** When any watch/tracking table shows a "fired then reverted" mystery, check whether the terminal-state UPDATE for one status is incidentally also setting a field that means something under a different status.
