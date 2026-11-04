import { STEALTH_FIRE_WINDOW_MS } from "./stealth-verdict-journal.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { addTracedArmSymbol } from "./coinglass-arm-trace.js";
import { getCircularPageWindow } from "./stealth-scan-pool.js";
import type { BreakoutCandle, BreakoutEvidence } from "./breakout-analysis.js";
import {
  buildStealthArmedSnapshot,
  evaluateStealthArmedSetup,
  type StealthBreakoutParticipationTelemetry,
  type StealthArmedDecision,
  type StealthArmedSnapshot,
} from "./stealth-breakout-armed.js";
import type { StealthAbneonArmSnapshot } from "./stealth-abneon-arm-snapshot.js";
import type { AutoRangePineResult } from "./auto-range-pine.js";
import {
  autoRangeEventMatchesIdentity,
  sameStealthAutoRangeInstance,
  updateStealthAutoRangeBounds,
  STEALTH_AUTO_RANGE_ARM_TTL_MS,
  type StealthAutoRangeIdentity,
  type StealthAutoRangeBreakoutEvent,
} from "./stealth-breakout-armed.js";

const STEALTH_FIRE_CLAIM_TTL_MS = 10 * 60 * 1000;
const STEALTH_ARM_UNSEEN_RANGE_MS = 48 * 60 * 60 * 1000;
// A qualified (confirmed) breakout never expires by time: it stays stored with
// its level until it fires or a real structural/gate reason closes it.

type ArmedRow = {
  id: number;
  status: "armed" | "qualified" | "firing";
  structure_key: string;
  breakout_source: "horizontal" | "trendline";
  breakout_level: number;
  touches: number;
  armed_at_ms: number;
  armed_after_4h_at_ms: number;
  armed_after_1h_at_ms?: number;
  expires_at_ms: number;
  level_source: string;
  legacy_breakout_level: number | null;
  experiment_version: string | null;
  abneon_nearest_resistance: number | null;
  decision_json?: Record<string, unknown> | null;
};

export type ActiveAutoRange4hArm = {
  symbol: string;
  decisionAt: number;
};

export type ActiveAutoRange4hArmPage = {
  arms: ActiveAutoRange4hArm[];
  totalCount: number;
  nextCursor: number;
};

