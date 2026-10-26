# Impulse Buy production-volume audit — 2026-10-01

**Read-only production snapshot:** 2026-10-01 03:46:42.60018 UTC. Dubai calendar months (UTC+4). No application, database, or gate changes were made.

## Accounting and policy guardrails

- The raw September close-month ledger has **166 rows**. The UI-style view excludes only stop losses detected before `2026-09-11 14:50:31 UTC`, using immutable detection time; it does not remove other old outcomes. This is a display/statistics exclusion, not a change to the ledger.
- “Strict >10%” means realized `pnl_percent > 10`, not a status-based “non-stop” rate. Open positions are censored. Cancellations, B.U. stops, and expirations remain separately visible.
- For `impulse_runner_v1`, canonical `pnl_percent` is **pure runner return**, not an 80/20 weighted core/runner total. Core PnL is separate component telemetry and is not added to, averaged with, or used to alter canonical PnL/status. The breakeven emergency floor applies **only after core close**; it is not an initial whole-position stop. The documented 30-point runner trail arms after a +30% peak. See `.agents/memory/impulse-runner-exit-policy.md` and `artifacts/api-server/src/lib/impulse-runner-policy.ts`.
- Source verification: the closed-30m candle body must be ≥2%, candle-volume multiplier ≥1.5x, and close strength ≥0.65. Known funding below −0.1%, OI1h/OI4h above 20%, and spot-volume multiplier outside the inclusive [1x, 2x] range reject; those telemetry gates fail open when unavailable. CVD rejects only when all four timeframes are present and not all bullish; incomplete CVD fails open. See `scanner-patterns.ts:831–916` and `scanner.ts:6945–6960`.

## Dubai month comparison: no August baseline

| Dubai close month | Raw closed rows | Status mix: profit / stop / B.U. / expired / cancelled | Realized >10% | Raw PnL sum / mean | UI-style rows after old-stop exclusion |
|---|---:|---|---:|---:|---:|
| August 2026 | 0 | — | 0 | — | 0 |
| September 2026 | **166** | **26 / 26 / 62 / 4 / 48** | **13/166 (7.8%)** | **+187.07 / +1.13** | **151** |

The UI-style September subset removes **15 pre-cutoff stop losses** and leaves 11 stop losses; it leaves the 13 strict >10% rows unchanged, so the displayed rate becomes **13/151 (8.6%)**. That increase is a denominator effect, not evidence of improved trading. September entry-month has 171 rows (166 September closes, three September-open positions, and two reclassified legacy rows); one of the four currently open `single_entry_v1` positions was detected in October. August has no entry- or close-month rows, so this is **not a valid August-to-September performance comparison**.

## Detection cohort and policy strata

The stats-cohort boundary is detection time, not close time. There are 69 tracked rows detected on/after the cutoff, but these do not form one homogeneous policy cohort:

| Detection/policy stratum | Rows | Closed / open | Closed status mix | Strict realized >10% |
|---|---:|---:|---|---:|
| Legacy `policy_version` null, detected after cutoff | 3 | 3 / 0 | 2 B.U., 1 cancelled | 0 |
| `impulse_runner_v1`, `entry_policy_version` null | 18 | 18 / 0 | 3 profit, 3 stop, 4 B.U., 8 cancelled | 1 |
| `impulse_runner_v1` + `single_entry_v1` | 48 | 44 / 4 | 6 profit, 8 stop, 15 B.U., 2 expired, 13 cancelled | **6** raw tracker PnLs |

Across runner v1 since September 13 there are 66 positions: 62 closed and four active. The `single_entry_v1` 44 closed rows have raw `pnl_percent` mean **+2.079**, median **0.00**; the six strict >10% rows are **6/44 (13.6%)** of all closed rows, or **6/31 (19.4%)** of closed non-cancellations. Peak ≥10% was 12/31 closed non-cancellations (secondary, unrealized opportunity measure). The 15 B.U. exits and two expirations are not silently recoded as wins or losses; the four active rows remain censored.

One data-quality caveat for the strict count: `AERO-USDT` is an expired row with `pnl_percent=+20.665%`, but its runner state, runner exit price, and runner PnL are null. Keep it in the raw six-hit ledger count, but do not treat it as a verified runner settlement without reconciling that row. `PENGU-USDT`’s +23.267% expiration does have a recorded runner exit.

### BR outlier dependence

