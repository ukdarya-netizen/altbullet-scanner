---
name: Profit-lock shadow directionality
description: Rules for observational +10% to +5% protected-profit analytics across long and short signals.
---

The protected-profit shadow must keep its own activation peak once activated and must compute actual close PnL from direction and entry/exit prices. A virtual hit is a fill at the locked +5% level, not the first sampled price beyond it.

**Why:** The general tracked peak is historically long-oriented, so a short's favorable low can be lost after a rebound. Recording the sampled crossing price also mixes slippage-like observation delay into a counterfactual fixed-stop outcome.

**How to apply:** For any later profit-lock report, preserve the activation-derived directional peak through hit, close, and restart reconciliation. Compare actual close PnL against the fixed virtual locked PnL; keep both values observational only.

The live scanner must hydrate active profit-lock activations once into a bounded process cache rather than perform a database lookup per open signal on every FastCycle. If a terminal shadow write cannot complete, periodic reconciliation must reconstruct the direction-aware extrema from durable price trajectories.

**Why:** Per-signal observational reads compete with stops and exits for the same database pool. A short's favorable minimum is not recoverable from the legacy long-oriented peak field alone after an interrupted terminal write.

**How to apply:** Keep pending activations retryable in memory during the process, and use trajectory extrema only in bounded startup/background reconciliation—not in the live decision path.

Profit-lock EV must use the full activation cohort, not only rows where the virtual +5% stop fired. For each completed activation, use +5% only when the hit happened before the real close; otherwise retain actual close PnL. Keep open activations separate and exclude inactive patterns.

**Why:** A hit-only report has survivor bias and cannot answer whether +10% → +5% improves total strategy PnL. A late or post-close hit must never rewrite the counterfactual outcome.

**How to apply:** Report actual versus candidate average and total PnL, helped/hurt counts, lost realized upside, and post-hit trajectory coverage. Block pattern recommendations until at least 20 completed virtual hits.