---
name: Telegram bot-blocked reachability
description: Durable rule for distinguishing Telegram reachability from subscription and Dashboard access.
---

A confirmed direct-chat Telegram 403 stating that the bot was blocked is a persistent recipient reachability status and immediately revokes linked Dashboard access. Record it for subscriber-only and Dashboard-linked Chat IDs, and show the cause in the merged member view.

**Why:** Delivery audit and durable outbox retained the exact 403 reason, but Dashboard users stayed approved. Production had 268 abandoned rows for two directly linked Chat IDs, so those users could still use Dashboard after blocking the bot.

**How to apply:** All text, keyboard, uploaded-photo, and cached-photo paths atomically upsert blocked reachability and set the matched Dashboard account to blocked. Backfill from both delivery audit and durable outbox. A successful `/start` clears Telegram reachability, but Dashboard restoration requires admin approval; manual deactivation or expiry never manufactures a block.