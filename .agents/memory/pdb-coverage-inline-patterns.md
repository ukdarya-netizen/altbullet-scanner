---
name: pdb coverage — 5 inline patterns instrumented
description: bid_wall/liq_magnet/exchange_outflow/oversold/smart_money_div had no _pdbCheck; added 2026-07-16. Also: pdb save architecture and Neon stress behavior.
---

## What was done
`_pdbCheck/_pdbReject/_pdbPass` added for 5 inline patterns (bid_wall_absorption, liq_magnet_squeeze, exchange_outflow_accum, oversold_reversal, smart_money_divergence) at scanner.ts lines ~4731-4755. Code runs for EVERY token before the noOiNoVol bypass check.

These 5 + isSpotDivergenceCandidate were also added to the noOiNoVol bypass list so they can fire even when anyOiPass=false.

## Critical architectural fact: pdb saves at START of next cycle
`persistPatternDebugSnapshot(cycleNumber - 1)` is called at line 1235 = **beginning of performScan()**, not end.
- Cycle N data is written when cycle N+1 starts
- After a fresh deploy, cycle 1 data appears only when cycle 2 starts

**Why:** This design saves the previous cycle's debug snapshot before resetting `lastPatternDebug = {}` for the new cycle.

## Neon stress post-scan
After a long scan (~35 min), all `dbWriteBestEffort(2500ms)` calls timeout for several minutes:
- `lastScanAt heartbeat (idle)` logs "write failed" every ~3 min
- `persistPatternDebugSnapshot` also uses `dbWriteBestEffort` → will also fail if called during this window
- Once Neon recovers (usually within 1-2 cycles), pdb writes resume normally

## Verification
Verified in dist (index.mjs lines 73963-73975): pdbCheck calls present and outside any conditional. The 211K existing rows confirm the mechanism works — just blocked by first-cycle timing and Neon stress.
