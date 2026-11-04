---
name: spot_taker_lead double-fetch TTL diagnostic
description: Diagnostic-only logging added to confirm/refute the hypothesis that loop1 vs loop2 getSpotTakerFlow calls can straddle the 2-min cache TTL and flip dominance.
---

## Setup
`spot_taker_lead` calls `getSpotTakerFlow` twice per cycle: once in loop1 (gate check) and again in loop2 (SPOT TAKER FLOW FILTER). Hypothesis: if the gap between these two calls exceeds the 2-minute CoinGlass cache TTL, loop2 re-fetches fresh data and can see `dominance` flip to "sell" even though loop1 saw "buy" — causing legitimate signals to self-reject.

**Status as of 2026-07-08:** instrumentation only, no behavior change. `spotTakerLeadLoop1At` (module-level `Map<symbol, {at, dominance}>`) records loop1's timestamp+dominance; loop2 logs `gapMs`, `gapExceedsTtl` (>120s), and `dominanceFlipped` (buy→sell) at `logger.info` level with message `"🔬 spot_taker_lead DIAG"` whenever `finalSentiment.key === "spot_taker_lead"`.

**How to apply:** Before adding a filter exemption for `spot_taker_lead` (the fix `spot_divergence` already has), pull ~2 days of these DIAG logs and confirm the gap/flip actually happens at meaningful frequency. Do not skip straight to the exemption — the hypothesis was unverified when this logging was added.
