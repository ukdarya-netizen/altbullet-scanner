import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { after, before, beforeEach, describe, test } from "node:test";
import { eq, isNull } from "drizzle-orm";
import {
  buildTelegramPhotoDeliveryRows,
  runTelegramPhotoClaimTransaction,
} from "../src/lib/telegram-photo-outbox-policy.js";

type DbModule = typeof import("@workspace/db");
type OutboxModule = typeof import("../src/lib/telegram-photo-outbox.js");
type TelegramModule = typeof import("../src/lib/telegram.js");

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_TELEGRAM_OUTBOX_DB_TESTS === "1";
const integrationSuiteName = "Telegram photo outbox PostgreSQL integration";
const integrationSuiteOptions = { skip: !integrationEnabled };
let workspaceDb: DbModule;
let database: DbModule["db"];
let pool: DbModule["pool"];
let telegramPhotoDeliveriesTable: DbModule["telegramPhotoDeliveriesTable"];
let telegramPatternMediaCacheTable: DbModule["telegramPatternMediaCacheTable"];
let trackedSignalsTable: DbModule["trackedSignalsTable"];
let settingsTable: DbModule["settingsTable"];
let outbox: OutboxModule;
let telegram: TelegramModule;
let schemaName = "";
let workerDatabaseUrl = "";
const temporaryFiles = new Set<string>();
const photoPath = fileURLToPath(
  new URL("../assets/active_trades.png", import.meta.url),
);
const originalFetch = globalThis.fetch;
const originalNodeEnv = process.env.NODE_ENV;
const originalTelegramChatId = process.env.TELEGRAM_CHAT_ID;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlWithSearchPath(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  const existingOptions = url.searchParams.get("options");
  const searchPathOption = `-c search_path=${schema},public`;
  url.searchParams.set(
    "options",
    [existingOptions, searchPathOption].filter(Boolean).join(" "),
  );
  return url.toString();
}

async function sql(
  text: string,
  values: unknown[] = [],
): Promise<{ rows: Array<Record<string, unknown>> }> {
  return pool.query(text, values);
}