/** Freeze the independently confirmed venue set once on each matching arm. */
export async function persistStealthAutoRangeConfirmingVenues(input: {
  armIds: readonly number[];
  venues: readonly NonNullable<StealthAutoRangeIdentity["venue"]>[];
}): Promise<void> {
  const armIds = [...new Set(input.armIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0,
  );
  const venues = [...new Set(input.venues)];
  if (armIds.length === 0 || venues.length === 0) return;
  const ids = sql.join(
    armIds.map((id) => sql`${id}`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE stealth_breakout_armed_setups
    SET decision_json = jsonb_set(
      decision_json,
      '{autoRangeIdentity,confirmingVenues}',
      ${JSON.stringify(venues)}::jsonb,
      true
    )
    WHERE id IN (${ids})
      AND level_source = 'auto_range_4h'
      AND decision_json #> '{autoRangeIdentity,confirmingVenues}' IS NULL
  `);
}

/**
 * Persisted live 4H Range arms must be discoverable independently of Prescan
 * and OI Watch. A bounded offset page lets scanner cycles fairly visit every
 * active arm, including rows beyond the oldest page and symbols without a
 * current ticker.
 */
export async function listActiveAutoRange4hArms(
  limit = 50,
  cursor = 0,
  levelSources: readonly ("auto_range_4h" | "auto_range_1h")[] = [
    "auto_range_4h",
    "auto_range_1h",
  ],
): Promise<ActiveAutoRange4hArmPage> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
  const sources = sql.join(
    levelSources.map((source) => sql`${source}`),
    sql`, `,
  );
  // A confirmed breakout (qualified/firing) is visited in EVERY cycle. Ordering
  // by decision_at used to push freshly qualified arms to the back of the
  // paged queue, so they waited several cycles and lost their breakout.
  const priorityResult = await db.execute(sql`
    SELECT symbol, MIN(decision_at) AS decision_at
    FROM stealth_breakout_armed_setups
    WHERE level_source IN (${sources})
      AND status IN ('qualified', 'firing')
    GROUP BY symbol
    ORDER BY MIN(decision_at) ASC NULLS FIRST, MIN(id) ASC
  `);
  const priorityRows = priorityResult.rows as Array<{
    symbol: string;
    decision_at: unknown;
  }>;
  const prioritySymbols = new Set(priorityRows.map((row) => row.symbol));
  const toArm = (row: { symbol: string; decision_at: unknown }) => ({
    symbol: row.symbol,
    decisionAt:
      row.decision_at instanceof Date
        ? row.decision_at.getTime()
        : Date.parse(String(row.decision_at)),
  });
  const countResult = await db.execute(sql`
    SELECT COUNT(DISTINCT symbol)::int AS total_count
    FROM stealth_breakout_armed_setups
    WHERE level_source IN (${sources})
      AND status = 'armed'
      AND expires_at > now()
      AND symbol NOT IN (SELECT symbol FROM stealth_breakout_armed_setups WHERE level_source IN (${sources}) AND status IN ('qualified','firing'))
  `);
  const totalCount = Number(
    (countResult.rows[0] as { total_count: number | string } | undefined)
      ?.total_count ?? 0,
  );
  if (!Number.isFinite(totalCount) || totalCount <= 0) {
    return {
      arms: priorityRows.map(toArm),
      totalCount: priorityRows.length,
      nextCursor: 0,
    };
  }

  const page = getCircularPageWindow(totalCount, cursor, boundedLimit);
  const firstPage = await db.execute(sql`
    SELECT symbol, MIN(decision_at) AS decision_at
    FROM stealth_breakout_armed_setups
    WHERE level_source IN (${sources})
      AND status = 'armed'
      AND expires_at > now()
      AND symbol NOT IN (SELECT symbol FROM stealth_breakout_armed_setups WHERE level_source IN (${sources}) AND status IN ('qualified','firing'))
    GROUP BY symbol
    ORDER BY MIN(decision_at) ASC NULLS FIRST, MIN(id) ASC
    LIMIT ${page.firstPageLimit}
    OFFSET ${page.offset}
  `);
  const rows = [...firstPage.rows] as Array<{
    symbol: string;
    decision_at: unknown;
  }>;
  const wrappedPageLimit = page.wrappedPageLimit;
  if (wrappedPageLimit > 0) {
    const wrappedPage = await db.execute(sql`
    SELECT symbol, MIN(decision_at) AS decision_at
      FROM stealth_breakout_armed_setups
      WHERE level_source IN (${sources})
        AND status = 'armed'
        AND expires_at > now()
        AND symbol NOT IN (SELECT symbol FROM stealth_breakout_armed_setups WHERE level_source IN (${sources}) AND status IN ('qualified','firing'))
    GROUP BY symbol
    ORDER BY MIN(decision_at) ASC NULLS FIRST, MIN(id) ASC
      LIMIT ${wrappedPageLimit}
    `);
    rows.push(
      ...(wrappedPage.rows as Array<{
        symbol: string;
        decision_at: unknown;
      }>),
    );
  }
  return {
    arms: [...priorityRows, ...rows].map(toArm),
    totalCount: totalCount + prioritySymbols.size,
    nextCursor: page.nextCursor,
  };
}

function autoRangeStructureKey(identity: StealthAutoRangeIdentity): string {
  return [
    identity.venue ?? "bingx",
    identity.version,
    identity.openedAt,
    identity.anchorAt,
  ].join(":");
}

/**
 * A Pine range stays on the chart (and can break out again) after the arm that
 * watched it ended. Re-arm the same range under a numbered key when every
 * earlier arm for it ended without a signal; a range that already fired, or
 * was reclassified, is never re-armed.
 */
async function nextAutoRange1hStructureKey(
  tx: {
    execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }>;
  },
  symbol: string,
  baseKey: string,
): Promise<string> {
  const prior = await tx.execute(sql`
    SELECT structure_key, status, fired_at
    FROM stealth_breakout_armed_setups
    WHERE symbol = ${symbol}
      AND level_source = 'auto_range_1h'
      AND (structure_key = ${baseKey} OR structure_key LIKE ${`${baseKey}:r%`})
  `);
  const rows = prior.rows as Array<{
    structure_key: string;
    status: string;
    fired_at: unknown;
  }>;
  if (
    rows.length === 0 ||
    rows.some(
      (row) =>
        row.fired_at !== null ||
        row.status === "fired" ||
        row.status === "reclassified",
    )
  ) {
    return baseKey;
  }
  return `${baseKey}:r${rows.length}`;
}

export type DurableStealthArmProvenance = {
  levelSource: string;
  breakoutLevel: number;
  legacyBreakoutLevel: number | null;
  experimentVersion: string | null;
  abneonResistance: number | null;
  autoRangeIdentity: StealthAutoRangeIdentity | null;
};

export function buildStealthDecisionAudit(input: {
  arm: StealthArmedSnapshot;
  decision: StealthArmedDecision;
  evaluatedAt: number;
  participationTelemetry?: StealthBreakoutParticipationTelemetry;
}): Record<string, unknown> {
  const { arm, decision, evaluatedAt } = input;
  const refinement = "refinement" in decision ? decision.refinement : undefined;
  const breakoutGate =
    arm.technicalMode === "auto_range_4h"
      ? "closed_4h_pine_upside_break_matches_frozen_auto_range_then_closed_1h_hold"
      : arm.technicalMode === "auto_range_1h"
        ? "closed_1h_pine_upside_break_matches_versioned_frozen_auto_range_then_closed_30m_hold"
        : arm.technicalMode === "closed_1h_30m"
          ? "closed_1h_cross_with_volume_then_closed_30m_hold"
          : arm.technicalMode === "closed_30m"
            ? "two_closed_30m_closes_above_frozen_4h_resistance"
            : "closed_4h_candle_breaks_frozen_4h_resistance";
  return {
    status: decision.status,
    reason: decision.reason,
    timeframe:
      arm.technicalMode === "auto_range_4h"
        ? "4h_auto_range+1h"
        : arm.technicalMode === "auto_range_1h"
          ? "1h_auto_range+30m"
          : arm.technicalMode === "closed_1h_30m"
            ? "1h+30m"
            : arm.technicalMode === "closed_30m"
              ? "30m"
              : "4h",
    breakoutGate,
    evaluatedAt,
    technicalMode: arm.technicalMode ?? "four_hour",
    frozenLevel: arm.breakoutLevel,
    autoRangeIdentity: arm.autoRangeIdentity ?? null,
    autoRangeVersion: arm.autoRangeIdentity?.version ?? null,
    autoRangeCandleCutoff: arm.autoRangeIdentity?.candleCutoff ?? null,
    breakoutSource: arm.breakoutSource,
    firstCrossAt: "firstCrossAt" in decision ? decision.firstCrossAt : null,
    decisionLagMs:
      "firstCrossAt" in decision ? evaluatedAt - decision.firstCrossAt : null,
    confirmation: "confirmation" in decision ? decision.confirmation : null,
    refinement: refinement ?? null,
    windowShadow:
      refinement?.confirmationAt == null
        ? null
        : {
            version: "stealth-30m-hold-v1",
            hypotheticalEntryAt: refinement.confirmationAt,
            confirmationCandleTimes: refinement.confirmationCandleTimes,
            stopCandidatesPct: [6, 8, 10],
            evaluationSource: "pattern_backfill_candles_15m",
            sameCandlePolicy: "stop_first",
          },
    volumeShadow: "volumeShadow" in decision ? decision.volumeShadow : null,
    oneHourVolume:
      "oneHourVolume" in decision ? (decision.oneHourVolume ?? null) : null,
    entryPath:
      "entryPath" in decision
        ? ((decision as { entryPath?: string }).entryPath ?? null)
        : null,
    latestEvaluationParticipationTelemetry:
      input.participationTelemetry ?? null,
  };
}

function triggerParticipationTelemetry(
  telemetry: StealthBreakoutParticipationTelemetry | undefined,
  firstCrossAt: number,
): StealthBreakoutParticipationTelemetry {
  if (telemetry?.capturedAt === firstCrossAt) return telemetry;
  const delayedSource = (source?: string) =>
    source ? `unavailable_delayed:${source}` : "unavailable_at_trigger";
  return {
    capturedAt: firstCrossAt,
    oi: {
      value: null,
      source: delayedSource(telemetry?.oi.source),
      available: false,
    },
    cvd: {
      value: { cvd15m: null, cvd30m: null, cvd1h: null, cvd4h: null },
      source: delayedSource(telemetry?.cvd.source),
      available: false,
    },
    spotTaker: {
      value: null,
      source: delayedSource(telemetry?.spotTaker.source),
      available: false,
    },
  };
}

export type DurableStealthArmedResult =
  | {
      status: "not_armed";
      reason:
        | "no_quiet_structure"
        | "missing_4h_data"
        | "missing_1h_data"
        | "creation_blocked";
    }
  | {
      status: "armed";
      armId: number;
      created: boolean;
      arm: DurableStealthArmProvenance;
      waitingReason:
        | "awaiting_later_4h_cross"
        | "awaiting_later_1h_cross_with_volume"
        | "awaiting_later_1h_auto_range_breakout"
        | "breakout_active_waiting_retest"
        | "breakout_active_waiting_30m_data"
        | "breakout_active_waiting_1h_data";
    }
  | {
      status: "in_flight";
      armId: number;
      arm: DurableStealthArmProvenance;
    }
  | {
      status: "qualified" | "invalidated" | "expired";
      armId: number;
      decision: Exclude<StealthArmedDecision, { status: "armed" }>;
      arm: DurableStealthArmProvenance;
    }
  | {
      status: "terminal_structure";
      reason: "already_consumed" | "superseded_by_1h_confirmation_policy";
    };

export async function sweepExpiredStealthArmClaims(
  evaluatedAt = Date.now(),
): Promise<{ armed: number; qualified: number; firing: number }> {
  return db.transaction(async (tx) => {
    const armed = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'expired',
        terminal_reason = 'arm_ttl_elapsed',
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'expired',
            'reason', 'arm_ttl_elapsed',
            'evaluatedAt', ${evaluatedAt}::bigint
          ),
        updated_at = now()
      WHERE status = 'armed'
        AND expires_at <= to_timestamp(${evaluatedAt / 1000.0})
      RETURNING id, symbol, level_source, decision_json
    `);
    // A scanner crash can happen after tracker persistence but before
    // markStealthArmFired. Reconcile by the stable symbol/sentiment claim
    // window before releasing the claim; otherwise a duplicate fire is
    // possible after restart.
    const recoveredFiring = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups AS setup
         SET status = 'fired',
             fired_signal_id = tracked.signal_id,
             terminal_reason = 'fire_recovered_from_active_tracker',
             decision_at = to_timestamp(${evaluatedAt / 1000.0}),
             decision_json = COALESCE(setup.decision_json, '{}'::jsonb) ||
               jsonb_build_object(
                 'status', 'fired',
                 'reason', 'fire_recovered_from_active_tracker',
                 'signalId', tracked.signal_id,
                 'evaluatedAt', ${evaluatedAt}::bigint
               ),
             fire_claimed_at = NULL,
             updated_at = now()
        FROM tracked_signals AS tracked
       WHERE setup.status = 'firing'
         AND setup.fire_claimed_at <= to_timestamp(${(evaluatedAt - STEALTH_FIRE_CLAIM_TTL_MS) / 1000.0})
         AND tracked.symbol = setup.symbol
         AND tracked.sentiment_key = 'stealth_breakout'
         AND tracked.signal_id IS NOT NULL
         AND tracked.detected_at >= setup.fire_claimed_at
          AND tracked.detected_at <=
            setup.fire_claimed_at +
              (${STEALTH_FIRE_CLAIM_TTL_MS}::bigint * INTERVAL '1 millisecond')
      RETURNING setup.id
    `);
    const firing = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'qualified',
        terminal_reason = NULL,
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'qualified',
            'reason', 'fire_claim_recovered_for_retry',
            'evaluatedAt', ${evaluatedAt}::bigint
          ),
        fire_claimed_at = NULL,
        updated_at = now()
      WHERE status = 'firing'
        AND fire_claimed_at <
          to_timestamp(${(evaluatedAt - STEALTH_FIRE_CLAIM_TTL_MS) / 1000.0})
      RETURNING id, symbol, level_source, decision_json
    `);
    const transitions = [
      ...armed.rows.map((row) => ({ row, transition: "arm_expired" })),
      ...firing.rows.map((row) => ({ row, transition: "fire_recovered" })),
    ] as Array<{
      row: {
        id: number;
        symbol: string;
        level_source: string;
        decision_json: unknown;
      };
      transition: string;
    }>;
    for (const { row: item, transition } of transitions) {
      if (item.level_source !== "continuation_shelf") continue;
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${item.id}:${transition}:${evaluatedAt}`},
          ${item.id},
          ${item.symbol},
          'decision',
          to_timestamp(${evaluatedAt / 1000.0}),
          ${JSON.stringify(item.decision_json)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
    // Owner order 2026-10-17: no retry window. A qualified Range breakout that
    // was not fired stays offered every cycle until it fires or is rejected by
    // a structural guard (price back below level, chase limit, range recheck).
    // Accountability: a qualified breakout must receive a logged scan verdict
    // (reject reason or fire) every cycle. Report any that did not.
    const unreached = await tx.execute(sql`
      SELECT s.id, s.symbol, s.level_source
      FROM stealth_breakout_armed_setups s
      WHERE s.status = 'qualified'
        AND s.level_source IN ('auto_range_4h', 'auto_range_1h')
        AND s.decision_at < to_timestamp(${(evaluatedAt - 35 * 60 * 1000) / 1000.0})
        AND NOT EXISTS (
          SELECT 1 FROM scan_reject_log r
          WHERE r.symbol = s.symbol
            AND r.pattern = 'stealth_breakout'
            AND r.cycle_at >= to_timestamp(${(evaluatedAt - 35 * 60 * 1000) / 1000.0})
        )
    `);
    if (unreached.rows.length > 0) {
      logger.error(
        { arms: unreached.rows },
        "Qualified Range breakouts without a logged scan verdict in the last 35 min",
      );
    }
    return {
      armed: armed.rows.length,
      qualified: 0,
      firing: firing.rows.length + recoveredFiring.rows.length,
    };
  });
}

export async function terminalizeDisabledAutoRangeArms(
  levelSource: "auto_range_1h" | "auto_range_4h" = "auto_range_4h",
  evaluatedAt = Date.now(),
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE stealth_breakout_armed_setups
    SET status = 'invalidated',
        terminal_reason = 'auto_range_live_disabled',
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', 'auto_range_live_disabled',
            'evaluatedAt', ${evaluatedAt}::bigint
          ),
        updated_at = now()
    WHERE level_source = ${levelSource}
      AND status IN ('armed', 'qualified')
    RETURNING id
  `);
  return result.rows.length;
}

function rowToSnapshot(row: ArmedRow): StealthArmedSnapshot {
  const audit =
    typeof row.decision_json === "string"
      ? (JSON.parse(row.decision_json) as Record<string, unknown>)
      : (row.decision_json ?? {});
  const state =
    audit.closed30mState && typeof audit.closed30mState === "object"
      ? (audit.closed30mState as Record<string, unknown>)
      : {};
  const rawAutoRange =
    audit.autoRangeIdentity && typeof audit.autoRangeIdentity === "object"
      ? (audit.autoRangeIdentity as Record<string, unknown>)
      : null;
  const validAutoRangeVersion =
    rawAutoRange?.version === "auto_range_pine_v1_1h"
      ? "auto_range_pine_v1_1h"
      : rawAutoRange?.version === "auto_range_pine_v1"
        ? "auto_range_pine_v1"
        : undefined;
  const validAutoRangeVenue =
    rawAutoRange?.venue === undefined || rawAutoRange?.venue === null
      ? "bingx"
      : typeof rawAutoRange.venue === "string" &&
          [
            "bingx",
            "binance",
            "okx",
            "bybit",
            "gate",
            "kucoin",
            "mexc",
            "bitget",
            "htx",
            "kraken",
          ].includes(rawAutoRange.venue)
        ? (rawAutoRange.venue as StealthAutoRangeIdentity["venue"])
        : undefined;
  const validConfirmingVenues = Array.isArray(rawAutoRange?.confirmingVenues)
    ? rawAutoRange.confirmingVenues.filter(
        (venue): venue is NonNullable<StealthAutoRangeIdentity["venue"]> =>
          typeof venue === "string" &&
          [
            "bingx",
            "binance",
            "okx",
            "bybit",
            "gate",
            "kucoin",
            "mexc",
            "bitget",
            "htx",
            "kraken",
          ].includes(venue),
      )
    : undefined;
  const autoRangeIdentity: StealthAutoRangeIdentity | undefined =
    rawAutoRange &&
    validAutoRangeVersion &&
    validAutoRangeVenue &&
    Number.isFinite(Number(rawAutoRange.openedAt)) &&
    Number.isFinite(Number(rawAutoRange.anchorAt)) &&
    Number.isFinite(Number(rawAutoRange.upper)) &&
    Number.isFinite(Number(rawAutoRange.lower)) &&
    Number.isFinite(Number(rawAutoRange.candleCutoff))
      ? {
          version: validAutoRangeVersion,
          venue: validAutoRangeVenue,
          ...(validConfirmingVenues?.length
            ? { confirmingVenues: validConfirmingVenues }
            : {}),
          openedAt: Number(rawAutoRange.openedAt),
          anchorAt: Number(rawAutoRange.anchorAt),
          upper: Number(rawAutoRange.upper),
          lower: Number(rawAutoRange.lower),
          candleCutoff: Number(rawAutoRange.candleCutoff),
        }
      : undefined;
  return {
    structureKey: row.structure_key,
    breakoutSource: row.breakout_source,
    breakoutLevel: Number(row.breakout_level),
    touches: Number(row.touches),
    armedAt: normalizeStealthTimestamp(row.armed_at_ms),
    armedAfterFourHourCandleTime: normalizeStealthTimestamp(
      row.armed_after_4h_at_ms,
    ),
    armedAfterOneHourCandleTime:
      row.armed_after_1h_at_ms == null
        ? normalizeStealthTimestamp(row.armed_after_4h_at_ms)
        : normalizeStealthTimestamp(row.armed_after_1h_at_ms),
    expiresAt: normalizeStealthTimestamp(row.expires_at_ms),
    technicalMode:
      audit.technicalMode === "auto_range_4h"
        ? "auto_range_4h"
        : audit.technicalMode === "auto_range_1h"
          ? "auto_range_1h"
          : audit.technicalMode === "closed_1h_30m"
            ? "closed_1h_30m"
            : audit.technicalMode === "closed_30m"
              ? "closed_30m"
              : "four_hour",
    autoRangeIdentity,
    atr: audit.atr == null ? undefined : Number(audit.atr),
    rawCrossObservedAt:
      state.rawCrossObservedAt == null
        ? null
        : Number(state.rawCrossObservedAt),
    rawCrossCandleAt:
      state.rawCrossCandleAt == null ? null : Number(state.rawCrossCandleAt),
    rawCrossPrice:
      state.rawCrossPrice == null ? null : Number(state.rawCrossPrice),
    reclaimCount: Number(state.reclaimCount ?? 0),
    lastCandleAt:
      state.lastCandleAt == null ? null : Number(state.lastCandleAt),
  };
}

export function normalizeStealthTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  throw new Error(`Invalid Stealth timestamp: ${String(value)}`);
}

