import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import {
  createScannerBotHealthHandler,
  normalizeHealthDate,
  serializeTelegramDeliveryHealth,
} from "../src/lib/scanner-health.js";

const TEST_SESSION_SECRET = "scanner-bot-health-test-secret";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
const { requireAdminToken } = await import("../src/middleware/adminAuth.js");

async function startTestServer(app: express.Express): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe("scanner bot health date serialization", () => {
  test("serializes oldestAt consistently for Date and PostgreSQL string values", () => {
    const date = new Date("2026-08-25T05:02:30.000Z");
    const rows = serializeTelegramDeliveryHealth([
      {
        recipientRole: "channel",
        status: "retry",
        reason: "network",
        queueClass: "active",
        rows: 1,
        oldestAt: date,
      },
      {
        recipientRole: "direct_chat",
        status: "processing",
        reason: "unknown",
        queueClass: "active",
        rows: 2,
        oldestAt: "2026-08-25T05:02:30.000Z",
      },
    ]);

    assert.deepEqual(
      rows.map((row) => row.oldestAt),
      ["2026-08-25T05:02:30.000Z", "2026-08-25T05:02:30.000Z"],
    );
  });

  test("keeps empty and invalid health dates safe", () => {
    assert.deepEqual(serializeTelegramDeliveryHealth([]), []);
    assert.equal(normalizeHealthDate(null), null);
    assert.equal(normalizeHealthDate("not-a-date"), null);
  });
});

describe("scanner bot health authorized route smoke test", () => {
  test("returns the complete JSON response with delivery dates through the router", async () => {
    const app = express();
    const deliveryDate = new Date("2026-08-25T05:02:30.000Z");
    let pingedDatabase = false;

    app.get(
      "/api/scanner/bot-health",
      requireAdminToken,
      createScannerBotHealthHandler({
        getScannerState: async () => ({
          running: true,
          isScanning: false,
          lastScanAt: deliveryDate,
          nextScanAt: "2026-08-25T05:12:30.000Z",
          lastScanDurationMs: 1200,
          lastFailureAt: null,
          lastFailureReason: null,
          retryAt: null,
          activeMarketLeaseExpiresAt: null,
          marketsScanned: 42,
          scanIntervalMs: 600_000,
          bingxConnected: true,
          telegramConnected: true,
          lastCgTelemetry: null,
          oiWatchInsertErrors: 0,
          cgTimeoutsLastScan: 0,
        }),
        getTelegramDeliveryHealth: async () => [
          {
            recipientRole: "channel",
            status: "retry",
            reason: "network",
            queueClass: "active",
            rows: 1,
            oldestAt: deliveryDate,
          },
          {
            recipientRole: "direct_chat",
            status: "processing",
            reason: "unknown",
            queueClass: "active",
            rows: 2,
            oldestAt: "2026-08-25T05:02:30.000Z",
          },
        ],
        getDiscoveryScannerLeaseStatus: async () => ({
          busy: false,
          ownerToken: null,
          acquiredAt: null,
          heartbeatAt: null,
          expectedExpiryAt: null,
        }),
        getWatcherJobTimings: () => ({
          scanner: {
            label: "Scanner",
            intervalMs: 600_000,
            lastRunAt: deliveryDate.getTime(),
            overdueMs: 0,
          },
        }),
        getApiConnected: () => true,
        pingDatabase: async () => {
          pingedDatabase = true;
        },
        getDbPoolSnapshot: () => ({
          total: 1,
          idle: 1,
          waiting: 0,
          max: 8,
          underPressure: false,
        }),
        getSchedulerPoolSnapshot: () => ({
          total: 1,
          idle: 1,
          waiting: 0,
          max: 1,
          underPressure: false,
        }),
      }),
    );

    const { server, url } = await startTestServer(app);
    try {
      const token = jwt.sign({ role: "owner" }, TEST_SESSION_SECRET);
      const response = await fetch(`${url}/api/scanner/bot-health`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /application\/json/,
      );
      const body = (await response.json()) as {
        scanner: { running: boolean; marketsScanned: number };
        db: { ok: boolean };
        connections: { telegram: boolean };
        telegramDeliveries: Array<{
          recipientRole: string;
          status: string;
          reason: string;
          queueClass: string;
          rows: number;
          oldestAt: string | null;
        }>;
      };

      assert.equal(pingedDatabase, true);
      assert.equal(body.scanner.running, true);
      assert.equal(body.scanner.marketsScanned, 42);
      assert.equal(body.db.ok, true);
      assert.equal(body.connections.telegram, true);
      assert.deepEqual(body.telegramDeliveries, [
        {
          recipientRole: "channel",
          status: "retry",
          reason: "network",
          queueClass: "active",
          rows: 1,
          oldestAt: "2026-08-25T05:02:30.000Z",
        },
        {
          recipientRole: "direct_chat",
          status: "processing",
          reason: "unknown",
          queueClass: "active",
          rows: 2,
          oldestAt: "2026-08-25T05:02:30.000Z",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("returns an empty delivery list without throwing when authorized", async () => {
    const app = express();
    app.get(
      "/api/scanner/bot-health",
      requireAdminToken,
      createScannerBotHealthHandler({
        getScannerState: async () => ({
          running: false,
          isScanning: false,
          lastScanAt: null,
          nextScanAt: null,
          lastScanDurationMs: null,
          lastFailureAt: null,
          lastFailureReason: null,
          retryAt: null,
          activeMarketLeaseExpiresAt: null,
          marketsScanned: 0,
          scanIntervalMs: 600_000,
          bingxConnected: false,
          telegramConnected: false,
          lastCgTelemetry: null,
          oiWatchInsertErrors: 0,
          cgTimeoutsLastScan: 0,
        }),
        getTelegramDeliveryHealth: async () => [],
        getDiscoveryScannerLeaseStatus: async () => ({
          busy: false,
          ownerToken: null,
          acquiredAt: null,
          heartbeatAt: null,
          expectedExpiryAt: null,
        }),
        getWatcherJobTimings: () => ({}),
        getApiConnected: () => false,
        pingDatabase: async () => {},
        getDbPoolSnapshot: () => null,
        getSchedulerPoolSnapshot: () => null,
      }),
    );

    const { server, url } = await startTestServer(app);
    try {
      const token = jwt.sign({ role: "owner" }, TEST_SESSION_SECRET);
      const response = await fetch(`${url}/api/scanner/bot-health`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assert.equal(response.status, 200);
      const body = (await response.json()) as {
        telegramDeliveries: unknown[];
      };
      assert.deepEqual(body.telegramDeliveries, []);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
