# Balanced Grind p24h cap decision

**Checked:** 2026-08-28  
**Decision:** keep the live `balanced_grind` upper cap at `p24h ≤ 20%`.

## Production evidence

The production read-only check used the dedicated shadow source prefix
`balanced_grind:p24h_gt_20:%` and restricted the cohort to
`reason = 'p24h_too_high_20pct'` and `pattern = 'balanced_grind'`.

| Measure | Result |
|---|---:|
| Shadow rows | 0 |
| Strict-reason rows | 0 |
| Rows with entry price | 0 |
| Rows with `price_6h_pct` | 0 |
| Rows with `price_24h_pct_after` | 0 |
| Rows complete at both horizons | 0 |
| Complete rows in 20–30% | 0 |
| Complete rows above 30% | 0 |

Because there are no production observations yet, neither the 20–30% range nor
the >30% range has a sample size, mean, median, +5% share, or negative-outcome
share to report. The minimum evidence threshold of 20 completed candidates is
not met.

## Rationale and next review

This is an evidence-insufficient decision, not evidence that the 20% cap is
optimal. The cap remains unchanged because the shadow cohort is specifically
designed to isolate candidates that passed every other BG gate; historical
signals or candidates rejected for another reason must not be mixed into this
comparison.

Revisit only after at least 20 deduplicated shadow rows have both forward
measurements populated. At that point, report the 20–30% and >30% groups
separately with sample size, 6h/24h mean and median, share reaching +5%, and
share with a negative outcome before considering 20%, 30%, or another cap.