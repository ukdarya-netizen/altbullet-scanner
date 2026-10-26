# Impulse Buy indicator audit — 2026-10-01

## Executive finding

The matured tracked cohort does **not** meet the objective of realizing more
than 10% on over 90% of positions. Among 42 non-cancelled position-status
outcomes, 6 (14.3%) recorded `pnl_percent > 10`. The proper closed
`single_entry_v1` cohort is 44 entered outcomes, **including all 13 actual
entered cancellations**, with 6/44 (13.6%) over +10%; its four active rows
remain right-censored. Across the mature cohort, 10 actual entered
single-entry cancellations join the 42 non-cancelled outcomes, giving 6/52
(11.5%) on the confirmed entered-outcome denominator. Nine other mature
cancellations have unknown entry state; if all nine were also entered, the
pooled rate would be 6/61 (9.8%). A further 17/42 non-cancelled outcomes
reached a peak at or above +10%, but a peak is not a realized result: 21
ended `bu_stop`, including seven that peaked at +10% and fourteen that peaked
from +5% to below +10%.

No tested RSI, Williams %R, ADX, ATR, Bollinger, aVWAP, or candle rule is
supported as a new entry gate. RSI, Williams %R, and lower Bollinger
bandwidth reject every strict winner in the pooled matured cohort; the ATR
cut loses five of six. Their apparently attractive reductions also remove
most stops, but they remove more high-profit opportunities and are dominated
by reconstructed rather than decision-time-captured indicators. A 30m
ADX-at-least-30 split retains five of six winners in-sample, but is small,
era-confounded, and not a validated holdout. **Do not restore the removed
ADX-slope gate.**

The key interpretation is versioning: `impulse_runner_v1` is an exit/accounting
policy stamp, not an entry-filter version; `single_entry_v1` marks an entry
execution change, not a complete version of scanner gates. Scanner decision
rules changed during the observation window. The 15m/30m/1h/4h indicator
history is reconstructed through 2026-09-21, while captured snapshots begin
that day. All six matured >10% outcomes come from reconstructed rows; the
captured cohort has 18 entered outcomes including four cancellations, zero
>10% outcomes and two peak movers. Thus the pooled feature cuts are historical
descriptions, not decision-time evidence for the current gate set.

## Scope, population, and outcome definitions

- Read-only production review; no trading, production writes, secrets, or
  database/schema changes.
- Audit start: **2026-09-11 14:50:31 UTC**. The complete tracked-signal ledger
  contains 188 rows across history (63 `bu_stop`, 55 `cancelled`, 32
  `stop_loss`, 28 `profit`, 4 `expired`, 4 `active`, 2 `reclassified`).
  Of these, 119 predate the requested start and 69 are on/after it. The main
  outcome cohort retains every row in its stated date range; it does not
  selectively remove old stops or other unfavorable statuses.
- The 69 on/after-start rows all have source-signal lineage. Separately, 259
  of 447 Impulse Buy source signals have no tracker row, including 137 after
  the start date; none of those post-start source-only rows is marked queued.
  These are unknown delivery/outcome cases, not wins, losses, or rejected
  trades, and are not in the tracked-position denominator.
- To avoid treating very recent positions as mature, the analysis cohort is
  `detected_at < 2026-09-28 00:00:00 UTC` (a conservative 72-hour age cutoff
  relative to the audit date). It contains **61 rows**: 21 `bu_stop`, 11
  `stop_loss`, 19 `cancelled`, 8 `profit`, and 2 `expired`; no active rows.
  The eight later rows are reported separately: four remain active, three
  were cancelled, and one (ARK-USDT) has tracker PnL +20.33%. These are
  outside the mature comparison; the four active positions are right-censored.
- The non-cancelled position-status outcomes are `bu_stop`, `stop_loss`,
  `profit`, or `expired`: 42 total (21 B.U., 11 stops, 8 profit-status
  outcomes, 2 expired). This status subtotal is not the quality denominator
  when an entry cancellation is known to have occurred. The mature
  single-entry subset has 10 confirmed entered cancellations in addition to
  its 30 non-cancelled outcomes. Nine other cancellations in the mature
  cohort have unknown entry state, so they are reported separately rather
  than silently classified as pre-entry or dropped.
