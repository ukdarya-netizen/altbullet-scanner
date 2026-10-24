---
name: Daily profitability BTC context
description: Defines the honest BTC-context semantics for entry-day and close-day profitability archives.
---

The daily profitability archive selects BTC 24h by calendar mode: entry-day uses the immutable entry snapshot, while close-day uses the separately captured final-close snapshot. Missing values remain unknown, not zero.

**Why:** Entry and exit can occur in different BTC regimes. Reusing entry context for close-day reporting or filling historical gaps with the current market value would create false market context.

**How to apply:** Capture close-time BTC only on the live terminal transition path. Do not populate old closed rows during startup reconciliation or substitute entry BTC when the close snapshot is null. Archive reads must tolerate a partial production rollout where the close-snapshot column is not present yet; absence yields null and must not fail the whole archive.