---
name: Stealth no cancellations
description: Stealth range-return cancel removed; no Stealth position is auto-cancelled.
---
2026-10-22 owner: «Убери отмены у Stealth». The watcher range-return cancel block was deleted; policy already had automaticCancellationEnabled=false. Stealth positions close only via normal exits (stop, B.U., profit, trailing, expiry).

**Why:** the user asked.
**How to apply:** do not reintroduce range-return or any other cancel for stealth_breakout; old cancelled rows and the re-entry module stay as history (re-entry is now inert).
