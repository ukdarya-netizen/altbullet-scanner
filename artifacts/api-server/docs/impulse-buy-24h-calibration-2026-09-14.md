# Impulse Buy: 24h calibration review

Date: 2026-09-14  
Environment: production, read-only analysis

## Decision

Do not relax or tighten the live Impulse Buy gates from the current historical
cohort. Keep the existing 30m body, volume, close-strength, funding, OI, and
spot-volume rules unchanged until new fired decisions carry the same immutable
decision-time metrics as rejected decisions.

The pattern remains weak enough to require calibration, but the available data
does not identify a reliable replacement threshold:

- September legacy outcomes are positive but unstable.
- The latest week was negative.
- Fired and rejected decision snapshots are not feature-compatible.
- Several attractive reject averages were caused by compound reasons and an
  invalid LSK price discontinuity.
- The new 80/20 core-runner policy has only two terminal observations.

This review adds decision-time metric persistence for future fired Impulse Buy
events. It does not change trading behavior.

## Available cohort

At the analysis cutoff:

- 2,801 Impulse Buy decisions had 24h candle coverage.
- 1,893 trajectories were complete.
- 1,225 remained pending, partial, or retryable.
- 1,097 rejected trajectories completed during the preceding six hours.
- 120 fired events had 24h coverage.
- Rejected coverage began on 2026-09-04.
- Fired coverage spans 2026-06-18 through 2026-09-12.

The main comparability problem is feature provenance. Rejected snapshots contain
the closed-30m decision metrics (`candleBodyPct`, `candleVolumeMult`,
`candleCloseStrength`, funding, and OI). Existing fired snapshots came from
`tracked_signals` and contain none of those fields. Therefore historical fired
signals cannot be placed into the same threshold or failure-mask analysis
without reconstructing values after the fact, which is intentionally forbidden.

## Real tracked outcomes

September legacy Impulse Buy terminals:

| Policy | Terminal | Profit | Stop loss | Protected/B.U. | Average PnL | Median PnL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy | 76 | 17 | 15 | 43 | +0.76% | 0.00% |
| Runner v1 | 2 | 0 | 0 | 2 | +2.50% | +2.50% |

Weekly legacy outcomes were not stable:

| Week starting | Terminal | Profit | Stop loss | Protected/B.U. | Average PnL |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08-31 | 40 | 11 | 6 | 22 | +2.33% |
| 2026-09-07 | 38 | 6 | 9 | 23 | -0.79% |

The pattern is not reliable enough to declare calibration complete. The runner
sample is far too small for an exit-policy decision.

## Gate-independent 24h outcomes

For the 120 fired trajectories:

- +10% before -10%: 46
- -10% before +10%: 58
- neither: 16
- median MFE: +6.82%
- 10% trimmed mean MFE: +9.14%
- median MAE: -9.69%
- median 24h close return: -3.04%

This confirms weak downside-adjusted quality, but it does not reveal which live
threshold should change because the original fired decision features are
missing.

## Exact rejection masks

Compound reasons were kept as exact masks rather than crediting every outcome to
every failed gate.

| Exact reason mask | N | +10 before -10 | -10 before +10 | Median MFE | Median MAE | Median 24h close |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Body + volume + close | 880 | 198 | 230 | +2.93% | -3.27% | -0.62% |
| Body + volume + close + funding | 572 | 169 | 192 | +4.83% | -4.81% | -0.69% |
| Body + volume | 439 | 89 | 108 | +2.69% | -3.12% | -0.40% |
| Body + volume + funding | 231 | 62 | 60 | +4.54% | -4.16% | -0.27% |
| Volume only | 54 | 20 | 25 | +9.05% | -10.79% | -3.88% |
| OI1h only | 20 | 7 | 13 | +5.40% | -13.66% | -7.25% |
| Funding only | 16 | 7 | 9 | +9.85% | -21.71% | -13.74% |
| OI4h only | 12 | 3 | 9 | +11.85% | -14.20% | -8.15% |
| Body only | 7 | 1 | 1 | +5.32% | -2.05% | -0.18% |

The isolated funding and OI failures are volatile but downside-heavy. Their
median 24h closes are materially negative, and stop-first outcomes exceed
target-first outcomes. They do not justify removing the hard blocks.

The isolated volume failure is also weaker than required for promotion and has
large adverse excursion. Removing the volume gate would additionally create a
large frequency increase because component-only rejects are a 2% deterministic
sample.

The isolated body cohort is too small. No decision should be made from seven
events.

Close-strength-only evidence is insufficient.

## Outlier and dependence controls

Ordinary averages were rejected as the primary statistic.

Multiple LSK decisions on 2026-09-12 showed apparent 24h MFE between roughly
+800% and +1,100%. The repeated discontinuity dominates telemetry-failure
averages and is not accepted as calibration evidence. LSK must be excluded until
its price continuity is separately validated.

Repeated scans of the same symbol are correlated observations. Future policy
comparisons must deduplicate or cluster by symbol and 12-hour opportunity and
report day-clustered uncertainty. Raw row counts must not be treated as
independent trades.

## Concrete policy recommendations

1. Keep the current live gates unchanged.
2. Do not remove the funding or OI blocks based on aggregate MFE. Isolated
   failures have poor median close returns and adverse excursion.
3. Keep the 1.5x volume requirement. Removing it would materially increase
   frequency while admitting a downside-heavy isolated cohort.
4. Do not change the 2% body or 0.65 close-strength thresholds yet; their
   isolated samples are insufficient.
5. Do not tune the 80/20 runner until a meaningful terminal cohort exists.
6. Exclude invalid price-discontinuity symbols from calibration, beginning with
   LSK, without changing live trading solely from this report.
7. Re-run calibration only on forward fired and rejected events that share the
   same immutable decision metrics and overlap in time.

## Readiness criteria for the next gate decision

A gate change is decision-grade only when:

- fired and rejected events both contain the same decision-time fields;
- at least 30 completed isolated or matched events exist for the proposed gate
  change, with at least 20 in the later validation period;
- conservative TP-before-SL improves in the later period;
- median or 10% trimmed 24h return does not deteriorate;
- median MAE and worst-decile close return remain within the current fired
  cohort risk;
- the result survives symbol/12h deduplication and exclusion of invalid price
  discontinuities;
- the projected signal-frequency increase is acceptable.

## Instrumentation change

New fired Impulse Buy tracker snapshots now merge the original scanner
decision-time metrics into the canonical `tracked:<id>` trajectory event:

- price changes at 1h, 3h, and 24h;
- OI at 30m, 1h, and 4h;
- funding and spot-volume multiplier;
- futures taker telemetry;
- 30m body, volume multiplier, and close strength;
- candle close time, score, and component booleans.

The existing event identity is retained, so reconciliation remains idempotent
and does not create a second fired trajectory. The payload is stored atomically
on the tracker row before the best-effort snapshot write, so reconciliation can
recover the same metrics after a transient snapshot failure.