- Strict realized success is the persisted `pnl_percent > 10` (not `>=10`).
  PnL on `bu_stop` rows is left as persisted; no B.U. PnL is forced to zero.
  Peak opportunity is separately calculated as
  `(peak_price / original_entry_price - 1) * 100 >= 10` when the original
  entry is present. B.U. +5…<10 counts use the same peak basis.
- The six strict winners are PTB (+34.35%), ONE (+60.87%), AERO (+20.67%,
  expired), BR (+144.10%), UNI (+23.30%), and PENGU (+23.27%, expired).
  They are six distinct symbols. There are 37 symbols among 42 completed
  positions; no symbol has more than two completed positions. BR is a large
  PnL outlier, so no average-return claim is used.
- Four strict winners have status `profit` and two have status `expired`;
  the expired rows are kept visible rather than recoded. These are
  tracker-reported outcomes, not an exchange-fill/backtest with fee,
  slippage, or executable entry assumptions.

## Policy and chronology stratification

The stamps have different meanings and must not be conflated:

| Mature rows | Non-cancelled outcome statuses | PnL >10 | Peak ≥10 | B.U. | Stops | Cancelled |
|---|---:|---:|---:|---:|---:|---:|
| All 61 rows | 42 | 6 | 17 | 21 | 11 | 19 |
| `policy_version=impulse_runner_v1` (exit accounting) | 58 | 6 | 16 | 19 | 11 | 18 |
| Of those, `entry_policy_version=single_entry_v1` | 40 | 5 | 11 | 15 | 8 | 10 |
| Runner-accounted, no `single_entry_v1` stamp | 18 | 1 | 5 | 4 | 3 | 8 |
| No runner-policy stamp | 3 | 0 | 1 | 2 | 0 | 1 |

The runner stamp first appears on 2026-09-13. In the current source,
`impulse_runner_v1` governs exit accounting (canonical pure-runner PnL,
not 80/20 weighted portfolio PnL; runner trailing activation at +30% with a 30-point gap, and a five-day
maximum age); it does not identify which entry gates fired. `single_entry_v1`
first appears on 2026-09-17 and identifies the full, single-entry execution
model rather than the earlier split-entry approach. Its 40 matured rows have
5/40 >10% outcomes (12.5%) and 11/40 peaks ≥10% (27.5%), with all 10
confirmed entered cancellations included in those denominators. These groups
are nested, not additive.

The latest eight rows (2026-09-28 onward) are all runner-stamped and
`single_entry_v1`: 62 of the 66 runner-stamped rows since the audit start are
closed and four are still active. Across the full `single_entry_v1` cohort,
44 completed entries include 13 actual entered cancellations and six
strict >10% outcomes (13.6%). Of the eight newer rows, ARK is the one closed
>10% result; the other three closed rows were cancelled and are included in
the 13. The four active rows are right-censored.

`impulse_decision_metrics` snapshots first appear on 2026-09-14; they exist on
14/18 runner-stamped rows without `single_entry_v1` and 40/40 single-entry
rows, but on none of the three unstamped rows. The 40 mature single-entry
snapshots contain the three baseline 30m candle components as true on 39
rows. Their entry-metric columns show four-timeframe CVD complete on 13/40
(9 all bullish, 4 with at least one false; 27 have at least one missing
timeframe). Spot-volume multiplier is present on 39/40 (3 below 1x, 19 from
1–2x, 17 above 2x). These are useful immutable feature snapshots, but the
database does not attach an explicit scanner-gate version or the exact
evaluated gate result to each row; do not infer that every signal was fired
under the latest rule set from `single_entry_v1` alone.

