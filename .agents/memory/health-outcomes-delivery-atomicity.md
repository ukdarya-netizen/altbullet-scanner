---
name: Health & outcomes delivery atomicity
description: Transaction boundary for health-event and cancel-outcome analytics.
---

Health events and cancel outcomes must be written inside the same database
transaction that claims the tracked-signal state change and enqueues its
Telegram delivery. Do not add a detached, fire-and-forget analytics INSERT
after a successful claim.

**Why:** The production database pool can time out during busy scanner cycles.
A detached insert can fail after the state and notification are already
committed, leaving irrecoverable gaps in Health & Outcomes. The original market
snapshot cannot be recreated honestly later.

**How to apply:** For every Telegram-triggered health advice or tracked-signal
cancellation, insert its analytics row from the `broadcastPhotoAfterClaim`
transaction callback. If the analytics insert fails, abort the transaction so
neither the state change nor outbox event commits; the normal scanner cycle can
try again.