function rowToProvenance(row: ArmedRow): DurableStealthArmProvenance {
  return {
    levelSource: row.level_source,
    breakoutLevel: Number(row.breakout_level),
    legacyBreakoutLevel:
      row.legacy_breakout_level == null
        ? null
        : Number(row.legacy_breakout_level),
    experimentVersion: row.experiment_version,
    abneonResistance:
      row.abneon_nearest_resistance == null
        ? null
        : Number(row.abneon_nearest_resistance),
    autoRangeIdentity: rowToSnapshot(row).autoRangeIdentity ?? null,
  };
}

const QUALIFIED_RETRY_LEVEL_SOURCES = new Set([
  "auto_range_1h",
  "auto_range_4h",
]);

/**
 * A Range breakout that qualified but was not fired (e.g. aggregated data was
 * briefly missing) is offered again from its stored qualified decision while
 * the breakout is fresh. Re-evaluating from live candles cannot reproduce it:
 * the live breakout event is only available for the latest closed candle.
 */
function retryableQualifiedDecision(
  row: ArmedRow,
  _evaluatedAt: number,
): Extract<StealthArmedDecision, { status: "qualified" }> | null {
  if (row.status !== "qualified") return null;
  const stored = row.decision_json;
  if (!QUALIFIED_RETRY_LEVEL_SOURCES.has(row.level_source) || !stored)
    return null;
  const firstCrossAt = Number(stored.firstCrossAt);
  if (!Number.isFinite(firstCrossAt)) return null;
  if (!stored.confirmation || !stored.refinement) return null;
  return {
    status: "qualified",
    reason: "later_frozen_level_cross",
    firstCrossAt,
    confirmation: stored.confirmation,
    refinement: stored.refinement,
    volumeShadow: stored.volumeShadow ?? null,
    ...(stored.oneHourVolume ? { oneHourVolume: stored.oneHourVolume } : {}),
    ...(stored.entryPath ? { entryPath: stored.entryPath } : {}),
  } as unknown as Extract<StealthArmedDecision, { status: "qualified" }>;
}

