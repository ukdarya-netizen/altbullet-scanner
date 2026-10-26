# PLM indicator audit — 2026-10-01

## Executive finding

**Current primary endpoint: fixed 72-hour forward peak.** For the current 21-row single-entry cohort, 15 paths are complete, 9 record a +10% or greater fixed72h peak, 6 paths are partial/censored, and there is 1 exact stop_loss. The six previously counted tracker-peak winners are a subset of those nine forward winners; three additional rows qualify only under the fixed72h endpoint. Do not use the prior current tracker-peak count of six as the main current quality denominator.

The table below reapplies the same existing 36 indicator cuts to the current cohort by joining metric rows to the fixed72h outcomes by tracker id. It reports strong forward peaks retained/lost, the exact stop removed, partial paths removed, and decision-time captured-source retention. No cut is being retuned or recommended.

The broader 168-row cohort still has 60 tracker peaks >=10%, 33 exact stops, 68 bu_stop outcomes, 14 expired outcomes and 5 cancellations. Those 60 peaks belong to the separate tracker-through-closure endpoint; they are retained in a clearly labeled historical cross-tab below and are not pooled with current fixed72h results.

No scanner, gate, database, workflow, market-data query, or deployment changes were made. The current forward join is purely offline against the existing PLM volume-audit JSON.

## Cohort, endpoint, and version discipline

- Fixed cohort: .local/reports/plm-cohort-2026-10-01.csv. Cutoff: 2026-10-01T04:36:43.459443Z. Status, entry/peak prices, peak, PnL, cancellation reason, closure time and stop-loss percentage come only from that frozen CSV; the live database was queried only for indicator evidence and stamps.
- Reference price is positive original_entry_price, falling back to entry_price only when the original is absent/nonpositive. Peak percent is (peak_price / reference_entry_price - 1) × 100; strong peak is >=10%. No split/average price substitutes for original entry.
- Current primary endpoint is fixed 72h forward high from the volume-audit JSON, over [decision_at, decision_at + 72 hours), including post-exit candles. Current cohort: 15 complete, 9 strong, 6 partial/censored. Unreached +10% in a partial path is unknown, not a final failure.
- Stop-loss counts are exact frozen status=stop_loss, not inferred from PnL. B.U. counts use status=bu_stop. All five cancellations remain in the cohort; none is dropped or converted to a win/loss.
- Separate historical tracker endpoint: legacy 147/147 closed with 54 tracker peaks >=10%, 32 stops, 60 B.U. and 5 cancellations; single_entry_v1 has 21 rows with 15 closed + 6 active, 6 tracker peaks >=10%, 1 stop and 8 B.U. These tracker counts are not fixed72h outcomes. single_entry_v1 is an entry-execution stamp, not a PLM scanner-gate revision; gate versions are unstamped.
- Current PLM scanner contract remains the documented 24h/3h price-momentum, spot-volume, netflow and CVD logic; this indicator-only report makes no changes to those rules.

## Provenance, timestamp validity, and missingness

Indicators were read per row from entry_indicator_telemetry for 15m, 30m, 1h and 4h. A value is eligible only when it is present and its stored candleCloseAt is <= detected_at. Missing/invalid telemetry is unknown and retained fail-open, never replaced with zero. A historical reconstructed candle may be closed before entry but is not evidence it was available at decision time.

| TF | Closed-bar-valid values / 168 | Captured | Reconstructed | Unavailable | Future close rows excluded | Candle age (minutes) | Captured checkedAt minus detect (minutes) |
|---|---:|---:|---:|---:|---:|---|---|
| 15m | 153/168 | 15 | 138 | 15 | 0 | 3.425 [0.516–14.783], n=153 | 0.053 [0.042–0.059], n=11 |
| 30m | 157/168 | 15 | 142 | 11 | 0 | 4.095 [0.516–29.783], n=157 | 0.032 [0.022–0.043], n=11 |
| 1h | 160/168 | 15 | 145 | 8 | 0 | 32.172 [0.516–53.459], n=160 | 0.017 [0.013–0.022], n=11 |
| 4h | 166/168 | 15 | 151 | 2 | 0 | 96.908 [2.434–216.863], n=166 | 0.01 [0.008–0.011], n=11 |

