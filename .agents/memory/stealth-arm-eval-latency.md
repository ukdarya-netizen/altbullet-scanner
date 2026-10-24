---
name: Stealth arm evaluation latency
description: Why armed 1H breakouts qualified 40-49 min after candle close, and restart blank cycle
---
Arms are evaluated once per scan cycle (:00/:30 start, ~18 min long), so late loop position = up to ~48 min lag; active-arm symbols are now put first in the loop.
First cycle after a restart had empty unlock cache; one failed fetch refused all symbols (unlock_data_unavailable) — fetch now retries 3x.
Arms survive while price is inside the old frozen range (17.10 owner rule), so ~30% of armed rows sit on an older range than the detector's current one.
**Why:** measured 2026-10-19 (ARC/0G/AXL/WLD 42-49 min; KITE/BIKETYSON 41-45 min).
**How to apply:** check cycle position and the first post-restart cycle before blaming gates.

## Early pass, second arm, unlock snapshot (2026-10-19)
- Early 1H arm pass runs before phase 0 only within 25 min of the hour close and skips breakouts older than the current hour (empty 30m refinement is only valid then). No telemetry written; missing data leaves the arm untouched. Fire stays in the main loop. Early pass budget 120s was exceeded in the first prod cycle (162 armed, 4 evaluated): raise budget/concurrency or order by hour-fresh arms.
- Max 2 live 1H arms per symbol via decision_json.armSlot (primary/secondary); trigger maps secondary to arm_venue='secondary' so the unique-armed index allows it. Secondary promotes to primary when the detector range equals it.
- `range_obsolete` after 48h unseen with price inside; last sighting in decision_json.detectorLastSeenAt, fallback armed_at (so old arms close on first check).
- Unlock list: last good list persisted in unlock_list_snapshot, used up to 24h when the API fails; older → unavailable.
- Cycle metrics now hold earlyArmPass, phase0StartOffsetMs, loopStartOffsetMs.
- First prod cycle after publish (13:00 UTC): early-qualified ATOM then got `aggregated_data_unavailable:oi` in main loop at 13:06 (OI phase not run yet) — this is why fire needs the mini-cycle (not built yet; performScanBody is monolithic, ~12 evict/write sites + durable cycle number allocation).
- evaluateDurableStealthArm takes `prefetchedVolumes` (key present, even null = no re-fetch).
