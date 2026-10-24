---
name: calcAlphaScore structural floor for low-magnitude patterns
description: Why "quiet"/slow-accumulation patterns rarely clear the finalAlphaScore>=5 hard gate even when their own condition fires.
---

## Finding
calcAlphaScore's two biggest components (oiScore 0–3.5, volScore 0–3.0) are keyed on the *magnitude* of OI change and volume multiplier. Patterns designed to catch small, quiet moves (quiet_oi_accumulation, spot_oi4h_build, oi1h_breakout at its low end, bingx_exclusive, spot_vol_accumulation/surge) gate on OI/volume ranges that are themselves near the bottom of calcAlphaScore's own scoring bands (e.g. quiet_oi_accumulation requires oi30m 0.2–0.5%, spotVolMult 0.8–1.8x — both floor to the minimum 0.5/0.4 score). Combined with priceScore capped at 0.5, the structural ceiling from a pattern's own base signal is often ~1–2 raw points, well short of 5.

The only way these patterns cross the gate is via bonus factors that are NOT guaranteed per-signal: cmcScore (+2, only if CMC-trending), fundingScore (up to +1.5, only if funding notably negative), liqScore (up to +2, only if CoinGlass liquidation data available), and the post-OB `scoreBonus` added to `finalAlphaScore`. A signal without any of these bonuses will almost never pass, regardless of how "real" the underlying accumulation is.

**Why:** Explains the low fire-rate on 2026-07-08 for 8+ specialist patterns without needing to hypothesize a bug — the pattern condition and the score gate were designed independently and the gate implicitly assumes OI/volume magnitude correlates with quality, which conflicts with patterns explicitly built to catch LOW magnitude (quiet/early) moves.

**How to apply:** Before changing pattern gate thresholds to "fix" a low fire rate, check whether the real blocker is the shared `finalAlphaScore < 5` gate at scanner.ts. `spot_taker_lead` already has a documented manual override (scanner.ts ~6530) for this exact reason ("OI не участвует → calcAlphaScore недооценивает паттерн") — the same override pattern is the fix, not touching calcAlphaScore's shared formula (which volume_breakout_spot / whale-type patterns rely on being magnitude-sensitive).

2026-07-08: shipped the same manual-override fix for `quiet_oi_accumulation`, `oi1h_breakout`, `spot_oi4h_build`, `bingx_exclusive` (base 5-6 + margin from an orthogonal quality signal — cycle count / oi4hConsecGrowth / vol multiple — not from calcAlphaScore's own OI/vol magnitude).

2026-07-08 (batch 2, "Group A"): same override pattern shipped for `4h_momentum` (base 5 +1 if price4h≥6% or oi1h≥3%), `volume_taker` (base 5 +1 if volumeMultiplier≥4.0 or taker netBuyPct≥15%), `spot_momentum_reversal` (base 5 +1 if volumeMultiplier≥2.5). Overrides live in loop2 (post-candidate) scope, which only has the `base` candidate object + `_pe3` (prescanTracker) — NOT loop1's per-symbol locals (`priceChange`, `oi1h`, `spotVolMult`, `_spotTaker`, etc). Any future override must read from `base.*`/`_pe3.*`, not loop1 variable names, even when a task description names loop1-style variables in its formula.

## Adjacent lesson: "no OI gate" claims must be verified per-branch, not by pattern label
When asked to confirm 6 patterns had "no OI gate" for the `diagCvdIfOiRejected` diagnostic, only 2 (`spot_momentum_reversal`, `volume_taker`) were actually OI-free. `flush_reversal` had a genuine confirming OI gate (`prevOi30m <= -1.0` then `oi30m >= 1.5`) that was missed on first pass — fixed by adding `diagCvdIfOiRejected` there too. `spot_vol_surge`/`spot_vol_accumulation`/`spot_vol_breakout` use OI as an *exclusionary* gate (`noOiSpikeForSpotVol` — pattern blocked if OI already spiked via CoinGlass short/long TF confirmation), which is the opposite semantics of "OI too low" and doesn't fit the `diagCvdIfOiRejected` diagnostic as-is.
**Why:** grep for the gate's boolean definition line, not just the sentimentKey string — pattern names alone don't tell you whether OI participates.
