---
name: Telegram chart links in reports
description: TradingView links belong in ticker-specific operational messages, never in periodic reports.
---

Periodic daily, weekly, and monthly reports must not contain TradingView chart links, including photo captions, continuation chunks, fallbacks, retries, and manual bot commands. Other messages about a concrete ticker keep their chart links.

**Why:** A global Telegram enrichment layer can re-add links after a report formatter removes them, especially during durable outbox delivery.

**How to apply:** Report suppression must survive the final delivery layer and outbox splitting; do not disable chart enrichment globally.