async function launchWorker(params: {
  dedupKey?: string;
  logFile?: string;
  barrierKey?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const compiledWorkerPath = fileURLToPath(
    new URL("./telegram-photo-outbox-worker.js", import.meta.url),
  );
  const useSourceWorker =
    process.env.TELEGRAM_OUTBOX_TEST_USE_SOURCE_WORKER === "1";
  const workerPath =
    !useSourceWorker && existsSync(compiledWorkerPath)
      ? compiledWorkerPath
      : fileURLToPath(
          new URL("./telegram-photo-outbox-worker.ts", import.meta.url),
        );
  const command =
    !useSourceWorker && existsSync(compiledWorkerPath)
      ? process.execPath
      : fileURLToPath(
          new URL(
            "../../../node_modules/.pnpm/node_modules/.bin/tsx",
            import.meta.url,
          ),
        );
  return new Promise((resolve, reject) => {
    const child = spawn(command, [workerPath], {
      env: {
        ...process.env,
        DATABASE_URL: workerDatabaseUrl,
        OUTBOX_WORKER_DEDUP_KEY: params.dedupKey ?? "",
        OUTBOX_WORKER_LOG_FILE: params.logFile ?? "",
        OUTBOX_WORKER_BARRIER_KEY: params.barrierKey ?? "",
        OUTBOX_WORKER_ID: randomUUID(),
        TELEGRAM_OUTBOX_TEST_CLAIM_BARRIER: params.barrierKey ?? "",
        TELEGRAM_OUTBOX_TEST_USE_SOURCE_WORKER: "1",
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "deterministic-test-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function insertDelivery(params: {
  dedupKey: string;
  target: string;
  phase?: string;
  status?: string;
  nextPartIndex?: number;
  nextAttemptAt?: Date;
  leaseUntil?: Date | null;
  sendAttemptedAt?: Date | null;
  continuationTexts?: string[];
  deliveryPolicyVersion?: number;
}) {
  const now = new Date();
  await database.insert(telegramPhotoDeliveriesTable).values({
    dedupKey: params.dedupKey,
    target: params.target,
    photoPath,
    caption: "POSITION UPDATE",
    fallbackText: "POSITION UPDATE",
    continuationTexts: params.continuationTexts ?? [],
    status: params.status ?? "ready",
    phase: params.phase ?? "photo",
    nextPartIndex: params.nextPartIndex ?? 0,
    nextAttemptAt: params.nextAttemptAt ?? now,
    leaseUntil: params.leaseUntil ?? null,
    sendAttemptedAt: params.sendAttemptedAt ?? null,
    attempts: 0,
    photoAttempts: 0,
    deliveryPolicyVersion: params.deliveryPolicyVersion ?? 4,
    createdAt: now,
    updatedAt: now,
  });
}

async function deliveryRows(dedupKey: string) {
  return database
    .select()
    .from(telegramPhotoDeliveriesTable)
    .where(eq(telegramPhotoDeliveriesTable.dedupKey, dedupKey));
}

async function mediaKeyForPhoto(): Promise<string> {
  return `sha256:${createHash("sha256")
    .update(await readFile(photoPath))
    .digest("hex")}`;
}

async function insertActiveTrackedSignal(): Promise<number> {
  const result = await sql(
    "INSERT INTO tracked_signals (status, updated_at) VALUES ('active', now()) RETURNING id",
  );
  return (result.rows[0] as { id: number }).id;
}

describe(integrationSuiteName, integrationSuiteOptions, () => {
  before(async () => {
    schemaName = `telegram_outbox_test_${process.pid}_${Date.now()}`;
    workerDatabaseUrl = databaseUrlWithSearchPath(
      integrationDatabaseUrl!,
      schemaName,
    );
    process.env.DATABASE_URL = workerDatabaseUrl;
    process.env.NODE_ENV = "production";
    process.env.TELEGRAM_CHAT_ID = "9191";
    process.env.TELEGRAM_OUTBOX_TEST_GLOBAL_INTERVAL_MS = "5";
    process.env.TELEGRAM_OUTBOX_TEST_RECIPIENT_INTERVAL_MS = "25";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { photo: [{ file_id: "main-cached-photo-id" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    workspaceDb = await import("@workspace/db");
    database = workspaceDb.db;
    pool = workspaceDb.pool;
    telegramPhotoDeliveriesTable = workspaceDb.telegramPhotoDeliveriesTable;
    telegramPatternMediaCacheTable = workspaceDb.telegramPatternMediaCacheTable;
    trackedSignalsTable = workspaceDb.trackedSignalsTable;
    settingsTable = workspaceDb.settingsTable;
    outbox = await import("../src/lib/telegram-photo-outbox.js");
    telegram = await import("../src/lib/telegram.js");

    await sql(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
    await sql(`
      CREATE TABLE tracked_signals (
        id serial PRIMARY KEY,
        status text NOT NULL,
        last_update_state text,
        cancel_reason text,
        updated_at timestamp NOT NULL DEFAULT now(),
        closed_at timestamp,
        exit_price real,
        pnl_percent real
      )
    `);
    await sql(`
      CREATE TABLE settings (
        id serial PRIMARY KEY,
        last_restart_notified_at timestamp,
        last_manual_check_sent_at timestamp,
        last_watchdog_alert_at timestamp
      )
    `);
    await sql(`
      CREATE TABLE telegram_photo_deliveries (
        id serial PRIMARY KEY,
        dedup_key text NOT NULL,
        target text NOT NULL,
        photo_path text NOT NULL,
        caption text NOT NULL,
        fallback_text text NOT NULL,
        continuation_texts jsonb NOT NULL DEFAULT '[]'::jsonb,
        status text NOT NULL DEFAULT 'ready',
        phase text NOT NULL DEFAULT 'photo',
        next_part_index integer NOT NULL DEFAULT 0,
        next_attempt_at timestamp NOT NULL DEFAULT now(),
        lease_until timestamp,
        claim_token text,
        send_attempted_at timestamp,
        accepted_at timestamp,
        delivered_at timestamp,
        last_error text,
        attempts integer NOT NULL DEFAULT 0,
        photo_attempts integer NOT NULL DEFAULT 0,
        plain_text boolean NOT NULL DEFAULT false,
        ambiguous_retry_count integer NOT NULL DEFAULT 0,
        repeat_notice boolean NOT NULL DEFAULT false,
        delivery_policy_version integer NOT NULL DEFAULT 1,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE telegram_pattern_media_cache (
        media_key text PRIMARY KEY,
        file_id text,
        lease_until timestamp,
        claim_token text,
        upload_attempted_at timestamp,
        upload_event_key text,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE telegram_delivery_attempt_audit (
        id serial PRIMARY KEY,
        audit_key text NOT NULL UNIQUE,
        delivery_id integer NOT NULL,
        dedup_key text NOT NULL,
        target text NOT NULL,
        phase text NOT NULL,
        part_index integer NOT NULL,
        outcome text NOT NULL,
        http_status integer,
        classification text NOT NULL DEFAULT 'unknown',
        retry_after_seconds integer,
        reason text NOT NULL,
        attempt integer NOT NULL DEFAULT 0,
        send_attempted_at timestamp,
        observed_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE telegram_delivery_events (
        id serial PRIMARY KEY,
        event_key text NOT NULL UNIQUE,
        expected_recipient_count integer NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        last_error text,
        completed_at timestamp,
        attention_at timestamp,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE telegram_delivery_rate_limits (
        bucket_key text PRIMARY KEY,
        next_allowed_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE stealth_breakout_observations (
        id serial PRIMARY KEY,
        symbol text NOT NULL,
        observation_key text NOT NULL UNIQUE,
        level_key text NOT NULL,
        breakout_source text NOT NULL,
        breakout_level real NOT NULL,
        touches integer NOT NULL,
        quiet_zone boolean NOT NULL,
        first_cross_at timestamp NOT NULL,
        first_detected_at timestamp NOT NULL,
        confirmation_at timestamp,
        confirmation_signal_id integer,
        early_alert_queued boolean NOT NULL DEFAULT false,
        created_at timestamp NOT NULL DEFAULT now(),
        updated_at timestamp NOT NULL DEFAULT now()
      )
    `);
    await sql(`
      CREATE TABLE subscribers (
        chat_id bigint PRIMARY KEY,
        active boolean NOT NULL DEFAULT true,
        subscribed_until timestamp
      )
    `);
    await sql(`
      CREATE TABLE dashboard_users (
        id serial PRIMARY KEY,
        email text NOT NULL UNIQUE,
        password_hash text NOT NULL,
        name text NOT NULL,
        chat_id text,
        subscribed_until timestamp,
        status text NOT NULL DEFAULT 'pending'
      )
    `);
    await sql(`
      CREATE UNIQUE INDEX telegram_photo_delivery_dedup_target_unique
      ON telegram_photo_deliveries (dedup_key, target)
    `);
    await sql(`
      CREATE TABLE outbox_test_barriers (
        barrier_key text PRIMARY KEY,
        ready_count integer NOT NULL DEFAULT 0,
        released boolean NOT NULL DEFAULT false,
        claim_ready_count integer NOT NULL DEFAULT 0,
        claim_released boolean NOT NULL DEFAULT false
      )
    `);
    await sql(`
      CREATE TABLE outbox_test_claim_workers (
        barrier_key text NOT NULL,
        worker_id text NOT NULL,
        PRIMARY KEY (barrier_key, worker_id)
      )
    `);
  });

  beforeEach(async () => {
    await sql(
      "TRUNCATE telegram_delivery_attempt_audit, telegram_photo_deliveries, telegram_delivery_events, telegram_delivery_rate_limits, telegram_pattern_media_cache, stealth_breakout_observations, subscribers, dashboard_users, tracked_signals, settings RESTART IDENTITY",
    );
    await sql("INSERT INTO settings DEFAULT VALUES");
    await sql(
      `INSERT INTO subscribers (chat_id, active, subscribed_until)
       VALUES (101, true, NULL), (202, true, NULL), (7818695412, true, NULL)`,
    );
  });

  test("suppresses a queued personal delivery when subscription has expired before drain", async () => {
    const dedupKey = `expired-recipient:${randomUUID()}`;
    const target = "707";
    let telegramRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      telegramRequests++;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { photo: [{ file_id: "must-not-be-used" }] },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    try {
      await sql(
        `INSERT INTO subscribers (chat_id, active, subscribed_until)
         VALUES ($1, true, now())`,
        [Number(target)],
      );
      await insertDelivery({ dedupKey, target });

      await outbox.drainTelegramPhotoOutbox(dedupKey);

      const rows = await deliveryRows(dedupKey);
      assert.equal(rows[0]?.status, "suppressed");
      assert.equal(rows[0]?.sendAttemptedAt, null);
      assert.equal(
        telegramRequests,
        0,
        "Telegram API must not be called at or after subscribed_until",
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("does not create a ticker-signal delivery row for an expired Dashboard recipient", async () => {
    const eventKey = `signal:${randomUUID()}`;
    const target = 707;
    let telegramRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      telegramRequests++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      await sql(
        `INSERT INTO dashboard_users
           (email, password_hash, name, chat_id, subscribed_until, status)
         VALUES ($1, 'hash', 'Expired', $2, now() - interval '1 minute', 'expired')`,
        [`expired-${randomUUID()}@example.test`, String(target)],
      );

      const queued = await outbox.enqueueTelegramPhotoBroadcast({
        photoPath,
        text: "TICKER SIGNAL",
        targets: [target],
        eventKey,
      });

      assert.equal(queued, 0);
      assert.equal((await deliveryRows(eventKey)).length, 0);
      const events = await sql(
        "SELECT count(*)::int AS count FROM telegram_delivery_events WHERE event_key = $1",
        [eventKey],
      );
      assert.equal(events.rows[0]?.count, 0);
      assert.equal(telegramRequests, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("blocks an expired milestone recipient before direct Telegram transport", async () => {
    const target = 708;
    let telegramRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      telegramRequests++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      await sql(
        `INSERT INTO dashboard_users
           (email, password_hash, name, chat_id, subscribed_until, status)
         VALUES ($1, 'hash', 'Expired milestone', $2, now() - interval '1 minute', 'expired')`,
        [`expired-milestone-${randomUUID()}@example.test`, String(target)],
      );

      const result = await telegram.sendMessageResult(
        target,
        "TARGET TRANSITION",
      );

      assert.equal(result.ok, false);
      assert.equal(result.description, "recipient subscription expired");
      assert.equal(telegramRequests, 0);
      const rows = await sql(
        "SELECT count(*)::int AS count FROM telegram_photo_deliveries WHERE target = $1",
        [String(target)],
      );
      assert.equal(rows.rows[0]?.count, 0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("fails closed before enqueue when the subscription database is unavailable", async () => {
    const eventKey = `db-unavailable:${randomUUID()}`;
    let telegramRequests = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      telegramRequests++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      process.env.TELEGRAM_ELIGIBILITY_FORCE_DB_ERROR = "1";

      await assert.rejects(
        outbox.enqueueTelegramPhotoBroadcast({
          photoPath,
          text: "MUST FAIL CLOSED",
          targets: [709],
          eventKey,
        }),
        /Telegram recipient eligibility is unavailable/,
      );
    } finally {
      delete process.env.TELEGRAM_ELIGIBILITY_FORCE_DB_ERROR;
      globalThis.fetch = previousFetch;
    }

    assert.equal((await deliveryRows(eventKey)).length, 0);
    const events = await sql(
      "SELECT count(*)::int AS count FROM telegram_delivery_events WHERE event_key = $1",
      [eventKey],
    );
    assert.equal(events.rows[0]?.count, 0);
    assert.equal(telegramRequests, 0);
  });

  after(async () => {
    try {
      if (pool) {
        await sql(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
        );
      }
    } finally {
      await Promise.all(
        [...temporaryFiles].map((file) => rm(file, { force: true })),
      );
      globalThis.fetch = originalFetch;
      process.env.NODE_ENV = originalNodeEnv;
      if (originalTelegramChatId === undefined) {
        delete process.env.TELEGRAM_CHAT_ID;
      } else {
        process.env.TELEGRAM_CHAT_ID = originalTelegramChatId;
      }
      await pool?.end();
    }
  });

  test("two worker processes deliver each recipient once under contention", async () => {
    const dedupKey = `position:${randomUUID()}`;
    const logFile = `/tmp/${dedupKey.replaceAll(":", "-")}.log`;
    const barrierKey = `workers:${randomUUID()}`;
    temporaryFiles.add(logFile);
    await sql("INSERT INTO outbox_test_barriers (barrier_key) VALUES ($1)", [
      barrierKey,
    ]);
    await Promise.all([
      insertDelivery({ dedupKey, target: "@altbullet" }),
      insertDelivery({ dedupKey, target: "101" }),
      insertDelivery({ dedupKey, target: "202" }),
    ]);

    const [first, second] = await Promise.all([
      launchWorker({ dedupKey, logFile, barrierKey }),
      launchWorker({ dedupKey, logFile, barrierKey }),
    ]);

    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    const rows = await deliveryRows(dedupKey);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.status === "delivered"));
    assert.ok(
      rows.every((row) => row.attempts === 1),
      "a recipient row must have exactly one winning claim",
    );
    assert.ok(rows.every((row) => row.deliveredAt != null));
    assert.ok(rows.every((row) => row.acceptedAt != null));
    const sentBodies = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            chat_id: string;
            multipart?: boolean;
            photo?: string;
          },
      );
    assert.deepEqual(sentBodies.map((body) => body.chat_id).sort(), [
      "101",
      "202",
      "@altbullet",
    ]);
    assert.equal(
      sentBodies.filter((body) => body.multipart).length,
      1,
      "only one recipient may upload the shared image",
    );
    assert.equal(
      sentBodies.filter(
        (body) => !body.multipart && body.photo === "worker-cached-photo-id",
      ).length,
      2,
      "the remaining recipients must use Telegram's cached media ID",
    );
  });

  test("quarantines standalone Stealth TA deliveries before recovery can send them", async () => {
    const eventKey = `stealth-ta:SB-USDT:${randomUUID()}`;
    await sql(
      `INSERT INTO telegram_delivery_events
       (event_key, expected_recipient_count, status)
       VALUES ($1, 2, 'queued')`,
      [eventKey],
    );
    await insertDelivery({ dedupKey: eventKey, target: "9191" });
    await insertDelivery({
      dedupKey: eventKey,
      target: "@altbullet",
      status: "retry",
    });

    assert.equal(
      await outbox.quarantineDisabledStealthObservationDeliveries(),
      2,
    );
    const deliveries = await sql(
      `SELECT target, status, last_error
       FROM telegram_photo_deliveries
       WHERE dedup_key = $1
       ORDER BY target`,
      [eventKey],
    );
    assert.deepEqual(deliveries.rows, [
      {
        target: "9191",
        status: "abandoned",
        last_error: "Standalone Stealth TA observations are disabled",
      },
      {
        target: "@altbullet",
        status: "abandoned",
        last_error: "Standalone Stealth TA observations are disabled",
      },
    ]);
    const event = await sql(
      `SELECT status, last_error
       FROM telegram_delivery_events
       WHERE event_key = $1`,
      [eventKey],
    );
    assert.deepEqual(event.rows, [
      {
        status: "attention",
        last_error: "Standalone Stealth TA observations are disabled",
      },
    ]);
  });

  test("replaces an explicitly invalid cached media ID with one safe upload", async () => {
    const dedupKey = `signal:${randomUUID()}`;
    const calls: Array<{
      multipart: boolean;
      photo: string | null;
    }> = [];
    globalThis.fetch = async (_input, init) => {
      if (init?.body instanceof FormData) {
        calls.push({
          multipart: true,
          photo: String(init.body.get("photo")),
        });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { photo: [{ file_id: "fresh-file-id" }] },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      const body = JSON.parse(String(init?.body)) as { photo?: string };
      calls.push({ multipart: false, photo: body.photo ?? null });
      return new Response(
        JSON.stringify({
          ok: false,
          description: "Bad Request: wrong file identifier/HTTP URL specified",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };
    await insertDelivery({ dedupKey, target: "@altbullet" });
    await database.insert(telegramPatternMediaCacheTable).values({
      mediaKey: await mediaKeyForPhoto(),
      fileId: "expired-file-id",
    });

    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "delivered");
    assert.deepEqual(
      calls.map((call) => call.multipart),
      [false, true],
    );
    assert.equal(calls[0]?.photo, "expired-file-id");
    const cacheRows = await database
      .select()
      .from(telegramPatternMediaCacheTable);
    assert.equal(cacheRows[0]?.fileId, "fresh-file-id");
  });

  test("does not retry or re-upload after a cached-photo timeout", async () => {
    const dedupKey = `signal:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new DOMException("simulated timeout", "TimeoutError");
    };
    await insertDelivery({ dedupKey, target: "@altbullet" });
    await database.insert(telegramPatternMediaCacheTable).values({
      mediaKey: await mediaKeyForPhoto(),
      fileId: "valid-file-id",
    });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "ambiguous");
    assert.equal(calls, 1);
    const cacheRows = await database
      .select()
      .from(telegramPatternMediaCacheTable);
    assert.equal(cacheRows[0]?.fileId, "valid-file-id");
  });

  test("never starts a second multipart upload after a shared upload is unknown", async () => {
    const firstEvent = `signal:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new DOMException("simulated timeout", "TimeoutError");
    };
    await Promise.all([
      insertDelivery({ dedupKey: firstEvent, target: "@altbullet" }),
      insertDelivery({ dedupKey: firstEvent, target: "101" }),
    ]);

    await outbox.drainTelegramPhotoOutbox(firstEvent);

    const firstRows = await deliveryRows(firstEvent);
    assert.equal(calls, 1);
    assert.ok(
      firstRows.every((row) => row.status === "ambiguous"),
      "the remaining recipients must become visible attention, not new uploads",
    );
    const cacheAfterUnknown = await database
      .select()
      .from(telegramPatternMediaCacheTable);
    assert.equal(cacheAfterUnknown[0]?.fileId, null);
    assert.notEqual(cacheAfterUnknown[0]?.uploadAttemptedAt, null);

    // This represents a later worker recovering another recipient from the
    // same business event after the original upload lease has expired.
    await insertDelivery({ dedupKey: firstEvent, target: "202" });
    await outbox.drainTelegramPhotoOutbox(firstEvent);
    const laterRows = await deliveryRows(firstEvent);
    assert.equal(calls, 1);
    assert.equal(
      laterRows.find((row) => row.target === "202")?.status,
      "ambiguous",
    );
  });

  test("lets a separate future signal refresh a media cache blocked by an old event", async () => {
    const oldEvent = `signal:${randomUUID()}`;
    const newEvent = `signal:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async (_input, init) => {
      calls++;
      assert.ok(init?.body instanceof FormData);
      return new Response(
        JSON.stringify({
          ok: true,
          result: { photo: [{ file_id: "recovered-file-id" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await database.insert(telegramPatternMediaCacheTable).values({
      mediaKey: await mediaKeyForPhoto(),
      uploadAttemptedAt: new Date(Date.now() - 60_000),
      uploadEventKey: oldEvent,
      leaseUntil: null,
    });
    await insertDelivery({ dedupKey: newEvent, target: "@altbullet" });

    await outbox.drainTelegramPhotoOutbox(newEvent);

    const rows = await deliveryRows(newEvent);
    assert.equal(calls, 1);
    assert.equal(rows[0]?.status, "delivered");
    const cacheRows = await database
      .select()
      .from(telegramPatternMediaCacheTable);
    assert.equal(cacheRows[0]?.fileId, "recovered-file-id");
  });

  test("rolls back the signal transition and outbox when enqueue fails", async () => {
    const dedupKey = `cancel:${randomUUID()}`;
    await insertActiveTrackedSignal();

    await assert.rejects(
      database.transaction(async (transaction) => {
        const claimed = await transaction
          .update(trackedSignalsTable)
          .set({ status: "cancelled", cancelReason: "test_failure" })
          .where(eq(trackedSignalsTable.id, 1))
          .returning({ id: trackedSignalsTable.id });
        assert.equal(claimed.length, 1);

        return runTelegramPhotoClaimTransaction({
          transaction,
          rows: buildTelegramPhotoDeliveryRows(
            {
              photoPath: "/assets/cancel.png",
              text: "SIGNAL CANCELLED",
              targets: ["@altbullet", "101"],
            },
            dedupKey,
          ),
          claim: async () => true,
          insert: async (tx, rows) => {
            await tx.insert(telegramPhotoDeliveriesTable).values(rows[0]!);
            throw new Error("simulated outbox insert failure");
          },
        });
      }),
      /simulated outbox insert failure/,
    );

    const signal = await sql(
      "SELECT status, cancel_reason FROM tracked_signals WHERE id = 1",
    );
    assert.deepEqual(signal.rows, [{ status: "active", cancel_reason: null }]);
    assert.deepEqual(await deliveryRows(dedupKey), []);
  });

  test("reclaims an expired lease and resumes continuation at next_part_index", async () => {
    const dedupKey = `position:${randomUUID()}`;
    const logFile = `/tmp/${dedupKey.replaceAll(":", "-")}.log`;
    temporaryFiles.add(logFile);
    await insertDelivery({
      dedupKey,
      target: "101",
      status: "processing",
      phase: "continuation",
      nextPartIndex: 1,
      leaseUntil: new Date(Date.now() - 1_000),
      continuationTexts: ["already sent", "resume here", "still later"],
    });

    const result = await launchWorker({ dedupKey, logFile });
    assert.equal(result.code, 0, result.stderr);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "delivered");
    assert.equal(rows[0]?.nextPartIndex, 3);
    assert.equal(rows[0]?.attempts, 1);
    const sentBodies = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { text: string });
    assert.deepEqual(
      sentBodies.map((body) => body.text),
      ["resume here", "still later"],
    );
  });

  test("quarantines an expired persisted send attempt without another Telegram call", async () => {
    const dedupKey = `position:${randomUUID()}`;
    await insertDelivery({
      dedupKey,
      target: "101",
      status: "processing",
      leaseUntil: new Date(Date.now() - 1_000),
      sendAttemptedAt: new Date(Date.now() - 5_000),
    });

    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, "ambiguous");
    assert.equal(rows[0]?.attempts, 0);
    assert.equal(rows[0]?.repeatNotice, false);
    assert.match(
      rows[0]?.lastError ?? "",
      /Telegram outcome unknown after persisted send attempt/,
    );
    const audit = await sql(
      "SELECT outcome, reason, target FROM telegram_delivery_attempt_audit WHERE dedup_key = $1",
      [dedupKey],
    );
    assert.deepEqual(audit.rows, [
      {
        outcome: "ambiguous",
        reason: "Telegram outcome unknown after persisted send attempt",
        target: "101",
      },
    ]);
  });

  test("does not retry a 5xx outcome but keeps one durable unknown-outcome audit", async () => {
    const dedupKey = `position:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ ok: false, description: "temporary outage" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    };
    await insertDelivery({ dedupKey, target: "101" });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "ambiguous");
    assert.equal(calls, 1);
    const audit = await sql(
      "SELECT count(*)::int AS count FROM telegram_delivery_attempt_audit WHERE dedup_key = $1",
      [dedupKey],
    );
    assert.deepEqual(audit.rows, [{ count: 1 }]);
  });

  test("runs one bounded recovery for a new unknown outcome", async () => {
    const dedupKey = `position:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const recovered = calls === 2;
      return new Response(
        JSON.stringify(
          recovered
            ? { ok: true, result: true }
            : { ok: false, description: "temporary outage" },
        ),
        {
          status: recovered ? 200 : 503,
          headers: { "content-type": "application/json" },
        },
      );
    };
    await insertDelivery({
      dedupKey,
      target: "101",
      deliveryPolicyVersion: 3,
    });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    let rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "retry");
    assert.equal(rows[0]?.ambiguousRetryCount, 1);
    assert.equal(rows[0]?.repeatNotice, true);
    assert.equal(calls, 1);

    await database
      .update(telegramPhotoDeliveriesTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(telegramPhotoDeliveriesTable.dedupKey, dedupKey));
    await outbox.drainTelegramPhotoOutbox(dedupKey);
    rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "delivered");
    assert.equal(rows[0]?.ambiguousRetryCount, 1);
    assert.equal(calls, 2);
  });

  test("quarantines a second unknown outcome after the bounded recovery", async () => {
    const dedupKey = `position:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ ok: false, description: "temporary outage" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    };
    await insertDelivery({
      dedupKey,
      target: "101",
      deliveryPolicyVersion: 3,
    });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    await database
      .update(telegramPhotoDeliveriesTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(telegramPhotoDeliveriesTable.dedupKey, dedupKey));
    await outbox.drainTelegramPhotoOutbox(dedupKey);
    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "ambiguous");
    assert.equal(rows[0]?.ambiguousRetryCount, 1);
    assert.equal(rows[0]?.repeatNotice, false);
    assert.equal(calls, 2);
  });

  test("quarantines a malformed 2xx photo result without fallback or resend", async () => {
    const dedupKey = `position:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ ok: false, description: "unverified acceptance" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    await insertDelivery({ dedupKey, target: "101" });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    await outbox.drainTelegramPhotoOutbox(dedupKey);

    const rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "ambiguous");
    assert.equal(rows[0]?.phase, "photo");
    assert.equal(calls, 1);
    const audit = await sql(
      "SELECT count(*)::int AS count FROM telegram_delivery_attempt_audit WHERE dedup_key = $1",
      [dedupKey],
    );
    assert.deepEqual(audit.rows, [{ count: 1 }]);
  });

  test("retries a 429 rejection and accepts the next explicit API success", async () => {
    const dedupKey = `position:${randomUUID()}`;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const rejected = calls === 1;
      return new Response(
        JSON.stringify(
          rejected
            ? { ok: false, description: "Too Many Requests" }
            : { ok: true, result: true },
        ),
        {
          status: rejected ? 429 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    };
    await insertDelivery({ dedupKey, target: "101" });

    await outbox.drainTelegramPhotoOutbox(dedupKey);
    let rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "retry");

    await database
      .update(telegramPhotoDeliveriesTable)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(telegramPhotoDeliveriesTable.dedupKey, dedupKey));
    await outbox.drainTelegramPhotoOutbox(dedupKey);
    rows = await deliveryRows(dedupKey);
    assert.equal(rows[0]?.status, "delivered");
    assert.equal(calls, 2);
  });

  test("delivers concurrent signals to 100 recipients across 429, timeout, 5xx, and restart", async () => {
    const eventKeys = Array.from(
      { length: 3 },
      (_, index) => `load-signal-${index}:${randomUUID()}`,
    );
    const recipients = Array.from({ length: 100 }, (_, index) =>
      String(50_000 + index),
    );
    await sql(
      `INSERT INTO subscribers (chat_id, active, subscribed_until)
       SELECT value::bigint, true, NULL
       FROM unnest($1::text[]) AS value`,
      [recipients],
    );
    for (const eventKey of eventKeys) {
      for (const target of recipients) {
        await insertDelivery({
          dedupKey: eventKey,
          target,
          phase: "fallback",
        });
      }
    }

    const firstAttempts = new Set<string>();
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { chat_id: string };
      const target = String(body.chat_id);
      if (firstAttempts.has(target)) {
        return new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      firstAttempts.add(target);
      const bucket = Number(target) % 3;
      if (bucket === 0) {
        return new Response(
          JSON.stringify({
            ok: false,
            description: "Too Many Requests",
            parameters: { retry_after: 1 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      if (bucket === 1) {
        throw new DOMException("simulated timeout", "TimeoutError");
      }
      return new Response(
        JSON.stringify({ ok: false, description: "temporary outage" }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    };

    await outbox.drainTelegramPhotoOutbox();
    await sql(
      "UPDATE telegram_photo_deliveries SET next_attempt_at = now() - interval '1 second' WHERE status = 'retry'",
    );

    const workerOnlyEventKeys = Array.from(
      { length: 3 },
      (_, index) => `worker-load-signal-${index}:${randomUUID()}`,
    );
    for (const eventKey of workerOnlyEventKeys) {
      for (const target of recipients) {
        await insertDelivery({
          dedupKey: eventKey,
          target,
          phase: "fallback",
        });
      }
    }

    const logFile = `/tmp/telegram-load-${randomUUID()}.log`;
    temporaryFiles.add(logFile);
    const barrierKey = `load-workers:${randomUUID()}`;
    await sql("INSERT INTO outbox_test_barriers (barrier_key) VALUES ($1)", [
      barrierKey,
    ]);
    const restartResults = await Promise.all([
      launchWorker({ logFile, barrierKey }),
      launchWorker({ logFile, barrierKey }),
    ]);
    for (const restartResult of restartResults) {
      assert.equal(restartResult.code, 0, restartResult.stderr);
    }

    const summary = await sql(
      `SELECT status, count(*)::int AS count
       FROM telegram_photo_deliveries
       WHERE dedup_key = ANY($1)
       GROUP BY status`,
      [eventKeys],
    );
    assert.deepEqual(summary.rows, [{ status: "delivered", count: 300 }]);
    const audit = await sql(
      `SELECT classification, count(*)::int AS count
       FROM telegram_delivery_attempt_audit
       WHERE dedup_key = ANY($1)
       GROUP BY classification`,
      [eventKeys],
    );
    const classifications = new Set(
      audit.rows.map((row) => row.classification),
    );
    assert.ok(classifications.has("rate_limited"));
    assert.ok(classifications.has("timeout"));
    assert.ok(classifications.has("server_error"));
    assert.ok(classifications.has("accepted"));

    const dispatches = (await readFile(logFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            chat_id: string;
            dispatched_at: number;
          },
      )
      .sort((left, right) => left.dispatched_at - right.dispatched_at);
    assert.equal(dispatches.length, 400);
    for (let index = 1; index < dispatches.length; index++) {
      assert.ok(
        dispatches[index]!.dispatched_at -
          dispatches[index - 1]!.dispatched_at >=
          3,
        "two workers must share the global Telegram throughput bucket",
      );
    }
    for (const target of recipients) {
      const targetDispatches = dispatches.filter(
        (dispatch) => String(dispatch.chat_id) === target,
      );
      assert.equal(targetDispatches.length, 4);
      for (let index = 1; index < targetDispatches.length; index++) {
        assert.ok(
          targetDispatches[index]!.dispatched_at -
            targetDispatches[index - 1]!.dispatched_at >=
            20,
          "two workers must share the per-recipient Telegram bucket",
        );
      }
    }
  });

  test("commits position and cancellation transitions with every recipient row", async () => {
    const transitions = [
      {
        eventKey: `position:${randomUUID()}`,
        values: { lastUpdateState: "follow" },
        text: "POSITION UPDATE",
        expectedSignal: {
          status: "active",
          cancelReason: null,
          lastUpdateState: "follow",
        },
      },
      {
        eventKey: `cancel:${randomUUID()}`,
        values: { status: "cancelled", cancelReason: "stale" },
        text: "SIGNAL CANCELLED",
        expectedSignal: {
          status: "cancelled",
          cancelReason: "stale",
          lastUpdateState: null,
        },
      },
    ] as const;

    for (const transition of transitions) {
      const signalId = await insertActiveTrackedSignal();

      const result = await outbox.enqueueTelegramPhotoBroadcastAfterClaim({
        photoPath,
        text: transition.text,
        targets: ["@altbullet", "101"],
        eventKey: transition.eventKey,
        claim: async (transaction) => {
          const claimed = await transaction
            .update(trackedSignalsTable)
            .set(transition.values)
            .where(eq(trackedSignalsTable.id, signalId))
            .returning({ id: trackedSignalsTable.id });
          return claimed.length === 1;
        },
      });
      await outbox.drainTelegramPhotoOutbox(transition.eventKey);

      assert.deepEqual(result, { claimed: true, queued: 2 });
      assert.deepEqual(
        (
          await sql(
            'SELECT status, cancel_reason AS "cancelReason", last_update_state AS "lastUpdateState" FROM tracked_signals WHERE id = $1',
            [signalId],
          )
        ).rows,
        [transition.expectedSignal],
      );
      const rows = await deliveryRows(transition.eventKey);
      assert.deepEqual(rows.map((row) => row.target).sort(), [
        "101",
        "@altbullet",
      ]);
    }
  });

  test("atomically claims a critical settings broadcast with channel, subscribers, and owner rows", async () => {
    const dedupKey = `manual-check:${randomUUID()}`;
    const claimedAt = new Date();
    const result = await database.transaction((transaction) =>
      runTelegramPhotoClaimTransaction({
        transaction,
        rows: buildTelegramPhotoDeliveryRows(
          {
            photoPath,
            text: "MANUAL CHECK",
            targets: ["@altbullet", "101", "202", "7818695412"],
          },
          dedupKey,
        ),
        claim: async (tx) => {
          const claimed = await tx
            .update(settingsTable)
            .set({ lastManualCheckSentAt: claimedAt })
            .where(isNull(settingsTable.lastManualCheckSentAt))
            .returning({ id: settingsTable.id });
          return claimed.length === 1;
        },
        insert: async (tx, rows) => {
          const inserted = await tx
            .insert(telegramPhotoDeliveriesTable)
            .values(rows)
            .returning({ id: telegramPhotoDeliveriesTable.id });
          return inserted.length;
        },
      }),
    );

    assert.deepEqual(result, { claimed: true, queued: 4 });
    assert.deepEqual(
      (await deliveryRows(dedupKey)).map((row) => row.target).sort(),
      ["101", "202", "7818695412", "@altbullet"],
    );
    assert.deepEqual(
      (
        await sql(
          "SELECT last_manual_check_sent_at IS NOT NULL AS claimed FROM settings",
        )
      ).rows,
      [{ claimed: true }],
    );
  });

  test("rolls back a settings broadcast claim when recipient rows cannot be inserted", async () => {
    const dedupKey = `watchdog:${randomUUID()}`;

    await assert.rejects(
      database.transaction((transaction) =>
        runTelegramPhotoClaimTransaction({
          transaction,
          rows: buildTelegramPhotoDeliveryRows(
            {
              photoPath,
              text: "WATCHDOG",
              targets: ["@altbullet", "7818695412"],
            },
            dedupKey,
          ),
          claim: async (tx) => {
            const claimed = await tx
              .update(settingsTable)
              .set({ lastWatchdogAlertAt: new Date() })
              .where(isNull(settingsTable.lastWatchdogAlertAt))
              .returning({ id: settingsTable.id });
            return claimed.length === 1;
          },
          insert: async (tx, rows) => {
            await tx.insert(telegramPhotoDeliveriesTable).values(rows[0]!);
            throw new Error("simulated settings outbox insert failure");
          },
        }),
      ),
      /simulated settings outbox insert failure/,
    );

    assert.deepEqual(
      (await sql("SELECT last_watchdog_alert_at FROM settings")).rows,
      [{ last_watchdog_alert_at: null }],
    );
    assert.deepEqual(await deliveryRows(dedupKey), []);
  });
});
