---
name: Primary Telegram delivery policy
description: Bounded, auditable recovery for primary trading signals when Telegram delivery fails or is uncertain.
---

Primary trading signals use bounded, visibly auditable recovery after a persisted send fence. A successful Telegram response means only that its API explicitly accepted the request (`ok: true`), never that a user read it. Explicit HTML parse rejection switches durably to plain text. Telegram 429 follows `retry_after`; timeout, network, and 5xx failures use capped exponential backoff with jitter. Every dispatch is recorded before the external call and receives a separate immutable outcome.

**Why:** For primary trading alerts, a silent miss is more damaging than a bounded, visibly marked duplicate risk. Pre-dispatch fencing, recipient-level audit, strict retry budgets, and terminal operator escalation make that tradeoff explicit and observable.

**How to apply:** Freeze the intended recipient set before queue acknowledgement and create one durable row per recipient. Reserve shared global and recipient rate slots before every Telegram call. Persist a dispatch-start audit before sending and an outcome afterward. A newly exhausted or terminal delivery may create one deduplicated operator alert, but startup migrations/quarantines must emit only one aggregate summary; per-row migration alerts can flood the owner with hundreds of historical failures. Pending operator alerts may be quarantined without touching the underlying trading deliveries or audit.