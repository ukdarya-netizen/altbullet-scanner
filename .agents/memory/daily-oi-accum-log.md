---
name: Daily OI accum log-only detector
description: checkDailyOiAccumulation() — log-only pattern for multi-day daily OI growth; why it's distinct from intraday patterns.
---

## The rule
`checkDailyOiAccumulation()` in `whaleTracker.ts` runs once per UTC day immediately after `saveDailyOiSnapshots()` (chained `.then()`). Writes to `missed_signals_log` with `source='daily_oi_accum'`, `pattern='quiet_oi_accumulation'`. No signal is created — pure observation for 2-3 weeks of data collection.

**Criterion:** 2 consecutive days with `oi_change_24h ≥ 5%`, `oi_base ≥ $1M`, price delta over those days `≤ +10%`.

## Why it's distinct from existing intraday patterns

| | quiet_oi_accumulation | spot_oi4h_build | daily_oi_accum |
|---|---|---|---|
| OI source | Coinalyze API (intraday) | Coinalyze API (intraday) | oi_daily_snapshots (DB) |
| OI window | 30m / 1h | 30m / 1h / 4h | 24h+ (2+ days) |
| OI threshold | oi30m ≥ 0.2%, oi1h ≥ 0.5% | oi30m ≥ 0.5%, oi1h ≥ 1.0% | daily ≥ 5%/day |

A token accumulating +8%/day OI produces only ~0.17%/30min (uniform spread) — below ALL intraday thresholds. These are structurally different detection windows.

**Why:** BANK-USDT and C-USDT confirmed the pattern empirically in Jul 2026 (DropsTab batch analysis). Both had 2 consecutive daily OI growth ≥8%, flat price, then +8-12% price spike in one 4h candle. Neither was caught by existing patterns even without the DropsTab prescan bug. CHR-USDT also confirmed (smaller scale, +21.9% intraday wick). CFG-USDT was a false positive (OI grew but price returned to start).

**How to apply:** Don't adjust quiet_oi_accumulation thresholds to try to catch this — the gap is ~10x in OI rate. If data after 2-3 weeks shows consistent hit rate, implement as real pattern reading from oi_daily_snapshots, not Coinalyze.

## Implementation location
- `artifacts/api-server/src/lib/whaleTracker.ts` — `checkDailyOiAccumulation()` export
- Called from `artifacts/api-server/src/lib/scanner.ts` line ~1274: `saveDailyOiSnapshots(...).then(() => checkDailyOiAccumulation()...)`
- In-memory 23h dedup: `_dailyOiAccumDedup` map in whaleTracker module scope