Coverage is 153/168 at 15m (15 unavailable), 157/168 at 30m (11 unavailable), 160/168 at 1h (8 unavailable), and 166/168 at 4h (2 unavailable). RSI5, Williams %R, ADX, ATR rank, Bollinger rank and candle fields are populated for each valid closed snapshot. Anchored-VWAP distances exist only for 16/168 at 15m, 30m and 1h, and 15/168 at 4h, because historical reconstructed rows mostly lack the precise anchor.

Source counts split by exact tracker outcome status are in plm-indicator-coverage-2026-10-01.csv. The 147 legacy rows are reconstructed/unavailable, not decision-time captures. All 21 current single-entry rows have a closed-bar value, but 6 are reconstructed. Captured source coverage remains 15/21 across all four timeframes: 9 captured rows have complete fixed72h paths (4 strong), 6 captured rows are partial; the 6 reconstructed rows are complete (5 strong). The original captured cohort spans 2026-09-21T11:04:32.535Z through 2026-10-01T01:06:33.755Z. The old tracker endpoint counted only 3 captured tracker-strong rows; the primary fixed72h endpoint counts 4 captured strong rows.

The code stores checkedAt only on some telemetry. For captured entries it is present on 11/15 rows; when present it is within seconds of detected_at. Missing checkedAt stays unknown, and reconstructed rows are not assigned a fabricated freshness timestamp. Candle ages use only closed bars at or before detection.

## Stored indicator distributions — descriptive, not candidate tuning

Values are median [minimum–maximum], with n valid snapshots; distribution summaries pool legacy reconstructed and captured rows, so they are descriptive only. RSI(14) is not in the per-timeframe telemetry. Schema entry_rsi_1h is documented as CoinGlass RSI 1h, not RSI(14), and is not substituted.

### Momentum / trend strength

| TF | RSI5 | Williams %R21 | Williams EMA13 | ADX14 | +DI / −DI | ADX slope3 |
|---|---|---|---|---|---|---|
| 15m | 71.528 [36.057–97.863], n=153 | -14.793 [-78.346–0], n=153 | -25.033 [-81.763–-6.633], n=153 | 35.32 [9.712–67.268], n=153 | 32.294 [13.645–48.582], n=153 / 11.714 [2.816–27.933], n=153 | 2.441 [-4.514–10.961], n=153 |
| 30m | 77.967 [38.493–97.425], n=157 | -13.556 [-79.365–0], n=157 | -25.249 [-82.66–-6.905], n=157 | 35.429 [10.253–64.258], n=157 | 34.623 [16.781–53.762], n=157 / 10.998 [1.47–25.688], n=157 | 2.573 [-6.648–9.858], n=157 |
| 1h | 79.193 [34.886–98.938], n=160 | -11.983 [-83.384–0], n=160 | -25.069 [-84.934–-9.129], n=160 | 35.117 [11.345–60.375], n=160 | 34.617 [18.319–58.005], n=160 / 10.41 [1.85–35.844], n=160 | 2.999 [-9.185–10.569], n=160 |
| 4h | 78.285 [18.414–96.237], n=166 | -17.329 [-94.954–0], n=166 | -39.682 [-87.515–-13.773], n=166 | 27.612 [9.274–65.401], n=166 | 31.092 [10.126–52.383], n=166 / 12.874 [3.406–32.332], n=166 | 2.374 [-8.931–10.537], n=166 |

### Volatility / bands

| TF | ATR14 % | ATR percentile | ATR change3 (raw price units) | BB bandwidth | BB percentile | BB expansion3 | BB position |
|---|---|---|---|---|---|---|---|
| 15m | 1.439 [0.506–5.065], n=153 | 93.264 [21.528–100], n=153 | 0 [-0.169–3.472], n=153 | 0.074 [0.023–0.41], n=153 | 91.875 [22.292–100], n=153 | 0.007 [-0.078–0.105], n=153 | 0.81 [-0.368–1.922], n=153 |
| 30m | 1.821 [0.711–9.434], n=157 | 94.097 [12.708–100], n=157 | 0 [-0.162–16.345], n=157 | 0.098 [0.023–0.506], n=157 | 91.389 [10.069–100], n=157 | 0.012 [-0.066–0.213], n=157 | 0.911 [-0.643–2.037], n=157 |
| 1h | 2.243 [0.977–11.319], n=160 | 93.611 [8.333–100], n=160 | 0 [-0.494–9.453], n=160 | 0.13 [0.032–0.56], n=160 | 91.944 [6.944–100], n=160 | 0.017 [-0.157–0.177], n=160 | 0.952 [-0.858–1.961], n=160 |
| 4h | 3.905 [1.606–20.984], n=166 | 87.218 [1.613–100], n=166 | 0 [-0.05–8.297], n=166 | 0.168 [0.045–2.769], n=166 | 82.316 [6.616–100], n=166 | 0.019 [-0.317–0.41], n=166 | 0.967 [-0.857–2.012], n=166 |

