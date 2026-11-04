import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import express from "express";
import cors from "cors";
import {
  createTradingPositionSyncRouter,
  deriveTradingSourceAction,
  isTradingBotToken,
} from "../src/routes/trading-position-sync.js";

const TEST_TOKEN = "test-receiver-token-not-a-secret";

test("bot token comparison rejects missing and incorrect credentials", () => {
  assert.equal(isTradingBotToken(TEST_TOKEN, TEST_TOKEN), true);
  assert.equal(isTradingBotToken(undefined, TEST_TOKEN), false);
  assert.equal(isTradingBotToken(TEST_TOKEN, undefined), false);
  assert.equal(isTradingBotToken("dashboard-admin", TEST_TOKEN), false);
});

test("only the bot can read position snapshots, even with a dashboard cookie", async () => {
  const calls: number[] = [];
  const app = express();
  app.use(
    "/api/trading/position-sync",
    createTradingPositionSyncRouter({
      token: () => TEST_TOKEN,
      read: async (afterId) => {
        calls.push(afterId);
        return {
          asOf: "2026-09-28T00:00:00.000Z",
          positions: [
            {
              sourceSignalId: "cab-signal-12",
              signalAt: "2026-09-27T00:00:00.000Z",
              botEnqueuedAt: "2026-09-27T00:00:05.000Z",
              symbol: "BTCUSDT",
              initialStopPrice: "90000",
              sourceStatus: "in_run",
              sourceUpdatedAt: "2026-09-28T00:00:00.000Z",
              sourceClosedAt: null,
              sourceEntryPrice: 100000,
              sourceExitPrice: null,
              sourcePnlPercent: null,
              sourcePeakPrice: 103000,
              sourceStopLossPrice: 90000,
              sourceTrailingStopLevel: 102000,
              sourceLastMilestone: 3,
              sourceCancelReason: null,
              sourceAction: "hold",
            },
          ],
          nextAfterId: null,
        };
      },
    }),
  );
  app.use(cors());
  app.use("/api", (_req, res) => res.status(401).json({ error: "dashboard" }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/trading/position-sync`;

  try {
    const noToken = await fetch(url, {
      headers: {
        cookie: "dashboard_session=owner",
        origin: "https://other.site",
      },
    });
    assert.equal(noToken.status, 401);
    assert.equal(noToken.headers.get("access-control-allow-origin"), null);
    assert.equal(noToken.headers.get("cache-control"), "no-store");
    assert.equal((await noToken.text()).includes("BTCUSDT"), false);
    assert.equal(
      (await fetch(url, { headers: { "x-trading-token": "bad" } })).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${url}?afterId=-1`, {
          headers: { "x-trading-token": TEST_TOKEN },
        })
      ).status,
      400,
    );
    assert.deepEqual(calls, []);

    const allowed = await fetch(`${url}?afterId=11`, {
      headers: { "x-trading-token": TEST_TOKEN, origin: "https://other.site" },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), null);
    const body = await allowed.json();
    assert.ok(
      typeof body === "object" &&
        body !== null &&
        "positions" in body &&
        Array.isArray(body.positions),
    );
    assert.equal(body.positions[0].sourceSignalId, "cab-signal-12");
    assert.equal(body.positions[0].sourceStatus, "in_run");
    assert.equal(body.positions[0].sourceTrailingStopLevel, 102000);
    assert.deepEqual(calls, [11]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("missing bot configuration fails closed", async () => {
  const app = express();
  app.use(
    "/api/trading/position-sync",
    createTradingPositionSyncRouter({
      token: () => undefined,
      read: async () => {
        throw new Error("must not read data");
      },
    }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/trading/position-sync`,
    );
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("source action: real closes close, administration is only review", () => {
  const at = new Date();
  assert.equal(deriveTradingSourceAction("profit", at), "close");
  assert.equal(deriveTradingSourceAction("stop_loss", at), "close");
  assert.equal(deriveTradingSourceAction("profit", null), "review");
  assert.equal(deriveTradingSourceAction("reclassified", null), "review");
  assert.equal(deriveTradingSourceAction("cancelled", at), "review");
  assert.equal(deriveTradingSourceAction("in_run", null), "hold");
  assert.equal(deriveTradingSourceAction(null, null), "unknown");
});
