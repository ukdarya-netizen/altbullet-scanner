# Impulse Buy smart-cancel / runner replay

**Read-only replay; no trading code, stored history, workflow, or database was changed.** The comparison is limited to the 13 production `impulse_smart_cancel_cvd` cancellations, all single-entry `single_entry_v1` rows stamped `impulse_runner_v1`. Production data is as of **2026-10-01 04:09:16.912 UTC**.

## Result

The recorded cancellation marks are all negative: **13/13**, totaling **−37.3803 percentage points** across equally reported rows (mean **−2.8754%**; not a portfolio-weighted return). These `cancelled` row marks are not exchange fills or proof of executed exits. None had recorded a +10% peak at its cancellation time.

In the price-only counterfactual—remove only the impulse smart-cancel and retain the requested core protections, ordinary stop/trailing behavior, normal age rules, and runner timer—**0/13 has a modeled normal exit definitely before its recorded smart-cancel time**. By available follow-through, 10 rows have terminal modeled outcomes and 3 newer rows remain right-censored:

- **8 terminal core exits** reach the persisted −8% emergency stop.
- **2 core trailing closes transition to the pure runner**. The core stop marks are +19.33% (ENA, ID 1718) and +10.30% (FET, ID 1737). At the original-entry five-day lifetime, their canonical pure-runner marks are **+27.03%** and **+33.48%**, respectively. In both cases the recorded OHLC mark is above the earned runner floor (+4.87% ENA; +7.21% FET), so the settlement mark is `max(observed mark, earned floor)`. These are not 20%-weighted contributions or whole-position returns.
- **3 newer rows are unresolved**, not winners or losers: source coverage ends at 32.1 hours (PUMP, ID 2047), 14.6 hours (MARSCOIN, ID 2063), and 14.6 hours (ARB, ID 2064).

Thus, **2 distinct terminal rows** have a modeled lifetime settlement mark strictly above +10%, with both high-first/low-first core-transition branches terminal and no unresolved runner continuation for those rows. Three newer positions are still censored and excluded from winners/losers. The 8 core-stop outcomes are separate from the 2 canonical, pure-runner rows. No combined weighted/portfolio P&L is asserted. The price-only source also shows four positions later printing a +10% peak within their observation horizon, but those later highs are **secondary only**: PUMP (ID 1715) and ENA (ID 1735) reach their later raw highs after the counterfactual has already hit its ordinary stop.

## Row-by-row comparison

All modeled prices below are gross theoretical stop/timeout marks with original entry as the return basis. “Observed peak” is a later raw price high, not a realized counterfactual result.

| ID | Symbol | Cancel age | Recorded cancel mark | No-smart-cancel path | Observed peak, secondary |
|---:|---|---:|---:|---|---:|
| 1707 | DASH | 7.95h | −2.61% | Core emergency stop −8.00%, Sep 20 03:00 UTC | +4.87% |
| 1715 | PUMP | 6.37h | −2.09% | Core emergency stop −8.00%, Sep 20 03:30 UTC | +10.29% |
| 1718 | ENA | 11.93h | −2.33% | Core closed; lifetime settlement mark +27.03% (earned floor +4.87%), Sep 23 07:35 UTC | +34.87% |
| 1723 | VTHO | 7.48h | −4.56% | Core emergency stop −8.00%, Sep 19 04:00 UTC | +4.05% |
| 1735 | ENA | 9.31h | −3.47% | Core emergency stop −8.00%, Sep 23 14:15 UTC | +17.98% |
| 1737 | FET | 8.99h | −2.67% | Core closed; lifetime settlement mark +33.48% (earned floor +7.21%), Sep 25 17:05 UTC | +37.21% |
| 1921 | WIF | 64.03h | −2.62% | Core emergency stop −8.00%, Sep 28 15:00 UTC | +4.99% |
| 1922 | FARTCOIN | 13.87h | −2.32% | Core emergency stop −8.00%, Sep 28 03:45 UTC | +0.81% |
| 1930 | SYN | 47.15h | −2.16% | Core emergency stop −8.00%, Sep 28 05:45 UTC | +4.08% |
| 1949 | FLOW | 7.57h | −2.67% | Core emergency stop −8.00%, Sep 28 05:45 UTC | +1.60% |
| 2047 | PUMP | 7.73h | −2.18% | Right-censored at 32.1h; last mark −2.84% | +1.76% |
| 2063 | MARSCOIN | 6.81h | −4.71% | Right-censored at 14.6h; last mark −0.20% | +0.30% |
| 2064 | ARB | 6.10h | −3.00% | Right-censored at 14.6h; last mark −1.84% | +1.74% |