### Candle structure / aVWAP

| TF | Close location % | Body % of range | Upper wick % | Range / ATR | Bull / bear / doji | VWAP distance ATR | VWAP distance % | Above / reclaim |
|---|---|---|---|---|---|---|---|---|
| 15m | 65.846 [0–100], n=153 | 54.545 [0–97.143], n=153 | 19.101 [0–93.578], n=153 | 1.193 [0.404–3.571], n=153 | 92 / 45 / 16 | 0.233 [-0.811–2.515], n=16 | 0.308 [-1.047–1.403], n=16 | above 10/16; reclaim 1/16 |
| 30m | 65.182 [2.182–100], n=157 | 42.857 [0–100], n=157 | 23.81 [0–85.714], n=157 | 1.349 [0.37–3.262], n=157 | 101 / 45 / 11 | 0.431 [-0.341–1.901], n=16 | 0.814 [-0.825–3.586], n=16 | above 15/16; reclaim 1/16 |
| 1h | 73.644 [1.98–100], n=160 | 53.307 [3.053–94.882], n=160 | 23.393 [0–85.714], n=160 | 1.425 [0.343–5.081], n=160 | 130 / 25 / 5 | 0.908 [0.192–2.592], n=16 | 1.598 [0.472–4.186], n=16 | above 16/16; reclaim 0/16 |
| 4h | 72.332 [0–100], n=166 | 54.296 [0–96.279], n=166 | 19.873 [0–78.571], n=166 | 1.371 [0.233–5.426], n=166 | 114 / 36 / 16 | 1.48 [-0.203–1.885], n=15 | 4.789 [-0.996–8.075], n=15 | above 13/15; reclaim 1/15 |

Candle telemetry also stores lower wick and pattern labels. rangeAtr is available but there is no explicit burst field. Body is the fraction of candle range, not a PLM entry-time body-return signal; no stored PLM scanner timeframe/gate supports a body >=3 rule, so none is tested. No 2D structural composite was tested because no pre-defined normalized composite contract exists. ATR-change3 and Bollinger-expansion3 are absolute changes, not scale-normalized cross-symbol returns. Percentile fields named “60d” rank up to 1,440 valid observations: roughly 15 days at 15m, 30 days at 30m, 60 days at 1h, while 4h is capped by the fetched 60-day history. They are not uniform 60-calendar-day percentiles.

## Primary current indicator cut: fixed 72-hour forward peak

**For the current 21-row cohort, the primary endpoint is the volume-audit fixed 72h forward high**, not the tracker peak at closure. The endpoint is the high in [decision_at, decision_at + 72 hours), with post-exit candles included, measured from the frozen original/reference entry price. The offline outcome join is by tracker id to .local/reports/plm-volume-audit-2026-10-01.json; no market or database queries were added.

The current 21 rows contain **15 complete 72h paths, 9 observed >=10% forward peaks, 6 incomplete/partial paths, and 1 exact stop_loss**. The six partial paths are right-censored, not failures; they comprise closed ARX with 144 15m candles plus five active rows with 72, 48, 24, 24 and 0 candles. None has an observed +10% yet, but their unobserved future must not be treated as final. The six tracker-peak >=10% entries previously reported are all contained in the nine fixed-72h winners; the fixed endpoint adds three more strong rows (IDs 1722 ORDI, 1725 ATH, 1975 NMR). The tracker-peak six are no longer the primary current quality denominator.

Indicator-source coverage is unchanged: 15/21 rows have captured telemetry across all four timeframes, and 6/21 are reconstructed. Within the 15 captured rows, 9 have complete 72h paths (4 strong) and 6 are partial; the 6 reconstructed rows are all complete (5 strong). The exact stop is within the captured group. The table also shows captured-source cut retention so the reconstructed/captured split remains visible. Candidate metrics and thresholds are the existing 36 fixed cuts; unknown values remain retained, and no threshold was retuned.

