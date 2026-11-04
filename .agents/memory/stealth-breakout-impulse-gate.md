---
name: Stealth breakout impulse gate
description: Live fire gate on the breakout candle; current thresholds, calibration evidence and known limits.
---
Since 2026-10-07 (v8) Stealth fire needs: bullish breakout candle, body >= 3% and frozen-range width >= 20% for 1H; body >= 5% and width >= 30% for 4H. BingX price candles only, no CoinGlass dependency (old futures/spot volume 3x gate is gone; its code remains for observations/LC). Reject reason: breakout_candle_not_impulse (stealthVolumeGate.minBodyPct/minRangeWidthPct in entry_metrics).
**Why:** owner asked to calibrate on successful breakouts we do NOT catch, not on our own signals. Independent study (959 BingX perps, 41 days, breakout = close above prior-100-bar high, success = peak >=15% in 48h): body and range width separate winners; aggregated taker ratio, delta, volume ratio and OI change did not (OI only via candle size). 1H body>=3&width>=20: 38% hit, 34% of winners caught; 4H body>=5&width>=30: 37% hit, 48% caught; old volume>=3x caught only 6% (1H)/13% (4H). One market period, in-sample, not a proven edge.
**How to apply:** don't call it proven; ask owner before changing. Study used 100-bar high break, not the exact Pine Auto Range, so live frequency may differ. Verify forward on fired signals; nothing else in the gate should reintroduce volume as a blocker.
Owner 2026-10-08: range-height gate removed for 1H and 4H (minRangeWidthPct=0); only body >=3% (1H) / >=5% (4H). Study: consolidation length in bars did not predict winners (longer = lower hit rate), so no bars gate either. Previous 1H close may be up to 1% above frozen upper.
Qualified arms live 3h. Tokens listed only on Gate/Aster (COOL, APM, TA) are not BingX-only; the volume path then used BingX price bars (still in loadBarsCached).

Owner decisions 2026-10-07: Stealth stop is exactly 8% (PATTERN_MAX_STOP; Telegram, reference page and external relay follow it); all Stealth positions open up to tracker id 2284 are neutral-closed at startup (outside stats). SAND fired at 0.0852 after a +14% 1H candle through frozen level 0.0822 — the bot's range differed from the TradingView range she showed (0.067), so it was a late chase of an earlier move.

SAND 2026-10-07 root cause: armed 1H Auto Range identity (0.0643-0.0822) did not exist in an independent Pine replay (real ranges: 53-bar 0.0719-0.0792 broke down 10-05, 22-bar 0.0649-0.0673 broke up 10-07 01:00 UTC); why live detector produced it is UNKNOWN. Guard added: fire needs fresh BingX 1H replay latest upside breakout within 5% of frozen bounds (fired arms differ <=2.9%); fails closed. 4H not validated/covered.

Owner 2026-10-07: Stealth Breakout is no longer experimental (no "Эксперимент" label/notice); it is relayed to the Bybit bot like every active pattern (relay = all ACTIVE_PATTERN_KEYS). Whale Futures stays experimental.

**2026-10-10 external replay (owner: stop waiting for forward data):** BingX 15m replay of 294 closed-1H Range crossings (Oct 7-10, entry=trigger close, stop 8%): body>=3 → +5% first 48%, >=5 → 61%, >=8 → 64% (n=23/11, tiny). 1H body gate raised 3→5 (4H already 5). Retest-at-level entry and stricter stop did worse. Unfired qualified arms are mostly low-hit (peak>=10% only 9%). `qualified_live_fire_paused` is a misleading catch-all label: arm consumed when gate passed but wider-range/recheck blocked (9 arms, 8 with data: 2 tp10/5 stop) — not an owner pause. `qualified_broadcast_window_conflict` = Stealth's own duplicate signal exists.

**2026-10-10 owner: 4H Range Breakout removed** (AUTO_RANGE_LIVE_ENABLED=false, 4h not a live source). Only 1H Range creates Stealth trades; existing 4H positions/history stay. Supersedes the 1H/4H-both-live notes for new entries.

**2026-10-10 evening:** momentum pass no longer needs OI30m>=+0.04 (live = body>=5 OR p24h>=4). Replay of 309 1H crossings (28 first-touch +10, 57 first-touch -8): live-before caught 9/28 winners (12 losses, EV/decision -0.3), new rule 15/28 (14 losses, +1.3). Body alone is a weak gate (body>=5: 7/28 winners). In-sample, one week, 224 of 309 undecided.
