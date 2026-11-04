---
name: broadcastBatchAlert silent failure
description: broadcastBatchAlert now returns number (sent count); was void and silently swallowed all send failures
---

## Rule
`broadcastBatchAlert` returns `number` (count of successful sends to unique targets). Callers must check the return value — `0` means the signal was tracked in DB but NO Telegram message was delivered.

**Why:** VELVET-USDT fired (liq_cascade, +35.92%) but zero TG messages sent. Root cause: `sendMessage` / `sendPhotoByFileId` return `false` on failure (never throw); `broadcastBatchAlert` was `Promise<void>` and ignored all return values silently. No error was logged anywhere. Signal was marked fired in tracker, removed from `_watchMap` by next watcher cycle → no retry ever possible.

**How to apply:**
- `broadcastBatchAlert` (telegram.ts) now tracks `totalSent` per target, logs WARN per-target failure, logs ERROR when `totalSent === 0`.
- `_runLiqCascadeFireCycle` (watcher.ts) logs ERROR if `_liqBcastSent === 0` with symbol+entryReason.
- Other call sites currently ignore the return value — that is acceptable (failures are now self-logged inside `broadcastBatchAlert`).
- Do NOT revert to `Promise<void>` — callers that care can now detect failure.
