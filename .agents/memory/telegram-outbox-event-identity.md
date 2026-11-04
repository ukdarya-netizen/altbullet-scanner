---
name: Telegram outbox event identity
description: How durable Telegram delivery deduplication distinguishes retries from separate notifications.
---

# Rule
Use a stable caller-provided business-event key for a durable Telegram outbox. Do not derive its uniqueness from the image path or rendered message text.

**Why:** Separate cancellations or position transitions can legitimately produce the same copy. Content-based uniqueness permanently suppresses later real notifications, while an event key preserves retries of one event without merging different events.

**How to apply:** Scope the key to the domain event, such as a tracked signal plus its cancellation reason, or a signal plus a specific triggered position transition. Keep the recipient in the unique database constraint so each target is delivered once per event.

# Transaction boundary
Persist the business-state transition and every recipient outbox row in the same database transaction.

**Why:** Committing a position/cancellation state first and enqueueing afterward creates a crash window where the state suppresses future retries but no durable delivery job exists.

**How to apply:** Resolve recipients before claiming the transition, conditionally update the business row and insert recipient jobs inside one transaction, then start network delivery only after commit. An empty recipient set skips only outbox insertion; it must not block the business-state transition.

# Recipient snapshot completeness
Treat “recipient lookup failed” and “recipient lookup succeeded with zero recipients” as different outcomes. State-changing delivery must use strict recipient-source resolution: any subscriber/settings lookup failure aborts before the business-state claim, while a confirmed empty snapshot may still commit the state transition.

**Why:** A tolerant lookup can return only the env/channel target during a transient subscriber query failure. Committing that partial snapshot permanently loses the event for every omitted subscriber.

**How to apply:** Keep tolerant fallback only for informational broadcasts. Durable lifecycle/cancellation fan-out must resolve every authoritative source successfully before entering the claim/outbox transaction.

# Lease fencing and bounded recovery
Persist a recipient row's pre-send fence and immutable attempt-start audit before every external Telegram request. Apply bounded recovery to 429, timeout, network, and 5xx outcomes; HTML parse rejection must switch durably to plain text.

**Why:** Telegram has no idempotency key or recipient-read confirmation, but primary trading alerts prioritize avoiding silent misses. The duplicate risk must therefore be bounded, marked, audited, and escalated rather than hidden.

**How to apply:** Size the lease above the request timeout, checkpoint each confirmed continuation part, and use shared DB-backed global plus recipient rate buckets across workers. Exhausted retries and terminal startup quarantine must enqueue a separate plain-text operator alert.

# Primary signal recovery
Primary alerts use `signal:<signals.id>` as their event identity and must remain durably pending until their recipient outbox enqueue succeeds.

**Why:** A signal can be committed while Neon is temporarily unable to insert its delivery rows. Without a persisted pending marker, the position begins receiving follow-ups even though the initial entry alert is lost forever.

**How to apply:** New primary-signal writers mark the signal pending before attempting delivery, then acknowledge it only after the outbox accepts the event. A startup and periodic reconciler re-enqueues pending rows with the same event key, making recovery safe across restarts and two workers.