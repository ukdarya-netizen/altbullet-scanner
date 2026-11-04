---
name: Neon no-wait entry policy
description: Neon (ABNeon Support Bounce) enters at detection or not at all; October rows restated by replay; spot/mcap gate removed
---

Neon fires only on the first scan that sees a qualified event; an offered event that did not fire is terminalized (`neon_not_entered_at_detection`), never re-offered. Neon has no spot/mcap minimum (owner 2026-10-25, TAG +30-60% was blocked at detection). Late entries came from the 2026-10-17/21 "qualified never expires / re-offered each cycle" changes; Sept entries were ~immediate and clean.

**Why:** owner: late entry is already growth; replay of 69 real fires: entered <1h +44 pts, later -12 pts (stop 8 / TP10 first-touch).

**How to apply:** do not reintroduce waiting/retry windows for Neon. October closed Neon rows (43) are restated by a one-off production migration (`neon-no-wait-recalc`): entry = close of the 15m candle at 1H reaction close, exits replayed on 15m candles (stop 10→8 from 2026-10-22, BE +5, trail peak-10 after +15). Originals live in table `tracked_signals_backup_neon_no_wait_20261025`. Active rows, BTC and 3 rows with no exit yet were left untouched. Replay fidelity vs real exits was 39/46; entry-sensitive (TAG becomes B.U.).

## Restatement criterion (2026-10-25)
A Neon row is "would not have been entered" only if its candidate's first evaluation was rejected by a rule that still exists in code (support_broken_before_entry, spot_taker_sell_dominance, aggregated_data_unavailable, confirmed_fire_mcap_unavailable/duplicate, other-pattern precedence). Rejects by removed filters (came_from_below, bounce_already_left_zone, no_pullback, quiet_zone_precedence) and the removed spot/mcap gate do NOT block. Such rows are deleted from tracked_signals+signals (backups in *_backup_neon_open_removal_* tables); the rest are replayed (BE +8, trail peak-10 after +15, stop 10% before 2026-10-22 18:50Z). Neon BE is +8; Stealth/Neon send no +5 pre-target message. Later gates were not evaluated for events rejected early (unverified assumption).
