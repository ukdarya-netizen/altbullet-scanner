---
name: DropsTab watchlist — DELETED 2026-07-15
description: In-house DropsTab watchlist feature fully removed after analysis showed zero value; context for why it should not be rebuilt as-is.
---

The DropsTab manual watchlist (accumulation_phase/bounce_dip/binance_soon, Layer 0b scan injection, per-cycle metric logging) was **fully deleted on 2026-07-15**: frontend panel, routes/dropstab.ts, scanner Layer 0b block, schema tables (`dropstab_watchlist`, `dropstab_watch_log`), and OpenAPI paths/schemas. Dev DB tables dropped; prod tables left orphaned (harmless).

**Why deleted:** analysis of collected data showed the watchlist produced no actionable calibration signal for `dip_accumulation` — tokens were tagged too sporadically and the metric logs never fed any threshold change. Zero signals, zero tuning value, ongoing UI/scan complexity.

**Durable lesson:** DropsTab's public API has no endpoints for their screener tabs (only /coins, /tokenUnlocks, /fundingRounds, /investors, /cryptoActivities, /exchanges) — any future DropsTab integration would again require manual tagging, which failed here. Don't rebuild without a plan that guarantees consistent labeling volume.