| TF | Existing candidate cut | Classification | Measured / unknown | Excluded / kept (21) | Complete 72h kept / 15 | Forward >=10% kept / 9 (removed) | Exact stop removed / 1 | Partial paths removed / 6 | Captured measured / unknown; kept / 15 |
|---|---|---|---:|---:|---:|---|---:|---:|---|
| 15m | RSI5 <=70 | pre-specified | 21/0 | 8/13 | 8/15 | 5/9 (4 removed) | 1/1 | 1/6 | 15/0; 10/15 |
| 15m | Williams %R(21) <=-20 | pre-specified | 21/0 | 9/12 | 7/15 | 5/9 (4 removed) | 1/1 | 1/6 | 15/0; 9/15 |
| 15m | ADX14 >=20 | pre-specified | 21/0 | 2/19 | 13/15 | 7/9 (2 removed) | 0/1 | 0/6 | 15/0; 14/15 |
| 15m | ADX14 >=30 | pre-specified | 21/0 | 8/13 | 9/15 | 4/9 (5 removed) | 0/1 | 2/6 | 15/0; 9/15 |
| 15m | ATR percentile <=75 | pre-specified | 21/0 | 17/4 | 3/15 | 2/9 (7 removed) | 1/1 | 5/6 | 15/0; 4/15 |
| 15m | BB bandwidth percentile <=50 | pre-specified | 21/0 | 20/1 | 1/15 | 1/9 (8 removed) | 1/1 | 6/6 | 15/0; 0/15 |
| 15m | Candle close location >=60 | pre-specified | 21/0 | 14/7 | 6/15 | 3/9 (6 removed) | 0/1 | 5/6 | 15/0; 4/15 |
| 15m | abs aVWAP distance <=2 ATR | exploratory | 16/5 | 1/20 | 14/15 | 9/9 (0 removed) | 0/1 | 0/6 | 15/0; 15/15 |
| 15m | abs aVWAP distance <=2% | exploratory | 16/5 | 0/21 | 15/15 | 9/9 (0 removed) | 0/1 | 0/6 | 15/0; 15/15 |
| 30m | RSI5 <=70 | pre-specified | 21/0 | 10/11 | 6/15 | 4/9 (5 removed) | 1/1 | 1/6 | 15/0; 10/15 |
| 30m | Williams %R(21) <=-20 | pre-specified | 21/0 | 11/10 | 6/15 | 4/9 (5 removed) | 1/1 | 2/6 | 15/0; 8/15 |
| 30m | ADX14 >=20 | pre-specified | 21/0 | 3/18 | 13/15 | 7/9 (2 removed) | 0/1 | 1/6 | 15/0; 12/15 |
| 30m | ADX14 >=30 | pre-specified | 21/0 | 6/15 | 10/15 | 5/9 (4 removed) | 0/1 | 1/6 | 15/0; 10/15 |
| 30m | ATR percentile <=75 | pre-specified | 21/0 | 16/5 | 5/15 | 3/9 (6 removed) | 1/1 | 6/6 | 15/0; 2/15 |
| 30m | BB bandwidth percentile <=50 | pre-specified | 21/0 | 17/4 | 4/15 | 4/9 (5 removed) | 1/1 | 6/6 | 15/0; 2/15 |
| 30m | Candle close location >=60 | pre-specified | 21/0 | 12/9 | 8/15 | 5/9 (4 removed) | 0/1 | 5/6 | 15/0; 5/15 |
| 30m | abs aVWAP distance <=2 ATR | exploratory | 16/5 | 0/21 | 15/15 | 9/9 (0 removed) | 0/1 | 0/6 | 15/0; 15/15 |
| 30m | abs aVWAP distance <=2% | exploratory | 16/5 | 1/20 | 15/15 | 9/9 (0 removed) | 0/1 | 1/6 | 15/0; 14/15 |
| 1h | RSI5 <=70 | pre-specified | 21/0 | 16/5 | 2/15 | 1/9 (8 removed) | 1/1 | 3/6 | 15/0; 4/15 |
| 1h | Williams %R(21) <=-20 | pre-specified | 21/0 | 16/5 | 3/15 | 3/9 (6 removed) | 1/1 | 4/6 | 15/0; 5/15 |
| 1h | ADX14 >=20 | pre-specified | 21/0 | 1/20 | 14/15 | 8/9 (1 removed) | 0/1 | 0/6 | 15/0; 14/15 |
| 1h | ADX14 >=30 | pre-specified | 21/0 | 7/14 | 9/15 | 4/9 (5 removed) | 0/1 | 1/6 | 15/0; 9/15 |
| 1h | ATR percentile <=75 | pre-specified | 21/0 | 15/6 | 4/15 | 2/9 (7 removed) | 1/1 | 4/6 | 15/0; 4/15 |
| 1h | BB bandwidth percentile <=50 | pre-specified | 21/0 | 18/3 | 3/15 | 2/9 (7 removed) | 1/1 | 6/6 | 15/0; 3/15 |
| 1h | Candle close location >=60 | pre-specified | 21/0 | 10/11 | 8/15 | 4/9 (5 removed) | 0/1 | 3/6 | 15/0; 8/15 |
| 1h | abs aVWAP distance <=2 ATR | exploratory | 16/5 | 1/20 | 14/15 | 9/9 (0 removed) | 1/1 | 0/6 | 15/0; 14/15 |
| 1h | abs aVWAP distance <=2% | exploratory | 16/5 | 6/15 | 11/15 | 8/9 (1 removed) | 1/1 | 2/6 | 15/0; 9/15 |
| 4h | RSI5 <=70 | pre-specified | 21/0 | 16/5 | 4/15 | 3/9 (6 removed) | 1/1 | 5/6 | 15/0; 5/15 |
| 4h | Williams %R(21) <=-20 | pre-specified | 21/0 | 14/7 | 5/15 | 4/9 (5 removed) | 1/1 | 4/6 | 15/0; 7/15 |
| 4h | ADX14 >=20 | pre-specified | 21/0 | 5/16 | 12/15 | 7/9 (2 removed) | 0/1 | 2/6 | 15/0; 11/15 |
| 4h | ADX14 >=30 | pre-specified | 21/0 | 14/7 | 6/15 | 3/9 (6 removed) | 0/1 | 5/6 | 15/0; 6/15 |
| 4h | ATR percentile <=75 | pre-specified | 21/0 | 13/8 | 5/15 | 3/9 (6 removed) | 1/1 | 3/6 | 15/0; 5/15 |
| 4h | BB bandwidth percentile <=50 | pre-specified | 21/0 | 16/5 | 4/15 | 2/9 (7 removed) | 1/1 | 5/6 | 15/0; 4/15 |
| 4h | Candle close location >=60 | pre-specified | 21/0 | 7/14 | 9/15 | 5/9 (4 removed) | 0/1 | 1/6 | 15/0; 10/15 |
| 4h | abs aVWAP distance <=2 ATR | exploratory | 15/6 | 0/21 | 15/15 | 9/9 (0 removed) | 0/1 | 0/6 | 15/0; 15/15 |
| 4h | abs aVWAP distance <=2% | exploratory | 15/6 | 9/12 | 11/15 | 9/9 (0 removed) | 1/1 | 5/6 | 15/0; 6/15 |

