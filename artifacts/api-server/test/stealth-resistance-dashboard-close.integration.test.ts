import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";
import {
  STEALTH_RESISTANCE_NEUTRAL_CLOSE_REASON,
  STEALTH_RESISTANCE_NEUTRAL_CLOSE_TARGETS,
  neutralizeReviewedStealthResistanceInTransaction,
} from "../src/lib/stealth-resistance-dashboard-close.js";

test(
  "reviewed Resistance positions move to history without PnL or lost observations",
  {
    skip: process.env.RUN_STEALTH_RESISTANCE_NEUTRAL_CLOSE_TESTS !== "true",
  },
  async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("TEST_DATABASE_URL is required");
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
          peak_price real, last_milestone integer, entry_fut_vol_mult real,
          trailing_stop_level real, trailing_stop_armed_at timestamptz,
          pending_milestone integer, pending_milestone_kind text,
          pending_milestone_price real, pending_milestone_trailing_stop real,
          pending_milestone_status text, pending_milestone_lease_until timestamptz,
          last_smart_cancel_check_at timestamptz, updated_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE stealth_breakout_armed_setups (
          id integer PRIMARY KEY, fired_signal_id integer, symbol text,
          level_source text, status text, terminal_reason text,
          entry_volume_snapshot jsonb, updated_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE milestone_notification_deliveries (
          tracked_signal_id integer, status text, lease_until timestamptz,
          claim_token text, last_error text
        ) ON COMMIT DROP;
        CREATE TEMP TABLE telegram_photo_deliveries (
          dedup_key text, status text, send_attempted_at timestamptz,
          lease_until timestamptz, claim_token text,
          last_error text, updated_at timestamptz
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
      for (const [
        trackedId,
        signalId,
        armId,
        symbol,
        levelSource,
      ] of STEALTH_RESISTANCE_NEUTRAL_CLOSE_TARGETS) {
        await client.query(
          "INSERT INTO signals VALUES ($1,$2,'stealth_breakout')",
          [signalId, symbol],
        );
        await client.query(
          `INSERT INTO tracked_signals
           (id, signal_id, symbol, sentiment_key, status, peak_price,
            last_milestone, entry_fut_vol_mult)
           VALUES ($1,$2,$3,'stealth_breakout','active',10,5,2.3)`,
          [trackedId, signalId, symbol],
        );
        await client.query(
          `INSERT INTO stealth_breakout_armed_setups
           (id, fired_signal_id, symbol, level_source, status,
            entry_volume_snapshot)
           VALUES ($1,$2,$3,$4,'fired','{"futVolMult":2.3}'::jsonb)`,
          [armId, signalId, symbol, levelSource],
        );
      }
      // Natural outcomes and partially realized runners must retain their
      // real trading state. A later signal with the same symbol is not targeted.
      await client.query(
        "UPDATE tracked_signals SET status = 'profit', pnl_percent = 8 WHERE id = 1936",
      );
      await client.query(
        "UPDATE tracked_signals SET runner_state = 'open', core_closed_at = now() WHERE id = 1937",
      );
      await client.query(`
        INSERT INTO signals VALUES (999, 'AGI-USDT', 'stealth_breakout');
        INSERT INTO tracked_signals
          (id, signal_id, symbol, sentiment_key, status)
        VALUES (999, 999, 'AGI-USDT', 'stealth_breakout', 'active');
        INSERT INTO stealth_breakout_armed_setups
          (id, fired_signal_id, symbol, level_source, status)
        VALUES (999, 999, 'AGI-USDT', 'auto_range_4h', 'fired');
        INSERT INTO milestone_notification_deliveries
          VALUES (1965, 'ready', now(), 'claim', NULL),
                 (999, 'ready', now(), 'claim', NULL);
        INSERT INTO telegram_photo_deliveries (dedup_key, status)
          VALUES ('position:1965:milestone', 'ready'),
                 ('signal:12368', 'retry'),
                 ('signal:11550', 'delivered'),
                 ('position:999:milestone', 'ready');
        INSERT INTO telegram_delivery_events (event_key, status)
          VALUES ('position:1965:milestone', 'pending'),
                 ('signal:12368', 'pending'),
                 ('signal:11550', 'delivered');
        INSERT INTO trading_signal_deliveries (source_signal_id, status)
          VALUES (12368, 'pending'), (999, 'pending')
      `);
      const result =
        await neutralizeReviewedStealthResistanceInTransaction(client);
      assert.deepEqual(result, {
        moved: 10,
        alreadyClosed: [1936],
        partialRunners: [1937],
        missing: [],
      });
      const rows = await client.query(
        `SELECT t.id, t.status, t.cancel_reason, t.pnl_percent, t.closed_at,
                t.peak_price, t.last_milestone, t.entry_fut_vol_mult,
                a.status AS arm_status, a.entry_volume_snapshot
           FROM tracked_signals t
           JOIN stealth_breakout_armed_setups a ON a.fired_signal_id = t.signal_id
          WHERE t.id IN (1935, 1936, 1937, 1941, 1965, 999)`,
      );
      const byId = new Map(rows.rows.map((row) => [row.id as number, row]));
      for (const id of [1935, 1941, 1965]) {
        const row = byId.get(id)!;
        assert.equal(row.status, "reclassified");
        assert.equal(
          row.cancel_reason,
          STEALTH_RESISTANCE_NEUTRAL_CLOSE_REASON,
        );
        assert.equal(row.pnl_percent, null);
        assert.equal(row.closed_at, null);
        assert.equal(row.peak_price, 10);
        assert.equal(row.last_milestone, 5);
        assert.equal(row.entry_fut_vol_mult, 2.3);
        assert.equal(row.arm_status, "reclassified");
        assert.deepEqual(row.entry_volume_snapshot, { futVolMult: 2.3 });
      }
      assert.equal(byId.get(1936)?.status, "profit");
      assert.equal(byId.get(1936)?.pnl_percent, 8);
      assert.equal(byId.get(1937)?.status, "active");
      assert.equal(byId.get(999)?.status, "active");
      assert.equal(byId.get(999)?.arm_status, "fired");
      const photoRows = await client.query(
        "SELECT dedup_key,status FROM telegram_photo_deliveries ORDER BY dedup_key",
      );
      assert.deepEqual(
        Object.fromEntries(
          photoRows.rows.map((row) => [row.dedup_key, row.status]),
        ),
        {
          "position:1965:milestone": "abandoned",
          "position:999:milestone": "ready",
          "signal:11550": "delivered",
          "signal:12368": "abandoned",
        },
      );
      const relayRows = await client.query(
        "SELECT source_signal_id,status FROM trading_signal_deliveries ORDER BY source_signal_id",
      );
      assert.deepEqual(
        Object.fromEntries(
          relayRows.rows.map((row) => [row.source_signal_id, row.status]),
        ),
        { 999: "pending", 12368: "quarantined" },
      );
      const second =
        await neutralizeReviewedStealthResistanceInTransaction(client);
      assert.deepEqual(second, {
        moved: 0,
        alreadyClosed: [1936],
        partialRunners: [1937],
        missing: [],
      });
      await client.query("DELETE FROM tracked_signals WHERE id = 1939");
      const afterRetention =
        await neutralizeReviewedStealthResistanceInTransaction(client);
      assert.deepEqual(afterRetention, {
        moved: 0,
        alreadyClosed: [1936],
        partialRunners: [1937],
        missing: [1939],
      });
      await client.query(
        "UPDATE tracked_signals SET signal_id = 999 WHERE id = 1938",
      );
      await assert.rejects(
        neutralizeReviewedStealthResistanceInTransaction(client),
        /tracker identity mismatch for 1938/,
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