async function evaluateDurableStealthArmInner(input: {
  symbol: string;
  structure: BreakoutEvidence;
  breakoutCandles4h: readonly BreakoutCandle[];
  breakoutCandles1h?: readonly BreakoutCandle[];
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt?: number;
  allowCreate?: boolean;
  levelSource?:
    | "stealth_legacy"
    | "continuation_shelf"
    | "auto_range_4h"
    | "auto_range_1h";
  legacyBreakoutLevel?: number | null;
  experimentVersion?: string | null;
  /** Immutable observational evidence; never participates in live evaluation. */
  abneonSnapshot?: StealthAbneonArmSnapshot;
  /** Immutable observational participation evidence; never a live gate. */
  participationTelemetry?: StealthBreakoutParticipationTelemetry;
  technicalMode?:
    | "four_hour"
    | "closed_30m"
    | "closed_1h_30m"
    | "auto_range_4h"
    | "auto_range_1h";
  atr?: number;
  autoRangeIdentity?: StealthAutoRangeIdentity | null;
  fastVolumePass?: boolean;
  marketCapUsd?: number | null;
  autoRangeBreakoutEvent?: StealthAutoRangeBreakoutEvent | null;
  autoRangeStatus?: AutoRangePineResult["status"];
  /**
   * 1H Range only. A symbol may hold two live arms: the primary one and a
   * secondary arm on a newer detector range while price still sits inside the
   * primary's frozen range (owner 2026-10-19). Default is primary.
   */
  armSlot?: "primary" | "secondary";
  /**
   * Aggregated volume already fetched by the caller (time → USD). When given,
   * it is used as-is and CoinGlass is not asked again for the same interval.
   */
  prefetchedVolumes?: {
    "1h"?: ReadonlyMap<number, number> | null;
    "4h"?: ReadonlyMap<number, number> | null;
  };
}): Promise<DurableStealthArmedResult> {
  const evaluatedAt = input.evaluatedAt ?? Date.now();
  const levelSource = input.levelSource ?? "stealth_legacy";
  const armSlot = input.armSlot ?? "primary";
  const oneHourIdentity = input.autoRangeIdentity;
  const autoRangeVenue =
    input.autoRangeIdentity?.venue ??
    input.autoRangeBreakoutEvent?.venue ??
    "bingx";
  if (
    (levelSource === "auto_range_1h" ||
      input.technicalMode === "auto_range_1h") &&
    (levelSource !== "auto_range_1h" || input.technicalMode !== "auto_range_1h")
  ) {
    return { status: "not_armed", reason: "creation_blocked" };
  }
  // Owner rule: volume is aggregated only. Attach CoinGlass multi-exchange USD
  // volume to the breakout candles before the DB lock; BingX volume is ignored.
  const withAggregatedVolume = async (
    candles: readonly BreakoutCandle[] | undefined,
    interval: "1h" | "4h",
  ): Promise<readonly BreakoutCandle[] | undefined> => {
    if (!candles || candles.length === 0) return candles;
    // A key present in prefetchedVolumes (even null = caller's fetch failed)
    // means the caller already asked CoinGlass: never ask again.
    const volumes =
      input.prefetchedVolumes && interval in input.prefetchedVolumes
        ? (input.prefetchedVolumes[interval] ?? null)
        : await getAggFuturesVolumeByInterval(
            input.symbol,
            interval,
            Math.min(4500, candles.length + 5),
          ).catch(() => null);
    return candles.map((candle) => ({
      ...candle,
      volumeUsd: volumes?.get(candle.time),
    }));
  };
  input = {
    ...input,
    breakoutCandles4h:
      (await withAggregatedVolume(input.breakoutCandles4h, "4h")) ??
      input.breakoutCandles4h,
    breakoutCandles1h: await withAggregatedVolume(
      input.breakoutCandles1h,
      "1h",
    ),
  };
  return db.transaction(async (tx) => {
    const recoveredFireClaims = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'qualified',
        terminal_reason = NULL,
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'qualified',
            'reason', 'fire_claim_recovered_for_retry',
            'evaluatedAt', ${evaluatedAt}::bigint
          ),
        fire_claimed_at = NULL,
        updated_at = now()
      WHERE symbol = ${input.symbol}
        AND level_source = ${levelSource}
        AND status = 'firing'
        AND fire_claimed_at <
          to_timestamp(${(evaluatedAt - STEALTH_FIRE_CLAIM_TTL_MS) / 1000.0})
      RETURNING id, symbol, level_source, decision_json
    `);
    for (const item of [...recoveredFireClaims.rows] as Array<{
      id: number;
      symbol: string;
      level_source: string;
      decision_json: unknown;
    }>) {
      if (item.level_source !== "continuation_shelf") continue;
      const transition = "fire_recovered";
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${item.id}:${transition}:${evaluatedAt}`},
          ${item.id},
          ${item.symbol},
          'decision',
          to_timestamp(${evaluatedAt / 1000.0}),
          ${JSON.stringify(item.decision_json)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
    const activeResult = await tx.execute(sql`
      SELECT
        id,
        status,
        structure_key,
        breakout_source,
        breakout_level,
        touches,
        (EXTRACT(EPOCH FROM armed_at) * 1000)::bigint AS armed_at_ms,
        (EXTRACT(EPOCH FROM armed_after_4h_at) * 1000)::bigint AS armed_after_4h_at_ms,
        (EXTRACT(EPOCH FROM armed_after_1h_at) * 1000)::bigint AS armed_after_1h_at_ms,
        (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms,
        level_source,
        legacy_breakout_level,
        experiment_version,
        abneon_nearest_resistance,
        decision_json
      FROM stealth_breakout_armed_setups
      WHERE symbol = ${input.symbol}
        AND level_source = ${levelSource}
        AND (
          ${levelSource} <> 'auto_range_4h'
          OR COALESCE(decision_json #>> '{autoRangeIdentity,venue}', 'bingx') =
            ${autoRangeVenue}
        )
        AND (
          ${levelSource} <> 'auto_range_1h'
          OR COALESCE(decision_json ->> 'armSlot', 'primary') = ${armSlot}
        )
        AND status IN ('armed', 'qualified', 'firing')
      FOR UPDATE
    `);
    let row: ArmedRow | undefined = (
      activeResult.rows as unknown as ArmedRow[]
    )[0];
    // A secondary arm becomes the primary once the primary is gone and the
    // detector's active range is that secondary's range: re-arming would
    // duplicate the same range under a ":rN" key.
    if (
      !row &&
      armSlot === "primary" &&
      levelSource === "auto_range_1h" &&
      input.autoRangeIdentity
    ) {
      const secondary = await tx.execute(sql`
        SELECT id, structure_json #> '{autoRangeIdentity}' AS identity
        FROM stealth_breakout_armed_setups
        WHERE symbol = ${input.symbol}
          AND level_source = 'auto_range_1h'
          AND decision_json ->> 'armSlot' = 'secondary'
          AND status IN ('armed', 'qualified', 'firing')
        FOR UPDATE
      `);
      const secondaryRow = (
        secondary.rows as unknown as Array<{
          id: number;
          identity: StealthAutoRangeIdentity | string | null;
        }>
      )[0];
      const secondaryIdentity =
        typeof secondaryRow?.identity === "string"
          ? (JSON.parse(secondaryRow.identity) as StealthAutoRangeIdentity)
          : secondaryRow?.identity;
      if (
        secondaryRow &&
        secondaryIdentity &&
        sameStealthAutoRangeInstance(secondaryIdentity, input.autoRangeIdentity)
      ) {
        await tx.execute(sql`
          UPDATE stealth_breakout_armed_setups
          SET decision_json = COALESCE(decision_json, '{}'::jsonb) ||
                jsonb_build_object('armSlot', 'primary'),
              updated_at = now()
          WHERE id = ${secondaryRow.id}
        `);
        const promoted = await tx.execute(sql`
          SELECT
            id, status, structure_key, breakout_source, breakout_level, touches,
            (EXTRACT(EPOCH FROM armed_at) * 1000)::bigint AS armed_at_ms,
            (EXTRACT(EPOCH FROM armed_after_4h_at) * 1000)::bigint AS armed_after_4h_at_ms,
            (EXTRACT(EPOCH FROM armed_after_1h_at) * 1000)::bigint AS armed_after_1h_at_ms,
            (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms,
            level_source, legacy_breakout_level, experiment_version,
            abneon_nearest_resistance, decision_json
          FROM stealth_breakout_armed_setups
          WHERE id = ${secondaryRow.id}
        `);
        row = (promoted.rows as unknown as ArmedRow[])[0];
      }
    }
    if (
      row &&
      levelSource === "auto_range_4h" &&
      row.status === "armed" &&
      input.autoRangeStatus === "ready"
    ) {
      let existingIdentity = rowToSnapshot(row).autoRangeIdentity;
      const activeIdentity = input.autoRangeIdentity ?? null;
      const breakoutEvent = input.autoRangeBreakoutEvent ?? null;
      const activeSameInstance = sameStealthAutoRangeInstance(
        existingIdentity,
        activeIdentity,
      );
      const eventSameInstance = sameStealthAutoRangeInstance(
        existingIdentity,
        breakoutEvent
          ? {
              version: "auto_range_pine_v1",
              venue: existingIdentity?.venue ?? "bingx",
              openedAt: breakoutEvent.openedAt,
              anchorAt: breakoutEvent.anchorAt,
            }
          : null,
      );
      const observedRange = activeSameInstance
        ? activeIdentity
        : eventSameInstance && breakoutEvent && existingIdentity
          ? {
              version: existingIdentity.version,
              openedAt: breakoutEvent.openedAt,
              anchorAt: breakoutEvent.anchorAt,
              upper: breakoutEvent.upper,
              lower: breakoutEvent.lower,
              candleCutoff: existingIdentity.candleCutoff,
            }
          : null;
      if (existingIdentity && observedRange) {
        const updatedIdentity = updateStealthAutoRangeBounds(
          existingIdentity,
          observedRange,
        );
        if (
          updatedIdentity &&
          (updatedIdentity.upper !== existingIdentity.upper ||
            updatedIdentity.lower !== existingIdentity.lower)
        ) {
          const stableStructureKey = autoRangeStructureKey(updatedIdentity);
          const decision =
            typeof row.decision_json === "string"
              ? (JSON.parse(row.decision_json) as Record<string, unknown>)
              : (row.decision_json ?? {});
          const updatedDecision = {
            ...decision,
            frozenLevel: updatedIdentity.upper,
            autoRangeIdentity: updatedIdentity,
            autoRangeVersion: updatedIdentity.version,
            autoRangeCandleCutoff: updatedIdentity.candleCutoff,
          };
          // Another arm of the same symbol may already own the target key
          // (unique symbol+structure_key). Keep this arm's key then, instead
          // of failing the whole symbol scan on a duplicate-key error.
          const keyTaken = await tx.execute(sql`
            SELECT 1 FROM stealth_breakout_armed_setups
            WHERE symbol = ${input.symbol}
              AND structure_key = ${stableStructureKey}
              AND id <> ${row.id}
            LIMIT 1
          `);
          const nextStructureKey =
            keyTaken.rows.length > 0 ? row.structure_key : stableStructureKey;
          await tx.execute(sql`
            UPDATE stealth_breakout_armed_setups
            SET structure_key = ${nextStructureKey},
                breakout_level = ${updatedIdentity.upper},
                structure_json = COALESCE(structure_json, '{}'::jsonb) ||
                  jsonb_build_object(
                    'autoRangeIdentity',
                    ${JSON.stringify(updatedIdentity)}::jsonb
                  ),
                decision_json = ${JSON.stringify(updatedDecision)}::jsonb,
                updated_at = now()
            WHERE id = ${row.id}
              AND status = 'armed'
          `);
          row = {
            ...row,
            structure_key: nextStructureKey,
            breakout_level: updatedIdentity.upper,
            decision_json: updatedDecision,
          };
          existingIdentity = updatedIdentity;
        }
      }
      const stillActive = activeSameInstance;
      const matchingBreak = autoRangeEventMatchesIdentity(
        existingIdentity,
        breakoutEvent,
      );
      const latestRangeClose =
        input.breakoutCandles4h.at(-1)?.close ?? Number.NaN;
      const priceRemainsInFrozenRange =
        existingIdentity !== undefined &&
        latestRangeClose <= existingIdentity.upper &&
        latestRangeClose >= existingIdentity.lower;
      if (
        !stillActive &&
        !matchingBreak &&
        (activeIdentity !== null || !priceRemainsInFrozenRange)
      ) {
        const reason = activeIdentity
          ? "auto_range_range_replaced"
          : "auto_range_range_obsolete";
        const audit = {
          status: "invalidated",
          reason,
          evaluatedAt,
          priorAutoRangeIdentity: existingIdentity ?? null,
          currentAutoRangeIdentity: activeIdentity,
          latestUpsideBreakout: breakoutEvent,
        };
        await tx.execute(sql`
          UPDATE stealth_breakout_armed_setups
          SET status = 'invalidated',
              terminal_reason = ${reason},
              decision_at = to_timestamp(${evaluatedAt / 1000.0}),
              decision_json = COALESCE(decision_json, '{}'::jsonb) ||
                ${JSON.stringify(audit)}::jsonb,
              updated_at = now()
          WHERE id = ${row.id}
            AND status = 'armed'
        `);
        row = undefined;
      }
    }
    if (row && levelSource === "auto_range_1h" && row.status === "armed") {
      let existingIdentity = rowToSnapshot(row).autoRangeIdentity;
      const activeIdentity = input.autoRangeIdentity ?? null;
      const breakoutEvent = input.autoRangeBreakoutEvent ?? null;
      const activeSameInstance = sameStealthAutoRangeInstance(
        existingIdentity,
        activeIdentity,
      );
      const eventSameInstance = sameStealthAutoRangeInstance(
        existingIdentity,
        breakoutEvent
          ? {
              version: "auto_range_pine_v1_1h",
              openedAt: breakoutEvent.openedAt,
              anchorAt: breakoutEvent.anchorAt,
            }
          : null,
      );
      const observedRange = activeSameInstance
        ? activeIdentity
        : eventSameInstance && breakoutEvent && existingIdentity
          ? {
              version: existingIdentity.version,
              openedAt: breakoutEvent.openedAt,
              anchorAt: breakoutEvent.anchorAt,
              upper: breakoutEvent.upper,
              lower: breakoutEvent.lower,
              candleCutoff: existingIdentity.candleCutoff,
            }
          : null;
      if (existingIdentity && observedRange) {
        const updatedIdentity = updateStealthAutoRangeBounds(
          existingIdentity,
          observedRange,
        );
        if (
          updatedIdentity &&
          (updatedIdentity.upper !== existingIdentity.upper ||
            updatedIdentity.lower !== existingIdentity.lower)
        ) {
          const stableStructureKey = autoRangeStructureKey(updatedIdentity);
          const decision =
            typeof row.decision_json === "string"
              ? (JSON.parse(row.decision_json) as Record<string, unknown>)
              : (row.decision_json ?? {});
          const updatedDecision = {
            ...decision,
            frozenLevel: updatedIdentity.upper,
            autoRangeIdentity: updatedIdentity,
            autoRangeVersion: updatedIdentity.version,
            autoRangeCandleCutoff: updatedIdentity.candleCutoff,
          };
          // Another arm of the same symbol may already own the target key
          // (unique symbol+structure_key). Keep this arm's key then, instead
          // of failing the whole symbol scan on a duplicate-key error.
          const keyTaken = await tx.execute(sql`
            SELECT 1 FROM stealth_breakout_armed_setups
            WHERE symbol = ${input.symbol}
              AND structure_key = ${stableStructureKey}
              AND id <> ${row.id}
            LIMIT 1
          `);
          const nextStructureKey =
            keyTaken.rows.length > 0 ? row.structure_key : stableStructureKey;
          await tx.execute(sql`
            UPDATE stealth_breakout_armed_setups
            SET structure_key = ${nextStructureKey},
                breakout_level = ${updatedIdentity.upper},
                structure_json = COALESCE(structure_json, '{}'::jsonb) ||
                  jsonb_build_object(
                    'autoRangeIdentity',
                    ${JSON.stringify(updatedIdentity)}::jsonb
                  ),
                decision_json = ${JSON.stringify(updatedDecision)}::jsonb,
                updated_at = now()
            WHERE id = ${row.id}
              AND status = 'armed'
          `);
          row = {
            ...row,
            structure_key: nextStructureKey,
            breakout_level: updatedIdentity.upper,
            decision_json: updatedDecision,
          };
          existingIdentity = updatedIdentity;
        }
      }
      const matchingBreak = autoRangeEventMatchesIdentity(
        existingIdentity,
        breakoutEvent,
      );
      const latestRangeClose =
        input.breakoutCandles1h?.at(-1)?.close ?? Number.NaN;
      const priceRemainsInFrozenRange =
        existingIdentity?.version === "auto_range_pine_v1_1h" &&
        latestRangeClose <= existingIdentity.upper &&
        latestRangeClose >= existingIdentity.lower;
      // Missing/stale history is not evidence that the persisted range died.
      // Keep the arm until a fresh, continuous replay can verify replacement
      // or a matching breakout; otherwise a restart can permanently lose it.
      const unavailable = existingIdentity?.version !== "auto_range_pine_v1_1h";
      // Owner 2026-10-17 (LPT/ALICE): replay is path-dependent, so a scan can
      // show a different range instance while price still sits inside the
      // frozen one. That must not kill the arm before its breakout; a
      // replacement counts only once price has left the frozen range.
      const replaced =
        activeIdentity !== null &&
        !priceRemainsInFrozenRange &&
        !matchingBreak &&
        (!activeSameInstance ||
          activeIdentity.version !== "auto_range_pine_v1_1h");
      // Owner 2026-10-19: an arm whose range the detector has not shown for
      // 48 hours, with price still inside it, is dead weight. The last sighting
      // is stored on the arm; arms without one fall back to their arm time.
      const detectorSeesArm =
        input.autoRangeStatus === "ready" &&
        (activeSameInstance || matchingBreak);
      const storedLastSeen = Number(
        (row.decision_json as Record<string, unknown> | null | undefined)
          ?.detectorLastSeenAt,
      );
      const lastSeenAt = Number.isFinite(storedLastSeen)
        ? storedLastSeen
        : Number(row.armed_at_ms);
      const unseenTooLong =
        input.autoRangeStatus === "ready" &&
        !detectorSeesArm &&
        priceRemainsInFrozenRange &&
        evaluatedAt - lastSeenAt > STEALTH_ARM_UNSEEN_RANGE_MS;
      if (
        detectorSeesArm &&
        (!Number.isFinite(storedLastSeen) ||
          evaluatedAt - storedLastSeen > 30 * 60 * 1000)
      ) {
        await tx.execute(sql`
          UPDATE stealth_breakout_armed_setups
          SET decision_json = COALESCE(decision_json, '{}'::jsonb) ||
                jsonb_build_object('detectorLastSeenAt', ${evaluatedAt}::bigint)
          WHERE id = ${row.id}
            AND status = 'armed'
        `);
      }
      if (
        unavailable ||
        unseenTooLong ||
        (input.autoRangeStatus === "ready" &&
          (replaced ||
            (!activeSameInstance &&
              !matchingBreak &&
              !priceRemainsInFrozenRange)))
      ) {
        const reason = unavailable
          ? "auto_range_1h_range_unavailable"
          : replaced
            ? "auto_range_1h_range_replaced"
            : "auto_range_1h_range_obsolete";
        const audit = {
          status: "invalidated",
          reason,
          timeframe: "1h",
          evaluatedAt,
          priorAutoRangeIdentity: existingIdentity ?? null,
          currentAutoRangeIdentity: activeIdentity,
          latestUpsideBreakout: breakoutEvent,
        };
        await tx.execute(sql`
          UPDATE stealth_breakout_armed_setups
          SET status = 'invalidated',
              terminal_reason = ${reason},
              decision_at = to_timestamp(${evaluatedAt / 1000.0}),
              decision_json = COALESCE(decision_json, '{}'::jsonb) ||
                ${JSON.stringify(audit)}::jsonb,
              updated_at = now()
          WHERE id = ${row.id}
            AND status = 'armed'
        `);
        row = undefined;
      }
    }
    // Existing candidates were discovered under another confirmation policy.
    // Retire their pending slot explicitly and preserve their original audit;
    // the next scan can freeze a fresh arm under the new 1H policy. Never
    // reinterpret an old 30m crossing as a new 1H decision.
    if (
      row &&
      input.technicalMode === "closed_1h_30m" &&
      row.status !== "firing" &&
      rowToSnapshot(row).technicalMode !== "closed_1h_30m"
    ) {
      const reason = "superseded_by_1h_confirmation_policy";
      const previousMode = rowToSnapshot(row).technicalMode;
      const audit = {
        status: "invalidated",
        reason,
        evaluatedAt,
        priorTechnicalMode: previousMode,
      };
      await tx.execute(sql`
        UPDATE stealth_breakout_armed_setups
        SET status = 'invalidated',
            terminal_reason = ${reason},
            decision_at = to_timestamp(${evaluatedAt / 1000.0}),
            decision_json = COALESCE(decision_json, '{}'::jsonb) ||
              ${JSON.stringify(audit)}::jsonb,
            updated_at = now()
        WHERE id = ${row.id}
          AND status IN ('armed', 'qualified')
      `);
      if (levelSource === "continuation_shelf") {
        await tx.execute(sql`
          INSERT INTO stealth_continuation_shelf_events (
            event_key, arm_id, symbol, event_type, event_at, payload
          ) VALUES (
            ${`${row.id}:${reason}`},
            ${row.id},
            ${input.symbol},
            'decision',
            to_timestamp(${evaluatedAt / 1000.0}),
            ${JSON.stringify(audit)}::jsonb
          )
          ON CONFLICT (event_key) DO NOTHING
        `);
      }
      return { status: "terminal_structure", reason } as const;
    }
    if (row && row.status !== "armed") {
      const retry = retryableQualifiedDecision(row, evaluatedAt);
      if (retry) {
        return {
          status: "qualified",
          armId: row.id,
          decision: retry,
          arm: rowToProvenance(row),
        } as const;
      }
      return {
        status: "in_flight",
        armId: row.id,
        arm: rowToProvenance(row),
      } as const;
    }

    if (!row) {
      if (input.allowCreate === false) {
        return {
          status: "not_armed",
          reason: "creation_blocked",
        } as const;
      }
      if (
        levelSource === "auto_range_1h" &&
        (input.autoRangeStatus !== "ready" ||
          !oneHourIdentity ||
          oneHourIdentity.version !== "auto_range_pine_v1_1h" ||
          !Number.isFinite(oneHourIdentity.openedAt) ||
          !Number.isFinite(oneHourIdentity.anchorAt) ||
          !Number.isFinite(oneHourIdentity.candleCutoff) ||
          !Number.isFinite(oneHourIdentity.upper) ||
          !Number.isFinite(oneHourIdentity.lower) ||
          !(oneHourIdentity.upper > oneHourIdentity.lower))
      ) {
        return { status: "not_armed", reason: "creation_blocked" } as const;
      }
      const latestFourHour =
        input.breakoutCandles4h[input.breakoutCandles4h.length - 1];
      const latestOneHour =
        input.breakoutCandles1h?.[input.breakoutCandles1h.length - 1];
      if (levelSource === "auto_range_1h" && !latestOneHour) {
        return { status: "not_armed", reason: "missing_1h_data" } as const;
      }
      if (levelSource !== "auto_range_1h" && !latestFourHour) {
        return { status: "not_armed", reason: "missing_4h_data" } as const;
      }
      const snapshot =
        levelSource === "auto_range_4h"
          ? input.autoRangeIdentity
            ? {
                structureKey: autoRangeStructureKey(input.autoRangeIdentity),
                breakoutSource: "horizontal" as const,
                breakoutLevel: input.autoRangeIdentity.upper,
                touches: 2,
                armedAt: evaluatedAt,
                armedAfterFourHourCandleTime:
                  input.autoRangeIdentity.candleCutoff,
                armedAfterOneHourCandleTime:
                  input.autoRangeIdentity.candleCutoff,
                expiresAt: evaluatedAt + STEALTH_AUTO_RANGE_ARM_TTL_MS,
                technicalMode: "auto_range_4h" as const,
                autoRangeIdentity: input.autoRangeIdentity,
                atr: input.atr,
              }
            : null
          : levelSource === "auto_range_1h"
            ? input.autoRangeIdentity
              ? {
                  structureKey: await nextAutoRange1hStructureKey(
                    tx,
                    input.symbol,
                    autoRangeStructureKey(input.autoRangeIdentity),
                  ),
                  breakoutSource: "horizontal" as const,
                  breakoutLevel: input.autoRangeIdentity.upper,
                  touches: 2,
                  armedAt: evaluatedAt,
                  armedAfterFourHourCandleTime:
                    input.autoRangeIdentity.candleCutoff,
                  armedAfterOneHourCandleTime: latestOneHour!.time,
                  expiresAt: evaluatedAt + STEALTH_AUTO_RANGE_ARM_TTL_MS,
                  technicalMode: "auto_range_1h" as const,
                  autoRangeIdentity: input.autoRangeIdentity,
                  atr: input.atr,
                }
              : null
            : buildStealthArmedSnapshot({
                structure: input.structure,
                latestClosedFourHourCandleTime: latestFourHour!.time,
                confirmationCandles: input.breakoutCandles4h,
                armedAt: evaluatedAt,
                structureKeyPrefix:
                  input.technicalMode === "closed_1h_30m"
                    ? `${input.experimentVersion ?? "stealth"}:closed_1h_30m`
                    : (input.experimentVersion ?? undefined),
                technicalMode: input.technicalMode,
                atr: input.atr,
              });
      if (!snapshot) {
        return { status: "not_armed", reason: "no_quiet_structure" } as const;
      }
      if (input.technicalMode === "closed_1h_30m") {
        // The mode-specific key makes a fresh candidate possible after an
        // explicit policy cutover. It must not reopen a level already consumed
        // by an old signal or an ordinary terminal decision.
        const oldKey = buildStealthArmedSnapshot({
          structure: input.structure,
          latestClosedFourHourCandleTime: latestFourHour.time,
          confirmationCandles: input.breakoutCandles4h,
          armedAt: evaluatedAt,
          structureKeyPrefix: input.experimentVersion ?? undefined,
        })?.structureKey;
        if (oldKey) {
          const consumed = await tx.execute(sql`
            SELECT id FROM stealth_breakout_armed_setups
            WHERE symbol = ${input.symbol}
              AND level_source = ${levelSource}
              AND structure_key = ${oldKey}
              AND terminal_reason IS DISTINCT FROM
                'superseded_by_1h_confirmation_policy'
            LIMIT 1
          `);
          if (consumed.rows.length) {
            return {
              status: "terminal_structure",
              reason: "already_consumed",
            } as const;
          }
        }
      }
      const inserted = await tx.execute(sql`
        INSERT INTO stealth_breakout_armed_setups (
          symbol,
          structure_key,
          breakout_source,
          breakout_level,
          touches,
          quiet_zone,
          armed_at,
           armed_after_1h_at,
           armed_after_4h_at,
          expires_at,
          status,
          structure_json,
           abneon_indicator_version,
           abneon_status,
           abneon_verdict,
           abneon_nearest_resistance,
           abneon_level_distance_pct,
           abneon_classification,
           abneon_coverage,
           abneon_reason,
           abneon_checks,
           abneon_context,
           abneon_captured_at,
           level_source,
           legacy_breakout_level,
           experiment_version,
          decision_json,
          decision_at
        ) VALUES (
          ${input.symbol},
          ${snapshot.structureKey},
          ${snapshot.breakoutSource},
          ${snapshot.breakoutLevel},
          ${snapshot.touches},
          true,
          to_timestamp(${snapshot.armedAt / 1000.0}),
            to_timestamp(${(snapshot.armedAfterOneHourCandleTime ?? snapshot.armedAfterFourHourCandleTime!) / 1000.0}),
           to_timestamp(${snapshot.armedAfterFourHourCandleTime! / 1000.0}),
          to_timestamp(${snapshot.expiresAt / 1000.0}),
          'armed',
           ${JSON.stringify({
             ...input.structure,
             ...(snapshot.autoRangeIdentity
               ? { autoRangeIdentity: snapshot.autoRangeIdentity }
               : {}),
           })}::jsonb,
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.indicatorVersion ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.status ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.verdict ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.nearestResistance ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.levelDistancePct ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.classification ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.coverage ?? null) : null},
           ${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.reason ?? null) : null},
           ${levelSource === "stealth_legacy" && input.abneonSnapshot?.checks ? JSON.stringify(input.abneonSnapshot.checks) : null}::jsonb,
           ${levelSource === "stealth_legacy" && input.abneonSnapshot?.context ? JSON.stringify(input.abneonSnapshot.context) : null}::jsonb,
           to_timestamp(${levelSource === "stealth_legacy" ? (input.abneonSnapshot?.capturedAt ?? null) : null}::double precision / 1000.0),
           ${levelSource},
           ${input.legacyBreakoutLevel ?? null},
           ${input.experimentVersion ?? null},
           ${JSON.stringify({
             status: "armed",
             reason:
               input.technicalMode === "auto_range_4h"
                 ? "awaiting_later_4h_cross"
                 : input.technicalMode === "auto_range_1h"
                   ? "awaiting_later_1h_auto_range_breakout"
                   : input.technicalMode === "closed_1h_30m"
                     ? "awaiting_later_1h_cross_with_volume"
                     : "awaiting_later_4h_cross",
             timeframe:
               input.technicalMode === "auto_range_4h"
                 ? "4h_auto_range_pine"
                 : input.technicalMode === "auto_range_1h"
                   ? "1h_auto_range_pine"
                   : (input.technicalMode ?? "four_hour") === "closed_1h_30m"
                     ? "1h+30m"
                     : input.technicalMode === "closed_30m"
                       ? "30m"
                       : "4h",
             breakoutGate:
               input.technicalMode === "auto_range_4h"
                 ? "closed_4h_pine_upside_break_matches_frozen_auto_range_then_closed_1h_hold"
                 : input.technicalMode === "auto_range_1h"
                   ? "closed_1h_pine_upside_break_matches_versioned_frozen_auto_range_then_closed_30m_hold"
                   : (input.technicalMode ?? "four_hour") === "closed_1h_30m"
                     ? "closed_1h_cross_with_volume_then_closed_30m_hold"
                     : input.technicalMode === "closed_30m"
                       ? "two_closed_30m_closes_above_frozen_4h_resistance"
                       : "closed_4h_candle_breaks_frozen_4h_resistance",
             evaluatedAt,
             frozenLevel: snapshot.breakoutLevel,
             breakoutSource: snapshot.breakoutSource,
             levelSource,
             ...(levelSource === "auto_range_1h" ? { armSlot } : {}),
             autoRangeIdentity: snapshot.autoRangeIdentity ?? null,
             autoRangeVersion: snapshot.autoRangeIdentity?.version ?? null,
             autoRangeCandleCutoff:
               snapshot.autoRangeIdentity?.candleCutoff ?? null,
             legacyBreakoutLevel: input.legacyBreakoutLevel ?? null,
             experimentVersion: input.experimentVersion ?? null,
             technicalMode: input.technicalMode ?? "four_hour",
             atr: input.atr ?? null,
             alternativeResistances: {
               horizontal: input.structure.levels,
               trendline: input.structure.trendline,
             },
             abneonShadow:
               levelSource === "stealth_legacy" && input.abneonSnapshot
                 ? {
                     shadowOnly: true,
                     indicatorVersion: input.abneonSnapshot.indicatorVersion,
                     capturedAt: input.abneonSnapshot.capturedAt,
                     status: input.abneonSnapshot.status,
                     verdict: input.abneonSnapshot.verdict,
                     nearestResistance: input.abneonSnapshot.nearestResistance,
                     frozenStealthLevel:
                       input.abneonSnapshot.frozenStealthLevel,
                     levelDistancePct: input.abneonSnapshot.levelDistancePct,
                     classification: input.abneonSnapshot.classification,
                     coverage: input.abneonSnapshot.coverage,
                     reason: input.abneonSnapshot.reason,
                     checks: input.abneonSnapshot.checks,
                     context: input.abneonSnapshot.context,
                   }
                 : null,
           })}::jsonb,
          to_timestamp(${evaluatedAt / 1000.0})
        )
        ON CONFLICT DO NOTHING
        RETURNING
          id,
          status,
          structure_key,
          breakout_source,
          breakout_level,
          touches,
          (EXTRACT(EPOCH FROM armed_at) * 1000)::bigint AS armed_at_ms,
          (EXTRACT(EPOCH FROM armed_after_4h_at) * 1000)::bigint AS armed_after_4h_at_ms,
          (EXTRACT(EPOCH FROM armed_after_1h_at) * 1000)::bigint AS armed_after_1h_at_ms,
          (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms,
          level_source,
           legacy_breakout_level,
            experiment_version,
           abneon_nearest_resistance,
           decision_json
      `);
      row = (inserted.rows as unknown as ArmedRow[])[0];
      if (row) {
        if (levelSource === "continuation_shelf") {
          await tx.execute(sql`
            INSERT INTO stealth_continuation_shelf_events (
              event_key, arm_id, symbol, event_type, event_at, payload
            ) VALUES (
              ${`${row.id}:frozen`},
              ${row.id},
              ${input.symbol},
              'frozen',
              to_timestamp(${evaluatedAt / 1000.0}),
              ${JSON.stringify({
                structure: input.structure,
                frozenLevel: snapshot.breakoutLevel,
                structureKey: snapshot.structureKey,
                levelSource,
              })}::jsonb
            )
            ON CONFLICT (event_key) DO NOTHING
          `);
        }
        return {
          status: "armed",
          armId: row.id,
          created: true,
          arm: rowToProvenance(row),
          waitingReason:
            input.technicalMode === "auto_range_1h"
              ? "awaiting_later_1h_auto_range_breakout"
              : input.technicalMode === "closed_1h_30m"
                ? "awaiting_later_1h_cross_with_volume"
                : "awaiting_later_4h_cross",
        };
      }

      const concurrent = await tx.execute(sql`
        SELECT
          id,
          status,
          structure_key,
          breakout_source,
          breakout_level,
          touches,
          (EXTRACT(EPOCH FROM armed_at) * 1000)::bigint AS armed_at_ms,
          (EXTRACT(EPOCH FROM armed_after_4h_at) * 1000)::bigint AS armed_after_4h_at_ms,
          (EXTRACT(EPOCH FROM armed_after_1h_at) * 1000)::bigint AS armed_after_1h_at_ms,
          (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms,
          level_source,
          legacy_breakout_level,
          experiment_version,
          abneon_nearest_resistance,
          decision_json
        FROM stealth_breakout_armed_setups
        WHERE symbol = ${input.symbol}
          AND level_source = ${levelSource}
          AND status IN ('armed', 'qualified', 'firing')
        FOR UPDATE
      `);
      row = (concurrent.rows as unknown as ArmedRow[])[0];
      if (!row) {
        return {
          status: "terminal_structure",
          reason: "already_consumed",
        } as const;
      }
      if (row.status !== "armed") {
        const retry = retryableQualifiedDecision(row, evaluatedAt);
        if (retry) {
          return {
            status: "qualified",
            armId: row.id,
            decision: retry,
            arm: rowToProvenance(row),
          } as const;
        }
        return {
          status: "in_flight",
          armId: row.id,
          arm: rowToProvenance(row),
        } as const;
      }
    }

    const decision = evaluateStealthArmedSetup({
      arm: rowToSnapshot(row),
      breakoutCandles4h: input.breakoutCandles4h,
      breakoutCandles1h: input.breakoutCandles1h,
      refinementCandles: input.refinementCandles,
      evaluatedAt,
      participationTelemetry: input.participationTelemetry,
      autoRangeBreakoutEvent: input.autoRangeBreakoutEvent,
      fastVolumePass: input.fastVolumePass,
      marketCapUsd: input.marketCapUsd,
    });
    if (decision.status === "armed") {
      const firstCrossAt =
        "firstCrossAt" in decision ? decision.firstCrossAt : null;
      const triggerTelemetry =
        firstCrossAt == null
          ? null
          : triggerParticipationTelemetry(
              input.participationTelemetry,
              firstCrossAt,
            );
      const decisionAudit = {
        ...buildStealthDecisionAudit({
          arm: rowToSnapshot(row),
          decision,
          evaluatedAt,
          participationTelemetry: input.participationTelemetry,
        }),
        technicalMode: input.technicalMode ?? rowToSnapshot(row).technicalMode,
        closed30mState: decision.closed30mState ?? null,
        triggerParticipationTelemetry: triggerTelemetry,
      };
      await tx.execute(sql`
        UPDATE stealth_breakout_armed_setups
        SET
          first_cross_at = CASE
            WHEN ${firstCrossAt}::double precision IS NULL THEN first_cross_at
            ELSE to_timestamp(${firstCrossAt}::double precision / 1000.0)
          END,
          terminal_reason = ${decision.reason},
          decision_at = to_timestamp(${evaluatedAt / 1000.0}),
          trigger_candle_at = CASE
            WHEN ${"confirmation" in decision ? (decision.confirmation.triggerCandle?.time ?? null) : null}::double precision IS NULL
              THEN trigger_candle_at
            ELSE to_timestamp(${("confirmation" in decision ? decision.confirmation.triggerCandle?.time : null) ?? null}::double precision / 1000.0)
          END,
          decision_lag_ms = CASE
            WHEN ${firstCrossAt}::double precision IS NULL THEN NULL
            ELSE ${evaluatedAt}::bigint - ${firstCrossAt}::bigint
          END,
          decision_json = COALESCE(decision_json, '{}'::jsonb) ||
            ${JSON.stringify(decisionAudit)}::jsonb,
          updated_at = now()
        WHERE id = ${row.id}
          AND status = 'armed'
      `);
      return {
        status: "armed",
        armId: row.id,
        created: false,
        arm: rowToProvenance(row),
        waitingReason: decision.reason,
      } as const;
    }
    const firstCrossAt =
      "firstCrossAt" in decision ? decision.firstCrossAt : null;
    const triggerTelemetry =
      firstCrossAt === null
        ? null
        : triggerParticipationTelemetry(
            input.participationTelemetry,
            firstCrossAt,
          );
    const baseDecisionAudit = buildStealthDecisionAudit({
      arm: rowToSnapshot(row),
      decision,
      evaluatedAt,
      participationTelemetry: input.participationTelemetry,
    });
    const decisionAudit =
      firstCrossAt === null
        ? baseDecisionAudit
        : {
            ...baseDecisionAudit,
            triggerParticipationTelemetry: triggerTelemetry,
          };
    if (levelSource === "continuation_shelf") {
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${row.id}:${decision.status}:${decision.reason}:${evaluatedAt}`},
          ${row.id},
          ${input.symbol},
          'decision',
          to_timestamp(${evaluatedAt / 1000.0}),
          ${JSON.stringify(decisionAudit)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
    await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = ${decision.status},
        terminal_reason = ${decision.reason},
        first_cross_at = CASE
          WHEN ${firstCrossAt}::double precision IS NULL THEN first_cross_at
          ELSE to_timestamp(${firstCrossAt}::double precision / 1000.0)
        END,
        trigger_candle_at = CASE
          WHEN ${firstCrossAt}::double precision IS NULL THEN trigger_candle_at
          ELSE to_timestamp(${firstCrossAt}::double precision / 1000.0)
        END,
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_lag_ms = CASE
          WHEN ${firstCrossAt}::double precision IS NULL THEN NULL
          ELSE ${evaluatedAt}::bigint - ${firstCrossAt}::bigint
        END,
             decision_json = CASE
           WHEN ${firstCrossAt}::double precision IS NULL THEN
             COALESCE(decision_json, '{}'::jsonb) ||
              ${JSON.stringify({
                ...decisionAudit,
                closed30mState: decision.closed30mState,
              })}::jsonb
           ELSE jsonb_set(
             COALESCE(decision_json, '{}'::jsonb) ||
              ${JSON.stringify({
                ...decisionAudit,
                closed30mState: decision.closed30mState,
              })}::jsonb,
             '{triggerParticipationTelemetry}',
             COALESCE(
               decision_json->'triggerParticipationTelemetry',
               ${JSON.stringify(triggerTelemetry)}::jsonb
             ),
             true
           )
             END,
        updated_at = now()
      WHERE id = ${row.id} AND status = 'armed'
    `);
    return {
      status: decision.status,
      armId: row.id,
      decision,
      arm: rowToProvenance(row),
    } as const;
  });
}