The retained/removed counts use exact existing rule operators from the prior 36-cut cross-tab. Any current metric that is absent/invalid is unknown and kept. The 15 captured source rows have measured values for each tested rule; the six reconstructed entries are included where their pre-entry closed-candle value exists, but are not decision-time proof. Partial-window removal is a foregone, unobserved opportunity—not a failed 72h outcome.

The historical six tracker-peak winners inside the forward nine are IDs 1706, 1709, 1739, 1755, 1757 and 1932. Forward-only strong rows are 1722 ORDI (+10.18%), 1725 ATH (+12.18%) and 1975 NMR (+53.42%). The complete fixed72h strong rows are IDs 1706, 1709, 1722, 1725, 1739, 1755, 1757, 1932 and 1975.

No candidate is recommended from 21 rows and a one-stop denominator. In this same sample, 1h absolute aVWAP distance <=2 ATR removes the one stop, none of the nine complete strong peaks, and none of the six partial paths, but it excludes just one signal and relies on only 16 measured cohort values (5 unknown); it is exploratory, not validation. The 4h absolute aVWAP <=2% cut also removes the one stop and retains all nine strong paths, but removes five partial paths and four other complete rows; only 15 values are measured (6 unknown). These rows are reported transparently, not selected or promoted to gates.

Appendix: .local/reports/plm-indicator-current-fixed72h-2026-10-01.csv contains all 36 rows, exact threshold classification, complete/strong/stop/partial counts, captured-source counts, and tracker IDs removed. JSON fields primaryCurrentFixed72h and currentFixed72hIndicatorCrossTab contain the same ID-joined outcomes.

