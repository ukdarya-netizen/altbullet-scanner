---
name: Gate rewrite — retrospective 753 cases
description: Specific threshold changes made to surviving patterns based on 753 retrospective 20%+ move cases
---

## Changes made (2026-07-18)

### oversold_reversal
- RSI 1h: ≤32 → **≤38** (33-38 bucket showed similar avg peak to 28-32 in retro)
- RSI 15m: removed as hard requirement (single 15m candle flips the whole indicator);
  still read optionally for the log line

### spot_vol_accumulation (loop1, ~line 2660)
- VBS_MIN_MULT: 3.0 → **2.5** (was raised to 3.0 based on only 24 signals; retro of 753 showed 2.5-2.9x range still positive)
- VBS_MIN_SPOT_MCAP_PCT: 0.03 → **0.015** (3% was cutting 55% of cases without improving avg peak)
- p24h lower bound: -5% → **-10%** (retro: -5%..-10% zone has similar avg peak to 0..+5% at ≥2.5x spotVol)
- OI gate: **fail-open** — was hard-blocking all BingX-exclusive tokens (no CG OI data = skip).
  Spot-driven pattern; OI is secondary. Only hard block: OI4h < -3% (clear distribution signal).
- CVD gate: **cvd1h required only** (cvd4h fail-open). Retro: 45% of valid cases had cvd1h=true but cvd4h=false, avg peak +19% vs +21%. Not worth the block.

### bullish_accumulation (inline gates, ~line 4900+)
- OI floor: 3.5% → **2.0%**
- SpotCVD gate: **removed**
- Vol floor with CG OI: 1.8x → **1.2x** / without OI: 2.5x → **1.8x**
- cycleCount cap: >15 → **>25**
- OI4h threshold: -3% → **-5%**
- p24h cap: 15% → **25%**

### flush_reversal
- SpotCVD hard gate: **removed** (fail-open)

### impulse_buy → impulse_breakout
- Renamed; price3h ≥ 8%, vol ≥ 1.5x

## Dead patterns removed (14)
spot_absorption, early_vol_oi, spot_divergence, 4h_momentum, quiet_oi_accum,
volume_taker, bingx_exclusive, oi1h_breakout, spot_oi4h_build,
spot_trend_accumulation, short_squeeze, spot_taker_lead, spot_vol_breakout,
accumulation_breakout

**Why:** all had 0 fires in live tracking; removing reduces false-positive risk and
simplifies the scan loop (~17 fewer signal creation blocks).
