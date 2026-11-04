---
name: Range-return hold 2h and Stealth re-entry
description: 1H Range cancel hold 2h; re-entry after cancel implemented (owner 2026-10-21) with replay evidence and gaps
---
1H Range cancels after 2h (3 closed 1H candles) below the level; 4H keeps 4h. Basis: replay of 241 closed 1H Range signals.

Re-entry: one per arm, within 48h of a stealth_returned_to_range cancel, on a closed 1H candle closing above the frozen level that passes live filters (aggregated volume rule 0.8x, dist>=1%, body>=1 ATR). Own timer in watcher; unique broadcast key `reentry:<trackedId>` is the one-per-arm guard; Telegram label «повторный вход»; its own range-return cancel uses level stored in decision_metrics.stealthReentry.
**Why:** replay (dist/body filter only): 24 re-entries, 6 champions, Σ +76.9, total −92.5 vs −169.4 without.
**How to apply:** volume gate and the momentum (p24h>=4) alternative are NOT replayable/NOT applied to re-entry; verify live volume behavior after first re-entries.
