import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { BingXKline } from "../src/lib/bingx.js";

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_ALTBULLET_SNAPSHOT_INTEGRATION_TESTS === "true";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlWithSearchPath(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  const existingOptions = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existingOptions, `-c search_path=${schema},public`]
      .filter(Boolean)
      .join(" "),
  );
  return url.toString();
}

function makeKlines(intervalMs: number, count: number): BingXKline[] {
  return Array.from({ length: count }, (_, index) => ({
    open: "100",
    high: "101",
    low: "99",
    close: "100",
    volume: "100",
    time: 1_700_000_000_000 + index * intervalMs,
  }));
}

test(
  "AltBullet snapshots retain transient work and finish exactly once",
  { skip: !integrationEnabled },
  async () => {
    assert.ok(integrationDatabaseUrl);
    const schema = `ab_retry_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrlWithSearchPath(
      integrationDatabaseUrl,
      schema,
    );

    const { pool } = await import("@workspace/db");
    const { ensureAltBulletSnapshotRetrySchema } =
      await import("../src/lib/altbullet-snapshot-schema.js");
    const {
      ALT_BULLET_SNAPSHOT_MAX_AGE_MS,
      ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS,
      captureAltBulletIndicatorSnapshot,
    } = await import("../src/lib/altbullet-indicator.js");
    const quotedSchema = quoteIdentifier(schema);

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      await pool.query(`
        CREATE TABLE signals (
          id serial PRIMARY KEY,
          symbol text NOT NULL,
          sentiment_key text
        )
      `);
      await ensureAltBulletSnapshotRetrySchema();
      const expectedSignalColumns = [
        "altbullet_snapshot_requested_at",
        "altbullet_snapshot_claimed_at",
        "altbullet_snapshot_claim_token",
        "altbullet_snapshot_attempt_count",
        "altbullet_snapshot_retry_after",
        "altbullet_snapshot_last_error",
      ];
      const migratedSignalColumns = await pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'signals'
           AND column_name = ANY($1::text[])
         ORDER BY column_name`,
        [expectedSignalColumns],
      );
      assert.deepEqual(
        migratedSignalColumns.rows.map((row) => row.column_name),
        [...expectedSignalColumns].sort(),
        "AltBullet startup migration is missing a signals column",
      );
      const migratedSnapshotColumns = await pool.query<{
        column_name: string;
      }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'altbullet_indicator_snapshots'
         ORDER BY column_name`,
      );
      assert.deepEqual(
        migratedSnapshotColumns.rows.map((row) => row.column_name),
        [
          "audit",
          "captured_at",
          "checks",
          "context",
          "error",
          "id",
          "indicator_version",
          "score",
          "sentiment_key",
          "signal_id",
          "status",
          "symbol",
          "timeframe",
          "verdict",
        ],
        "AltBullet startup migration is missing a snapshot column",
      );

      const requestedAt = new Date();
      const first = await pool.query<{ id: number }>(
        `INSERT INTO signals (
          symbol,
          sentiment_key,
          altbullet_snapshot_requested_at,
          altbullet_snapshot_claimed_at,
          altbullet_snapshot_claim_token,
          altbullet_snapshot_attempt_count
        ) VALUES ($1, $2, $3, $3, $4, 1) RETURNING id`,
        ["TEST-USDT", "balanced_grind", requestedAt, "claim-one"],
      );
      const signalId = first.rows[0]!.id;

      await captureAltBulletIndicatorSnapshot(
        {
          signalId,
          symbol: "TEST-USDT",
          sentimentKey: "balanced_grind",
        },
        { token: "claim-one", attemptCount: 1, requestedAt },
        {
          getKlines: async () => {
            throw new Error("Market request cancelled because its cycle ended");
          },
          now: () => requestedAt,
        },
      );

      const deferred = await pool.query<{
        requested: Date | null;
        claimed: Date | null;
        token: string | null;
        retryAfter: Date | null;
      }>(
        `SELECT
          altbullet_snapshot_requested_at AS "requested",
          altbullet_snapshot_claimed_at AS "claimed",
          altbullet_snapshot_claim_token AS "token",
          altbullet_snapshot_retry_after AS "retryAfter"
        FROM signals WHERE id = $1`,
        [signalId],
      );
      assert.ok(deferred.rows[0]!.requested);
      assert.equal(deferred.rows[0]!.claimed, null);
      assert.equal(deferred.rows[0]!.token, null);
      assert.ok(deferred.rows[0]!.retryAfter);
      assert.equal(
        (await pool.query(`SELECT * FROM altbullet_indicator_snapshots`))
          .rowCount,
        0,
      );

      await pool.query(
        `UPDATE signals
        SET altbullet_snapshot_claimed_at = now(),
            altbullet_snapshot_claim_token = 'claim-two',
            altbullet_snapshot_attempt_count = 2,
            altbullet_snapshot_retry_after = null
        WHERE id = $1`,
        [signalId],
      );
      await captureAltBulletIndicatorSnapshot(
        {
          signalId,
          symbol: "TEST-USDT",
          sentimentKey: "balanced_grind",
        },
        { token: "claim-two", attemptCount: 2, requestedAt },
        {
          getKlines: async (_symbol, timeframe) =>
            makeKlines(
              timeframe === "4h" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000,
              timeframe === "4h" ? 32 : 22,
            ),
        },
      );
      const finalized = await pool.query<{
        requested: Date | null;
        token: string | null;
        status: string;
      }>(
        `SELECT
          s.altbullet_snapshot_requested_at AS "requested",
          s.altbullet_snapshot_claim_token AS "token",
          i.status
        FROM signals s
        JOIN altbullet_indicator_snapshots i ON i.signal_id = s.id
        WHERE s.id = $1`,
        [signalId],
      );
      assert.equal(finalized.rows.length, 1);
      assert.equal(finalized.rows[0]!.requested, null);
      assert.equal(finalized.rows[0]!.token, null);
      assert.equal(finalized.rows[0]!.status, "ready");

      const concurrent = await pool.query<{ id: number }>(
        `INSERT INTO signals (
          symbol,
          altbullet_snapshot_requested_at,
          altbullet_snapshot_claimed_at,
          altbullet_snapshot_claim_token,
          altbullet_snapshot_attempt_count
        ) VALUES ($1, $2, $2, 'shared-claim', 1) RETURNING id`,
        ["RACE-USDT", requestedAt],
      );
      const concurrentSignalId = concurrent.rows[0]!.id;
      const concurrentInput = {
        signalId: concurrentSignalId,
        symbol: "RACE-USDT",
        sentimentKey: null,
      };
      const concurrentClaim = {
        token: "shared-claim",
        attemptCount: 1,
        requestedAt,
      };
      const successfulKlines = async (_symbol: string, timeframe: string) =>
        makeKlines(
          timeframe === "4h" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000,
          timeframe === "4h" ? 32 : 22,
        );
      await Promise.all([
        captureAltBulletIndicatorSnapshot(concurrentInput, concurrentClaim, {
          getKlines: successfulKlines,
        }),
        captureAltBulletIndicatorSnapshot(concurrentInput, concurrentClaim, {
          getKlines: successfulKlines,
        }),
      ]);
      const duplicateCount = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM altbullet_indicator_snapshots
         WHERE signal_id = $1`,
        [concurrentSignalId],
      );
      assert.equal(duplicateCount.rows[0]!.count, "1");

      const insufficient = await pool.query<{ id: number }>(
        `INSERT INTO signals (
          symbol,
          altbullet_snapshot_requested_at,
          altbullet_snapshot_claimed_at,
          altbullet_snapshot_claim_token,
          altbullet_snapshot_attempt_count
        ) VALUES ($1, $2, $2, 'terminal-claim', 1) RETURNING id`,
        ["NEW-USDT", requestedAt],
      );
      const insufficientSignalId = insufficient.rows[0]!.id;
      await captureAltBulletIndicatorSnapshot(
        {
          signalId: insufficientSignalId,
          symbol: "NEW-USDT",
          sentimentKey: null,
        },
        { token: "terminal-claim", attemptCount: 1, requestedAt },
        {
          getKlines: async (_symbol, timeframe) =>
            makeKlines(
              timeframe === "4h" ? 4 * 60 * 60 * 1000 : 60 * 60 * 1000,
              timeframe === "4h" ? 4 : 12,
            ),
        },
      );
      const terminal = await pool.query<{
        requested: Date | null;
        status: string;
        error: string | null;
      }>(
        `SELECT
          s.altbullet_snapshot_requested_at AS "requested",
          i.status,
          i.error
        FROM signals s
        JOIN altbullet_indicator_snapshots i ON i.signal_id = s.id
        WHERE s.id = $1`,
        [insufficientSignalId],
      );
      assert.equal(terminal.rows[0]!.requested, null);
      assert.equal(terminal.rows[0]!.status, "unavailable");
      assert.match(terminal.rows[0]!.error ?? "", /Недостаточно 1H\/4H свечей/);

      let lateFetches = 0;
      const expiredRequestedAt = new Date(
        requestedAt.getTime() - ALT_BULLET_SNAPSHOT_MAX_AGE_MS,
      );
      const expired = await pool.query<{ id: number }>(
        `INSERT INTO signals (
          symbol,
          altbullet_snapshot_requested_at,
          altbullet_snapshot_claimed_at,
          altbullet_snapshot_claim_token,
          altbullet_snapshot_attempt_count
        ) VALUES ($1, $2, $2, 'expired-claim', 1) RETURNING id`,
        ["EXPIRED-USDT", expiredRequestedAt],
      );
      const expiredSignalId = expired.rows[0]!.id;
      await captureAltBulletIndicatorSnapshot(
        {
          signalId: expiredSignalId,
          symbol: "EXPIRED-USDT",
          sentimentKey: null,
        },
        {
          token: "expired-claim",
          attemptCount: 1,
          requestedAt: expiredRequestedAt,
        },
        {
          getKlines: async () => {
            lateFetches += 1;
            return makeKlines(60 * 60 * 1000, 22);
          },
        },
      );

      const overBudget = await pool.query<{ id: number }>(
        `INSERT INTO signals (
          symbol,
          altbullet_snapshot_requested_at,
          altbullet_snapshot_claimed_at,
          altbullet_snapshot_claim_token,
          altbullet_snapshot_attempt_count
        ) VALUES ($1, $2, $2, 'budget-claim', $3) RETURNING id`,
        ["BUDGET-USDT", requestedAt, ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS + 1],
      );
      const overBudgetSignalId = overBudget.rows[0]!.id;
      await captureAltBulletIndicatorSnapshot(
        {
          signalId: overBudgetSignalId,
          symbol: "BUDGET-USDT",
          sentimentKey: null,
        },
        {
          token: "budget-claim",
          attemptCount: ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS + 1,
          requestedAt,
        },
        {
          getKlines: async () => {
            lateFetches += 1;
            return makeKlines(60 * 60 * 1000, 22);
          },
        },
      );
      assert.equal(lateFetches, 0);
      const bounded = await pool.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count
         FROM altbullet_indicator_snapshots
         WHERE signal_id IN ($1, $2)
         GROUP BY status`,
        [expiredSignalId, overBudgetSignalId],
      );
      assert.deepEqual(bounded.rows, [{ status: "unavailable", count: "2" }]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      await pool.end();
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  },
);
