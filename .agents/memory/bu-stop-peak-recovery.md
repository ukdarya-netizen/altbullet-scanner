---
name: B.E. recovery from durable peaks
description: How position protection must recover when a process stops between peak and milestone writes.
---

For active positions, a durable peak that crossed the pattern-specific B.E. threshold is sufficient evidence that B.E. protection was earned, even when the milestone field is missing.

**Why:** A watcher outage can occur after the peak is persisted but before the milestone write. Treating only the milestone as evidence lets the restarted worker misclassify a protected return as an ordinary stop loss.

**How to apply:** Recover the milestone from the persisted peak before evaluating exits, and ensure every early stop-loss path yields to a protected B.E. exit. Keep the Bullish Accumulation threshold at 10%; standard patterns use 5%.