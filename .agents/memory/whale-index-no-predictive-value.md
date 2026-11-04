---
name: Whale Index — no predictive value
description: 2026-07-14 backtest of BTC Whale Index at fire time vs signal outcomes — no correlation after time control; keep informational only, never wire into alphaScore.
---

# Whale Index (CoinGlass BTC 4h) vs signal outcomes — verdict: no predictive value

**Method:** Whale Index is not persisted at fire time, but it is a global BTC 4h series — reconstructed via CoinGlass `/api/futures/whale-index/history` (limit=200 covers ~33 days) and joined to `tracked_signals.detected_at` by 4h candle. 135 fired signals over 21 days (2026-06-23 → 07-14).

**Results:**
- Raw correlation WI vs peakPercent: Pearson -0.255, Spearman -0.278 (t=-3.3 — looks significant but is confounded).
- WI correlates 0.82 with calendar time (market regime trend), and peak% declined over the same period → the raw correlation is a time confound.
- Partial correlation controlling for time: -0.078 (Pearson) / -0.068 (Spearman) ≈ zero.
- Per-week correlations: -0.31, +0.21, +0.12, -0.04 — noise around zero.
- Tercile win rates (peak≥5%): LOW WI 60%, MID 53%, HIGH 27% — again driven by time, not WI.

**Decision:** keep the Whale Index line informational only; do NOT add it as an alphaScore factor.

**Side finding:** observed WI range is -181…+17, not the documented -15…+17. Display thresholds ±3 are miscalibrated — 87% of alerts read "киты продают", the label carries almost no information. If the line is ever kept long-term, recalibrate thresholds to observed quantiles or drop the mood label.

**Why:** a global market-context series shared by all signals in a window cannot rank signals against each other; any apparent correlation with outcomes is regime/time confounding. Re-check any future "market context" factor with partial correlation vs time before adding to scoring.

## Production check after BTC-context tracking

The post-2026-08-21 production cohort does not justify suppressing signals during BTC-down periods. Among known BTC24h snapshots, 49 signals fired with BTC below 0%; PLM had fewer stop losses in that regime than in the non-down comparison, while other patterns were too small or censored by open/reclassified states for a reliable veto.

**Why:** The Telegram global WI line is not persisted with each alert, so an exact WI-period outcome study is unavailable. The stored BTC24h snapshot is a useful market-regime proxy, not proof that the informational WI line caused or prevented execution.

**How to apply:** Continue issuing signals while BTC/WI is unfavorable; keep the warning informational. Do not add a global BTC or WI gate without a separately persisted decision-time context and a sufficiently large, outcome-complete cohort.

## Scale shift in later observations

The July observed range (-181…+17) is not a durable calibration range: the saved BTC observations from 2026-09-22 to 2026-09-26 have WI 64.295…145.09, with all 117 values above +10. A fixed ±10 grouping cannot distinguish any of those observations. For observational forward-price comparisons, divide the available WI cohort into thirds; this is retrospective grouping, not a deployable threshold or evidence of prediction.

**Why:** The WI scale in saved observations changed enough that legacy hardcoded bins collapsed to one group; outcomes from overlapping half-hour samples also share market time.

**How to apply:** Recheck the actual WI distribution and source before interpreting historical WI buckets or comparing them with pattern outcomes. Do not transfer July thresholds into current analytics or trading gates without source and time-controlled validation.
