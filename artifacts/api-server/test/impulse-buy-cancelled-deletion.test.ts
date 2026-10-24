import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const start = source.indexOf(
  "async function deleteInvalidCancelledImpulseBuyTrades",
);
const end = source.indexOf(
  "async function deleteInvalidStealthQuietZoneTrades",
  start,
);
assert.ok(start >= 0 && end > start);
const correction = source.slice(start, end);

const targets = [
  [1587, "XAN-USDT", 5486],
  [1590, "UAI-USDT", 5512],
  [1594, "THETA-USDT", 5524],
  [1599, "PUMP-USDT", 5534],
  [1604, "ARB-USDT", 5552],
  [1605, "ENA-USDT", 5558],
  [1606, "1000BONK-USDT", 5562],
  [1607, "SEI-USDT", 5564],
  [1608, "DYM-USDT", 5566],
  [1609, "MINA-USDT", 5570],
  [1618, "BLUR-USDT", 5620],
] as const;

test("cancelled Impulse Buy correction is production-only and exact-fenced", () => {
  assert.match(correction, /process\.env\.NODE_ENV !== "production"/);
  assert.match(source, /await deleteInvalidCancelledImpulseBuyTrades\(\)/);
  assert.match(
    correction,
    /pg_advisory_xact_lock\(hashtext\('invalid_cancelled_impulse_buy_trades_delete_202610'\)\)/,
  );
  assert.match(
    correction,
    /CREATE TEMP TABLE startup_invalid_cancelled_impulse_buy_targets/,
  );
  assert.doesNotMatch(correction, /startup_invalid_stealth_targets/);
  assert.doesNotMatch(correction, /startup_invalid_stealth_photo_ids/);
  assert.match(
    correction,
    /presentCount !== 0 && presentCount !== targets\.length/,
  );
  assert.match(correction, /d\.sentiment_key = 'impulse_buy'/);
  assert.match(correction, /d\.status = 'cancelled'/);
  for (const [trackerId, symbol, signalId] of targets) {
    assert.match(
      correction,
      new RegExp(`${trackerId}, "${symbol}", ${signalId}`),
    );
  }
});

test("correction deletes dependents before tracker then source", () => {
  const trackedDelete = correction.indexOf("DELETE FROM tracked_signals");
  const sourceDelete = correction.indexOf("DELETE FROM signals");
  assert.ok(trackedDelete >= 0 && sourceDelete > trackedDelete);
  assert.match(
    correction,
    /DELETE FROM telegram_delivery_attempt_audit[\s\S]*DELETE FROM telegram_photo_deliveries[\s\S]*DELETE FROM telegram_delivery_events/,
  );
  assert.match(
    correction,
    /DELETE FROM pattern_decision_snapshots[\s\S]*tracked_signal_id[\s\S]*signal_id/,
  );
  assert.match(
    correction,
    /DELETE FROM pattern_backfill_candles[\s\S]*decision_snapshot_id[\s\S]*DELETE FROM pattern_decision_snapshots/,
  );
  assert.match(correction, /DELETE FROM signal_whale_seeds/);
  assert.match(correction, /d\.signal_id = x\.signal_id/);
  assert.match(correction, /d\.tracked_signal_id = x\.tracker_id/);
  const whaleSegment = correction.slice(
    correction.indexOf("DELETE FROM signal_whale_seeds"),
    correction.indexOf(
      'if (await columnExists("signal_whale_seeds", "tracked_signal_id"))',
    ),
  );
  assert.doesNotMatch(whaleSegment, /d\.signal_id[\s\S]*x\.tracker_id/);
  assert.match(
    correction,
    /sourceTrackerRefs[\s\S]*tracker_ref_count[\s\S]*expected exactly tracker/,
  );
});

test("correction uses bounded Telegram prefixes and explicit outbox IDs only", () => {
  assert.match(correction, /LIKE 'cancel:' \|\| x\.tracker_id::text \|\| ':%'/);
  assert.match(
    correction,
    /LIKE 'position:' \|\| x\.tracker_id::text \|\| ':%'/,
  );
  assert.match(
    correction,
    /LIKE 'milestone:v3:' \|\| x\.tracker_id::text \|\| ':%'/,
  );
  assert.match(correction, /d\.payload \? 'signalId'/);
  assert.match(correction, /d\.payload \? 'trackedSignalId'/);
  assert.match(
    correction,
    /a\.dedup_key IN[\s\S]*LIKE 'cancel:'[\s\S]*a\.dedup_key LIKE 'position:'/,
  );
  assert.doesNotMatch(correction, /positions_report/);
  assert.doesNotMatch(correction, /LIKE '%'\s*\|\|/);
});

test("correction covers every requested individual ledger without reports", () => {
  for (const table of [
    "milestone_notification_deliveries",
    "bu_stop_followup_snapshots",
    "altbullet_take_profit_shadow",
    "pattern_decision_snapshots",
    "pattern_backfill_candles",
    "signal_trajectory_log",
    "signal_drawdown_extrema",
    "signal_trailing_events",
    "signal_trailing_shadow_events",
    "signal_profit_lock_shadow_events",
    "signal_health_events",
    "signal_cancel_outcomes",
    "altbullet_indicator_snapshots",
    "liq_cascade_candidate_observations",
    "signal_whale_seeds",
    "telegram_delivery_attempt_audit",
    "telegram_photo_deliveries",
    "telegram_delivery_events",
    "prescan_telemetry_outbox",
  ]) {
    assert.match(correction, new RegExp(table));
  }
  assert.match(correction, /db\.transaction\(async \(tx\)/);
  assert.match(correction, /RETURNING d\.id/);
  assert.match(correction, /counts\.tracked_signals !== targets\.length/);
  assert.match(correction, /counts\.signals !== targets\.length/);
  assert.doesNotMatch(correction, /positions[_-]?report/i);
});

test("correction has explicit rollback diagnostics and idempotent absence path", () => {
  assert.match(
    correction,
    /found partial target state \(\$\{presentCount\}\/\$\{targets\.length\}\)/,
  );
  assert.match(
    correction,
    /if \(presentCount === 0\)[\s\S]*already complete[\s\S]*return;/,
  );
  assert.match(
    correction,
    /preflight failed for source \$\{String\(row\.signal_id\)\}/,
  );
});
