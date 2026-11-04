---
name: Sleeping patterns threshold tuning 2026-07-10
description: Two rounds of consultant-driven threshold loosening for 16 never-fired patterns across the scanner
---

Loosened thresholds on 16 patterns that had checked/passed gate stats but zero all-time fires, per two user-provided consultant documents in the same session.

**Round 1 (6 patterns):**
- `liquidation_cascade`: volMult 5.0x→3.0x, oi1h floor -8.0%→-5.0%.
- `spot_divergence`: OI30m gate `>= 0.3` → `>= -1.0` — the pattern's own logic (spot buying while futures taker sells) structurally conflicts with requiring OI growth.
- `accumulation_breakout`: OI1h 3.0%→2.0% OR OI4h 5.0%→3.5% (gate lives in `isAccumBreakout` in scanner.ts, not scanner-patterns.ts).
- `dip_accumulation`: OI floor 8%→4% in `detectSentiment()` (scanner-patterns.ts) — also mirrored in `_likelyDipAccum` bypass helper in scanner.ts, must stay in sync.
- `spot_vol_accumulation` / `spot_vol_breakout`: see `vb-tuning-2026-07-10.md`.

**Round 2 (10 patterns), all in scanner.ts:**
- `quiet_oi_accumulation`: Fut Taker gate 3%→2%, spotVolMult range 0.8–1.8x→0.6–2.0x.
- `oi1h_breakout`: spotVolMult 2.0x→1.5x (or 1.2x if OI1h≥4.0%).
- `spot_oi4h_build`: consecutive-growth-cycles requirement 3+→2+.
- `oi_surge_no_vol`: OI1h 15%→8%, OI4h 25%→15% — original thresholds almost always co-occur with a volume spike, contradicting the pattern's "no volume" premise.
- `spot_trend_accumulation`: Spot Taker made optional — bypassed when `spotCvd.cvd4h === true` (CVD trusted over single taker snapshot).
- `4h_momentum`: OI1h floor 1.0%→0.5% (OI is meant as confirmation only, not primary filter).
- `early_vol_oi`: two-candle volMult requirement 2x/2x→1.8x/1.3x (asymmetric), summed OI30m 2.0%→1.5%.
- `bingx_exclusive`: spotVolMult 3.0x→1.8x.
- `volume_taker`: Fut Taker 8%→5%.
- `spot_momentum_reversal`: futures taker dominance requirement widened from strict `"sell"` to `"sell" || "neutral"`.

**Why the low fire rate in general:** primary gate values across many patterns were set well above what live market data actually produces at scale — same root cause across both rounds and the earlier volume_breakout tuning.

**How to apply:** if fire rate is still near-zero after 2-3 weeks of live data, re-check `pattern_debug_log` gate-pass counts before loosening further — don't just guess at another threshold cut. When editing any OI/vol/CVD threshold, check for a duplicate/mirrored condition elsewhere (e.g. price-growth-gate bypass helpers) that must be kept in sync.
