---
name: Telegram bootstrap command resilience
description: Rules for Telegram commands needed before a user is known to the app.
---

Commands that provide a user’s Telegram identity or initial setup information must be handled before any subscription lookup or other database-dependent work.

**Why:** These commands are specifically needed when no subscription exists yet. A database timeout or pool error must not turn a simple identity request into a silent webhook success with no bot reply.

**How to apply:** Keep identity/setup commands self-contained, return an explicit response for private and group chats, and record whether the Telegram send succeeded. Do not put subscription guards or incidental reads ahead of them.