# Bullet → Bybit trading bot (PAPER)

This is a **standalone, runnable receiver**, not a replacement for Bullet's
sender and not the earlier ingress-only example. It accepts authenticated
Bullet v2 signals, durably queues them in PostgreSQL, executes a PAPER entry,
tracks the position against Bybit's public price feed, and applies the saved
exit plan. It does **not** place real orders. The `PAPER_ONLY_SIGNAL` guard is
enforced at startup and in the worker.

## Run

Requirements: Node.js 22+, PostgreSQL, a private shared ingest token.

1. Create a **dedicated bot database**; apply `schema.sql` to it once, after
   reviewing the SQL. The schema seeds a $100 PAPER account once and will not
   reset it on restart. Do not apply this schema to Bullet's production database.
2. Install this folder's dependencies with `pnpm install`.
3. Supply `DATABASE_URL` and `TRADING_INGEST_TOKEN` through Replit Secrets or
   the deployment's secret manager. Do not put either in a source file. Keep
   `PAPER_ONLY_SIGNAL=true` (or leave unset); never set `EXECUTION_MODE=live`.
4. Run `pnpm start`; the server binds to `PORT` (default 3003).
5. Run `pnpm test` for offline contract, exit-rule, HTTP, and adapter tests.

Routes:

- `POST /api/trading/signals` — requires `x-trading-token`. A successful
  `202 {accepted:true,signal:{status:"pending",sourceSignalId}}` for a new
  signal proves a **durable enqueue**, not a fill. Idempotent retries return
  the stored status; reusing an ID with changed content gets 409.
- `GET /api/trading/status` — same token; current PAPER wallet, recent signal
  results and open/closed position snapshots, including simulated realized PnL.
- `GET /healthz` — liveness and explicit PAPER mode.

Only fresh (≤10 minutes), confirmed, approved signals for
`liquidation_cascade`, `price_led_momentum`, `impulse_buy`, or
`neon_support_bounce` pass ingress. New `balanced_grind` entries are rejected;
already persisted Balanced Grind positions remain manageable from their saved
exit snapshots. Unknown or non-approved patterns, changed exit versions,
legacy `corePct/runnerPct`, and stale signals fail closed. The worker checks
freshness again **before** an entry. Never replay the frozen samples from
Bullet's public contract: they have expired. No historical backfill or
automatic retransmission of rejected old events is implemented.

The worker validates the actual Bybit instrument filters in PAPER mode and
rejects orders whose quantity, stop tick, or minimum notional cannot be
honored, or whose entry quote would require more than $100 notional for the
contracted $10 initial margin at 10x. This is a separate execution result; a `202` alone is not proof that
the exchange would accept the order. There are no placeholders for
`supportsPlan` or `enqueue`: the validated contract is implemented in
`contract.mjs`, and `store.mjs` commits the queue before HTTP acknowledges.

The PAPER wallet starts at $100 and atomically reserves $10 per accepted
entry. Released collateral and simulated PnL are applied once on partial or
full exits. These figures omit fees, slippage, funding, liquidation, and
margin top-ups; they are **not** a live or guaranteed PnL statement. Partial
profit *advice* does not execute a sale. Impulse Buy uses 80% core and
20% runner; BTC uses its separate +1/+2/1-point ladder. The worker observes
public ticker prices every 3 seconds, not exchange order fills or continuous
intrabar highs/lows.

## Scope of the live adapter

`bybit.mjs` implements signed Bybit V5 calls, instrument checks, isolated
mode/leverage setup, entry with an attached stop, position/order inspection,
reduce-only closes, stop changes and adding margin. **These methods are
offline-tested with mocked HTTP; they are not wired to live execution.**
Actual exit-order reconciliation, especially maintaining an independent
Impulse Buy runner after its core closes, and top-ups sufficient to protect
the stop require exchange testnet evidence before the live guard can be
removed. Disabling `PAPER_ONLY_SIGNAL` currently stops the service instead
of enabling trades. A queued receipt cannot be used as approval to trade.

This checked-in handoff does not prove that the separately deployed
`https://bybit-trading-bot.replit.app` receiver has been updated. Bullet's
existing relay still points there. Publishing this separate code will **not**
automatically switch the relay or change the deployed receiver's allowlist.
Verify the actual PAPER deployment and its persistence before treating Neon
Support as executable there; change a production sender destination only as a
deliberate, separately verified action.