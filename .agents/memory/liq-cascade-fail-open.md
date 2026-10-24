---
name: liquidation_cascade fail-open for CVD and taker — 2026-07-14
description: CVD (=== true) and taker (available && buy) both hard-blocked all fires when CG was down; changed to fail-open.
---

## Rule

`liquidation_cascade` CVD and spot-taker checks must be **fail-open**:

```ts
// OLD — blocked when CG unavailable
spotCvd?.available === true && spotCvd.cvd1h === true
_spotTaker !== null && _spotTaker.available && _spotTaker.dominance === "buy"

// NEW — fail-open
spotCvd?.cvd1h !== false               // null/undefined = no data = pass
_spotTaker === null || !_spotTaker.available || _spotTaker.dominance === "buy"
```

**Why:** Phase 1 conditions (price1h ≤ -8% AND ≥ -15% + OI1h ≤ -5% + volMult ≥ 3x) are already very rare and specific — a liquidation event at this scale is genuinely uncommon. Adding hard CG-data requirements on top means the pattern fires 0 times whenever CoinGlass has an outage, which can last hours. Phase 2's OI30m ≥ 0 (stabilization) is sufficient as the primary reversal confirmation.

**How to apply:** Any pattern where Phase 1 is already highly selective should use fail-open for secondary data sources. Hard-require CG data only when Phase 1 conditions are loose enough that false positives are a real risk.

Also updated `_pdbReject` chain to distinguish `oi30m_not_recovered` / `taker_bearish` / `cvd_bearish` for better diagnostics.
