/**
 * Focused unit tests for reconcilePendingSignalAlerts reliability properties.
 *
 * These tests import the pure policy module instead of telegram.ts, which
 * transitively pulls in the production database runtime.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  canRecoverPrimaryAlert,
  createSingleFlight,
  PRIMARY_ALERT_RECOVERY_MAX_AGE_MS,
  RECONCILE_ADVISORY_LOCK_KEY,
} from "../src/lib/telegram-reconcile-policy.js";
import { shouldRecoverDeliveredSignal } from "../src/lib/delivered-signal-recovery-policy.js";

// ── 1. Advisory lock key stability ───────────────────────────────────────────
// This value is baked into every running DB session.  Changing it allows two
// workers to hold locks simultaneously during a rolling deploy.
// Source: telegram.ts RECONCILE_ADVISORY_LOCK_KEY
// hex: 0x616c745f7369 ("alt_sg" — abbreviated "alt_signal")

describe("reconcilePendingSignalAlerts: advisory lock key", () => {
  test("documented key equals 0x616c745f7369", () => {
    assert.equal(RECONCILE_ADVISORY_LOCK_KEY, 0x616c745f7369);
  });

  test("fits in a safe JavaScript integer (no precision loss)", () => {
    // pg advisory lock keys are int8 on the server; JS must represent exactly.
    // Keys above Number.MAX_SAFE_INTEGER would silently lose bits when passed
    // as SQL parameters through Drizzle, causing incorrect lock matching.
    assert.ok(
      RECONCILE_ADVISORY_LOCK_KEY <= Number.MAX_SAFE_INTEGER,
      "advisory lock key exceeds MAX_SAFE_INTEGER — precision loss in JS",
    );
  });
});

// ── 2. Signal event-key format (outbox idempotency) ──────────────────────────
// The outbox dedup key is `signal:<id>`.  A stable format guarantees that
// re-queuing after a crash uses the same key and onConflictDoNothing wins.

describe("reconcilePendingSignalAlerts: signal event-key format", () => {
  test("event key is signal:<id> for integer IDs", () => {
    const id = 42;
    assert.equal(`signal:${id}`, "signal:42");
  });

  test("different signal IDs produce different event keys", () => {
    assert.notEqual(`signal:${1}`, `signal:${2}`);
  });

  test("event key is stable regardless of stringification method", () => {
    const id = 999;
    assert.equal(`signal:${id}`, `signal:${String(id)}`);
  });
});

describe("reconcilePendingSignalAlerts: tracker atomicity", () => {
  test("primary alert recovery requires a durable tracked signal", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/telegram.ts"),
      "utf8",
    );
    assert.match(
      source,
      /EXISTS\s*\(\s*SELECT 1\s*FROM tracked_signals ts\s*WHERE ts\.signal_id = \$\{signalsTable\.id\}/s,
    );
  });

  test("orphan recovery requires confirmed delivery and missing tracker", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/watcher.ts"),
      "utf8",
    );
    assert.match(source, /d\.status = 'delivered'/);
    assert.match(
      source,
      /NOT EXISTS\s*\(\s*SELECT 1\s*FROM tracked_signals ts\s*WHERE ts\.signal_id = s\.id/s,
    );
  });

  test("an old orphan is not recovered after a newer tracker trade exists", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/watcher.ts"),
      "utf8",
    );
    assert.match(
      source,
      /NOT EXISTS\s*\(\s*SELECT 1\s*FROM tracked_signals newer\s*WHERE newer\.symbol = s\.symbol\s*AND newer\.detected_at > s\.detected_at\s*\)/s,
    );
  });

  test("recovery remains allowed when no newer tracker trade exists", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/watcher.ts"),
      "utf8",
    );
    const recoveryQuery = source.slice(
      source.indexOf(
        "export async function reconcileDeliveredSignalsMissingTracker",
      ),
      source.indexOf(
        "// ── Startup reset:",
        source.indexOf(
          "export async function reconcileDeliveredSignalsMissingTracker",
        ),
      ),
    );
    assert.match(recoveryQuery, /AND NOT EXISTS\s*\([^)]*newer/s);
    assert.doesNotMatch(
      recoveryQuery,
      /WHERE newer\.symbol = s\.symbol[\s\S]*newer\.status/,
      "a later tracker row blocks recovery regardless of how that later trade closed",
    );
  });

  test("old orphan followed by a newer closed trade is rejected", () => {
    assert.equal(
      shouldRecoverDeliveredSignal(
        new Date("2026-08-24T10:00:00.000Z"),
        new Date("2026-08-25T10:00:00.000Z"),
      ),
      false,
    );
  });

  test("INX-like orphan without a newer position is still recovered", () => {
    assert.equal(
      shouldRecoverDeliveredSignal(new Date("2026-08-25T10:00:00.000Z"), null),
      true,
    );
  });

  test("superseded recovered positions are closed idempotently", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/watcher.ts"),
      "utf8",
    );
    assert.match(
      source,
      /recovered\.entry_source = 'delivered_signal_recovery'/,
    );
    assert.match(source, /recovered\.status IN \('active', 'in_run'\)/);
    assert.match(source, /cancel_reason = 'superseded_recovery'/);
    assert.match(
      source,
      /newer\.symbol = recovered\.symbol\s*AND newer\.detected_at > recovered\.detected_at/s,
    );
  });
});

describe("real signal overview contract", () => {
  test("real scope and summary require a tracked signal link", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/routes/signals.ts"),
      "utf8",
    );

    assert.match(source, /req\.query\.scope === "real"/);
    assert.match(
      source,
      /if \(scope === "real"\)[\s\S]*EXISTS \(\s*SELECT 1 FROM tracked_signals ts\s*WHERE ts\.signal_id = signals\.id/s,
    );
    assert.match(
      source,
      /const trackerCondition = and\(\s*inArray\(trackedSignalsTable\.sentimentKey, ACTIVE_PATTERN_KEYS\),\s*sql`\$\{trackedSignalsTable\.status\} <> 'reclassified'`/s,
    );
    assert.match(source, /\.from\(trackedSignalsTable\)/);
    assert.match(
      source,
      /\.where\(and\(gte\(trackedSignalsTable\.detectedAt, today\), trackerCondition\)\)/,
    );
  });

  test("Telegram delivery is reported independently from tracker status", () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), "src/routes/signals.ts"),
      "utf8",
    );
    const specSource = readFileSync(
      resolve(process.cwd(), "../../lib/api-spec/openapi.yaml"),
      "utf8",
    );

    assert.match(
      routeSource,
      /telegramDeliveryStatus:[\s\S]*FROM telegram_delivery_events tde[\s\S]*tde\.event_key = \('signal:' \|\| signals\.id::text\)/,
    );
    assert.match(specSource, /telegramDeliveryStatus:\s*\n\s*type: string/);
  });

  test("preliminary rows are discarded only when no tracker references them", () => {
    const watcherSource = readFileSync(
      resolve(process.cwd(), "src/lib/watcher.ts"),
      "utf8",
    );
    const scannerSource = readFileSync(
      resolve(process.cwd(), "src/lib/scanner.ts"),
      "utf8",
    );

    assert.match(
      watcherSource,
      /export async function discardUntrackedSignal[\s\S]*DELETE[\s\S]*NOT EXISTS \(\s*SELECT 1 FROM tracked_signals ts\s*WHERE ts\.signal_id = \$\{signalsTable\.id\}/i,
    );
    assert.match(
      scannerSource,
      /discardUntrackedSignal\(\s*inserted\.id,\s*"tracker_persist_failed"/,
    );
    assert.match(
      scannerSource,
      /discardUntrackedSignal\(\s*inserted\.id,\s*"duplicate_or_post_pump"/,
    );
    for (const reason of [
      "oi_watch_path_a_failed",
      "oi_watch_path_a_skip",
      "oi_watch_path_b_failed",
      "oi_watch_path_b_skip",
      "liq_cascade_tracker_failed",
      "liq_cascade_tracker_skip",
    ]) {
      assert.match(
        watcherSource,
        new RegExp(`discardUntrackedSignal\\([^;]+${reason}`),
      );
    }
  });
});

describe("reconcilePendingSignalAlerts: stale primary alerts", () => {
  const now = new Date("2026-09-25T11:02:00.000Z");

  test("recovers only open positions within the ten-minute window", () => {
    assert.equal(PRIMARY_ALERT_RECOVERY_MAX_AGE_MS, 10 * 60 * 1000);
    assert.equal(
      canRecoverPrimaryAlert(
        new Date(now.getTime() - 2 * 60_000),
        "active",
        now,
      ),
      true,
    );
    assert.equal(
      canRecoverPrimaryAlert(
        new Date(now.getTime() - PRIMARY_ALERT_RECOVERY_MAX_AGE_MS),
        "in_run",
        now,
      ),
      true,
    );
  });

  test("does not send old or already closed positions as NEW SIGNAL", () => {
    assert.equal(
      canRecoverPrimaryAlert(
        new Date("2026-09-23T20:37:52.644Z"),
        "active",
        now,
      ),
      false,
    );
    assert.equal(
      canRecoverPrimaryAlert(new Date(now.getTime() - 60_000), "bu_stop", now),
      false,
    );
    assert.equal(canRecoverPrimaryAlert(now, null, now), false);
    assert.equal(
      canRecoverPrimaryAlert(new Date(now.getTime() + 60_000), "active", now),
      false,
    );
  });

  test("backlog SQL applies the age and open-position guards", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/telegram.ts"),
      "utf8",
    );
    const reconcile = source.slice(
      source.indexOf("const runReconcilePendingSignalAlerts"),
      source.indexOf("export const reconcilePendingSignalAlerts"),
    );
    assert.match(reconcile, /PRIMARY_ALERT_RECOVERY_MAX_AGE_MS/);
    assert.match(reconcile, /ts\.status IN \('active', 'in_run'\)/);
    assert.match(reconcile, /canRecoverPrimaryAlert\(/);
  });
});

// ── 3. Single-flight guard behaviour ─────────────────────────────────────────

describe("reconcilePendingSignalAlerts: single-flight guard", () => {
  test("concurrent calls return the same Promise object", async () => {
    let callCount = 0;
    const reconcile = createSingleFlight(async () => {
      callCount++;
      await new Promise<void>((r) => setImmediate(r));
      return 1;
    });

    const p1 = reconcile();
    const p2 = reconcile(); // called while p1 is still in flight

    assert.strictEqual(p1, p2, "second call must return the same Promise");
    await p1;
    assert.equal(callCount, 1, "work must execute exactly once");
  });

  test("second call after first completes starts a fresh run", async () => {
    let callCount = 0;
    const reconcile = createSingleFlight(async () => {
      callCount++;
      return callCount;
    });

    const r1 = await reconcile();
    const r2 = await reconcile(); // first fully settled — new run allowed

    assert.equal(r1, 1);
    assert.equal(r2, 2);
    assert.equal(callCount, 2, "each sequential call must run work once");
  });

  test("inFlight is cleared even when work throws", async () => {
    let attempt = 0;
    const reconcile = createSingleFlight(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient failure");
      return attempt;
    });

    await assert.rejects(() => reconcile(), /transient failure/);

    // Guard must reset after rejection so the next timer tick can retry.
    // (Ambiguous-timeout signals remain queued, not silently dropped.)
    const r = await reconcile();
    assert.equal(r, 2, "guard must reset after rejection so retry is possible");
  });
});
