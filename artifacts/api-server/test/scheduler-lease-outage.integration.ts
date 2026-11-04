import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const enabled = process.env.RUN_SCHEDULER_LEASE_OUTAGE_TESTS === "true";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type WorkerResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `${command} ${args.join(" ")} exited with ${signal ?? code}`,
          ),
        );
      }
    });
  });
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function launchWorker(params: {
  databaseUrl: string;
  workerId: string;
  eventKey: string;
  readyFile: string;
  continueFile: string;
  deliveryFile: string;
  resultFile: string;
  ttlMs: number;
  heartbeatMs: number;
  leaseName?: string;
  releaseTimeoutMs?: number;
  beforeReleaseFile?: string;
  releaseContinueFile?: string;
}): Promise<{
  child: ReturnType<typeof spawn>;
  result: Promise<WorkerResult>;
}> {
  const compiledWorker = fileURLToPath(
    new URL("./scheduler-lease-outage-worker.js", import.meta.url),
  );
  const workerPath = existsSync(compiledWorker)
    ? compiledWorker
    : fileURLToPath(
        new URL("./scheduler-lease-outage-worker.ts", import.meta.url),
      );
  const command = existsSync(compiledWorker)
    ? process.execPath
    : fileURLToPath(
        new URL(
          "../../../node_modules/.pnpm/node_modules/.bin/tsx",
          import.meta.url,
        ),
      );
  const child = spawn(command, [workerPath], {
    env: {
      ...process.env,
      DATABASE_URL: params.databaseUrl,
      NODE_ENV: "production",
      TELEGRAM_BOT_TOKEN: "outage-drill-test-token",
      OUTAGE_DRILL_WORKER_ID: params.workerId,
      OUTAGE_DRILL_EVENT_KEY: params.eventKey,
      OUTAGE_DRILL_READY_FILE: params.readyFile,
      OUTAGE_DRILL_CONTINUE_FILE: params.continueFile,
      OUTAGE_DRILL_DELIVERY_FILE: params.deliveryFile,
      OUTAGE_DRILL_RESULT_FILE: params.resultFile,
      OUTAGE_DRILL_TTL_MS: String(params.ttlMs),
      OUTAGE_DRILL_HEARTBEAT_MS: String(params.heartbeatMs),
      ...(params.leaseName
        ? { OUTAGE_DRILL_LEASE_NAME: params.leaseName }
        : {}),
      ...(params.releaseTimeoutMs
        ? {
            OUTAGE_DRILL_RELEASE_TIMEOUT_MS: String(params.releaseTimeoutMs),
          }
        : {}),
      ...(params.beforeReleaseFile
        ? { OUTAGE_DRILL_BEFORE_RELEASE_FILE: params.beforeReleaseFile }
        : {}),
      ...(params.releaseContinueFile
        ? { OUTAGE_DRILL_RELEASE_CONTINUE_FILE: params.releaseContinueFile }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, result };
}

async function startPostgres(dataDir: string, port: number): Promise<void> {
  await runCommand("pg_ctl", [
    "-D",
    dataDir,
    "-o",
    `-p ${port} -h 127.0.0.1 -k ${dataDir}`,
    "-w",
    "start",
  ]);
}

async function stopPostgres(dataDir: string): Promise<void> {
  try {
    await runCommand("pg_ctl", [
      "-D",
      dataDir,
      "-m",
      "immediate",
      "-w",
      "stop",
    ]);
  } catch {
    // Cleanup is idempotent when the test already stopped the cluster.
  }
}

async function runSql(databaseUrl: string, statement: string): Promise<string> {
  const { stdout } = await execFileAsync("psql", [
    "--dbname",
    databaseUrl,
    "--no-psqlrc",
    "--tuples-only",
    "--no-align",
    "--quiet",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    statement,
  ]);
  return stdout.trim();
}

async function queryJson<T>(
  databaseUrl: string,
  statement: string,
): Promise<T> {
  return JSON.parse((await runSql(databaseUrl, statement)) || "null") as T;
}

function holdMarketLeaseRowLock(
  databaseUrl: string,
  durationMs: number,
): { locked: Promise<void>; done: Promise<void> } {
  const child = spawn(
    "psql",
    [
      "--dbname",
      databaseUrl,
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  const locked = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("lease-row-locked")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!stdout.includes("lease-row-locked")) {
        reject(
          new Error(`lease lock exited before acquiring (${signal ?? code})`),
        );
      }
    });
  });
  child.stdin?.write(`
    BEGIN;
    SELECT lease_name FROM scheduler_leases
    WHERE lease_name = 'market-cycle' FOR UPDATE;
    SELECT 'lease-row-locked';
  `);
  void locked.then(() => {
    setTimeout(() => {
      child.stdin?.end("COMMIT;\n\\q\n");
    }, durationMs);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`lease lock exited with ${signal ?? code}`));
    });
  });
  return { locked, done };
}

