import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

process.env.SESSION_SECRET = "cancellation-replay-route-test-secret";

const { createCancellationReplayHandler } =
  await import("../src/routes/cancellation-replay.js");
const app = express();

type QueryResult = { rows: Record<string, unknown>[] };

async function startTestServer(): Promise<{
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

test("cancellation replay preserves observation timing labels at the route boundary", async () => {
  const queryResults: QueryResult[] = [
    {
      rows: [
        {
          total: 3,
          measured: 2,
          pending: 1,
          timestamped: 1,
          observation_time_unavailable: 1,
          recovered_10_plus: 2,
          avg_observed_at_or_after_72h_pct: 12.5,
        },
      ],
    },
    {
      rows: [
        {
          pattern: "balanced_grind",
          cancel_reason: "stale_oi_vol",
          total: 3,
          measured: 2,
          pending: 1,
          recovered_10_plus: 2,
          avg_observed_at_or_after_72h_pct: 12.5,
        },
        {
          pattern: "bullish_accumulation",
          cancel_reason: "bu_stop",
          total: 1,
          measured: 1,
          pending: 0,
          recovered_10_plus: 1,
          avg_observed_at_or_after_72h_pct: 18,
        },
      ],
    },
    {
      rows: [
        {
          id: 101,
          symbol: "DELAYED-USDT",
          pattern: "balanced_grind",
          status: "cancelled",
          cancel_reason: "stale_oi_vol",
          observed_price_at_or_after_72h_pct: 12.5,
          observed_at: "2026-08-19T12:00:00.000Z",
          observation_hours_after_exit: 74.5,
          observation_label: "observed_at_or_after_72h",
          highlighted: true,
        },
        {
          id: 102,
          symbol: "LEGACY-USDT",
          pattern: "balanced_grind",
          status: "cancelled",
          cancel_reason: "stale_oi_vol",
          observed_price_at_or_after_72h_pct: 15,
          observed_at: null,
          observation_hours_after_exit: null,
          observation_label: "observation_time_unavailable",
          highlighted: true,
        },
        {
          id: 103,
          symbol: "PENDING-USDT",
          pattern: "balanced_grind",
          status: "cancelled",
          cancel_reason: "stale_oi_vol",
          observed_price_at_or_after_72h_pct: null,
          observed_at: null,
          observation_hours_after_exit: null,
          observation_label: "pending",
          highlighted: null,
        },
      ],
    },
    { rows: [] },
    { rows: [] },
  ];
  const executedSql: string[] = [];
  const dialect = new PgDialect();

  app.get(
    "/api/admin/tracker/cancellation-replay",
    createCancellationReplayHandler(
      async (_query: SQL): Promise<QueryResult> => {
        executedSql.push(dialect.sqlToQuery(_query).sql);
        const result = queryResults.shift();
        assert.ok(result, "the route issued an unexpected database query");
        return result;
      },
    ),
  );
  const { server, url } = await startTestServer();

  try {
    const token = jwt.sign({ role: "owner" }, process.env.SESSION_SECRET!);
    const response = await fetch(
      `${url}/api/admin/tracker/cancellation-replay?thresholdPct=10`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      summary: {
        total: number;
        measured: number;
        pending: number;
        timestamped: number;
        observationTimeUnavailable: number;
        recovered10Plus: number;
        recoveredRate: number | null;
        avgObservedAtOrAfter72hPct: number | null;
      };
      byReason: Array<Record<string, unknown>>;
      rows: Array<Record<string, unknown>>;
    };

    assert.deepEqual(body.summary, {
      total: 3,
      measured: 2,
      pending: 1,
      timestamped: 1,
      observationTimeUnavailable: 1,
      recovered10Plus: 2,
      recoveredRate: 1,
      avgObservedAtOrAfter72hPct: 12.5,
    });
    assert.equal(body.rows[0]?.observed_at, "2026-08-19T12:00:00.000Z");
    assert.equal(body.rows[0]?.observation_hours_after_exit, 74.5);
    assert.equal(body.rows[0]?.observation_label, "observed_at_or_after_72h");
    assert.equal(
      body.rows[1]?.observation_label,
      "observation_time_unavailable",
    );
    assert.equal(body.rows[1]?.observed_at, null);
    assert.equal(body.rows[2]?.observation_label, "pending");
    assert.equal(body.rows[2]?.observed_price_at_or_after_72h_pct, null);
    assert.equal(body.summary.recovered10Plus, 2);
    assert.equal(body.byReason[1]?.cancel_reason, "bu_stop");
    assert.match(
      executedSql[2]!,
      /price_72h_after_exit_observed_at AS observed_at/,
    );
    assert.match(executedSql[2]!, /AS observation_hours_after_exit/);
    assert.match(executedSql[2]!, /'observed_at_or_after_72h'/);
    assert.match(executedSql[2]!, /'observation_time_unavailable'/);
    assert.match(executedSql[2]!, /'pending'/);
    assert.match(
      executedSql[1]!,
      /GROUP BY sentiment_key, cancel_reason, status/,
    );
    assert.match(executedSql[1]!, /'bu_stop'/);
    assert.equal(queryResults.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
