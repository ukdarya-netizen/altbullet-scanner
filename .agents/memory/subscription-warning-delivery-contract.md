---
name: Subscription warning delivery contract
description: At-most-once policy for subscription-expiry photos when Telegram and database outcomes can diverge.
---

Retry a subscription warning only after Telegram explicitly reports failure. A network error or timeout is ambiguous even when the sender reports it as retryable: Telegram may already have accepted the photo. Do not automatically reclaim an old `processing` delivery, even after its lease timestamp passes.

**Why:** Telegram Bot API has no idempotency key. If Telegram accepted the photo but the database could not persist `delivered`, reclaiming that ambiguous row can send the same warning twice. Preventing duplicate expiry photos takes priority over automatic recovery of an outcome that cannot be proven.

**How to apply:** Deduplicate by Chat ID, warning kind, and exact subscription expiry. Let concurrent workers compete through one atomic claim. The expiry-photo policy is a 2–4 hour delivery window centered on three hours; its durable kind is separate from the retired four-hour schedule. Classify structured sender results: an HTTP/API rejection is retryable, while a no-response transport failure remains ambiguous. Keep ambiguous `processing` rows claimed and surface them for manual inspection instead of resending automatically.