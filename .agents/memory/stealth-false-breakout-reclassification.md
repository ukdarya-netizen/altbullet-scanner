---
name: Stealth false-breakout reclassification
description: How to remove confirmed false Stealth entries from live outcomes without destroying audit history.
---

Confirmed false Stealth entries should leave the trading/outcome population through a neutral reclassification, while their source and tracking records remain available for audit.

**Why:** Hard deletion can violate signal-to-tracker referential integrity and makes it impossible to explain the correction; treating the row as cancelled or a loss would distort performance statistics. A neutral tracker alone is insufficient if delayed alert recovery can still announce it as a new trade.

**How to apply:** Use an exact, reviewed identifier whitelist for one-time corrections, keep positive-control symbols out, clear outcome fields, exclude neutral status from all performance queries and outbound recovery, and preserve already-delivered audit history.