## Historical 168-row tracker-peak cross-tabs (different endpoint)

**Different endpoint from the primary current fixed72h table above:** every strong-move count in this 168-row cross-tab is the recorded tracker peak through closure/cutoff. Its current/single-entry column also uses tracker peaks and must not be interpreted as fixed72h retention. The 60 historical tracker peaks are not merged with the current forward nine.

The seven numerical cuts named in the audit brief were fixed before the outcome cross-tab: RSI5 <=70; Williams %R21 <=-20; ADX14 >=20 and >=30; ATR percentile <=75; Bollinger bandwidth percentile <=50; candle close location >=60. The absolute aVWAP caps of <=2 ATR and <=2% were fixed for this audit, but remain exploratory. The grid crosses each fixed cut with all four timeframes; no “best” cell is selected.

| TF | Rule | Measured values | Unknown retained | Removed of 168 | Tracker-strong removed / retained (60) | Exact stops removed / 33 | B.U. removed / 68 | Cancels removed / 5 | Open removed / 6 | single_entry tracker-strong removed / 6; stops / B.U. removed |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|
| 15m | RSI5 <=70 | 153/168 | 15/168 | 84/168 (50.0%) | 32 / 28 | 17/33 | 34/68 | 1/5 | 1/6 | 8/21; 3/6, 1/1, 2/8 |
| 15m | Williams %R(21) <=-20 | 153/168 | 15/168 | 94/168 (56.0%) | 32 / 28 | 23/33 | 37/68 | 1/5 | 1/6 | 9/21; 3/6, 1/1, 3/8 |
| 15m | ADX14 >=20 | 153/168 | 15/168 | 17/168 (10.1%) | 7 / 53 | 4/33 | 8/68 | 1/5 | 0/6 | 2/21; 2/6, 0/1, 0/8 |
| 15m | ADX14 >=30 | 153/168 | 15/168 | 59/168 (35.1%) | 18 / 42 | 14/33 | 26/68 | 3/5 | 2/6 | 8/21; 5/6, 0/1, 2/8 |
| 15m | ATR percentile <=75 | 153/168 | 15/168 | 124/168 (73.8%) | 43 / 17 | 24/33 | 52/68 | 3/5 | 5/6 | 17/21; 4/6, 1/1, 6/8 |
| 15m | BB bandwidth percentile <=50 | 153/168 | 15/168 | 140/168 (83.3%) | 47 / 13 | 29/33 | 57/68 | 3/5 | 6/6 | 20/21; 5/6, 1/1, 8/8 |
| 15m | Candle close location >=60 | 153/168 | 15/168 | 65/168 (38.7%) | 22 / 38 | 8/33 | 30/68 | 3/5 | 5/6 | 14/21; 4/6, 0/1, 5/8 |
| 15m | abs aVWAP distance <=2 ATR | 16/168 | 152/168 | 1/168 (0.6%) | 0 / 60 | 0/33 | 1/68 | 0/5 | 0/6 | 1/21; 0/6, 0/1, 1/8 |
| 15m | abs aVWAP distance <=2% | 16/168 | 152/168 | 0/168 (0.0%) | 0 / 60 | 0/33 | 0/68 | 0/5 | 0/6 | 0/21; 0/6, 0/1, 0/8 |
| 30m | RSI5 <=70 | 157/168 | 11/168 | 103/168 (61.3%) | 36 / 24 | 23/33 | 40/68 | 3/5 | 1/6 | 10/21; 4/6, 1/1, 3/8 |
| 30m | Williams %R(21) <=-20 | 157/168 | 11/168 | 97/168 (57.7%) | 38 / 22 | 21/33 | 39/68 | 1/5 | 2/6 | 11/21; 4/6, 1/1, 3/8 |
| 30m | ADX14 >=20 | 157/168 | 11/168 | 13/168 (7.7%) | 6 / 54 | 2/33 | 6/68 | 0/5 | 0/6 | 3/21; 2/6, 0/1, 1/8 |
| 30m | ADX14 >=30 | 157/168 | 11/168 | 51/168 (30.4%) | 18 / 42 | 13/33 | 20/68 | 2/5 | 0/6 | 6/21; 4/6, 0/1, 3/8 |
| 30m | ATR percentile <=75 | 157/168 | 11/168 | 125/168 (74.4%) | 42 / 18 | 27/33 | 50/68 | 3/5 | 6/6 | 16/21; 5/6, 1/1, 4/8 |
| 30m | BB bandwidth percentile <=50 | 157/168 | 11/168 | 143/168 (85.1%) | 47 / 13 | 31/33 | 59/68 | 4/5 | 6/6 | 17/21; 2/6, 1/1, 8/8 |
| 30m | Candle close location >=60 | 157/168 | 11/168 | 70/168 (41.7%) | 24 / 36 | 11/33 | 32/68 | 2/5 | 5/6 | 12/21; 2/6, 0/1, 5/8 |
| 30m | abs aVWAP distance <=2 ATR | 16/168 | 152/168 | 0/168 (0.0%) | 0 / 60 | 0/33 | 0/68 | 0/5 | 0/6 | 0/21; 0/6, 0/1, 0/8 |
| 30m | abs aVWAP distance <=2% | 16/168 | 152/168 | 1/168 (0.6%) | 0 / 60 | 0/33 | 0/68 | 0/5 | 1/6 | 1/21; 0/6, 0/1, 0/8 |
| 1h | RSI5 <=70 | 160/168 | 8/168 | 110/168 (65.5%) | 39 / 21 | 24/33 | 41/68 | 3/5 | 3/6 | 16/21; 5/6, 1/1, 7/8 |
| 1h | Williams %R(21) <=-20 | 160/168 | 8/168 | 111/168 (66.1%) | 42 / 18 | 20/33 | 44/68 | 2/5 | 5/6 | 16/21; 4/6, 1/1, 5/8 |
| 1h | ADX14 >=20 | 160/168 | 8/168 | 15/168 (8.9%) | 6 / 54 | 4/33 | 4/68 | 0/5 | 0/6 | 1/21; 1/6, 0/1, 0/8 |
| 1h | ADX14 >=30 | 160/168 | 8/168 | 56/168 (33.3%) | 22 / 38 | 11/33 | 21/68 | 2/5 | 0/6 | 7/21; 4/6, 0/1, 4/8 |
| 1h | ATR percentile <=75 | 160/168 | 8/168 | 121/168 (72.0%) | 43 / 17 | 27/33 | 49/68 | 2/5 | 4/6 | 15/21; 5/6, 1/1, 5/8 |
| 1h | BB bandwidth percentile <=50 | 160/168 | 8/168 | 150/168 (89.3%) | 51 / 9 | 30/33 | 59/68 | 5/5 | 6/6 | 18/21; 4/6, 1/1, 6/8 |
| 1h | Candle close location >=60 | 160/168 | 8/168 | 53/168 (31.5%) | 16 / 44 | 11/33 | 21/68 | 3/5 | 4/6 | 10/21; 2/6, 0/1, 5/8 |
| 1h | abs aVWAP distance <=2 ATR | 16/168 | 152/168 | 1/168 (0.6%) | 0 / 60 | 1/33 | 0/68 | 0/5 | 0/6 | 1/21; 0/6, 1/1, 0/8 |
| 1h | abs aVWAP distance <=2% | 16/168 | 152/168 | 6/168 (3.6%) | 1 / 59 | 1/33 | 1/68 | 0/5 | 2/6 | 6/21; 1/6, 1/1, 1/8 |
| 4h | RSI5 <=70 | 166/168 | 2/168 | 108/168 (64.3%) | 38 / 22 | 17/33 | 48/68 | 1/5 | 6/6 | 16/21; 3/6, 1/1, 5/8 |
| 4h | Williams %R(21) <=-20 | 166/168 | 2/168 | 93/168 (55.4%) | 33 / 27 | 17/33 | 40/68 | 2/5 | 5/6 | 14/21; 3/6, 1/1, 4/8 |
| 4h | ADX14 >=20 | 166/168 | 2/168 | 37/168 (22.0%) | 16 / 44 | 4/33 | 14/68 | 1/5 | 2/6 | 5/21; 1/6, 0/1, 2/8 |
| 4h | ADX14 >=30 | 166/168 | 2/168 | 93/168 (55.4%) | 34 / 26 | 11/33 | 41/68 | 2/5 | 5/6 | 14/21; 3/6, 0/1, 6/8 |
| 4h | ATR percentile <=75 | 166/168 | 2/168 | 103/168 (61.3%) | 39 / 21 | 20/33 | 43/68 | 2/5 | 3/6 | 13/21; 5/6, 1/1, 4/8 |
| 4h | BB bandwidth percentile <=50 | 166/168 | 2/168 | 137/168 (81.5%) | 50 / 10 | 30/33 | 53/68 | 5/5 | 5/6 | 16/21; 5/6, 1/1, 5/8 |
| 4h | Candle close location >=60 | 166/168 | 2/168 | 56/168 (33.3%) | 21 / 39 | 9/33 | 24/68 | 2/5 | 0/6 | 7/21; 2/6, 0/1, 5/8 |
| 4h | abs aVWAP distance <=2 ATR | 15/168 | 153/168 | 0/168 (0.0%) | 0 / 60 | 0/33 | 0/68 | 0/5 | 0/6 | 0/21; 0/6, 0/1, 0/8 |
| 4h | abs aVWAP distance <=2% | 15/168 | 153/168 | 9/168 (5.4%) | 0 / 60 | 1/33 | 1/68 | 0/5 | 6/6 | 9/21; 0/6, 1/1, 1/8 |