The current scanner helper in the workspace is materially more specific than
the earliest rows: it rejects a known spot-volume multiplier below 1x or
above 2x and, when all four CVD timeframes are populated, requires all four
to be bullish. Missing spot/CVD remains fail-open in that helper. The recent
immutable snapshots and this rule cannot be projected backward to
2026-09-11. A gate-version stamp plus a matched decision-time fired/rejected
cohort is needed before evaluating the later rule as a policy.

## Outcomes by source and holdout

### Captured versus reconstructed

Only the per-timeframe JSON snapshots were used; the legacy scalar value is
the 1h compatibility view and was not substituted for other timeframes.
Closed candles were checked against `candleCloseAt <= detected_at`; no
future-close timestamps were found in the valid snapshots.

| Timeframe | Captured, valid | Reconstructed, valid | Unavailable |
|---|---:|---:|---:|
| 15m | 18 | 39 | 4 |
| 30m | 18 | 40 | 3 |
| 1h | 18 | 40 | 3 |
| 4h | 19 | 42 | 0 |

All four timeframe snapshots are valid on 57 rows: 18 are fully captured and
39 fully reconstructed; four additional rows lack valid 15m telemetry.
Captured 15m rows run from 2026-09-21 14:36 through 2026-09-27 23:06 UTC;
reconstructed rows run from 2026-09-11 through 2026-09-21 06:05 UTC. This is
a clean source-era boundary that overlaps both policy and calendar changes.

| 15m source cohort | Rows | Non-cancelled outcomes | Known entered cancels* | PnL >10 | Peak ≥10 | B.U. | Stops |
|---|---:|---:|---:|---:|---:|---:|---:|
| Captured at decision time | 18 | 14 | 4 | 0 | 2 | 8 | 5 |
| Reconstructed after entry | 39 | 26 | 5 | 6 | 15 | 11 | 6 |
| Unavailable (fail open) | 4 | 2 | 1 | 0 | 0 | 2 | 0 |

*The 10 known entered cancellations are the mature `single_entry_v1`
cancellations (4 captured, 5 reconstructed, 1 unavailable). The other nine
mature cancelled rows are legacy/unstamped with entry state unknown. Their
saved PnL is not overwritten or imputed.

All six strict winners are in the reconstructed rows. Within the
single-entry subset specifically, the 20 reconstructed rows have 15
non-cancelled outcomes plus five confirmed entered cancellations and all five
strict winners; the 18 captured rows have 14 non-cancelled outcomes plus
four confirmed entered cancellations, no strict winner, and two peak movers;
two further rows have unavailable 15m telemetry. This is a provenance/era
confound, not evidence that reconstructed values were known at fire time or
that a filter would have been executable.
Reconstructed history is observational only; missing values are fail-open.

### Chronological splits

The exploratory median split of all 61 mature rows is
**2026-09-18 10:20:54 UTC**:

| Period | Rows | Positions | PnL >10 | Peak ≥10 | B.U. | Stops | Cancelled |
|---|---:|---:|---:|---:|---:|---:|---:|
| Before split | 30 | 18 | 3 | 9 | 9 | 4 | 12 |
| At/after split | 31 | 24 | 3 | 8 | 12 | 7 | 7 |

This looks balanced only in the pooled row counts. The earlier side has no
captured snapshots; the later side has 18 captured, 11 reconstructed, and
two unavailable rows. All three later strict winners are still from the
reconstructed era, before captured 15m history began. The 50/50 split is not
an independent forward validation.

Within `single_entry_v1`, the median split is
**2026-09-20 23:35:33 UTC**:

| Period | Rows | 15m provenance | Non-cancelled outcomes | Entered cancellations | PnL >10 | Peak ≥10 | B.U. | Stops |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| Before split | 20 | 19 reconstructed, 1 unavailable | 14 | 6 | 5 | 9 | 5 | 3 |
| At/after split | 20 | 18 captured, 1 reconstructed, 1 unavailable | 16 | 4 | 0 | 2 | 10 | 5 |

