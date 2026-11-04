---
name: Balanced Grind p24h upper-cap evidence
description: Evidence rule for deciding whether to keep or change the BG p24h upper bound.
---

Keep the Balanced Grind p24h upper cap at 20% until candidates that pass every other BG entry gate but fail only this cap have enough forward 6h/24h outcomes.

**Why:** three profitable historical BG signals above 20% occurred before the cap was introduced. They show that winners can exist above the threshold, but they do not measure the post-filter candidate population and cannot establish that reverting 20% to 30% improves expected outcomes.

**How to apply:** use only the deduplicated shadow cohort whose sole rejection is the p24h upper cap. Do not mix candidates that also fail funding, order-book, net-flow, Whale Index, CVD, OI, price-3h, or volume gates.

As of the September review, the clean shadow cohort had only one completed
20–30% candidate (+11.08% at 24h) and one >30% candidate (−0.69% at 24h).
This is far below the review threshold and supports neither widening nor
tightening the cap.