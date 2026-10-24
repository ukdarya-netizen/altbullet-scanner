---
name: Active-pattern analytics whitelist
description: Live analytics use active patterns; the monthly archive may include canonical retired patterns only where historical rows exist.
---

Live/current performance, operational views, and market-context analytics must filter through the canonical active-pattern whitelist rather than trying to exclude a growing list of retired keys. Statistics archives always show every current active pattern, including a zero baseline when it has no signals in the period. Retired patterns and historical detector methods appear only where real closed records exist.

**Why:** Historical `tracked_signals` and related telemetry are retained for audit, and users need honest month-level records of strategies that actually traded then. Raw unbounded aggregation would still silently contaminate current PnL, WIN RATE, and BTC-context conclusions.

**How to apply:** Default every dashboard/tracker aggregation to the active set at the API/database layer. In archives, add display-only zero rows for missing active keys without changing summary totals. Keep retired keys actual-data-only; for Stealth, synthesize only the current live method, never shadow or legacy methods.