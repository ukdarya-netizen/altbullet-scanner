---
name: Per-pattern exit profiles — whale_ prefix experiment
description: Whale patterns use tighter exit profile (8/12/7 vs global 10/15/10); why, where it's wired, and how to evaluate the experiment.
---

**Rule:** `getExitProfile(sentimentKey)` in watcher-config.ts returns `{firstTarget:8, trailingActivation:12, trailingGap:7}` for any sentimentKey with prefix `whale_` (whale_futures, whale_watch, whale_alert + legacy DB-only key whale_futures_early); everything else gets global defaults `{10,15,10}`. PARTIAL_TARGET=5 stays global.

**Why:** June–July 2026 analysis showed whale entries are accurate (profit 6 / stop 1) but exits leak: 9 signals peaked +6.5..+14.2% yet closed as bu_stop because FIRST_TARGET=10/TRAILING_ACTIVATION=15 were never reached; KAITO (+19.7 peak) and NMR (+20 peak) closed via 4-day timeout. Whale peaks cluster in 12–20%. Accepted risk: runners like ALLO (+201%) may exit earlier on a >7% pullback.

**How to apply:** ALL exit-behavior sites must use the profile, never the raw constants: watcher.ts (startup-reset in_run trailing, startup-reset active→in_run, FastCycle), watcher-formatters.ts (Telegram texts), routes/tracker.ts (live trailingStopLevel). `silent_whale` deliberately does NOT match the prefix. The "guarantee" % in msgTrailingActivated is multiplicative: ((1+act/100)*(1−gap/100)−1)*100.

**Status:** EXPERIMENT started 2026-07-15 — evaluate after 2–3 weeks of live whale signal closures (compare bu_stop rate and avg realized PnL vs pre-change baseline).
