---
name: Calibration high-profit objective
description: Defines the outcome trade-off to use when evaluating indicator and entry-filter candidates.
---

For entry-quality analysis and candidate filters, the user's current criterion is **peak movement**, not realized closing PnL. Use peak ≥10% as the existing strong-move threshold unless the user changes the threshold. A position reaching that peak remains a strong entry even if it later closes at B.U., by cancellation, or with smaller PnL. Realized PnL and exit effectiveness are separate, secondary analyses.

**Why:** On 2026-10-01 the user explicitly corrected the Impulse Buy audit: «Считаем и смотрим по пикам!». This supersedes the earlier realized-profit interpretation for evaluating strong entries. Do not reject a good entry merely because its exit failed to preserve the move.

**How to apply:** Lead with recall of peak ≥10% movers, removed strong peaks, peak distribution and reduction of weak entries. State whether the peak is recorded before closure or measured over a fixed forward horizon: do not merge those windows or truncate an entry-quality forward path at an earlier stop/cancellation. For fixed-horizon analysis, incomplete paths remain censored; a threshold already reached is observable, but an unreached threshold on an incomplete path is not a final failure. Preserve historical realized-PnL baselines as explicitly labelled historical measurements, not current objectives. Keep exit PnL and stop-before-peak paths visible separately, without relabelling peak movers as weak entries. Qualifying signals must not be suppressed merely because other positions are active.