Unknown/missing values are retained and counted, so every sample-reduction percentage is out of the full 168; “measured” is the eligible denominator. Candidate removals are retrospective counterfactuals, not actual scanner rejects. The full candidate CSV also breaks out closed rows, the 147-row legacy group, all 21 single-entry rows and captured-only single-entry results.

### Interpretation

- 1h BB bandwidth percentile <=50 removes 150/168 rows (89.3%), but also 51/60 strong peaks, 30/33 stops and 59/68 B.U. In single_entry it rejects 18/21, including 4/6 strong peaks, the only stop and 6/8 B.U.
- 15m RSI5 <=70 rejects 110/168, including 39/60 peaks, 24/33 stops and 41/68 B.U.; in single_entry it loses 3/6 peaks to remove its one stop.
- 30m ADX14 >=30 rejects 51/168, including 18/60 peaks and 13/33 stops; among the later 21 it removes 4/6 peaks and 0/1 stops.
- 4h ATR percentile <=75 rejects 103/168, including 39/60 peaks, 20/33 stops and 43/68 B.U.; among the later 21 it removes 5/6 peaks and the single stop.
- These historical tracker-endpoint counters are distinct from the fixed72h results above. No filter is recommended; in either endpoint, cutting a small number of stops is not sufficient if qualifying peak opportunities or censored paths are sacrificed.

