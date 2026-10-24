import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type {
  BreakoutEvidence,
  BreakoutCandle,
} from "../src/lib/breakout-analysis.js";
import type { StealthAbneonArmSnapshot } from "../src/lib/stealth-abneon-arm-snapshot.js";
import type { StealthAutoRangeIdentity } from "../src/lib/stealth-breakout-armed.js";

const enabled = process.env.RUN_STEALTH_ARM_STORE_INTEGRATION_TESTS === "true";
const integrationDatabaseUrl = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60_000;

let schemaName: string | undefined;
let previousDatabaseUrl: string | undefined;
let pool: typeof import("@workspace/db").pool | undefined;
let evaluateDurableStealthArm: typeof import("../src/lib/stealth-breakout-armed-store.js").evaluateDurableStealthArm;
let sweepExpiredStealthArmClaims: typeof import("../src/lib/stealth-breakout-armed-store.js").sweepExpiredStealthArmClaims;
let claimStealthArmForFire: typeof import("../src/lib/stealth-breakout-armed-store.js").claimStealthArmForFire;
let markStealthArmFired: typeof import("../src/lib/stealth-breakout-armed-store.js").markStealthArmFired;
let persistStealthAbneonShadow: typeof import("../src/lib/stealth-abneon-shadow-store.js").persistStealthAbneonShadow;
let getFrozenStealthAbneonLevel: typeof import("../src/lib/stealth-abneon-shadow-store.js").getFrozenStealthAbneonLevel;
let claimAbneonSupportBounceForFire: typeof import("../src/lib/stealth-abneon-shadow-store.js").claimAbneonSupportBounceForFire;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlWithSearchPath(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  const existingOptions = url.searchParams.get("options");
  url.searchParams.set(
    "options",
    [existingOptions, `-c search_path=${quoteIdentifier(schema)},public`]
      .filter(Boolean)
      .join(" "),
  );
  return url.toString();
}

function structure(level = 100): BreakoutEvidence {
  return {
    status: "approaching",
    kind: "horizontal",
    breakoutSource: "horizontal",
    timeframe: "4h",
    score: 60,
    quietZone: true,
    breakoutLevel: level,
    distanceFromLevelPct: -1,
    barsSinceBreakout: null,
    touches: 3,
    roomToResistancePct: null,
    breakoutTolerance: 1,
    breakoutZone: { lower: level - 1, upper: level + 1 },
    lifecycle: null,
    reasons: ["integration test quiet structure"],
    pivots: [],
    levels: [{ price: level, touches: 3 }],
    trendline: null,
    retestZone: null,
  };
}

function candles4h(armedAt: number): BreakoutCandle[] {
  return Array.from({ length: 8 }, (_, index) => ({
    time: armedAt - (8 - index) * 4 * HOUR,
    open: 98,
    high: 99,
    low: 97,
    close: 98,
    volume: 100,
  }));
}

function snapshot(
  capturedAt: number,
  nearestResistance: number | null,
  overrides: Partial<StealthAbneonArmSnapshot> = {},
): StealthAbneonArmSnapshot {
  return {
    indicatorVersion: "integration-test-abneon",
    capturedAt,
    status: "ready",
    verdict: "confirmed",
    nearestResistance,
    frozenStealthLevel: 100,
    levelDistancePct:
      nearestResistance == null ? null : Math.abs(nearestResistance - 100),
    classification: nearestResistance === 100 ? "agreement" : "neutral",
    coverage: nearestResistance == null ? "missing" : "complete",
    reason: nearestResistance == null ? "missing_for_test" : "test_snapshot",
    checks: { structure: "pass" },
    context: { nearestResistance },
    ...overrides,
  };
}

async function truncateTables(): Promise<void> {
  assert.ok(pool);
  await pool.query(
    "TRUNCATE stealth_continuation_shelf_events, stealth_breakout_armed_setups, stealth_abneon_shadow_candidates RESTART IDENTITY",
  );
}

async function insertArm(input: {
  symbol: string;
  status?: string;
  levelSource?: string;
  structureKey?: string;
  expiresAt: number;
  decisionAt?: number | null;
  fireClaimedAt?: number | null;
  decisionJson?: Record<string, unknown>;
}): Promise<number> {
  assert.ok(pool);
  const result = await pool.query<{ id: number }>(
    `
      INSERT INTO stealth_breakout_armed_setups (
        symbol, structure_key, breakout_source, breakout_level, touches,
        quiet_zone, armed_at, armed_after_1h_at, armed_after_4h_at,
        expires_at, status, structure_json, level_source, decision_json,
        decision_at, fire_claimed_at
      ) VALUES (
        $1, $2, 'horizontal', 100, 3, true, $3, $3, $3, $4, $5,
        '{"structure":"preserve"}'::jsonb, $6, $7::jsonb, $8, $9
      )
      RETURNING id
    `,
    [
      input.symbol,
      input.structureKey ?? `${input.symbol}:structure`,
      new Date(input.expiresAt - 2 * HOUR),
      new Date(input.expiresAt),
      input.status ?? "armed",
      input.levelSource ?? "stealth_legacy",
      JSON.stringify(input.decisionJson ?? { oldKey: "preserve" }),
      input.decisionAt == null ? null : new Date(input.decisionAt),
      input.fireClaimedAt == null ? null : new Date(input.fireClaimedAt),
    ],
  );
  assert.ok(result.rows[0]);
  return result.rows[0].id;
}

