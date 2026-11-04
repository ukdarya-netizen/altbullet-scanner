import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";
import { sql } from "drizzle-orm";

type DbModule = typeof import("@workspace/db");
type CloseDbModule = typeof import("../src/lib/impulse-runner-close-db.js");
type AccountingRepairModule =
  typeof import("../src/lib/impulse-runner-accounting-repair.js");
type SignalsRouteModule = typeof import("../src/routes/signals.js");

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_IMPULSE_RUNNER_CLOSE_DB_TESTS === "1";

let database: DbModule["db"];
let pool: DbModule["pool"];
let closeDb: CloseDbModule;
let accountingRepair: AccountingRepairModule;
let signalsRoute: SignalsRouteModule;
let schemaName = "";

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

describe(
  "Impulse runner close PostgreSQL race",
  { skip: !integrationEnabled },
  () => {
    before(async () => {
      schemaName = `impulse_runner_close_test_${process.pid}_${Date.now()}`;
      process.env.DATABASE_URL = databaseUrlWithSearchPath(
        integrationDatabaseUrl!,
        schemaName,
      );
      const workspaceDb = await import("@workspace/db");
      database = workspaceDb.db;
      pool = workspaceDb.pool;
      closeDb = await import("../src/lib/impulse-runner-close-db.js");
      accountingRepair =
        await import("../src/lib/impulse-runner-accounting-repair.js");
      signalsRoute = await import("../src/routes/signals.js");

      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await pool.query(`
        CREATE TYPE tracked_status AS ENUM (
          'active', 'in_run', 'profit', 'stop_loss', 'bu_stop',
          'breakeven', 'expired', 'cancelled', 'reclassified'
        )
      `);
      await pool.query(`
        CREATE TABLE tracked_signals (
          id serial PRIMARY KEY,
          signal_id integer,
          symbol text NOT NULL,
          signal_type text NOT NULL,
          is_short boolean NOT NULL DEFAULT false,
          entry_price real NOT NULL,
          original_entry_price real,
          entry_policy_version text,
          status tracked_status NOT NULL DEFAULT 'active',
          policy_version text,
          runner_state text,
          core_closed_at timestamp,
          core_exit_price real,
          core_pnl_percent real,
          core_close_event_key text,
          runner_peak_price real,
          runner_trailing_stop_level real,
          runner_trailing_stop_armed_at timestamp,
          runner_exit_price real,
          runner_pnl_percent real,
          runner_closed_at timestamp,
          runner_close_event_key text,
          peak_price real,
          trailing_stop_level real,
          trailing_stop_armed_at timestamp,
          exit_price real,
          pnl_percent real,
          closed_at timestamp,
          pending_milestone integer,
          pending_milestone_kind text,
          pending_milestone_price real,
          pending_milestone_trailing_stop real,
          pending_milestone_status text,
          pending_milestone_lease_until timestamp,
          updated_at timestamp NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE telegram_delivery_events (
          id serial PRIMARY KEY,
          event_key text NOT NULL UNIQUE,
          expected_recipient_count integer NOT NULL DEFAULT 0,
          status text NOT NULL DEFAULT 'queued',
          created_at timestamp NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE impulse_runner_original_entry_backfill_audit (
          tracked_signal_id integer PRIMARY KEY,
          prior_original_entry_price real,
          source_entry_price real NOT NULL,
          backfilled_at timestamp NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE impulse_runner_accounting_repair_audit (
          tracked_signal_id integer PRIMARY KEY,
          prior_pnl_percent real,
          prior_status text,
          corrected_pnl_percent real NOT NULL,
          corrected_status text NOT NULL,
          corrected_peak_price real NOT NULL,
          correction_required boolean NOT NULL DEFAULT false,
          repaired_at timestamp NOT NULL DEFAULT now()
        )
      `);
      await pool.query(`
        CREATE TABLE impulse_runner_trailing_floor_repair_audit (
          tracked_signal_id integer PRIMARY KEY,
          prior_runner_exit_price real NOT NULL,
          corrected_runner_exit_price real NOT NULL,
          durable_peak_price real NOT NULL,
          earned_trailing_floor real,
          effective_trailing_floor real,
          prior_persisted_trailing_stop real,
          prior_pnl_percent real,
          corrected_pnl_percent real NOT NULL,
          repaired_at timestamp NOT NULL DEFAULT now()
        )
      `);
    });

    beforeEach(async () => {
      await pool.query(
        `TRUNCATE tracked_signals, telegram_delivery_events,
          impulse_runner_accounting_repair_audit,
          impulse_runner_original_entry_backfill_audit,
          impulse_runner_trailing_floor_repair_audit RESTART IDENTITY`,
      );
    });

    after(async () => {
      try {
        await pool?.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
        );
      } finally {
        await pool?.end();
      }
    });

    test("five-day lifetime honors the runner's trailing and entry-anchored BE", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_exit_price,
          core_pnl_percent, runner_peak_price, peak_price
        ) VALUES
          ('GAIN-USDT', 'impulse_buy', 100, 100, 'in_run',
           'impulse_runner_v1', 'open', now(), 120, 20, 120, 120),
          ('LOSS-USDT', 'impulse_buy', 100, 100, 'in_run',
            'impulse_runner_v1', 'open', now(), 120, 20, 140, 140),
          ('UNDER-USDT', 'impulse_buy', 100, 100, 'in_run',
            'impulse_runner_v1', 'open', now(), 120, 20, 120, 120),
          ('MID-USDT', 'impulse_buy', 100, 100, 'in_run',
            'impulse_runner_v1', 'open', now(), 120, 20, 103, 103),
          ('EDGE-USDT', 'impulse_buy', 100, 100, 'in_run',
            'impulse_runner_v1', 'open', now(), 120, 20, 105, 105)
      `);
      const prices = [125, 90, 90, 103, 105];
      for (const id of [1, 2, 3, 4, 5]) {
        const closed = await database.transaction((tx) =>
          closeDb.claimImpulseRunnerFinalClose(tx, {
            trackedSignalId: id,
            policyVersion: "impulse_runner_v1",
            exitPrice: prices[id - 1]!,
            runnerPeakPrice: 100,
            eventKey: `position:${id}:impulse_runner_v1:runner_close:age_expired`,
            closedAt: new Date(),
            lifetimeClose: true,
          }),
        );
        assert.ok(closed);
      }
      const rows = (
        await pool.query(
          `SELECT id, status, runner_exit_price, runner_pnl_percent,
                  pnl_percent, runner_state, runner_trailing_stop_level
             FROM tracked_signals ORDER BY id`,
        )
      ).rows;
      assert.equal(rows[0].status, "bu_stop");
      assert.equal(rows[0].runner_state, "closed");
      assert.equal(rows[0].runner_exit_price, 100);
      assert.equal(rows[0].runner_pnl_percent, 0);
      assert.equal(rows[0].pnl_percent, 0);
      assert.equal(rows[1].status, "profit");
      assert.equal(rows[1].runner_trailing_stop_level, 110);
      assert.equal(rows[1].runner_exit_price, 110);
      assert.ok(Math.abs(rows[1].runner_pnl_percent - 10) < 0.001);
      assert.ok(Math.abs(rows[1].pnl_percent - 10) < 0.001);
      for (const row of rows.slice(2)) {
        assert.equal(row.status, "bu_stop");
        assert.equal(row.runner_exit_price, 100);
        assert.equal(row.runner_pnl_percent, 0);
      }
      const repaired = await database.transaction((tx) =>
        accountingRepair.repairImpulseRunnerCanonicalRows(tx),
      );
      assert.equal(repaired, 0);
    });

    for (const pendingStatus of ["processing", "failed"] as const) {
      test(`one worker closes while a ${pendingStatus} milestone is pending`, async () => {
        const eventKey = `position:1:impulse_runner_v1:runner_close`;
        await pool.query(
          `INSERT INTO tracked_signals (
             symbol, signal_type, entry_price, original_entry_price, status,
             policy_version, runner_state, core_closed_at, core_exit_price,
             core_pnl_percent, runner_peak_price, runner_trailing_stop_level,
             peak_price, pending_milestone, pending_milestone_kind,
             pending_milestone_price, pending_milestone_trailing_stop,
             pending_milestone_status, pending_milestone_lease_until
           ) VALUES (
             'RACE-USDT', 'impulse_buy', 100, 100, 'in_run',
             'impulse_runner_v1', 'open', now(), 120, 20, 140, 90,
             130, 25, 'runner', 125, 115, $1, now() + interval '2 minutes'
           )`,
          [pendingStatus],
        );

        const candidates = [
          {
            exitPrice: 114,
            runnerPeakPrice: 131,
            closedAt: new Date("2026-09-17T10:00:00Z"),
          },
          {
            exitPrice: 118,
            runnerPeakPrice: 135,
            closedAt: new Date("2026-09-17T10:00:01Z"),
          },
        ];
        const attempts = await Promise.all(
          candidates.map((candidate) =>
            database.transaction(async (tx) => {
              const claimed = await closeDb.claimImpulseRunnerFinalClose(tx, {
                trackedSignalId: 1,
                policyVersion: "impulse_runner_v1",
                eventKey,
                ...candidate,
              });
              if (claimed) {
                await tx.execute(sql`
                  INSERT INTO telegram_delivery_events
                    (event_key, expected_recipient_count, status)
                  VALUES (${eventKey}, 0, 'recipient_resolution_pending')
                `);
              }
              return claimed;
            }),
          ),
        );

        assert.equal(attempts.filter(Boolean).length, 1);
        const winnerIndex = attempts.findIndex(Boolean);
        const winner = candidates[winnerIndex]!;
        const signal = (
          await pool.query(
            `SELECT status, runner_state, runner_peak_price,
                    runner_trailing_stop_level, runner_exit_price,
                    runner_pnl_percent, exit_price, pnl_percent, closed_at,
                    runner_close_event_key, pending_milestone,
                    pending_milestone_kind, pending_milestone_price,
                    pending_milestone_trailing_stop, pending_milestone_status,
                    pending_milestone_lease_until
             FROM tracked_signals WHERE id = 1`,
          )
        ).rows[0];
        const expectedExit = Math.max(winner.exitPrice, 110);
        assert.equal(signal.status, "profit");
        assert.equal(signal.runner_state, "closed");
        assert.equal(
          signal.runner_peak_price,
          Math.max(140, winner.runnerPeakPrice),
        );
        assert.equal(signal.runner_exit_price, expectedExit);
        assert.equal(signal.runner_trailing_stop_level, 110);
        assert.equal(signal.exit_price, expectedExit);
        assert.equal(signal.runner_close_event_key, eventKey);
        assert.equal(
          new Date(signal.closed_at).toISOString(),
          winner.closedAt.toISOString(),
        );
        assert.ok(
          Math.abs(Number(signal.runner_pnl_percent) - (expectedExit - 100)) <
            0.00001,
        );
        assert.ok(
          Math.abs(Number(signal.pnl_percent) - (expectedExit - 100)) < 0.00001,
        );
        assert.equal(signal.pending_milestone, 25);
        assert.equal(signal.pending_milestone_kind, "runner");
        assert.equal(signal.pending_milestone_price, 125);
        assert.equal(signal.pending_milestone_trailing_stop, 115);
        assert.equal(signal.pending_milestone_status, pendingStatus);
        assert.ok(signal.pending_milestone_lease_until);

        const events = await pool.query(
          "SELECT event_key, status FROM telegram_delivery_events",
        );
        assert.deepEqual(events.rows, [
          { event_key: eventKey, status: "recipient_resolution_pending" },
        ]);

        const staleResult = await database.transaction((tx) =>
          closeDb.claimImpulseRunnerFinalClose(tx, {
            trackedSignalId: 1,
            policyVersion: "impulse_runner_v1",
            exitPrice: 999,
            runnerPeakPrice: 999,
            eventKey: `${eventKey}:${randomUUID()}`,
            closedAt: new Date("2026-09-17T11:00:00Z"),
          }),
        );
        assert.equal(staleResult, null);
        const afterStale = (
          await pool.query(
            `SELECT status, runner_exit_price, pnl_percent, closed_at,
                    runner_close_event_key FROM tracked_signals WHERE id = 1`,
          )
        ).rows[0];
        assert.equal(afterStale.status, signal.status);
        assert.equal(afterStale.runner_exit_price, signal.runner_exit_price);
        assert.equal(afterStale.pnl_percent, signal.pnl_percent);
        assert.equal(
          new Date(afterStale.closed_at).toISOString(),
          new Date(signal.closed_at).toISOString(),
        );
        assert.equal(afterStale.runner_close_event_key, eventKey);
        const eventCount = await pool.query(
          "SELECT count(*)::int AS count FROM telegram_delivery_events",
        );
        assert.equal(eventCount.rows[0]?.count, 1);
      });
    }

    test("confirmed trailing hit atomically opens one durable 20% runner event", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, peak_price, trailing_stop_level
        ) VALUES (
          'CORE-USDT', 'impulse_buy', 100, 100, 'in_run',
          'impulse_runner_v1', 140, 120
        )
      `);
      const eventKey = "position:1:impulse_runner_v1:core_close";
      const hit = {
        trackedSignalId: 1,
        policyVersion: "impulse_runner_v1",
        eventKey,
        trailingStop: 119,
        peakPrice: 141,
        runnerPeakPrice: 141,
        runnerTrailingStop: 111,
        observedAt: new Date("2026-09-17T09:59:59Z"),
        closedAt: new Date("2026-09-17T10:00:00Z"),
      };

      const attempts = await Promise.all(
        [hit, { ...hit, closedAt: new Date("2026-09-17T10:00:01Z") }].map(
          (candidate) =>
            database.transaction(async (tx) => {
              const claimed = await closeDb.claimImpulseRunnerCoreClose(
                tx,
                candidate,
              );
              if (claimed) {
                await tx.execute(sql`
                  INSERT INTO telegram_delivery_events
                    (event_key, expected_recipient_count, status)
                  VALUES (${eventKey}, 0, 'recipient_resolution_pending')
                `);
              }
              return claimed;
            }),
        ),
      );

      assert.equal(attempts.filter(Boolean).length, 1);
      const row = (
        await pool.query(
          `SELECT status, runner_state, core_closed_at, core_exit_price,
                  core_pnl_percent, core_close_event_key
           FROM tracked_signals WHERE id = 1`,
        )
      ).rows[0];
      assert.equal(row.status, "in_run");
      assert.equal(row.runner_state, "open");
      assert.equal(row.core_exit_price, 120);
      assert.equal(row.core_pnl_percent, 20);
      assert.equal(row.core_close_event_key, eventKey);
      assert.ok(row.core_closed_at);

      const events = await pool.query(
        "SELECT event_key FROM telegram_delivery_events",
      );
      assert.deepEqual(events.rows, [{ event_key: eventKey }]);

      const stale = await database.transaction((tx) =>
        closeDb.claimImpulseRunnerCoreClose(tx, {
          ...hit,
          eventKey: `${eventKey}:duplicate`,
          trailingStop: 999,
        }),
      );
      assert.equal(stale, null);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM telegram_delivery_events",
          )
        ).rows[0]?.count,
        1,
      );

      assert.deepEqual(
        signalsRoute.serializeTrackedRunnerFields({
          trackedRunnerState: row.runner_state,
          trackedCoreClosedAt: new Date(row.core_closed_at),
        }),
        {
          trackedRunnerState: "open",
          trackedCoreClosedAt: new Date(row.core_closed_at).toISOString(),
        },
      );
    });

    test("BR-like durable peak floors a stale low worker exit", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_pnl_percent,
          runner_peak_price, runner_trailing_stop_level, peak_price
        ) VALUES (
          'BR-USDT', 'impulse_buy', 0.2532, 0.2532, 'in_run',
          'impulse_runner_v1', 'open', now(), 50, 0.6940212, NULL, 0.4
        )
      `);
      const result = await database.transaction((tx) =>
        closeDb.claimImpulseRunnerFinalClose(tx, {
          trackedSignalId: 1,
          policyVersion: "impulse_runner_v1",
          exitPrice: 0.3,
          runnerPeakPrice: 0.31,
          eventKey: "br-like-close",
          closedAt: new Date("2026-09-17T12:00:00Z"),
        }),
      );
      assert.ok(result);
      assert.ok(
        Math.abs(Number(result.runnerExitPrice) - 0.6180612) < 0.000001,
      );
      assert.ok(Math.abs(Number(result.runnerPnlPercent) - 144.1) < 0.0001);
      assert.ok(Math.abs(Number(result.pnlPercent) - 144.1) < 0.0001);
      const row = (
        await pool.query(
          "SELECT runner_trailing_stop_level, runner_peak_price FROM tracked_signals WHERE id = 1",
        )
      ).rows[0];
      assert.ok(
        Math.abs(Number(row.runner_trailing_stop_level) - 0.6180612) < 0.000001,
      );
      assert.ok(Math.abs(Number(row.runner_peak_price) - 0.6940212) < 0.000001);
    });

    test("startup repair raises earned floors, audits truthfully, and is idempotent", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_pnl_percent,
          runner_peak_price, runner_trailing_stop_level, runner_exit_price,
          runner_pnl_percent, peak_price, exit_price, pnl_percent
        ) VALUES
          (
            'PTB-USDT', 'impulse_buy', 100, 100, 'profit',
            'impulse_runner_v1', 'closed', now(), 20,
            164, 111, 111, 11, 164, 111, 11
          ),
          (
            'STRICT-USDT', 'impulse_buy', 100, 100, 'stop_loss',
            'impulse_runner_v1', 'closed', now(), 20,
            140, 120, 90, -10, 140, 90, -10
          ),
          (
            'SYNC-USDT', 'impulse_buy', 100, 100, 'profit',
            'impulse_runner_v1', 'closed', now(), 20,
            120, NULL, 110, NULL, 120, 110, 1
          ),
          (
            'AMBIG-USDT', 'impulse_buy', 100, 100, 'profit',
            'impulse_runner_v1', 'closed', now(), 20,
            140, 150, 90, -10, 140, 90, -10
          )
      `);

      const repairedCount = await database.transaction((tx) =>
        accountingRepair.repairImpulseRunnerCanonicalRows(tx),
      );
      assert.equal(repairedCount, 3);

      const rows = (
        await pool.query(`
          SELECT symbol, runner_exit_price, runner_pnl_percent,
                 runner_trailing_stop_level, exit_price, pnl_percent,
                 peak_price, runner_peak_price, status
            FROM tracked_signals
           ORDER BY id
        `)
      ).rows;
      assert.deepEqual(
        rows.map((row) => ({
          symbol: row.symbol,
          runnerExit: Number(row.runner_exit_price),
          runnerPnl: Number(row.runner_pnl_percent),
          trailingStop:
            row.runner_trailing_stop_level == null
              ? null
              : Number(row.runner_trailing_stop_level),
          exit: Number(row.exit_price),
          pnl: Number(row.pnl_percent),
          peak: Number(row.peak_price),
          runnerPeak: Number(row.runner_peak_price),
          status: row.status,
        })),
        [
          {
            symbol: "PTB-USDT",
            runnerExit: 134,
            runnerPnl: 34,
            trailingStop: 134,
            exit: 134,
            pnl: 34,
            peak: 164,
            runnerPeak: 164,
            status: "profit",
          },
          {
            symbol: "STRICT-USDT",
            runnerExit: 120,
            runnerPnl: 20,
            trailingStop: 120,
            exit: 120,
            pnl: 20,
            peak: 140,
            runnerPeak: 140,
            status: "profit",
          },
          {
            symbol: "SYNC-USDT",
            runnerExit: 110,
            runnerPnl: 10,
            trailingStop: null,
            exit: 110,
            pnl: 10,
            peak: 120,
            runnerPeak: 120,
            status: "profit",
          },
          {
            symbol: "AMBIG-USDT",
            runnerExit: 90,
            runnerPnl: -10,
            trailingStop: 150,
            exit: 90,
            pnl: -10,
            peak: 140,
            runnerPeak: 140,
            status: "profit",
          },
        ],
      );

      const floorAudits = (
        await pool.query(`
          SELECT tracked_signal_id, prior_runner_exit_price,
                 corrected_runner_exit_price, earned_trailing_floor,
                 effective_trailing_floor, prior_persisted_trailing_stop
            FROM impulse_runner_trailing_floor_repair_audit
           ORDER BY tracked_signal_id
        `)
      ).rows;
      assert.deepEqual(
        floorAudits.map((row) => ({
          id: row.tracked_signal_id,
          priorExit: Number(row.prior_runner_exit_price),
          correctedExit: Number(row.corrected_runner_exit_price),
          earnedFloor: Number(row.earned_trailing_floor),
          effectiveFloor: Number(row.effective_trailing_floor),
          priorStop: Number(row.prior_persisted_trailing_stop),
        })),
        [
          {
            id: 1,
            priorExit: 111,
            correctedExit: 134,
            earnedFloor: 134,
            effectiveFloor: 134,
            priorStop: 111,
          },
          {
            id: 2,
            priorExit: 90,
            correctedExit: 120,
            earnedFloor: 110,
            effectiveFloor: 120,
            priorStop: 120,
          },
        ],
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT count(*)::int AS count,
                    bool_and(correction_required) AS all_corrections_required
               FROM impulse_runner_accounting_repair_audit`,
          )
        ).rows[0],
        { count: 3, all_corrections_required: true },
      );

      const secondRunCount = await database.transaction((tx) =>
        accountingRepair.repairImpulseRunnerCanonicalRows(tx),
      );
      assert.equal(secondRunCount, 0);
    });

    test("full startup repair isolates ambiguous closed rows without inventing PnL", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_pnl_percent,
          runner_peak_price, runner_trailing_stop_level, runner_exit_price,
          runner_pnl_percent, peak_price, exit_price, pnl_percent
        ) VALUES (
          'AMBIG-STARTUP-USDT', 'impulse_buy', 100, 100, 'profit',
          'impulse_runner_v1', 'closed', now(), 20,
          140, 150, 90, NULL, 140, 90, NULL
        )
      `);

      await accountingRepair.repairImpulseRunnerCanonicalAccounting();

      const afterFirstRun = (
        await pool.query(`
          SELECT runner_exit_price, runner_pnl_percent, exit_price, pnl_percent,
                 status
            FROM tracked_signals
           WHERE symbol = 'AMBIG-STARTUP-USDT'
        `)
      ).rows[0];
      assert.deepEqual(afterFirstRun, {
        runner_exit_price: 90,
        runner_pnl_percent: null,
        exit_price: 90,
        pnl_percent: null,
        status: "profit",
      });

      const firstAudit = (
        await pool.query(`
          SELECT tracked_signal_id, reason
            FROM impulse_runner_accounting_ambiguity_audit
        `)
      ).rows;
      assert.deepEqual(firstAudit, [
        { tracked_signal_id: 1, reason: "runner_stop_above_peak" },
      ]);

      await accountingRepair.repairImpulseRunnerCanonicalAccounting();

      const afterSecondRun = (
        await pool.query(`
          SELECT runner_exit_price, runner_pnl_percent, exit_price, pnl_percent,
                 status
            FROM tracked_signals
           WHERE symbol = 'AMBIG-STARTUP-USDT'
        `)
      ).rows[0];
      assert.deepEqual(afterSecondRun, afterFirstRun);
      assert.equal(
        (
          await pool.query(`
            SELECT count(*)::int AS count
              FROM impulse_runner_accounting_ambiguity_audit
          `)
        ).rows[0]?.count,
        1,
      );
      assert.equal(
        (
          await pool.query(`
            SELECT count(*)::int AS count
              FROM impulse_runner_accounting_repair_audit
          `)
        ).rows[0]?.count,
        0,
      );
    });

    test("a runner cannot close while persisted core PnL evidence is missing", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_pnl_percent,
          runner_peak_price, runner_trailing_stop_level, peak_price
        ) VALUES (
          'NULLCORE-USDT', 'impulse_buy', 100, 100, 'in_run',
          'impulse_runner_v1', 'open', now(), NULL, 140, 90, 130
        )
      `);
      const result = await database.transaction((tx) =>
        closeDb.claimImpulseRunnerFinalClose(tx, {
          trackedSignalId: 1,
          policyVersion: "impulse_runner_v1",
          exitPrice: 80,
          runnerPeakPrice: 101,
          eventKey: "null-core-close",
          closedAt: new Date("2026-09-17T12:00:00Z"),
        }),
      );
      assert.equal(result, null);
      const row = (
        await pool.query(
          "SELECT runner_state, runner_exit_price, pnl_percent FROM tracked_signals WHERE id = 1",
        )
      ).rows[0];
      assert.equal(row.runner_state, "open");
      assert.equal(row.runner_exit_price, null);
      assert.equal(row.pnl_percent, null);
    });

    test("unarmed runner keeps a NULL trailing stop", async () => {
      await pool.query(`
        INSERT INTO tracked_signals (
          symbol, signal_type, entry_price, original_entry_price, status,
          policy_version, runner_state, core_closed_at, core_pnl_percent,
          runner_peak_price, runner_trailing_stop_level, peak_price
        ) VALUES (
          'UNARMED-USDT', 'impulse_buy', 100, 100, 'in_run',
          'impulse_runner_v1', 'open', now(), 20, 110, NULL, 109
        )
      `);
      const result = await database.transaction((tx) =>
        closeDb.claimImpulseRunnerFinalClose(tx, {
          trackedSignalId: 1,
          policyVersion: "impulse_runner_v1",
          exitPrice: 90,
          runnerPeakPrice: 111,
          eventKey: "unarmed-close",
          closedAt: new Date("2026-09-17T12:00:00Z"),
        }),
      );
      assert.ok(result);
      const row = (
        await pool.query(
          "SELECT runner_trailing_stop_level FROM tracked_signals WHERE id = 1",
        )
      ).rows[0];
      assert.equal(row.runner_trailing_stop_level, null);
    });
  },
);
