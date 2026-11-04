---
name: Telegram recipient union
description: Delivery audience combines eligible bot subscribers, approved Dashboard users with linked Telegram chats, and the configured channel.
---

# Rule
Resolve Telegram broadcast recipients as the deduplicated union of active bot
subscribers, approved non-expired Dashboard users with a numeric linked chat ID,
and the configured channel/environment target.

**Why:** Dashboard approval and Telegram subscription are separate lifecycle
records. Reading only one table silently omits valid users from signal and
position notifications.

**How to apply:** Durable state-changing broadcasts must resolve every recipient
source strictly before claiming the business event. For non-durable broadcasts,
use only a previously confirmed complete union as a transient database-outage
fallback; never fall back to a partial source.