async function row(id: number): Promise<Record<string, unknown>> {
  assert.ok(pool);
  const result = await pool.query(
    "SELECT * FROM stealth_breakout_armed_setups WHERE id = $1",
    [id],
  );
  assert.ok(result.rows[0]);
  return result.rows[0] as Record<string, unknown>;
}

function autoRangeIdentity(
  cutoff: number,
  upper: number,
  lower = 90,
): StealthAutoRangeIdentity {
  return {
    version: "auto_range_pine_v1",
    openedAt: cutoff - 24 * HOUR,
    anchorAt: cutoff - 48 * HOUR,
    upper,
    lower,
    candleCutoff: cutoff,
  };
}

before(async () => {
  if (!enabled) return;
  assert.ok(
    integrationDatabaseUrl,
    "TEST_DATABASE_URL is required when RUN_STEALTH_ARM_STORE_INTEGRATION_TESTS=true",
  );
  schemaName = `stealth_arm_store_test_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = databaseUrlWithSearchPath(
    integrationDatabaseUrl,
    schemaName,
  );

  const workspaceDb = await import("@workspace/db");
  pool = workspaceDb.pool;
  ({ evaluateDurableStealthArm, sweepExpiredStealthArmClaims } =
    await import("../src/lib/stealth-breakout-armed-store.js"));
  ({ claimStealthArmForFire, markStealthArmFired } =
    await import("../src/lib/stealth-breakout-armed-store.js"));
  ({ persistStealthAbneonShadow, getFrozenStealthAbneonLevel } =
    await import("../src/lib/stealth-abneon-shadow-store.js"));
  ({ claimAbneonSupportBounceForFire } =
    await import("../src/lib/stealth-abneon-shadow-store.js"));

  const quotedSchema = quoteIdentifier(schemaName);
  await pool.query(`CREATE SCHEMA ${quotedSchema}`);
  await pool.query(`
    CREATE TABLE stealth_breakout_armed_setups (
      id serial PRIMARY KEY,
      symbol text NOT NULL,
      structure_key text NOT NULL,
      breakout_source text NOT NULL,
      breakout_level double precision NOT NULL,
      touches integer NOT NULL,
      quiet_zone boolean NOT NULL DEFAULT true,
      armed_at timestamptz NOT NULL,
      armed_after_1h_at timestamptz,
      armed_after_4h_at timestamptz,
      expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'armed',
      first_cross_at timestamptz,
      terminal_reason text,
      fired_at timestamptz,
      structure_json jsonb NOT NULL,
      decision_json jsonb,
      decision_at timestamptz,
      trigger_candle_at timestamptz,
      decision_lag_ms bigint,
      fire_claimed_at timestamptz,
      fired_signal_id integer,
      abneon_indicator_version text,
      abneon_status text,
      abneon_verdict text,
      abneon_nearest_resistance double precision,
      abneon_level_distance_pct double precision,
      abneon_classification text,
      abneon_coverage text,
      abneon_reason text,
      abneon_checks jsonb,
      abneon_context jsonb,
      abneon_captured_at timestamptz,
      level_source text NOT NULL DEFAULT 'stealth_legacy',
      legacy_breakout_level double precision,
      experiment_version text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (symbol, structure_key)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX stealth_arm_store_active_arm
    ON stealth_breakout_armed_setups (symbol, level_source)
    WHERE status = 'armed'
  `);
  await pool.query(`
    CREATE TABLE stealth_continuation_shelf_events (
      event_key text PRIMARY KEY,
      arm_id integer NOT NULL,
      symbol text NOT NULL,
      event_type text NOT NULL,
      event_at timestamptz NOT NULL,
      payload jsonb NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE stealth_abneon_shadow_candidates (
      id serial PRIMARY KEY,
      symbol text NOT NULL,
      detection_method text NOT NULL,
      candidate_key text NOT NULL,
      frozen_level double precision NOT NULL,
      armed_at timestamptz NOT NULL,
      trigger_candle_at timestamptz,
      status text NOT NULL DEFAULT 'armed',
      live_eligible boolean NOT NULL DEFAULT false,
      terminal_reason text,
      volume_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      fire_claim_owner text,
      fire_claim_token text,
      fire_claim_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (symbol, detection_method, candidate_key)
    )
  `);
});

after(async () => {
  try {
    if (pool && schemaName) {
      await pool.query(
        `DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`,
      );
    }
  } finally {
    if (pool) await pool.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test(
  "Auto Range overshoot updates preserve the durable instance across scans and restart",
  { skip: !enabled },
  async () => {
    assert.ok(evaluateDurableStealthArm);
    const symbol = "AUTO-RANGE-OVERSHOOT-USDT";
    const evaluatedAt = Date.parse("2026-09-20T00:00:00.000Z");
    const firstIdentity = autoRangeIdentity(evaluatedAt - 4 * HOUR, 100);
    await truncateTables();

    const firstScan = await evaluateDurableStealthArm({
      symbol,
      structure: structure(100),
      breakoutCandles4h: candles4h(evaluatedAt),
      refinementCandles: [],
      evaluatedAt,
      allowCreate: true,
      levelSource: "auto_range_4h",
      experimentVersion: "auto-range-pine-v1",
      technicalMode: "auto_range_4h",
      autoRangeIdentity: firstIdentity,
      autoRangeStatus: "ready",
    });
    assert.equal(firstScan.status, "armed");
    if (firstScan.status !== "armed") return;

    const overshotIdentity = {
      ...firstIdentity,
      upper: 103,
      lower: 88,
      candleCutoff: evaluatedAt,
    };
    const afterOvershoot = await evaluateDurableStealthArm({
      symbol,
      structure: structure(103),
      breakoutCandles4h: candles4h(evaluatedAt + 4 * HOUR),
      refinementCandles: [],
      evaluatedAt: evaluatedAt + 4 * HOUR,
      allowCreate: true,
      levelSource: "auto_range_4h",
      experimentVersion: "auto-range-pine-v1",
      technicalMode: "auto_range_4h",
      autoRangeIdentity: overshotIdentity,
      autoRangeStatus: "ready",
    });
    assert.equal(afterOvershoot.status, "armed");
    assert.equal(afterOvershoot.armId, firstScan.armId);
    assert.equal(afterOvershoot.arm.breakoutLevel, 103);

    // A subsequent evaluator call re-reads the SQL row, like a scanner restart.
    const afterRestart = await evaluateDurableStealthArm({
      symbol,
      structure: structure(103),
      breakoutCandles4h: candles4h(evaluatedAt + 8 * HOUR),
      refinementCandles: [],
      evaluatedAt: evaluatedAt + 8 * HOUR,
      allowCreate: true,
      levelSource: "auto_range_4h",
      experimentVersion: "auto-range-pine-v1",
      technicalMode: "auto_range_4h",
      autoRangeIdentity: overshotIdentity,
      autoRangeStatus: "ready",
    });
    assert.equal(afterRestart.status, "armed");
    assert.equal(afterRestart.armId, firstScan.armId);
    const persisted = await row(firstScan.armId);
    assert.equal(Number(persisted.breakout_level), 103);
    assert.equal(
      (persisted.decision_json as Record<string, unknown>).autoRangeIdentity &&
        (
          (persisted.decision_json as Record<string, unknown>)
            .autoRangeIdentity as Record<string, unknown>
        ).upper,
      103,
    );
  },
);

test(
  "durable 1H Auto Range arm fires only from its closed 1H Pine event",
  { skip: !enabled },
  async () => {
    assert.ok(evaluateDurableStealthArm);
    await truncateTables();
    const symbol = "AUTO-RANGE-1H-PINE-USDT";
    const cutoff = Date.parse("2026-09-20T00:00:00.000Z");
    const breakoutCloseTime = cutoff + 2 * HOUR;
    const identity: StealthAutoRangeIdentity = {
      version: "auto_range_pine_v1_1h",
      openedAt: cutoff - 24 * HOUR,
      anchorAt: cutoff - 48 * HOUR,
      upper: 100,
      lower: 90,
      candleCutoff: cutoff,
    };
    const priorCandle: BreakoutCandle = {
      time: cutoff,
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      volume: 100,
    };
    const candles1h: BreakoutCandle[] = [
      priorCandle,
      {
        time: cutoff + HOUR,
        open: 99,
        high: 103,
        low: 99,
        close: 102,
        volume: 120,
      },
    ];
    const armed = await evaluateDurableStealthArm({
      symbol,
      structure: structure(100),
      breakoutCandles4h: [],
      breakoutCandles1h: [priorCandle],
      refinementCandles: [],
      evaluatedAt: cutoff + HOUR,
      allowCreate: true,
      levelSource: "auto_range_1h",
      technicalMode: "auto_range_1h",
      autoRangeIdentity: identity,
      autoRangeStatus: "ready",
    });
    assert.equal(armed.status, "armed");
    // A restarted worker can see the durable arm before its full hourly
    // history has warmed. Unknown data must not consume the frozen cursor.
    const duringWarmup = await evaluateDurableStealthArm({
      symbol,
      structure: structure(100),
      breakoutCandles4h: [],
      breakoutCandles1h: [],
      refinementCandles: [],
      evaluatedAt: cutoff + HOUR + 30 * 60_000,
      allowCreate: false,
      levelSource: "auto_range_1h",
      technicalMode: "auto_range_1h",
      autoRangeIdentity: null,
      autoRangeStatus: "unknown",
    });
    assert.equal(duringWarmup.status, "armed");
    if (duringWarmup.status === "armed" && armed.status === "armed") {
      assert.equal(duringWarmup.armId, armed.armId);
    }
    const result = await evaluateDurableStealthArm({
      symbol,
      structure: structure(100),
      breakoutCandles4h: [],
      breakoutCandles1h: candles1h,
      refinementCandles: [
        {
          time: breakoutCloseTime,
          open: 100.2,
          high: 101,
          low: 100,
          close: 100.5,
          volume: 10,
        },
        {
          time: breakoutCloseTime + 30 * 60_000,
          open: 100.2,
          high: 101,
          low: 100,
          close: 100.5,
          volume: 10,
        },
      ],
      evaluatedAt: breakoutCloseTime + HOUR,
      allowCreate: true,
      levelSource: "auto_range_1h",
      technicalMode: "auto_range_1h",
      autoRangeIdentity: identity,
      autoRangeStatus: "ready",
      autoRangeBreakoutEvent: {
        openedAt: identity.openedAt,
        anchorAt: identity.anchorAt,
        upper: identity.upper,
        lower: identity.lower,
        breakoutCloseTime,
      },
    });
    assert.equal(result.status, "qualified");
    assert.equal(
      result.status === "qualified" && "firstCrossAt" in result.decision
        ? result.decision.firstCrossAt
        : null,
      breakoutCloseTime,
    );
    assert.equal(result.arm.levelSource, "auto_range_1h");
    const persisted = await pool!.query(
      "SELECT armed_after_1h_at, decision_json FROM stealth_breakout_armed_setups WHERE symbol = $1",
      [symbol],
    );
    assert.equal(
      new Date(persisted.rows[0].armed_after_1h_at).getTime(),
      cutoff,
    );
    assert.equal(
      (persisted.rows[0].decision_json as Record<string, unknown>)
        .autoRangeVersion,
      "auto_range_pine_v1_1h",
    );
    assert.equal(
      (persisted.rows[0].decision_json as Record<string, unknown>).timeframe,
      "1h_auto_range+30m",
    );
    assert.equal(
      (persisted.rows[0].decision_json as Record<string, unknown>).breakoutGate,
      "closed_1h_pine_upside_break_matches_versioned_frozen_auto_range_then_closed_30m_hold",
    );
  },
);

test(
  "qualified loser survives fire rejection/restart and is deduped only with durable winner fire",
  { skip: !enabled },
  async () => {
    assert.ok(claimStealthArmForFire);
    assert.ok(markStealthArmFired);
    const symbol = "STEALTH-DEDUPE-RETRY-USDT";
    await truncateTables();
    const expiresAt = Date.parse("2026-09-21T00:00:00.000Z");
    const winnerId = await insertArm({
      symbol,
      status: "qualified",
      levelSource: "continuation_shelf",
      structureKey: `${symbol}:winner`,
      expiresAt,
    });
    const fallbackId = await insertArm({
      symbol,
      status: "qualified",
      levelSource: "auto_range_4h",
      structureKey: `${symbol}:fallback`,
      expiresAt,
    });

    assert.equal(
      await markStealthArmFired(winnerId, 101, 44, [fallbackId]),
      false,
    );
    assert.equal((await row(winnerId)).status, "qualified");
    assert.equal((await row(fallbackId)).status, "qualified");

    // Re-read both durable candidates after a simulated process restart.
    assert.equal(await claimStealthArmForFire(winnerId), true);
    assert.equal(
      await markStealthArmFired(winnerId, 101, 44, [fallbackId]),
      true,
    );
    assert.equal((await row(winnerId)).status, "fired");
    const fallback = await row(fallbackId);
    assert.equal(fallback.status, "invalidated");
    assert.equal(
      fallback.terminal_reason,
      "deduplicated_by_continuation_shelf",
    );
  },
);

test(
  "global sweep expires TTL rows, preserves audit, frees slots, and rechecks predicates",
  { skip: !enabled },
  async () => {
    assert.ok(sweepExpiredStealthArmClaims);
    const evaluatedAt = Date.parse("2026-09-14T00:00:00.000Z");
    await truncateTables();
    const expiredId = await insertArm({
      symbol: "EXPIRED-USDT",
      expiresAt: evaluatedAt,
      decisionJson: { oldKey: "preserve", nested: { value: 7 } },
    });
    const qualifiedId = await insertArm({
      symbol: "QUALIFIED-USDT",
      status: "qualified",
      expiresAt: evaluatedAt - HOUR,
      decisionAt: evaluatedAt - 1_000,
    });
    const firingId = await insertArm({
      symbol: "FIRING-USDT",
      status: "firing",
      expiresAt: evaluatedAt - HOUR,
      fireClaimedAt: evaluatedAt - 1_000,
    });
    const shelfId = await insertArm({
      symbol: "SHELF-USDT",
      levelSource: "continuation_shelf",
      expiresAt: evaluatedAt,
      decisionJson: { shelfKey: "preserve" },
    });

    const counts = await sweepExpiredStealthArmClaims(evaluatedAt);
    assert.equal(counts.armed, 2);
    assert.equal(counts.qualified, 0);
    assert.equal(counts.firing, 0);

    const expired = await row(expiredId);
    assert.equal(expired.status, "expired");
    assert.equal(expired.terminal_reason, "arm_ttl_elapsed");
    assert.equal(new Date(String(expired.decision_at)).getTime(), evaluatedAt);
    assert.deepEqual(expired.structure_json, { structure: "preserve" });
    assert.deepEqual(expired.decision_json, {
      oldKey: "preserve",
      nested: { value: 7 },
      status: "expired",
      reason: "arm_ttl_elapsed",
      evaluatedAt,
    });
    const qualified = await row(qualifiedId);
    const firing = await row(firingId);
    assert.equal(qualified.status, "qualified");
    assert.equal(firing.status, "firing");

    const reusableId = await insertArm({
      symbol: "EXPIRED-USDT",
      structureKey: "EXPIRED-USDT:replacement",
      expiresAt: evaluatedAt + HOUR,
    });
    assert.ok(reusableId > expiredId);

    const shelfEvent = await pool!.query(
      "SELECT payload FROM stealth_continuation_shelf_events WHERE arm_id = $1",
      [shelfId],
    );
    assert.equal(shelfEvent.rows.length, 1);
    assert.deepEqual(shelfEvent.rows[0].payload, {
      shelfKey: "preserve",
      status: "expired",
      reason: "arm_ttl_elapsed",
      evaluatedAt,
    });

    await truncateTables();
    const raceId = await insertArm({
      symbol: "RACE-USDT",
      expiresAt: evaluatedAt,
    });
    const client = await pool!.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM stealth_breakout_armed_setups WHERE id = $1 FOR UPDATE",
        [raceId],
      );
      const sweep = sweepExpiredStealthArmClaims(evaluatedAt);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await client.query(
        "UPDATE stealth_breakout_armed_setups SET status = 'qualified' WHERE id = $1",
        [raceId],
      );
      await client.query("COMMIT");
      await sweep;
    } finally {
      client.release();
    }
    assert.equal((await row(raceId)).status, "qualified");
  },
);

test(
  "durable arms preserve immutable ABNeon evidence without changing live state",
  { skip: !enabled },
  async () => {
    assert.ok(evaluateDurableStealthArm);
    const evaluatedAt = Date.parse("2026-09-14T00:00:00.000Z");
    const candles = candles4h(evaluatedAt);
    const liveStructure = structure();
    await truncateTables();

    const firstSnapshot = snapshot(evaluatedAt, 100);
    const secondSnapshot = snapshot(evaluatedAt, 110);
    const first = await evaluateDurableStealthArm({
      symbol: "SNAP-A-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt,
      abneonSnapshot: firstSnapshot,
      legacyBreakoutLevel: 100,
      experimentVersion: "integration",
    });
    const second = await evaluateDurableStealthArm({
      symbol: "SNAP-B-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt,
      abneonSnapshot: secondSnapshot,
      legacyBreakoutLevel: 100,
      experimentVersion: "integration",
    });
    assert.equal(first.status, "armed");
    assert.equal(second.status, "armed");
    assert.equal(first.arm.breakoutLevel, second.arm.breakoutLevel);
    assert.equal(first.arm.levelSource, second.arm.levelSource);
    assert.equal(first.arm.abneonResistance, 100);
    assert.equal(second.arm.abneonResistance, 110);
    const firstRow = await row(first.armId);
    const secondRow = await row(second.armId);
    assert.equal(firstRow.breakout_level, secondRow.breakout_level);
    assert.equal(firstRow.abneon_nearest_resistance, 100);
    assert.equal(secondRow.abneon_nearest_resistance, 110);
    assert.notDeepEqual(firstRow.decision_json, secondRow.decision_json);

    const changed = await evaluateDurableStealthArm({
      symbol: "SNAP-A-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt: evaluatedAt + HOUR,
      abneonSnapshot: snapshot(evaluatedAt + HOUR, 999),
      legacyBreakoutLevel: 100,
      experimentVersion: "integration",
    });
    assert.equal(changed.status, "armed");
    const unchangedRow = await row(first.armId);
    assert.equal(unchangedRow.abneon_nearest_resistance, 100);
    // Live waiting decisions advance on each scan; only the ARMED-time
    // observational evidence and frozen level must remain immutable.
    assert.deepEqual(
      (unchangedRow.decision_json as { abneonShadow?: unknown }).abneonShadow,
      (firstRow.decision_json as { abneonShadow?: unknown }).abneonShadow,
    );
    assert.equal(unchangedRow.breakout_level, firstRow.breakout_level);

    const missing = await evaluateDurableStealthArm({
      symbol: "SNAP-MISSING-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt,
      abneonSnapshot: snapshot(evaluatedAt, null),
    });
    const error = await evaluateDurableStealthArm({
      symbol: "SNAP-ERROR-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt,
      abneonSnapshot: snapshot(evaluatedAt, null, {
        reason: "snapshot_error:synthetic",
        status: "unavailable",
      }),
    });
    assert.equal(missing.status, "armed");
    assert.equal(error.status, "armed");
    assert.equal((await row(missing.armId)).status, "armed");
    assert.equal((await row(error.armId)).status, "armed");

    const shelf = await evaluateDurableStealthArm({
      symbol: "SNAP-SHELF-USDT",
      structure: liveStructure,
      breakoutCandles4h: candles,
      refinementCandles: [],
      evaluatedAt,
      levelSource: "continuation_shelf",
      abneonSnapshot: firstSnapshot,
    });
    assert.equal(shelf.status, "armed");
    const shelfRow = await row(shelf.armId);
    assert.equal(shelfRow.abneon_nearest_resistance, null);
    assert.equal(
      (shelfRow.decision_json as { abneonShadow?: unknown }).abneonShadow,
      null,
    );
  },
);

test(
  "a durable 1H volume cross waits for the next closed 30m hold",
  { skip: !enabled },
  async () => {
    await truncateTables();
    const armedAt = Date.parse("2026-09-24T00:00:00.000Z");
    const oneHourBefore = Array.from({ length: 21 }, (_, index) => ({
      time: armedAt - (21 - index) * HOUR,
      open: 99,
      high: 99.5,
      low: 98,
      close: 99,
      volume: 1_000,
    }));
    const cross = {
      time: armedAt,
      open: 99,
      high: 101.5,
      low: 98.5,
      close: 101,
      volume: 700,
    };
    const base = {
      symbol: "ONE-HOUR-STEALTH-USDT",
      structure: structure(),
      breakoutCandles4h: candles4h(armedAt),
      technicalMode: "closed_1h_30m" as const,
      allowCreate: true,
    };
    const created = await evaluateDurableStealthArm({
      ...base,
      breakoutCandles1h: oneHourBefore,
      refinementCandles: [],
      evaluatedAt: armedAt,
    });
    assert.equal(created.status, "armed");
    const pending = await evaluateDurableStealthArm({
      ...base,
      breakoutCandles1h: [...oneHourBefore, cross],
      refinementCandles: [],
      evaluatedAt: armedAt + HOUR,
    });
    assert.equal(pending.status, "armed");
    const held = await evaluateDurableStealthArm({
      ...base,
      breakoutCandles1h: [...oneHourBefore, cross],
      refinementCandles: [
        {
          time: armedAt + HOUR,
          open: 101,
          high: 101.5,
          low: 100.5,
          close: 101,
          volume: 300,
        },
      ],
      evaluatedAt: armedAt + HOUR + HOUR / 2,
    });
    assert.equal(held.status, "qualified");
    const persisted = await row(created.armId);
    const decision = persisted.decision_json as {
      breakoutGate: string;
      confirmation: { timeframe: string };
      refinement: { timeframe: string };
      oneHourVolume: { gatePassed: boolean; breakoutTurnover: number };
    };
    assert.equal(
      decision.breakoutGate,
      "closed_1h_cross_with_volume_then_closed_30m_hold",
    );
    assert.equal(decision.confirmation.timeframe, "1h");
    assert.equal(decision.refinement.timeframe, "30m");
    assert.equal(decision.oneHourVolume.gatePassed, true);
    assert.equal(decision.oneHourVolume.breakoutTurnover, 700 * 101);
  },
);

test(
  "old pending 30m arm is retired, not silently reinterpreted as a 1H arm",
  { skip: !enabled },
  async () => {
    await truncateTables();
    const armedAt = Date.parse("2026-09-24T00:00:00.000Z");
    const base = {
      symbol: "LEGACY-THIRTY-MINUTE-USDT",
      structure: structure(),
      breakoutCandles4h: candles4h(armedAt),
      refinementCandles: [],
    };
    const old = await evaluateDurableStealthArm({
      ...base,
      technicalMode: "closed_30m",
      evaluatedAt: armedAt,
    });
    assert.equal(old.status, "armed");
    const cutover = await evaluateDurableStealthArm({
      ...base,
      technicalMode: "closed_1h_30m",
      breakoutCandles1h: [],
      evaluatedAt: armedAt + HOUR,
    });
    assert.deepEqual(cutover, {
      status: "terminal_structure",
      reason: "superseded_by_1h_confirmation_policy",
    });
    const oldRow = await row(old.armId);
    assert.equal(oldRow.status, "invalidated");
    assert.equal(
      (oldRow.decision_json as { priorTechnicalMode: string })
        .priorTechnicalMode,
      "closed_30m",
    );
    const newArm = await evaluateDurableStealthArm({
      ...base,
      technicalMode: "closed_1h_30m",
      breakoutCandles1h: [],
      evaluatedAt: armedAt + 2 * HOUR,
    });
    assert.equal(newArm.status, "armed");
    assert.notEqual(newArm.armId, old.armId);
    const audit = (await row(newArm.armId)).decision_json as {
      timeframe: string;
      reason: string;
    };
    assert.equal(audit.timeframe, "1h+30m");
    assert.equal(audit.reason, "awaiting_later_1h_cross_with_volume");
  },
);

test(
  "participation telemetry freezes at the first decisive cross for both arm sources",
  { skip: !enabled },
  async () => {
    assert.ok(evaluateDurableStealthArm);
    const baseAt = Date.parse("2026-09-15T00:00:00.000Z");
    const telemetry = (capturedAt: number, value: number | null) => ({
      capturedAt,
      oi: { value, source: "integration-oi", available: value !== null },
      cvd: {
        value: {
          cvd15m: value === null ? null : value > 0,
          cvd30m: value === null ? null : value > 0,
          cvd1h: null,
          cvd4h: null,
        },
        source: "integration-cvd",
        available: value !== null,
      },
      spotTaker: {
        value,
        source: "integration-taker",
        available: value !== null,
      },
    });
    const breakout = [
      ...candles4h(baseAt),
      {
        time: baseAt,
        open: 100,
        high: 104,
        low: 99,
        close: 103,
        volume: 200,
      },
    ];
    const retest = [
      {
        time: baseAt + 4 * HOUR,
        open: 103,
        high: 104,
        low: 102.5,
        close: 103,
        volume: 1,
      },
      {
        time: baseAt + 4.5 * HOUR,
        open: 103,
        high: 103,
        low: 102.5,
        close: 103,
        volume: 1,
      },
    ];

    for (const levelSource of [
      "stealth_legacy",
      "continuation_shelf",
    ] as const) {
      await truncateTables();
      const symbol = `TELEMETRY-${levelSource}-USDT`;
      const initial = await evaluateDurableStealthArm({
        symbol,
        structure: structure(),
        breakoutCandles4h: candles4h(baseAt),
        refinementCandles: [],
        evaluatedAt: baseAt,
        allowCreate: true,
        levelSource,
      });
      assert.equal(initial.status, "armed");
      const preCross = (await row(initial.armId)).decision_json as Record<
        string,
        unknown
      >;
      assert.equal("triggerParticipationTelemetry" in preCross, false);

      const triggerTelemetry = telemetry(baseAt + 5 * HOUR, 1);
      const crossed = await evaluateDurableStealthArm({
        symbol,
        structure: structure(),
        breakoutCandles4h: breakout,
        refinementCandles: retest,
        evaluatedAt: baseAt + 5 * HOUR,
        allowCreate: true,
        levelSource,
        participationTelemetry: triggerTelemetry,
      });
      assert.equal(crossed.status, "armed");
      if (crossed.status === "armed") {
        assert.equal(crossed.waitingReason, "breakout_active_waiting_retest");
      }
      const triggerRow = await row(initial.armId);
      const triggerJson = triggerRow.decision_json as Record<string, unknown>;
      assert.deepEqual(triggerJson.triggerParticipationTelemetry, {
        capturedAt: baseAt + 4 * HOUR,
        oi: {
          value: null,
          source: "unavailable_delayed:integration-oi",
          available: false,
        },
        cvd: {
          value: {
            cvd15m: null,
            cvd30m: null,
            cvd1h: null,
            cvd4h: null,
          },
          source: "unavailable_delayed:integration-cvd",
          available: false,
        },
        spotTaker: {
          value: null,
          source: "unavailable_delayed:integration-taker",
          available: false,
        },
      });
      const repeated = await Promise.all([
        evaluateDurableStealthArm({
          symbol,
          structure: structure(),
          breakoutCandles4h: breakout,
          refinementCandles: retest,
          evaluatedAt: baseAt + 5.5 * HOUR,
          levelSource,
          participationTelemetry: telemetry(baseAt + 5.5 * HOUR, 1.5),
        }),
        evaluateDurableStealthArm({
          symbol,
          structure: structure(),
          breakoutCandles4h: breakout,
          refinementCandles: retest,
          evaluatedAt: baseAt + 5.5 * HOUR,
          levelSource,
          participationTelemetry: telemetry(baseAt + 5.5 * HOUR, 1.5),
        }),
      ]);
      for (const item of repeated) {
        assert.ok("armId" in item);
        if ("armId" in item) assert.equal(item.armId, initial.armId);
      }

      const laterTelemetry = telemetry(baseAt + 6 * HOUR, 2);
      const waiting = await evaluateDurableStealthArm({
        symbol,
        structure: structure(),
        breakoutCandles4h: breakout,
        refinementCandles: [
          ...retest,
          { ...retest[1]!, time: baseAt + 5.5 * HOUR, close: 103.1 },
        ],
        evaluatedAt: baseAt + 6 * HOUR,
        levelSource,
        participationTelemetry: laterTelemetry,
      });
      assert.equal(waiting.status, "armed");
      const waitingJson = (await row(initial.armId)).decision_json as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        waitingJson.triggerParticipationTelemetry,
        triggerJson.triggerParticipationTelemetry,
      );
      assert.deepEqual(
        waitingJson.latestEvaluationParticipationTelemetry,
        laterTelemetry,
      );

      const qualified = await evaluateDurableStealthArm({
        symbol,
        structure: structure(),
        breakoutCandles4h: breakout,
        refinementCandles: [
          { ...retest[0]!, close: 101.5, open: 101.5 },
          { ...retest[1]!, close: 101.5, open: 101.5 },
        ],
        evaluatedAt: baseAt + 7 * HOUR,
        levelSource,
        participationTelemetry: telemetry(baseAt + 7 * HOUR, 3),
      });
      assert.equal(qualified.status, "qualified");
      const finalJson = (await row(initial.armId)).decision_json as Record<
        string,
        unknown
      >;
      assert.deepEqual(
        finalJson.triggerParticipationTelemetry,
        triggerJson.triggerParticipationTelemetry,
      );
      assert.equal(initial.armId, qualified.armId);
    }
  },
);

test(
  "shadow-store keeps order-block ineligible and preserves frozen detector evidence",
  { skip: !enabled },
  async () => {
    assert.ok(pool && getFrozenStealthAbneonLevel);
    const base = Date.parse("2026-09-16T00:00:00.000Z");
    const evidence = {
      version: "ob-support-v1",
      orderBlock: {
        candleTime: base - 8 * HOUR,
        zoneLow: 99,
        zoneHigh: 100,
        atr: 2,
      },
      displacement: { candleTime: base - 4 * HOUR, close: 105 },
      reaction: null,
    };
    const orderBlock = {
      method: "order_block_support_bounce" as const,
      status: "armed" as const,
      reason: "awaiting_later_1h_order_block_reaction",
      frozenLevel: 99.5,
      armCandleTime: base,
      triggerCandleTime: null,
      volumeEvidence: { triggerVolume: 100, baselineVolume: 50, ratio: 2 },
      evidence,
    };
    await persistStealthAbneonShadow({
      symbol: "OB-ELIGIBILITY-USDT",
      result: orderBlock,
      observedAt: base,
    });
    let result = await pool.query(
      "SELECT live_eligible, volume_evidence FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["OB-ELIGIBILITY-USDT"],
    );
    assert.equal(result.rows[0].live_eligible, false);
    assert.deepEqual(result.rows[0].volume_evidence.detectorEvidence, evidence);
    const abneon = {
      ...orderBlock,
      method: "abneon_support_bounce" as const,
      reason: "awaiting_later_1h_reaction",
    };

    await persistStealthAbneonShadow({
      symbol: "OB-ELIGIBILITY-USDT",
      result: {
        ...orderBlock,
        status: "qualified",
        triggerCandleTime: base + HOUR,
        reason: "later_closed_1h_order_block_reaction",
      },
      observedAt: base + HOUR,
    });
    const raceResults = await Promise.all([
      persistStealthAbneonShadow({
        symbol: "ABNEON-RACE-USDT",
        result: {
          ...abneon,
          status: "qualified",
          triggerCandleTime: base + HOUR,
          evidence: {
            version: "race",
            latestObservation: { trigger: base + HOUR },
          },
          volumeEvidence: {
            triggerVolume: 801,
            baselineVolume: 100,
            ratio: 8.01,
          },
        },
        observedAt: base + HOUR,
      }),
      persistStealthAbneonShadow({
        symbol: "ABNEON-RACE-USDT",
        result: {
          ...abneon,
          status: "qualified",
          triggerCandleTime: base + 2 * HOUR,
          evidence: {
            version: "race",
            latestObservation: { trigger: base + 2 * HOUR },
          },
          volumeEvidence: {
            triggerVolume: 802,
            baselineVolume: 100,
            ratio: 8.02,
          },
        },
        observedAt: base + 2 * HOUR,
      }),
    ]);
    assert.ok(raceResults[0] && raceResults[1]);
    assert.equal(
      raceResults[0]!.triggerCandleTime,
      raceResults[1]!.triggerCandleTime,
    );
    result = await pool.query(
      "SELECT live_eligible FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["OB-ELIGIBILITY-USDT"],
    );
    assert.equal(result.rows[0].live_eligible, false);

    await pool.query(
      `INSERT INTO stealth_abneon_shadow_candidates
       (symbol, detection_method, candidate_key, frozen_level, armed_at, status, live_eligible, volume_evidence)
       VALUES ($1, $2, $3, $4, $5, 'armed', true, $6::jsonb)`,
      [
        "OB-SEEDED-USDT",
        "order_block_support_bounce",
        `${base}:99.5000000000`,
        99.5,
        new Date(base),
        JSON.stringify({ accidental: true }),
      ],
    );
    await persistStealthAbneonShadow({
      symbol: "OB-SEEDED-USDT",
      result: {
        ...orderBlock,
        triggerCandleTime: base + HOUR,
        status: "qualified",
      },
      observedAt: base + HOUR,
    });
    result = await pool.query(
      "SELECT live_eligible FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["OB-SEEDED-USDT"],
    );
    assert.equal(result.rows[0].live_eligible, false);

    const frozen = await getFrozenStealthAbneonLevel({
      symbol: "OB-ELIGIBILITY-USDT",
      method: "order_block_support_bounce",
    });
    assert.equal(frozen?.level, 99.5);
    assert.equal(frozen?.armedAt, base);
    assert.deepEqual(frozen?.evidence, evidence);

    await persistStealthAbneonShadow({
      symbol: "ABNEON-ELIGIBILITY-USDT",
      result: abneon,
      observedAt: base,
    });
    result = await pool.query(
      "SELECT live_eligible FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["ABNEON-ELIGIBILITY-USDT"],
    );
    assert.equal(result.rows[0].live_eligible, true);
    await persistStealthAbneonShadow({
      symbol: "ABNEON-ELIGIBILITY-USDT",
      result: {
        ...abneon,
        status: "qualified",
        triggerCandleTime: base + HOUR,
      },
      observedAt: base + HOUR,
    });
    result = await pool.query(
      "SELECT live_eligible FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["ABNEON-ELIGIBILITY-USDT"],
    );
    assert.equal(result.rows[0].live_eligible, true);

    const qualificationEvidence = {
      version: "pivot-v1",
      latestObservation: { ratio: 4, reactionCandleTime: base + HOUR },
    };
    const firstQualification = await persistStealthAbneonShadow({
      symbol: "ABNEON-REGRESSION-USDT",
      result: {
        ...abneon,
        status: "qualified",
        triggerCandleTime: base + HOUR,
        evidence: qualificationEvidence,
        volumeEvidence: { triggerVolume: 800, baselineVolume: 100, ratio: 8 },
      },
      observedAt: base + HOUR,
    });
    assert.equal(firstQualification?.status, "qualified");
    await Promise.all([
      persistStealthAbneonShadow({
        symbol: "ABNEON-REGRESSION-USDT",
        result: {
          ...abneon,
          status: "armed",
          triggerCandleTime: null,
          evidence: { version: "pivot-v1", latestObservation: { ratio: 1 } },
          volumeEvidence: {
            triggerVolume: 101,
            baselineVolume: 100,
            ratio: 1.01,
          },
        },
        observedAt: base + 2 * HOUR,
      }),
      persistStealthAbneonShadow({
        symbol: "ABNEON-REGRESSION-USDT",
        result: {
          ...abneon,
          status: "armed",
          triggerCandleTime: null,
          evidence: { version: "pivot-v1", latestObservation: { ratio: 1.1 } },
          volumeEvidence: {
            triggerVolume: 102,
            baselineVolume: 100,
            ratio: 1.02,
          },
        },
        observedAt: base + 3 * HOUR,
      }),
    ]);
    result = await pool.query(
      "SELECT status, trigger_candle_at, live_eligible, volume_evidence FROM stealth_abneon_shadow_candidates WHERE symbol = $1",
      ["ABNEON-REGRESSION-USDT"],
    );
    assert.equal(result.rows[0].status, "qualified");
    assert.equal(result.rows[0].trigger_candle_at.getTime(), base + HOUR);
    assert.equal(result.rows[0].live_eligible, true);
    assert.equal(result.rows[0].volume_evidence.ratio, 8);
    assert.deepEqual(
      result.rows[0].volume_evidence.detectorEvidence,
      qualificationEvidence,
    );
    const terminalObservation = await persistStealthAbneonShadow({
      symbol: "ABNEON-REGRESSION-USDT",
      result: {
        ...abneon,
        status: "terminal",
        triggerCandleTime: null,
        reason: "reaction_window_expired",
        evidence: { version: "pivot-v1", latestObservation: { ratio: 0 } },
        volumeEvidence: { triggerVolume: 1, baselineVolume: 100, ratio: 0.01 },
      },
      observedAt: base + 4 * HOUR,
    });
    assert.equal(terminalObservation?.status, "qualified");
    assert.equal(terminalObservation?.triggerCandleTime, base + HOUR);
    assert.ok(claimAbneonSupportBounceForFire);
    const claim = await claimAbneonSupportBounceForFire({
      symbol: "ABNEON-REGRESSION-USDT",
      frozenLevel: 99.5,
      armCandleTime: base,
      triggerCandleTime: base + HOUR,
      owner: "integration-test",
    });
    assert.ok(claim);
  },
);
