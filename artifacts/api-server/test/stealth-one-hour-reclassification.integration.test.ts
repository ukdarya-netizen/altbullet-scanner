import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

const databaseUrl = process.env.TEST_DATABASE_URL;
const enabled =
  Boolean(databaseUrl) && process.env.RUN_STEALTH_1H_RECLASS_DB_TESTS === "1";
const schemaName = `stealth_1h_review_test_${process.pid}_${Date.now()}`;

describe(
  "reviewed Stealth 1H neutral reclassification",
  { skip: !enabled },
  () => {
    let pool: typeof import("@workspace/db").pool;
    let correction: typeof import("../src/lib/stealth-one-hour-reclassification.js");

    before(async () => {
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schemaName},public`);
      process.env.DATABASE_URL = url.toString();
      const workspace = await import("@workspace/db");
      pool = workspace.pool;
      correction =
        await import("../src/lib/stealth-one-hour-reclassification.js");
      await pool.query(`CREATE SCHEMA "${schemaName}"`);
      await pool.query(`
      CREATE TYPE tracked_status AS ENUM
        ('active','in_run','profit','stop_loss','bu_stop','reclassified');
      CREATE TABLE signals (
        id integer PRIMARY KEY, symbol text NOT NULL, sentiment_key text NOT NULL
      );
      CREATE TABLE tracked_signals (
        id integer PRIMARY KEY, signal_id integer NOT NULL, symbol text NOT NULL,
        sentiment_key text NOT NULL, status tracked_status NOT NULL,
        cancel_reason text, runner_state text, core_closed_at timestamp,
        exit_price real, pnl_percent real, closed_at timestamp,
        trailing_stop_level real, last_smart_cancel_check_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE stealth_breakout_armed_setups (
        id integer PRIMARY KEY, symbol text NOT NULL, fired_signal_id integer,
        status text NOT NULL, terminal_reason text,
        updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE milestone_notification_deliveries (
        id serial PRIMARY KEY, tracked_signal_id integer, status text NOT NULL,
        lease_until timestamp, claim_token text, last_error text
      );
      CREATE TABLE telegram_photo_deliveries (
        id serial PRIMARY KEY, dedup_key text NOT NULL, status text NOT NULL,
        lease_until timestamp, claim_token text, last_error text,
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    });

    beforeEach(async () => {
      await pool.query(`
      TRUNCATE signals, tracked_signals, stealth_breakout_armed_setups,
        milestone_notification_deliveries, telegram_photo_deliveries
      RESTART IDENTITY
    `);
      for (const [
        trackedId,
        signalId,
        armId,
        symbol,
      ] of correction.STEALTH_ONE_HOUR_RECLASSIFICATION_TARGETS) {
        const status =
          signalId === 6374 || signalId === 6434
            ? "bu_stop"
            : signalId === 8058 || signalId === 8446
              ? "stop_loss"
              : signalId === 6476
                ? "in_run"
                : "active";
        await pool.query(
          "INSERT INTO signals VALUES ($1,$2,'stealth_breakout')",
          [signalId, symbol],
        );
        await pool.query(
          `INSERT INTO tracked_signals
           (id,signal_id,symbol,sentiment_key,status,exit_price,pnl_percent,closed_at)
         VALUES ($1,$2,$3,'stealth_breakout',($4::text)::tracked_status,100,5,
           CASE WHEN $4::text IN ('bu_stop','stop_loss') THEN now() ELSE NULL END)`,
          [trackedId, signalId, symbol, status],
        );
        await pool.query(
          `INSERT INTO stealth_breakout_armed_setups
           (id,symbol,fired_signal_id,status) VALUES ($1,$2,$3,'fired')`,
          [armId, symbol, signalId],
        );
      }
      await pool.query(`
      INSERT INTO signals VALUES (9999,'CONTROL-USDT','stealth_breakout');
      INSERT INTO tracked_signals
        (id,signal_id,symbol,sentiment_key,status)
      VALUES (9999,9999,'CONTROL-USDT','stealth_breakout','active')
    `);
    });

    after(async () => {
      try {
        await pool?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await pool?.end();
      }
    });

    async function runCorrection(): Promise<number> {
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        return await correction.reclassifyReviewedStealthOneHourFailures();
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    }

    test("neutralizes exactly 17, preserves audits, suppresses pending delivery, and reruns safely", async () => {
      await pool.query(`
      INSERT INTO milestone_notification_deliveries(tracked_signal_id,status)
      VALUES (1750,'ready'),(1790,'delivered'),(9999,'ready');
      INSERT INTO telegram_photo_deliveries(dedup_key,status)
      VALUES ('signal:6400','ready'),('position:1750:close','failed'),
             ('signal:6374','delivered'),('signal:9999','ready')
    `);
      assert.equal(await runCorrection(), 17);
      assert.equal(await runCorrection(), 0);
      const tracked = (
        await pool.query(
          "SELECT id,status,cancel_reason,pnl_percent,exit_price,closed_at FROM tracked_signals ORDER BY id",
        )
      ).rows;
      assert.equal(
        tracked.filter((r) => r.status === "reclassified").length,
        17,
      );
      assert.ok(
        tracked
          .slice(0, 17)
          .every(
            (r) =>
              r.cancel_reason ===
                correction.STEALTH_ONE_HOUR_RECLASSIFICATION_REASON &&
              r.pnl_percent === null &&
              r.exit_price === null &&
              r.closed_at === null,
          ),
      );
      assert.equal(tracked.at(-1).status, "active");
      const arms = (
        await pool.query(
          "SELECT status,terminal_reason,fired_signal_id FROM stealth_breakout_armed_setups",
        )
      ).rows;
      assert.equal(arms.length, 17);
      assert.ok(
        arms.every(
          (r) =>
            r.status === "reclassified" &&
            r.terminal_reason ===
              correction.STEALTH_ONE_HOUR_RECLASSIFICATION_REASON &&
            r.fired_signal_id !== null,
        ),
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM signals")).rows[0].n,
        18,
      );
      const milestones = (
        await pool.query(
          "SELECT tracked_signal_id,status FROM milestone_notification_deliveries ORDER BY id",
        )
      ).rows;
      assert.deepEqual(
        milestones.map((r) => r.status),
        ["abandoned", "delivered", "ready"],
      );
      const photos = (
        await pool.query(
          "SELECT status FROM telegram_photo_deliveries ORDER BY id",
        )
      ).rows;
      assert.deepEqual(
        photos.map((r) => r.status),
        ["abandoned", "abandoned", "delivered", "ready"],
      );
    });

    test("an identity mismatch aborts the entire batch", async () => {
      await pool.query(
        "UPDATE stealth_breakout_armed_setups SET fired_signal_id=9999 WHERE id=3222",
      );
      await assert.rejects(
        runCorrection(),
        /expected 17 exact tracker\/signal\/arm matches/,
      );
      const statuses = (
        await pool.query("SELECT status FROM tracked_signals WHERE id<>9999")
      ).rows;
      assert.equal(
        statuses.filter((row) => row.status === "reclassified").length,
        0,
      );
    });
  },
);
