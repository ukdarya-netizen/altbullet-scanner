---
name: Neon wait-for-trigger backtest
description: 30-day all-universe backtest of 4H support-zone touch/spring + 1H triggers showed no edge; wait-mode not implemented
---
Oct 2026 backtest (1001 BingX perps, 1H/4H candles, bot zone detector, exit replay on 1H bars): every trigger variant (T1 ATR break, T2 1H BOS, T3 Williams %R(28), T2+T3, T1+T3, spring N=3/6/12) had negative total PnL and good share 6.6–7.6%, vs 2 profit of 13 closed real Neon signals. T4 (aggregated volume) could not be tested: no historical aggregated volume.

**Why:** owner asked for a Neon wait-for-trigger mode; criterion was max total PnL with good share >= current logic; no variant met it, so nothing was implemented.

**How to apply:** do not re-propose price-only triggers on raw zone touches; any retry needs aggregated volume history and a volume-filtered event set.
