---
name: Real signal overview identity
description: Durable identity and cleanup rules for dashboard signals versus raw detector rows.
---

Dashboard-facing signal lists and counters treat a row as a real trading signal only when it is linked to a durable tracked position. Telegram delivery state is a separate fact and must be displayed separately from the trading status.

**Why:** Detector flows may insert a raw row before tracking. Duplicate, post-pump, or persistence guards can then suppress the position and Telegram alert, leaving a convincing orphan that was never a real signal.

**How to apply:** Keep raw detector access diagnostic-only. After a pre-track rejection, discard the preliminary row only with a `NOT EXISTS` tracker guard so an FK-linked position can never be removed. New overview queries must reuse the tracker-linked definition.