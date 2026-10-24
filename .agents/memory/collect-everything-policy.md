---
name: Collect everything for rejected decisions
description: Owner requires full metrics and full price-path backfill for ALL rejected/priced decisions of every trajectory pattern, no sampling.
---
Owner's rule (repeated, angry): record ALL metrics and backfill ALL decisions, even ones that look useless. Do not sample or demote rejects as "low value".
**Why:** she believed this was already happening; found Stealth analysis lacked data (rejects were sampled at ~2%, crossing telemetry mostly "unavailable_delayed").
**How to apply:** never reintroduce reject sampling in pattern_decision_snapshots admission; whale_watch recording starts 2026-10-10 under a new detection path (old rows irrelevant, owner said so). Stealth OI/CVD/taker live in decision_json.latestEvaluationParticipationTelemetry (evaluation time after the cross; triggerParticipationTelemetry is intentionally unavailable_delayed) — use the former for analysis.
Reject metrics: scanner rejects carry decision_json flowSnapshot via _symRej; LC detector rejections (liq-cascade-watcher) get a prescan_tracker flowSnapshot at flush. Check new patterns' reject paths write flowSnapshot too.
Stealth arms get decision_json.backfilledParticipation (CoinGlass 15m history at first_cross_at; ~10 day depth) via a background job; always keep it separate from live captures in analysis. Every pattern decision also gets flowSnapshot at the common write point.

**Правило общения:** когда владелица называет вывод анализа и просит действовать, внедрять немедленно; не предлагать «подождать forward-когорту» и не переспрашивать (она повторила это дважды, 2026-10-11).