/** Evaluates the arm and starts tracing its CoinGlass requests once qualified (mid-cycle too). */
export async function evaluateDurableStealthArm(
  input: Parameters<typeof evaluateDurableStealthArmInner>[0],
): ReturnType<typeof evaluateDurableStealthArmInner> {
  const result = await evaluateDurableStealthArmInner(input);
  if (result.status === "qualified") addTracedArmSymbol(input.symbol);
  return result;
}

export async function markStealthArmFired(
  armId: number,
  firedPrice?: number | null,
  firedSignalId?: number | null,
  deduplicatedArmIds: readonly number[] = [],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'fired',
        fired_at = now(),
        fired_signal_id = ${firedSignalId ?? null},
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) || jsonb_build_object(
          'status', 'fired',
          'reason', 'signal_persisted',
          'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
          'firedAt', now(),
          'firedPrice', ${firedPrice ?? null}::double precision,
          'fireLagMs',
            CASE
              WHEN first_cross_at IS NULL THEN NULL
              ELSE (EXTRACT(EPOCH FROM (now() - first_cross_at)) * 1000)::bigint
            END
        ),
        updated_at = now()
      WHERE id = ${armId} AND status = 'firing'
      RETURNING id, symbol, level_source, decision_json
    `);
    const row = result.rows[0] as
      | {
          id: number;
          symbol: string;
          level_source: string;
          decision_json: unknown;
        }
      | undefined;
    if (row?.level_source === "continuation_shelf") {
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${row.id}:fired`}, ${row.id}, ${row.symbol}, 'decision', now(),
          ${JSON.stringify(row.decision_json)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
    if (row) {
      const reason = `deduplicated_by_${row.level_source}`;
      for (const deduplicatedArmId of new Set(deduplicatedArmIds)) {
        if (deduplicatedArmId === armId) continue;
        const consumed = await tx.execute(sql`
          UPDATE stealth_breakout_armed_setups
          SET
            status = 'invalidated',
            terminal_reason = ${reason},
            fire_claimed_at = NULL,
            decision_at = now(),
            decision_json = COALESCE(decision_json, '{}'::jsonb) ||
              jsonb_build_object(
                'status', 'invalidated',
                'reason', ${reason}::text,
                'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
              ),
            updated_at = now()
          WHERE id = ${deduplicatedArmId}
            AND symbol = ${row.symbol}
            AND status IN ('qualified', 'firing')
          RETURNING id, symbol, level_source, decision_json
        `);
        const losingArm = consumed.rows[0] as
          | {
              id: number;
              symbol: string;
              level_source: string;
              decision_json: unknown;
            }
          | undefined;
        if (losingArm?.level_source === "continuation_shelf") {
          await tx.execute(sql`
            INSERT INTO stealth_continuation_shelf_events (
              event_key, arm_id, symbol, event_type, event_at, payload
            ) VALUES (
              ${`${losingArm.id}:consumed_after_winner_fired`},
              ${losingArm.id},
              ${losingArm.symbol},
              'decision',
              now(),
              ${JSON.stringify(losingArm.decision_json)}::jsonb
            )
            ON CONFLICT (event_key) DO NOTHING
          `);
        }
      }
    }
    return row !== undefined;
  });
}

