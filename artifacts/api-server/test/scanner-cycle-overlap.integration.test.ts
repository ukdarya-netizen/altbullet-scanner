import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_SCANNER_OVERLAP_INTEGRATION_TESTS === "true";

type WorkerResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type WorkerOutput = {
  stdout: string;
  stderr: string;
};

type DiagnosticWorker = {
  getOutput: () => WorkerOutput;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
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

function launchWorker(params: {
  role: "scanner" | "background";
  databaseUrl: string;
  readyFile: string;
  cancelFile: string;
  transportFile: string;
  resultFile: string;
}): {
  child: ReturnType<typeof spawn>;
  result: Promise<WorkerResult>;
  getOutput: () => WorkerOutput;
} {
  const compiledWorker = fileURLToPath(
    new URL("./scanner-cycle-overlap.worker.js", import.meta.url),
  );
  const workerPath = existsSync(compiledWorker)
    ? compiledWorker
    : fileURLToPath(
        new URL("./scanner-cycle-overlap.worker.ts", import.meta.url),
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
      NODE_ENV: "test",
      SCANNER_OVERLAP_ROLE: params.role,
      SCANNER_OVERLAP_READY_FILE: params.readyFile,
      SCANNER_OVERLAP_CANCEL_FILE: params.cancelFile,
      SCANNER_OVERLAP_TRANSPORT_FILE: params.transportFile,
      SCANNER_OVERLAP_RESULT_FILE: params.resultFile,
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
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return {
    child,
    result,
    getOutput: (): WorkerOutput => ({ stdout, stderr }),
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  const [line] = text.trim().split("\n").filter(Boolean);
  assert.ok(line, `expected JSON result in ${path}`);
  return JSON.parse(line) as Record<string, unknown>;
}

async function stopWorker(
  worker: ReturnType<typeof launchWorker> | undefined,
): Promise<WorkerResult | undefined> {
  if (!worker) return undefined;
  if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
  try {
    return await worker.result;
  } catch {
    return undefined;
  }
}

async function writeFailureDiagnostics(params: {
  diagnosticsDir: string | undefined;
  error: unknown;
  transportFile: string;
  workers: Array<{
    role: "scanner" | "background";
    worker: DiagnosticWorker | undefined;
  }>;
}): Promise<void> {
  if (!params.diagnosticsDir) return;

  try {
    await mkdir(params.diagnosticsDir, { recursive: true });
    const transport = await readFile(params.transportFile, "utf8").catch(
      (error: unknown) =>
        `Unable to read transport event log: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
    );
    const failureText =
      params.error instanceof Error
        ? `${params.error.name}: ${params.error.message}\n${params.error.stack ?? ""}`
        : String(params.error);
    const eventLog =
      typeof transport === "string" ? transport.trim() : String(transport);

    await Promise.all([
      writeFile(
        `${params.diagnosticsDir}/failure.txt`,
        [
          "Scanner overlap integration failure",
          "",
          failureText,
          "",
          "Transport events (role, event, request label):",
          eventLog || "(no transport events recorded)",
          "",
          "Worker output files are named worker-<role>.stdout.log and worker-<role>.stderr.log.",
          "",
        ].join("\n"),
        "utf8",
      ),
      writeFile(`${params.diagnosticsDir}/transport.jsonl`, transport, "utf8"),
      ...params.workers.flatMap(({ role, worker }) => {
        const output = worker?.getOutput() ?? { stdout: "", stderr: "" };
        return [
          writeFile(
            `${params.diagnosticsDir}/worker-${role}.stdout.log`,
            output.stdout,
            "utf8",
          ),
          writeFile(
            `${params.diagnosticsDir}/worker-${role}.stderr.log`,
            output.stderr,
            "utf8",
          ),
        ];
      }),
    ]);
  } catch (diagnosticsError) {
    console.error(
      "Unable to preserve scanner overlap diagnostics:",
      diagnosticsError,
    );
  }
}

test("failure diagnostics retain transport and named worker logs", async () => {
  const controlDir = await mkdtemp(`${tmpdir()}/scanner-overlap-diagnostics-`);
  const diagnosticsDir = `${controlDir}/diagnostics`;
  const transportFile = `${controlDir}/transport.jsonl`;
  const scannerOutput = {
    getOutput: (): WorkerOutput => ({
      stdout: "scanner transport started\n",
      stderr: "scanner worker diagnostic\n",
    }),
  };
  const backgroundOutput = {
    getOutput: (): WorkerOutput => ({
      stdout: "background transport started\n",
      stderr: "background worker diagnostic\n",
    }),
  };
  const emittedEvents = [
    {
      role: "scanner",
      event: "start",
      label: "mock://scanner/active-0",
    },
    {
      role: "background",
      event: "start",
      label: "mock://fast-cycle/critical",
    },
  ];

  try {
    await writeFile(
      transportFile,
      `${emittedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    let failure: unknown;
    try {
      const transportEvents = (await readFile(transportFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(transportEvents, [
        ...emittedEvents,
        {
          role: "scanner",
          event: "start",
          label: "mock://scanner/expected-but-missing",
        },
      ]);
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure,
      "the diagnostics harness must exercise the failure path",
    );

    await writeFailureDiagnostics({
      diagnosticsDir,
      error: failure,
      transportFile,
      workers: [
        { role: "scanner", worker: scannerOutput },
        { role: "background", worker: backgroundOutput },
      ],
    });

    assert.deepEqual((await readdir(diagnosticsDir)).sort(), [
      "failure.txt",
      "transport.jsonl",
      "worker-background.stderr.log",
      "worker-background.stdout.log",
      "worker-scanner.stderr.log",
      "worker-scanner.stdout.log",
    ]);
    const failureText = await readFile(`${diagnosticsDir}/failure.txt`, "utf8");
    assert.match(failureText, /Scanner overlap integration failure/);
    assert.match(failureText, /expected-but-missing/);
    assert.deepEqual(
      await readFile(`${diagnosticsDir}/transport.jsonl`, "utf8"),
      await readFile(transportFile, "utf8"),
    );
    assert.equal(
      await readFile(`${diagnosticsDir}/worker-scanner.stdout.log`, "utf8"),
      "scanner transport started\n",
    );
    assert.equal(
      await readFile(`${diagnosticsDir}/worker-scanner.stderr.log`, "utf8"),
      "scanner worker diagnostic\n",
    );
    assert.equal(
      await readFile(`${diagnosticsDir}/worker-background.stdout.log`, "utf8"),
      "background transport started\n",
    );
    assert.equal(
      await readFile(`${diagnosticsDir}/worker-background.stderr.log`, "utf8"),
      "background worker diagnostic\n",
    );
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
});

async function waitForWorkerFile(
  path: string,
  worker: ReturnType<typeof launchWorker>,
): Promise<void> {
  try {
    await waitForFile(path);
  } catch (error) {
    const result = await Promise.race([
      worker.result,
      sleep(250).then(() => null),
    ]);
    if (result) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `Worker exited with ${result.signal ?? result.code}\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    throw error;
  }
}

test(
  "two workers keep FastCycle responsive and abort stale scanner transport",
  { skip: !integrationEnabled },
  async () => {
    assert.ok(integrationDatabaseUrl);
    const schemaName = `scanner_overlap_${randomUUID().replaceAll("-", "")}`;
    const workerDatabaseUrl = databaseUrlWithSearchPath(
      integrationDatabaseUrl,
      schemaName,
    );
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = integrationDatabaseUrl;
    const { pool: rootPool } = await import("@workspace/db");
    const controlDir = await mkdtemp(`${tmpdir()}/scanner-overlap-`);
    const scannerReadyFile = `${controlDir}/scanner-ready`;
    const backgroundReadyFile = `${scannerReadyFile}.background`;
    const cancelFile = `${controlDir}/cancel`;
    const transportFile = `${controlDir}/transport.jsonl`;
    const scannerResultFile = `${controlDir}/scanner-result.json`;
    const backgroundResultFile = `${controlDir}/background-result.json`;
    const diagnosticsDir = process.env.SCANNER_OVERLAP_DIAGNOSTICS_DIR;
    let scannerWorker: ReturnType<typeof launchWorker> | undefined;
    let backgroundWorker: ReturnType<typeof launchWorker> | undefined;
    let failure: unknown;

    try {
      await rootPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await rootPool.query(`
        CREATE TABLE ${quoteIdentifier(schemaName)}.scheduler_leases (
          lease_name TEXT PRIMARY KEY,
          owner_token TEXT NOT NULL,
          acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `);

      scannerWorker = launchWorker({
        role: "scanner",
        databaseUrl: workerDatabaseUrl,
        readyFile: scannerReadyFile,
        cancelFile,
        transportFile,
        resultFile: scannerResultFile,
      });
      await waitForWorkerFile(scannerReadyFile, scannerWorker);
      const lease = await rootPool.query(
        `SELECT owner_token, expires_at > NOW() AS "notExpired"
         FROM ${quoteIdentifier(schemaName)}.scheduler_leases
         WHERE lease_name = $1`,
        ["market-cycle"],
      );
      assert.equal(lease.rowCount, 1);
      assert.equal(lease.rows[0]?.notExpired, true);

      backgroundWorker = launchWorker({
        role: "background",
        databaseUrl: workerDatabaseUrl,
        readyFile: scannerReadyFile,
        cancelFile,
        transportFile,
        resultFile: backgroundResultFile,
      });
      await waitForWorkerFile(backgroundReadyFile, backgroundWorker);

      const backgroundResult = await readJsonFile(backgroundResultFile);
      assert.equal(backgroundResult.leaseBusyDuringOverlap, true);
      assert.deepEqual(backgroundResult.deferredJobs, [
        "oi-watch",
        "liq-cascade",
        "analytics-backfill",
      ]);
      assert.deepEqual(backgroundResult.rescheduled, [
        {
          job: "oi-watch",
          reason: "market-cycle-lease",
        },
        {
          job: "liq-cascade",
          reason: "market-cycle-lease",
        },
        {
          job: "analytics-backfill",
          reason: "market-cycle-lease",
        },
      ]);
      assert.deepEqual(backgroundResult.started, [
        "mock://fast-cycle/critical",
      ]);

      await writeFile(cancelFile, "abort scanner\n", "utf8");
      const [scannerExit, backgroundExit] = await Promise.all([
        scannerWorker.result,
        backgroundWorker.result,
      ]);
      assert.equal(scannerExit.code, 0, scannerExit.stderr);
      assert.equal(backgroundExit.code, 0, backgroundExit.stderr);

      const scannerResult = await readJsonFile(scannerResultFile);
      assert.equal(scannerResult.error, "SchedulerLeaseLostError");
      assert.equal(scannerResult.aborted, true);
      assert.deepEqual(scannerResult.requestResults, [
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "rejected",
        "fulfilled",
      ]);

      const events = (await readFile(transportFile, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              role: string;
              event: string;
              label: string;
            },
        );
      const scannerScanStarts = events.filter(
        (event) =>
          event.role === "scanner" &&
          event.event === "start" &&
          event.label.startsWith("mock://scanner/"),
      );
      const scannerAborts = events.filter(
        (event) => event.role === "scanner" && event.event === "abort",
      );
      assert.equal(scannerScanStarts.length, 10);
      assert.equal(
        scannerScanStarts.some(
          (event) => event.label === "mock://scanner/queued",
        ),
        false,
      );
      assert.equal(scannerAborts.length, 10);
      assert.deepEqual(
        events.filter(
          (event) =>
            event.role === "scanner" &&
            event.event === "start" &&
            event.label === "mock://fast-cycle/priority",
        ),
        [
          {
            role: "scanner",
            event: "start",
            label: "mock://fast-cycle/priority",
          },
        ],
      );
      assert.deepEqual(
        events.filter((event) => event.role === "background"),
        [
          {
            role: "background",
            event: "start",
            label: "mock://fast-cycle/critical",
          },
        ],
      );
      if (diagnosticsDir) {
        await assert.rejects(access(diagnosticsDir));
      }
    } catch (error) {
      failure = error;
    } finally {
      await Promise.all([
        stopWorker(scannerWorker),
        stopWorker(backgroundWorker),
      ]);
      if (failure) {
        await writeFailureDiagnostics({
          diagnosticsDir,
          error: failure,
          transportFile,
          workers: [
            { role: "scanner", worker: scannerWorker },
            { role: "background", worker: backgroundWorker },
          ],
        });
      }
      await rootPool.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
      );
      await rootPool.end();
      process.env.DATABASE_URL = previousDatabaseUrl;
      await rm(controlDir, { recursive: true, force: true });
    }
    if (failure) throw failure;
  },
);