BR-USDT row 1688 has canonical pure-runner PnL **+144.10%** and peak about **+174.1%**. Its `core_pnl_percent` is +11.67% component telemetry only; it is not part of that +144.10% and must not be weighted into it. In the 18-row runner/entry-policy-null stratum, excluding this one row changes non-cancelled net from +112.71 over 10 outcomes to **−31.39 over nine**; it is that stratum’s sole strict >10% result. Across all runner-v1 non-cancelled closures, net +241.55 over 41 becomes **+97.45 over 40** without BR row 1688. The new single-entry stratum does not contain this positive BR outlier (its BR row is a separate stop loss).

## Decision-time evidence and missingness

For the 48 `single_entry_v1` fires, the immutable impulse decision payload has candle body, candle volume, close strength, and funding for 47/48; OI1h for 47/48; OI4h for 30/48; and the actual decision spot-volume multiplier for only **8/48**. The separate `entry_spot_vol_mult` tracker field is populated on 46/48, but is not a safe substitute for the decision payload when it is null: the scanner stores it through a separate resolver.

Other observed coverage: futures taker 47/48, spot taker 37/48, spot netflow 1h 46/48, and OB ratio 48/48. BTC 24h price regime is absent (0/48); BTC dominance is present for 47/48 but is not a BTC price-regime measure. Detection and confirmation lag are absent (0/48); prescan cycles are present for 23/48 only. Four-timeframe CVD is complete in 19/48 saved entry vectors, all-bullish in 14; five complete saved vectors are not all bullish despite being fired. CVD is not retained in the impulse decision JSON, so the tracker vector does not establish exact gate parity. These gaps prevent a defensible fire-time rule from BTC, CVD, detection lag, or prescan. Missing remains unknown/fail-open, not a market rejection.

## Fixed, univariate volume/candle checks — exploratory only

For chronological validation, the first 34 of 48 `single_entry_v1` detections are training; the last 14 are a holdout beginning 2026-09-26 11:06:57 UTC. Unknown metrics pass each test. Rates below use closed, non-cancelled outcomes; opens are censored.

| Fixed candidate | Coverage / rows removed | Strict >10% retained | Peak ≥10% retained | Holdout read |
|---|---|---:|---:|---|
| Candle-volume cap ≤2x | 47/48 measured; one unknown passes; blocks 23/48 | 5/6 (train 4/5; holdout 1/1) | 8/12 (holdout 1/2) | Keeps the one holdout strict result, but loses one holdout peak opportunity; removes four stop losses and eight B.U. exits overall. |
| Candle body ≥3% | 47/48 measured; blocks 17/48 | 5/6 (train 4/5; holdout 1/1) | 10/12 (holdout 1/2) | One of the six raw strict hits is an expired row; the holdout has only one strict hit. |
| Spot multiplier ≤1.5x | Exact decision value only 8/48; **40 missing pass**; blocks two measured rows | 5/6 (train 4/5; holdout 1/1) | 11/12 (holdout 2/2) | Too little measured decision-time volume to support a cap; one removed measured row is a strict winner. |
| OI4h ≤10% | 30/48 measured; blocks 16/48 | 3/6 | 7/12 | Rejects three strict hits, including the only holdout strict hit. |

Even the best observed simple split leaves far fewer than the stated >90% realized >10% objective, on only six raw strict hits. These are retrospective screens, not validated gates. No gate change is supported. Candle-volume capping is particularly non-robust: it sacrifices four of eight stop losses, but also eight of 15 B.U. exits, four of 12 peak≥10 opportunities, and one of six strict realized hits.

## Rejected-backfill readiness and decision

Fired snapshots: 150 complete 288-candle trajectories (93 symbols), 61 after the stats cutoff. Rejected snapshots: 12,662 complete (557 symbols; 12,506 have 288 candles and 156 have 287), including 10,693 after cutoff; another 2,929 are partial and 123,626 unavailable. A complete 288×15m trajectory is **72 hours**, not the older 6h default. Repeated symbol/scan-cycle rows are not independent trades. Frequent exact compound reject masks include body+volume+close+CVD (1,368 rows/344 symbols) and the same plus spot<1x (1,137/301); these are reason-mask counts, not isolated-gate samples. Rejected trajectories are not compatible fired-trade counterfactuals and are not used as such here.

**Conclusion:** preserve the current [1x,2x] spot-volume and complete-CVD contracts, keep unknowns fail-open, and make no live threshold changes. September’s apparent UI improvement is caused by the pre-cutoff stop exclusion; August provides no denominator. Runner outcomes must remain policy-stratified and use pure-runner canonical PnL. No result here supports a >90% realized >10% rate or a claim of overfit.