Recorded cancel-age returns are tracker marks, not independently verified fills. The 15-minute event bar was locally refined with public one-minute candles; the pre-entry overlapping minute was excluded.

## Policy used

The replay imports the live pure helpers from `watcher-config.ts`, `trailing-stop.ts`, `impulse-runner-policy.ts`, and `timeout-exit-policy.ts`, rather than changing or shadow-copying application policy:

- All stop, milestone, trailing, runner, and P&L calculations use `originalEntryPrice` (zero entry/original-entry mismatches in this cohort).
- Persisted single-entry emergency stop: **−8%**.
- Impulse Buy protection: **+5% peak → breakeven (0%)**; **+10% peak → +5% protected floor**.
- Core target/trailing: **+10% first target; +15% activation; 10-point gap**.
- Once a trailing core close settles the core, the runner is simulated separately: **breakeven floor; +30% activation; 30-point gap; original-entry five-day lifetime**. The replay follows `claimImpulseRunnerFinalClose`'s lifetime settlement contract: if the durable peak is at least +30% and the effective trailing stop is at/above entry, close at `max(observedPriceMark, effectiveTrailingStop)` and classify profit; otherwise close at original-entry breakeven and classify `bu_stop`. The modeled observed mark is the last available fully closed candle at the timer, not an exchange fill. Runner P&L is pure return from original entry, not an 80/20 weighted result.
- The independent **72-hour normal max-age path is retained conditionally**. The live path additionally needs market/OI/CVD evidence; it is never presumed from OHLC alone. The ordinary stale path remains disabled for impulse buys. For an unclosed non-runner core, the normal four-day watcher lifetime remains in the model.

The age-72 price gate was eligible in **0** rows. WIF (ID 1921) was still active near 72 hours but its observed peak was +4.99%, above the policy’s `<+2%` max-age price condition. The other rows had already exited, entered a runner stage, or had not reached 72 hours. Twelve cancellation rows have no saved exit CVD/OI values. PUMP (ID 2047) retains only partial cancellation-time fields (two false CVD flags and OI changes); that snapshot is at cancellation, not at 72 hours, and is insufficient to reconstruct the full smart-cancel decision. For the 72-hour normal max-age branch, the OI/CVD/NetChange/market gate snapshot remains unavailable; no gate is presumed to pass.

## Coverage and uncertainty

- The production fixture contains **10 complete 288-candle 15-minute trajectories** and **3 partial trajectories** (120, 48, and 48 stored candles). Public BingX 15-minute swap candles extend the path from original entry toward `min(entry + 120h, production as-of)`.
- **9/13** have continuous full five-day price coverage. FLOW (ID 1949) has 107.1 hours through the as-of cutoff; the three newer rows have the shorter horizons above. No source gaps were found in the prepared paths.
- Public BingX one-minute windows refine each entry and cancellation interval; the corresponding 15-minute bars are replaced, not double-counted. The source fixture records endpoints, time bounds, statuses, and counts. Fetches were serial and rate-limited.
- OHLC does not reveal high/low ordering, intrabar execution, slippage, stop gaps, or actual fills. The replay checks already-armed stops before raising them and records feasible same-candle paths. In particular, core-close transition candles are checked for a runner floor crossing: the high-first branch checks the candle low; the low-first branch seeds the post-core runner peak and checks the later close. Where a raised core stop and an existing stop can both be hit, both outcomes are retained. The two completed runner rows have no transition-candle floor touch or unresolved remainder under those bounds. Lifetime settlement marks use the last fully observed price mark at the entry-anchored timer together with the canonical protected-floor rule.
- The source horizon is **entry-anchored**, not “72 hours after cancellation.” Later highs are not treated as exits. Fees, funding, live exchange executions, and any realized partial-size accounting are not inferred from these candles.

## Reproduction

```sh
node scripts/ict-audit/ib-cancel-runner-replay.mjs
node --test scripts/ict-audit/ib-cancel-runner-replay.test.mjs
```

Artifacts:

- `scripts/ict-audit/ib-cancel-runner-replay.mjs` — deterministic replay/export script
- `scripts/ict-audit/ib-cancel-runner-replay.test.mjs` — focused protection, runner timing, timer, ambiguity, and original-entry-basis tests
- `.local/reports/impulse-buy-cancel-runner-replay-data.json` — bounded production/candle source bundle
- `.local/reports/impulse-buy-cancel-runner-replay-2026-10-01.json` and `.csv` — replay results
