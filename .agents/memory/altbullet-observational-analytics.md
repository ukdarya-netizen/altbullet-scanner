---
name: AltBullet observational analytics
description: Product boundary for the user's TradingView AltBullet Neon 4H indicator.
---

AltBullet Neon 4H is an observation layer: every model version forms a separate immutable cohort, and a snapshot is recorded only after a signal has already been accepted for tracking. It must never block, delay, alter, or silently downgrade Telegram delivery.

**Why:** The purpose is to measure whether the user's custom indicator predicts outcomes across all bot patterns without contaminating the bot's existing signal-selection behavior.

**How to apply:** Keep unavailable market data and snapshot-write failures non-blocking. Never merge model versions in one metric. Checks use pass/fail/unknown, where unknown never becomes pass; independent evidence is counted once. Compare with closed outcomes only after at least 20 closed snapshots; findings never change entries or exits without a separate data-backed decision.

AltBullet market-data capture must never be awaited on a primary Telegram delivery path.

**Why:** Its 1H/4H market-data calls can slow or time out independently of an already accepted trading signal; observation must not make a time-sensitive alert late.

**How to apply:** Schedule the immutable snapshot only after the primary alert attempt, handle capture errors inside the background task, and keep all gate, exit, and delivery decisions independent of its result.

Each accepted signal needs a durable AltBullet snapshot intent that is leased in the database and acknowledged only in the same transaction as the immutable snapshot insert.

**Why:** An in-memory timer disappears on a restart or deploy; an unrecorded observation gap cannot be reconstructed honestly as a fire-time reading.

**How to apply:** Write the intent with the signal record, let only one worker claim it at a time, clear it only after the snapshot commit, and reclaim expired or unclaimed intents during startup and periodic recovery. The background scheduler remains only an immediate trigger, never the sole source of truth.

ABNeon оценивается только как наблюдательный S/R-слой во взаимосвязи с уже сохранёнными входными индикаторами и исходами; новые score/verdict и ABNeon TP-гипотезы не создаются. Исторические результаты этих экспериментов остаются доступными для аудита, не смешиваясь с новыми снимками.

**Why:** Пользователь отказался применять новые тейки и выбрал «сейчас только отслеживание». Общий score и TP-shadow не дали достаточного основания менять реальные выходы.

**How to apply:** Разделять паттерны, версии и происхождение входных показателей (в момент сигнала, предскан, реконструкция, неизвестно). Не подменять пропуски текущими значениями; показывать только подтверждённые траекторией касания, не называя отсутствие записи промахом. Любые изменения реальных тейков требуют отдельного решения по сопоставимым исходам.

Entry-time context is frozen at the durable snapshot request time, not the later retry/capture time.

**Why:** A retry may run after additional candles close; using them would introduce look-ahead and make the observational cohort dishonest.

**How to apply:** Include only candles whose close is at or before the original request time. Store 1H/4H freshness, BTC regime provenance, and unknown reasons. Never infer target-before-stop from sparse samples or terminal summaries when exact ordering is unavailable.

Support influence on other patterns, especially Liquidation Cascade, must be evaluated using a versioned signal-time ABNeon snapshot: distinguish no lower 4H S/R level from no usable snapshot, and compare proximity to support (distance in percent and ATR) rather than treating every distant lower level as meaningful support.

**Why:** The older indicator snapshots contain resistance but no support; retrospective classification from current support would leak future information. Liquidation Cascade snapshots also include many rows without a linked tracked position, so snapshot counts alone are not an outcome cohort.

**How to apply:** Use only the new model-version forward cohort joined to real tracked signals; report coverage, completed outcomes, high-profit retention and B.U./stop breakdown by support-distance bands. Do not merge older versions or turn support into a live gate on this observation alone.

The forward resistance-version verdict is not yet a useful trade filter: in the 2026-09-25 production audit of measurable tracked trades, `confirmed` did not outperform the conflict groups, and the "room" check would have excluded a disproportionate share of ≥10% outcomes.

**Why:** Snapshot totals include signals without tracked positions, and aggregate verdict/check differences mix patterns. Even a sizable completed cohort does not establish a robust directional advantage from a generic score; later support-observation snapshots had too few closed tracked trades for a comparable conclusion.

**How to apply:** Before any indicator change, compare same-version, tracker-linked closed trades within pattern and test high-profit retention and event-ordered target/stop paths. Re-evaluate the newer support cohort after enough closes; do not train on mixed versions or interpret ambiguous target order as a miss.