The quality denominator is all 20 entered outcomes per half, including the
six and four cancellations respectively. This is a cautionary holdout, not
proof of deterioration: the later half is mostly captured and too small for a
stable rate estimate, but it contains no mature >10% winner. RSI, Williams
%R, and the lower-Bollinger cut remove all five early strict winners; the ATR
cut removes four. In the later half there are no strict winners to retain,
and close-location ≥60 removes none of its rows. None shows a useful, stable
gain in both periods.

## Interpretable indicator cuts

Each rule below was tested as a **single univariate observational cut**, with
unknown values left in the retained set. The table reports whole-cohort
effects; the captured/reconstructed effects are separated immediately below.
`B.U. +5…<10` means a `bu_stop` whose recorded peak was in that band, not a
realized gain.

| Keep rule | Rows suppressed (of 61) | Missing fail-open | Strict >10 winners suppressed (of 6) | Peak ≥10 suppressed (of 17) | B.U. +5…<10 suppressed (of 14) | Stops suppressed (of 11) |
|---|---:|---:|---:|---:|---:|---:|
| 15m RSI(5) ≤70 | 52 | 4 | 6 | 16 | 10 | 10 |
| 15m Williams %R(21) ≤−20 | 49 | 4 | 6 | 15 | 11 | 9 |
| 15m Bollinger bandwidth percentile ≤50 | 53 | 4 | 6 | 16 | 11 | 10 |
| 15m ATR percentile ≤75 | 45 | 4 | 5 | 14 | 10 | 9 |
| 30m ADX(14) ≥30 | 29 | 3 | 1 | 7 | 6 | 6 |
| 15m candle close location ≥60 | 3 | 4 | 0 | 2 | 0 | 0 |

The indicator-source breakdown makes the apparent pooled effects especially
unsafe. In the captured subset (18 rows, 14 positions, no strict winners,
two peak movers), RSI removes 15 rows/12 positions and both peak movers;
Williams removes 15/12 and one peak mover; Bollinger removes 17/13 and both
peak movers; ATR removes 15/12 and one peak mover; close-location ≥60 removes
none. In the reconstructed subset (39 rows, 26 positions, all six strict
winners and 15 peak movers), RSI suppresses 37 rows and all six winners;
Williams 34 and all six; Bollinger 36 and all six; ATR 30 and five winners;
close-location ≥60 suppresses three rows and two peak movers. The four
unavailable rows remain fail-open. No indicator cut can be validated on the
captured cohort because it contains no realized >10% winner.

### RSI, Williams %R, ATR, Bollinger

- The 15m RSI ≤70 cut leaves only five observed values plus four unknowns;
  it removes all six strict winners and 16/17 peak movers while also removing
  10/11 stops. That is not a favorable trade-off under the strict >10%
  objective.
- The Williams %R ≤−20 cut removes six strict winners and 15/17 peak movers,
  while also removing 9/11 stops. It does not pass either chronological test.
- The ≤50 Bollinger-bandwidth-rank cut removes six strict winners and 16/17
  peak movers. This is a bandwidth-percentile test, not a like-for-like
  replication of the prior lower-half Bollinger-expansion observation. On
  this distinct metric the cut is a strong anti-filter, not a candidate to
  restore.
- ATR percentile ≤75 removes five strict winners, 14/17 peaks, 16/21 B.U.s,
  and 9/11 stops. Its apparent retained strict-winner count falls from 3/3
  in the early pooled split to 0/3 in the later split.
- In the underlying 15m ATR percentile bins, ≤50 contains 6 rows/4 positions
  and no strict winner; 50–75 contains 6 rows/3 positions and one winner;
  >75 contains 45 rows/33 positions and five winners. Missing values are
  excluded from these bins and fail open in the cut.

The Bollinger/ATR fields are named `*Percentile60d`, but the current telemetry
implementation ranks the most recent 1,440 valid observations at every
timeframe. That is roughly 15 days on 15m, 30 days on 30m, and 60 days on 1h;
4h is limited by the 60-day candle history. Interpret same-named percentile
values as timeframe-specific windows, not a uniform 60-day lookback.

