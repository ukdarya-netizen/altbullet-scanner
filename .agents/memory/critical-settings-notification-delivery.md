---
name: Critical settings notification delivery
description: Delivery contract for restart, manual-check, and watchdog alerts.
---

Critical operational alerts whose deduplication is tracked in a settings timestamp must first resolve a strict, complete recipient snapshot, then update the settings claim and insert one durable outbox row per recipient in the same transaction. The operational owner chat is a safety recipient and is independent of paid subscriptions.

**Why:** A channel-only fallback can make an alert appear handled while the owner never receives it; a state claim before durable rows can permanently suppress a notification after a queue failure. Network-ambiguous Telegram outcomes must stay quarantined rather than being retried as a new send.

**How to apply:** Use strict recipient resolution and the settings-plus-outbox claim path for restart, near-stop/manual-check, and primary watchdog alerts. Log recipient role and delivery state, never message content, so channel and direct-chat failures remain separately visible.