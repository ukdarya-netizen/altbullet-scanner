import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function findWorkspaceRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (
      existsSync(join(directory, "artifacts/api-server/src/index.ts")) &&
      existsSync(join(directory, "lib/db/src/schema/signals.ts"))
    ) {
      return directory;
    }

    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(
        "Could not locate workspace root for position schema parity test",
      );
    }
    directory = parent;
  }
}

const workspaceRoot = findWorkspaceRoot();
const apiIndexSource = readFileSync(
  join(workspaceRoot, "artifacts/api-server/src/index.ts"),
  "utf8",
);
const trackedSignalsSchemaSource = readFileSync(
  join(workspaceRoot, "lib/db/src/schema/signals.ts"),
  "utf8",
);

test("close BTC metric stays in the mandatory position schema gate", () => {
  assert.match(
    trackedSignalsSchemaSource,
    /closeBtc24h:\s*real\("close_btc_24h"\)/,
    "tracked_signals Drizzle schema must declare close_btc_24h",
  );

  const gateStart = apiIndexSource.indexOf(
    "async function ensurePositionTrackingSchema",
  );
  const gateEnd = apiIndexSource.indexOf(
    "\nasync function ",
    gateStart + "async function ".length,
  );
  assert.ok(
    gateStart >= 0 && gateEnd > gateStart,
    "position gate boundaries found",
  );

  const gateSource = apiIndexSource.slice(gateStart, gateEnd);
  assert.match(
    gateSource,
    /ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS close_btc_24h real/,
    "position gate must install close_btc_24h idempotently",
  );
  assert.match(
    gateSource,
    /pg_advisory_xact_lock\(hashtext\('position_tracking_schema'\)\)/,
    "position gate must serialize concurrent startup migrations",
  );

  const optionalMigrationStart = apiIndexSource.indexOf(
    "async function runStartupMigration",
  );
  assert.ok(optionalMigrationStart >= 0, "optional startup migration found");
  assert.doesNotMatch(
    apiIndexSource.slice(optionalMigrationStart),
    /close_btc_24h/,
    "close_btc_24h must not depend on optional startup maintenance",
  );

  const gateCall = apiIndexSource.indexOf(
    "await ensurePositionTrackingSchema()",
  );
  const watcherStart = apiIndexSource.indexOf("startWatcher();");
  assert.ok(
    gateCall >= 0 && watcherStart > gateCall,
    "mandatory position gate must run before watcher startup",
  );
});

test("durable trailing armed time stays in the mandatory position schema gate", () => {
  assert.match(
    trackedSignalsSchemaSource,
    /trailingStopArmedAt:\s*timestamp\("trailing_stop_armed_at"\)/,
  );
  const gateStart = apiIndexSource.indexOf(
    "async function ensurePositionTrackingSchema",
  );
  const gateEnd = apiIndexSource.indexOf("\nasync function ", gateStart + 1);
  const gateSource = apiIndexSource.slice(gateStart, gateEnd);
  assert.match(
    gateSource,
    /ALTER TABLE tracked_signals ADD COLUMN IF NOT EXISTS trailing_stop_armed_at timestamp/,
  );
  assert.match(
    gateSource,
    /SET trailing_stop_armed_at = updated_at[\s\S]*trailing_stop_level IS NOT NULL/,
  );
});

test("Stealth method remains identical in source signals and tracker rows", () => {
  const gateStart = apiIndexSource.indexOf(
    "async function ensurePositionTrackingSchema",
  );
  const gateEnd = apiIndexSource.indexOf("\nasync function ", gateStart + 1);
  const gateSource = apiIndexSource.slice(gateStart, gateEnd);
  assert.match(
    gateSource,
    /UPDATE signals AS s[\s\S]*ts\.signal_id = s\.id[\s\S]*ts\.sentiment_key = 'stealth_breakout'[\s\S]*ts\.stealth_detection_method IS NOT NULL[\s\S]*s\.stealth_detection_method IS NULL/,
  );

  const scannerSource = readFileSync(
    join(workspaceRoot, "artifacts/api-server/src/lib/scanner.ts"),
    "utf8",
  );
  assert.match(
    scannerSource,
    /signalsToInsert\.push\(\{[\s\S]*stealthDetectionMethod:\s*base\.stealthDetectionMethod \?\? null/,
  );
});

test("PLM futures taker shadow stays in the mandatory decision schema gate", () => {
  assert.match(
    trackedSignalsSchemaSource,
    /plmFutTakerShadow:\s*text\("plm_fut_taker_shadow"\)/,
  );
  const gateStart = apiIndexSource.indexOf(
    "async function ensurePlmDecisionSnapshotSchema",
  );
  const gateEnd = apiIndexSource.indexOf("\nasync function ", gateStart + 1);
  const gateSource = apiIndexSource.slice(gateStart, gateEnd);
  assert.match(
    gateSource,
    /ALTER TABLE \$\{table\} ADD COLUMN IF NOT EXISTS plm_fut_taker_shadow text/,
  );
  const gateCall = apiIndexSource.indexOf(
    "await ensurePlmDecisionSnapshotSchema()",
  );
  const watcherStart = apiIndexSource.indexOf("startWatcher();");
  assert.ok(gateCall >= 0 && watcherStart > gateCall);
});
