---
name: BA+TA gate fixes 2026-07-19
description: 5 data-backed fixes for bullish_accumulation and trend_accumulation based on 34+21 signal history + retro_pre_growth 774 events
---

## Source data
- 34 trend_accumulation signals (6 profits, 6 stops, 5 BU stops, ~16 stale cancels)
- 21 bullish_accumulation signals (5 profits, 6 stops, 4 BU stops, 2 cancels)
- retro_pre_growth: 774 events × 5 snapshots (T-2/3/4/6/12h) in dev DB

## Key retro findings

**trend_accumulation:** OI30m ≥3.5% + prevOI30m ≥0.3% → avg_p3h = 10.32% (best bucket). Conditions are correct. Stops clustered at cycleCount 1-2 (TAIKO cycle=1, PROM cycle=2, B2 cycle=2).

**bullish_accumulation:** vol 1.0-2.0x → avg_p3h=6.53%, hit_10%=17/70. vol ≥2.0x performs WORSE (avg_p3h=4.34%, hit_10%=2). The old `settings.volumeMultiplier=3x` in evaluatePattern blocked the best bucket entirely. Futures vol: fut ≥0.8x → avg_p3h=7.45%, hit_10%=19; fut <0.8x → 0 hits ≥10%.

## Changes shipped

**T1 — trend_accumulation:** `cycleCount >= 3` → `>= 5` in detectSentiment (scanner-patterns.ts). ~50 min of prescan OI history required before TA can fire.

**T2 — trend_accumulation:** PDB diagnostic block added in scanner.ts AFTER evaluatePattern. When det=bullish_accumulation (TA fallback), logs FIRST failed TA gate: `oi30m_low / prev_oi30m_low / price30m_low / price24h_high / vol_low / cycles_low`. Allows reading which gate dominates in real cycles.

**B1 — bullish_accumulation:** Added to evaluatePattern bypass list (scanner-patterns.ts line ~467). Removes `settings.oiChangePercent(5%) + settings.volumeMultiplier(3x)` block that killed the best vol bucket. Real gates remain in scanner.ts.

**B2 — bullish_accumulation:** p24h cap `> 25` → `> 20` (scanner.ts). FLOCK p24h=27.8% (stop -10.23%), BANK 26.6% (BU stop) both would be blocked.

**B3 — bullish_accumulation:** Futures vol floor `volMult < 0.5` → reject with `fut_vol_low` (scanner.ts). Conservative: blocks PARTI (0.2x, stop -10.89%), passes FHE (0.6x, profit +4.98%).

## What to watch next
- PDB in next cycles: `trend_accumulation rejectedAt` should now show named gates (oi30m_low / price30m_low / prev_oi30m_low etc.) — tells us the dominant blocker
- BA fire rate: B1 should increase pipeline throughput from evaluatePattern; B2+B3 should trim the high-risk end
- TA: if `cycles_low` dominates → threshold is right; if `price30m_low` dominates → market is quiet and 1.0% threshold may need review

**Why:**
- evaluatePattern settings.volumeMultiplier=3x was a global UI setting never intended for BA specifically; BA was originally a fallback pattern (detectSentiment returns it unconditionally when nothing else matches)
- Retro data showed vol 1-2x outperforms vol ≥2x in the OI 2-10% zone — counterintuitive but consistent
