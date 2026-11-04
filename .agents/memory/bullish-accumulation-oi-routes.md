---
name: Bullish Accumulation OI routes
description: Durable entry-contract rules for BA and its delayed OI Watch fire paths.
---

Bullish Accumulation v3 separates four OI theses: slow multi-TF (OI30m ≤2.5%), transition (2.5–3.5%), fresh (3.5–5%), and extended (5–10%). OI30m >10% remains blocked. Slow multi-TF additionally blocks known OI1h >6%; missing remains fail-open.

**Why:** A single pipeline previously required strong OI30m and later rejected the same candidate as too hot. The 2.5–3.5% gap and >5% cap were hard gates built from unrepresentative samples, so separate routes keep them attributable. In the v2 slow production cohort, OI1h >6% separated 2/2 STOP LOSS from 0/6 signals with an observed peak ≥10%; the transition winner at OI1h 6.62% proves the cap must remain slow-only.

**How to apply:** Keep route classification in one pure contract shared by scanner and every delayed fire path. Slow OI Watch entries require no extra +2% move (0% floor); faster routes retain +2%. Apply the >6% OI1h cap only after a candidate resolves to slow; transition/fresh/extended are unaffected. Refresh missing multi-TF OI and retain incomplete rows.

Production calibration must identify the canonical cohort by a versioned entry-source marker that includes the selected OI thesis. v3 begins with the slow-only OI1h cap; never mix it with v1/v2, infer the launch boundary from a deployment timestamp, or reclassify legacy signals from later-enriched metrics.

**Why:** Direct scan and OI Watch historically wrote different source labels, while old entry snapshots were captured under conflicting gates. Mixing them would make a post-contract comparison look larger than it really is.

**How to apply:** Never mix contract versions. Compare slow, transition, fresh, and extended separately. Keep thresholds unchanged until at least 20 final signals exist and every live route has five; any change still requires replay.