### ADX

On 30m ADX(14), the observed bins are: below 20 — 9 rows, 4 positions,
0 strict winners/2 peak movers; 20–<30 — 20 rows, 15 positions, 1/6 strict
winners and 5/17 peaks; ≥30 — 29 rows, 21 positions, 5/6 winners and 10/17
peaks. Three rows have no usable ADX. The ≥30 cut is therefore a small
in-sample split, loses a strict winner and seven peak opportunities, and has
not demonstrated later captured-cohort value.

The 30m three-bar ADX-slope split has 19 rows at slope ≤0 (12 positions,
2 strict winners, 6 peak movers) and 39 at slope >0 (28 positions, 4 strict
winners, 11 peak movers), with three missing values. Reinstating a
non-positive-slope rejection would have suppressed two of the six realized
winners and six of the 17 peak movers in this cohort, in addition to the
known missed-move evidence behind its removal. It must remain observational;
this audit does not support restoring it.

### aVWAP

Historical aVWAP was unavailable for reconstructed rows because the exact
anchor was not persisted. Only 18 captured rows have valid 15m aVWAP; all
18 are above it (0 below). Their close-to-aVWAP distance is +0.38% to
+11.30% (median +1.78%), or 0.39–4.80 ATR (median 1.35 ATR). Nine are
0–<2% above (6 positions, no strict winner/peak mover); nine are ≥2% above
(8 positions, no strict winner, two peak movers). A reclaim is true on one
row, FLOW-USDT, which was cancelled; it is false on 17, and unavailable on
43 of the 61 rows. “Above VWAP” has no observed discrimination and cannot
be used as a gate from this evidence.

### Candle structure

15m candle direction is bullish on 54/57 valid rows (including all six
strict winners and 15/17 peak movers), doji on two rows (both peak ≥10%),
and bearish on one cancelled row. Close location is ≥60 on 54 rows; the
three rows below 60 include two peak movers but no strict winner, and no
stop. That cut removes only two completed outcomes overall and removes no
rows in the later single-entry half.

Body-percent-of-range bins are not monotonic: <25% contains 5 rows, 3
positions, 1 strict winner/3 peak movers; 25–<50% contains 14 rows,
13 positions, 1/5; 50–<75% contains 15 rows, 11 positions, 1/2; ≥75%
contains 23 rows, 13 positions, 3/7. Rare `inside_bar` (5), `outside_bar`
(3), `hammer` (3), and `doji` (2) labels are too sparse and may overlap.
There is no stable structural threshold here.

This 15m candle-analysis telemetry is distinct from the scanner's separate
closed-30m candle impulse/volume/close-strength decision components. Do not
interpret the descriptive 15m candle bins as a replay of the 30m entry gate.

## Conclusions and next evidence

1. The tracked cohort’s strict realized >10% rate is far from the stated
   >90% goal, even before any candidate filter. Keep realized PnL and peak
   opportunity separate; B.U. peaks do not count as wins.
2. No tested indicator threshold is a deployable entry gate. RSI/Williams/
   Bollinger suppress all six strict winners; ATR suppresses five; ADX ≥30
   lacks a sufficiently large forward holdout; close-location is too weak
   to remove meaningful losses; aVWAP is missing/one-sided.
3. Do not restore the removed ADX-slope gate based on this audit.
4. Maintain the source/version separation. `impulse_runner_v1` is exit
   accounting; `single_entry_v1` is entry execution; neither alone identifies
   the scanner-gate revision. Current spot/CVD checks are later policy and
   must not be backdated to September 11. Record an immutable entry-gate
   version and exact pass/reject/missing reasons in future decision-time
   snapshots, including rejected opportunities.
5. Continue indicators as telemetry only. Revisit a pre-fixed candidate only
   on a genuinely new, mature, decision-time-captured cohort with enough
   >10% winners to test retention, a separate later holdout, source and
   policy parity, and review of strong rejected opportunities and actual
   entry/exit assumptions.