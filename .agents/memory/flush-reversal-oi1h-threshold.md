---
name: flush_reversal oi1h threshold loosened
description: Why flush_reversal's oi1h gate was changed from >=0 to >=-0.5.
---

## Finding
`flush_reversal` requires a prior OI drop (`prevOi30m <= -1.0`) followed by recovery (`oi30m >= 1.5`) within the same rolling 1h window that produces `oi1h`. Requiring `oi1h >= 0` demanded the 1h window fully net out to flat-or-positive despite the drop just confirmed by `prevOi30m` sitting inside that same window — mathematically fighting its own confirming condition on borderline cases.

**Why:** the drop and the recovery are both partly inside the 1h lookback; a strict `>=0` floor rejected valid recoveries where the drop was still weighing down the 1h aggregate.

**How to apply:** gate loosened to `oi1h >= -0.5`, giving headroom for the confirmed drop without abandoning the "net recovering, not net collapsing" intent. If tightening `oi1h` again in the future, check it against `prevOi30m`'s window overlap first, not in isolation.

## Update 2026-07-09 — real bottleneck was prevOi30m, not oi1h
The `oi1h` loosening above never mattered in practice: `prevOi30m <= -1.0` (the *first* gate condition) blocked 99.4% of all rejections (8635/8685 since 2026-07-08) — candidates never got past it to reach the `oi1h` check at all.

A live cross-sectional snapshot of `prescan_tracker.prev_oi_30m` (n=37 tracked tokens) showed: median ≈ +0.19, p25 ≈ -0.19, only 2/37 (5.4%) at or below -1.0, but 8/37 (21.6%) at or below -0.3. Threshold loosened -1.0 → -0.3 to let the gate pass occasionally while still requiring a real prior OI decline (not just flat/positive).

**Why:** a mathematically near-unreachable *first* gate condition silently kills a pattern regardless of any other threshold tuning further down its condition chain — always check the actual value distribution of the first blocking condition before tuning downstream thresholds.

**How to apply:** `prescan_tracker` holds only a *live snapshot* per currently-tracked symbol, not historical distribution — treat it as a small-n proxy only. If a rigorous historical distribution is needed later, add value logging on rejection first.
