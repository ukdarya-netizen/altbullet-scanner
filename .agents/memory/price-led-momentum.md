---
name: price_led_momentum pattern design
description: Durable decision contract for the price_led_momentum scanner pattern (Archetype C).
---

## Durable decision contract

Price Led Momentum is a direct, spot-led signal. Its live gates are:

- 24h price change from 5% through 15%;
- 3h price change from 1.5% through 4.0%;
- decision-time Spot Volume multiplier present, finite, and at least 1.1x its stored 1h average;
- positive Spot Netflow on either 1h or 4h;
- at least two positive values among 15m, 30m, 1h, and 4h spot CVD.

The Spot Volume multiplier is frozen once at decision time and the same value must drive qualification, decision metrics, and tracked-signal persistence. Missing or non-finite Spot Volume fails closed for PLM. Impulse Buy keeps its separate historical zero-volume unavailable/fail-open behavior.

OI, Futures Taker, Whale Index, futures-volume/OI ratios, and cycle count are telemetry only. They must not influence PLM qualification, direct-fire routing, or automatic cancellation. Existing/open/legacy positions and historical outcomes are not changed.

## Why this policy

The all-history review showed that tightening PLM improves quality and deposit capacity at the cost of signal frequency. The comparable immutable cohort retained only a modest sample, so its quality/frequency trade-off is accepted as the selected policy, not as proof for further threshold inference. Do not add OI, Futures Taker, cycle-count, funding, or other gates until new forward evidence supports a separately reviewed change.

Calibration must use only recorded decision-time values. Never reconstruct missing legacy metrics or reinterpret mutable/backfilled telemetry as an immutable decision cohort. Shadow analytics for the former p24h cap, Futures Taker, OI, and other slices remain observation-only and must never mutate scanner thresholds automatically.
## Lifetime
Owner 2026-10-11: PLM positions live at most 1 day (generic lifetime close via per-pattern max watch days; other patterns keep 4). Earned BE/trailing protection still wins at expiry.
**Why:** live PLM closes took median ~23h and 30/62 took >24h (some 50–100h); the pattern is a fast continuation.