const OUTAGE_SCHEMA_SQL = `
  CREATE TABLE scheduler_leases (
    lease_name text PRIMARY KEY,
    owner_token text NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE TABLE outage_business_events (
    event_key text PRIMARY KEY,
    first_worker_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE outage_signal_write_attempts (
    id serial PRIMARY KEY,
    event_key text NOT NULL,
    worker_id text NOT NULL,
    stage text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
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
  );
  CREATE TABLE telegram_delivery_events (
    id serial PRIMARY KEY,
    event_key text NOT NULL,
    expected_recipient_count integer NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    last_error text,
    completed_at timestamp,
    attention_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX telegram_delivery_event_key_unique
    ON telegram_delivery_events (event_key);
  CREATE TABLE telegram_pattern_media_cache (
    media_key text PRIMARY KEY,
    file_id text,
    lease_until timestamp,
    claim_token text,
    upload_attempted_at timestamp,
    upload_event_key text,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE telegram_delivery_attempt_audit (
    id serial PRIMARY KEY,
    audit_key text NOT NULL,
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
  );
  CREATE TABLE telegram_delivery_rate_limits (
    bucket_key text PRIMARY KEY,
    next_allowed_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX telegram_delivery_attempt_audit_key_unique
    ON telegram_delivery_attempt_audit (audit_key);
  CREATE UNIQUE INDEX telegram_photo_delivery_unique
    ON telegram_photo_deliveries (dedup_key, target);
  CREATE INDEX telegram_photo_delivery_due
    ON telegram_photo_deliveries (status, next_attempt_at, lease_until);
`;

