---
name: Password reset schema startup
description: Availability rule for password-reset codes requested through Telegram.
---

The table that stores dashboard password-reset codes is required application schema, not optional startup maintenance.

**Why:** A Telegram reset request may arrive when heavy maintenance is disabled; putting its table only there turns a user-visible command into a webhook failure with no reset code.

**How to apply:** Ensure this table and the dashboard Telegram-link column are created in the mandatory schema gate before webhook processing. Commands must return an explicit temporary-error reply if a database operation still fails.