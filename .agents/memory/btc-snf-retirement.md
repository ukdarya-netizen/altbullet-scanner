---
name: BTC SNF retirement
description: BTC-specific Spot Net Flow observation and correlation analysis are retired
---

BTC-specific Spot Net Flow tracking for 1h, 4h, 24h and 7d is retired. Do not restart its observation series, expose its latest values on the BTC page, or compare its historical values against later BTC prices or altcoin outcomes. Existing historical measurements need not be deleted.

**Why:** The user found no useful correlation and explicitly requested removing BTC SNF and stopping its tracking. This supersedes the earlier decision to keep an observational BTC-SNF-to-BTC-price comparison.

**How to apply:** Continue BTC price/dominance observations and the separate per-token Spot Net Flow cache used by scanner patterns, metrics and Telegram. Do not remove token-level SNF or filter BTC from a generic cache solely because the BTC-specific analysis is retired.