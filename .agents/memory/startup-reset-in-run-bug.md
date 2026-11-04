---
name: runStartupReset active→in_run bug
description: runStartupReset previously reset entryPrice instead of transitioning to in_run when active signal hit FIRST_TARGET during downtime
---

## The rule
In `runStartupReset`, when `status === "active" && pnl >= FIRST_TARGET`, the signal must be transitioned to `in_run` — never reset entryPrice to currentPrice.

**Why:** The old code did `entryPrice = currentPrice, peakPrice = currentPrice, lastMilestone = null` which zeroed out the PnL. FastCycle then saw pnl=0% → never hit FIRST_TARGET again → signal stuck in "active" forever across all deploys.

**How to apply:** The correct update sets `status: "in_run", peakPrice: currentPrice` and keeps entryPrice untouched. Guard with `AND status = 'active'` + RETURNING for dual-process safety.
