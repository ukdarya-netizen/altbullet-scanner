---
name: ICT removed
description: ICT (TradingFinder/Inner Circle) tracking fully removed; LuxAlgo kept
---
Removed: ICT detector in LC OB wait, Smart Money/ICT shadow subsystem (worker, route, panel, DLIQ), scripts/ict-audit and ICT plm-audit files. Table smart_money_shadow_observations left in DB (data not dropped).
**Why:** owner asked to remove ICT and everything tied to it from UI and files (it was introduced together with LuxAlgo shadow panel).
**How to apply:** don't reintroduce ICT; LuxAlgo OB logic (lc-waiting-ob.ts) is used by Whale Futures. Older memory notes mentioning ICT/TradingFinder are historical.

**Update 2026-10-11:** owner demanded the per-signal Smart Money / LuxAlgo feature observation (internal OB, BOS, CHoCH, FVG, IMB, sweeps, DLIQ) for ALL active-pattern signals. The worker (smart-money-shadow.ts + liquidity-finder-dliq.ts) was restored and rewired in index.ts; the UI panel and ICT OB detector in LC wait stay removed. The observation was off from 2026-10-10 11:21 UTC to the restore (signals #2311+ unobserved until backfilled by the worker).
**Why:** the removal broke her expectation that every signal carries these features.
