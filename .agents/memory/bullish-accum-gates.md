---
name: bullish_accumulation gates overhaul 2026-07-16
description: 4 gate changes to BA pattern; unconditional fallback root cause and fixes
---

## Root cause

`detectSentiment()` in scanner-patterns.ts has an **unconditional final return** that returns `bullish_accumulation` for ANYTHING that doesn't match trend_accumulation or dip_accumulation — even OI=0. This means tokens with OI30m=0.84% (OPN-USDT, -6.3% PnL) fire as BA.

## Historical data (6 signals total)

| Token | OI30m | Price | Outcome |
|-------|-------|-------|---------|
| OPENEDEN | 10.4% | +16.4% | ✅ peak +16.5% |
| RAVE | 12.6% | +24.2% | ❌ stop -6.2% |
| ORDI | 8.2% | +10.1% | ⚠️ cancelled, peak +1.5% |
| FIL | 4.5% | +1.2% | ⚠️ cancelled |
| LAB | 6.5% | +1.5% | ⚠️ cancelled |
| ULTIMA | 5.1% | +1.0% | ⚠️ cancelled, peak 0% |

## Gates added (scanner.ts ~line 5086, 2026-07-16)

1. **OI floor** (`oi_too_low`): cgOIChange ≥ 3.5% required. Fail-open: CG unavailable → oi1h ≥ 2.0%. Both unavailable → reject.
2. **Two-cycle OI** (`prev_oi_not_building`): `_pe1.prevOi30m > 0` required. Fail-open: null → pass.
3. **CVD gate universal**: removed `cgOIChange < 14` condition — shorts load at any OI level.
4. **Vol floor raised**: 1.0x→1.5x with CG OI, 1.5x→2.0x without.

**Why:** BA is the rarest pattern (6 signals in history) but the loosest gate. All losers had OI<7% and weak price. The unconditional fallback is the core flaw — any token that passes the OI check in the scan loop and misses trend/dip patterns gets BA.

**How to apply:** If BA fires frequently after a change, check if a new prescan layer injects tokens that bypass the OI floor somehow. The fallback in detectSentiment will never be removed (it's structural), so the scanner.ts gates are the only defense.