export async function claimStealthArmForFire(armId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'firing',
        fire_claimed_at = now(),
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'firing',
            'reason', 'signal_persistence_claimed',
            'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
          ),
        updated_at = now()
      WHERE id = ${armId} AND status = 'qualified'
      RETURNING id, symbol, level_source, decision_json
    `);
    const row = result.rows[0] as
      | {
          id: number;
          symbol: string;
          level_source: string;
          decision_json: unknown;
        }
      | undefined;
    if (row?.level_source === "continuation_shelf") {
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${row.id}:firing`}, ${row.id}, ${row.symbol}, 'decision', now(),
          ${JSON.stringify(row.decision_json)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
    return row !== undefined;
  });
}

/**
 * Remember the latest real reason a qualified arm was held, so the catch-all
 * terminal label ("qualified_unfired_retry_window_elapsed") no longer hides it.
 * Best effort and merge-only: never changes status or terminal_reason.
 */
export async function recordStealthQualifiedBlocker(
  armId: number,
  blocker: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE stealth_breakout_armed_setups
    SET decision_json = COALESCE(decision_json, '{}'::jsonb) ||
      jsonb_build_object(
        'lastBlocker', ${blocker}::text,
        'lastBlockerAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
      )
    WHERE id = ${armId} AND status IN ('qualified', 'firing')
  `);
}

/**
 * Owner 2026-10-18: a qualified arm older than the fire window (2h after its
 * trigger candle closed) is closed with its own terminal reason and the cut
 * breakout is copied to the shadow log for +24h outcome tracking.
 */
export const STALE_FIRE_WINDOW_REASON = "qualified_stale_fire_window_elapsed";

export async function closeStaleQualifiedStealthArms(
  evaluatedAt = Date.now(),
): Promise<number> {
  const cutoffTriggerOpen =
    evaluatedAt - STEALTH_FIRE_WINDOW_MS - 60 * 60 * 1000;
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'invalidated',
        terminal_reason = ${STALE_FIRE_WINDOW_REASON},
        fire_claimed_at = NULL,
        decision_at = to_timestamp(${evaluatedAt / 1000.0}),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', ${STALE_FIRE_WINDOW_REASON}::text,
            'fireWindowMs', ${STEALTH_FIRE_WINDOW_MS}::bigint,
            'evaluatedAt', ${evaluatedAt}::bigint
          ),
        updated_at = now()
      WHERE status = 'qualified'
        AND (decision_json #>> '{confirmation,triggerCandle,time}') ~ '^[0-9]+$'
        AND (decision_json #>> '{confirmation,triggerCandle,time}')::bigint
            < ${cutoffTriggerOpen}
      RETURNING id, symbol, level_source, breakout_level,
        (decision_json #>> '{confirmation,triggerCandle,time}')::bigint AS trigger_time
    `);
    for (const r of result.rows as Array<{
      id: number;
      symbol: string;
      level_source: string;
      breakout_level: number | string | null;
      trigger_time: string | number;
    }>) {
      await tx.execute(sql`
        INSERT INTO stealth_cutoff_shadow
          (arm_id, symbol, level_source, reason, trigger_time, level, details)
        VALUES (${r.id}, ${r.symbol}, ${r.level_source}, 'stale_fire_window',
                ${Number(r.trigger_time)},
                ${r.breakout_level === null ? null : Number(r.breakout_level)},
                ${JSON.stringify({ fireWindowMs: STEALTH_FIRE_WINDOW_MS })}::jsonb)
        ON CONFLICT (arm_id, reason) DO NOTHING
      `);
      // The status change is journaled by the database trigger.
    }
    return result.rows.length;
  });
}

