---
name: Primary signal tracker atomicity
description: Prevents a delivered trading alert from existing without its dashboard position.
---

A primary trading alert may enter Telegram recovery only after its linked tracker position exists. Recovery queries must enforce this at the database boundary, not rely on a preceding acknowledgement update.

**Why:** A tracker insert failure and a delayed `telegramAlertQueued` acknowledgement can race with the generic Telegram reconciler. The reconciler can otherwise deliver the signal while no position exists for watcher or dashboard.

**How to apply:** Require the linked tracker row before primary-alert replay. Repair historical orphans only when a durable delivery event confirms the alert actually went out, and perform the idempotent tracker repair while holding the market-cycle lease.