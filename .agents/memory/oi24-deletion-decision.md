---
name: OI24 pattern deleted, OI2д kept
description: Statistics-based deletion of oi24h_accumulation (2026-07-15) and the backtest method/results behind it; daily_oi_accum_experiment is the surviving variant.
---

# Decision (2026-07-15)

`oi24h_accumulation` (OI24, 3-day monotonic OI growth) fully deleted; `daily_oi_accum_experiment` (OI2д, 2 days ≥8%/day + price gate 0..+10%) kept as live experiment.

**Why:** three independent negative results converged for OI24:
- Live prod, 6 days: 24 fires, 15 closed, avg −5%/trade (1 profit vs 4 stops).
- Fresh 90d backtest (Coinalyze daily OI + BingX klines, 344 syms, first-touch +5% target vs −8% stop, 5d): live variant EV −1.56% vs baseline −0.35%, stop rate 46.5%. ALL strengthening variants (no-accel, 5% threshold, price gates 0..10%/0..5%/−2..5%) also negative — nothing to salvage.
- The pattern DOES raise peak-probability (64.6% vs 53.7%, z=9.8) but it's a volatility filter: drawdown arrives before the peak, so stops fire first. First-touch metric, not peak-based, is the honest evaluator.

OI2д was the ONLY positive variant: EV +0.56%, target 63% vs stop 29.6%, n=81 (z≈2.3). The 0..+10% price gate is essential — without it EV −2.01%. Promotion decision after 2–3 weeks of live stats.

**How to apply:**
- Do not resurrect 3-day monotonic OI growth as a signal trigger; if revisiting daily-OI ideas, start from the OI2д shape (fewer days, hard price gate).
- Type `oi24h_accumulation` kept in the pattern union + label maps + sentiment-badge for DB history display; `daily_oi_accum_experiment` shares the same Telegram image asset.
- `oi_daily_snapshots` pipeline (saveDailyOiSnapshots) must stay — OI2д depends on it.
- `triggerTf: "oi24h_accum"` in scanner.ts is Layer 8 OI Watch seeding — unrelated mechanism with a confusingly similar name, was intentionally NOT touched.
- Backtest method: evaluate pattern variants with first-touch target-vs-stop EV against an all-symbol-days baseline, not win-rate-at-peak; peak-based metrics flatter volatility filters.
