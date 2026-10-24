---
name: OI phase snapshot and history path
description: Scanner OI comes only from one pinned coins-markets snapshot per cycle; 30m history is a prescan-only supplement; no substitution on failure.
---
Rule (owner): current OI of every symbol (arms and prescan included) comes ONLY from the per-cycle pinned coins-markets snapshot. 30m history (prevOi30m, oi4hConsec, positiveCandles6h, oiConsecutiveUp) is fetched only for prescan symbols (the only consumers; Stealth arm gates read oiChange30m/oiUsd only). If history fails the fields stay null, result is flagged historyMissing, and the inter-cycle OI gate rejects with oi_history_unavailable. Symbol without snapshot row => not_in_snapshot; no snapshot => snapshot_unavailable. Never "history failed -> use snapshot" and never per-symbol OI for scanner symbols.

**Why:** owner demanded no substitutions/fail-open; arms had no history consumer; the old per-symbol path cost ~400 requests and made Phase-0 take 112-242 s.

**How to apply:** the cycle snapshot load retries (4 attempts, 15 s pause) because one coins-markets 429 once pushed a whole cycle into the legacy per-symbol path (snapshotMode false, 373 history requests, Phase-0 240 s timeout). Scanner always passes a snapshot (empty rows if the load fails). Legacy no-pin mode exists only for the open-positions panel/tests. Per-call stats (label, counts) are in coinglass_cycle_metrics.phases.oiPhase.source.calls; counters are drained before the batch so an aborted attempt cannot double a later cycle's totals. First prod cycle with pinned snapshot: Phase-0 45 s, OI 528/552, 160 prescan history symbols took 434 history requests (~2.7 requests/symbol).
