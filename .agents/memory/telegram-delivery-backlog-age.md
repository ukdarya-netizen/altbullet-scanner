---
name: Telegram delivery backlog age
description: Health classification for old unknown Telegram recipient deliveries.
---

Classify unknown or terminal Telegram delivery backlog by the event row's immutable creation time, not its most recent update time.

**Why:** startup quarantine, audit reconciliation, and recovery bookkeeping legitimately update a row. Using `updated_at` makes a days-old ambiguous delivery look like a fresh outage immediately after restart and hides the distinction operators need.

**How to apply:** use creation time for historical-vs-active health buckets and displayed backlog age; reserve update time for current state transitions and lease diagnostics.