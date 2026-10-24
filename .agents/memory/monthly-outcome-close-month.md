---
name: Monthly outcome calendar
description: Defines which calendar month owns a trade that crosses a month boundary.
---

Completed trade outcomes belong to the Asia/Dubai calendar month containing
their close time, not their entry time. Open positions remain associated with
their entry month until they close.

**Why:** A position opened near month-end can realize its outcome in the next
month. Keeping that result in the entry month leaves the current month's
statistics unchanged when the close actually occurs.

**How to apply:** Monthly dashboard totals, pattern breakdowns, PnL, win rate,
and milestone counts must bucket terminal rows by `closedAt` projected to
Asia/Dubai. The daily profitability chart shows exactly one complete calendar
month at a time, starts its cumulative line at zero on day 1, and navigates
between months; never truncate a month with a rolling-day cutoff. Entry-based
analytics may remain explicitly labeled as such.