export async function markStealthArmConsumed(
  armId: number,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET
        status = 'invalidated',
        terminal_reason = ${reason},
        fire_claimed_at = NULL,
        decision_at = now(),
        decision_json = COALESCE(decision_json, '{}'::jsonb) ||
          jsonb_build_object(
            'status', 'invalidated',
            'reason', ${reason}::text,
            'evaluatedAt', (EXTRACT(EPOCH FROM now()) * 1000)::bigint
          ),
        updated_at = now()
      WHERE id = ${armId} AND status IN ('qualified', 'firing')
      RETURNING id, symbol, level_source, decision_json
    `);
    const row = result.rows[0] as
      | {
          id: number;
          symbol: string;
          level_source: string;
          decision_json: unknown;
        }
      | undefined;
    if (row?.level_source === "continuation_shelf") {
      await tx.execute(sql`
        INSERT INTO stealth_continuation_shelf_events (
          event_key, arm_id, symbol, event_type, event_at, payload
        ) VALUES (
          ${`${row.id}:consumed:${reason}`},
          ${row.id},
          ${row.symbol},
          'decision',
          now(),
          ${JSON.stringify(row.decision_json)}::jsonb
        )
        ON CONFLICT (event_key) DO NOTHING
      `);
    }
  });
}

/**
 * Immutable decision-time flow snapshot for every qualified Stealth breakout
 * evaluation (fired or not), keyed once per arm and trigger candle. Lets later
 * calibration compare winners with rejected breakouts on identical metrics.
 */
export async function recordStealthDecisionMetrics(input: {
  armId: number;
  symbol: string;
  levelSource: string;
  triggerCandleAt: number | null;
  outcome: string;
  metrics: Record<string, unknown>;
}): Promise<void> {
  const eventKey = `${input.armId}:${input.triggerCandleAt ?? "none"}`;
  await db.execute(sql`
    INSERT INTO stealth_breakout_decision_metrics (
      event_key, arm_id, symbol, level_source, trigger_candle_at, outcome, metrics
    ) VALUES (
      ${eventKey}, ${input.armId}, ${input.symbol}, ${input.levelSource},
      ${input.triggerCandleAt === null ? null : sql`to_timestamp(${input.triggerCandleAt / 1000.0})`},
      ${input.outcome}, ${JSON.stringify(input.metrics)}::jsonb
    )
    ON CONFLICT (event_key) DO NOTHING
  `);
}

/** Symbols that currently hold a live secondary 1H Range arm. */
export async function listSecondaryOneHourArmSymbols(): Promise<Set<string>> {
  const result = await db.execute(sql`
    SELECT DISTINCT symbol
    FROM stealth_breakout_armed_setups
    WHERE level_source = 'auto_range_1h'
      AND decision_json ->> 'armSlot' = 'secondary'
      AND status IN ('armed', 'qualified', 'firing')
  `);
  return new Set(
    (result.rows as Array<{ symbol: string }>).map((r) => r.symbol),
  );
}
