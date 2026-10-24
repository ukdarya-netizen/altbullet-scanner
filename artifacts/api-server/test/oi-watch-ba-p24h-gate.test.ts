import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import {
  BULLISH_ACCUMULATION_MAX_P24H,
  getBullishAccumulationOiWatchFireDecision,
  getBullishAccumulationOiWatchEntrySource,
  isBullishAccumulationOiWatchFireAllowed,
  isBullishAccumulationP24hAllowed,
} from "../src/lib/bullish-accumulation-calibration.js";

type WorkerDecision = {
  path: "path_a" | "path_b";
  price24h: number;
  allowed: boolean;
};

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const integrationEnabled =
  Boolean(integrationDatabaseUrl) &&
  process.env.RUN_OI_WATCH_BA_GATE_INTEGRATION_TESTS === "true";

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

type OiWatchWorker = {
  child: ReturnType<typeof spawn>;
  result: Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
};

function launchOiWatchWorker(params: {
  path: "path_a" | "path_b";
  price24h: number;
  databaseUrl: string;
  readyFile: string;
  startFile: string;
  resultFile: string;
}): OiWatchWorker {
  const compiledWorker = fileURLToPath(
    new URL("./oi-watch-ba-p24h-gate.integration.worker.js", import.meta.url),
  );
  const workerPath = existsSync(compiledWorker)
    ? compiledWorker
    : fileURLToPath(
        new URL(
          "./oi-watch-ba-p24h-gate.integration.worker.ts",
          import.meta.url,
        ),
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
      LOG_LEVEL: "error",
      OI_WATCH_BA_GATE_PATH: params.path,
      OI_WATCH_BA_GATE_P24H: String(params.price24h),
      OI_WATCH_BA_GATE_READY_FILE: params.readyFile,
      OI_WATCH_BA_GATE_START_FILE: params.startFile,
      OI_WATCH_BA_GATE_RESULT_FILE: params.resultFile,
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
  const result = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });

  return { child, result };
}

async function stopOiWatchWorker(
  worker: OiWatchWorker | undefined,
): Promise<void> {
  if (!worker) return;
  if (worker.child.exitCode === null) worker.child.kill("SIGKILL");
  await worker.result.catch(() => undefined);
}

