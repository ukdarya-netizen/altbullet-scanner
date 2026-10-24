---
name: Post-close hourly follow-up
description: Why every terminal outcome retains one idempotent hourly 72-hour trajectory.
---

All terminal outcomes use one shared hourly price trajectory for the first 72 hours after closure. The legacy B.U. storage is generalized in place so valid B.U. observations remain available without copying or double-counting them.

**Why:** A single endpoint snapshot can miss a large continuation move that later retraces. A second parallel table would also risk counting the same historical B.U. observation twice.

**How to apply:** Record profit, stop-loss, cancelled, breakeven, B.U. stop, and expired outcomes under one signal/hour uniqueness key. Keep unavailable ticker hours absent rather than writing zero. Treat each price as that hour's ticker snapshot, not an intra-hour high or low.

For B.U. calibration specifically, use the direction-aware trajectory, its peak, trough, and hour-72 observation as evidence for adjusting activation.

Run +5/+8/+10 BE calibration independently for every active pattern. A pattern qualifies only from its own mature cohort (at least 10 BE exits, each with at least 60 distinct hourly samples and an exact hour-72 observation); global maturity cannot substitute for a sparse pattern.

**Why:** Continuation and protection-loss behavior differs by pattern. Pooling patterns can make a threshold look safe while one strategy lacks enough evidence or pays a different downside cost.

**How to apply:** Keep universal replay observation-only. Show per-pattern maturity and recommendation, preserve the actual +5% live rule until that pattern qualifies, and never let analytics mutate exit settings automatically.

For Liquidation Cascade, do not promote the B.U. milestone from +5% until at
least 10 mature B.U. exits each have 60 distinct observations in hours 1–72
and an exact hour-72 observation. Counterfactual +8%/+10% must show their
continuation rate, peak, hour-72 movement, and the count that would have
retraced below B.U. without reaching the higher level.

**Why:** The legacy LC exits predate the hourly post-B.U. collection and cannot
be reconstructed from entry-based trajectory snapshots. Treating their
single-point outcomes as a full path would make a higher stop in-sample.

**How to apply:** An incomplete cohort is an explicit “keep +5% for now,” not
evidence that +8% or +10% is safe.