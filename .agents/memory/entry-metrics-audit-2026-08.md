---
name: Entry metrics audit — data quality fixes 2026-08-02
description: Audit of tracked_signals fill rates; bugs found and fixed for pattern calibration analysis
---

# Entry metrics data quality audit (2026-08-02)

## Audit result — tracked_signals (130 signals, 14 days dev)

| Column | Fill % | Source |
|---|---|---|
| entry_whale_index | 99% | ✅ healthy |
| entry_funding_rate | 100% | ✅ healthy |
| entry_ob_ratio | 73% | ✅ healthy |
| entry_oi_30m/1h/4h | 75–98% | ✅ healthy |
| entry_cvd_1h/4h | 63% | ✅ healthy |
| entry_spot_taker | 40% | ⚠️ acceptable (CG data gaps) |
| prescan_cycles | 3% | ❌ → see bug below |
| entry_spot_net_buy_1h/4h | 6% | ❌ → FIXED |
| entry_fut_vol_mult | 0% | ❌ → FIXED |
| entry_spot_vol_mult | 0% | ❌ (acceptable for liq_cascade) |

## Bugs fixed in this session

### Bug 1: entry_spot_net_buy_1h = 0% for liq_cascade
**Root cause:** Universal SNF fallback in trackSignal (watcher.ts ~line 1187) only covered 4h/24h, not 1h.
Also: liq_cascade fire (watcher.ts ~line 8464) computed _gateSnf1h as gate but didn't pass to trackSignal.
**Fix:** Added 1h to universal SNF fallback; added explicit entrySpotNetBuy1h/4h to liq_cascade trackSignal call.

### Bug 2: entry_fut_vol_mult = 0% (last_vol_mult not in prescan_tracker DB)
**Root cause:** _pe.lastVolMult was in-memory only; wiper on restart → prescanE?.lastVolMult always null for bg signals.
**Fix:** 
- Added `last_vol_mult real` to prescanTrackerTable Drizzle schema (lib/db/src/schema/signals.ts)
- Added to UPSERT values + set (COALESCE) in scanner.ts
- Added to loadPrescanFromDb() mapping in scanner.ts
- ALTER TABLE in runStartupMigration Part 2 (index.ts ~line 632) for prod
- Direct psql ALTER in dev DB
**Why COALESCE:** volMult data can temporarily gap on CG timeouts; preserve last known value.

## prescan_cycles = 0 for liq_cascade — by design
liq_cascade fires on small/exotic BingX tokens not in prescan_tracker.
cycleCountAtDetect from liq_cascade_watch is null for these tokens (they're not scanned).
getPrescanEntry(symbol) returns null → prescanCycles = null. This is acceptable.

## Post-deploy fill rate verification (2026-08-02)

Queried prod `tracked_signals` after 24h of prod data post-deploy.

| Window | SNF 1h fill | vol_mult fill | liq_cascade vol_mult |
|---|---|---|---|
| Last 24h (11 signals) | **81.8%** ✅ | **81.8%** ✅ | N/A (0 liq_cascade signals) |
| Post 2026-08-01 liq_cascade (4 signals) | 75% ✅ | 50% ✅ | 50% ✅ |

Targets met: SNF ≥50% confirmed, vol_mult improved from ~0% for liq_cascade.
No liq_cascade signals fired in final 24h window — 4 post-deploy signals verified directly.

## overheat_log / growth_leader_log empty in dev
Normal: main scanner not running in dev ("DEV mode — scanner NOT started").
Growth leader criteria likely not met with current dev market conditions.
Should be healthy in prod — verify after deploy.

## retro_pre_growth stale
Last collection: 2026-07-17 (16 days ago). 3870 rows.
Missing cycle_count column — proposed as follow-up task #202.
After adding cycle_count: re-trigger POST /api/admin/collect-pre-growth.

## Files changed
- artifacts/api-server/src/lib/watcher.ts — SNF 1h fallback + liq_cascade SNF params
- lib/db/src/schema/signals.ts — lastVolMult column in prescanTrackerTable
- artifacts/api-server/src/lib/scanner.ts — UPSERT values/set + loadPrescanFromDb
- artifacts/api-server/src/index.ts — ALTER TABLE prescan_tracker ADD COLUMN last_vol_mult