test(
  "two live workers keep one business event through a database outage and lease reclamation",
  { skip: !enabled },
  async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/scheduler-lease-outage-`);
    const controlDir = await mkdtemp(
      `${tmpdir()}/scheduler-lease-outage-files-`,
    );
    const port = await findFreePort();
    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const eventKey = `outage-drill:${process.pid}:${Date.now()}`;
    const readyFile = `${controlDir}/original-ready.log`;
    const replacementReadyFile = `${controlDir}/replacement-ready.log`;
    const originalContinueFile = `${controlDir}/original-continue`;
    const replacementContinueFile = `${controlDir}/replacement-continue`;
    const deliveryFile = `${controlDir}/telegram-deliveries.log`;
    const originalResultFile = `${controlDir}/original-result.log`;
    const replacementResultFile = `${controlDir}/replacement-result.log`;
    const ttlMs = 600;
    const heartbeatMs = 100;
    let originalWorker: Awaited<ReturnType<typeof launchWorker>> | undefined;
    let replacementWorker: Awaited<ReturnType<typeof launchWorker>> | undefined;

    try {
      await execFileAsync("initdb", [
        "-D",
        dataDir,
        "--username=postgres",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      await startPostgres(dataDir, port);

      await runSql(databaseUrl, OUTAGE_SCHEMA_SQL);
      await writeFile(replacementContinueFile, "continue", "utf8");

      originalWorker = await launchWorker({
        databaseUrl,
        workerId: "original-worker",
        eventKey,
        readyFile,
        continueFile: originalContinueFile,
        deliveryFile,
        resultFile: originalResultFile,
        ttlMs,
        heartbeatMs,
      });
      await waitForFile(readyFile, 5_000);

      // Make PostgreSQL genuinely unavailable while the original job is still
      // inside its market-cycle lease. It remains alive so that, once the
      // replacement has reclaimed the expired row, its own lease guard has to
      // prevent stale writes and Telegram delivery.
      await stopPostgres(dataDir);
      await sleep(ttlMs + 150);

      await startPostgres(dataDir, port);
      const replacement = await launchWorker({
        databaseUrl,
        workerId: "replacement-worker",
        eventKey,
        readyFile: replacementReadyFile,
        continueFile: replacementContinueFile,
        deliveryFile,
        resultFile: replacementResultFile,
        ttlMs,
        heartbeatMs,
      });
      replacementWorker = replacement;
      const replacementResult = await replacement.result;
      assert.equal(replacementResult.code, 0, replacementResult.stderr);
      assert.equal(replacementResult.signal, null);
      await writeFile(originalContinueFile, "continue", "utf8");
      const originalResult = await originalWorker.result;
      assert.equal(originalResult.code, 0, originalResult.stderr);
      assert.equal(originalResult.signal, null);
      const [originalOutcome] = (await readFile(originalResultFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { error?: string });
      assert.equal(originalOutcome?.error, "SchedulerLeaseLostError");

      const events = await queryJson<
        Array<{ event_key: string; first_worker_id: string }>
      >(
        databaseUrl,
        `SELECT coalesce(json_agg(row_to_json(event)), '[]'::json)
         FROM (
           SELECT event_key, first_worker_id
           FROM outage_business_events
           WHERE event_key = '${eventKey}'
         ) event`,
      );
      const signalWrites = await queryJson<
        Array<{ worker_id: string; stage: string }>
      >(
        databaseUrl,
        `SELECT coalesce(json_agg(row_to_json(attempt)), '[]'::json)
         FROM (
           SELECT worker_id, stage
           FROM outage_signal_write_attempts
           WHERE event_key = '${eventKey}'
           ORDER BY id
         ) attempt`,
      );
      const deliveries = await queryJson<
        Array<{ status: string; attempts: number; delivered: boolean }>
      >(
        databaseUrl,
        `SELECT coalesce(json_agg(row_to_json(delivery)), '[]'::json)
         FROM (
           SELECT status, attempts, delivered_at IS NOT NULL AS delivered
           FROM telegram_photo_deliveries
           WHERE dedup_key = '${eventKey}'
         ) delivery`,
      );

      assert.equal(events.length, 1, "one business event must exist");
      assert.deepEqual(events[0], {
        event_key: eventKey,
        first_worker_id: "original-worker",
      });
      assert.deepEqual(signalWrites, [
        { worker_id: "original-worker", stage: "first" },
        { worker_id: "replacement-worker", stage: "first" },
        { worker_id: "replacement-worker", stage: "second" },
      ]);
      // New delivery policy fences uncertain Telegram outcomes instead of
      // repeating a photo. Both a confirmed delivery and a single ambiguous
      // attempt preserve the no-duplicate guarantee this outage drill checks.
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.attempts, 1);
      assert.ok(
        (deliveries[0]?.status === "delivered" &&
          deliveries[0].delivered === true) ||
          (deliveries[0]?.status === "ambiguous" &&
            deliveries[0].delivered === false),
      );

      const telegramDeliveries = (
        await readFile(deliveryFile, "utf8").catch(() => "")
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { workerId: string }).workerId);
      assert.ok(
        telegramDeliveries.length === 0 ||
          (telegramDeliveries.length === 1 &&
            telegramDeliveries[0] === "replacement-worker"),
      );
    } finally {
      if (originalWorker && originalWorker.child.exitCode === null) {
        originalWorker.child.kill("SIGKILL");
      }
      if (replacementWorker && replacementWorker.child.exitCode === null) {
        replacementWorker.child.kill("SIGKILL");
      }
      await stopPostgres(dataDir);
      await rm(dataDir, { recursive: true, force: true });
      await rm(controlDir, { recursive: true, force: true });
    }
  },
);

test(
  "a background release timeout does not block the next discovery scanner cycle",
  { skip: !enabled },
  async () => {
    const dataDir = await mkdtemp(`${tmpdir()}/scanner-priority-outage-`);
    const controlDir = await mkdtemp(
      `${tmpdir()}/scanner-priority-outage-files-`,
    );
    const port = await findFreePort();
    const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    const backgroundEventKey = `background-outage:${process.pid}:${Date.now()}`;
    const scannerEventKey = `scanner-after-outage:${process.pid}:${Date.now()}`;
    const backgroundReadyFile = `${controlDir}/background-ready.log`;
    const backgroundContinueFile = `${controlDir}/background-continue`;
    const beforeReleaseFile = `${controlDir}/background-before-release.log`;
    const releaseContinueFile = `${controlDir}/background-release-continue`;
    const scannerReadyFile = `${controlDir}/scanner-ready.log`;
    const scannerContinueFile = `${controlDir}/scanner-continue`;
    const deliveryFile = `${controlDir}/telegram-deliveries.log`;
    const backgroundResultFile = `${controlDir}/background-result.log`;
    const scannerResultFile = `${controlDir}/scanner-result.log`;
    let backgroundWorker: Awaited<ReturnType<typeof launchWorker>> | undefined;
    let scannerWorker: Awaited<ReturnType<typeof launchWorker>> | undefined;

    try {
      await execFileAsync("initdb", [
        "-D",
        dataDir,
        "--username=postgres",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      await startPostgres(dataDir, port);
      await runSql(databaseUrl, OUTAGE_SCHEMA_SQL);

      backgroundWorker = await launchWorker({
        databaseUrl,
        workerId: "background-worker",
        eventKey: backgroundEventKey,
        readyFile: backgroundReadyFile,
        continueFile: backgroundContinueFile,
        deliveryFile,
        resultFile: backgroundResultFile,
        ttlMs: 5_000,
        heartbeatMs: 100,
        releaseTimeoutMs: 100,
        beforeReleaseFile,
        releaseContinueFile,
      });
      await waitForFile(backgroundReadyFile, 5_000);
      await writeFile(backgroundContinueFile, "continue", "utf8");
      await waitForFile(beforeReleaseFile, 5_000);

      // Held longer than the inline release retries (~2.3 s) so they all fail.
      const releaseLock = holdMarketLeaseRowLock(databaseUrl, 4_000);
      await releaseLock.locked;
      await writeFile(releaseContinueFile, "release", "utf8");

      // The background worker now has a timed-out release of market-cycle.
      // Discovery uses a separate row and must acquire immediately, without
      // waiting for market-cycle's TTL or the blocked DELETE to finish.
      await writeFile(scannerContinueFile, "continue", "utf8");
      scannerWorker = await launchWorker({
        databaseUrl,
        workerId: "scanner-worker",
        eventKey: scannerEventKey,
        readyFile: scannerReadyFile,
        continueFile: scannerContinueFile,
        deliveryFile,
        resultFile: scannerResultFile,
        ttlMs: 5_000,
        heartbeatMs: 100,
        leaseName: "discovery-scanner",
      });
      const scannerResult = await scannerWorker.result;
      assert.equal(scannerResult.code, 0, scannerResult.stderr);
      assert.equal(scannerResult.signal, null);

      await releaseLock.done;
      const backgroundResult = await backgroundWorker.result;
      assert.equal(backgroundResult.code, 0, backgroundResult.stderr);
      const backgroundOutcomes = (await readFile(backgroundResultFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { error?: string });
      const backgroundOutcome = backgroundOutcomes.at(-1);
      assert.equal(
        backgroundOutcome?.error,
        "SchedulerLeaseReleaseError",
        JSON.stringify({
          backgroundOutcome,
          stdout: backgroundResult.stdout,
          stderr: backgroundResult.stderr,
        }),
      );

      const [scannerOutcome] = (await readFile(scannerResultFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { acquired?: boolean });
      assert.equal(scannerOutcome?.acquired, true);
    } finally {
      if (backgroundWorker && backgroundWorker.child.exitCode === null) {
        backgroundWorker.child.kill("SIGKILL");
      }
      if (scannerWorker && scannerWorker.child.exitCode === null) {
        scannerWorker.child.kill("SIGKILL");
      }
      await stopPostgres(dataDir);
      await rm(dataDir, { recursive: true, force: true });
      await rm(controlDir, { recursive: true, force: true });
    }
  },
);
