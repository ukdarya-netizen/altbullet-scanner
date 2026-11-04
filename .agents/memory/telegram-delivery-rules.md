---
name: Telegram delivery rules
description: Index of durable delivery, deduplication, subscription and message-format policies
---

Read the relevant topic before changing Telegram delivery or outbound copy:

- [Dual-process broadcast dedup](dual-process-dedup.md) — use an atomic database claim across workers.
- [Outbox event identity](telegram-outbox-event-identity.md) — dedup keys identify events, not rendered text.
- [Subscription warning delivery](subscription-warning-delivery-contract.md) — retry confirmed failures only.
- [Subscription expiry send boundary](subscription-expiry-send-boundary.md) — check personal eligibility immediately before sending.
- [Subscription-start notification](subscription-start-notification-policy.md) — notify on activation or restoration, not end-date shifts.
- [Media upload fence](telegram-media-upload-fence.md) — unknown multipart outcomes close only the originating event.
- [Milestone delivery](milestone-delivery-confirmation.md) — trading state and Telegram delivery are separate.
- [Recipient union](telegram-recipient-union.md) — bot, Dashboard users and channel form a deduplicated audience.
- [Bot-blocked reachability](telegram-bot-blocked-reachability.md) — confirmed 403 is a transport state, not subscription status.
- [Critical settings delivery](critical-settings-notification-delivery.md) — resolve audience before atomic settings claim and outbox insert.
- [Primary delivery](primary-telegram-delivery-policy.md) — bounded marked recovery for unknown outcomes.
- [Stale primary alerts](stale-primary-alert-recovery.md) — never turn old unqueued detector rows into fresh alerts.
- [Primary tracker atomicity](primary-signal-tracker-atomicity.md) — recovery requires a durable tracker row.
- [Delivery backlog age](telegram-delivery-backlog-age.md) — classify age by creation, not update time.
- [Queued image policy after publish](telegram-queued-image-policy.md) — a deployed worker can send media selected by pre-deploy code; repair narrowly by event identity before dispatch.
- [Chart links in reports](telegram-report-chart-links.md) — omit links from daily/weekly/monthly reports, not ticker messages.
- [Primary caption budget](telegram-primary-signal-caption.md) — keep the complete primary signal in one photo caption.
- [Plain-text links](telegram-html-escaping.md) — strip HTML on egress and use Bot API entities for clickable links.
- [Owner forwarding](telegram-owner-forwarding.md) — operational owner gets an unprotected personal copy.

**Why:** Several outbound message paths share reliability and access constraints; selecting only a single rule can reintroduce duplicate, missing or misdirected sends.

**How to apply:** Open the topic for the delivery path being changed and check related audience, retry and event-identity rules.