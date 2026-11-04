---
name: BTC dominance outcome observations
description: Rules for testing whether BTC dominance explains changes in altcoin signal outcomes.
---

BTC.D is observational only. Capture the provider value, source, and provider observation time at signal entry and final close. Never use BTC.D as a scanner gate without a separate evidence-based decision.

**Why:** The user wants to test whether dominance explains weaker altcoin outcomes across months. Current BTC.D cannot be assigned to historical trades without corrupting the cohort, and old trades did not preserve entry-time dominance.

**How to apply:** Aggregate outcomes only from immutable entry snapshots and keep unavailable or legacy values as unknown. Use the same active-pattern cohort, Dubai entry month, and completed-outcome semantics when comparing months.

For daily BTC.D history, accumulate provider-timestamped observations independently of signal activity instead of assigning a live value to past days. Keep provider provenance and leave missing Dubai days empty.

**Why:** On 2026-09-27 CoinGlass history was unavailable and CoinGecko supplied only a current observation, while BTC prices covered 32 days. A current value cannot establish historical dominance. Future backfill requires a separately verified dated source and compatible methodology.

**How to apply:** A provider outage may reduce fresh coverage, but should not erase already saved observations. Do not infer missing BTC.D from BTC price or extrapolate from a current provider sample.