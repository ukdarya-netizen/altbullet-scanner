import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { getTableColumns } from "drizzle-orm";
import {
  patternDecisionSnapshotsTable,
  trackedSignalsTable,
} from "@workspace/db";
import {
  FINAL_GATE_REASON_PREFIXES,
  estimateTrajectoryEtaSeconds,
  expectedTrajectoryCoverageBucket,
  buildTrajectoryAdmissionFields,
  classifyTrajectoryAdmission,
  isFinalGateNearMissReason,
  liqCascadeRejectedDecisionEventKey,
  liqWatchDecisionEventKey,
  oiWatchDecisionEventKey,
  scannerRejectedDecisionEventKey,
  trackedDecisionEventKey,
} from "../src/lib/pattern-decision-history.js";

test("tracked decision event keys preserve normal and recycled identities", () => {
  assert.equal(trackedDecisionEventKey(42), "tracked:42");
  assert.equal(
    trackedDecisionEventKey(42, new Date("2026-01-02T03:04:05.000Z")),
    "tracked:42:reentry:2026-01-02T03:04:05.000Z",
  );
});

test("decision history schema exposes durable trajectory completion state", () => {
  const columns = getTableColumns(patternDecisionSnapshotsTable);
  for (const column of [
    "trajectoryStatus",
    "trajectoryAttempts",
    "trajectoryLastAttemptAt",
    "trajectoryNextAttemptAt",
    "trajectoryCompletedAt",
    "trajectoryLastError",
    "trajectoryCandleCount",
    "trajectoryClaimToken",
    "trajectoryClaimedAt",
    "trajectoryClaimExpiresAt",
  ]) {
    assert.ok(column in columns, `missing ${column}`);
  }
});

test("decision history schema exposes nullable decision reasons", () => {
  const columns = getTableColumns(patternDecisionSnapshotsTable);
  assert.ok("decisionReason" in columns);
  assert.equal(columns.decisionReason.notNull, false);
});

test("tracked signal schema keeps generic and legacy decision payloads", () => {
  const columns = getTableColumns(trackedSignalsTable);
  assert.ok("decisionMetrics" in columns);
  assert.ok("impulseDecisionMetrics" in columns);
});

test("non-exception event keys are deterministic and distinguish outcomes", () => {
  const cycle = new Date("2026-01-02T03:04:05.000Z");
  assert.equal(
    scannerRejectedDecisionEventKey(
      cycle,
      "bullish_accumulation",
      "BTC-USDT",
      "cvd_negative",
    ),
    scannerRejectedDecisionEventKey(
      cycle,
      "bullish_accumulation",
      "BTC-USDT",
      "cvd_negative",
    ),
  );
  assert.notEqual(
    scannerRejectedDecisionEventKey(
      cycle,
      "bullish_accumulation",
      "BTC-USDT",
      "cvd_negative",
    ),
    scannerRejectedDecisionEventKey(
      cycle,
      "bullish_accumulation",
      "BTC-USDT",
      "oi_negative",
    ),
  );
  assert.equal(oiWatchDecisionEventKey(8, "watching"), "oi-watch:8:watching");
  assert.equal(liqWatchDecisionEventKey(9, "expired"), "liq-watch:9:expired");
  assert.notEqual(
    liqCascadeRejectedDecisionEventKey("BTC-USDT", 1, "a"),
    liqCascadeRejectedDecisionEventKey("BTC-USDT", 2, "a"),
  );
});

test("scanner rejection keys collapse one reason group inside a 12-hour opportunity", () => {
  const first = new Date("2026-09-06T01:00:00.000Z");
  const repeated = new Date("2026-09-06T11:59:59.000Z");
  const next = new Date("2026-09-06T12:00:00.000Z");
  assert.equal(
    scannerRejectedDecisionEventKey(
      first,
      "balanced_grind",
      "BTC-USDT",
      "p24h_too_high=21.5pct",
    ),
    scannerRejectedDecisionEventKey(
      repeated,
      "balanced_grind",
      "BTC-USDT",
      "p24h_too_high=35.0pct",
    ),
  );
  assert.notEqual(
    scannerRejectedDecisionEventKey(
      first,
      "balanced_grind",
      "BTC-USDT",
      "p24h_too_high=21.5pct",
    ),
    scannerRejectedDecisionEventKey(
      next,
      "balanced_grind",
      "BTC-USDT",
      "p24h_too_high=21.5pct",
    ),
  );
});

