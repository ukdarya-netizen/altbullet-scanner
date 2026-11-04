---
name: whale_alert no_price_30m false cancellation
description: priceMap || 0 bug caused false no_price_30m cancels for symbols with valid BingX listing but temporarily 0 price
---

## Rule
Fast cycle priceMap must separate "symbol absent from BingX" (→ no_price_30m eligible)
from "symbol present but price=0" (→ skip cycle, not cancel).

## How to apply
Build two structures from the BingX ticker response:
- `knownOnBingX = new Set<string>()` — ALL symbols, even price=0
- `priceMap = new Map<string, number>()` — only symbols with price > 0

The no_price_30m cancel gate must check `!knownOnBingX.has(symbol)` before cancelling.
Symbols with price=0 that ARE in the BingX ticker list: skip cycle silently.

**Why:** BingX occasionally returns lastPrice="0" for briefly-halted or newly-listed
symbols. The old `|| 0` default stored 0 in priceMap, making `!0 = true` trigger the
"not on BingX" cancel path. Affected whale_alert signals for HYPE, SOL, NEAR.

## Also fixed in same session
- `_runWhaleAlertFireCycle`: trackSignal returning "skip" was not guarded → fell through
  to broadcastBatchAlert + markWhaleAlertFired. Added explicit `if (tracked === "skip") continue`
  before broadcast to prevent duplicate TG + premature pool "fired" mark.
- no_price_30m TG broadcast: changed `.catch(() => {})` to log warn for visibility.
- tracker.tsx: added ПРИЧИНА (cancelReason) column to "ОТМЕНЕНО СЕГОДНЯ" table.
