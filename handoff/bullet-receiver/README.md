# Copy to the separate trading bot — Crypto Alt Bullet ingress

`ingest.mjs` is a complete, dependency-free **HTTP ingress contract** for Bullet v2; it is **not an exchange executor**. Do not replace the bot's existing order-management code with it. It deliberately refuses `202` until your own executor supports the exact exit plan and a durable, idempotent queue confirms persistence.

Production diagnosis (2026-09-25): Bullet's relay recorded 21 accepted `202` and 21 rejected `400` receipts. The four observed `impulse_buy` events were all rejected; the last two were on 2026-09-25 at 11:37 UTC. Some `liquidation_cascade` and `balanced_grind` events were accepted under the older allowlist, so the sender was not simply offline. The old HTTP-400 response bodies were not saved, so their exact rejection reason is **unknown**. Balanced Grind is now retired for new entries; Neon Support is an approved pattern in this checked-in contract.

## Integrate in your existing Express app

```js
import express from "express";
import { expressBulletHandler } from "./ingest.mjs";

// Use the existing app and database/queue. Do not create a second HTTP server.
app.post(
  "/api/trading/signals",
  express.json({ limit: "32kb" }),
  expressBulletHandler({
    expectedToken: process.env.TRADING_INGEST_TOKEN,
    supportsPlan: async (signal) => {
      // Replace with a real capability check in YOUR executor. True only after
      // paper tests for v2 exits, BTC 1/2/1, and impulse core/runner pass.
      return false;
    },
    enqueue: async (signal) => {
      // Replace with an atomic INSERT/ON CONFLICT in YOUR durable queue.
      // Unique key: signal.sourceSignalId. Return { status: "pending" }
      // only after commit. Never submit a Bybit order inside this callback.
      throw new Error("durable queue not integrated");
    },
  }),
);
```

The example intentionally **does not enable live orders**. Never change the example callbacks to unconditional `true`/`pending` just to make Bullet's sender show a green status. A `202 {accepted:true,signal:{status:"pending"}}` is only an acknowledgement of durable queuing, not a filled order or proof of working exits. An unsupported rule must return a reasoned 422, not a generic 400. Leave `x-trading-token` in Secrets; never copy it into a file or a chat. An incoming event is fresh for at most 10 minutes: do not replay the old sample payloads to a live endpoint.

Once you have the receiving bot's source, replace the example callbacks using its real DB, symbol catalog, queue, and exit worker. Verify paper mode for all four approved patterns, including Neon Support, before enabling actual exchange orders. New Balanced Grind signals must be rejected, while existing saved positions need to retain their original exit management. Actual fills, protective-stop placement, margin top-ups, and subsequent exits need their own exchange-side verification.

Run the offline checks with `node --test handoff/bullet-receiver/ingest.test.mjs` from the Bullet workspace. They use historical JSON bodies only to validate shape; no network calls are made.
