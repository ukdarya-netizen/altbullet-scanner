---
name: AltBullet snapshot retry boundary
description: Bounded recovery rules for post-signal AltBullet observational snapshots.
---

AltBullet snapshot retry eligibility must be enforced before every market-data fetch and again before persisting a `ready` result. Reclaimed work outside the age window or beyond the attempt allowance must become a terminal `unavailable` snapshot without fetching delayed market data.

**Why:** Checking limits only after a failed request leaves restart-reclaimed work able to record a misleading late “entry” snapshot after a later successful fetch.

**How to apply:** Keep the retry columns and pending-work index behind a mandatory, advisory-lock-protected startup schema gate in both development and production. Preserve claim-token fencing when finalizing so concurrent or stale workers cannot overwrite the terminal outcome.