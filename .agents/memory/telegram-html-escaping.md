---
name: Telegram plain-text egress
description: Telegram delivery is plain text; formatting markup is stripped, while links stay compact through Bot API entities.
---

All Telegram text and photo-caption egress remains plain text. Legacy formatting markup is stripped centrally and HTML entities are decoded. Anchor labels stay compact and clickable through Bot API `text_link` entities instead of exposing raw URLs.

**Why:** HTML parse mode previously exposed literal formatting or rejected malformed alerts, while plain `label (URL)` links made operational messages visually noisy. Plain text plus entities avoids both problems.

**How to apply:** Не добавляй `parse_mode: HTML`. Normal direct send/photo/edit paths convert anchors into link entities. Every explicit plain-text fallback/retry must use the idempotent report sanitizer, not a single-pass entity decoder: enqueue repair can turn tags into entities, and one decode would expose literal `<b>`.