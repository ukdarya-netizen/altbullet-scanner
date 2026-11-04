import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { eq } from "drizzle-orm";

type DbModule = typeof import("@workspace/db");
type MilestoneDbModule = typeof import("../src/lib/milestone-delivery-db.js");

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_MILESTONE_DELIVERY_DB_TESTS === "1";
const suiteOptions = { skip: !integrationEnabled };

let workspaceDb: DbModule;
let database: DbModule["db"];
let pool: DbModule["pool"];
let milestoneDeliveriesTable: DbModule["milestoneNotificationDeliveriesTable"];
let milestoneDb: MilestoneDbModule;
let schemaName = "";
let workerDatabaseUrl = "";

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

describe("Milestone delivery PostgreSQL race", suiteOptions, () => {
  before(async () => {
    schemaName = `milestone_delivery_test_${process.pid}_${Date.now()}`;
    workerDatabaseUrl = databaseUrlWithSearchPath(
      integrationDatabaseUrl!,
      schemaName,
    );
    process.env.DATABASE_URL = workerDatabaseUrl;
    workspaceDb = await import("@workspace/db");
    database = workspaceDb.db;
    pool = workspaceDb.pool;
    milestoneDeliveriesTable = workspaceDb.milestoneNotificationDeliveriesTable;
    milestoneDb = await import("../src/lib/milestone-delivery-db.js");

    await pool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await pool.query(`
      CREATE TABLE milestone_notification_deliveries (
        id serial PRIMARY KEY,
        tracked_signal_id integer NOT NULL,
        milestone integer NOT NULL,
        milestone_kind text NOT NULL,
        target text NOT NULL,
        status text NOT NULL DEFAULT 'ready',
        lease_until timestamp,
        claim_token text,
        delivered_at timestamp,
        last_error text,
        attempts integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      CREATE TABLE milestone_test_barriers (
        barrier_key text PRIMARY KEY,
        stale_claimed boolean NOT NULL DEFAULT false,
        newer_claimed boolean NOT NULL DEFAULT false
      )
    `);
    await pool.query(`
      CREATE UNIQUE INDEX milestone_delivery_test_unique
      ON milestone_notification_deliveries
        (tracked_signal_id, milestone_kind, milestone, target)
    `);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE milestone_notification_deliveries, milestone_test_barriers RESTART IDENTITY",
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

  test("quarantines an expired channel claim instead of allowing a resend", async () => {
    const [channelRow] = await database
      .insert(milestoneDeliveriesTable)
      .values({
        trackedSignalId: 42,
        milestone: 10,
        milestoneKind: "first_target",
        target: "-100987654321",
        status: "processing",
        leaseUntil: new Date(Date.now() - 1_000),
        claimToken: "initial-claim",
        attempts: 0,
      })
      .returning({ id: milestoneDeliveriesTable.id });
    assert.ok(channelRow);

    const reclaimed = await milestoneDb.claimMilestoneRecipient(database, {
      trackedSignalId: 42,
      milestone: 10,
      milestoneKind: "first_target",
      target: "-100987654321",
    });
    assert.equal(reclaimed, null);
    assert.equal(
      await milestoneDb.quarantineExpiredMilestoneRecipients(database),
      1,
    );

    const rows = await database
      .select({
        target: milestoneDeliveriesTable.target,
        status: milestoneDeliveriesTable.status,
        attempts: milestoneDeliveriesTable.attempts,
        claimToken: milestoneDeliveriesTable.claimToken,
        lastError: milestoneDeliveriesTable.lastError,
      })
      .from(milestoneDeliveriesTable)
      .where(eq(milestoneDeliveriesTable.trackedSignalId, 42));
    assert.deepEqual(
      rows.sort((left, right) => left.target.localeCompare(right.target)),
      [
        {
          target: "-100987654321",
          status: "ambiguous",
          attempts: 0,
          claimToken: null,
          lastError: "Telegram outcome unknown after expired milestone claim",
        },
      ],
    );
  });
});
