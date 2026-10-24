---
name: Concurrent position quality target
description: Target of at most 30 open positions through signal quality, not a hard admission cap.
---

The user's newer goal is **at most 30 simultaneously open positions through better signal selection**, not a hard cap. Reduce B.U. exits and favor realized profit **strictly above 10%** per trade. Do not discard the 31st otherwise qualifying signal solely because 30 are open.

**Why:** The previous policy rejected hard portfolio-capacity limits after a Liquidation Cascade cap silently discarded valid candidates. The user explicitly chose better selection rather than a hard limit; a first-come cap could still reject the best entry without improving quality.

**How to apply:** First measure concurrent open positions and evaluate evidence-based quality gates on realized >10% retention, stops, B.U. and signal frequency. Duplicate events and already-active same-symbol signals may still be rejected. Keep operational concurrency controls distinct from a trading admission cap.