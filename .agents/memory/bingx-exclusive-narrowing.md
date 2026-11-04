---
name: isBingxExclusive narrowed — 2026-07-14
description: Removed oi30m<2.0 clause from isBingxExclusive; tokens with CG data but low OI should not route through bingx_exclusive pattern.
---

## Rule

`isBingxExclusive` must only fire when `cgOI?.available === false` — i.e. the token genuinely has zero data on CoinGlass.

The old condition `|| (oi30m !== null && oi30m < 2.0)` matched tokens that DO have CG data but happen to have low OI right now. These tokens should fall through to the standard OI patterns (silent_whale, dip_accumulation, etc.) which have their own OI thresholds.

**Why:** Mixing "no CG data" (structural) with "low OI this cycle" (transient) caused legitimate accumulation-phase tokens to fire as `bingx_exclusive` — a high-risk label with weaker supporting data — instead of being evaluated by patterns that already enforce appropriate OI gates.

**How to apply:** When adding any condition to `isBingxExclusive`, ask: "does this reflect a structural absence of external data, or just a current-cycle market state?" Only the former belongs here.
