---
name: Dedicated cancellation policy
description: Guardrails for BA, BG and LC cancellation decisions and retrospective evidence.
---

`bullish_accumulation` has no automatic cancellation paths. Normal stale cancellation is disabled globally. Liquidation Cascade's smart-CVD cancellation is paused, but its independent 120-hour max-age check and normal trading exits remain active. Other eligible patterns keep smart-CVD and max-age as independent paths, with fail-closed confirmation when required entry/current CVD and OI evidence is unavailable.

**Why:** In the mature production cohort since 2026-08-19, 72.7% of stale-cancelled positions recovered after exit and 54.5% moved at least +5%. BA is an accumulation thesis whose expected contract excludes cancellation. Among five mature September LC smart-CVD cancellations, two subsequently reached +10% from entry while only one crossed its saved stop; this small, partially sampled cohort argues for a reversible pause, not a permanent verdict. A past loop-level `continue` also showed that disabling one path must not accidentally suppress LC's separate max-age protection.

**How to apply:** Never re-enable BA auto-cancel or normal stale from legacy rows. Preserve historical reason codes for replay. Reassess LC smart-CVD only with a larger comparable forward cohort; do not disable its max-age check or ordinary stops while it is paused. Evaluate other smart-CVD and max-age paths separately, and treat 72-hour prices as observations at or after the threshold unless exact observation time is persisted.