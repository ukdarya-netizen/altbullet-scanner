---
name: Personal trade calculator policy
description: Durable product decisions for the dashboard trade calculator and its monthly archive.
---

The trade calculator is personal to each dashboard user and models a percentage of deposit per trade, with leverage and round-trip commission; it does not reinvest in the first version.

**Why:** The user explicitly chose a simple model that explains the signal performance without presenting it as actual brokerage profit.

**How to apply:** Group closed results by `closedAt` in Asia/Dubai. Exclude `breakeven` and `bu_stop` from PnL, averages, and fees while keeping their outcome counts and win-rate role. Keep cancellations without a real entry out of PnL, show them separately, keep open PnL separate, and preserve archived-month parameters.

For a question about what a **fixed cash deposit could actually trade**, do not equate the sum of all signal returns with an executable portfolio. Explicitly choose an entry-admission rule, reserve margin through each position's close, and distinguish open positions from realized results. The product calculator is an unconstrained signal model, not a capacity simulator.

**Why:** Several eligible signals can overlap while the account has insufficient free margin, so later closed winners in an all-signal sum may never have been enterable with the stated deposit.

**How to apply:** State the leverage, margin per trade, whether profits fund later slots, fee assumption, and how skipped signals are chosen. Never present a capital-limited replay as an exact exchange statement; funding, slippage, protective margin top-ups, minimum sizes, and partial fills require actual broker data.