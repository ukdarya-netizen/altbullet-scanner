---
name: OI2d backtest results
description: Backtest of daily_oi_accum_experiment over 90 days — priceDeltaPct gate, OI acceleration, base OI size findings
---

# OI2d Backtest Results (2026-07-16, n=155, 106 symbols, 90 days)

## priceDeltaPct gate (most important finding)

| Bucket   | n  | 24h avg | win>0 | win>2% | stop<-5% |
|----------|----|---------|----|-----|-----|
| 0-2%     | 6  | -1.7%   | 17% | 17% | 17% |
| **2-5%** | 11 | +1.7%   | **82%** | 36% | **0%** |
| **5-8%** | 21 | +0.1%   | 62% | 33% | 14% |
| 8-10%    | 11 | -0.4%   | 36% | 27% | 18% |
| 10-15%   | 26 | -1.9%   | 35% | 12% | 12% |
| 15-40%   | 80 | +6.0%*  | 41% | 31% | 34% |

*+6% avg in 15-40% is skewed by TAIKO +493% outlier — without it the bucket is unprofitable.

**Conclusion: cutoff should be >8%, not >5% (deployed 2026-07-16) and not >10% (original).**
- 2-5%: clear sweet spot (82% win, 0 stops)
- 5-8%: acceptable (62% win, avg flat)
- 8%+: clearly bad (<40% win, negative avg)

**Current code: `priceDeltaPct > 5` — deploy pending change to `> 8`**

## OI acceleration (oiD2 > oiD1)

| Group     | n  | 24h avg | win>0 | stop<-5% |
|-----------|----|---------|----|-----|
| нарастает | 80 | +6.4%*  | 46% | 18% |
| замедляет | 75 | -1.0%   | 43% | 29% |

*Again skewed by TAIKO outlier. Acceleration does reduce stop rate (18% vs 29%) — mild positive signal.

## OI magnitude (sum of 2 days)

| Bucket | n  | 24h avg | win>0 |
|--------|----|---------|-------|
| 16-25% | 43 | +1.3%   | 58%   |
| 25-35% | 51 | -1.2%   | 39%   |
| 35-50% | 34 | -0.7%   | 35%   |
| 50%+   | 27 | +17.3%* | 44%   |

Moderate OI (16-25% sum) is best. Very high OI (>35%) is paradoxically worse — likely blow-off top or squeeze.

## Base OI size

| Bucket   | n  | 24h avg | stop<-5% |
|----------|----|---------|---------|
| $1-5M    | 2  | -1.3%   | 0%      |
| $5-20M   | 43 | +10%*   | 28%     |
| $20-100M | 71 | 0.0%    | 25%     |
| $100M+   | 39 | +0.1%   | 15%     |

Large cap ($100M+) has lowest stop rate but near-zero avg — moves smaller. $5-20M has highest avg but also high stops (skewed by outliers).

## Best combo filter

`price2-8% + decel`: n=12, **win>0=92%**, avg=+2.9%, 0 stops — surprisingly the deceleration case is best within 2-8% range (n=12, small sample).

## Data sources used

- CoinGlass `/aggregated-history?interval=1d` for daily OI (returns `time` in ms, fields `open`/`close` as strings)
- BingX `/klines?interval=1d` for price (returns newest-first, need sort ascending)
- Script: `scripts/src/oi2d-backtest.ts`
