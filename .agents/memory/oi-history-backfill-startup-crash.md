---
name: One-shot startup jobs must survive Neon pool stress, not just be idempotent
description: Idempotency alone doesn't make a startup backfill job safe; it must also retry transient DB errors internally, or a single connection blip aborts the whole run silently.
---

A one-shot startup job (e.g. `setTimeout(..., 12_000)` calling a backfill function once) that is idempotent (skips already-filled rows) is NOT automatically safe from the known startup Neon pool-saturation window (~14 min after boot, see `startup-positions-timer.md`).

**Why:** if the job's DB calls have no retry wrapper, a single "Connection terminated due to connection timeout" mid-loop throws, is caught by the outer try/catch, logs an error, and the job exits — but since it's one-shot (not on a recurring cycle), it never runs again until the next full restart. Progress silently stalls at whatever partial state it reached, with no obvious "it crashed" signal unless you specifically search logs for its error string.

**How to apply:** for any one-shot startup backfill/migration job:
1. Delay its start past the known pool-stress window (e.g. 18+ min), not just a few seconds.
2. Wrap its own DB calls in a local retry (1-2 retries, short delay) — don't rely on the outer try/catch alone.
3. Use `Promise.allSettled` (not `Promise.all`) when batch-processing many independent items, so one item's unrecoverable failure doesn't abort the whole batch.
4. Verify completion via the DB (row counts), not just by trusting the "started" log — the "finished" log may never fire.
