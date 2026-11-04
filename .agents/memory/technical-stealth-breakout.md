---
name: Technical Stealth Breakout
description: The durable identity and calibration boundary for the Stealth Breakout pattern.
---

**Historical rule (superseded for new entries):** The earlier Stealth technical test used local 4H resistance or quiet-zone levels. Since 2026-09-27 only 4H Range Breakout can create new Stealth trades; see [Auto Range timeframe policy](auto-range-1h-rollout-decision.md). Keep these older rules for interpreting archived Resistance decisions, not for creating new signals.

**Why:** ZORA and INX showed that a 1H-only cross can look like a breakout while the 4H chart still shows only a support bounce or ordinary range movement. The traded event must therefore exist on the strategy timeframe itself.

**How to apply:** Preserve the frozen 4H resistance → later closed 4H crossing → 30m refinement order. A 1H cross, forming 4H candle, or 30m state must never create the signal. Select an actionable valid local 4H level rather than forcing the absolute high. Retain flow metrics in diagnostic data and label the test signals clearly, but do not reintroduce them as gates until the new cohort is reviewed.

**Temporary lifecycle rule:** Stealth Breakout does not use automatic cancellation paths while this technical cohort is being collected. This includes unavailable-price, stale, smart, and maximum-age cancellation; normal stop-loss, target, break-even, and trailing exits still apply.

**Why:** The user wants the structure-only experiment to reach a real trade outcome without its sample being shortened by market-health cancellation heuristics from older pattern logic.

**How to apply:** Keep the no-auto-cancel setting pattern-scoped and remove or revisit it only after the technical cohort is reviewed. Do not restore historical cancelled positions as part of this experiment.

**Replay boundary rule:** In a historical replay, emit a Stealth event only when the current closed-1H evaluation candle is its canonical first crossing; never backfill it from a later lifecycle re-evaluation.

**Why:** Lifecycle recovery can find an older crossing after later 4H/30m candles arrive. Backfilling would attach future structure and entry data to that earlier timestamp, corrupting the technical decision, outcomes, period summaries, and comparisons.

**How to apply:** After deriving the canonical crossing timestamp, require it to equal the current evaluation time and enforce the requested inclusive range before emitting; retain a regression case where a later evaluation can rediscover an earlier crossing.

**Prefetch resilience rule:** A 3-minute global market-prefetch timeout means a missing 4H/1H series is inconclusive, not genuine insufficient history. Recovery may fetch only the missing Stealth timeframes for a bounded number of symbols and must keep the normal 4H → closed 1H → 30m decision unchanged.

**Why:** A partial cache previously made every untouched symbol appear to have insufficient 4H/1H candles, silently suppressing valid technical breakouts during a slow CoinGlass pre-warm.

**How to apply:** Enable the bounded fallback only after the global prefetch actually timed out; use the shared market request budget and retain diagnostic logs for the timeout, per-symbol latency, and recovery result. Do not retry when a complete prefetch merely returned real short history, and do not turn recovery into an extra entry gate.

**Telegram rule:** Never send a standalone Stealth TA observation, pre-signal breakout notice, or “not a trading signal” message. Telegram receives Stealth only when the scanner emits the actual trading signal; that signal carries the experimental/testing notice.

**Why:** The requested experiment is a label on real Stealth signals, not a separate watchlist notification stream.

**How to apply:** Keep technical structure evaluation internal until every trading confirmation passes. Any old `stealth-ta:*` outbox delivery must remain quarantined; do not add an observation reconciler or another pre-signal send path.

**Fresh lifecycle rule:** Create ARMED only before a closed 4H breakout of the frozen resistance. Evaluate each later closed 4H candle only against its immediate prior closed 4H candle: it qualifies when the prior close is at/below the level and the current close is decisively above tolerance. A weak cross must not mask a later decisive cross.

**Why:** Broad trendline projection previously armed structures that had already broken out or drifted above resistance, then allowed old qualified setups to be reconsidered days later. Historical NEO/YGG and current HUMA/S show that real breakouts still have a decisive first hourly impulse; the historical event is a positive control, not permission to fire its old level again.

**How to apply:** Keep resistance identity frozen across ARMED → terminal, and mark every consumed outcome durably. Administrative false-breakout cleanup must use exact historical row/setup identities and the neutral `reclassified` lifecycle, which is excluded from open positions and trade-performance totals.

**Setup ownership rule:** The original 4H `analyzeStealthStructure` quiet-zone detector again owns candidate discovery and the level frozen into new ARMED rows. ABNeon remains observational and must not block setup creation.

**Why:** The old detector found the quiet zone reliably; the unresolved weakness was breakout identification. Making ABNeon readiness a setup gate mixed those two stages and suppressed the useful detector.

**How to apply:** Keep setup detection and breakout confirmation separate: 4H quiet zone → frozen local 4H resistance → later fresh closed-4H crossing → 30m refinement. Preserve TTL, freshness, dedup, consumed-state, and stale-cross protections while calibrating the breakout stage independently.