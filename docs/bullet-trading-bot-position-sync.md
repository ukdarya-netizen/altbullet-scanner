# Bullet → trading bot: position sync contract (v2, with `sourceAction`)

Bullet does not push exits. The bot polls and acts on `sourceAction`.

## Request

`GET https://crypto-alt-bullet.replit.app/api/trading/position-sync`

Header `x-trading-token` (same token as `POST /api/trading/signals`). Never put
the token in a URL, log, chat, or repository. 503 = token not configured on
Bullet, 401 = missing/wrong token. Read-only: the call changes nothing.

Poll every 1–5 minutes. Read pages of up to 200 accepted signals, starting
without `afterId`; while `nextAfterId` is non-null request
`?afterId=<nextAfterId>`. Match records by `sourceSignalId`
(`cab-signal-<id>`), never by symbol. A record exists only after the receiver
accepted the signal.

## Per-position fields

`sourceSignalId, signalAt, botEnqueuedAt, symbol, initialStopPrice,
sourceStatus, sourceAction, sourceUpdatedAt, sourceClosedAt, sourceEntryPrice,
sourceExitPrice, sourcePnlPercent, sourcePeakPrice, sourceStopLossPrice,
sourceTrailingStopLevel, sourceLastMilestone, sourceCancelReason`.
Null means unavailable, not zero. `sourceUpdatedAt` shows freshness: for open positions it is the later of the last event and the last FastCycle price check (~2 min), so a quiet open position stays fresh; it goes stale only if the tracker stops.

## What the bot must do per `sourceAction`

- `hold` (status `active`/`in_run`): position stays open. Apply the stop rules:
  - `sourceLastMilestone >= breakevenAtPct` (from the signal's `exitRules`,
    5 for altcoins): stop at least at the bot's actual entry price.
  - `sourceTrailingStopLevel` non-null: use it as the stop; it never decreases.
- `close` (status `profit`, `stop_loss`, `bu_stop`, `breakeven`, `expired`,
  with `sourceClosedAt`): Bullet closed the position. Close the whole
  remaining position at market, reduce-only, then confirm on the exchange
  that the position is zero. Do this even if the bot's own trailing did not
  trigger. This is the reconciliation guarantee: a position closed in Bullet
  must not stay open on Bybit.
- `review` (`cancelled`/`reclassified`): dashboard administration, not an
  exit. Do not close automatically; compare with the exchange and flag it.
- `unknown` (tracker row missing): never a close. Flag it.

`sourceExitPrice`, `sourcePnlPercent` and the other `source*` prices are
Bullet's tracker values, not the bot's fills; keep the bot's own entry,
fill, PnL and core/runner state. Fail loudly (log + alert) on poll errors,
stale `sourceUpdatedAt`, or any position that is open on the exchange while
Bullet says `close`.

This API does not repair positions already open in the bot; the first poll
after integration will return `close` for every already-closed signal that
the bot still holds.
