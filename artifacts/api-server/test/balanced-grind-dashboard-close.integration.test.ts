import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  BALANCED_GRIND_DASHBOARD_CLOSE_REASON,
  BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS,
  neutralizeReviewedBalancedGrindInTransaction,
} from "../src/lib/balanced-grind-dashboard-close.js";

test(
  "neutral dashboard close is exact, idempotent, and excludes PnL",
  { skip: process.env.RUN_BG_DASHBOARD_CLOSE_INTEGRATION_TESTS !== "true" },
  async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("TEST_DATABASE_URL is required");
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        CREATE TEMP TABLE signals (
          id integer PRIMARY KEY, symbol text, sentiment_key text
        ) ON COMMIT DROP;
        CREATE TEMP TABLE tracked_signals (
          id integer PRIMARY KEY, signal_id integer, symbol text,
          sentiment_key text, status text, cancel_reason text,
          runner_state text, core_closed_at timestamptz,
          exit_price real, pnl_percent real, closed_at timestamptz,
          peak_price real, trailing_stop_level real,
          trailing_stop_armed_at timestamptz, last_milestone integer,
          pending_milestone integer, pending_milestone_kind text,
          pending_milestone_price real, pending_milestone_trailing_stop real,
          pending_milestone_status text, pending_milestone_lease_until timestamptz,
          last_smart_cancel_check_at timestamptz, updated_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE milestone_notification_deliveries (
          tracked_signal_id integer, status text, lease_until timestamptz,
          claim_token text, last_error text
        ) ON COMMIT DROP;
        CREATE TEMP TABLE telegram_photo_deliveries (
          dedup_key text, status text, lease_until timestamptz,
          claim_token text, last_error text, updated_at timestamptz,
          send_attempted_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE telegram_delivery_events (
          event_key text, status text, attention_at timestamptz,
          last_error text, updated_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE trading_signal_deliveries (
          source_signal_id integer, status text, claim_token text,
          claim_until timestamptz, last_error text
        ) ON COMMIT DROP
      `);
      assert.equal(BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.length, 3);
      for (const [
        trackedId,
        signalId,
        symbol,
      ] of BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS) {
        await client.query(
          "INSERT INTO signals VALUES ($1, $2, 'balanced_grind')",
          [signalId, symbol],
        );
        await client.query(
          `INSERT INTO tracked_signals
            (id, signal_id, symbol, sentiment_key, status, last_milestone,
             peak_price, trailing_stop_level)
           VALUES ($1, $2, $3, 'balanced_grind', 'active', 5, 10, 9)`,
          [trackedId, signalId, symbol],
        );
      }
      await client.query(`
        INSERT INTO signals VALUES (999, 'OTHER-USDT', 'balanced_grind');
        INSERT INTO tracked_signals
          (id, signal_id, symbol, sentiment_key, status, last_milestone)
        VALUES (999, 999, 'OTHER-USDT', 'balanced_grind', 'active', 5);
        INSERT INTO milestone_notification_deliveries
          VALUES (1908, 'ready', now(), 'token', NULL),
                 (999, 'ready', now(), 'token', NULL);
        INSERT INTO telegram_photo_deliveries (dedup_key, status)
          VALUES ('position:1908:milestone', 'ready'),
                 ('signal:10962', 'retry'),
                 ('position:1931:delivered', 'delivered'),
                 ('position:999:milestone', 'ready');
        INSERT INTO telegram_delivery_events (event_key, status)
          VALUES ('position:1908:milestone', 'pending'),
                 ('signal:10962', 'pending'),
                 ('position:1931:delivered', 'delivered');
        INSERT INTO trading_signal_deliveries (source_signal_id, status)
          VALUES (10118, 'pending'), (10962, 'delivered'),
                 (12636, 'pending'), (999, 'pending')
      `);
      await client.query("SAVEPOINT fixture");
      assert.equal(
        await neutralizeReviewedBalancedGrindInTransaction(client),
        3,
      );
      assert.equal(
        await neutralizeReviewedBalancedGrindInTransaction(client),
        0,
      );
      const state = await client.query(
        "SELECT id, status, cancel_reason, exit_price, pnl_percent, closed_at, last_milestone, peak_price, trailing_stop_level FROM tracked_signals ORDER BY id",
      );
      assert.deepEqual(
        state.rows.map((row) => [
          row.id,
          row.status,
          row.cancel_reason,
          row.exit_price,
          row.pnl_percent,
          row.closed_at,
          row.last_milestone,
          row.peak_price,
          row.trailing_stop_level,
        ]),
        [
          [999, "active", null, null, null, null, 5, null, null],
          ...BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.map(([id]) => [
            id,
            "reclassified",
            BALANCED_GRIND_DASHBOARD_CLOSE_REASON,
            null,
            null,
            null,
            5,
            10,
            9,
          ]),
        ],
      );
      const photos = await client.query(
        "SELECT dedup_key, status FROM telegram_photo_deliveries ORDER BY dedup_key",
      );
      assert.deepEqual(
        photos.rows.map(({ dedup_key, status }) => [dedup_key, status]),
        [
          ["position:1908:milestone", "abandoned"],
          ["position:1931:delivered", "delivered"],
          ["position:999:milestone", "ready"],
          ["signal:10962", "abandoned"],
        ],
      );
      const relay = await client.query(
        "SELECT source_signal_id, status FROM trading_signal_deliveries ORDER BY source_signal_id",
      );
      assert.deepEqual(
        relay.rows.map(({ source_signal_id, status }) => [
          source_signal_id,
          status,
        ]),
        [
          [999, "pending"],
          [10118, "quarantined"],
          [10962, "delivered"],
          [12636, "quarantined"],
        ],
      );

      // The earlier rollout cleared historical observations. Replaying the
      // correction restores only known values on the three reviewed rows.
      await client.query("ROLLBACK TO SAVEPOINT fixture");
      await client.query(
        `UPDATE tracked_signals
            SET status = 'reclassified', cancel_reason = $1,
                peak_price = NULL, last_milestone = NULL
          WHERE id = ANY($2::integer[])`,
        [
          BALANCED_GRIND_DASHBOARD_CLOSE_REASON,
          BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.map(([id]) => id),
        ],
      );
      assert.equal(
        await neutralizeReviewedBalancedGrindInTransaction(client),
        0,
      );
      const restored = await client.query(
        `SELECT id, status, peak_price, last_milestone, pnl_percent
           FROM tracked_signals WHERE id = ANY($1::integer[]) ORDER BY id`,
        [BALANCED_GRIND_DASHBOARD_CLOSE_TARGETS.map(([id]) => id)],
      );
      assert.deepEqual(
        restored.rows.map(({ id, status, last_milestone, pnl_percent }) => [
          id,
          status,
          last_milestone,
          pnl_percent,
        ]),
        [
          [1908, "reclassified", 5, null],
          [1931, "reclassified", 5, null],
          [1971, "reclassified", null, null],
        ],
      );
      for (const [id, peakPrice] of [
        [1908, 0.04567],
        [1931, 0.02247],
        [1971, 0.01196],
      ]) {
        const found = restored.rows.find((item) => item.id === id);
        assert.ok(found);
        assert.ok(Math.abs(found.peak_price - peakPrice) < 1e-7);
      }

      // A naturally closed position keeps its real result; the other two
      // positions still close neutrally. A mismatched lineage aborts all work.
      await client.query("ROLLBACK TO SAVEPOINT fixture");
      await client.query(
        "UPDATE tracked_signals SET status = 'profit', exit_price = 2, pnl_percent = 12 WHERE id = 1908",
      );
      assert.equal(
        await neutralizeReviewedBalancedGrindInTransaction(client),
        2,
      );
      const natural = await client.query(
        "SELECT status, exit_price, pnl_percent FROM tracked_signals WHERE id = 1908",
      );
      assert.deepEqual(natural.rows[0], {
        status: "profit",
        exit_price: 2,
        pnl_percent: 12,
      });
      await client.query("ROLLBACK TO SAVEPOINT fixture");
      await client.query(
        "UPDATE signals SET symbol = 'WRONG-USDT' WHERE id = 10118",
      );
      await assert.rejects(
        neutralizeReviewedBalancedGrindInTransaction(client),
        /lineage mismatch/,
      );
      const unchanged = await client.query(
        "SELECT COUNT(*)::int AS n FROM tracked_signals WHERE status = 'active'",
      );
      assert.equal(unchanged.rows[0].n, 4);

      await client.query("ROLLBACK TO SAVEPOINT fixture");
      await client.query("SET LOCAL search_path = pg_temp");
      await client.query("DROP TABLE trading_signal_deliveries");
      assert.equal(
        await neutralizeReviewedBalancedGrindInTransaction(client),
        3,
      );
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
);