test("trajectory ETA is explicit when throughput is known or absent", () => {
  assert.equal(estimateTrajectoryEtaSeconds(120, 60, 6), 43_200);
  assert.equal(estimateTrajectoryEtaSeconds(120, 0, 6), null);
  assert.equal(estimateTrajectoryEtaSeconds(0, 0, 6), 0);
});

test("trajectory horizon coverage uses the last fully closed 15m bucket", () => {
  const decisionAt = new Date("2026-09-13T10:07:00.000Z");
  assert.equal(
    expectedTrajectoryCoverageBucket(
      decisionAt,
      24 * 60 * 60 * 1000,
    )?.toISOString(),
    "2026-09-14T09:45:00.000Z",
  );
  assert.equal(
    expectedTrajectoryCoverageBucket(
      decisionAt,
      72 * 60 * 60 * 1000,
    )?.toISOString(),
    "2026-09-16T09:45:00.000Z",
  );
});

test("trajectory admission keeps valuable decisions and bounds early rejects", () => {
  const base = {
    eventKey: "decision:1",
    symbol: "TEST-USDT",
    decisionAt: new Date("2026-09-13T10:00:00.000Z"),
    entryPrice: 1,
    source: "scanner_sym_reject",
  } as const;
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "balanced_grind",
      decisionKind: "rejected",
      reason: "p24h_too_high=22.1pct",
    }),
    "full",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "impulse_buy",
      decisionKind: "fired",
      reason: null,
    }),
    "full",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "balanced_grind",
      decisionKind: "rejected",
      reason: "p24h_too_high",
      entryPrice: null,
    }),
    "no_price",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "price_led_momentum",
      decisionKind: "rejected",
      reason: "p24h_high=15.6%",
    }),
    "full",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "price_led_momentum",
      decisionKind: "rejected",
    }),
    "full",
  );

  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      eventKey: "early-reject:1",
      patternKey: "stealth_breakout",
      decisionKind: "rejected",
      reason: "structure_4h_no_quiet_zone",
    }),
    "full",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "legacy_pattern",
      decisionKind: "fired",
      reason: null,
    }),
    "audit_only",
  );
  assert.deepEqual(
    buildTrajectoryAdmissionFields({
      ...base,
      patternKey: "legacy_pattern",
      decisionKind: "fired",
      reason: null,
    }),
    {
      trajectoryStatus: "unavailable",
      trajectoryLastError: "retired_pattern_no_backfill",
    },
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "impulse_buy",
      decisionKind: "rejected",
      reason: "candle_body_lt_2pct+volume_lt_1_5x+funding_below_minus_0_1pct",
    }),
    "full",
  );
  assert.equal(
    classifyTrajectoryAdmission({
      ...base,
      patternKey: "liquidation_cascade",
      decisionKind: "rejected",
      reason: "liq_not_exhausted",
    }),
    "full",
  );
});

