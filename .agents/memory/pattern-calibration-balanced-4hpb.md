---
name: Pattern calibration — balanced_grind + 4h_pullback_continuation (2026-07-31)
description: Data-driven gate changes based on scan_reject_log + growth_leader_log analysis.
---

## balanced_grind calibration

**Problem:** Vol floor 0.8 killed 95% of price_or_vol rejects (1811/1895 due to vol).
**Data:**
- price_or_vol rejects vol distribution: p10=0.13, p25=0.19, p50=0.29, p75=0.42, p90=0.64
- growth_leader_log vol: p25=0.22, p50=0.38 — "grind" is low-vol by nature

**Changes:**
- `volMult >= 0.8` → `>= 0.2` (covers growth_leader p25; grind = low-volume accumulation)
- `lastOi4h <= 8.0` → `<= 10.0` (growth_leader_log oi4h p75=8.77; 10% covers 75th pct)

**Why:** "Balanced grind" is characterized by uniform OI growth without volume surge. High vol floor was fundamentally mismatched to the pattern archetype.

## 4h_pullback_continuation calibration

**Problem 1:** price4h > -1.0% rejected 82 candidates with p50_p24h=1.47 (trending tokens, pullback not deep enough).
**Problem 2:** oi4h_not_neg: 32 cases with avg_oi30m=2.02 when OI4h >= 0 — bullish divergence (price down, OI up), old code required OI4h < 0.

**Changes:**
- `price24hChange >= 1` → `>= 0.5` (catch early trend start)
- `price4hChange <= -1.0` → `<= -0.7` (shallower pullbacks allowed)
- Added Path B: `OI4h >= 0 AND OI30m >= 1.0` = conviction buying during dip (bullish divergence)
- PDB reject: `oi4h_not_neg` + `oi4h_not_improving` merged → `oi_conditions`
- OiStr in fire block: shows "conviction buy" for Path B

**How to apply:**
- If scan_reject_log shows `oi_conditions` as dominant: consider further relaxing OI30m threshold for Path B.
- If false positives emerge (signals on downtrending tokens): tighten price24h floor back to 1%.
- Monitor signal quality after deploy; first fire is the true test.
