---
name: Subscription-start notification policy
description: When the Telegram activation image should be sent during subscription administration.
---

Send the subscription-start image only when access is explicitly approved, a
first paid end date is assigned, or expired/inactive access is restored. Do not
resend it when an administrator only moves an already-active future end date.

**Why:** The image is a welcome to a newly active paid service, not a reminder
for ordinary administrative edits. Repeating it on each date correction makes
the bot noisy and weakens the activation moment.

**How to apply:** Any future subscription-management route must compare the
previous and next access state before dispatching the image. Preserve the
non-blocking delivery behavior: Telegram delivery problems must never roll back
an approved subscription.