test("LC detector rejects preserve live price and rejection-time semantics", () => {
  const source = readFileSync(
    new URL("../src/lib/liq-cascade-watcher.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /entryPrice: number \| null/);
  assert.match(source, /decisionAt: input\.observedAt/);
  assert.match(source, /entryPrice: input\.entryPrice/);
  assert.match(
    source,
    /timestamp_semantics: "decision_at_is_first_live_rejection_observation"/,
  );
  assert.match(source, /entry_price: "bingx_ticker_at_rejection"/);

  for (const reason of [
    "quote_volume_below_min",
    "price24h_above_cascade_max",
    "liq_data_unavailable",
    "long_liq_1h_below_min",
    "long_liq_24h_missing_or_zero",
    "long_liq_ratio_below_min",
    "price_not_dumping",
  ]) {
    const rejection = source.slice(source.indexOf(`reason: "${reason}"`));
    assert.notEqual(
      rejection.length,
      source.length,
      `${reason} must be recorded`,
    );
    assert.match(
      rejection.slice(0, 500),
      /entryPrice: detectorPrice > 0 \? detectorPrice : null/,
      `${reason} must carry the live BingX price`,
    );
  }

  const tickerUnavailable = source.slice(
    source.indexOf('reason: "ticker_unavailable"'),
  );
  assert.match(tickerUnavailable.slice(0, 300), /entryPrice: null/);
});

test("canonical final-gate taxonomy preserves prefix and compound reason semantics", () => {
  const base = {
    symbol: "TEST-USDT",
    decisionAt: new Date("2026-09-13T10:00:00.000Z"),
    entryPrice: 1,
    source: "scanner_sym_reject",
    decisionKind: "rejected",
  } as const;

  for (const [patternKey, prefixes] of Object.entries(
    FINAL_GATE_REASON_PREFIXES,
  )) {
    for (const prefix of prefixes) {
      const reason = `early_gate+${prefix}=measured+another_gate`;
      assert.equal(isFinalGateNearMissReason(patternKey, reason), true);
      assert.equal(
        classifyTrajectoryAdmission({
          ...base,
          eventKey: `${patternKey}:${prefix}`,
          patternKey,
          reason,
        }),
        "full",
        `${patternKey}:${prefix} must stay decision-grade`,
      );
    }
  }

  assert.equal(
    isFinalGateNearMissReason("balanced_grind", "early_gate+p24h_too_high"),
    true,
  );
  assert.equal(
    isFinalGateNearMissReason("balanced_grind", "early_gate+vol_mult_low"),
    false,
  );
});

test("snapshot SQL uses pattern identity rather than operational source labels", () => {
  const source = readFileSync(
    new URL("../src/lib/pattern-decision-history.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /COALESCE\(t\.sentiment_key, t\.signal_type, 'unknown'\)/,
  );
  assert.match(
    source,
    /FROM pattern_decision_snapshots d\s+WHERE d\.entry_price > 0\s+AND d\.pattern_key IN \(\$\{TRAJECTORY_PATTERN_KEYS_SQL\}\)\s+AND d\.decision_at <= now\(\) - interval '15 minutes'/s,
  );
  assert.match(source, /COALESCE\(m\.pattern, m\.source, 'unknown'\)/);
  assert.match(
    source,
    /COALESCE\(w\.sentiment_key, w\.trigger_tf, 'unknown'\)/,
  );
  assert.match(source, /'liquidation_cascade'/);
  assert.equal(
    source.match(
      /to_jsonb\(t\) - ARRAY\[[^\]]*\]::text\[\]\)\s+\|\| \(\s*COALESCE\(t\.impulse_decision_metrics/g,
    )?.length,
    2,
  );
  assert.match(source, /COALESCE\(t\.decision_metrics, '\{\}'::jsonb\)/);
  assert.match(source, /'decision_metrics_capture'/);
  assert.match(source, /'persisted_tracker_reconciliation'/);
});

test("Impulse Buy decision metrics exist before tracker reads can start", () => {
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const schemaGateStart = source.indexOf(
    "async function ensurePositionTrackingSchema",
  );
  const watcherStart = source.indexOf("startWatcher();", schemaGateStart);
  const decisionColumn = source.indexOf(
    "ADD COLUMN IF NOT EXISTS impulse_decision_metrics jsonb",
    schemaGateStart,
  );
  const genericDecisionColumn = source.indexOf(
    "ADD COLUMN IF NOT EXISTS decision_metrics jsonb",
    schemaGateStart,
  );

  assert.ok(schemaGateStart >= 0);
  assert.ok(decisionColumn > schemaGateStart);
  assert.ok(genericDecisionColumn > decisionColumn);
  assert.ok(watcherStart > decisionColumn);
  assert.ok(watcherStart > genericDecisionColumn);
});

test("trajectory backfill fairly prioritizes active patterns over legacy backlog", () => {
  const source = readFileSync(
    new URL("../src/lib/pattern-decision-history.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /TRAJECTORY_PATTERN_KEYS_SQL/);
  assert.match(source, /ROW_NUMBER\(\) OVER \(\s*PARTITION BY pattern_key/s);
  assert.match(
    source,
    /ORDER BY lifecycle_rank ASC, pattern_rank ASC,\s*trajectory_priority ASC/s,
  );
  assert.match(
    source,
    /WHERE d\.entry_price > 0\s+AND d\.pattern_key IN \(\$\{TRAJECTORY_PATTERN_KEYS_SQL\}\)/s,
  );
  assert.match(
    source,
    /WHEN pattern_key IN \(\$\{TRAJECTORY_PATTERN_KEYS_SQL\}\) THEN 0/,
  );
  assert.match(
    source,
    /WHERE d\.id = s\.id\s+AND d\.entry_price > 0\s+AND d\.pattern_key IN \(\$\{TRAJECTORY_PATTERN_KEYS_SQL\}\)/s,
  );
  assert.match(source, /trajectory_claim_token = \$\{claimToken\}/);
  assert.match(source, /trajectory_claim_expires_at <= now\(\)/);
  assert.match(source, /AND trajectory_claim_token = \$\{claimToken\}/);
  assert.match(source, /'liq_cascade_fire_reject'/);
  assert.match(source, /FINAL_GATE_REASON_PREFIXES/);
  assert.match(source, /FINAL_GATE_REASON_SQL/);
  assert.equal(
    source.match(/\$\{DECISION_GRADE_TRAJECTORY_SQL\}/g)?.length,
    2,
    "queue status and scheduling must share the classifier",
  );
  assert.match(
    source,
    /WHEN \$\{DECISION_GRADE_TRAJECTORY_SQL\} THEN 1\s+ELSE 2/s,
  );
  assert.match(
    source,
    /ROW_NUMBER\(\) OVER \(\s*PARTITION BY pattern_key\s+ORDER BY\s+trajectory_priority ASC/s,
  );
  assert.match(source, /decision_grade_backlog/);
  assert.match(source, /audit_sample_backlog/);
  assert.match(source, /decision_grade_due_by_pattern/);
  assert.match(source, /audit_sample_due_by_pattern/);
});

test("LC rejected trajectory is atomically derived from the canonical observation", () => {
  const source = readFileSync(
    new URL("../src/lib/liq-cascade-observation.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /WITH canonical_observation AS/);
  assert.match(source, /ON CONFLICT \(event_key\) DO UPDATE/);
  assert.match(
    source,
    /WHEN existing\.price IS NULL OR existing\.price <= 0\s+THEN EXCLUDED\.price/s,
  );
  assert.match(source, /FROM canonical_observation o/);
  assert.match(
    source,
    /CASE WHEN o\.price IS NULL OR o\.price <= 0\s+THEN 'unavailable' ELSE 'pending' END/s,
  );
  assert.match(source, /'liq_cascade_fire_reject'/);
});

test("every pattern-debug rejection is centrally given durable candidate context", () => {
  const source = readFileSync(
    new URL("../src/lib/scanner.ts", import.meta.url),
    "utf8",
  );
  const rejectCalls = source.match(/\b_pdbReject\s*\(/g) ?? [];
  assert.ok(rejectCalls.length >= 25, "expected all pattern-specific gates");

  const rejectImplementation = source.slice(
    source.indexOf("export function _pdbReject"),
    source.indexOf("export function _pdbEnsure"),
  );
  assert.match(rejectImplementation, /const context = _pdbCtx\.value/);
  assert.match(rejectImplementation, /_symRej\(/);
  for (const field of [
    "context.symbol",
    "context.entryPrice",
    "context.oi30m",
    "context.volMult",
    "context.price24h",
    "context.prescanCycles",
  ]) {
    assert.ok(rejectImplementation.includes(field), `missing ${field}`);
  }

  assert.match(
    source,
    /_pdbCtx\.value = Object\.freeze\(\{\s*symbol,\s*entryPrice: close > 0 \? close : null,\s*oi30m: oi30m \?\? null,\s*volMult: volMult \?\? null,\s*price24h: price24hChange \?\? null,\s*prescanCycles:/,
  );
  assert.match(source, /entryPrice: row\.decisionEntryPrice/);
  assert.match(source, /scanner_current_30m_kline_close/);
  assert.match(source, /const dedupKey = `\$\{pattern\}.*\$\{reason\}/s);
  assert.match(source, /priceLedMomentumMetrics/);
  for (const field of [
    "p24h:",
    "p3h:",
    "snf1h:",
    "snf4h:",
    "cvd15m:",
    "cvd30m:",
    "cvd1h:",
    "cvd4h:",
    "cvdCount:",
    "oi30m:",
    "oi1h:",
    "oi4h:",
    "volume:",
    "prescanCycles:",
  ]) {
    assert.ok(source.includes(field), `missing PLM metric ${field}`);
  }
  assert.match(source, /decisionMetrics: base\.decisionMetrics/);
});

const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;

function databaseUrlWithSearchPath(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

test(
  "trajectory claims prioritize decision-grade rows fairly in PostgreSQL",
  { skip: !integrationDatabaseUrl },
  async () => {
    const schema = `pattern_claim_test_${process.pid}_${Date.now()}`;
    const { pool: rootPool } = await import("@workspace/db");
    const workerUrl = databaseUrlWithSearchPath(
      integrationDatabaseUrl!,
      schema,
    );

    await rootPool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        const child = spawn(
          "../../node_modules/.pnpm/node_modules/.bin/tsx",
          [
            new URL(
              "./pattern-decision-history.integration.worker.ts",
              import.meta.url,
            ).pathname,
          ],
          {
            env: {
              ...process.env,
              DATABASE_URL: workerUrl,
              TELEGRAM_BOT_TOKEN: "test",
              NODE_ENV: "test",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(new Error(`integration worker exited ${code}: ${stderr}`));
        });
      });
    } finally {
      await rootPool.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
      );
    }
  },
);