## Temporal split and historical baseline

The later single_entry group is not a validated holdout: gate versions are unstamped and old scanner rules cannot be assigned retroactively. The prior tracker-peak summary of the nine captured closed rows (3 tracker peaks) is historical only. For the primary fixed72h endpoint, 9 captured paths are complete and 4 reach +10%, while 6 captured paths remain partial/censored; the six reconstructed rows are complete with 5 strong. This remains a tiny descriptive cohort, not independent evidence of threshold performance.

The 2026-09-22 PLM Williams 4h baseline retained 20/21 trades by a different objective (realized PnL >=10%) and different complete-telemetry cohort. That does not answer peak >=10% retention and is not a like-for-like comparator here. No new live PLM rule is proposed.

## Reproducible exports

- plm-indicator-cohort-input-2026-10-01.csv — all frozen cohort outcomes plus reference-price fallback and derived peak percent.
- plm-indicator-telemetry-2026-10-01.csv — 672 clean row-by-timeframe observations, provenance, timestamps, closed-bar validation and flattened candle fields.
- plm-indicator-gate-results-2026-10-01.csv — all 36 timeframe × threshold results for the separate historical tracker-peak endpoint.
- plm-indicator-current-fixed72h-2026-10-01.csv — current 21-row fixed72h ID join for the same 36 existing cuts; no thresholds or metrics retuned.
- plm-indicator-coverage-2026-10-01.csv — missingness and source by exact outcome status.
- plm-indicator-strong-peaks-2026-10-01.csv — all 60 strong tracker peaks with four-timeframe values, for direct retained/removed review.
- plm-indicator-audit-2026-10-01.json — primary current fixed72h outcome table plus explicitly labeled historical tracker-peak results, coverage and source SQL.

Production enrichment used only read-only SELECTs on public.tracked_signals, bounded by the 168 fixed cohort IDs using id = ANY($1::int[]); the query projected per-row indicator fields for each timeframe and did not aggregate whole-table JSON. Frozen outcome labels/values were never replaced by later database state.
