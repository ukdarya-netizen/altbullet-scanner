---
name: Dashboard presence semantics
description: Product decision for online status in the Members view
---

“Online” in the Members view means an active dashboard session, not a Telegram
online/offline state. The user explicitly selected dashboard activity when
offered the distinction.

**Why:** Telegram's Bot API does not expose a reliable user presence signal.
Showing activity from an open dashboard tab is accurate about the product the
owner is managing and avoids mislabelling Telegram subscribers.

**How to apply:** Keep the distinction visible in future UI or reporting work:
dashboard users can be online/offline based on recent session activity, while
bot-only subscribers must not be represented as Telegram-online.