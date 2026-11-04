---
name: Expired vs Breakeven
description: Durable outcome semantics for positions closed at the maximum signal lifetime.
---

At the maximum four-day lifetime, trailing protection takes precedence and closes as `profit` with its earned floor if crossed; an earned BE/profit stop without trailing closes as `bu_stop` at its protected price. Without protection, a price below entry is `stop_loss`, 0..<5% is `expired` with observed PnL, and ≥5% is `profit`. A core-closed Impulse runner follows its separate five-day lifetime and its already-earned entry-anchored BE or trailing protection. Genuine `breakeven` remains a legacy/manual compatibility enum.

**Why:** The owner changed the universal lifetime policy before a large cohort reached expiry: only unprotected near-flat positions should be called Expired. Protection earned during monitoring must not be discarded by a timeout.

**How to apply:** Apply the same precedence to all lifetime-close paths, including the runner-specific one, without rewriting historical closes. Include `expired` in closed-position totals and raw PnL using its recorded PnL; `bu_stop` remains separate. User-facing UI, Telegram and reports keep the statuses distinct.