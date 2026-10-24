---
name: PONS-style rapid liquidation rebounds
description: Why early 5m candle reactions near liquidation watches must be studied separately from later trade signals.
---

The user considers the fast PONS rebound the kind of reaction they want to study and potentially trade. Preserve its role as an example, not a calibrated strategy. Capture both LC watches that later fire and those that are rejected, with 5m candle-close confirmation and comparable forward controls; never label a post-confirmation observation as available at watch start.

**Why:** The PONS case showed a sharp 5m wick/recovery overlapping a rise in aggregated liquidation readings, while the tracked LC entry came substantially later. The exchange candle and cross-exchange liquidation estimate do not identify the same trades or prove causality, and a single case cannot determine an entry rule.

**How to apply:** Keep watch-time snapshots, candle confirmation times, and forward outcomes separate. Treat missing candles/liquidation data as unknown; assess comparable cohorts only after sufficient completed outcomes, de-duplicate overlapping watches, and test execution/fees on later unseen events before any trading change.