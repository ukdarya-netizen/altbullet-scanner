---
name: Broadcast window dedup — DB-level signal dedup
description: broadcast_window_key unique constraint prevents duplicate Telegram signals for the same symbol in a 30-minute window; also covers Path A/B skip-handling bugs.
---

# Broadcast window dedup — signals table

## The rule
`signals.broadcast_window_key = "${symbol}:${Math.floor(Date.now() / (30*60*1000))}"` is a unique column. All signal insert sites use `.onConflictDoNothing()`. If the insert returns an empty array → another code path already created the signal for this symbol in this 30-min window → skip everything, continue.

**Why:** Two independent code paths (scanner confirmed-fire, OI Watch Path A, Path B, LiqCascade) can race to create different signal IDs for the same symbol. Each gets its own outbox `dedup_key = signal:<id>`, so both get delivered. The window key prevents the second row from entering the DB at all.

**How to apply:**
- Every new signal insert site must set `broadcastWindowKey` and use `.onConflictDoNothing().returning()`
- Check `if (rows.length === 0) { logger.info(...); continue; }`
- Pass `signalId: inserted.id` to `broadcastBatchAlert` → shown as `#N` in Telegram

## Also fixed (same session)
- **OI Watch Path A**: `tracked === "skip"` now suppresses broadcast (was broadcasting despite coin already active)
- **OI Watch Path B**: trackSignal moved BEFORE broadcastBatchAlert (was broadcasting then discovering skip too late; telegramAlertQueued remained false → reconciliation loop re-tried)

## Signal ID visibility
`AlphaResult.signalId?: number | null` → `formatAlphaSignal` adds `<code>#N</code>` to tagsLine. Same number twice in Telegram = duplicate slipped through.