function runGateWorker(
  path: WorkerDecision["path"],
  price24h: number,
): Promise<WorkerDecision> {
  const compiledWorker = fileURLToPath(
    new URL("./oi-watch-ba-p24h-gate.worker.js", import.meta.url),
  );
  const workerPath = existsSync(compiledWorker)
    ? compiledWorker
    : fileURLToPath(
        new URL("./oi-watch-ba-p24h-gate.worker.ts", import.meta.url),
      );
  const command = existsSync(compiledWorker)
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
        OI_WATCH_BA_GATE_PATH: path,
        OI_WATCH_BA_GATE_P24H: String(price24h),
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
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gate worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as WorkerDecision);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("OI Watch Bullish Accumulation p24h gate", () => {
  test("keeps the scanner's calibrated 5% ceiling inclusive", () => {
    assert.equal(BULLISH_ACCUMULATION_MAX_P24H, 5);
    assert.equal(isBullishAccumulationP24hAllowed(5), true);
    assert.equal(isBullishAccumulationP24hAllowed(4.9), true);
    assert.equal(isBullishAccumulationP24hAllowed(5.01), false);
    assert.equal(isBullishAccumulationP24hAllowed(null), false);
  });

  test("allows each OI Watch fire path only below the BA ceiling", () => {
    for (const path of ["path_a", "path_b"] as const) {
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          4.9,
        ),
        true,
      );
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          9.7,
        ),
        false,
      );
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          20.9,
        ),
        false,
      );
    }
  });

  test("applies the same OI route truth table to both OI Watch paths", () => {
    for (const path of ["path_a", "path_b"] as const) {
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          4.9,
          { oi30m: 3.5, oi1h: 0, oi4h: 0 },
        ),
        true,
      );
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          4.9,
          { oi30m: 2.5, oi1h: 2, oi4h: null },
        ),
        true,
      );
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          4.9,
          { oi30m: 3, oi1h: 5, oi4h: 5 },
        ),
        true,
      );
      assert.equal(
        isBullishAccumulationOiWatchFireAllowed(
          path,
          "bullish_accumulation",
          4.9,
          { oi30m: 10.01, oi1h: 5, oi4h: 5 },
        ),
        false,
      );
    }
  });

  test("returns exact OI Watch route decisions and rejection reasons", () => {
    assert.deepEqual(
      getBullishAccumulationOiWatchFireDecision(
        "path_a",
        "bullish_accumulation",
        4.9,
        { oi30m: 3, oi1h: 5, oi4h: 5 },
      ),
      { allowed: true, reason: null, oiPath: "transition_oi30m" },
    );
    assert.deepEqual(
      getBullishAccumulationOiWatchFireDecision(
        "path_b",
        "bullish_accumulation",
        5.01,
        { oi30m: 2, oi1h: 5, oi4h: 5 },
      ),
      {
        allowed: false,
        defer: false,
        reason: "ba_p24h_too_high_5pct",
        oiPath: null,
      },
    );
  });

  test("retains a possible slow-4h route when OI4h is temporarily unavailable", () => {
    assert.deepEqual(
      getBullishAccumulationOiWatchFireDecision(
        "path_a",
        "bullish_accumulation",
        4.9,
        { oi30m: 2, oi1h: 1, oi4h: null },
      ),
      {
        allowed: false,
        defer: true,
        reason: "ba_oi_data_incomplete",
        oiPath: null,
      },
    );
  });

  test("marks post-fix BA OI Watch signals as a clean analytics cohort", () => {
    assert.equal(
      getBullishAccumulationOiWatchEntrySource("path_a", "fresh_oi30m"),
      "oi_watch/path_a/ba-oi-contract-v3/fresh_oi30m",
    );
    assert.equal(
      getBullishAccumulationOiWatchEntrySource("path_a", "transition_oi30m"),
      "oi_watch/path_a/ba-oi-contract-v3/transition_oi30m",
    );
    assert.equal(
      getBullishAccumulationOiWatchEntrySource("path_a", "extended_oi30m"),
      "oi_watch/path_a/ba-oi-contract-v3/extended_oi30m",
    );
    assert.equal(
      getBullishAccumulationOiWatchEntrySource("path_b", "slow_multitf"),
      "oi_watch/path_b/ba-oi-contract-v3/slow_multitf",
    );
  });

  test("blocks overheated BA signals through both fire paths in two workers", async () => {
    const decisions = await Promise.all([
      runGateWorker("path_a", 9.7),
      runGateWorker("path_b", 20.9),
    ]);

    assert.deepEqual(decisions, [
      { path: "path_a", price24h: 9.7, allowed: false },
      { path: "path_b", price24h: 20.9, allowed: false },
    ]);
  });
});

