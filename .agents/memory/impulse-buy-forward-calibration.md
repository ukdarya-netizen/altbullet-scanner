---
name: Impulse Buy forward calibration
description: Evidence boundary for changing Impulse Buy entry gates after the 24h rejected-candidate review.
---

Relax or retune an existing Impulse Buy rejection boundary only from temporally
overlapping fired and rejected cohorts that contain the same immutable
decision-time metrics. An additive quality gate may instead be evaluated inside
the fired cohort when its immutable metric is available there, because the
question is which known entries should have been excluded. Deduplicate or
cluster repeated observations and exclude unresolved price discontinuities.

**Why:** The September 2026 historical review showed weak and unstable fired
outcomes, but legacy fired snapshots lacked the detailed candle features present
on rejects. Compound reasons and repeated LSK discontinuities distorted ordinary
averages. Isolated funding, OI, and volume rejects had enough downside that
removing those blocks was not supported, while isolated body and close-strength
samples were too small.

**How to apply:** Existing gate relaxation still requires feature-parity, at
least 30 completed isolated or matched events, later-period validation, stable
TP-before-SL, robust return metrics, acceptable MAE, and symbol/time clustering.
For an additive fired-cohort gate, require immutable fire-time provenance,
improvement in both the full and later cohorts, no dependence on one symbol, and
fail-open handling of missing telemetry.

For final quality calibration, count every actually entered completed position
with recorded PnL, including loss-bearing cancellations. A conditional rate
excluding cancellations may be shown separately but is not the primary
realized >10% success rate. Use actual B.U. PnL rather than replacing every B.U.
row with zero. Separate entry and exit policy eras inside any date-cutoff cohort.

**Why:** An entered cancellation is a realized closure, not a rejected entry.
Excluding it inflates success rates; a single calendar cutoff does not isolate
later entry-filter, single-entry, and runner-policy changes.

**How to apply:** Keep raw, symmetric audit cohorts distinct from user-facing
statistics that intentionally exclude old stops. Identify no-entry neutral
closures explicitly, keep open trades censored, and report runner-only canonical
PnL without calling it allocation-weighted or verified exchange execution.

The long-liquidation concentration candidate (`long liq 1h / long liq 24h`)
must remain telemetry-only above 0.15 until at least 20–30 completed forward
high-ratio decisions exist. Capture the ratio from the scanner-time batch cache,
preserve cache freshness metadata, and treat unavailable data as unknown rather
than reconstructing it after entry.

**Why:** The September fired cohort showed a stable downside-heavy band above
0.15, but the older metric was captured at tracker creation rather than inside
 the immutable scanner decision and had no compatible rejected counterfactual.

The 30m ADX-slope entry gate was removed. Its tracker indicator telemetry and
historical backfill have since been decommissioned; do not restore the collector
or use ADX as a rejection reason without explicit approval.

**Why:** Of its first four live blocks on 2026-09-24, H and XAI subsequently
closed 15m candles above +10% from the decision price, and LTC reached +10%
intrabar. None hit the -10% stop before those highs. This does not prove three
executable wins, but contradicts the intended high-profit-retention objective.

**How to apply:** Preserve historical blocked rows for audit. No new tracker
indicator telemetry is collected or reconstructed. Before any future ADX gate,
fix the threshold in advance and collect a sufficiently large gate-specific,
decision-time forward shadow cohort under a separately approved design, with
execution-price and exit-policy sensitivity, before enabling a live rejection.

The owner approved a non-monotonic p24h weak-band exclusion, not a requirement
to enter only above +15% and not a general claim that higher daily growth is bad.
Retired tracker indicators, including RSI(5), Williams %R, and aVWAP, are no
longer captured; do not infer new decision-time observations from their legacy
columns.

**Why:** The historical band trade-off was accepted even after a profitable
`expired` outcome was identified among its exclusions. Exact status `profit`
is not the complete inventory of profitable outcomes.

**How to apply:** Preserve all entered closures, including profitable expired
rows, when reviewing retention. Distinguish legacy tracker fire-time p24h from
scanner decision-time p24h: the two differed in historical paired snapshots.
Calibrate against the actual decision metric rather than treating those
columns as interchangeable.
Live Impulse Buy now blocks (owner-approved, 2026-10-01) a 3h price rise >=20%
and any missing core decision-time metric (p24h, p3h, CoinGlass OI30m, futures
volume) or the exact 1.0/1.0 spot+futures volume placeholder. CVD, funding,
OI1h/4h and spot-volume-alone stay fail-open.

**Why:** Fired cohort: p3h>=20% had 42% stops and negative average PnL, while the
strongest winners started at 10-18%, so a 10% cap would have removed them. Fired
signals missing a core metric stopped 42% vs 22% with complete data. CVD is
empty on ~74% of signals, so requiring it would block almost everything.

**How to apply:** Re-check both rules against rejected candidates (price1h/price3h
are now captured on every decision) after 2-3 weeks before changing thresholds.
Pre-capture rejects have no p3h and cannot validate the rule.

Decision 2026-10-10 (owner demanded action, no more "wait"): IB hard-rejects p24h >= 20% (`p24h_ge_20pct`). Basis: closed IB trades, p24h>=20% → 15/36 stops (42%) vs 20/96 (21%) below. Revisit by forward cohort.

2026-10-22 (владелица, live без shadow): Impulse Buy не выдаётся при spot volume / mcap в [6%, 15%) (без верхнего потолка; 15%+ проходит). Основание: когорта с 2026-09-11, 1/27 пик ≥10% в зоне 6–15% против 7/17 в 4–6%; немонотонно, n мало — пересмотреть на forward. Код: confirmed-fire блок scanner.ts, причина impulse_spot_mcap_6_to_15pct.
Код отказа volume_baseline_missing теперь только для реально запрошенного, но отсутствующего агрегата; незапрошенный — volume_not_measured.
Причины отказа IB различают «не запрошено» (*_not_measured: volume, fut_taker, cvd, spot_volume) и «запрошено, агрегата нет» (*_unavailable). Range-only символы теперь тоже оцениваются IB (раньше 16k строк decision_reason_not_recorded).
