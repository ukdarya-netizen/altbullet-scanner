---
name: Stale primary alert recovery
description: Why replaying unqueued historic signals must differ from retrying already queued Telegram deliveries.
---

Recovery of a primary signal that **never entered the recipient outbox** must be limited to a recent signal with an open tracked position. Do not apply this cutoff to recipient rows that were already durably queued; those follow the separate bounded Telegram retry and ambiguity policy.

**Why:** A reconciliation run sent several days-old detector rows as new Telegram alerts, including a position that had closed a week earlier. The Dashboard's current-period view correctly did not list that closed position, making the notification appear to describe a missing new trade.

**How to apply:** When changing primary-alert reconciliation, require both an actionable time window and an open authoritative tracker before creating the outbox event, and recheck just before queueing. Treat historical unqueued rows as unsent, not as fresh alerts. Keep original signal time distinct from Telegram delivery time in investigations.