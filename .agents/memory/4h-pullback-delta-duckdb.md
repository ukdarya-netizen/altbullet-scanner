---
name: 4h_pullback delta — DuckDB validation was contaminated
description: Attempted oi_4h>=2.0 delta condition; 63.3% win rate was data leakage from confirmed_pump source
---

## Decision (2026-07-20)
**REVERTED** — oi_4h≥2.0 proxy condition removed. Zero-crossing (prevOi4h<0 → lastOi4h≥0) restored.

## Root cause of false validation
market_snapshots has 3 sources:
- `confirmed_pump` (n=767): label_win=1 BY CONSTRUCTION — rows selected because pump already happened
- `full_scan` (n=12834): honest random sample, label_win reflects future price
- `bingx_excl` (n=3996): BingX-exclusive tokens

For 4h_pullback candidate pool (p24h 5-20%, p4h≤-1.5%, oi_4h≥2.0):
- n=49 total: 29 confirmed_pump (100% label_win) + 20 full_scan (10% label_win)
- Mixed-source result: 63.3% — MEANINGLESS, contaminated
- Correct result (full_scan only): 10.0% (n=20)

## Honest train/test split (full_scan only, time-based 70/30)
Train: 2026-05-05 → 2026-06-26
Test:  2026-06-26 → 2026-07-18

| Condition | TRAIN n | TRAIN win% | TEST n | TEST win% | ALL win% |
|-----------|---------|-----------|--------|----------|---------|
| base (no OI gate) | 83 | 3.6% | 193 | 4.7% | 4.3% |
| old (oi_4h≥0) | 22 | 0.0% | 57 | 10.5% | 7.6% |
| new (oi_4h≥2) | **4** | 0.0% | **16** | 12.5% | 10.0% |

Sample sizes too small (n=4 train) for any conclusion. Neither condition has valid evidence.

## Key rule for future DuckDB validation
**ALWAYS filter by source='full_scan'** before evaluating any condition.
confirmed_pump rows = historical pumps selected because they pumped → always label_win=1 → inflates ANY feature that correlates with pumping behavior (like high OI4h).

## label_8pct_24h note
label_8pct_24h is NULL for full_scan rows (not populated). Only confirmed_pump has it.
So 100% label_8pct_24h = 29/29 confirmed_pump = pure leakage, not a real signal.

## Status
4h_pullback_continuation: code reverted to original zero-crossing condition (prevOi4h<0 → lastOi4h≥0).
Pattern was firing 0 signals in prod regardless — redesign requires real prod signal data.