test(
  "two API workers atomically expire overheated BA OI Watch rows",
  { skip: !integrationEnabled },
  async () => {
    assert.ok(integrationDatabaseUrl);

    const schemaName = `oi_watch_ba_gate_${process.pid}_${Date.now()}`;
    const workerDatabaseUrl = databaseUrlWithSearchPath(
      integrationDatabaseUrl,
      schemaName,
    );
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = integrationDatabaseUrl;

    const { pool: rootPool } = await import("@workspace/db");
    const controlDir = await mkdtemp(`${tmpdir()}/oi-watch-ba-gate-`);
    const startFile = `${controlDir}/start`;
    let failure: unknown;

    try {
      await rootPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await rootPool.query(`
        CREATE TABLE ${quoteIdentifier(schemaName)}.oi_watch (
          id serial PRIMARY KEY,
          symbol text NOT NULL,
          trigger_tf text NOT NULL,
          oi_change real NOT NULL,
          price_at_entry real NOT NULL,
          volume_multiplier real NOT NULL,
          sentiment_key text,
          oi_30m real,
          oi_1h real,
          oi_24h real,
          price_1h_change real,
          price_24h_change real,
          current_vol_mult real,
          vol_status_reason text,
          entry_vol_mult real,
          entry_cg_turnover real,
          last_oi_check real,
          prev_oi_check real,
          prev_oi_check2 real,
          status text NOT NULL DEFAULT 'watching',
          added_at timestamp NOT NULL DEFAULT now(),
          expires_at timestamp NOT NULL,
          fired_at timestamp,
          avg_volume real,
          is_vol_confirmed boolean NOT NULL DEFAULT false,
          signal_payload jsonb
        )
      `);
      await rootPool.query(`
        CREATE TABLE ${quoteIdentifier(schemaName)}.signals (
          id serial PRIMARY KEY
        )
      `);
      await rootPool.query(`
        CREATE TABLE ${quoteIdentifier(schemaName)}.tracked_signals (
          id serial PRIMARY KEY
        )
      `);

      const scenarios = [
        {
          name: "path A at 9.7%",
          path: "path_a" as const,
          price24h: 9.7,
          signalPayload: {
            alphaResult: {
              sentimentKey: "bullish_accumulation",
              price24hChange: 9.7,
            },
            signalRow: {},
          },
          expectedStatus: "expired",
          expectedReason: "ba_p24h_too_high_5pct",
        },
        {
          name: "path B at 20.9%",
          path: "path_b" as const,
          price24h: 20.9,
          signalPayload: null,
          expectedStatus: "expired",
          expectedReason: "ba_p24h_too_high_5pct",
        },
        {
          name: "path A control at 4.9%",
          path: "path_a" as const,
          price24h: 4.9,
          signalPayload: {
            alphaResult: {
              sentimentKey: "bullish_accumulation",
              price24hChange: 4.9,
            },
            signalRow: {},
          },
          expectedStatus: "watching",
          expectedReason: null,
        },
      ];

      for (const scenario of scenarios) {
        await rm(startFile, { force: true });
        const readyFiles = [
          `${controlDir}/${scenario.path}-worker-a-ready`,
          `${controlDir}/${scenario.path}-worker-b-ready`,
        ];
        const resultFiles = [
          `${controlDir}/${scenario.path}-worker-a-result`,
          `${controlDir}/${scenario.path}-worker-b-result`,
        ];
        const symbol = "BA-GATE";
        const inserted = await rootPool.query(
          `
            INSERT INTO ${quoteIdentifier(schemaName)}.oi_watch (
              symbol, trigger_tf, oi_change, price_at_entry,
              volume_multiplier, sentiment_key, oi_30m,
              oi_1h, oi_24h, price_24h_change,
              expires_at, is_vol_confirmed, signal_payload
            ) VALUES ($1, 'all+30m', 1, 100, 1, 'bullish_accumulation',
              1, 1, 1, $2, NOW() + INTERVAL '1 hour', $3, $4::jsonb)
            RETURNING id
          `,
          [
            symbol,
            scenario.price24h,
            scenario.path === "path_a",
            scenario.signalPayload
              ? JSON.stringify(scenario.signalPayload)
              : null,
          ],
        );
        const watchId = (inserted.rows[0] as { id: number }).id;

        const workers = [
          launchOiWatchWorker({
            path: scenario.path,
            price24h: scenario.price24h,
            databaseUrl: workerDatabaseUrl,
            readyFile: readyFiles[0]!,
            startFile,
            resultFile: resultFiles[0]!,
          }),
          launchOiWatchWorker({
            path: scenario.path,
            price24h: scenario.price24h,
            databaseUrl: workerDatabaseUrl,
            readyFile: readyFiles[1]!,
            startFile,
            resultFile: resultFiles[1]!,
          }),
        ];

        try {
          await Promise.all(readyFiles.map((path) => waitForFile(path)));
          await writeFile(startFile, `${scenario.name}\n`, "utf8");
          const workerResults = await Promise.all(
            workers.map((worker) => worker.result),
          );
          for (const result of workerResults) {
            assert.equal(
              result.code,
              0,
              `${scenario.name} worker failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
            );
          }

          const workerOutput = await Promise.all(
            resultFiles.map(async (path) => {
              const [line] = (await readFile(path, "utf8"))
                .trim()
                .split("\n")
                .filter(Boolean);
              assert.ok(line, `missing worker result in ${path}`);
              return JSON.parse(line) as { ok: boolean; error?: string };
            }),
          );
          assert.deepEqual(
            workerOutput,
            [{ ok: true }, { ok: true }],
            `${scenario.name} worker reports`,
          );

          const watchResult = await rootPool.query(
            `
              SELECT status, vol_status_reason AS "volStatusReason"
              FROM ${quoteIdentifier(schemaName)}.oi_watch
              WHERE id = $1
            `,
            [watchId],
          );
          assert.equal(watchResult.rowCount, 1);
          assert.deepEqual(watchResult.rows[0], {
            status: scenario.expectedStatus,
            volStatusReason: scenario.expectedReason,
          });

          for (const table of ["signals", "tracked_signals"]) {
            const countResult = await rootPool.query(
              `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`,
            );
            assert.equal(
              countResult.rows[0]?.count,
              0,
              `${scenario.name} wrote to ${table}`,
            );
          }

          await rootPool.query(
            `DELETE FROM ${quoteIdentifier(schemaName)}.oi_watch`,
          );
        } finally {
          await Promise.all(workers.map(stopOiWatchWorker));
          await Promise.all(
            [...readyFiles, ...resultFiles].map((path) =>
              rm(path, { force: true }),
            ),
          );
        }
      }
    } catch (error) {
      failure = error;
    } finally {
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
