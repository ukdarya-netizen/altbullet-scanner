---
name: Queued image policy after publish
description: Persisted Telegram photo outbox rows can retain a pre-publish image choice while newer code delivers them.
---

When changing which image represents a business event, account for already-queued photo rows. Source-level selection only affects newly queued events; delivery after a publish may still use an old persisted image path. A narrow delivery-time correction may be needed for a known event identity and old path. Never rewrite already-delivered rows or broaden this to unrelated media.

**Why:** A profitable 4-day close was queued with an exit-advice image just before a new deployment started, but sent after deployment. The newly deployed selection code was correct yet the user still received the old image.

**How to apply:** For Telegram image-policy fixes, inspect production outbox creation time, delivery time, stored media path and deployment start before concluding that production code is stale. Test both new enqueue and legacy queued dispatch.