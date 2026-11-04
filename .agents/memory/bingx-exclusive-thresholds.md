---
name: bingx_exclusive correct thresholds
description: Why old vol≥1.8x was wrong, what the data-driven thresholds are, and the 2026-07-19 cycleCount + volMult fix
---

## Rule (current, 2026-07-19)
bingx_exclusive fires on: `cgNoDataCount >= 3` + `price24h 3-30%` + `priceChange >= 0.3%` + `cycleCount >= 2`.
`volMult >= 0.3` gate REMOVED.

## Why cycleCount was lowered 5 → 2
Backtest via `GET /api/admin/backtest-bingx-exclusive` (growth_leader_log, 30 days):
- 796 BingX-exclusive tokens logged; 30 in p24h 3-30% range
- **ALL 30 were blocked by cycleCount < 5** — by cycle 5 (~2.5h) every pumper had already exceeded 30% p24h ceiling
- With cycleCount >= 2: 15 candidates/month, hit_10% ~13%, avg_p24h ~6.3%
- With cycleCount >= 5 (old): 0 candidates — pattern was permanently dead

## Why volMult gate was removed
- `null >= 0.3` in JavaScript evaluates to `false` (null coerces to 0)
- At cycle 1-4, `volMult` is NULL (no rolling-average baseline established yet)
- So the vol gate silently blocked every single token that passed the cycle gate
- Fix: removed `&& volMult >= 0.3` entirely; `priceChange >= 0.3%` provides sufficient activity confirmation
- Do NOT re-add `volMult >= X` without verifying non-null coverage at target cycle count first

## Why old spotVolMult ≥ 1.8x was wrong (original finding)
- growth_leader_log analysis: pumpers had avg vol 0.31x (not 1.8x)
- Higher vol correlated WORSE with pump outcomes

## Data source quirk — cg_oi_available vs oi_30m
For backtest queries, `cg_oi_available = false` returns 0 rows (historical data):
- BingX-exclusive tokens had `cgNoDataCount < 3` at log time → `cg_oi_available = NULL` (not false)
- Correct proxy filter: `oi_30m IS NULL AND oi_1h IS NULL` (matches all 796 no-OI entries exactly)

## How to apply
- Stop loss: global -10% (no liq-heatmap data for these tokens)
- HighRisk flag in telegram.ts wired for `sentimentKey === "bingx_exclusive"` — no change needed
- If false-positive rate high after production data: tighten `price24h >= 5` or add `cycleCount >= 3`
- Do NOT use volMult as a gate until enough cycle-2+ tokens accumulate vol baselines (weeks of data)
