import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getCached, setCached } from "../lib/routeCache.js";
import { TRACKED_SIGNALS_WITH_CORE_SQL } from "../lib/core-settlement-stats.js";
import { getLcWaitingShadowReport } from "../lib/lc-waiting-shadow.js";
import { getLcRepeatWatchReport } from "../lib/lc-repeat-watch.js";
import { getLcRapidReboundReport } from "../lib/lc-rapid-rebound.js";
import {
  ACTIVE_PATTERN_KEYS,
  DEAD_PATTERN_KEYS,
  PDB_HIDDEN_PATTERN_KEYS,
  PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
} from "../lib/dead-patterns.js";
import {
  db,
  trackedSignalsTable,
  prescanTrackerTable,
  patternDebugLogTable,
  signalsTable,
  prescanSnapshotsTable,
  dashboardUsersTable,
  tradeCalculatorSettingsTable,
  tradeCalculatorMonthlyTable,
  altBulletIndicatorSnapshotsTable,
  altBulletTakeProfitShadowTable,
  signalDrawdownExtremaTable,
  signalTrajectoryLogTable,
  reentryShadowEventsTable,
  indicatorTargetObservationExperimentsTable,
  indicatorTargetObservationsTable,
} from "@workspace/db";
import type { TrackedSignal } from "@workspace/db";
import {
  desc,
  asc,
  eq,
  ne,
  gte,
  lt,
  lte,
  gt,
  and,
  inArray,
  or,
  not,
  isNull,
  isNotNull,
  ilike,
  sql,
  getTableColumns,
} from "drizzle-orm";
import jwt from "jsonwebtoken";
import {
  runWatcherCycle,
  sendWeeklyDigest,
  sendDailyReport,
  sendMonthlyDigest,
  adminBroadcast,
  broadcastPhoto,
  broadcastPhotoAfterClaim,
  _writeExitMetrics,
  recordCloseSnapshot,
} from "../lib/watcher.js";
import { msgMilestone } from "../lib/watcher-formatters.js";
import {
  getLiveMarketData,
  lastPatternDebug,
  lastPatternDebugCycleNumber,
  computeTokenCoverage,
} from "../lib/scanner.js";
import { selectLatestPatternDebugCycles } from "../lib/pattern-debug-cycles.js";
import { getDubaiMonthStart } from "../lib/positionsReport.js";
import { getFutureTickers, getKlinesRange } from "../lib/bingx.js";
import { getFsVolume } from "../lib/coinglass_fs_volume.js";
import { batchFetchMarketCap } from "../lib/whale_watch_v2.js";
import { logger } from "../lib/logger.js";
import {
  getExitProfile,
  resolveBuStopProtection,
} from "../lib/watcher-config.js";
import {
  resolveActivatedTrailingStopLevel,
  resolveTrailingStopLevel,
} from "../lib/trailing-stop.js";
import {
  impulseRunnerPnlPercent,
  isImpulseRunnerCoreClosed,
  resolveImpulseRunnerEmergencyStopPrice,
} from "../lib/impulse-runner-policy.js";
import { backfillOiHistoryAfterCollisionCleanup } from "../lib/oiHistoryBackfill.js";
import { requireAdminToken } from "../middleware/adminAuth.js";
import {
  requireAuthenticatedDashboardAccess,
  requireDashboardOwner,
} from "../middleware/dashboardAccess.js";
import { getBitcoinDominanceSummary } from "../lib/coinglass_btc_dominance.js";
import { loadBtcDominanceObservations } from "../lib/btc-dominance-observations.js";
import { buildBtcDailyMarketContext } from "../lib/btc-daily-market-context.js";
import {
  getIndicatorTargetObservationWorkerHealth,
  INDICATOR_TARGET_OBSERVATION_VERSION,
} from "../lib/indicator-target-observations.js";
import {
  getBtcCrossAlerts,
  markBtcCrossAlertRead,
  reconcileBtcCrossAlerts,
} from "../lib/btc-cross-alerts.js";
import {
  GetBtcAnalysisResponse,
  GetBtcCrossAlertsResponse,
  GetLcRapidReboundResponse,
  GetAdminTrackerIndicatorTargetObservationsQueryParams,
  GetAdminTrackerIndicatorTargetObservationsResponse,
  MarkBtcCrossAlertReadParams,
  MarkBtcCrossAlertReadResponse,
} from "@workspace/api-zod";
import {
  buildBtcMarketHistory,
  getBtcDailyCandles,
} from "../lib/btc-market-history.js";
import { getCachedLiqDataEx } from "../lib/coinglass_liquidation.js";
import {
  calculateLivePnl,
  getOpenPositionLiveMetrics,
  liveMetricSource,
  resolveCurrentMetric,
} from "../lib/open-position-metrics.js";
import { createCancellationReplayHandler } from "./cancellation-replay.js";
import {
  analyzeBuStopThresholds,
  analyzeBuStopThresholdsByPattern,
} from "../lib/bu-stop-threshold-analysis.js";
import {
  CALCULATOR_CLOSED_STATUSES,
  CALCULATOR_MONTH_TIME_ZONE,
  calculateCalculatorSummary,
  getDubaiMonthKey,
} from "../lib/trade-calculator.js";
import type { CalculatorTradeRow } from "../lib/trade-calculator.js";
import {
  CLOSED_TRADE_OUTCOME_STATUSES,
  getEstimatedBuStopPnlPercent,
  getBuStopTakePct,
  normalizeClosedPnlPercent,
} from "../lib/raw-pnl.js";
import {
  aggregateIndicatorRelations,
  aggregateTargetAudit,
  ABNEON_RELATION_MAX_READY_SNAPSHOTS,
  classifyRelationProvenance,
  relationOutcomePnl,
  RELATION_METRIC_BUCKETS,
  type RelationMetric,
  type RelationTrade,
} from "../lib/abneon-indicator-relations.js";
import { aggregateAltBulletAnalysis } from "../lib/altbullet-analysis.js";
import { ALT_BULLET_INDICATOR_VERSION } from "../lib/altbullet-indicator.js";
import { ALT_BULLET_TP_EXPERIMENT_VERSION } from "../lib/altbullet-take-profit-shadow.js";
import {
  buildDrawdownRiskAnalysis,
  DRAWDOWN_OUTCOME_STATUSES,
} from "../lib/drawdown-analysis.js";
import {
  ALT_BULLET_MIN_CLOSED_SNAPSHOTS,
  getAltBulletAnalysisRecommendation,
} from "../lib/altbullet-indicator.js";
import {
  aggregateDailyProfitability,
  DAILY_STATS_INCLUDED_STATUSES,
  getDubaiCalendarDay,
  parseDailyStatsBasis,
} from "../lib/daily-profitability.js";
import { buildPlmCalibrationReport } from "../lib/plm-calibration.js";
import { buildBullishAccumulationCalibrationReport } from "../lib/bullish-accumulation-calibration.js";
import { buildProfitLockEvAnalysis } from "../lib/profit-lock-shadow.js";
import { IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT } from "../lib/impulse-buy-stats-cohort.js";
import { lcStatsExclusionSql } from "../lib/lc-stats-exclusions.js";
import {
  buildTrailingAnalysis,
  TRAILING_ANALYSIS_HORIZON_DAYS,
  TRAILING_ANALYSIS_SINCE,
  type TrailingAnalysisTrade,
} from "../lib/trailing-analysis.js";
import {
  buildBtcDailyPerformance,
  getBtcDailyPerformanceWindow,
  type BtcDailyPerformanceSourceRow,
} from "../lib/btc-daily-performance.js";
import { buildBtcEntryOutcomeContext } from "../lib/btc-outcome-context.js";

const router = Router();
const trailingAnalysisCache = new Map<
  string,
  { expiresAt: number; value: ReturnType<typeof buildTrailingAnalysis> }
>();
const trailingAnalysisInFlight = new Map<
  string,
  Promise<ReturnType<typeof buildTrailingAnalysis>>
>();
const TRAILING_ANALYSIS_CACHE_MS = 5 * 60_000;

const OPEN_STATUSES = ["active", "in_run"] as const;
const {
  stealthDetectionMethod: _stealthDetectionMethod,
  ...TRACKER_LIST_COMPATIBLE_COLUMNS
} = getTableColumns(trackedSignalsTable);
const ACTIVE_PATTERN_KEYS_SQL = sql.join(
  ACTIVE_PATTERN_KEYS.map((key) => sql`${key}`),
  sql`, `,
);
const OPEN_TRACKER_PATTERN_KEYS = [
  ...ACTIVE_PATTERN_KEYS,
  ...PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
];
type StealthLevelSource =
  | "auto_range_4h"
  | "auto_range_1h"
  | "stealth_legacy"
  | "continuation_shelf";

async function loadStealthEntryPaths(
  signalIds: Array<number | null | undefined>,
): Promise<Map<number, string>> {
  const ids = [...new Set(signalIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const result = await db.execute(sql`
    SELECT fired_signal_id, decision_json->>'entryPath' AS entry_path
      FROM stealth_breakout_armed_setups
     WHERE fired_signal_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND decision_json->>'entryPath' IN ('fast_volume', 'hold_30m')
  `);
  const paths = new Map<number, string>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.fired_signal_id === "number" &&
      typeof row.entry_path === "string"
    ) {
      paths.set(row.fired_signal_id, row.entry_path);
    }
  }
  return paths;
}

async function loadStealthLevelSources(
  signalIds: Array<number | null | undefined>,
): Promise<Map<number, StealthLevelSource>> {
  const ids = [...new Set(signalIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  // Batch by the durable fired_signal_id relationship. This avoids per-row
  // lookups and deliberately leaves legacy signals without a linked arm unknown.
  const result = await db.execute(sql`
    SELECT fired_signal_id, level_source
      FROM stealth_breakout_armed_setups
     WHERE fired_signal_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
        AND level_source IN ('auto_range_4h', 'auto_range_1h', 'stealth_legacy', 'continuation_shelf')
  `);
  const sources = new Map<number, StealthLevelSource>();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.fired_signal_id === "number" &&
      (row.level_source === "auto_range_4h" ||
        row.level_source === "auto_range_1h" ||
        row.level_source === "stealth_legacy" ||
        row.level_source === "continuation_shelf")
    ) {
      sources.set(row.fired_signal_id, row.level_source);
    }
  }
  return sources;
}

async function loadWhaleObTimeframes(
  signalIds: Array<number | null | undefined>,
): Promise<Map<number, "4h" | "1d">> {
  const ids = [...new Set(signalIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const result = await db.execute(sql`
    SELECT signal_id, decision_metrics #>> '{whaleWatchOb,timeframe}' AS tf
      FROM tracked_signals
     WHERE signal_id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )})
       AND decision_metrics #>> '{whaleWatchOb,timeframe}' IN ('4h', '1d')
  `);
  const out = new Map<number, "4h" | "1d">();
  for (const row of result.rows as Array<Record<string, unknown>>) {
    if (
      typeof row.signal_id === "number" &&
      (row.tf === "4h" || row.tf === "1d")
    ) {
      out.set(row.signal_id, row.tf);
    }
  }
  return out;
}

async function loadStealthRangeConfirmingVenues(
  signalIds: Array<number | null | undefined>,
): Promise<Map<number, string[]>> {
  const ids = [...new Set(signalIds.filter((id): id is number => id != null))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: signalsTable.id,
      venues: signalsTable.stealthRangeConfirmingVenues,
    })
    .from(signalsTable)
    .where(inArray(signalsTable.id, ids));
  const venuesBySignalId = new Map<number, string[]>();
  for (const row of rows) {
    if (row.venues) venuesBySignalId.set(row.id, row.venues);
  }
  return venuesBySignalId;
}
const ACTIVE_PATTERN_ORDER = new Map<string, number>(
  ACTIVE_PATTERN_KEYS.map((pattern, index) => [pattern, index]),
);
const BALANCED_GRIND_DASHBOARD_CLOSE_REASON =
  "balanced_grind_dashboard_neutral_close";
const balancedGrindNeutralCloseCondition = and(
  eq(trackedSignalsTable.sentimentKey, "balanced_grind"),
  eq(trackedSignalsTable.status, "reclassified"),
  eq(trackedSignalsTable.cancelReason, BALANCED_GRIND_DASHBOARD_CLOSE_REASON),
);
const stealthResistanceNeutralCloseCondition = and(
  eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
  eq(trackedSignalsTable.status, "reclassified"),
  eq(
    trackedSignalsTable.cancelReason,
    "stealth_resistance_dashboard_neutral_close",
  ),
);
const plmRetirementNeutralCloseCondition = and(
  eq(trackedSignalsTable.sentimentKey, "price_led_momentum"),
  eq(trackedSignalsTable.status, "reclassified"),
  eq(trackedSignalsTable.cancelReason, "plm_retirement_neutral_close"),
);
const neutralCloseCondition = or(
  balancedGrindNeutralCloseCondition,
  stealthResistanceNeutralCloseCondition,
  plmRetirementNeutralCloseCondition,
);
const ARCHIVE_PATTERN_KEYS_SQL = sql.join(
  [
    ...ACTIVE_PATTERN_KEYS,
    ...DEAD_PATTERN_KEYS,
    ...PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
  ].map((key) => sql`${key}`),
  sql`, `,
);
type ArchiveStatsRow = {
  sentimentKey: string;
  total: number;
  profit: number;
  breakeven: number;
  expired: number;
  buStop: number;
  stopLoss: number;
  cancelled: number;
  netPnlPercent: number;
  winRate: number | null;
  avgPnl: number | null;
  avgPeak: number | null;
  bestDeal: number | null;
  lastSignalAt: string | null;
  avgDurationMs: number | null;
};

function emptyArchiveStatsRow(sentimentKey: string): ArchiveStatsRow {
  return {
    sentimentKey,
    total: 0,
    profit: 0,
    breakeven: 0,
    expired: 0,
    buStop: 0,
    stopLoss: 0,
    cancelled: 0,
    netPnlPercent: 0,
    winRate: null,
    avgPnl: null,
    avgPeak: null,
    bestDeal: null,
    lastSignalAt: null,
    avgDurationMs: null,
  };
}

export function ensureActiveArchivePatternRows<
  T extends { sentimentKey: string },
>(rows: readonly T[]): Array<T | ArchiveStatsRow> {
  const byPattern = new Map<string, T | ArchiveStatsRow>();
  for (const row of rows) byPattern.set(row.sentimentKey, row);
  for (const pattern of ACTIVE_PATTERN_KEYS) {
    if (!byPattern.has(pattern)) {
      byPattern.set(pattern, emptyArchiveStatsRow(pattern));
    }
  }
  return [...byPattern.values()].sort(
    (left, right) =>
      (ACTIVE_PATTERN_ORDER.get(left.sentimentKey) ?? Number.MAX_SAFE_INTEGER) -
        (ACTIVE_PATTERN_ORDER.get(right.sentimentKey) ??
          Number.MAX_SAFE_INTEGER) ||
      left.sentimentKey.localeCompare(right.sentimentKey),
  );
}

const activeTrackedPatternCondition = () =>
  inArray(trackedSignalsTable.sentimentKey, ACTIVE_PATTERN_KEYS);
// Owner 2026-10-24: profitable trades of retired PLM count in closed-outcome
// totals; its other outcomes stay outside them.
const journalClosedPatternCondition = () =>
  or(
    activeTrackedPatternCondition(),
    and(
      eq(trackedSignalsTable.sentimentKey, "price_led_momentum"),
      eq(trackedSignalsTable.status, "profit"),
    ),
  );
const currentStatsCohortCondition = () => sql`
  NOT (
    ${trackedSignalsTable.sentimentKey} = 'impulse_buy'
    AND ${trackedSignalsTable.status} = 'stop_loss'
    AND (
      ${trackedSignalsTable.detectedAt} IS NULL
      OR ${trackedSignalsTable.detectedAt} < ${IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT}
    )
  )

  AND ${lcStatsExclusionSql(sql`${trackedSignalsTable.id}`, sql`${trackedSignalsTable.sentimentKey}`)}
`;
type BuStopMilestoneBucket = 5 | 8 | 10;
const NON_CANCELLED_PNL_STATUSES = ["profit", "stop_loss", "expired"] as const;

function normalizedTrackedPnlSql() {
  return sql<number>`
    CASE
      WHEN ${trackedSignalsTable.status} IN ('bu_stop', 'breakeven')
        THEN NULL
      ELSE ${trackedSignalsTable.pnlPercent}
    END
  `;
}

type IndicatorTargetObservationGroupInput = Record<string, unknown>;
type IndicatorTargetObservationRecentInput = Record<string, unknown>;

function observationNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function observationNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function observationDate(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

/** Shapes read-only target outcome aggregates for the tracker observation API. */
export function buildIndicatorTargetObservationsResponse(
  groups: readonly IndicatorTargetObservationGroupInput[],
  recent: readonly IndicatorTargetObservationRecentInput[],
  generatedAt = new Date(),
) {
  return {
    generatedAt: generatedAt.toISOString(),
    observationOnly: true,
    decisionUse: false,
    benchmarksPercent: [8, 12, 16],
    groups: groups.map((group) => ({
      pattern: String(group.pattern),
      targetPct: observationNumber(group.targetPct),
      total: observationNumber(group.total),
      awaitingHit: observationNumber(group.awaitingHit),
      hit: observationNumber(group.hit),
      noHitBeforeClose: observationNumber(group.noHitBeforeClose),
      unknown: observationNumber(group.unknown),
      followupNotStarted: observationNumber(group.followupNotStarted),
      followupPending: observationNumber(group.followupPending),
      followupDelayed: observationNumber(group.followupDelayed),
      followupRetry: observationNumber(group.followupRetry),
      followupComplete: observationNumber(group.followupComplete),
      followupPartial: observationNumber(group.followupPartial),
      followupUnavailable: observationNumber(group.followupUnavailable),
      followupNotApplicable: observationNumber(group.followupNotApplicable),
      completeOutcomeCount: observationNumber(group.completeOutcomeCount),
      completeAverageChangePct: observationNullableNumber(
        group.completeAverageChangePct,
      ),
      completePositiveAfter72: observationNumber(group.completePositiveAfter72),
      completeAverageMaxFavorablePct: observationNullableNumber(
        group.completeAverageMaxFavorablePct,
      ),
      completeAverageMinFavorablePct: observationNullableNumber(
        group.completeAverageMinFavorablePct,
      ),
      lowSample: observationNumber(group.completeOutcomeCount) < 20,
    })),
    recent: recent.map((row) => ({
      trackedSignalId: observationNumber(row.trackedSignalId),
      symbol: String(row.symbol),
      pattern: String(row.pattern),
      signalAt: observationDate(row.signalAt),
      targetPct: observationNumber(row.targetPct),
      indicatorProvenanceStatus: String(row.indicatorProvenanceStatus),
      status: String(row.status),
      hitAt: observationDate(row.hitAt),
      hitPrice: observationNullableNumber(row.hitPrice),
      hitSource: row.hitSource == null ? null : String(row.hitSource),
      tradeClosedAt: observationDate(row.tradeClosedAt),
      followupStatus: String(row.followupStatus),
      followupDeadline: observationDate(row.followupDeadline),
      priceAt72h: observationNullableNumber(row.priceAt72h),
      priceAt72hChangePct: observationNullableNumber(row.priceAt72hChangePct),
      maxFavorablePct: observationNullableNumber(row.maxFavorablePct),
      minFavorablePct: observationNullableNumber(row.minFavorablePct),
      followupSampleCount: observationNullableNumber(row.followupSampleCount),
      followupExpectedSampleCount: observationNullableNumber(
        row.followupExpectedSampleCount,
      ),
      priceAt72hObservedAt: observationDate(row.priceAt72hObservedAt),
    })),
    methodology:
      "Observation-only target hypotheses; no take-profit recommendation. A completed 72h outcome is included only when the follow-up status is complete, the exact endpoint is observed at its deadline, and all 288 expected closed 15m candles are present. Partial and unavailable follow-ups are never imputed or included in complete-outcome statistics. Durable DB progress and process-local worker health are reported separately.",
  };
}

type BuStopMilestoneCounts = Record<`after${BuStopMilestoneBucket}`, number>;

function buStopMilestoneBucketSql() {
  return sql<number>`
    CASE
      WHEN ${trackedSignalsTable.lastMilestone} IS NULL THEN NULL
      WHEN ${trackedSignalsTable.lastMilestone} >= 10 THEN 10
      WHEN ${trackedSignalsTable.lastMilestone} >= 8 THEN 8
      ELSE 5
    END
  `;
}

function toBuStopMilestoneCounts(
  rows: readonly { bucket: unknown; count: unknown }[],
): BuStopMilestoneCounts {
  const counts: BuStopMilestoneCounts = {
    after5: 0,
    after8: 0,
    after10: 0,
  };
  for (const row of rows) {
    if (row.bucket == null) continue;
    const bucket = Number(row.bucket) as BuStopMilestoneBucket;
    if (bucket === 5 || bucket === 8 || bucket === 10) {
      counts[`after${bucket}`] = Number(row.count ?? 0);
    }
  }
  return counts;
}

const SPOT_AUDIT_CANCEL_IMG = new URL("../assets/cancel.png", import.meta.url)
  .pathname;
const CALCULATOR_JWT_SECRET = process.env["SESSION_SECRET"];
const OWNER_ONLY_ARCHIVE_MONTHS = new Set(["2026-04", "2026-05", "2026-06"]);

function isOwnerDashboardRequest(req: {
  headers: { authorization?: string };
}): boolean {
  const header = req.headers.authorization;
  if (!CALCULATOR_JWT_SECRET || !header?.startsWith("Bearer ")) return false;
  try {
    const payload = jwt.verify(header.slice(7), CALCULATOR_JWT_SECRET) as {
      role?: string;
    };
    return payload.role === "owner";
  } catch {
    return false;
  }
}
const CALCULATOR_OWNER_EMAIL = (process.env["OWNER_EMAIL"] ?? "")
  .toLowerCase()
  .trim();

type CalculatorSettingsInput = {
  depositUsdt: number;
  leverage: number;
  allocationPercent: number;
  commissionPercent: number;
};

function getMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, (monthNumber ?? 1) - 1, 1)).toLocaleDateString(
    "ru-RU",
    {
      month: "long",
      year: "numeric",
      timeZone: CALCULATOR_MONTH_TIME_ZONE,
    },
  );
}

function getCalculatorMonth(): string {
  return getDubaiMonthKey(new Date());
}

function isValidCalculatorNumber(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

async function getCalculatorUserId(req: any, res: any): Promise<number | null> {
  const header = req.headers.authorization as string | undefined;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Необходима авторизация" });
    return null;
  }
  if (!CALCULATOR_JWT_SECRET) {
    res.status(503).json({ error: "Сервис авторизации не настроен" });
    return null;
  }

  try {
    const payload = jwt.verify(header.slice(7), CALCULATOR_JWT_SECRET) as {
      userId?: number;
      email?: string;
    };
    const userId = Number(payload.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      res.status(401).json({ error: "Недействительный токен" });
      return null;
    }

    const [user] = await db
      .select({
        id: dashboardUsersTable.id,
        email: dashboardUsersTable.email,
        status: dashboardUsersTable.status,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(
        and(
          eq(dashboardUsersTable.id, userId),
          payload.email
            ? eq(dashboardUsersTable.email, payload.email)
            : sql`true`,
        ),
      )
      .limit(1);

    if (!user || user.status !== "approved") {
      res.status(403).json({ error: "Доступ недоступен" });
      return null;
    }

    // Keep this endpoint aligned with the dashboard's access boundary. The
    // owner is allowed to use the calculator without an expiry date.
    if (
      user.subscribedUntil &&
      user.subscribedUntil.getTime() <= Date.now() &&
      user.email !== CALCULATOR_OWNER_EMAIL
    ) {
      res.status(403).json({ error: "Подписка истекла" });
      return null;
    }

    return user.id;
  } catch {
    res.status(401).json({ error: "Токен недействителен" });
    return null;
  }
}

// GET /api/tracker — list tracked signals
router.get("/tracker", async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = Math.min(
      parseInt((req.query.limit as string) ?? "100") || 100,
      200,
    );

    const where = and(
      status === "open"
        ? inArray(trackedSignalsTable.sentimentKey, OPEN_TRACKER_PATTERN_KEYS)
        : activeTrackedPatternCondition(),
      status === "open"
        ? inArray(trackedSignalsTable.status, [...OPEN_STATUSES])
        : status && status !== "all"
          ? eq(trackedSignalsTable.status, status as any)
          : undefined,
    );

    const signals = await db
      .select(TRACKER_LIST_COMPATIBLE_COLUMNS)
      .from(trackedSignalsTable)
      .where(where)
      .orderBy(desc(trackedSignalsTable.detectedAt))
      .limit(limit);
    const stealthSources = await loadStealthLevelSources(
      signals
        .filter((signal) => signal.sentimentKey === "stealth_breakout")
        .map((signal) => signal.signalId),
    );
    const stealthEntryPaths = await loadStealthEntryPaths(
      signals
        .filter((signal) => signal.sentimentKey === "stealth_breakout")
        .map((signal) => signal.signalId),
    );
    const stealthRangeVenues = await loadStealthRangeConfirmingVenues(
      signals
        .filter((signal) => signal.sentimentKey === "stealth_breakout")
        .map((signal) => signal.signalId),
    );
    const whaleObTimeframes = await loadWhaleObTimeframes(
      signals
        .filter((signal) => signal.sentimentKey === "whale_watch")
        .map((signal) => signal.signalId),
    );

    // For open positions fetch live prices from BingX to compute real-time PnL
    const priceMap = new Map<string, number>();
    const openSignals = signals.filter((s) =>
      OPEN_STATUSES.includes(s.status as any),
    );
    if (openSignals.length > 0) {
      try {
        const tickers = (await getFutureTickers()) as {
          symbol: string;
          lastPrice: string;
        }[];
        for (const t of tickers)
          priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);
      } catch {
        /* non-critical — show without live price */
      }
    }

    // The scanner is a useful low-cost fallback, but open positions own a
    // separate current-metrics refresh so tokens that leave prescan stay fresh.
    const liveMarket = getLiveMarketData(openSignals.map((s) => s.symbol));
    const livePositionMetrics = await getOpenPositionLiveMetrics(
      openSignals.map((s) => s.symbol),
      priceMap,
    );

    // ── Live liq data: O(1) cache populated by liq watcher every 3 min ─────────
    // Доступна для ВСЕХ паттернов, не только liq_cascade.
    const liqDataMap = new Map<
      string,
      {
        longLiq1h: number;
        shortLiq1h: number;
        longLiq24h: number;
        shortLiq24h: number;
      }
    >();
    for (const s of openSignals) {
      const liq = getCachedLiqDataEx(s.symbol);
      if (liq) liqDataMap.set(s.symbol, liq);
    }

    // ── DB prescan fallback: для символов без live-данных в памяти ───────────────
    // prescan_tracker DB содержит последние значения CVD/OI/WI которые пережили рестарт.
    // Покрывает токены выпавшие из prescan (позиция ещё открыта, но монета остыла).
    const symbolsWithoutLive = openSignals
      .filter((s) => !liveMarket[s.symbol])
      .map((s) => s.symbol);
    const prescanDbMap = new Map<
      string,
      {
        lastCvd15m: boolean | null;
        lastCvd30m: boolean | null;
        lastCvd1h: boolean | null;
        lastCvd4h: boolean | null;
        lastOi30m: number | null;
        lastOi1h: number | null;
        lastOi4h: number | null;
        lastWhaleIndex: number | null;
        lastNetBuyPct: number | null;
      }
    >();
    if (symbolsWithoutLive.length > 0) {
      try {
        const rows = await db
          .select({
            symbol: prescanTrackerTable.symbol,
            lastCvd15m: prescanTrackerTable.lastCvd15m,
            lastCvd30m: prescanTrackerTable.lastCvd30m,
            lastCvd1h: prescanTrackerTable.lastCvd1h,
            lastCvd4h: prescanTrackerTable.lastCvd4h,
            lastOi30m: prescanTrackerTable.lastOi30m,
            lastOi1h: prescanTrackerTable.lastOi1h,
            lastOi4h: prescanTrackerTable.lastOi4h,
            lastWhaleIndex: prescanTrackerTable.lastWhaleIndex,
            lastNetBuyPct: prescanTrackerTable.lastNetBuyPct,
          })
          .from(prescanTrackerTable)
          .where(inArray(prescanTrackerTable.symbol, symbolsWithoutLive));
        for (const r of rows) prescanDbMap.set(r.symbol, r);
      } catch {
        /* non-critical */
      }
    }

    res.json({
      signals: signals.map((s) => {
        const base = {
          ...s,
          stealthLevelSource:
            s.sentimentKey === "stealth_breakout" && s.signalId != null
              ? (stealthSources.get(s.signalId) ?? null)
              : null,
          stealthEntryPath:
            s.sentimentKey === "stealth_breakout" && s.signalId != null
              ? (stealthEntryPaths.get(s.signalId) ?? null)
              : null,
          whaleObTimeframe:
            s.sentimentKey === "whale_watch" && s.signalId != null
              ? (whaleObTimeframes.get(s.signalId) ?? null)
              : null,
          stealthRangeConfirmingVenues:
            s.sentimentKey === "stealth_breakout" && s.signalId != null
              ? (stealthRangeVenues.get(s.signalId) ?? null)
              : null,
          detectedAt: s.detectedAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          closedAt: s.closedAt?.toISOString() ?? null,
          buStopTakePct: getBuStopTakePct(s.status, s.lastMilestone),
          ...computeTokenCoverage(s.symbol),
        };
        if (OPEN_STATUSES.includes(s.status as any) && s.entryPrice != null) {
          const currentPrice = priceMap.get(s.symbol) ?? null;
          const entry = Number(s.entryPrice);
          const livePnl = calculateLivePnl(entry, currentPrice, !!s.isShort);
          const dbPeak = s.peakPrice != null ? Number(s.peakPrice) : null;
          const livePeak = currentPrice
            ? dbPeak && dbPeak > currentPrice
              ? dbPeak
              : currentPrice
            : dbPeak;
          const persistedPeakPnl =
            dbPeak && entry > 0 ? ((dbPeak - entry) / entry) * 100 : null;
          // Trailing stop: activated once peak PnL >= trailingActivation (per-pattern profile)
          const exitProfile = getExitProfile(s.sentimentKey, s.symbol);
          const trailingActive =
            persistedPeakPnl != null &&
            persistedPeakPnl >= exitProfile.trailingActivation &&
            dbPeak != null;
          const liveTrailingStop = trailingActive
            ? resolveActivatedTrailingStopLevel({
                peakPnlPercent: persistedPeakPnl,
                trailingActivationPercent: exitProfile.trailingActivation,
                entryPrice: entry,
                peakPrice: dbPeak,
                trailingGapPercent: exitProfile.trailingGap,
                persistedTrailingStopLevel: s.trailingStopLevel,
              })
            : null;
          const beProtection = resolveBuStopProtection({
            sentimentKey: s.sentimentKey,
            symbol: s.symbol,
            lastMilestone: s.lastMilestone,
            persistedPeakPnlPercent: persistedPeakPnl,
          });
          const beStopLevel = beProtection.earned
            ? entry * (1 + beProtection.protectedProfitPct / 100)
            : null;
          const displayedProtectedStop = trailingActive
            ? liveTrailingStop
            : beStopLevel;
          const runnerProtectedMode =
            s.runnerTrailingStopLevel != null
              ? "runner_trailing"
              : "runner_emergency";
          const isOpenRunner =
            isImpulseRunnerCoreClosed(s) && s.runnerState === "open";
          const live = liveMarket[s.symbol];
          const db3 = prescanDbMap.get(s.symbol);
          const positionLive = livePositionMetrics.get(s.symbol);
          const liqLive = liqDataMap.get(s.symbol);
          const oi30m = resolveCurrentMetric(
            positionLive?.oi30m,
            live?.oi30m,
            db3?.lastOi30m,
          );
          const oi1h = resolveCurrentMetric(
            positionLive?.oi1h,
            live?.oi1h,
            db3?.lastOi1h,
          );
          const oi4h = resolveCurrentMetric(
            positionLive?.oi4h,
            live?.oi4h,
            db3?.lastOi4h,
          );
          const cvd15m = resolveCurrentMetric(
            positionLive?.cvd15m,
            live?.cvd15m,
            db3?.lastCvd15m,
          );
          const cvd30m = resolveCurrentMetric(
            positionLive?.cvd30m,
            live?.cvd30m,
            db3?.lastCvd30m,
          );
          const cvd1h = resolveCurrentMetric(
            positionLive?.cvd1h,
            live?.cvd1h,
            db3?.lastCvd1h,
          );
          const cvd4h = resolveCurrentMetric(
            positionLive?.cvd4h,
            live?.cvd4h,
            db3?.lastCvd4h,
          );
          const futuresTaker = resolveCurrentMetric(
            positionLive?.futuresTakerNetBuy,
            live?.netBuyPct,
            db3?.lastNetBuyPct,
          );
          const spotTaker = resolveCurrentMetric(
            positionLive?.spotTakerNetBuy,
            live?.spotTakerNetBuy,
            null,
          );
          const metricSource = liveMetricSource(
            positionLive,
            Boolean(live),
            Boolean(db3),
          );
          const runnerLivePnl =
            currentPrice != null &&
            isImpulseRunnerCoreClosed(s) &&
            Number(s.originalEntryPrice) > 0
              ? impulseRunnerPnlPercent(
                  Number(s.originalEntryPrice),
                  currentPrice,
                )
              : null;
          return {
            ...base,
            // While only the 20% runner remains open, the primary live PnL
            // must describe that managed position. Keep the component estimate
            // available separately for informational views only.
            pnlPercent: isOpenRunner ? (runnerLivePnl ?? livePnl) : livePnl,
            runnerLivePnlPercent: runnerLivePnl,
            currentPrice,
            peakPrice: livePeak,
            stopLossPct:
              s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT"
                ? 1
                : base.stopLossPct,
            stopLossPrice:
              s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT"
                ? entry * 0.99
                : base.stopLossPrice,
            trailingStopLevel: isOpenRunner ? null : displayedProtectedStop,
            protectedStopMode: isOpenRunner
              ? runnerProtectedMode
              : trailingActive
                ? "trailing"
                : beProtection.earned
                  ? "be"
                  : null,
            runnerTrailingStopLevel: isOpenRunner
              ? s.runnerTrailingStopLevel
              : null,
            runnerEmergencyStopPrice: isOpenRunner
              ? resolveImpulseRunnerEmergencyStopPrice(
                  Number(s.originalEntryPrice),
                  s.stopLossPct,
                  s.entryPolicyVersion,
                )
              : null,
            beStopMilestone:
              !isOpenRunner && beProtection.earned
                ? beProtection.milestone
                : null,
            trailingActivationPct: isOpenRunner
              ? null
              : exitProfile.trailingActivation,
            trailingGapPct: isOpenRunner ? null : exitProfile.trailingGap,
            // Current metrics never use an entry snapshot as a fallback. The
            // entry* fields remain in base and are rendered only when labelled
            // as entry-time context.
            oi30m: oi30m.value,
            oi1h: oi1h.value,
            oi4h: oi4h.value,
            oi24h: positionLive?.oi24h ?? live?.oi24h ?? null,
            cvd15m: cvd15m.value,
            cvd30m: cvd30m.value,
            cvd1h: cvd1h.value,
            cvd4h: cvd4h.value,
            netBuyPct: futuresTaker.value,
            price1h: live?.price1h ?? null,
            price24h: live?.price24h ?? null,
            spotTakerNetBuy: spotTaker.value,
            spotTakerDominance:
              positionLive?.spotTakerDominance ??
              live?.spotTakerDominance ??
              null,
            whaleIndex:
              positionLive?.whaleIndex ??
              live?.whaleIndex ??
              db3?.lastWhaleIndex ??
              null,
            obRatio: positionLive?.obRatio ?? live?.obRatio ?? null,
            snf1h: positionLive?.snf1h ?? null,
            snf4h: positionLive?.snf4h ?? null,
            snf24h: positionLive?.snf24h ?? null,
            metricsSource: metricSource,
            metricsUpdatedAt: positionLive?.fetchedAt
              ? new Date(positionLive.fetchedAt).toISOString()
              : null,
            // Live liq data from CoinGlass batch (refreshed every 3 min, ALL patterns).
            // Long liq = forced long closures (exhaustion → bullish entry).
            // Short liq = short squeeze volume (directional momentum).
            liveLiqLong1h: liqLive?.longLiq1h ?? null,
            liveLiqShort1h: liqLive?.shortLiq1h ?? null,
            liveLiqLong24h: liqLive?.longLiq24h ?? null,
            liveLiqShort24h: liqLive?.shortLiq24h ?? null,
          };
        }
        return base;
      }),
      total: signals.length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch tracked signals");
    res.status(500).json({ error: "Failed to fetch tracked signals" });
  }
});

// GET /api/tracker/journal — full trading journal data
// Optional query param: ?from=YYYY-MM-DD
//   - Open signals (active/in_run): always counted without date filter
//   - Closed signals (profit/stop_loss/cancelled/breakeven): filtered by detected_at >= from
//     (detectedAt, NOT closedAt — prevents stale-cancel of old signals polluting current month)
const JOURNAL_CACHE_TTL_MS = 15_000;

// Journal runs ~7 aggregate queries over all closed signals and is polled by
// every open dashboard; a short shared cache keeps repeat loads instant.
function cacheJournalResponse(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = `tracker:journal:${String(req.query.from ?? "")}`;
  const hit = getCached<object>(key);
  if (hit) {
    res.json(hit);
    return;
  }
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode === 200) setCached(key, body, JOURNAL_CACHE_TTL_MS);
    return originalJson(body);
  };
  next();
}

router.get("/tracker/journal", cacheJournalResponse, async (req, res) => {
  try {
    const fromParam = req.query.from as string | undefined;
    const fromDate = fromParam ? new Date(fromParam) : null;
    // Filter closed signals by detectedAt (when the signal was found), NOT closedAt.
    // Using closedAt causes stale-cancel of old signals to pollute the current month's stats
    // (e.g. June signals stale-cancelled on July 1 appear as July cancellations).
    const closedFilter = fromDate
      ? gte(trackedSignalsTable.detectedAt, fromDate)
      : undefined;
    // 1a. Open signals — always count ALL open regardless of period filter
    const openStatusRows = await db
      .select({
        status: trackedSignalsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          inArray(trackedSignalsTable.status, ["active", "in_run"]),
          activeTrackedPatternCondition(),
        ),
      )
      .groupBy(trackedSignalsTable.status);

    const byOpen: Record<string, number> = {};
    for (const row of openStatusRows) {
      byOpen[row.status ?? "unknown"] = row.count;
    }
    const active =
      (byOpen["active"] ?? 0) +
      (byOpen["accumulation"] ?? 0) +
      (byOpen["in_run"] ?? 0) +
      (byOpen["re_entry"] ?? 0);

    // 1b. Closed signals — filter by closedAt >= from
    const closedStatusRows = await db
      .select({
        status: trackedSignalsTable.status,
        count: sql<number>`count(*)::int`,
        avgPnl: sql<number>`round(avg(${normalizedTrackedPnlSql()})::numeric, 2)`,
        pnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}), 0)`,
        positiveCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} > 0)::int`,
        negativeCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} < 0)::int`,
        breakevenCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} = 0)::int`,
        positivePnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}) filter (where ${normalizedTrackedPnlSql()} > 0), 0)`,
        negativePnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}) filter (where ${normalizedTrackedPnlSql()} < 0), 0)`,
      })
      .from(sql`${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals`)
      .where(
        and(
          inArray(trackedSignalsTable.status, [
            "profit",
            "stop_loss",
            "cancelled",
            "breakeven",
            "expired",
            "bu_stop",
          ]),
          journalClosedPatternCondition(),
          closedFilter,
          currentStatsCohortCondition(),
        ),
      )
      .groupBy(trackedSignalsTable.status);

    // bu_stop is split by the highest target reached before the protected exit.
    // Missing legacy milestones are conservatively classified as the first +5% level.
    const buStopMilestoneRows = await db
      .select({
        bucket: buStopMilestoneBucketSql(),
        count: sql<number>`count(*)::int`,
        estimatedPnlSum: sql<number>`COALESCE(SUM(
          CASE WHEN ${trackedSignalsTable.lastMilestone} >= 5
            THEN ${trackedSignalsTable.lastMilestone} * 0.2
            ELSE 0 END
        ), 0)::float8`,
        estimatedCount: sql<number>`COUNT(*) FILTER (
          WHERE ${trackedSignalsTable.lastMilestone} >= 5
        )::int`,
        unavailableCount: sql<number>`COUNT(*) FILTER (
          WHERE ${trackedSignalsTable.lastMilestone} IS NULL
             OR ${trackedSignalsTable.lastMilestone} < 5
        )::int`,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          eq(trackedSignalsTable.status, "bu_stop"),
          activeTrackedPatternCondition(),
          closedFilter,
        ),
      )
      .groupBy(buStopMilestoneBucketSql());
    const buStopMilestones = toBuStopMilestoneCounts(buStopMilestoneRows);
    const estimatedBuStopPnlPercent =
      Math.round(
        buStopMilestoneRows.reduce(
          (sum, row) => sum + Number(row.estimatedPnlSum ?? 0),
          0,
        ) * 100,
      ) / 100;
    const estimatedBuStopTrades = buStopMilestoneRows.reduce(
      (sum, row) => sum + Number(row.estimatedCount ?? 0),
      0,
    );
    const unavailableBuStopEstimateTrades = buStopMilestoneRows.reduce(
      (sum, row) => sum + Number(row.unavailableCount ?? 0),
      0,
    );

    const byStatus: Record<
      string,
      {
        count: number;
        avgPnl: number | null;
        pnlSum: number;
        positiveCount: number;
        negativeCount: number;
        breakevenCount: number;
        positivePnlSum: number;
        negativePnlSum: number;
      }
    > = {};
    for (const row of closedStatusRows) {
      byStatus[row.status ?? "unknown"] = {
        count: row.count,
        avgPnl: row.avgPnl != null ? Number(row.avgPnl) : null,
        pnlSum: Number(row.pnlSum ?? 0),
        positiveCount: Number(row.positiveCount ?? 0),
        negativeCount: Number(row.negativeCount ?? 0),
        breakevenCount: Number(row.breakevenCount ?? 0),
        positivePnlSum: Number(row.positivePnlSum ?? 0),
        negativePnlSum: Number(row.negativePnlSum ?? 0),
      };
    }

    const profit = byStatus["profit"]?.count ?? 0;
    const stopLoss = byStatus["stop_loss"]?.count ?? 0;
    const cancelled = byStatus["cancelled"]?.count ?? 0;
    const breakeven = byStatus["breakeven"]?.count ?? 0;
    const expired = byStatus["expired"]?.count ?? 0;
    const buStop = byStatus["bu_stop"]?.count ?? 0;
    const total =
      active + profit + stopLoss + cancelled + breakeven + expired + buStop;
    const rawPnlStatuses = [
      "profit",
      "stop_loss",
      "expired",
      "cancelled",
    ] as const;
    const nonCancelledPositiveCount = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (byStatus[status]?.positiveCount ?? 0),
      0,
    );
    const nonCancelledNegativeCount = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (byStatus[status]?.negativeCount ?? 0),
      0,
    );
    const nonCancelledPositivePnlSum = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (byStatus[status]?.positivePnlSum ?? 0),
      0,
    );
    const nonCancelledNegativePnlSum = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (byStatus[status]?.negativePnlSum ?? 0),
      0,
    );
    const winRateWins = profit + buStop;
    const winRateDenominator = winRateWins + stopLoss;
    const winRate =
      winRateDenominator > 0
        ? Math.round((winRateWins / winRateDenominator) * 100)
        : null;
    const avgProfit =
      nonCancelledPositiveCount > 0
        ? nonCancelledPositivePnlSum / nonCancelledPositiveCount
        : null;
    const avgLoss =
      nonCancelledNegativeCount > 0
        ? nonCancelledNegativePnlSum / nonCancelledNegativeCount
        : null;
    const breakevenAvgPnl = byStatus["breakeven"]?.avgPnl ?? null;
    const netPnlPercent =
      Math.round(
        rawPnlStatuses.reduce(
          (sum, status) => sum + (byStatus[status]?.pnlSum ?? 0),
          0,
        ) * 100,
      ) / 100;

    // 2. Best / worst trade — filter by closedAt >= from
    const bestRows = await db
      .select({
        symbol: trackedSignalsTable.symbol,
        pnl: trackedSignalsTable.pnlPercent,
        sentimentKey: trackedSignalsTable.sentimentKey,
      })
      .from(sql`${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals`)
      .where(
        and(
          eq(trackedSignalsTable.status, "profit"),
          journalClosedPatternCondition(),
          closedFilter,
        ),
      )
      .orderBy(desc(trackedSignalsTable.pnlPercent))
      .limit(1);

    const worstRows = await db
      .select({
        symbol: trackedSignalsTable.symbol,
        pnl: trackedSignalsTable.pnlPercent,
        sentimentKey: trackedSignalsTable.sentimentKey,
      })
      .from(sql`${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals`)
      .where(
        and(
          eq(trackedSignalsTable.status, "stop_loss"),
          activeTrackedPatternCondition(),
          closedFilter,
          currentStatsCohortCondition(),
        ),
      )
      .orderBy(trackedSignalsTable.pnlPercent)
      .limit(1);

    // 3. Per-pattern breakdown — closed signals only, filtered by closedAt >= from
    const patternRows = await db
      .select({
        sentimentKey: trackedSignalsTable.sentimentKey,
        status: trackedSignalsTable.status,
        count: sql<number>`count(*)::int`,
        sumPnl: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}), 0)`,
        avgPnl: sql<number>`round(avg(${normalizedTrackedPnlSql()})::numeric, 2)`,
        maxPnl: sql<number>`round(max(${normalizedTrackedPnlSql()})::numeric, 2)`,
        avgPeak: sql<number>`round(avg((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / nullif(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)::numeric, 2)`,
        lastSignalAt: sql<string>`max(detected_at)`,
      })
      .from(sql`${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals`)
      .where(
        and(
          inArray(trackedSignalsTable.status, [
            "profit",
            "stop_loss",
            "cancelled",
            "breakeven",
            "expired",
            "bu_stop",
          ]),
          journalClosedPatternCondition(),
          closedFilter,
          currentStatsCohortCondition(),
        ),
      )
      .groupBy(trackedSignalsTable.sentimentKey, trackedSignalsTable.status);

    const patternMap = new Map<
      string,
      {
        profit: number;
        stopLoss: number;
        cancelled: number;
        breakeven: number;
        expired: number;
        buStop: number;
        netPnl: number;
        totalPnl: number;
        pnlCount: number;
        totalPeak: number;
        peakCount: number;
        bestDeal: number | null;
        lastSignalAt: string | null;
      }
    >();
    for (const row of patternRows) {
      const key = row.sentimentKey ?? "unknown";
      if (!patternMap.has(key))
        patternMap.set(key, {
          profit: 0,
          stopLoss: 0,
          cancelled: 0,
          breakeven: 0,
          expired: 0,
          buStop: 0,
          netPnl: 0,
          totalPnl: 0,
          pnlCount: 0,
          totalPeak: 0,
          peakCount: 0,
          bestDeal: null,
          lastSignalAt: null,
        });
      const p = patternMap.get(key)!;
      if (row.status === "profit") p.profit += row.count;
      else if (row.status === "stop_loss") p.stopLoss += row.count;
      else if (row.status === "cancelled") p.cancelled += row.count;
      else if (row.status === "breakeven") p.breakeven += row.count;
      else if (row.status === "expired") p.expired += row.count;
      else if (row.status === "bu_stop") p.buStop += row.count;
      p.netPnl += Number(row.sumPnl ?? 0);
      if (row.status === "profit" && row.avgPnl != null) {
        p.totalPnl += Number(row.avgPnl) * row.count;
        p.pnlCount += row.count;
      }
      if (row.status === "profit" && row.maxPnl != null) {
        const mx = Number(row.maxPnl);
        if (p.bestDeal == null || mx > p.bestDeal) p.bestDeal = mx;
      }
      // avgPeak: exclude cancelled — their peak is unrealized and skews the average
      if (row.avgPeak != null && row.status !== "cancelled") {
        p.totalPeak += Number(row.avgPeak) * row.count;
        p.peakCount += row.count;
      }
      if (
        row.lastSignalAt != null &&
        (p.lastSignalAt == null || row.lastSignalAt > p.lastSignalAt)
      ) {
        p.lastSignalAt = row.lastSignalAt as string;
      }
    }

    const byPattern = Array.from(patternMap.entries())
      .map(([key, p]) => {
        const patTotal =
          p.profit +
          p.stopLoss +
          p.cancelled +
          p.breakeven +
          p.expired +
          p.buStop;
        const patWrDenom = p.profit + p.buStop + p.stopLoss;
        return {
          sentimentKey: key,
          total: patTotal,
          profit: p.profit,
          breakeven: p.breakeven,
          expired: p.expired,
          stopLoss: p.stopLoss,
          cancelled: p.cancelled,
          buStop: p.buStop,
          netPnlPercent: Math.round(p.netPnl * 10) / 10,
          winRate:
            patWrDenom > 0
              ? Math.round(((p.profit + p.buStop) / patWrDenom) * 100)
              : null,
          avgPnl:
            p.pnlCount > 0
              ? Math.round((p.totalPnl / p.pnlCount) * 10) / 10
              : null,
          avgPeak:
            p.peakCount > 0
              ? Math.round((p.totalPeak / p.peakCount) * 10) / 10
              : null,
          bestDeal:
            p.bestDeal != null ? Math.round(p.bestDeal * 10) / 10 : null,
          lastSignalAt: p.lastSignalAt,
        };
      })
      .sort(
        (a, b) =>
          (ACTIVE_PATTERN_ORDER.get(a.sentimentKey) ??
            Number.MAX_SAFE_INTEGER) -
            (ACTIVE_PATTERN_ORDER.get(b.sentimentKey) ??
              Number.MAX_SAFE_INTEGER) || b.total - a.total,
      );

    // 4. Per-token breakdown — closed signals only, filtered by closedAt >= from
    const tokenRows = await db.execute(
      fromDate
        ? sql`
          SELECT
            symbol,
            COUNT(*)::int                                                                         AS total,
            COUNT(*) FILTER (WHERE status = 'profit')::int                                       AS profit,
            COUNT(*) FILTER (WHERE status = 'stop_loss')::int                                    AS stop_loss,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int                                    AS cancelled,
            COUNT(*) FILTER (WHERE status = 'breakeven')::int                                    AS breakeven,
            COUNT(*) FILTER (WHERE status = 'expired')::int                                      AS expired,
            COUNT(*) FILTER (WHERE status = 'bu_stop')::int                                      AS bu_stop,
            ROUND(AVG(CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END)::numeric, 2)
                                                                                                  AS avg_pnl,
            ROUND(MAX(pnl_percent) FILTER (WHERE status = 'profit')::numeric, 2)                AS best_pnl,
            ROUND(AVG((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / NULLIF(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)::numeric, 2)   AS avg_peak,
            MODE() WITHIN GROUP (ORDER BY sentiment_key)                                         AS main_pattern,
            MAX(detected_at)                                                                      AS last_signal_at
          FROM ${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals
          WHERE status IN ('profit', 'stop_loss', 'cancelled', 'breakeven', 'expired', 'bu_stop')
            AND closed_at >= ${fromDate}
            AND sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          GROUP BY symbol
          ORDER BY total DESC
        `
        : sql`
          SELECT
            symbol,
            COUNT(*)::int                                                                         AS total,
            COUNT(*) FILTER (WHERE status = 'profit')::int                                       AS profit,
            COUNT(*) FILTER (WHERE status = 'stop_loss')::int                                    AS stop_loss,
            COUNT(*) FILTER (WHERE status = 'cancelled')::int                                    AS cancelled,
            COUNT(*) FILTER (WHERE status = 'breakeven')::int                                    AS breakeven,
            COUNT(*) FILTER (WHERE status = 'expired')::int                                      AS expired,
            COUNT(*) FILTER (WHERE status = 'bu_stop')::int                                      AS bu_stop,
            ROUND(AVG(CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END)::numeric, 2)
                                                                                                  AS avg_pnl,
            ROUND(MAX(pnl_percent) FILTER (WHERE status = 'profit')::numeric, 2)                AS best_pnl,
            ROUND(AVG((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / NULLIF(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)::numeric, 2)   AS avg_peak,
            MODE() WITHIN GROUP (ORDER BY sentiment_key)                                         AS main_pattern,
            MAX(detected_at)                                                                      AS last_signal_at
          FROM ${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals
          WHERE status IN ('profit', 'stop_loss', 'cancelled', 'breakeven', 'expired', 'bu_stop')
            AND sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          GROUP BY symbol
          ORDER BY total DESC
        `,
    );

    const byToken = (tokenRows.rows as Record<string, unknown>[]).map((r) => {
      const tok_profit = Number(r.profit) || 0;
      const tok_stop = Number(r.stop_loss) || 0;
      const tok_buStop = Number(r.bu_stop) || 0;
      const tok_wrDenom = tok_profit + tok_buStop + tok_stop;
      return {
        symbol: r.symbol as string,
        total: Number(r.total),
        profit: tok_profit,
        stopLoss: tok_stop,
        cancelled: Number(r.cancelled) || 0,
        breakeven: Number(r.breakeven) || 0,
        expired: Number(r.expired) || 0,
        buStop: tok_buStop,
        winRate:
          tok_wrDenom > 0
            ? Math.round(((tok_profit + tok_buStop) / tok_wrDenom) * 100)
            : null,
        avgPnl: r.avg_pnl != null ? Number(r.avg_pnl) : null,
        bestPnl: r.best_pnl != null ? Number(r.best_pnl) : null,
        avgPeak: r.avg_peak != null ? Number(r.avg_peak) : null,
        mainPattern: (r.main_pattern as string) ?? null,
        lastSignalAt:
          r.last_signal_at != null ? String(r.last_signal_at) : null,
      };
    });

    // 5. Recent closed trades (last 50) with entry conditions
    const tradeRows = await db.execute(
      fromDate
        ? sql`
          SELECT
            ts.id, ts.symbol, ts.status, ts.sentiment_key,
            ts.entry_price, ts.exit_price, ts.last_milestone,
        ROUND((CASE WHEN ts.status IN ('bu_stop', 'breakeven') THEN NULL ELSE ts.pnl_percent END)::numeric, 2)
                                                                                         AS pnl_percent,
            ROUND(((ts.peak_price - CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END)/NULLIF(CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END,0)*100)::numeric, 2) AS peak_pct,
            ts.detected_at, ts.closed_at,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(ts.closed_at, NOW()) - ts.detected_at))/3600, 1) AS hours_held,
            s.oi_change_percent,
            s.cumulative_oi_change,
            ROUND((s.volume_24h / NULLIF(s.avg_volume, 0))::numeric, 1) AS vol_mult,
            s.alpha_score,
            s.price_change_percent AS px_24h
          FROM tracked_signals ts
          LEFT JOIN signals s ON ts.signal_id = s.id
            WHERE ts.status IN ('profit', 'stop_loss', 'cancelled', 'breakeven', 'expired', 'bu_stop')
            AND ts.closed_at >= ${fromDate}
            AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          ORDER BY ts.closed_at DESC
          LIMIT 50
        `
        : sql`
          SELECT
            ts.id, ts.symbol, ts.status, ts.sentiment_key,
            ts.entry_price, ts.exit_price, ts.last_milestone,
        ROUND((CASE WHEN ts.status IN ('bu_stop', 'breakeven') THEN NULL ELSE ts.pnl_percent END)::numeric, 2)
                                                                                         AS pnl_percent,
            ROUND(((ts.peak_price - CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END)/NULLIF(CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END,0)*100)::numeric, 2) AS peak_pct,
            ts.detected_at, ts.closed_at,
            ROUND(EXTRACT(EPOCH FROM (COALESCE(ts.closed_at, NOW()) - ts.detected_at))/3600, 1) AS hours_held,
            s.oi_change_percent,
            s.cumulative_oi_change,
            ROUND((s.volume_24h / NULLIF(s.avg_volume, 0))::numeric, 1) AS vol_mult,
            s.alpha_score,
            s.price_change_percent AS px_24h
          FROM tracked_signals ts
          LEFT JOIN signals s ON ts.signal_id = s.id
            WHERE ts.status IN ('profit', 'stop_loss', 'cancelled', 'breakeven', 'expired', 'bu_stop')
            AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          ORDER BY ts.closed_at DESC NULLS LAST
          LIMIT 50
        `,
    );

    const trades = (tradeRows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      symbol: r.symbol,
      status: r.status,
      sentimentKey: r.sentiment_key,
      entryPrice: r.entry_price != null ? Number(r.entry_price) : null,
      exitPrice: r.exit_price != null ? Number(r.exit_price) : null,
      pnlPercent: normalizeClosedPnlPercent(
        r.status as string | null,
        r.pnl_percent != null ? Number(r.pnl_percent) : null,
      ),
      buStopTakePct: getBuStopTakePct(
        r.status as string | null,
        r.last_milestone as number | string | null | undefined,
      ),
      estimatedBuStopPnlPercent: getEstimatedBuStopPnlPercent(
        r.status as string | null,
        r.last_milestone as number | string | null | undefined,
      ),
      peakPct: r.peak_pct != null ? Number(r.peak_pct) : null,
      detectedAt: r.detected_at,
      closedAt: r.closed_at ?? null,
      hoursHeld: r.hours_held != null ? Number(r.hours_held) : null,
      oiChangePct:
        r.oi_change_percent != null ? Number(r.oi_change_percent) : null,
      cumulativeOi:
        r.cumulative_oi_change != null ? Number(r.cumulative_oi_change) : null,
      volMult: r.vol_mult != null ? Number(r.vol_mult) : null,
      alphaScore: r.alpha_score != null ? Number(r.alpha_score) : null,
      px24h: r.px_24h != null ? Number(r.px_24h) : null,
    }));

    res.json({
      summary: {
        total,
        profit,
        stopLoss,
        cancelled,
        breakeven,
        expired,
        buStop,
        buStopAfter5: buStopMilestones.after5,
        buStopAfter8: buStopMilestones.after8,
        buStopAfter10: buStopMilestones.after10,
        active,
        winRate,
        avgProfit,
        avgLoss,
        breakevenAvgPnl,
        netPnlPercent,
        estimatedBuStopPnlPercent,
        pnlWithEstimatedBuStopPercent:
          Math.round((netPnlPercent + estimatedBuStopPnlPercent) * 100) / 100,
        estimatedBuStopTrades,
        unavailableBuStopEstimateTrades,
        pnlByStatus: {
          profit: Math.round((byStatus["profit"]?.pnlSum ?? 0) * 10) / 10,
          buStop: Math.round((byStatus["bu_stop"]?.pnlSum ?? 0) * 10) / 10,
          stopLoss: Math.round((byStatus["stop_loss"]?.pnlSum ?? 0) * 10) / 10,
          expired: Math.round((byStatus["expired"]?.pnlSum ?? 0) * 10) / 10,
          cancelled: Math.round((byStatus["cancelled"]?.pnlSum ?? 0) * 10) / 10,
        },
        bestTrade: bestRows[0]
          ? {
              symbol: bestRows[0].symbol,
              pnl: Number(bestRows[0].pnl),
              sentimentKey: bestRows[0].sentimentKey ?? null,
            }
          : null,
        worstTrade: worstRows[0]
          ? {
              symbol: worstRows[0].symbol,
              pnl: Number(worstRows[0].pnl),
              sentimentKey: worstRows[0].sentimentKey ?? null,
            }
          : null,
      },
      byPattern,
      byToken,
      trades,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch journal");
    res.status(500).json({ error: "Failed to fetch journal" });
  }
});

// GET /api/tracker/monthly-stats — closed outcomes grouped by Dubai close month
router.get("/tracker/monthly-stats", async (req, res) => {
  try {
    const canViewOwnerArchive = isOwnerDashboardRequest(req);
    const [rows, patternRows] = await Promise.all([
      db.execute(sql`
        SELECT
          TO_CHAR(closed_at + INTERVAL '4 hours', 'YYYY-MM') AS month,
          COUNT(*)::int                                                                     AS total,
          COUNT(*) FILTER (WHERE status = 'profit')::int                                   AS profit,
          COUNT(*) FILTER (WHERE status = 'stop_loss')::int                                AS stop_loss,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int                                AS cancelled,
          COUNT(*) FILTER (WHERE status = 'breakeven')::int                                AS breakeven,
          COUNT(*) FILTER (WHERE status = 'expired')::int                                  AS expired,
          COUNT(*) FILTER (WHERE status = 'bu_stop')::int                                  AS bu_stop,
           COUNT(*) FILTER (WHERE (CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END) > 0)::int
                                                                                           AS positive_count,
           COUNT(*) FILTER (WHERE (CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END) < 0)::int
                                                                                           AS negative_count,
           COUNT(*) FILTER (WHERE (CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END) = 0)::int
                                                                                           AS breakeven_count,
           COUNT(*) FILTER (
             WHERE status IN ('profit', 'stop_loss', 'expired')
                AND pnl_percent > 0
           )::int                                                                            AS win_positive_count,
           COUNT(*) FILTER (
             WHERE status IN ('profit', 'stop_loss', 'expired')
                AND pnl_percent < 0
           )::int                                                                            AS win_negative_count,
           COUNT(*) FILTER (
             WHERE status IN ('profit', 'stop_loss', 'expired')
                AND pnl_percent = 0
           )::int                                                                            AS win_breakeven_count,
          COALESCE(SUM(pnl_percent) FILTER (
              WHERE status IN ('profit', 'stop_loss', 'expired')
                AND pnl_percent > 0
          ), 0)                                                                            AS positive_pnl_sum,
          COALESCE(SUM(pnl_percent) FILTER (
              WHERE status IN ('profit', 'stop_loss', 'expired')
                AND pnl_percent < 0
          ), 0)                                                                            AS negative_pnl_sum,
           ROUND(AVG(pnl_percent) FILTER (
             WHERE status IN ('profit', 'stop_loss', 'expired')
               AND pnl_percent > 0
          )::numeric, 2)                                                                   AS avg_profit,
           ROUND(AVG(pnl_percent) FILTER (
             WHERE status IN ('profit', 'stop_loss', 'expired')
               AND pnl_percent < 0
          )::numeric, 2)                                                                   AS avg_loss,
           NULL::numeric                                                                       AS breakeven_avg_pnl,
          ROUND(
            COALESCE(
               SUM(pnl_percent) FILTER (
                 WHERE status IN ('profit', 'stop_loss', 'expired', 'cancelled')
              ),
              0
            )::numeric,
            2
          )                                                                                AS net_pnl_percent,
          ROUND(AVG((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / NULLIF(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)
                FILTER (WHERE status IN ('profit','stop_loss'))::numeric, 2)               AS avg_peak,
          MAX(pnl_percent) FILTER (WHERE status = 'profit')                                AS best_pnl,
          MIN(pnl_percent) FILTER (WHERE status = 'stop_loss')                             AS worst_pnl
        FROM ${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals
        WHERE status IN ('profit','stop_loss','cancelled','breakeven','expired','bu_stop')
          AND closed_at IS NOT NULL
          AND sentiment_key IN (${ARCHIVE_PATTERN_KEYS_SQL})
          AND NOT (
            sentiment_key = 'impulse_buy'
            AND status = 'stop_loss'
            AND (
              detected_at IS NULL
              OR detected_at < ${IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT}
            )
          )
          AND ${lcStatsExclusionSql(sql`id`, sql`sentiment_key`)}
        GROUP BY TO_CHAR(closed_at + INTERVAL '4 hours', 'YYYY-MM')
        ORDER BY month DESC
      `),
      db.execute(sql`
        SELECT
          TO_CHAR(closed_at + INTERVAL '4 hours', 'YYYY-MM') AS month,
          sentiment_key,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'profit')::int AS profit,
          COUNT(*) FILTER (WHERE status = 'breakeven')::int AS breakeven,
          COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
          COUNT(*) FILTER (WHERE status = 'stop_loss')::int AS stop_loss,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE status = 'bu_stop')::int AS bu_stop,
          ROUND(
            COALESCE(
               SUM(CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END),
              0
            )::numeric,
            2
          ) AS net_pnl_percent,
          ROUND(
             AVG(CASE WHEN status IN ('bu_stop', 'breakeven') THEN NULL ELSE pnl_percent END)::numeric,
            2
          ) AS avg_pnl,
          ROUND(
            AVG((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / NULLIF(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)
              FILTER (WHERE status <> 'cancelled')::numeric,
            2
          ) AS avg_peak,
          ROUND(MAX(pnl_percent) FILTER (WHERE status = 'profit')::numeric, 2)
            AS best_deal,
          MAX(closed_at) AS last_signal_at,
          ROUND(
            AVG(EXTRACT(EPOCH FROM (closed_at - detected_at)) * 1000)
              FILTER (
                WHERE status IN ('profit','stop_loss','breakeven','expired','bu_stop')
                  AND detected_at IS NOT NULL
                  AND closed_at >= detected_at
              )::numeric
          ) AS avg_duration_ms
        FROM ${TRACKED_SIGNALS_WITH_CORE_SQL} AS tracked_signals
        WHERE status IN ('profit','stop_loss','cancelled','breakeven','expired','bu_stop')
          AND closed_at IS NOT NULL
          AND sentiment_key IN (${ARCHIVE_PATTERN_KEYS_SQL})
          AND NOT (
            sentiment_key = 'impulse_buy'
            AND status = 'stop_loss'
            AND (
              detected_at IS NULL
              OR detected_at < ${IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT}
            )
          )
          AND ${lcStatsExclusionSql(sql`id`, sql`sentiment_key`)}
        GROUP BY TO_CHAR(closed_at + INTERVAL '4 hours', 'YYYY-MM'), sentiment_key
        ORDER BY month DESC, total DESC, sentiment_key
      `),
    ]);

    const byPatternMonth = new Map<
      string,
      Array<{
        sentimentKey: string;
        total: number;
        profit: number;
        breakeven: number;
        expired: number;
        buStop: number;
        stopLoss: number;
        cancelled: number;
        netPnlPercent: number;
        winRate: number | null;
        avgPnl: number | null;
        avgPeak: number | null;
        bestDeal: number | null;
        lastSignalAt: string | null;
        avgDurationMs: number | null;
      }>
    >();
    for (const row of patternRows.rows as Record<string, unknown>[]) {
      const profit = Number(row.profit ?? 0);
      const breakeven = Number(row.breakeven ?? 0);
      const expired = Number(row.expired ?? 0);
      const buStop = Number(row.bu_stop ?? 0);
      const stopLoss = Number(row.stop_loss ?? 0);
      const winRateDenom = profit + buStop + stopLoss;
      const month = String(row.month);
      const pattern = {
        sentimentKey: String(row.sentiment_key),
        total: Number(row.total ?? 0),
        profit,
        breakeven,
        expired,
        buStop,
        stopLoss,
        cancelled: Number(row.cancelled ?? 0),
        netPnlPercent: Number(row.net_pnl_percent ?? 0),
        winRate:
          winRateDenom > 0
            ? Math.round(((profit + buStop) / winRateDenom) * 100)
            : null,
        avgPnl: row.avg_pnl != null ? Number(row.avg_pnl) : null,
        avgPeak: row.avg_peak != null ? Number(row.avg_peak) : null,
        bestDeal: row.best_deal != null ? Number(row.best_deal) : null,
        lastSignalAt:
          row.last_signal_at != null ? String(row.last_signal_at) : null,
        avgDurationMs:
          row.avg_duration_ms != null ? Number(row.avg_duration_ms) : null,
      };
      const monthPatterns = byPatternMonth.get(month) ?? [];
      monthPatterns.push(pattern);
      byPatternMonth.set(month, monthPatterns);
    }
    // Summary months are the source of truth for the archive period list. Keep
    // the pattern baseline present even if a mocked/legacy query result has no
    // per-pattern row for a month.
    for (const row of rows.rows as Record<string, unknown>[]) {
      const month = String(row.month);
      const monthPatterns = ensureActiveArchivePatternRows(
        byPatternMonth.get(month) ?? [],
      );
      byPatternMonth.set(month, monthPatterns);
    }

    const months = (rows.rows as Record<string, unknown>[])
      .filter(
        (r) =>
          canViewOwnerArchive ||
          !OWNER_ONLY_ARCHIVE_MONTHS.has(String(r.month)),
      )
      .map((r) => {
        const profit = Number(r.profit ?? 0);
        const stopLoss = Number(r.stop_loss ?? 0);
        const buStop = Number(r.bu_stop ?? 0);
        const winPositiveCount = Number(r.win_positive_count ?? 0);
        const winNegativeCount = Number(r.win_negative_count ?? 0);
        const winRateDenom = profit + buStop + stopLoss;
        const winRate =
          winRateDenom > 0
            ? Math.round(((profit + buStop) / winRateDenom) * 100)
            : null;

        const [year, mon] = String(r.month).split("-");
        const monthLabel = new Date(
          Number(year),
          Number(mon) - 1,
          1,
        ).toLocaleDateString("ru-RU", {
          month: "long",
          year: "numeric",
        });

        return {
          month: r.month as string,
          label: monthLabel,
          total: Number(r.total ?? 0),
          profit,
          stopLoss,
          cancelled: Number(r.cancelled ?? 0),
          breakeven: Number(r.breakeven ?? 0),
          expired: Number(r.expired ?? 0),
          buStop,
          winRate,
          avgProfit:
            winPositiveCount > 0
              ? Number(r.positive_pnl_sum ?? 0) / winPositiveCount
              : null,
          avgLoss:
            winNegativeCount > 0
              ? Number(r.negative_pnl_sum ?? 0) / winNegativeCount
              : null,
          breakevenAvgPnl:
            r.breakeven_avg_pnl != null ? Number(r.breakeven_avg_pnl) : null,
          netPnlPercent: Number(r.net_pnl_percent ?? 0),
          avgPeak: r.avg_peak != null ? Number(r.avg_peak) : null,
          bestPnl: r.best_pnl != null ? Number(r.best_pnl) : null,
          worstPnl: r.worst_pnl != null ? Number(r.worst_pnl) : null,
          byPattern: byPatternMonth.get(String(r.month)) ?? [],
        };
      });

    res.json({ months });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch monthly stats");
    res.status(500).json({ error: "Failed to fetch monthly stats" });
  }
});

// GET /api/tracker/daily-stats — stats grouped by Dubai entry or close day
router.get("/tracker/daily-stats", async (req, res) => {
  const rawBasis = Array.isArray(req.query.basis)
    ? req.query.basis[0]
    : req.query.basis;
  const basis = parseDailyStatsBasis(rawBasis);
  const includedStatusesSql = sql.join(
    DAILY_STATS_INCLUDED_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );

  try {
    const canViewOwnerArchive = isOwnerDashboardRequest(req);
    const rows = await db.execute(sql`
      SELECT
        ts.status,
        ts.sentiment_key,
        ts.pnl_percent,
        ts.entry_price,
        ts.policy_version,
        ts.original_entry_price,
        ts.peak_price,
        to_jsonb(ts)->>'entry_btc_24h' AS entry_btc_24h,
        to_jsonb(ts)->>'close_btc_24h' AS close_btc_24h,
        ts.detected_at,
        ts.closed_at
      FROM ${TRACKED_SIGNALS_WITH_CORE_SQL} AS ts
      WHERE ts.status IN (${includedStatusesSql})
        AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
        AND ${lcStatsExclusionSql(sql`ts.id`, sql`ts.sentiment_key`)}
        ${basis === "close" ? sql`AND ts.closed_at IS NOT NULL` : sql``}
      ORDER BY ${basis === "close" ? sql`ts.closed_at` : sql`ts.detected_at`} DESC
    `);

    const sourceRows = (rows.rows as Record<string, unknown>[])
      .map((row) => ({
        status: row.status as string | null,
        sentimentKey: row.sentiment_key as string | null,
        pnlPercent: row.pnl_percent as number | string | null,
        entryPrice: row.entry_price as number | string | null,
        peakPrice: row.peak_price as number | string | null,
        entryBtc24h: row.entry_btc_24h as number | string | null,
        closeBtc24h: row.close_btc_24h as number | string | null,
        detectedAt: row.detected_at as Date | string | null,
        closedAt: row.closed_at as Date | string | null,
      }))
      .filter((row) => {
        if (canViewOwnerArchive) return true;
        const detectedDay = getDubaiCalendarDay(row.detectedAt);
        return (
          detectedDay == null ||
          !OWNER_ONLY_ARCHIVE_MONTHS.has(detectedDay.slice(0, 7))
        );
      });

    res.json({
      basis,
      btcContext:
        basis === "entry"
          ? "BTC 24h в момент входа сделок этого дня"
          : "BTC 24h в момент закрытия сделок этого дня",
      days: aggregateDailyProfitability(sourceRows, basis),
    });
  } catch (err) {
    req.log.error({ err, basis }, "Failed to fetch daily stats");
    res.status(500).json({ error: "Failed to fetch daily stats" });
  }
});

// GET /api/tracker/btc-analysis — authenticated descriptive view of the BTC
// snapshots already recorded alongside tracked signals. It is deliberately
// observational: no output from this route is consumed by the scanner.
router.use("/tracker/btc-analysis", requireAuthenticatedDashboardAccess);
router.get("/tracker/btc-analysis", async (req, res) => {
  try {
    const generatedAt = new Date();
    const dailyPerformanceWindow = getBtcDailyPerformanceWindow(generatedAt);
    const [result, dominance, dailyPerformanceResult, priceCandles] =
      await Promise.all([
        db.execute(sql`
      SELECT
        ts.id,
        ts.symbol,
        ts.sentiment_key,
        ts.status,
        ts.pnl_percent,
        ts.entry_price,
        ts.peak_price,
        ts.detected_at,
        ts.closed_at,
        to_jsonb(ts)->>'entry_btc_24h' AS entry_btc_24h,
        to_jsonb(ts)->>'close_btc_24h' AS close_btc_24h,
        to_jsonb(ts)->>'entry_btc_dominance' AS entry_btc_dominance,
        to_jsonb(ts)->>'close_btc_dominance' AS close_btc_dominance,
        to_jsonb(ts)->>'entry_btc_dominance_observed_at' AS entry_btc_dominance_observed_at,
        to_jsonb(ts)->>'close_btc_dominance_observed_at' AS close_btc_dominance_observed_at
      FROM tracked_signals AS ts
      WHERE ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
        AND ts.symbol NOT IN ('BTC-USDT', 'BTCUSDT')
        AND ${lcStatsExclusionSql(sql`ts.id`, sql`ts.sentiment_key`)}
      ORDER BY ts.detected_at DESC NULLS LAST
    `),
        getBitcoinDominanceSummary(),
        db.execute(sql`
        SELECT
          ts.signal_id,
          ts.sentiment_key,
          ts.status,
          ts.detected_at,
          ts.closed_at,
          ts.pnl_percent,
          ts.exit_price,
          to_jsonb(ts)->>'entry_btc_24h' AS entry_btc_24h,
          to_jsonb(ts)->>'entry_btc_dominance' AS entry_btc_dominance
        FROM tracked_signals AS ts
        WHERE ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          AND ts.symbol NOT IN ('BTC-USDT', 'BTCUSDT')
        AND ${lcStatsExclusionSql(sql`ts.id`, sql`ts.sentiment_key`)}
          AND (
            (ts.detected_at >= ${dailyPerformanceWindow.start}
              AND ts.detected_at < ${dailyPerformanceWindow.end})
            OR
            (ts.closed_at >= ${dailyPerformanceWindow.start}
              AND ts.closed_at < ${dailyPerformanceWindow.end})
          )
        ORDER BY ts.detected_at ASC NULLS LAST, ts.closed_at ASC NULLS LAST
      `),
        getBtcDailyCandles(),
      ]);
    const dailyRows: BtcDailyPerformanceSourceRow[] = (
      dailyPerformanceResult.rows as Record<string, unknown>[]
    ).map((row) => ({
      signalId: row.signal_id == null ? null : Number(row.signal_id),
      sentimentKey:
        row.sentiment_key == null ? null : String(row.sentiment_key),
      status: row.status == null ? null : String(row.status),
      detectedAt:
        row.detected_at == null ? null : (row.detected_at as Date | string),
      closedAt: row.closed_at == null ? null : (row.closed_at as Date | string),
      pnlPercent:
        row.pnl_percent == null ? null : (row.pnl_percent as number | string),
      exitPrice:
        row.exit_price == null ? null : (row.exit_price as number | string),
      entryBtc24h: row.entry_btc_24h == null ? null : Number(row.entry_btc_24h),
      entryBtcDominance:
        row.entry_btc_dominance == null
          ? null
          : Number(row.entry_btc_dominance),
    }));
    const dailyPerformance = buildBtcDailyPerformance(dailyRows, generatedAt);
    const entryOutcomeContext = buildBtcEntryOutcomeContext(
      dailyRows,
      generatedAt,
    );
    // Read after the provider call, so the first successful observation is
    // visible immediately as well as after a subsequent provider outage.
    const storedDominance = await loadBtcDominanceObservations(generatedAt);

    type ContextRow = {
      id: number;
      symbol: string;
      sentimentKey: string | null;
      status: string;
      pnlPercent: number | null;
      peakPct: number | null;
      detectedAt: string | null;
      closedAt: string | null;
      entryBtc24h: number | null;
      closeBtc24h: number | null;
      entryBtcDominance: number | null;
      closeBtcDominance: number | null;
      entryBtcDominanceObservedAt: string | null;
      closeBtcDominanceObservedAt: string | null;
    };
    const rows: ContextRow[] = (result.rows as Record<string, unknown>[]).map(
      (row) => {
        const entryPrice = Number(row.entry_price);
        const accountingEntryPrice =
          row.policy_version === "impulse_runner_v1"
            ? Number(row.original_entry_price)
            : entryPrice;
        const peakPrice = Number(row.peak_price);
        const peakPct =
          Number.isFinite(accountingEntryPrice) &&
          accountingEntryPrice > 0 &&
          Number.isFinite(peakPrice)
            ? ((peakPrice - accountingEntryPrice) / accountingEntryPrice) * 100
            : null;
        return {
          id: Number(row.id),
          symbol: String(row.symbol ?? ""),
          sentimentKey:
            row.sentiment_key == null ? null : String(row.sentiment_key),
          status: String(row.status ?? ""),
          pnlPercent:
            row.pnl_percent == null || !Number.isFinite(Number(row.pnl_percent))
              ? null
              : Number(row.pnl_percent),
          peakPct,
          detectedAt:
            row.detected_at == null
              ? null
              : new Date(row.detected_at as string | Date).toISOString(),
          closedAt:
            row.closed_at == null
              ? null
              : new Date(row.closed_at as string | Date).toISOString(),
          entryBtc24h:
            row.entry_btc_24h == null ||
            !Number.isFinite(Number(row.entry_btc_24h))
              ? null
              : Number(row.entry_btc_24h),
          closeBtc24h:
            row.close_btc_24h == null ||
            !Number.isFinite(Number(row.close_btc_24h))
              ? null
              : Number(row.close_btc_24h),
          entryBtcDominance:
            row.entry_btc_dominance == null ||
            !Number.isFinite(Number(row.entry_btc_dominance))
              ? null
              : Number(row.entry_btc_dominance),
          closeBtcDominance:
            row.close_btc_dominance == null ||
            !Number.isFinite(Number(row.close_btc_dominance))
              ? null
              : Number(row.close_btc_dominance),
          entryBtcDominanceObservedAt:
            row.entry_btc_dominance_observed_at == null
              ? null
              : new Date(
                  String(row.entry_btc_dominance_observed_at),
                ).toISOString(),
          closeBtcDominanceObservedAt:
            row.close_btc_dominance_observed_at == null
              ? null
              : new Date(
                  String(row.close_btc_dominance_observed_at),
                ).toISOString(),
        };
      },
    );
    const altRows = rows;
    const isCompleted = (row: ContextRow) =>
      !OPEN_STATUSES.includes(row.status as (typeof OPEN_STATUSES)[number]);
    const entryRows = altRows.filter((row) => row.entryBtc24h !== null);
    const bucketDefinitions = [
      {
        key: "below_minus_3",
        label: "BTC ниже −3%",
        test: (value: number) => value < -3,
      },
      {
        key: "minus_3_to_minus_1",
        label: "BTC −3%…−1%",
        test: (value: number) => value >= -3 && value < -1,
      },
      {
        key: "minus_1_to_plus_1",
        label: "BTC −1%…+1%",
        test: (value: number) => value >= -1 && value < 1,
      },
      {
        key: "plus_1_to_plus_3",
        label: "BTC +1%…+3%",
        test: (value: number) => value >= 1 && value < 3,
      },
      {
        key: "above_plus_3",
        label: "BTC +3% и выше",
        test: (value: number) => value >= 3,
      },
    ] as const;
    const buckets = bucketDefinitions.map((definition) => {
      const bucketRows = entryRows.filter((row) =>
        definition.test(row.entryBtc24h as number),
      );
      const completed = bucketRows.filter(
        (row) => isCompleted(row) && row.pnlPercent !== null,
      );
      const withPeak = completed.filter((row) => row.peakPct !== null);
      const average = (values: number[]) =>
        values.length === 0
          ? null
          : Number(
              (
                values.reduce((sum, value) => sum + value, 0) / values.length
              ).toFixed(2),
            );
      const percent = (count: number, total: number) =>
        total === 0 ? null : Number(((count / total) * 100).toFixed(1));
      return {
        key: definition.key,
        label: definition.label,
        total: bucketRows.length,
        completed: completed.length,
        averagePnl: average(completed.map((row) => row.pnlPercent as number)),
        averagePeak: average(withPeak.map((row) => row.peakPct as number)),
        hit5Rate: percent(
          withPeak.filter((row) => (row.peakPct as number) >= 5).length,
          withPeak.length,
        ),
        hit10Rate: percent(
          withPeak.filter((row) => (row.peakPct as number) >= 10).length,
          withPeak.length,
        ),
      };
    });
    const dominanceBucketDefinitions = [
      {
        key: "below_50",
        label: "BTC.D ниже 50%",
        test: (value: number) => value < 50,
      },
      {
        key: "50_to_55",
        label: "BTC.D 50–55%",
        test: (value: number) => value >= 50 && value < 55,
      },
      {
        key: "55_to_60",
        label: "BTC.D 55–60%",
        test: (value: number) => value >= 55 && value < 60,
      },
      {
        key: "above_60",
        label: "BTC.D 60% и выше",
        test: (value: number) => value >= 60,
      },
    ] as const;
    const average = (values: number[]) =>
      values.length === 0
        ? null
        : Number(
            (
              values.reduce((sum, value) => sum + value, 0) / values.length
            ).toFixed(2),
          );
    const percent = (count: number, total: number) =>
      total === 0 ? null : Number(((count / total) * 100).toFixed(1));
    const dominanceRows = altRows.filter(
      (row) => row.entryBtcDominance !== null,
    );
    const dominanceBuckets = dominanceBucketDefinitions.map((definition) => {
      const bucketRows = dominanceRows.filter((row) =>
        definition.test(row.entryBtcDominance as number),
      );
      const completed = bucketRows.filter(
        (row) => isCompleted(row) && row.pnlPercent !== null,
      );
      const withPeak = completed.filter((row) => row.peakPct !== null);
      return {
        key: definition.key,
        label: definition.label,
        total: bucketRows.length,
        completed: completed.length,
        averagePnl: average(completed.map((row) => row.pnlPercent as number)),
        averagePeak: average(withPeak.map((row) => row.peakPct as number)),
        hit5Rate: percent(
          withPeak.filter((row) => (row.peakPct as number) >= 5).length,
          withPeak.length,
        ),
        hit10Rate: percent(
          withPeak.filter((row) => (row.peakPct as number) >= 10).length,
          withPeak.length,
        ),
      };
    });
    const dubaiMonth = (isoTimestamp: string) => {
      const parts = new Intl.DateTimeFormat("en", {
        timeZone: "Asia/Dubai",
        year: "numeric",
        month: "2-digit",
      }).formatToParts(new Date(isoTimestamp));
      const year = parts.find((part) => part.type === "year")?.value;
      const month = parts.find((part) => part.type === "month")?.value;
      return year && month ? `${year}-${month}` : null;
    };
    const monthlyDominance = Array.from(
      dominanceRows.reduce((groups, row) => {
        const month = row.detectedAt ? dubaiMonth(row.detectedAt) : null;
        if (!month) return groups;
        const group = groups.get(month) ?? [];
        group.push(row);
        groups.set(month, group);
        return groups;
      }, new Map<string, ContextRow[]>()),
    )
      .map(([month, monthRows]) => {
        const completed = monthRows.filter(
          (row) => isCompleted(row) && row.pnlPercent !== null,
        );
        return {
          month,
          samples: monthRows.length,
          completed: completed.length,
          averageEntryDominance: average(
            monthRows.map((row) => row.entryBtcDominance as number),
          ),
          averagePnl: average(completed.map((row) => row.pnlPercent as number)),
          winRate: percent(
            completed.filter((row) => Number(row.pnlPercent) > 0).length,
            completed.length,
          ),
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month));

    const observationResult = await db.execute(sql`
        SELECT observed_at, price
        FROM btc_regime_observations
         WHERE bucket_at >= ${new Date(
           dailyPerformanceWindow.start.getTime() - 86_400_000,
         )}
         ORDER BY bucket_at DESC
          LIMIT 1600
      `);
    const allObservationRows = (
      observationResult.rows as Record<string, unknown>[]
    ).reverse();
    const lastPricedObservation = [...allObservationRows]
      .reverse()
      .find((row) => row.price != null && Number(row.price) > 0);
    const latestBtcPrice = lastPricedObservation
      ? {
          observedAt: new Date(
            String(lastPricedObservation.observed_at),
          ).toISOString(),
          price: Number(lastPricedObservation.price),
        }
      : null;
    const btcMarketHistory = buildBtcMarketHistory({
      dominance,
      signalDominance: altRows.flatMap((row) => [
        {
          observedAt: row.entryBtcDominanceObservedAt ?? row.detectedAt,
          value: row.entryBtcDominance,
        },
        {
          observedAt: row.closeBtcDominanceObservedAt ?? row.closedAt,
          value: row.closeBtcDominance,
        },
      ]),
      priceCandles,
      priceSnapshots: allObservationRows.map((row) => ({
        observedAt: new Date(String(row.observed_at)).toISOString(),
        price: row.price == null ? null : Number(row.price),
      })),
      now: generatedAt,
    });
    const marketContextDominanceObservations = [
      ...storedDominance.map((point) => ({
        observedAt: point.observedAt,
        value: point.value,
        source: point.source,
      })),
      ...(dominance
        ? [
            ...dominance.history.map((point) => ({
              observedAt: point.timestamp,
              value: point.dominance,
              source: dominance.source,
            })),
            {
              observedAt: dominance.updatedAt,
              value: dominance.current,
              source: dominance.source,
            },
          ]
        : []),
      ...altRows.flatMap((row) => [
        row.entryBtcDominanceObservedAt != null && row.entryBtcDominance != null
          ? {
              observedAt: row.entryBtcDominanceObservedAt,
              value: row.entryBtcDominance,
              source: "signal_snapshot" as const,
            }
          : null,
        row.closeBtcDominanceObservedAt != null && row.closeBtcDominance != null
          ? {
              observedAt: row.closeBtcDominanceObservedAt,
              value: row.closeBtcDominance,
              source: "signal_snapshot" as const,
            }
          : null,
      ]),
    ].filter((point): point is NonNullable<typeof point> => point != null);
    const dailyMarketContext = buildBtcDailyMarketContext({
      days: dailyPerformanceWindow.days,
      now: generatedAt,
      priceObservations: allObservationRows.map((row) => ({
        observedAt: new Date(String(row.observed_at)).toISOString(),
        price: row.price == null ? null : Number(row.price),
      })),
      priceCandles,
      dominanceObservations: marketContextDominanceObservations,
    });
    const crossHistory = await reconcileBtcCrossAlerts(
      generatedAt,
      priceCandles,
    );
    const response = {
      observationOnly: true,
      generatedAt: generatedAt.toISOString(),
      dailyPerformance,
      dailyMarketContext,
      entryOutcomeContext,
      crossHistory,
      dominance,
      btcMarketHistory,
      latestBtcPrice,
      coverage: {
        totalAltSignals: altRows.length,
        completedAltSignals: altRows.filter(isCompleted).length,
        entryBtc24hSamples: entryRows.length,
        closeBtc24hSamples: altRows.filter((row) => row.closeBtc24h !== null)
          .length,
        entryBtcDominanceSamples: dominanceRows.length,
        closeBtcDominanceSamples: altRows.filter(
          (row) => row.closeBtcDominance !== null,
        ).length,
        firstEntryBtcAt:
          entryRows.length === 0
            ? null
            : (entryRows[entryRows.length - 1]?.detectedAt ?? null),
        lastEntryBtcAt: entryRows[0]?.detectedAt ?? null,
      },
      buckets,
      dominanceBuckets,
      monthlyDominance,
      unavailableData: [
        ...(dominance
          ? []
          : ["BTC dominance (BTC.D): CoinGlass временно недоступен"]),
        "BTC 15m / 1h / 4h snapshots на входе: не сохраняются как единый ряд",
      ],
    };
    GetBtcAnalysisResponse.parse(response);
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch BTC analysis");
    res.status(500).json({ error: "Failed to fetch BTC analysis" });
  }
});

router.get("/btc-cross-alerts", requireDashboardOwner, async (req, res) => {
  try {
    await reconcileBtcCrossAlerts();
    const response = await getBtcCrossAlerts();
    GetBtcCrossAlertsResponse.parse(response);
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to load BTC crossing alerts");
    res.status(500).json({ error: "Failed to load BTC crossing alerts" });
  }
});

router.post(
  "/btc-cross-alerts/:id/read",
  requireDashboardOwner,
  async (req, res) => {
    const params = MarkBtcCrossAlertReadParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid BTC crossing alert id" });
      return;
    }
    try {
      const marked = await markBtcCrossAlertRead(params.data.id);
      if (!marked) {
        res.status(404).json({ error: "BTC crossing alert not found" });
        return;
      }
      res.json(MarkBtcCrossAlertReadResponse.parse({ success: true }));
    } catch (err) {
      req.log.error({ err }, "Failed to mark BTC crossing alert as read");
      res
        .status(500)
        .json({ error: "Failed to mark BTC crossing alert as read" });
    }
  },
);

// Owner-only monitoring of the observation-only indicator-target experiment.
router.get(
  "/admin/tracker/indicator-target-observations",
  requireAdminToken,
  async (req, res): Promise<void> => {
    const parsedQuery =
      GetAdminTrackerIndicatorTargetObservationsQueryParams.safeParse(
        req.query,
      );
    if (!parsedQuery.success) {
      res.status(400).json({ error: parsedQuery.error.message });
      return;
    }

    try {
      const [experiment] = await db
        .select({
          startAt: indicatorTargetObservationExperimentsTable.startAt,
        })
        .from(indicatorTargetObservationExperimentsTable)
        .where(
          eq(
            indicatorTargetObservationExperimentsTable.experimentVersion,
            INDICATOR_TARGET_OBSERVATION_VERSION,
          ),
        )
        .limit(1);
      if (!experiment) {
        req.log.error(
          { experimentVersion: INDICATOR_TARGET_OBSERVATION_VERSION },
          "Indicator target experiment start is missing",
        );
        res
          .status(503)
          .json({ error: "Indicator target experiment unavailable" });
        return;
      }

      const complete72h = sql`
        ${indicatorTargetObservationsTable.followupStatus} = 'complete'
        AND ${indicatorTargetObservationsTable.followupSampleCount} = 288
        AND ${indicatorTargetObservationsTable.followupExpectedSampleCount} = 288
        AND ${indicatorTargetObservationsTable.priceAt72h} IS NOT NULL
        AND ${indicatorTargetObservationsTable.priceAt72hObservedAt}
          = ${indicatorTargetObservationsTable.followupDeadline}
      `;
      const versionCondition = eq(
        indicatorTargetObservationsTable.experimentVersion,
        INDICATOR_TARGET_OBSERVATION_VERSION,
      );
      const eligibleTrackerCondition = and(
        eq(trackedSignalsTable.isShort, false),
        isNotNull(trackedSignalsTable.signalId),
        gt(trackedSignalsTable.entryPrice, 0),
        gte(trackedSignalsTable.detectedAt, experiment.startAt),
      );
      const [
        eligible,
        enrolled,
        durableProgress,
        groups,
        provenanceRows,
        recent,
      ] = await Promise.all([
        db
          .select({
            trackedSignals: sql<number>`count(DISTINCT ${trackedSignalsTable.id})::int`,
          })
          .from(trackedSignalsTable)
          .where(eligibleTrackerCondition),
        db
          .select({
            trackedSignals: sql<number>`count(*)::int`,
          })
          .from(trackedSignalsTable)
          .where(
            and(
              eligibleTrackerCondition,
              sql`(
                  SELECT count(DISTINCT observation.target_pct)
                  FROM indicator_target_observations observation
                  WHERE observation.tracked_signal_id = ${trackedSignalsTable.id}
                    AND observation.experiment_version = ${INDICATOR_TARGET_OBSERVATION_VERSION}
                    AND observation.target_pct IN (8, 12, 16)
                ) = 3`,
            ),
          ),
        db
          .select({
            observationRows: sql<number>`count(*)::int`,
            attempts: sql<number>`coalesce(sum(${indicatorTargetObservationsTable.attempts}), 0)::int`,
            lastUpdatedAt: sql<Date | null>`max(${indicatorTargetObservationsTable.updatedAt})`,
          })
          .from(indicatorTargetObservationsTable)
          .where(versionCondition),
        db
          .select({
            pattern: indicatorTargetObservationsTable.pattern,
            targetPct: indicatorTargetObservationsTable.targetPct,
            total: sql<number>`count(*)::int`,
            awaitingHit: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.status} = 'awaiting_hit')::int`,
            hit: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.status} = 'hit')::int`,
            noHitBeforeClose: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.status} = 'no_hit_before_close')::int`,
            unknown: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.status} = 'unknown')::int`,
            followupNotStarted: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'not_started')::int`,
            followupPending: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'pending')::int`,
            followupDelayed: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'delayed')::int`,
            followupRetry: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'retry')::int`,
            followupComplete: sql<number>`count(*) FILTER (WHERE ${complete72h})::int`,
            followupPartial: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'partial')::int`,
            followupUnavailable: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'unavailable')::int`,
            followupNotApplicable: sql<number>`count(*) FILTER (WHERE ${indicatorTargetObservationsTable.followupStatus} = 'not_applicable')::int`,
            completeOutcomeCount: sql<number>`count(*) FILTER (WHERE ${complete72h})::int`,
            completeAverageChangePct: sql<
              number | null
            >`avg(${indicatorTargetObservationsTable.priceAt72hChangePct}) FILTER (WHERE ${complete72h})`,
            completePositiveAfter72: sql<number>`count(*) FILTER (WHERE ${complete72h} AND ${indicatorTargetObservationsTable.priceAt72hChangePct} > 0)::int`,
            completeAverageMaxFavorablePct: sql<
              number | null
            >`avg(${indicatorTargetObservationsTable.maxFavorablePct}) FILTER (WHERE ${complete72h})`,
            completeAverageMinFavorablePct: sql<
              number | null
            >`avg(${indicatorTargetObservationsTable.minFavorablePct}) FILTER (WHERE ${complete72h})`,
          })
          .from(indicatorTargetObservationsTable)
          .where(versionCondition)
          .groupBy(
            indicatorTargetObservationsTable.pattern,
            indicatorTargetObservationsTable.targetPct,
          )
          .orderBy(
            asc(indicatorTargetObservationsTable.pattern),
            asc(indicatorTargetObservationsTable.targetPct),
          ),
        db
          .select({
            status: indicatorTargetObservationsTable.indicatorProvenanceStatus,
            trackedSignals: sql<number>`count(DISTINCT ${indicatorTargetObservationsTable.trackedSignalId})::int`,
          })
          .from(indicatorTargetObservationsTable)
          .where(versionCondition)
          .groupBy(indicatorTargetObservationsTable.indicatorProvenanceStatus)
          .orderBy(
            asc(indicatorTargetObservationsTable.indicatorProvenanceStatus),
          ),
        db
          .select({
            trackedSignalId: indicatorTargetObservationsTable.trackedSignalId,
            symbol: indicatorTargetObservationsTable.symbol,
            pattern: indicatorTargetObservationsTable.pattern,
            signalAt: indicatorTargetObservationsTable.signalAt,
            targetPct: indicatorTargetObservationsTable.targetPct,
            indicatorProvenanceStatus:
              indicatorTargetObservationsTable.indicatorProvenanceStatus,
            status: indicatorTargetObservationsTable.status,
            hitAt: indicatorTargetObservationsTable.hitAt,
            hitPrice: indicatorTargetObservationsTable.hitPrice,
            hitSource: indicatorTargetObservationsTable.hitSource,
            tradeClosedAt: indicatorTargetObservationsTable.tradeClosedAt,
            followupStatus: indicatorTargetObservationsTable.followupStatus,
            followupDeadline: indicatorTargetObservationsTable.followupDeadline,
            priceAt72h: indicatorTargetObservationsTable.priceAt72h,
            priceAt72hChangePct:
              indicatorTargetObservationsTable.priceAt72hChangePct,
            maxFavorablePct: indicatorTargetObservationsTable.maxFavorablePct,
            minFavorablePct: indicatorTargetObservationsTable.minFavorablePct,
            followupSampleCount:
              indicatorTargetObservationsTable.followupSampleCount,
            followupExpectedSampleCount:
              indicatorTargetObservationsTable.followupExpectedSampleCount,
            priceAt72hObservedAt:
              indicatorTargetObservationsTable.priceAt72hObservedAt,
          })
          .from(indicatorTargetObservationsTable)
          .where(versionCondition)
          .orderBy(
            desc(indicatorTargetObservationsTable.signalAt),
            desc(indicatorTargetObservationsTable.id),
          )
          .limit(parsedQuery.data.limit),
      ]);

      const workerHealth = getIndicatorTargetObservationWorkerHealth();
      const shaped = buildIndicatorTargetObservationsResponse(groups, recent);
      res.json(
        GetAdminTrackerIndicatorTargetObservationsResponse.parse({
          ...shaped,
          experimentVersion: INDICATOR_TARGET_OBSERVATION_VERSION,
          experimentStartedAt: observationDate(experiment.startAt),
          eligibleTrackedSignalsSinceStart: observationNumber(
            eligible[0]?.trackedSignals,
          ),
          enrolledTrackedSignalsSinceStart: observationNumber(
            enrolled[0]?.trackedSignals,
          ),
          missingEnrollmentTrackedSignalsSinceStart: Math.max(
            0,
            observationNumber(eligible[0]?.trackedSignals) -
              observationNumber(enrolled[0]?.trackedSignals),
          ),
          durableProgress: {
            observationRows: observationNumber(
              durableProgress[0]?.observationRows,
            ),
            attempts: observationNumber(durableProgress[0]?.attempts),
            lastUpdatedAt: observationDate(durableProgress[0]?.lastUpdatedAt),
          },
          workerProcess: {
            lastAttemptAt: observationDate(workerHealth.lastAttemptAt),
            lastSuccessAt: observationDate(workerHealth.lastSuccessAt),
            lastErrorAt: observationDate(workerHealth.lastErrorAt),
            lastError: workerHealth.lastError ?? null,
            lastEnrolled: observationNumber(workerHealth.lastEnrolled),
            lastProcessed: observationNumber(workerHealth.lastProcessed),
          },
          indicatorProvenanceCoverage: provenanceRows.map((row) => ({
            status: row.status,
            trackedSignals: observationNumber(row.trackedSignals),
          })),
          decisionUse: false,
          takeProfitRecommendation: false,
        }),
      );
    } catch (err) {
      req.log.error({ err }, "Indicator target observation report failed");
      res
        .status(503)
        .json({ error: "Indicator target observation report unavailable" });
    }
  },
);

router.get(
  "/admin/tracker/lc-waiting-shadow",
  requireAdminToken,
  async (req, res) => {
    try {
      res.json(await getLcWaitingShadowReport());
    } catch (err) {
      req.log.error({ err }, "LC waiting shadow report failed");
      res.status(503).json({ error: "LC waiting shadow unavailable" });
    }
  },
);

router.get(
  "/admin/tracker/lc-repeat-watch",
  requireAdminToken,
  async (req, res): Promise<void> => {
    try {
      res.json(await getLcRepeatWatchReport());
    } catch (err) {
      req.log.error({ err }, "LC repeat watch report failed");
      res.status(503).json({ error: "LC repeat watch unavailable" });
    }
  },
);

router.get(
  "/admin/tracker/lc-rapid-rebound",
  requireAdminToken,
  async (req, res): Promise<void> => {
    try {
      res.json(
        GetLcRapidReboundResponse.parse(await getLcRapidReboundReport()),
      );
    } catch (err) {
      req.log.error({ err }, "LC rapid rebound report failed");
      res.status(503).json({ error: "LC rapid rebound report unavailable" });
    }
  },
);

router.get(
  "/admin/tracker/reentry-shadow",
  requireAdminToken,
  async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const [events, aggregate] = await Promise.all([
        db
          .select()
          .from(reentryShadowEventsTable)
          .orderBy(desc(reentryShadowEventsTable.candidateAt))
          .limit(limit),
        db
          .select({
            eventCount: sql<number>`count(*)::int`,
            observed4h: sql<number>`count(${reentryShadowEventsTable.outcome4hPct})::int`,
            observed8h: sql<number>`count(${reentryShadowEventsTable.outcome8hPct})::int`,
            observed24h: sql<number>`count(${reentryShadowEventsTable.outcome24hPct})::int`,
            avg4h: sql<
              number | null
            >`avg(${reentryShadowEventsTable.outcome4hPct})`,
            avg8h: sql<
              number | null
            >`avg(${reentryShadowEventsTable.outcome8hPct})`,
            avg24h: sql<
              number | null
            >`avg(${reentryShadowEventsTable.outcome24hPct})`,
          })
          .from(reentryShadowEventsTable),
      ]);
      res.json({
        shadowOnly: true,
        policy: "shadow-only",
        actionable: false,
        events,
        aggregate: aggregate[0] ?? {
          eventCount: 0,
          observed4h: 0,
          observed8h: 0,
          observed24h: 0,
          avg4h: null,
          avg8h: null,
          avg24h: null,
        },
      });
    } catch (error) {
      req.log.error({ error }, "reentry shadow analytics failed");
      res.status(500).json({ error: "reentry shadow analytics unavailable" });
    }
  },
);

router.get("/tracker/stats", async (req, res) => {
  try {
    const monthStart = getDubaiMonthStart();

    const [rows, monthRows, monthBuStopMilestoneRows, monthAvgPeakRows] =
      await Promise.all([
        db
          .select({
            status: trackedSignalsTable.status,
            count: sql<number>`count(*)::int`,
            avgPnl: sql<number>`round(avg(${normalizedTrackedPnlSql()})::numeric, 2)`,
            positiveCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} > 0)::int`,
            negativeCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} < 0)::int`,
            breakevenCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} = 0)::int`,
          })
          .from(trackedSignalsTable)
          .where(
            and(
              activeTrackedPatternCondition(),
              ne(trackedSignalsTable.status, "reclassified"),
              currentStatsCohortCondition(),
            ),
          )
          .groupBy(trackedSignalsTable.status),

        db
          .select({
            status: trackedSignalsTable.status,
            count: sql<number>`count(*)::int`,
            avgPnl: sql<number>`round(avg(${normalizedTrackedPnlSql()})::numeric, 2)`,
            pnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}), 0)`,
            positiveCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} > 0)::int`,
            negativeCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} < 0)::int`,
            breakevenCount: sql<number>`count(*) filter (where ${normalizedTrackedPnlSql()} = 0)::int`,
            positivePnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}) filter (where ${normalizedTrackedPnlSql()} > 0), 0)`,
            negativePnlSum: sql<number>`coalesce(sum(${normalizedTrackedPnlSql()}) filter (where ${normalizedTrackedPnlSql()} < 0), 0)`,
          })
          .from(trackedSignalsTable)
          // Terminal outcomes belong to the Dubai month when they closed. Open
          // positions still belong to their entry month until they reach a final
          // status. This keeps cross-month closes out of the entry-month archive.
          .where(
            and(
              // Owner 2026-10-24: profitable trades of retired PLM stay in the
              // current-month counter; its other outcomes remain outside it.
              or(
                activeTrackedPatternCondition(),
                and(
                  eq(trackedSignalsTable.sentimentKey, "price_led_momentum"),
                  eq(trackedSignalsTable.status, "profit"),
                ),
              ),
              ne(trackedSignalsTable.status, "reclassified"),
              currentStatsCohortCondition(),
              or(
                and(
                  inArray(trackedSignalsTable.status, [...OPEN_STATUSES]),
                  gte(trackedSignalsTable.detectedAt, monthStart),
                ),
                and(
                  not(inArray(trackedSignalsTable.status, [...OPEN_STATUSES])),
                  isNotNull(trackedSignalsTable.closedAt),
                  gte(trackedSignalsTable.closedAt, monthStart),
                ),
              ),
            ),
          )
          .groupBy(trackedSignalsTable.status),

        db
          .select({
            bucket: buStopMilestoneBucketSql(),
            count: sql<number>`count(*)::int`,
          })
          .from(trackedSignalsTable)
          .where(
            and(
              eq(trackedSignalsTable.status, "bu_stop"),
              activeTrackedPatternCondition(),
              isNotNull(trackedSignalsTable.closedAt),
              gte(trackedSignalsTable.closedAt, monthStart),
            ),
          )
          .groupBy(buStopMilestoneBucketSql()),

        db
          .select({
            avgPeak: sql<number>`round(avg((peak_price - CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END) / nullif(CASE WHEN policy_version = 'impulse_runner_v1' THEN original_entry_price ELSE entry_price END, 0) * 100)::numeric, 2)`,
          })
          .from(trackedSignalsTable)
          .where(
            and(
              activeTrackedPatternCondition(),
              inArray(trackedSignalsTable.status, ["profit", "stop_loss"]),
              currentStatsCohortCondition(),
              isNotNull(trackedSignalsTable.closedAt),
              gte(trackedSignalsTable.closedAt, monthStart),
            ),
          ),
      ]);

    const stats: Record<
      string,
      {
        count: number;
        avgPnl: number | null;
        positiveCount: number;
        negativeCount: number;
        breakevenCount: number;
      }
    > = {};
    for (const row of rows)
      stats[row.status] = {
        count: row.count,
        avgPnl: row.avgPnl,
        positiveCount: Number(row.positiveCount ?? 0),
        negativeCount: Number(row.negativeCount ?? 0),
        breakevenCount: Number(row.breakevenCount ?? 0),
      };

    const monthStats: Record<
      string,
      {
        count: number;
        avgPnl: number | null;
        pnlSum: number;
        positiveCount: number;
        negativeCount: number;
        breakevenCount: number;
        positivePnlSum: number;
        negativePnlSum: number;
      }
    > = {};
    for (const row of monthRows)
      monthStats[row.status] = {
        count: row.count,
        avgPnl: row.avgPnl,
        pnlSum: Number(row.pnlSum ?? 0),
        positiveCount: Number(row.positiveCount ?? 0),
        negativeCount: Number(row.negativeCount ?? 0),
        breakevenCount: Number(row.breakevenCount ?? 0),
        positivePnlSum: Number(row.positivePnlSum ?? 0),
        negativePnlSum: Number(row.negativePnlSum ?? 0),
      };

    const monthBuStopMilestones = toBuStopMilestoneCounts(
      monthBuStopMilestoneRows,
    );

    const total = rows.reduce((s, r) => s + r.count, 0);
    const allTimeProfit = stats["profit"]?.count ?? 0;
    const allTimeBuStop = stats["bu_stop"]?.count ?? 0;
    const allTimeStopLoss = stats["stop_loss"]?.count ?? 0;
    const allTimeWinRateDenominator =
      allTimeProfit + allTimeBuStop + allTimeStopLoss;
    const winRate =
      allTimeWinRateDenominator > 0
        ? Math.round(
            ((allTimeProfit + allTimeBuStop) / allTimeWinRateDenominator) * 100,
          )
        : null;
    const avgProfit =
      stats["profit"]?.avgPnl != null ? Number(stats["profit"].avgPnl) : null;
    const avgLoss =
      stats["stop_loss"]?.avgPnl != null
        ? Number(stats["stop_loss"].avgPnl)
        : null;

    // Month-only derived stats
    const rawPnlStatuses = [
      "profit",
      "stop_loss",
      "expired",
      "cancelled",
    ] as const;
    const monthNonCancelledPositiveCount = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (monthStats[status]?.positiveCount ?? 0),
      0,
    );
    const monthNonCancelledNegativeCount = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (monthStats[status]?.negativeCount ?? 0),
      0,
    );
    const monthNonCancelledPositivePnlSum = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (monthStats[status]?.positivePnlSum ?? 0),
      0,
    );
    const monthNonCancelledNegativePnlSum = NON_CANCELLED_PNL_STATUSES.reduce(
      (sum, status) => sum + (monthStats[status]?.negativePnlSum ?? 0),
      0,
    );
    const monthProfit = monthStats["profit"]?.count ?? 0;
    const monthBuStop = monthStats["bu_stop"]?.count ?? 0;
    const monthStopLoss = monthStats["stop_loss"]?.count ?? 0;
    const monthWinRateDenominator = monthProfit + monthBuStop + monthStopLoss;
    const monthWinRate =
      monthWinRateDenominator > 0
        ? Math.round(
            ((monthProfit + monthBuStop) / monthWinRateDenominator) * 100,
          )
        : null;
    const monthAvgProfit =
      monthNonCancelledPositiveCount > 0
        ? monthNonCancelledPositivePnlSum / monthNonCancelledPositiveCount
        : null;
    const monthAvgLoss =
      monthNonCancelledNegativeCount > 0
        ? monthNonCancelledNegativePnlSum / monthNonCancelledNegativeCount
        : null;
    const monthAvgPeak =
      monthAvgPeakRows[0]?.avgPeak != null
        ? Number(monthAvgPeakRows[0].avgPeak)
        : null;
    const monthNetPnlPercent =
      Math.round(
        rawPnlStatuses.reduce(
          (sum, status) => sum + (monthStats[status]?.pnlSum ?? 0),
          0,
        ) * 100,
      ) / 100;

    res.json({
      stats,
      total,
      winRate,
      avgProfit,
      avgLoss,
      monthStats,
      monthWinRate,
      monthAvgProfit,
      monthAvgLoss,
      monthAvgPeak,
      monthNetPnlPercent,
      monthBuStopAfter5: monthBuStopMilestones.after5,
      monthBuStopAfter8: monthBuStopMilestones.after8,
      monthBuStopAfter10: monthBuStopMilestones.after10,
    });
  } catch (_err) {
    res.status(500).json({ error: "Failed to fetch tracker stats" });
  }
});

// GET /api/tracker/calculator — personal, modelled monthly PnL for dashboard user
router.get("/tracker/calculator", async (req, res) => {
  const userId = await getCalculatorUserId(req, res);
  if (userId == null) return;

  try {
    await db
      .insert(tradeCalculatorSettingsTable)
      .values({ userId })
      .onConflictDoNothing();

    const [settingsRow] = await db
      .select()
      .from(tradeCalculatorSettingsTable)
      .where(eq(tradeCalculatorSettingsTable.userId, userId))
      .limit(1);
    if (!settingsRow) {
      return res.status(500).json({ error: "Не удалось загрузить настройки" });
    }

    const settings: CalculatorSettingsInput = {
      depositUsdt: Number(settingsRow.depositUsdt),
      leverage: Number(settingsRow.leverage),
      allocationPercent: Number(settingsRow.allocationPercent),
      commissionPercent: Number(settingsRow.commissionPercent),
    };
    const currentMonth = getCalculatorMonth();

    const rows = (await db
      .select({
        status: trackedSignalsTable.status,
        pnlPercent: trackedSignalsTable.pnlPercent,
        lastMilestone: trackedSignalsTable.lastMilestone,
        closedAt: trackedSignalsTable.closedAt,
      })
      .from(trackedSignalsTable)
      .where(
        inArray(trackedSignalsTable.status, CALCULATOR_CLOSED_STATUSES as any),
      )) as Array<{
      status: string;
      pnlPercent: number | null;
      lastMilestone: number | null;
      closedAt: Date | null;
    }>;

    const grouped = new Map<string, CalculatorTradeRow[]>();
    for (const row of rows) {
      if (!row.closedAt) continue;
      const month = getDubaiMonthKey(row.closedAt);
      const monthRows = grouped.get(month) ?? [];
      monthRows.push({
        status: row.status,
        pnlPercent: row.pnlPercent,
        lastMilestone: row.lastMilestone,
        closedAt: row.closedAt,
      });
      grouped.set(month, monthRows);
    }

    const current = calculateCalculatorSummary(
      currentMonth,
      grouped.get(currentMonth) ?? [],
      settings,
    );

    const now = new Date();
    await db
      .insert(tradeCalculatorMonthlyTable)
      .values({
        userId,
        month: currentMonth,
        ...settings,
        reinvest: false,
        grossPnlUsdt: current.grossPnlUsdt,
        netPnlUsdt: current.netPnlUsdt,
        closedTrades: current.closedTrades,
        profitTrades: current.profitTrades,
        lossTrades: current.lossTrades,
        buStopTrades: current.buStopTrades,
        breakevenTrades: current.breakevenTrades,
        expiredTrades: current.expiredTrades,
        cancelledSignals: current.cancelledSignals,
        periodClosedAt: null,
        calculatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          tradeCalculatorMonthlyTable.userId,
          tradeCalculatorMonthlyTable.month,
        ],
        set: {
          depositUsdt: settings.depositUsdt,
          leverage: settings.leverage,
          allocationPercent: settings.allocationPercent,
          commissionPercent: settings.commissionPercent,
          grossPnlUsdt: current.grossPnlUsdt,
          netPnlUsdt: current.netPnlUsdt,
          closedTrades: current.closedTrades,
          profitTrades: current.profitTrades,
          lossTrades: current.lossTrades,
          buStopTrades: current.buStopTrades,
          breakevenTrades: current.breakevenTrades,
          expiredTrades: current.expiredTrades,
          cancelledSignals: current.cancelledSignals,
          calculatedAt: now,
          updatedAt: now,
        },
        // A correctly scheduled archive can never be the current month, but
        // this guard keeps a closed row immutable even after clock changes or
        // a manually inserted snapshot.
        setWhere: isNull(tradeCalculatorMonthlyTable.periodClosedAt),
      });

    const archive = await db
      .select()
      .from(tradeCalculatorMonthlyTable)
      .where(eq(tradeCalculatorMonthlyTable.userId, userId))
      .orderBy(desc(tradeCalculatorMonthlyTable.month))
      .limit(24);

    return res.json({
      timeZone: CALCULATOR_MONTH_TIME_ZONE,
      archivePolicy: {
        closedSnapshots: "immutable",
        lateCorrections: "manual_revision_required",
      },
      settings,
      current,
      archive: archive.map((row) => ({
        month: row.month,
        label: getMonthLabel(row.month),
        periodClosedAt: row.periodClosedAt?.toISOString() ?? null,
        depositUsdt: Number(row.depositUsdt),
        leverage: Number(row.leverage),
        allocationPercent: Number(row.allocationPercent),
        commissionPercent: Number(row.commissionPercent),
        grossPnlUsdt: Number(row.grossPnlUsdt),
        netPnlUsdt: Number(row.netPnlUsdt),
        netPnlPercent:
          Number(row.depositUsdt) > 0
            ? (Number(row.netPnlUsdt) / Number(row.depositUsdt)) * 100
            : 0,
        closedTrades: row.closedTrades,
        profitTrades: row.profitTrades,
        lossTrades: row.lossTrades,
        buStopTrades: row.buStopTrades,
        breakevenTrades: row.breakevenTrades,
        expiredTrades: row.expiredTrades,
        cancelledSignals: row.cancelledSignals,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "trade calculator load error");
    return res.status(500).json({ error: "Не удалось рассчитать результат" });
  }
});

// PUT /api/tracker/calculator — update personal model parameters
router.put("/tracker/calculator", async (req, res) => {
  const userId = await getCalculatorUserId(req, res);
  if (userId == null) return;

  const body = req.body as Partial<CalculatorSettingsInput>;
  if (
    !isValidCalculatorNumber(body.depositUsdt, 10, 10_000_000) ||
    !isValidCalculatorNumber(body.leverage, 1, 125) ||
    !isValidCalculatorNumber(body.allocationPercent, 0.1, 100) ||
    !isValidCalculatorNumber(body.commissionPercent, 0, 5)
  ) {
    return res.status(400).json({
      error:
        "Проверьте депозит, плечо, размер позиции и комиссию — значения вне допустимого диапазона.",
    });
  }

  try {
    const settings: CalculatorSettingsInput = {
      depositUsdt: body.depositUsdt,
      leverage: body.leverage,
      allocationPercent: body.allocationPercent,
      commissionPercent: body.commissionPercent,
    };
    await db
      .insert(tradeCalculatorSettingsTable)
      .values({ userId, ...settings, reinvest: false, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: tradeCalculatorSettingsTable.userId,
        set: { ...settings, reinvest: false, updatedAt: new Date() },
      });
    // Keep an immutable-at-close parameter source for the month that is open
    // right now. A setting saved after the Dubai boundary only touches the new
    // month, so delayed archival retries cannot use it for the previous one.
    const currentMonth = getCalculatorMonth();
    const now = new Date();
    await db
      .insert(tradeCalculatorMonthlyTable)
      .values({
        userId,
        month: currentMonth,
        ...settings,
        reinvest: false,
        grossPnlUsdt: 0,
        netPnlUsdt: 0,
        closedTrades: 0,
        profitTrades: 0,
        lossTrades: 0,
        breakevenTrades: 0,
        expiredTrades: 0,
        cancelledSignals: 0,
        periodClosedAt: null,
        calculatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          tradeCalculatorMonthlyTable.userId,
          tradeCalculatorMonthlyTable.month,
        ],
        set: { ...settings, reinvest: false, updatedAt: now },
        setWhere: isNull(tradeCalculatorMonthlyTable.periodClosedAt),
      });
    return res.json({ settings });
  } catch (err) {
    req.log.error({ err }, "trade calculator settings update error");
    return res.status(500).json({ error: "Не удалось сохранить настройки" });
  }
});

// POST /api/tracker/import — bulk-insert tracked positions (migration/admin tool)
// Body: { positions: Array<{ symbol, sentimentKey, isShort?, entryPrice, detectedAt, status? }> }
router.post("/tracker/import", requireAdminToken, async (req, res) => {
  try {
    const { positions } = req.body as {
      positions: Array<{
        symbol: string;
        sentimentKey: string;
        isShort?: boolean;
        entryPrice: number;
        detectedAt: string;
        status?: string;
      }>;
    };
    if (!Array.isArray(positions) || positions.length === 0) {
      res.status(400).json({ error: "positions array required" });
      return;
    }
    const now = new Date();
    const inserted: string[] = [];
    const skipped: string[] = [];
    for (const p of positions) {
      // Skip if already open for this symbol
      const existing = await db
        .select({ id: trackedSignalsTable.id })
        .from(trackedSignalsTable)
        .where(
          and(
            eq(trackedSignalsTable.symbol, p.symbol),
            inArray(trackedSignalsTable.status, ["active", "in_run"]),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        skipped.push(p.symbol);
        continue;
      }
      await db.insert(trackedSignalsTable).values({
        symbol: p.symbol,
        signalType: "strict_alpha",
        sentimentKey: p.sentimentKey,
        isShort: p.isShort ?? false,
        entryPrice: p.entryPrice,
        status: (p.status ?? "active") as any,
        detectedAt: new Date(p.detectedAt),
        updatedAt: now,
      });
      inserted.push(p.symbol);
    }
    req.log.info({ inserted, skipped }, "tracker/import: positions imported");
    res.json({ ok: true, inserted, skipped });
  } catch (err) {
    req.log.error({ err }, "tracker/import failed");
    res.status(500).json({ error: "Import failed" });
  }
});

// POST /api/tracker/run-cycle — manually trigger watcher cycle
router.post("/tracker/run-cycle", requireAdminToken, async (req, res) => {
  try {
    const result = await runWatcherCycle();
    if (!result) {
      res
        .status(409)
        .json({ error: "Another market cycle is already running" });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (_err) {
    res.status(500).json({ error: "Watcher cycle failed" });
  }
});

// POST /api/tracker/notify — admin broadcast custom message to all subscribers
router.post("/tracker/notify", requireAdminToken, async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text) {
      res.status(400).json({ error: "text required" });
      return;
    }
    await adminBroadcast(text);
    res.json({ ok: true });
  } catch (_err) {
    res.status(500).json({ error: "Broadcast failed" });
  }
});

// POST /api/tracker/weekly-digest — send weekly digest now (manual, bypass dedupe)
router.post("/tracker/weekly-digest", requireAdminToken, async (req, res) => {
  try {
    await sendWeeklyDigest(undefined, true);
    res.json({ ok: true });
  } catch (_err) {
    res.status(500).json({ error: "Weekly digest failed" });
  }
});

// POST /api/tracker/daily-digest — send daily report now (manual, bypass dedupe)
router.post("/tracker/daily-digest", requireAdminToken, async (req, res) => {
  try {
    await sendDailyReport(undefined, true);
    res.json({ ok: true });
  } catch (_err) {
    res.status(500).json({ error: "Daily report failed" });
  }
});

// POST /api/tracker/monthly-digest — send the current Dubai calendar month now
router.post("/tracker/monthly-digest", requireAdminToken, async (req, res) => {
  try {
    // Manual report: always bypass the scheduled-send dedupe guard. The report
    // itself is bounded from the first day of the current Asia/Dubai month.
    await sendMonthlyDigest(undefined, true);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to send monthly digest");
    res.status(500).json({ error: "Monthly digest failed" });
  }
});

// ── POST /api/tracker/spot-audit ──────────────────────────────────────────────
// Прогоняет все открытые сигналы через спот-фильтр (% от MCap).
// Отменяет те, где данные есть и объём ниже порога.
// Отправляет сводку в Telegram и возвращает JSON с результатами.
router.post("/tracker/spot-audit", requireAdminToken, async (req, res) => {
  try {
    const OPEN_STATUSES = ["active", "in_run"] as const;
    // Спот-объём >= MIN_PCT * MCap — только процентный порог, без фиксированной суммы.
    // Нет MCap данных → блок.
    const MIN_PCT_ALPHA = 0.0005; // 0.05% MCap — стандартные паттерны

    // 1. Все открытые позиции
    const open = await db
      .select()
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.status, [...OPEN_STATUSES]));

    if (open.length === 0) {
      await adminBroadcast(
        `🔍 <b>Аудит спот-фильтра</b>\n\nОткрытых позиций нет — нечего проверять.`,
      );
      res.json({ ok: true, total: 0, cancelled: 0, passed: 0, noData: 0 });
      return;
    }

    // 2. Получаем текущие цены для P&L
    const priceMap = new Map<string, number>();
    try {
      const tickers = (await getFutureTickers()) as {
        symbol: string;
        lastPrice: string;
      }[];
      for (const t of tickers)
        priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);
    } catch {
      /* skip */
    }

    // 3. Спот-объёмы — параллельно (BingX, без rate limit проблем)
    //    MCap — одним батч-запросом к CoinGecko (экономим rate limit)
    type AuditRow = {
      sig: TrackedSignal;
      spotVol24h: number | null;
      marketCapUsd: number | null;
      spotPct: number | null;
      minPct: number;
      verdict: "cancel" | "pass" | "no_data";
    };

    const symbols = open.map((s) => s.symbol);

    // Параллельно: все spot vol + один батч mcap запрос
    const [spotVolMap, mcapMap] = await Promise.all([
      Promise.all(
        symbols.map((sym) =>
          getFsVolume(sym)
            .then((r) => r.spotVolUsd24h ?? null)
            .catch(() => null)
            .then((vol) => [sym, vol] as [string, number | null]),
        ),
      ).then((entries) => new Map(entries)),
      batchFetchMarketCap(symbols),
    ]);

    const rows: AuditRow[] = open.map((sig) => {
      const minPct = MIN_PCT_ALPHA;
      const spotVol24h = spotVolMap.get(sig.symbol) ?? null;
      const mcapData = mcapMap.get(sig.symbol) ?? null;
      const marketCapUsd = mcapData?.mcap ?? null;
      const spotPct =
        spotVol24h != null && marketCapUsd != null && marketCapUsd > 0
          ? (spotVol24h / marketCapUsd) * 100
          : null;

      // Только процентный порог от MCap — нет MCap данных → no_data (не отменяем).
      let verdict: AuditRow["verdict"] = "no_data";
      if (spotVol24h !== null && marketCapUsd !== null) {
        const pctOk = spotPct !== null && spotPct >= minPct * 100;
        verdict = pctOk ? "pass" : "cancel";
      }

      return { sig, spotVol24h, marketCapUsd, spotPct, minPct, verdict };
    });

    const toCancel = rows.filter((r) => r.verdict === "cancel");

    // 4. Telegram сводка
    const now = new Date();
    const moscowTime = now.toLocaleString("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });

    function fmtP(p: number): string {
      if (p >= 1) return `$${p.toFixed(3)}`;
      if (p >= 0.01) return `$${p.toFixed(4)}`;
      return `$${p.toFixed(5)}`;
    }
    function computePnl(sig: TrackedSignal, curPrice: number): number {
      if (!sig.entryPrice || sig.entryPrice === 0) return 0;
      const diff = curPrice - sig.entryPrice;
      return ((sig.isShort ? -diff : diff) / sig.entryPrice) * 100;
    }

    const lines: string[] = [
      `🔍 <b>Аудит спот-фильтра</b> — <i>${moscowTime} МСК</i>`,
      ``,
      `Проверено позиций: <b>${open.length}</b>`,
      ``,
    ];

    // Отменённые
    if (toCancel.length > 0) {
      lines.push(`❌ <b>Закрыты принудительно — ${toCancel.length}</b>`);
      for (const r of toCancel) {
        const coin = r.sig.symbol.replace("-USDT", "");
        const pctStr =
          r.spotPct != null ? `${r.spotPct.toFixed(1)}% MCap` : "?% MCap";
        const reqStr = `${(r.minPct * 100).toFixed(0)}%`;
        const curPrice = priceMap.get(r.sig.symbol);
        const pnl = curPrice ? computePnl(r.sig, curPrice) : null;
        const pnlStr =
          pnl != null ? ` | P&L: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : "";
        lines.push(
          `  • <b>${coin}</b> — спот ${pctStr} (нужно ≥${reqStr})${pnlStr}`,
        );
      }
      lines.push(``);
    }

    // Прошли фильтр
    const passed = rows.filter((r) => r.verdict === "pass");
    if (passed.length > 0) {
      lines.push(`✅ <b>Прошли фильтр — ${passed.length}</b>`);
      for (const r of passed) {
        const coin = r.sig.symbol.replace("-USDT", "");
        const pctStr = r.spotPct != null ? `${r.spotPct.toFixed(1)}% MCap` : "";
        const curPrice = priceMap.get(r.sig.symbol);
        const pnl = curPrice ? computePnl(r.sig, curPrice) : null;
        const pnlStr =
          pnl != null ? ` | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%` : "";
        const priceStr = curPrice
          ? ` | ${fmtP(r.sig.entryPrice ?? 0)} → ${fmtP(curPrice)}`
          : "";
        lines.push(`  • <b>${coin}</b> — ${pctStr}${priceStr}${pnlStr}`);
      }
      lines.push(``);
    }

    // Нет данных (не блокировали — но сообщаем)
    const noData = rows.filter((r) => r.verdict === "no_data");
    if (noData.length > 0) {
      lines.push(`⚠️ <b>Нет данных MCap — ${noData.length} (не тронуты)</b>`);
      for (const r of noData) {
        const coin = r.sig.symbol.replace("-USDT", "");
        lines.push(`  • <b>${coin}</b>`);
      }
      lines.push(``);
    }

    lines.push(
      `📋 Итог: закрыто <b>${toCancel.length}</b>, активно <b>${passed.length + noData.length}</b>`,
    );

    if (toCancel.length > 0) {
      const cancelIds = toCancel.map((row) => row.sig.id);
      const closedAt = new Date();
      let claimedIds: number[] = [];
      const delivery = await broadcastPhotoAfterClaim(
        SPOT_AUDIT_CANCEL_IMG,
        lines.join("\n"),
        `cancel:spot_audit:${cancelIds.sort((a, b) => a - b).join(",")}:${now.toISOString()}`,
        async (tx) => {
          const claimed = await tx
            .update(trackedSignalsTable)
            .set({
              status: "cancelled",
              cancelReason: "spot_audit_low_vol",
              closedAt,
              updatedAt: closedAt,
            })
            .where(
              and(
                inArray(trackedSignalsTable.id, cancelIds),
                inArray(trackedSignalsTable.status, [
                  ...OPEN_STATUSES,
                ] as any[]),
                sql`NOT (
                  ${trackedSignalsTable.runnerState} = 'open'
                  AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
                )`,
              ),
            )
            .returning({ id: trackedSignalsTable.id });
          claimedIds = claimed.map((row) => row.id);
          return claimedIds.length > 0;
        },
      );
      if (delivery.claimed) {
        const claimedSet = new Set(claimedIds);
        for (const row of toCancel) {
          if (claimedSet.has(row.sig.id)) {
            void _writeExitMetrics(row.sig.id, row.sig.symbol);
            const _curPrice = priceMap.get(row.sig.symbol);
            const _pct = _curPrice ? computePnl(row.sig, _curPrice) : 0;
            const _accountingEntry =
              row.sig.policyVersion === "impulse_runner_v1"
                ? Number(row.sig.originalEntryPrice)
                : Number(row.sig.entryPrice);
            const _peakPct =
              row.sig.peakPrice != null && _accountingEntry > 0
                ? ((row.sig.peakPrice - _accountingEntry) / _accountingEntry) *
                  100
                : _pct;
            void recordCloseSnapshot(
              {
                id: row.sig.id,
                symbol: row.sig.symbol,
                sentimentKey: row.sig.sentimentKey,
                detectedAt: row.sig.detectedAt,
              },
              _curPrice ?? row.sig.entryPrice ?? 0,
              _pct,
              _peakPct,
              "cancelled",
            );
          }
        }
        logger.info(
          {
            cancelled: toCancel
              .filter((row) => claimedSet.has(row.sig.id))
              .map((row) => row.sig.symbol),
            queued: delivery.queued,
          },
          "spot-audit: принудительно отменены сигналы с низким спот-объёмом",
        );
      }
    } else {
      await adminBroadcast(lines.join("\n"));
    }

    res.json({
      ok: true,
      total: open.length,
      cancelled: toCancel.length,
      passed: passed.length,
      noData: noData.length,
      cancelledSymbols: toCancel.map((r) => r.sig.symbol),
      passedSymbols: passed.map((r) => r.sig.symbol),
      noDataSymbols: noData.map((r) => r.sig.symbol),
    });
  } catch (err) {
    logger.error({ err }, "spot-audit: ошибка");
    res.status(500).json({ error: "Spot audit failed" });
  }
});

// GET /api/debug/signal-metrics — diagnostic endpoint, three modes:
//   ?ids=441,452,...          — by tracked_signal IDs (ts.id)
//   ?signal_ids=427,426,...   — by signals table IDs (ts.signal_id)
//   ?by_pattern=dip_accumulation&status=cancelled&days=60  — by sentimentKey+status
router.get("/debug/signal-metrics", requireAdminToken, async (req, res) => {
  try {
    const COLS = sql`
        ts.id,
        ts.symbol,
        ts.signal_type,
        ts.status,
        ts.cancel_reason,
        to_char(ts.detected_at, 'YYYY-MM-DD HH24:MI') AS detected_at,
        to_char(ts.closed_at,   'YYYY-MM-DD HH24:MI') AS closed_at,
        EXTRACT(EPOCH FROM ts.closed_at) * 1000        AS closed_at_ms,
        ROUND(ts.entry_price::numeric, 6)              AS entry_price,
        ROUND(
           (CASE WHEN ts.status = 'bu_stop' THEN ts.entry_price ELSE ts.exit_price END)::numeric,
          6
        )                                              AS exit_price,
        ts.prescan_cycles,
        ROUND(ts.price_24h_at_fire::numeric, 1)        AS price_24h,
        -- Versioned OI Watch BA sources identify the post-gate clean cohort;
        -- legacy trigger-TF values identify historical bypass-era entries.
        ts.entry_source,
        ROUND(
           (CASE WHEN ts.status IN ('bu_stop', 'breakeven') THEN NULL ELSE ts.pnl_percent END)::numeric,
          2
        )                                              AS pnl,
        ts.entry_cvd_15m                               AS cvd_15m,
        ts.entry_cvd_30m                               AS cvd_30m,
        ts.entry_cvd_1h                                AS cvd_1h,
        ts.entry_cvd_4h                                AS cvd_4h,
        ts.alpha_score,
        ROUND((s.volume_24h / NULLIF(s.avg_volume, 0))::numeric, 2) AS vol_mult_signal,
        ROUND(s.oi_change_percent::numeric, 2)         AS oi_30m_signal,
        ROUND(s.price_change_percent::numeric, 2)      AS price_pct_signal,
        NULL::numeric                                  AS oi_short,
        ROUND(ow.oi_30m::numeric, 2)                   AS oi_30m,
        ROUND(ow.oi_1h::numeric, 2)                    AS oi_1h,
        ROUND(ow.oi_24h::numeric, 2)                   AS oi_24h,
        ROUND(ow.entry_vol_mult::numeric, 2)           AS oi_watch_vol_mult,
        ROUND(ow.volume_multiplier::numeric, 2)        AS oi_watch_vol_at_fire,
        ow.vol_status_reason,
        ow.sentiment_key                               AS oi_watch_pattern,
        ROUND(ow.price_24h_change::numeric, 1)         AS oi_watch_p24h`;

    const JOINS = sql`
      FROM tracked_signals ts
      LEFT JOIN signals s ON ts.signal_id = s.id
      LEFT JOIN LATERAL (
        SELECT * FROM oi_watch
        WHERE symbol = ts.symbol
          AND fired_at IS NOT NULL
          AND fired_at <= ts.detected_at + INTERVAL '5 minutes'
          AND fired_at >= ts.detected_at - INTERVAL '60 minutes'
        ORDER BY fired_at DESC
        LIMIT 1
      ) ow ON true`;

    let rows: Awaited<ReturnType<typeof db.execute>>;

    // Mode 1: by tracked_signal IDs
    const rawIds = req.query.ids as string | undefined;
    // Mode 2: by signals table IDs
    const rawSignalIds = req.query.signal_ids as string | undefined;
    // Mode 3: by sentimentKey + status + days
    const byPattern = req.query.by_pattern as string | undefined;

    if (rawIds) {
      const ids = rawIds
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      if (!ids.length) return res.status(400).json({ error: "no valid ids" });
      rows = await db.execute(
        sql`SELECT ${COLS} ${JOINS} WHERE ts.id IN (${sql.raw(ids.join(","))}) ORDER BY ts.detected_at DESC`,
      );
    } else if (rawSignalIds) {
      const sids = rawSignalIds
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
      if (!sids.length)
        return res.status(400).json({ error: "no valid signal_ids" });
      rows = await db.execute(
        sql`SELECT ${COLS} ${JOINS} WHERE ts.signal_id IN (${sql.raw(sids.join(","))}) ORDER BY ts.detected_at DESC`,
      );
    } else if (byPattern) {
      const status = (req.query.status as string | undefined) ?? "cancelled";
      const days = Math.min(
        parseInt((req.query.days as string | undefined) ?? "90", 10),
        180,
      );
      const statuses = status
        .split(",")
        .map((s) => `'${s.trim().replace(/'/g, "")}'`)
        .join(",");
      rows = await db.execute(sql`SELECT ${COLS} ${JOINS}
        WHERE ts.sentiment_key = ${byPattern}
          AND ts.status IN (${sql.raw(statuses)})
          AND ts.detected_at >= NOW() - INTERVAL '${sql.raw(String(days))} days'
        ORDER BY ts.detected_at DESC LIMIT 100`);
    } else {
      return res
        .status(400)
        .json({ error: "ids, signal_ids, or by_pattern param required" });
    }

    // Fetch BingX post-exit price deltas (+1h / +4h / +24h after closed_at)
    const BX_BASE = "https://open-api.bingx.com";
    async function bxKlinesFrom(
      symbol: string,
      startMs: number,
    ): Promise<{
      p1h: number | null;
      p4h: number | null;
      p24h: number | null;
    }> {
      try {
        const url = `${BX_BASE}/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}&interval=1h&limit=26&startTime=${startMs}`;
        const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
        const j = (await r.json()) as {
          code: number;
          data?: Array<{ open: string; close: string; time: number }>;
        };
        if (j.code !== 0 || !Array.isArray(j.data) || j.data.length === 0)
          return { p1h: null, p4h: null, p24h: null };
        const klines = j.data.sort((a, b) => a.time - b.time);
        const get = (idx: number) =>
          klines[idx] ? parseFloat(klines[idx].close) : null;
        return { p1h: get(1), p4h: get(4), p24h: get(24) };
      } catch {
        return { p1h: null, p4h: null, p24h: null };
      }
    }

    function pctChange(from: number | null, to: number | null): number | null {
      if (from == null || to == null || from === 0) return null;
      return Math.round(((to - from) / from) * 1000) / 10; // 1dp
    }

    // Enrich rows with post-exit price data (parallel, max 5 at a time)
    const dbRows = rows.rows as Record<string, unknown>[];
    const enriched = await Promise.all(
      dbRows.map(async (row) => {
        const closedMs =
          row.closed_at_ms != null ? Number(row.closed_at_ms) : null;
        const exitPrice =
          row.exit_price != null ? Number(row.exit_price) : null;
        const entryPrice =
          row.entry_price != null ? Number(row.entry_price) : null;
        const symbol = String(row.symbol);

        let postExit: {
          p1h: number | null;
          p4h: number | null;
          p24h: number | null;
        } = {
          p1h: null,
          p4h: null,
          p24h: null,
        };
        if (closedMs && closedMs > 0) {
          postExit = await bxKlinesFrom(symbol, closedMs);
        }

        return {
          ...row,
          closed_at_ms: undefined, // remove raw ms from output
          post_exit: {
            ref_price: exitPrice ?? entryPrice, // price at exit point
            price_1h: postExit.p1h,
            price_4h: postExit.p4h,
            price_24h: postExit.p24h,
            pct_1h: pctChange(exitPrice ?? entryPrice, postExit.p1h),
            pct_4h: pctChange(exitPrice ?? entryPrice, postExit.p4h),
            pct_24h: pctChange(exitPrice ?? entryPrice, postExit.p24h),
          },
        };
      }),
    );

    return res.json({ count: enriched.length, data: enriched });
  } catch (err) {
    req.log.error({ err }, "debug/signal-metrics: query failed");
    return res.status(500).json({ error: String(err) });
  }
});

// ── Debug: prescan tracker live data ─────────────────────────────────────────
router.get("/tracker/prescan-debug", requireAdminToken, async (req, res) => {
  const raw = String(req.query.symbols ?? "");
  if (!raw) {
    res.status(400).json({ error: "symbols param required (comma-separated)" });
    return;
  }
  const symbols = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  try {
    const rows = await db
      .select({
        symbol: prescanTrackerTable.symbol,
        cycleCount: prescanTrackerTable.cycleCount,
        lastOi30m: prescanTrackerTable.lastOi30m,
        lastOi1h: prescanTrackerTable.lastOi1h,
        lastOi4h: prescanTrackerTable.lastOi4h,
        cvdPositiveCycles: prescanTrackerTable.cvdPositiveCycles,
        lastCgTimedOut: prescanTrackerTable.lastCgTimedOut,
        updatedAt: prescanTrackerTable.updatedAt,
      })
      .from(prescanTrackerTable)
      .where(inArray(prescanTrackerTable.symbol, symbols));
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "prescan-debug: DB error");
    res.status(500).json({ error: "DB error" });
  }
});

// GET /api/tracker/cancelled-today — отменённые за последние 24ч
router.get("/tracker/cancelled-today", async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select()
      .from(trackedSignalsTable)
      .where(
        sql`
        ${trackedSignalsTable.status} = 'cancelled'
        AND ${trackedSignalsTable.closedAt} >= ${since}
      `,
      )
      .orderBy(desc(trackedSignalsTable.closedAt));
    // Map entry* field names to the same aliases used by /api/tracker so the
    // UI can use consistent field names across all tables without branching.
    res.json({
      signals: rows.map((r) => ({
        ...r,
        oi30m: r.entryOi30m,
        oi1h: r.entryOi1h,
        oi4h: r.entryOi4h,
        oi24h: r.entryOi24h,
        cvd15m: r.entryCvd15m,
        cvd30m: r.entryCvd30m,
        cvd1h: r.entryCvd1h,
        cvd4h: r.entryCvd4h,
        netBuyPct: r.entryFutTakerNetBuy,
        spotTakerNetBuy: r.entrySpotTakerNetBuy,
        price1h: r.entryPrice1h,
        ...computeTokenCoverage(r.symbol),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "cancelled-today error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/admin/tracker/cancellation-replay
// Mature cancellations plus a transparent age-window replay for BA/BG/LC.
// A NULL 72h snapshot is reported as pending and never classified as a recovery.
router.get(
  "/admin/tracker/cancellation-replay",
  requireAdminToken,
  createCancellationReplayHandler((query) => db.execute(query)),
);

// GET /api/tracker/be-threshold-analysis — read-only +5/+8/+10 BE replay.
// Returns summaries only; raw signal trajectories stay behind the owner endpoint.
router.get("/tracker/be-threshold-analysis", async (req, res) => {
  try {
    const [coverageResult, rowsResult] = await Promise.all([
      db.execute(sql`
        SELECT
          ts.sentiment_key AS pattern,
          COUNT(DISTINCT ts.id)::int AS total_bu_stops,
          COUNT(DISTINCT bfs.tracked_signal_id)::int AS observed_signals,
          COUNT(DISTINCT bfs.tracked_signal_id) FILTER (
            WHERE bfs.hour_after_close = 72
          )::int AS completed_72h
        FROM tracked_signals ts
        LEFT JOIN bu_stop_followup_snapshots bfs
          ON bfs.tracked_signal_id = ts.id
        WHERE ts.status = 'bu_stop'
          AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
        GROUP BY ts.sentiment_key
      `),
      db.execute(sql`
        SELECT
          ts.id,
          ts.symbol,
          ts.sentiment_key AS pattern,
          ts.closed_at,
          bfs.hour_after_close,
          bfs.move_pct
        FROM tracked_signals ts
        INNER JOIN bu_stop_followup_snapshots bfs
          ON bfs.tracked_signal_id = ts.id
        WHERE ts.status = 'bu_stop'
          AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          AND ts.closed_at <= NOW() - INTERVAL '72 hours'
          AND bfs.hour_after_close BETWEEN 1 AND 72
        ORDER BY ts.sentiment_key ASC, ts.closed_at ASC, bfs.hour_after_close ASC
      `),
    ]);

    const trajectoryMap = new Map<
      number,
      {
        id: number;
        symbol: string;
        pattern: string | null;
        closedAt: string | null;
        samples: { hourAfterClose: number; movePct: number }[];
      }
    >();
    for (const row of rowsResult.rows) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      const trajectory = trajectoryMap.get(id) ?? {
        id,
        symbol: String(row.symbol ?? ""),
        pattern: row.pattern == null ? null : String(row.pattern),
        closedAt: row.closed_at == null ? null : String(row.closed_at),
        samples: [],
      };
      const hourAfterClose = Number(row.hour_after_close);
      const movePct = Number(row.move_pct);
      if (Number.isInteger(hourAfterClose) && Number.isFinite(movePct)) {
        trajectory.samples.push({ hourAfterClose, movePct });
      }
      trajectoryMap.set(id, trajectory);
    }

    const trajectories = [...trajectoryMap.values()];
    const analysisMap = new Map(
      analyzeBuStopThresholdsByPattern(trajectories).map((row) => [
        row.pattern,
        row.analysis,
      ]),
    );
    const coverageMap = new Map(
      coverageResult.rows.map((row) => [
        String(row.pattern),
        {
          totalBuStops: Number(row.total_bu_stops ?? 0),
          observedSignals: Number(row.observed_signals ?? 0),
          completed72h: Number(row.completed_72h ?? 0),
        },
      ]),
    );

    res.json({
      generatedAt: new Date().toISOString(),
      observationOnly: true,
      liveRuleChanged: false,
      global: analyzeBuStopThresholds(trajectories),
      byPattern: ACTIVE_PATTERN_KEYS.map((pattern) => ({
        pattern,
        ...(coverageMap.get(pattern) ?? {
          totalBuStops: 0,
          observedSignals: 0,
          completed72h: 0,
        }),
        analysis: analysisMap.get(pattern) ?? analyzeBuStopThresholds([]),
      })),
      methodology: {
        thresholds: [5, 8, 10],
        minimumHourlySamples: 60,
        exactHour72Required: true,
        minimumMatureTradesPerPattern: 10,
        note: "Почасовые ticker-снимки не доказывают intrahour порядок касаний. Рекомендации наблюдательные и не меняют live BE.",
      },
    });
  } catch (err) {
    req.log.error({ err }, "BE threshold analysis failed");
    res.status(500).json({ error: "BE threshold analysis failed" });
  }
});

// GET /api/admin/tracker/bu-stop-followup — hourly 72h outcome audit for BE stops.
router.get(
  "/admin/tracker/bu-stop-followup",
  requireAdminToken,
  async (req, res) => {
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "100")) || 100, 1),
      500,
    );
    const signalId = Number(req.query.signalId);

    try {
      const [summaryResult, signalsResult, samplesResult, analysisRowsResult] =
        await Promise.all([
          db.execute(sql`
          SELECT
            COUNT(DISTINCT ts.id)::int AS total_bu_stops,
            COUNT(DISTINCT bfs.tracked_signal_id)::int AS observed_signals,
            COUNT(DISTINCT bfs.tracked_signal_id) FILTER (
              WHERE bfs.hour_after_close = 72
            )::int AS completed_72h,
            ROUND(MAX(bfs.move_pct)::numeric, 2)::float4 AS best_observed_move_pct,
            ROUND(MIN(bfs.move_pct)::numeric, 2)::float4 AS worst_observed_move_pct
          FROM tracked_signals ts
          LEFT JOIN bu_stop_followup_snapshots bfs
            ON bfs.tracked_signal_id = ts.id
          WHERE ts.status = 'bu_stop'
        `),
          db.execute(sql`
          SELECT
            ts.id,
            ts.symbol,
            ts.sentiment_key AS pattern,
            ts.closed_at,
            ts.exit_price,
            COUNT(bfs.id)::int AS hourly_samples,
            MAX(bfs.hour_after_close)::int AS last_observed_hour,
            ROUND(MAX(bfs.move_pct)::numeric, 2)::float4 AS peak_move_pct,
            ROUND(MIN(bfs.move_pct)::numeric, 2)::float4 AS trough_move_pct,
            ROUND(MAX(bfs.move_pct) FILTER (
              WHERE bfs.hour_after_close = 72
            )::numeric, 2)::float4 AS move_pct_at_72h
          FROM tracked_signals ts
          LEFT JOIN bu_stop_followup_snapshots bfs
            ON bfs.tracked_signal_id = ts.id
          WHERE ts.status = 'bu_stop'
          GROUP BY ts.id, ts.symbol, ts.sentiment_key, ts.closed_at, ts.exit_price
          ORDER BY ts.closed_at DESC
          LIMIT ${limit}
        `),
          Number.isInteger(signalId) && signalId > 0
            ? db.execute(sql`
              SELECT hour_after_close, observed_at, price, move_pct
              FROM bu_stop_followup_snapshots
              WHERE tracked_signal_id = ${signalId}
              ORDER BY hour_after_close ASC
            `)
            : Promise.resolve({ rows: [] }),
          db.execute(sql`
          SELECT
            ts.id,
            ts.symbol,
            ts.sentiment_key AS pattern,
            ts.closed_at,
            bfs.hour_after_close,
            bfs.move_pct
          FROM tracked_signals ts
          INNER JOIN bu_stop_followup_snapshots bfs
            ON bfs.tracked_signal_id = ts.id
          WHERE ts.status = 'bu_stop'
            AND ts.sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
            AND ts.closed_at <= NOW() - INTERVAL '72 hours'
            AND bfs.hour_after_close BETWEEN 1 AND 72
          ORDER BY ts.sentiment_key ASC, ts.closed_at ASC, bfs.hour_after_close ASC
        `),
        ]);

      const trajectoryMap = new Map<
        number,
        {
          id: number;
          symbol: string;
          pattern: string | null;
          closedAt: string | null;
          samples: { hourAfterClose: number; movePct: number }[];
        }
      >();
      for (const row of analysisRowsResult.rows) {
        const id = Number(row.id);
        if (!Number.isFinite(id)) continue;
        const trajectory = trajectoryMap.get(id) ?? {
          id,
          symbol: String(row.symbol ?? ""),
          pattern: row.pattern == null ? null : String(row.pattern),
          closedAt: row.closed_at == null ? null : String(row.closed_at),
          samples: [],
        };
        const hourAfterClose = Number(row.hour_after_close);
        const movePct = Number(row.move_pct);
        if (Number.isInteger(hourAfterClose) && Number.isFinite(movePct)) {
          trajectory.samples.push({ hourAfterClose, movePct });
        }
        trajectoryMap.set(id, trajectory);
      }
      const trajectories = [...trajectoryMap.values()];
      const thresholdAnalysis = analyzeBuStopThresholds(trajectories);
      const thresholdAnalysisByPattern =
        analyzeBuStopThresholdsByPattern(trajectories);
      const liquidationCascadeThresholdAnalysis =
        thresholdAnalysisByPattern.find(
          (row) => row.pattern === "liquidation_cascade",
        )?.analysis ?? analyzeBuStopThresholds([]);

      res.json({
        ok: true,
        summary: summaryResult.rows[0] ?? {},
        signals: signalsResult.rows,
        samples: samplesResult.rows,
        thresholdAnalysis,
        thresholdAnalysisByPattern,
        liquidationCascadeThresholdAnalysis,
        notes: [
          "move_pct is direction-aware movement from the BE exit price: positive means the original trade direction continued.",
          "Hourly observations are approximate ticker snapshots, not intra-hour highs or lows.",
          "Pass signalId to return the full hourly trajectory for one BE stop.",
          "thresholdAnalysis includes mature BE stops from every active pattern; thresholdAnalysisByPattern applies the same qualification independently to each pattern.",
          "liquidationCascadeThresholdAnalysis preserves the previous LC-only view for compatibility.",
          "continuation means the trajectory exceeded the candidate threshold; protectionLostCount for +8/+10 means the higher level was never reached and the trajectory later moved below the actual BE level.",
          "All recommendations are observational only and never change live exit rules automatically.",
        ],
      });
    } catch (err) {
      req.log.error({ err }, "BE stop follow-up audit failed");
      res.status(500).json({ error: "BE stop follow-up audit failed" });
    }
  },
);

// POST /api/admin/fix-bustop-history — migrate misclassified stop_loss → bu_stop for signals with last_milestone >= 5
router.post(
  "/admin/fix-bustop-history",
  requireAdminToken,
  async (req, res) => {
    try {
      const result = await db.execute(sql`
      UPDATE tracked_signals
      SET status = 'bu_stop', updated_at = NOW()
      WHERE status = 'stop_loss'
        AND last_milestone IS NOT NULL
        AND last_milestone >= 5
    `);
      const count = (result as any).rowCount ?? (result as any).count ?? "?";
      req.log.info(
        { count },
        "admin/fix-bustop-history: migrated stop_loss → bu_stop",
      );
      res.json({ ok: true, updated: count });
    } catch (err) {
      req.log.error({ err }, "admin/fix-bustop-history error");
      res.status(500).json({ error: String(err) });
    }
  },
);

// POST /api/admin/rerun-oi-backfill — manually re-trigger OI history backfill for remaining NULL rows
router.post("/admin/rerun-oi-backfill", requireAdminToken, async (req, res) => {
  try {
    backfillOiHistoryAfterCollisionCleanup().catch((err) => {
      req.log.error({ err }, "admin/rerun-oi-backfill background error");
    });
    res.json({ ok: true, started: true });
  } catch (err) {
    req.log.error({ err }, "admin/rerun-oi-backfill error");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/admin/resend-milestone — resend milestone photo for a signal
router.post("/admin/resend-milestone", requireAdminToken, async (req, res) => {
  const { symbol, milestone } = req.body as {
    symbol?: string;
    milestone?: number;
  };
  if (!symbol || !milestone) {
    res.status(400).json({ error: "symbol and milestone required" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(trackedSignalsTable)
      .where(
        and(
          eq(trackedSignalsTable.symbol, symbol.toUpperCase()),
          inArray(trackedSignalsTable.status, ["in_run", "active"] as any[]),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: `No active/in_run signal found for ${symbol}` });
      return;
    }
    const tracked = rows[0]!;
    const MILESTONE_IMGS: Record<number, string> = {
      10: new URL("../../assets/milestone10.png", import.meta.url).pathname,
      15: new URL("../../assets/milestone15.png", import.meta.url).pathname,
      25: new URL("../../assets/moonshot.png", import.meta.url).pathname,
      50: new URL("../../assets/milestone50.png", import.meta.url).pathname,
      100: new URL("../../assets/milestone100.png", import.meta.url).pathname,
    };
    const imgPath =
      tracked.symbol === "BTC-USDT" ||
      tracked.symbol === "BTCUSDT" ||
      milestone > 200
        ? new URL("../../assets/target_hit.png", import.meta.url).pathname
        : MILESTONE_IMGS[milestone];
    const currentPrice =
      tracked.exitPrice ?? tracked.peakPrice ?? tracked.entryPrice;
    const trailingStop = resolveTrailingStopLevel({
      entryPrice: tracked.entryPrice,
      peakPrice: tracked.peakPrice ?? currentPrice,
      trailingGapPercent: getExitProfile(tracked.sentimentKey, tracked.symbol)
        .trailingGap,
      persistedTrailingStopLevel: tracked.trailingStopLevel,
    });
    const text = msgMilestone(tracked, milestone, currentPrice, trailingStop);
    if (imgPath) {
      await broadcastPhoto(imgPath, text);
    } else {
      await adminBroadcast(text);
    }
    req.log.info({ symbol, milestone }, "admin/resend-milestone sent");
    res.json({ ok: true, symbol, milestone, withPhoto: !!imgPath });
  } catch (err) {
    req.log.error({ err }, "admin/resend-milestone error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tracker/signal-history — полная история из trackedSignalsTable со всеми entry metrics
router.get("/tracker/signal-history", async (req, res) => {
  try {
    const queryKeys = [
      "status",
      "sort",
      "from",
      "to",
      "dateBasis",
      "pnlSign",
      "metric",
      "scope",
      "limit",
      "offset",
      "pattern",
      "symbol",
    ];
    if (queryKeys.some((key) => Array.isArray(req.query[key]))) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    for (const key of ["limit", "offset"]) {
      const raw = req.query[key];
      if (raw !== undefined && !/^\d+$/.test(String(raw))) {
        res.status(400).json({ error: "Invalid pagination" });
        return;
      }
    }
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const status = req.query.status as string | undefined;
    const sort = req.query.sort as string | undefined;
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;
    const dateBasis = (req.query.dateBasis as string | undefined) ?? "detected";
    const pnlSign = req.query.pnlSign as string | undefined;
    const metric = req.query.metric as string | undefined;
    const scope = req.query.scope as string | undefined;
    const pattern = req.query.pattern as string | undefined;
    const symbol = ((req.query.symbol as string) || "").trim().toUpperCase();
    if (scope && scope !== "archive") {
      res.status(400).json({ error: "Invalid scope" });
      return;
    }
    const ownerArchive = isOwnerDashboardRequest(req);
    const allowedSorts = new Set([
      "detectedAt",
      "closedAt",
      "pattern",
      "pnl_asc",
      "pnl_desc",
    ]);
    const allowedStatuses = new Set([
      "all",
      "open",
      "closed",
      "neutral_close",
      "bu_stop_5",
      "bu_stop_8",
      "bu_stop_10",
      "win_rate",
      "profit",
      "stop_loss",
      "cancelled",
      "breakeven",
      "bu_stop",
      "expired",
      "active",
      "in_run",
    ]);
    if (status && !allowedStatuses.has(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }
    if (sort && !allowedSorts.has(sort)) {
      res.status(400).json({ error: "Invalid sort" });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || offset < 0) {
      res.status(400).json({ error: "Invalid pagination" });
      return;
    }

    if (dateBasis !== "detected" && dateBasis !== "closed") {
      res.status(400).json({ error: "Invalid dateBasis" });
      return;
    }
    if (pnlSign && pnlSign !== "positive" && pnlSign !== "negative") {
      res.status(400).json({ error: "Invalid pnlSign" });
      return;
    }
    const fromDate = fromParam ? new Date(fromParam) : undefined;
    const toDate = toParam ? new Date(toParam) : undefined;
    if (
      (fromDate && Number.isNaN(fromDate.getTime())) ||
      (toDate && Number.isNaN(toDate.getTime()))
    ) {
      res.status(400).json({ error: "Invalid date range" });
      return;
    }
    if (fromDate && toDate && fromDate >= toDate) {
      res.status(400).json({ error: "Invalid date range" });
      return;
    }
    if (!ownerArchive) {
      if (!fromDate || !toDate) {
        if (scope === "archive") {
          res.status(403).json({ error: "Owner authorization required" });
          return;
        }
      } else {
        const overlapsProtected = [...OWNER_ONLY_ARCHIVE_MONTHS].some(
          (month) => {
            const [year, monthNumber] = month.split("-").map(Number);
            const start = new Date(
              Date.UTC(year, monthNumber - 1, 1) - 4 * 3600_000,
            );
            const end = new Date(Date.UTC(year, monthNumber, 1) - 4 * 3600_000);
            return fromDate < end && toDate > start;
          },
        );
        if (overlapsProtected) {
          res.status(403).json({ error: "Owner authorization required" });
          return;
        }
      }
    }
    if (scope === "archive" && !ownerArchive) {
      if (!fromDate || !toDate) {
        res.status(403).json({ error: "Owner authorization required" });
        return;
      }
      const overlapsProtected = [...OWNER_ONLY_ARCHIVE_MONTHS].some((month) => {
        const [year, monthNumber] = month.split("-").map(Number);
        const start = new Date(
          Date.UTC(year, monthNumber - 1, 1) - 4 * 3600_000,
        );
        const end = new Date(Date.UTC(year, monthNumber, 1) - 4 * 3600_000);
        return fromDate < end && toDate > start;
      });
      if (overlapsProtected) {
        res.status(403).json({ error: "Owner authorization required" });
        return;
      }
    }
    if (status === "neutral_close" && (metric || pnlSign)) {
      res.status(400).json({
        error: "Neutral administrative closes do not have PnL metrics",
      });
      return;
    }

    const conditions: ReturnType<typeof eq>[] = [
      (scope === "archive"
        ? inArray(trackedSignalsTable.sentimentKey, [
            ...ACTIVE_PATTERN_KEYS,
            ...DEAD_PATTERN_KEYS,
            ...PRESERVED_DECOMMISSIONED_PATTERN_KEYS,
          ])
        : status === "open"
          ? inArray(trackedSignalsTable.sentimentKey, OPEN_TRACKER_PATTERN_KEYS)
          : status === "closed" || status === "neutral_close"
            ? or(activeTrackedPatternCondition(), neutralCloseCondition)
            : activeTrackedPatternCondition()) as any,
    ];
    if (symbol) {
      const searchTerm = symbol.includes("-") ? symbol : `%${symbol}%`;
      conditions.push(
        ilike(
          trackedSignalsTable.symbol,
          searchTerm.includes("%") ? searchTerm : `%${searchTerm}%`,
        ) as any,
      );
    }

    if (status && status !== "all" && !metric) {
      if (status === "open") {
        conditions.push(
          inArray(trackedSignalsTable.status, ["active", "in_run"]) as any,
        );
      } else if (status === "closed") {
        conditions.push(
          or(
            inArray(trackedSignalsTable.status, [
              "profit",
              "stop_loss",
              "cancelled",
              "breakeven",
              "bu_stop",
              "expired",
            ]),
            neutralCloseCondition,
          ) as any,
        );
      } else if (status === "neutral_close") {
        conditions.push(neutralCloseCondition as any);
      } else if (status === "bu_stop_5") {
        conditions.push(
          and(
            eq(trackedSignalsTable.status, "bu_stop"),
            sql`${trackedSignalsTable.lastMilestone} >= 5`,
            sql`${trackedSignalsTable.lastMilestone} < 8`,
          ) as any,
        );
      } else if (status === "bu_stop_8") {
        conditions.push(
          and(
            eq(trackedSignalsTable.status, "bu_stop"),
            sql`${trackedSignalsTable.lastMilestone} >= 8`,
            sql`${trackedSignalsTable.lastMilestone} < 10`,
          ) as any,
        );
      } else if (status === "bu_stop_10") {
        conditions.push(
          and(
            eq(trackedSignalsTable.status, "bu_stop"),
            sql`${trackedSignalsTable.lastMilestone} >= 10`,
          ) as any,
        );
      } else if (status === "win_rate") {
        conditions.push(
          inArray(trackedSignalsTable.status, [
            "profit",
            "bu_stop",
            "stop_loss",
          ]) as any,
        );
      } else {
        conditions.push(eq(trackedSignalsTable.status, status as any));
      }
    }

    if (pattern && pattern !== "all") {
      conditions.push(eq(trackedSignalsTable.sentimentKey, pattern));
    }

    const dateColumn =
      status === "neutral_close" || dateBasis === "detected"
        ? sql<Date>`${trackedSignalsTable.detectedAt}`
        : sql<Date>`CASE WHEN ${neutralCloseCondition}
                     THEN ${trackedSignalsTable.detectedAt}
                     ELSE ${trackedSignalsTable.closedAt} END`;
    if (!ownerArchive) {
      const protectedMonthPredicates = [...OWNER_ONLY_ARCHIVE_MONTHS].map(
        (month) =>
          sql`to_char(${dateColumn} + interval '4 hours', 'YYYY-MM') = ${month}`,
      );
      conditions.push(
        sql`NOT (${sql.join(protectedMonthPredicates, sql` OR `)})` as any,
      );
    }
    if (fromDate) conditions.push(gte(dateColumn, fromDate) as any);
    if (toDate) conditions.push(lt(dateColumn, toDate) as any);
    if (pnlSign === "positive") {
      conditions.push(gt(normalizedTrackedPnlSql(), 0) as any);
    } else if (pnlSign === "negative") {
      conditions.push(sql`${normalizedTrackedPnlSql()} < 0` as any);
    }
    const metricStatuses: Record<string, string[]> = {
      win_rate: ["profit", "bu_stop", "stop_loss"],
      measurable_pnl: ["profit", "stop_loss", "expired", "cancelled"],
      current_measurable_pnl: ["profit", "stop_loss", "cancelled"],
      avg_profit: ["profit", "stop_loss", "expired"],
      avg_loss: ["profit", "stop_loss", "expired"],
      best_trade: ["profit"],
      worst_trade: ["stop_loss"],
      avg_peak: ["profit", "stop_loss", "breakeven", "bu_stop"],
      monthly_avg_peak: ["profit", "stop_loss"],
      monthly_pattern_avg_peak: [
        "profit",
        "stop_loss",
        "breakeven",
        "expired",
        "bu_stop",
      ],
      monthly_pattern_duration: [
        "profit",
        "stop_loss",
        "breakeven",
        "expired",
        "bu_stop",
      ],
      current_last_signal: [
        "profit",
        "stop_loss",
        "cancelled",
        "breakeven",
        "bu_stop",
      ],
      last_signal: [
        "profit",
        "stop_loss",
        "cancelled",
        "breakeven",
        "bu_stop",
        "expired",
      ],
    };
    if (metric) {
      if (!metricStatuses[metric]) {
        res.status(400).json({ error: "Invalid metric" });
        return;
      }
      conditions.push(
        inArray(
          trackedSignalsTable.status,
          metricStatuses[metric] as any,
        ) as any,
      );
      if (metric === "avg_profit")
        conditions.push(gt(normalizedTrackedPnlSql(), 0) as any);
      if (metric === "avg_loss")
        conditions.push(lt(normalizedTrackedPnlSql(), 0) as any);
      if (metric === "monthly_pattern_duration") {
        conditions.push(
          sql`${trackedSignalsTable.closedAt} IS NOT NULL
              AND ${trackedSignalsTable.closedAt} >= ${trackedSignalsTable.detectedAt}` as any,
        );
      }
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [countRow, rows] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(trackedSignalsTable)
        .where(where),
      db
        .select({
          id: trackedSignalsTable.id,
          signalId: trackedSignalsTable.signalId,
          stealthRangeConfirmingVenues:
            signalsTable.stealthRangeConfirmingVenues,
          symbol: trackedSignalsTable.symbol,
          signalType: trackedSignalsTable.signalType,
          sentimentKey: trackedSignalsTable.sentimentKey,
          alphaScore: trackedSignalsTable.alphaScore,
          isShort: trackedSignalsTable.isShort,
          status: trackedSignalsTable.status,
          entryPrice: trackedSignalsTable.entryPrice,
          exitPrice: trackedSignalsTable.exitPrice,
          pnlPercent: trackedSignalsTable.pnlPercent,
          lastMilestone: trackedSignalsTable.lastMilestone,
          peakPrice: trackedSignalsTable.peakPrice,
          detectedAt: trackedSignalsTable.detectedAt,
          closedAt: trackedSignalsTable.closedAt,
          cancelReason: trackedSignalsTable.cancelReason,
          price24hAtFire: trackedSignalsTable.price24hAtFire,
          prescanCycles: trackedSignalsTable.prescanCycles,
          entrySource: trackedSignalsTable.entrySource,
          stopLossPct: trackedSignalsTable.stopLossPct,
          stopSource: trackedSignalsTable.stopSource,
          policyVersion: trackedSignalsTable.policyVersion,
          runnerState: trackedSignalsTable.runnerState,
          coreClosedAt: trackedSignalsTable.coreClosedAt,
          coreExitPrice: trackedSignalsTable.coreExitPrice,
          corePnlPercent: trackedSignalsTable.corePnlPercent,
          runnerPeakPrice: trackedSignalsTable.runnerPeakPrice,
          runnerTrailingStopLevel: trackedSignalsTable.runnerTrailingStopLevel,
          runnerTrailingStopArmedAt:
            trackedSignalsTable.runnerTrailingStopArmedAt,
          runnerExitPrice: trackedSignalsTable.runnerExitPrice,
          runnerPnlPercent: trackedSignalsTable.runnerPnlPercent,
          runnerClosedAt: trackedSignalsTable.runnerClosedAt,
          originalEntryPrice: trackedSignalsTable.originalEntryPrice,
          // OI entry metrics
          entryOi15m: trackedSignalsTable.entryOi15m,
          entryOi30m: trackedSignalsTable.entryOi30m,
          entryOi1h: trackedSignalsTable.entryOi1h,
          entryOi4h: trackedSignalsTable.entryOi4h,
          entryOi24h: trackedSignalsTable.entryOi24h,
          // CVD entry metrics
          entryCvd15m: trackedSignalsTable.entryCvd15m,
          entryCvd30m: trackedSignalsTable.entryCvd30m,
          entryCvd1h: trackedSignalsTable.entryCvd1h,
          entryCvd4h: trackedSignalsTable.entryCvd4h,
          // Volume entry metrics
          entrySpotVolMult: trackedSignalsTable.entrySpotVolMult,
          entryFutVolMult: trackedSignalsTable.entryFutVolMult,
          entrySpotVol24h: trackedSignalsTable.entrySpotVol24h,
          entrySpotMcapPct: trackedSignalsTable.entrySpotMcapPct,
          entryFutTakerNetBuy: trackedSignalsTable.entryFutTakerNetBuy,
          entrySpotTakerNetBuy: trackedSignalsTable.entrySpotTakerNetBuy,
          entrySpotNetBuy1h: trackedSignalsTable.entrySpotNetBuy1h,
          entrySpotNetBuy4h: trackedSignalsTable.entrySpotNetBuy4h,
          entrySpotNetBuy24h: trackedSignalsTable.entrySpotNetBuy24h,
          entryPrice1h: trackedSignalsTable.entryPrice1h,
          entryFundingRate: trackedSignalsTable.entryFundingRate,
          entryBtc24h: trackedSignalsTable.entryBtc24h,
          entryBtcPrice: trackedSignalsTable.entryBtcPrice,
          closeBtc24h: trackedSignalsTable.closeBtc24h,
          closeBtcPrice: trackedSignalsTable.closeBtcPrice,
          entryWhaleIndex: trackedSignalsTable.entryWhaleIndex,
          // Market context
          marketCapUsd: trackedSignalsTable.marketCapUsd,
          // Liquidation Cascade specific
          entryLiqLong1h: trackedSignalsTable.entryLiqLong1h,
          entryLiqLong24h: trackedSignalsTable.entryLiqLong24h,
          entryLiqRatio: trackedSignalsTable.entryLiqRatio,
          entryLiqReason: trackedSignalsTable.entryLiqReason,
          // Orderbook
          entryObRatio: trackedSignalsTable.entryObRatio,
          // Volume context for bid wall % calculation (joined from signals table)
          entryFutVol24h: signalsTable.volume24h,
          // ── Exit metrics: снапшот в момент закрытия (2026-07-30) ──────────
          exitOi30m: trackedSignalsTable.exitOi30m,
          exitOi1h: trackedSignalsTable.exitOi1h,
          exitOi4h: trackedSignalsTable.exitOi4h,
          exitOi24h: trackedSignalsTable.exitOi24h,
          exitCvd15m: trackedSignalsTable.exitCvd15m,
          exitCvd30m: trackedSignalsTable.exitCvd30m,
          exitCvd1h: trackedSignalsTable.exitCvd1h,
          exitCvd4h: trackedSignalsTable.exitCvd4h,
          exitWhaleIndex: trackedSignalsTable.exitWhaleIndex,
          exitSpotTakerNetBuy: trackedSignalsTable.exitSpotTakerNetBuy,
          exitFutTakerNetBuy: trackedSignalsTable.exitFutTakerNetBuy,
          exitSpotNetBuy1h: trackedSignalsTable.exitSpotNetBuy1h,
          exitSpotVol1h: trackedSignalsTable.exitSpotVol1h,
          exitSpotVolMult: trackedSignalsTable.exitSpotVolMult,
          exitFutVolMult: trackedSignalsTable.exitFutVolMult,
          exitFundingRate: trackedSignalsTable.exitFundingRate,
          exitPrice1h: trackedSignalsTable.exitPrice1h,
          exitPrice24h: trackedSignalsTable.exitPrice24h,
          exitFutSpotRatio: trackedSignalsTable.exitFutSpotRatio,
          // Intraday adverse excursion collected by FastCycle.
          drawdownMinPct: signalDrawdownExtremaTable.minPctFromEntry,
          drawdownMinPrice: signalDrawdownExtremaTable.priceAtMin,
          drawdownMinObservedAt: signalDrawdownExtremaTable.minObservedAt,
          drawdownMinElapsedMs: signalDrawdownExtremaTable.minElapsedMs,
          drawdownSource: signalDrawdownExtremaTable.source,
          drawdownStatusAtMin: signalDrawdownExtremaTable.statusAtMin,
          // Custom TradingView AltBullet Neon 4H observation at fire time.
          altBulletStatus: altBulletIndicatorSnapshotsTable.status,
          altBulletIndicatorVersion:
            altBulletIndicatorSnapshotsTable.indicatorVersion,
          altBulletCapturedAt: altBulletIndicatorSnapshotsTable.capturedAt,
          altBulletScore: altBulletIndicatorSnapshotsTable.score,
          altBulletVerdict: altBulletIndicatorSnapshotsTable.verdict,
          altBulletChecks: altBulletIndicatorSnapshotsTable.checks,
          altBulletContext: altBulletIndicatorSnapshotsTable.context,
          altBulletAudit: altBulletIndicatorSnapshotsTable.audit,
          altBulletError: altBulletIndicatorSnapshotsTable.error,
        })
        .from(trackedSignalsTable)
        .leftJoin(
          signalsTable,
          eq(trackedSignalsTable.signalId, signalsTable.id),
        )
        .leftJoin(
          signalDrawdownExtremaTable,
          eq(trackedSignalsTable.id, signalDrawdownExtremaTable.signalId),
        )
        .leftJoin(
          altBulletIndicatorSnapshotsTable,
          eq(
            trackedSignalsTable.signalId,
            altBulletIndicatorSnapshotsTable.signalId,
          ),
        )
        .where(where)
        .orderBy(
          sort === "pattern"
            ? sql`
                CASE ${trackedSignalsTable.sentimentKey}
                  WHEN 'liquidation_cascade' THEN 0
                  WHEN 'balanced_grind' THEN 2
                  WHEN 'stealth_breakout' THEN 3
                  WHEN 'neon_support_bounce' THEN 4
                  WHEN 'price_led_momentum' THEN 5
                  WHEN 'impulse_buy' THEN 6
                  ELSE 99
                END ASC,
                ${trackedSignalsTable.detectedAt} DESC
              `
            : sort === "closedAt"
              ? sql`COALESCE(${trackedSignalsTable.closedAt}, ${trackedSignalsTable.detectedAt}) DESC`
              : sort === "pnl_asc"
                ? sql`${normalizedTrackedPnlSql()} ASC NULLS LAST, ${trackedSignalsTable.detectedAt} DESC`
                : sort === "pnl_desc"
                  ? sql`${normalizedTrackedPnlSql()} DESC NULLS LAST, ${trackedSignalsTable.detectedAt} DESC`
                  : desc(trackedSignalsTable.detectedAt),
        )
        .limit(limit)
        .offset(offset),
    ]);
    const stealthSources = await loadStealthLevelSources(
      rows
        .filter((row) => row.sentimentKey === "stealth_breakout")
        .map((row) => row.signalId),
    );
    const stealthEntryPaths = await loadStealthEntryPaths(
      rows
        .filter((row) => row.sentimentKey === "stealth_breakout")
        .map((row) => row.signalId),
    );

    const whaleObTimeframes = await loadWhaleObTimeframes(
      rows
        .filter((row) => row.sentimentKey === "whale_watch")
        .map((row) => row.signalId),
    );

    res.json({
      total: countRow[0]?.count ?? 0,
      signals: rows.map((r) => ({
        ...r,
        whaleObTimeframe:
          r.sentimentKey === "whale_watch" && r.signalId != null
            ? (whaleObTimeframes.get(r.signalId) ?? null)
            : null,
        stealthLevelSource:
          r.sentimentKey === "stealth_breakout" && r.signalId != null
            ? (stealthSources.get(r.signalId) ?? null)
            : null,
        stealthEntryPath:
          r.sentimentKey === "stealth_breakout" && r.signalId != null
            ? (stealthEntryPaths.get(r.signalId) ?? null)
            : null,
        exitPrice:
          r.status === "bu_stop" ? (r.exitPrice ?? r.entryPrice) : r.exitPrice,
        pnlPercent:
          r.policyVersion === "impulse_runner_v1" && r.runnerState === "open"
            ? null
            : normalizeClosedPnlPercent(r.status, r.pnlPercent, r.sentimentKey),
        pnlDisplayMode:
          r.policyVersion === "impulse_runner_v1" && r.runnerState === "open"
            ? "runner_live_required"
            : "final",
        // Canonical final PnL is the pure runner return from original entry.
        // Core/runner values below are component telemetry only.
        pnlPercentLabel: "runner final (original entry)",
        buStopTakePct: getBuStopTakePct(r.status, r.lastMilestone),
        estimatedBuStopPnlPercent: getEstimatedBuStopPnlPercent(
          r.status,
          r.lastMilestone,
        ),
        exitPolicy:
          r.policyVersion != null
            ? {
                version: r.policyVersion,
                runnerState: r.runnerState,
                core: {
                  exitPrice: r.coreExitPrice,
                  pnlPercent: r.corePnlPercent,
                  closedAt: r.coreClosedAt?.toISOString() ?? null,
                },
                runner: {
                  resultLabel: "runner result",
                  peakPrice: r.runnerPeakPrice,
                  trailingStopLevel: r.runnerTrailingStopLevel,
                  trailingStopArmedAt:
                    r.runnerTrailingStopArmedAt?.toISOString() ?? null,
                  exitPrice: r.runnerExitPrice,
                  pnlPercent: r.runnerPnlPercent,
                  closedAt: r.runnerClosedAt?.toISOString() ?? null,
                },
              }
            : null,
        detectedAt: r.detectedAt.toISOString(),
        altBulletCapturedAt: r.altBulletCapturedAt?.toISOString() ?? null,
        closedAt: r.closedAt?.toISOString() ?? null,
        peakPct:
          r.peakPrice &&
          (r.policyVersion === "impulse_runner_v1"
            ? Number(r.originalEntryPrice) > 0
            : r.entryPrice && r.entryPrice > 0)
            ? ((r.peakPrice -
                (r.policyVersion === "impulse_runner_v1"
                  ? Number(r.originalEntryPrice)
                  : r.entryPrice)) /
                (r.policyVersion === "impulse_runner_v1"
                  ? Number(r.originalEntryPrice)
                  : r.entryPrice)) *
              100
            : null,
        entryFundingRate:
          r.entryFundingRate != null
            ? r.entryFundingRate * 100 // raw decimal → percent
            : null,
        exitFundingRate:
          r.exitFundingRate != null
            ? r.exitFundingRate * 100 // raw decimal → percent
            : null,
        drawdownMinObservedAt: r.drawdownMinObservedAt?.toISOString() ?? null,
        ...computeTokenCoverage(r.symbol),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "signal-history error");
    res.status(500).json({ error: "Failed to get signal history" });
  }
});

// GET /api/tracker/trailing-analysis — observational comparison of virtual
// trailing profiles. This endpoint is deliberately read-only: its output is
// never used by watcher entry or exit decisions.
router.get("/tracker/trailing-analysis", async (req, res) => {
  try {
    const requestedPattern = (req.query.pattern as string | undefined)?.trim();
    const pattern =
      requestedPattern &&
      ACTIVE_PATTERN_KEYS.includes(
        requestedPattern as (typeof ACTIVE_PATTERN_KEYS)[number],
      )
        ? requestedPattern
        : undefined;
    const cacheKey = pattern || "all";
    const cached = trailingAnalysisCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      res.json(cached.value);
      return;
    }
    const existingLoad = trailingAnalysisInFlight.get(cacheKey);
    if (existingLoad) {
      res.json(await existingLoad);
      return;
    }
    const load = (async () => {
      const rowsResult = await db.execute(sql`
      WITH trailing_cohort AS (
        SELECT
          e.signal_id,
          MAX(e.peak_pnl_pct) AS peak_pnl_pct,
          MAX(e.activation_pct) AS activation_pct,
          MAX(e.trailing_gap_pct) AS trailing_gap_pct,
          BOOL_OR(TRUE) AS was_actual_trailing,
          MAX(e.actual_exit_price) FILTER (WHERE e.event_type = 'hit') AS actual_exit_price,
          MAX(e.actual_pnl_pct) FILTER (WHERE e.event_type = 'hit') AS actual_pnl_pct,
          MAX(e.closed_at) FILTER (WHERE e.event_type = 'hit') AS closed_at
        FROM signal_trailing_events e
        WHERE e.observed_at >= ${new Date(TRAILING_ANALYSIS_SINCE)}
        GROUP BY e.signal_id
      )
      SELECT
        ts.id AS "signalId",
        ts.symbol,
        ts.sentiment_key AS "sentimentKey",
        ts.is_short AS "isShort",
        ts.detected_at AS "detectedAt",
        COALESCE(ts.split_filled_at, ts.detected_at) AS "analysisStartAt",
        COALESCE(e.closed_at, ts.closed_at) AS "closedAt",
        ts.entry_price AS "entryPrice",
        COALESCE(e.actual_exit_price, ts.exit_price) AS "actualExitPrice",
        COALESCE(e.actual_pnl_pct, ts.pnl_percent) AS "actualPnlPct",
        COALESCE(e.peak_pnl_pct,
          CASE
            WHEN ts.is_short THEN (ts.entry_price - ts.peak_price) / NULLIF(ts.entry_price, 0) * 100
            ELSE (ts.peak_price - CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END) / NULLIF(CASE WHEN ts.policy_version = 'impulse_runner_v1' THEN ts.original_entry_price ELSE ts.entry_price END, 0) * 100
          END
        ) AS "actualPeakPnlPct",
         ts.entry_btc_24h AS "entryBtc24h",
         ts.stop_loss_pct AS "runnerEmergencyStopPct",
        e.activation_pct AS "actualActivationPct",
        e.trailing_gap_pct AS "actualTrailingGapPct",
        COALESCE(e.was_actual_trailing, FALSE) AS "wasActualTrailing"
      FROM tracked_signals ts
      LEFT JOIN trailing_cohort e ON e.signal_id = ts.id
      WHERE ts.entry_price > 0
        AND COALESCE(e.actual_pnl_pct, ts.pnl_percent) IS NOT NULL
        AND COALESCE(e.actual_exit_price, ts.exit_price) IS NOT NULL
        AND ts.status IN ('profit', 'stop_loss', 'bu_stop', 'breakeven', 'expired', 'cancelled')
        AND (
          ts.detected_at >= ${new Date(TRAILING_ANALYSIS_SINCE)}
          OR e.signal_id IS NOT NULL
        )
        ${pattern ? sql`AND ts.sentiment_key = ${pattern}` : sql``}
      ORDER BY COALESCE(e.closed_at, ts.closed_at) ASC
    `);
      const trades: TrailingAnalysisTrade[] = rowsResult.rows.map((row) => {
        const sentimentKey = String(row.sentimentKey ?? "unknown");
        return {
          signalId: Number(row.signalId),
          symbol: String(row.symbol),
          sentimentKey,
          isShort: row.isShort === true,
          detectedAt: row.detectedAt as Date | string,
          analysisStartAt: row.analysisStartAt as Date | string | null,
          closedAt: row.closedAt as Date | string | null,
          entryPrice: Number(row.entryPrice),
          actualExitPrice:
            row.actualExitPrice == null ? null : Number(row.actualExitPrice),
          actualPnlPct:
            row.actualPnlPct == null ? null : Number(row.actualPnlPct),
          actualPeakPnlPct:
            row.actualPeakPnlPct == null ? null : Number(row.actualPeakPnlPct),
          entryBtc24h: row.entryBtc24h == null ? null : Number(row.entryBtc24h),
          runnerEmergencyStopPct:
            row.runnerEmergencyStopPct == null
              ? null
              : Number(row.runnerEmergencyStopPct),
          firstTargetPct: getExitProfile(sentimentKey, String(row.symbol))
            .firstTarget,
          actualActivationPct:
            row.actualActivationPct == null
              ? null
              : Number(row.actualActivationPct),
          actualTrailingGapPct:
            row.actualTrailingGapPct == null
              ? null
              : Number(row.actualTrailingGapPct),
          wasActualTrailing: row.wasActualTrailing === true,
        };
      });
      const generatedAt = new Date();
      const candlesBySignal = new Map<
        number,
        Awaited<ReturnType<typeof getKlinesRange>>
      >();
      let nextTrade = 0;
      const workers = Array.from(
        { length: Math.min(4, trades.length) },
        async () => {
          while (nextTrade < trades.length) {
            const trade = trades[nextTrade++];
            if (!trade) break;
            const startAt = new Date(
              trade.analysisStartAt ?? trade.detectedAt,
            ).getTime();
            const candleStartAt =
              Math.floor(startAt / (15 * 60_000)) * 15 * 60_000;
            const analysisEndAt = Math.min(
              generatedAt.getTime(),
              new Date(trade.detectedAt).getTime() +
                TRAILING_ANALYSIS_HORIZON_DAYS * 24 * 60 * 60_000,
            );
            try {
              candlesBySignal.set(
                trade.signalId,
                await getKlinesRange(
                  trade.symbol,
                  "15m",
                  candleStartAt,
                  analysisEndAt,
                ),
              );
            } catch (err) {
              req.log.warn(
                { err, signalId: trade.signalId, symbol: trade.symbol },
                "trailing-analysis candle load failed",
              );
              candlesBySignal.set(trade.signalId, []);
            }
          }
        },
      );
      await Promise.all(workers);
      const report = buildTrailingAnalysis({
        trades,
        candlesBySignal,
        generatedAt,
      });
      trailingAnalysisCache.set(cacheKey, {
        expiresAt: Date.now() + TRAILING_ANALYSIS_CACHE_MS,
        value: report,
      });
      return report;
    })();
    trailingAnalysisInFlight.set(cacheKey, load);
    try {
      res.json(await load);
    } finally {
      if (trailingAnalysisInFlight.get(cacheKey) === load) {
        trailingAnalysisInFlight.delete(cacheKey);
      }
    }
  } catch (err) {
    req.log.error({ err }, "trailing-analysis error");
    res.status(500).json({ error: "Failed to get trailing analysis" });
  }
});

// GET /api/tracker/profit-lock-analysis — observational evaluation of the
// entry-anchored +10% → +5% protected-profit candidate. It must remain
// descriptive and must never feed the live exit path.
router.get("/tracker/profit-lock-analysis", async (req, res) => {
  try {
    const pattern = (req.query.pattern as string | undefined)?.trim();
    const activePatterns = [...ACTIVE_PATTERN_KEYS];
    const analysisPatternKeys =
      pattern &&
      activePatterns.includes(pattern as (typeof ACTIVE_PATTERN_KEYS)[number])
        ? [pattern]
        : pattern
          ? []
          : activePatterns;
    const activePatternValues = sql.join(
      activePatterns.map((key) => sql`${key}`),
      sql`, `,
    );
    const patternFilter = pattern
      ? sql`AND h.sentiment_key = ${pattern}`
      : sql``;

    const [groupsResult, sampleResult, evEventsResult] = await Promise.all([
      db.execute(sql`
        SELECT
          h.sentiment_key AS "sentimentKey",
          h.activation_pct AS "activationPct",
          h.locked_profit_pct AS "lockedProfitPct",
          COUNT(*)::int AS "virtualHits",
          COUNT(h6.id)::int AS "followUps6h",
          COUNT(h24.id)::int AS "followUps24h",
          COUNT(h72.id)::int AS "followUps72h",
          COUNT(c.id)::int AS "actualCloses",
          ROUND(AVG(h.current_pnl_pct)::numeric, 2) AS "averageVirtualExitPnl",
          ROUND(AVG(h.peak_pnl_pct)::numeric, 2) AS "averagePeakPnl",
          ROUND(AVG(h6.current_pnl_pct)::numeric, 2) AS "averagePnlAt6h",
          ROUND(AVG(h24.current_pnl_pct)::numeric, 2) AS "averagePnlAt24h",
          ROUND(AVG(h72.current_pnl_pct)::numeric, 2) AS "averagePnlAt72h",
          ROUND(
            100.0 * COUNT(*) FILTER (
              WHERE h24.peak_pnl_pct > h.peak_pnl_pct + 0.05
            ) / NULLIF(COUNT(h24.id), 0),
            1
          ) AS "newPeakAfter24hRate",
          ROUND(AVG(c.actual_pnl_pct)::numeric, 2) AS "averageActualClosePnl",
          ROUND(
            AVG(c.actual_pnl_pct - h.current_pnl_pct)::numeric,
            2
          ) AS "averageActualVsLockDelta"
        FROM signal_profit_lock_shadow_events h
        LEFT JOIN signal_profit_lock_shadow_events h6
          ON h6.signal_id = h.signal_id
         AND h6.activation_pct = h.activation_pct
         AND h6.locked_profit_pct = h.locked_profit_pct
         AND h6.event_type = '6h'
        LEFT JOIN signal_profit_lock_shadow_events h24
          ON h24.signal_id = h.signal_id
         AND h24.activation_pct = h.activation_pct
         AND h24.locked_profit_pct = h.locked_profit_pct
         AND h24.event_type = '24h'
        LEFT JOIN signal_profit_lock_shadow_events h72
          ON h72.signal_id = h.signal_id
         AND h72.activation_pct = h.activation_pct
         AND h72.locked_profit_pct = h.locked_profit_pct
         AND h72.event_type = '72h'
        LEFT JOIN signal_profit_lock_shadow_events c
          ON c.signal_id = h.signal_id
         AND c.activation_pct = h.activation_pct
         AND c.locked_profit_pct = h.locked_profit_pct
         AND c.event_type = 'close'
        WHERE h.event_type = 'hit'
          AND h.sentiment_key IN (${activePatternValues})
          ${patternFilter}
        GROUP BY h.sentiment_key, h.activation_pct, h.locked_profit_pct
        ORDER BY h.sentiment_key ASC
      `),
      db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE event_type = 'activated')::int AS "activated",
          COUNT(*) FILTER (WHERE event_type = 'hit')::int AS "virtualHits"
        FROM signal_profit_lock_shadow_events
        WHERE sentiment_key IN (${activePatternValues})
        ${pattern ? sql`AND sentiment_key = ${pattern}` : sql``}
      `),
      db.execute(sql`
        SELECT
          signal_id AS "signalId",
          sentiment_key AS "sentimentKey",
          event_type AS "eventType",
          observed_at AS "observedAt",
          current_pnl_pct AS "currentPnlPct",
          peak_pnl_pct AS "peakPnlPct",
          actual_pnl_pct AS "actualPnlPct"
        FROM signal_profit_lock_shadow_events
        WHERE sentiment_key IN (${activePatternValues})
          ${pattern ? sql`AND sentiment_key = ${pattern}` : sql``}
        ORDER BY signal_id ASC, observed_at ASC
      `),
    ]);

    const groups = groupsResult.rows.map((row) => {
      const virtualHits = Number(
        (row as { virtualHits?: number | string | null }).virtualHits ?? 0,
      );
      return {
        ...row,
        virtualHits,
        sufficient: virtualHits >= 20,
      };
    });
    const sample = sampleResult.rows[0] ?? { activated: 0, virtualHits: 0 };
    const virtualHits = Number(sample.virtualHits ?? 0);
    const counterfactual = buildProfitLockEvAnalysis(
      evEventsResult.rows.map((row) => ({
        signalId: Number(row.signalId),
        sentimentKey: String(row.sentimentKey),
        eventType: String(row.eventType),
        observedAt: row.observedAt as Date | string,
        currentPnlPct:
          row.currentPnlPct == null ? null : Number(row.currentPnlPct),
        peakPnlPct: row.peakPnlPct == null ? null : Number(row.peakPnlPct),
        actualPnlPct:
          row.actualPnlPct == null ? null : Number(row.actualPnlPct),
      })),
      analysisPatternKeys,
    );

    res.json({
      observationOnly: true,
      sample: {
        activated: Number(sample.activated ?? 0),
        virtualHits,
        minimumHits: 20,
        sufficient: virtualHits >= 20,
      },
      definition:
        "Сценарий активируется после наблюдаемого пика +10% и виртуально фиксирует +5% от цены входа. Hit — первое наблюдаемое касание этого фиксированного уровня. 6h/24h/72h сохраняются даже после реального закрытия позиции; это аналитика, а не команда изменить стоп.",
      groups,
      counterfactual,
    });
  } catch (err) {
    req.log.error({ err }, "profit-lock-analysis error");
    res.status(500).json({ error: "Failed to get profit-lock analysis" });
  }
});

// GET /api/tracker/plm-calibration — live-policy evaluation plus observation-only
// shadow analytics. It must never feed scanner gates.
router.get("/tracker/plm-calibration", async (req, res) => {
  try {
    const rows = await db
      .select({
        signalType: trackedSignalsTable.signalType,
        alphaScore: trackedSignalsTable.alphaScore,
        status: trackedSignalsTable.status,
        entryPrice: trackedSignalsTable.entryPrice,
        peakPrice: trackedSignalsTable.peakPrice,
        price24hAtFire: trackedSignalsTable.price24hAtFire,
        entryPrice3h: trackedSignalsTable.entryPrice3h,
        entryOi30m: trackedSignalsTable.entryOi30m,
        entryOi1h: trackedSignalsTable.entryOi1h,
        entryOi4h: trackedSignalsTable.entryOi4h,
        entryPrice1h: trackedSignalsTable.entryPrice1h,
        plmP24hCap18Pass: trackedSignalsTable.plmP24hCap18Pass,
        entryScoreBreakdown: trackedSignalsTable.entryScoreBreakdown,
        entryGradeReason: trackedSignalsTable.entryGradeReason,
        plmFutTakerShadow: trackedSignalsTable.plmFutTakerShadow,
        plmOi30mShadow: trackedSignalsTable.plmOi30mShadow,
        entryFutTakerNetBuy: trackedSignalsTable.entryFutTakerNetBuy,
        pnlPercent: trackedSignalsTable.pnlPercent,
        detectedAt: trackedSignalsTable.detectedAt,
        closedAt: trackedSignalsTable.closedAt,
        entrySpotVolMult: trackedSignalsTable.entrySpotVolMult,
      })
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.sentimentKey, "price_led_momentum"))
      .orderBy(desc(trackedSignalsTable.detectedAt));

    res.json(buildPlmCalibrationReport(rows));
  } catch (err) {
    req.log.error({ err }, "plm-calibration error");
    res.status(500).json({ error: "Failed to get PLM calibration" });
  }
});

// GET /api/tracker/bullish-accumulation-calibration — read-only comparison of
// the two canonical BA OI routes. Legacy entries are excluded by versioned
// entry_source rather than by a guessed deployment timestamp.
router.get("/tracker/bullish-accumulation-calibration", async (req, res) => {
  try {
    const rows = await db
      .select({
        status: trackedSignalsTable.status,
        pnlPercent: trackedSignalsTable.pnlPercent,
        entrySource: trackedSignalsTable.entrySource,
      })
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.sentimentKey, "bullish_accumulation"))
      .orderBy(desc(trackedSignalsTable.detectedAt));

    res.json(buildBullishAccumulationCalibrationReport(rows));
  } catch (err) {
    req.log.error({ err }, "bullish-accumulation-calibration error");
    res
      .status(500)
      .json({ error: "Failed to get Bullish Accumulation calibration" });
  }
});

// Relationship analysis uses only immutable decision-time fields and ready,
// frozen ABNeon snapshots. It does not read live market data or influence trades.
router.get("/tracker/altbullet-indicator-relations", async (req, res) => {
  try {
    const patternFilter = req.query.pattern as string | undefined;
    const versionFilter = req.query.version as string | undefined;
    const trackedConditions = [];
    if (patternFilter && patternFilter !== "all")
      trackedConditions.push(
        eq(trackedSignalsTable.sentimentKey, patternFilter),
      );
    const rows = await db
      .select({
        trackedId: trackedSignalsTable.id,
        signalId: trackedSignalsTable.signalId,
        pattern: trackedSignalsTable.sentimentKey,
        status: trackedSignalsTable.status,
        isShort: trackedSignalsTable.isShort,
        entryPrice: trackedSignalsTable.entryPrice,
        exitPrice: trackedSignalsTable.exitPrice,
        pnlPercent: trackedSignalsTable.pnlPercent,
        cancelReason: trackedSignalsTable.cancelReason,
        closedAt: trackedSignalsTable.closedAt,
        indicatorVersion: altBulletIndicatorSnapshotsTable.indicatorVersion,
        snapshotPattern: altBulletIndicatorSnapshotsTable.sentimentKey,
        snapshotContext: altBulletIndicatorSnapshotsTable.context,
        entryMetricsProvenance: trackedSignalsTable.entryMetricsProvenance,
        decisionMetrics: trackedSignalsTable.decisionMetrics,
        impulseDecisionMetrics: trackedSignalsTable.impulseDecisionMetrics,
        cvd15m: trackedSignalsTable.entryCvd15m,
        cvd30m: trackedSignalsTable.entryCvd30m,
        cvd1h: trackedSignalsTable.entryCvd1h,
        cvd4h: trackedSignalsTable.entryCvd4h,
        signalCvd15m: signalsTable.entryCvd15m,
        signalCvd30m: signalsTable.entryCvd30m,
        signalCvd1h: signalsTable.entryCvd1h,
        signalCvd4h: signalsTable.entryCvd4h,
        oi30m: trackedSignalsTable.entryOi30m,
        oi1h: trackedSignalsTable.entryOi1h,
        oi4h: trackedSignalsTable.entryOi4h,
        oi24h: trackedSignalsTable.entryOi24h,
        spotVolumeMultiple: trackedSignalsTable.entrySpotVolMult,
        futuresVolumeMultiple: trackedSignalsTable.entryFutVolMult,
        volume24h: signalsTable.volume24h,
        averageVolume: signalsTable.avgVolume,
        spotTakerNetBuy: trackedSignalsTable.entrySpotTakerNetBuy,
        futuresTakerNetBuy: trackedSignalsTable.entryFutTakerNetBuy,
        spotNetBuy1h: trackedSignalsTable.entrySpotNetBuy1h,
        spotNetBuy4h: trackedSignalsTable.entrySpotNetBuy4h,
        spotNetBuy24h: trackedSignalsTable.entrySpotNetBuy24h,
        fundingRate: trackedSignalsTable.entryFundingRate,
        signalFundingRate: signalsTable.fundingRate,
        rsi1h: trackedSignalsTable.entryRsi1h,
        priceMomentum1h: trackedSignalsTable.entryPrice1h,
        priceMomentum3h: trackedSignalsTable.entryPrice3h,
        signalPriceChangePercent: signalsTable.priceChangePercent,
        btcChange24h: trackedSignalsTable.entryBtc24h,
        btcDominance: trackedSignalsTable.entryBtcDominance,
        whaleIndex: trackedSignalsTable.entryWhaleIndex,
        orderBookBidUsd: trackedSignalsTable.entryObBids,
        orderBookAskUsd: trackedSignalsTable.entryObAsks,
        orderBookRatio: trackedSignalsTable.entryObRatio,
        spotVolume24h: trackedSignalsTable.entrySpotVol24h,
        spotVolumeMarketCapPct: trackedSignalsTable.entrySpotMcapPct,
        marketCapUsd: trackedSignalsTable.marketCapUsd,
        price24hAtFire: trackedSignalsTable.price24hAtFire,
        liqLong1h: trackedSignalsTable.entryLiqLong1h,
        liqLong24h: trackedSignalsTable.entryLiqLong24h,
        liqRatio: trackedSignalsTable.entryLiqRatio,
        liqReason: trackedSignalsTable.entryLiqReason,
      })
      .from(altBulletIndicatorSnapshotsTable)
      .innerJoin(
        trackedSignalsTable,
        eq(
          altBulletIndicatorSnapshotsTable.signalId,
          trackedSignalsTable.signalId,
        ),
      )
      .innerJoin(
        signalsTable,
        eq(signalsTable.id, trackedSignalsTable.signalId),
      )
      .where(
        and(
          activeTrackedPatternCondition(),
          eq(altBulletIndicatorSnapshotsTable.status, "ready"),
          ...(trackedConditions.length ? trackedConditions : []),
          ...(versionFilter
            ? [
                eq(
                  altBulletIndicatorSnapshotsTable.indicatorVersion,
                  versionFilter,
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(altBulletIndicatorSnapshotsTable.capturedAt))
      .limit(ABNEON_RELATION_MAX_READY_SNAPSHOTS);

    const shadowRows = rows.length
      ? await db
          .select({
            signalId: altBulletTakeProfitShadowTable.signalId,
            variant: altBulletTakeProfitShadowTable.variant,
            eligibilityReason: altBulletTakeProfitShadowTable.eligibilityReason,
            targetPct: altBulletTakeProfitShadowTable.targetPct,
            requestedAt: altBulletTakeProfitShadowTable.snapshotRequestedAt,
            capturedAt: altBulletTakeProfitShadowTable.snapshotCapturedAt,
            hitAt: altBulletTakeProfitShadowTable.hitAt,
          })
          .from(altBulletTakeProfitShadowTable)
          .where(
            and(
              inArray(
                altBulletTakeProfitShadowTable.signalId,
                rows
                  .map((row) => row.signalId)
                  .filter((id): id is number => id != null),
              ),
              eq(
                altBulletTakeProfitShadowTable.experimentVersion,
                ALT_BULLET_TP_EXPERIMENT_VERSION,
              ),
            ),
          )
      : [];
    const rowsBySignal = new Map(rows.map((row) => [row.signalId, row]));
    const targetAudit = aggregateTargetAudit(
      shadowRows.map((shadow) => {
        const trade = rowsBySignal.get(shadow.signalId)!;
        return {
          version: trade.indicatorVersion,
          pattern: trade.pattern ?? trade.snapshotPattern ?? "unknown",
          variant: shadow.variant,
          eligible: shadow.eligibilityReason == null,
          pnlPercent: relationOutcomePnl({
            status: trade.status,
            cancelReason: trade.cancelReason,
            exitPrice: trade.exitPrice,
            pnlPercent: trade.pnlPercent,
            sentimentKey: trade.pattern,
          }),
          targetPct: shadow.targetPct,
          requestedAt: shadow.requestedAt,
          capturedAt: shadow.capturedAt,
          hitAt: shadow.hitAt,
          closedAt: trade.closedAt,
        };
      }),
    );

    const finitePositive = (value: unknown): number | null => {
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) && number > 0 ? number : null;
    };
    const numeric = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    const buildMetrics = (row: (typeof rows)[number]): RelationMetric[] => {
      const volumeMultiple =
        numeric(row.volume24h) != null &&
        numeric(row.averageVolume) != null &&
        numeric(row.averageVolume)! > 0
          ? numeric(row.volume24h)! / numeric(row.averageVolume)!
          : null;
      const raw: Array<
        [string, number | boolean | string | null, string, string]
      > = [
        [
          "cvd15m",
          row.cvd15m ?? row.signalCvd15m,
          "boolean",
          row.cvd15m != null ? "entryCvd15m" : "signals.entryCvd15m",
        ],
        [
          "cvd30m",
          row.cvd30m ?? row.signalCvd30m,
          "boolean",
          row.cvd30m != null ? "entryCvd30m" : "signals.entryCvd30m",
        ],
        [
          "cvd1h",
          row.cvd1h ?? row.signalCvd1h,
          "boolean",
          row.cvd1h != null ? "entryCvd1h" : "signals.entryCvd1h",
        ],
        [
          "cvd4h",
          row.cvd4h ?? row.signalCvd4h,
          "boolean",
          row.cvd4h != null ? "entryCvd4h" : "signals.entryCvd4h",
        ],
        ["oi30m", numeric(row.oi30m), "%", "entryOi30m"],
        ["oi1h", numeric(row.oi1h), "%", "entryOi1h"],
        ["oi4h", numeric(row.oi4h), "%", "entryOi4h"],
        ["oi24h", numeric(row.oi24h), "%", "entryOi24h"],
        [
          "spotVolumeMultiple",
          numeric(row.spotVolumeMultiple),
          "×",
          "entrySpotVolMult",
        ],
        [
          "futuresVolumeMultiple",
          numeric(row.futuresVolumeMultiple),
          "×",
          "entryFutVolMult",
        ],
        [
          "volume24hToAverage",
          volumeMultiple,
          "×",
          "signals.volume24h/avgVolume",
        ],
        [
          "spotTakerNetBuy",
          numeric(row.spotTakerNetBuy),
          "%",
          "entrySpotTakerNetBuy",
        ],
        [
          "futuresTakerNetBuy",
          numeric(row.futuresTakerNetBuy),
          "%",
          "entryFutTakerNetBuy",
        ],
        ["spotNetBuy1h", numeric(row.spotNetBuy1h), "%", "entrySpotNetBuy1h"],
        ["spotNetBuy4h", numeric(row.spotNetBuy4h), "%", "entrySpotNetBuy4h"],
        [
          "spotNetBuy24h",
          numeric(row.spotNetBuy24h),
          "%",
          "entrySpotNetBuy24h",
        ],
        [
          "fundingRate",
          numeric(row.fundingRate ?? row.signalFundingRate),
          "raw decimal",
          row.fundingRate != null ? "entryFundingRate" : "signals.fundingRate",
        ],
        ["rsi1h", numeric(row.rsi1h), "RSI points", "entryRsi1h"],
        ["priceMomentum1h", numeric(row.priceMomentum1h), "%", "entryPrice1h"],
        ["priceMomentum3h", numeric(row.priceMomentum3h), "%", "entryPrice3h"],
        [
          "priceChangeAtSignal",
          numeric(row.signalPriceChangePercent),
          "%",
          "signals.priceChangePercent",
        ],
        ["price24hAtFire", numeric(row.price24hAtFire), "%", "price24hAtFire"],
        ["btcChange24h", numeric(row.btcChange24h), "%", "entryBtc24h"],
        ["btcDominance", numeric(row.btcDominance), "%", "entryBtcDominance"],
        [
          "whaleIndex",
          numeric(row.whaleIndex),
          "index points",
          "entryWhaleIndex",
        ],
        ["orderBookBidUsd", numeric(row.orderBookBidUsd), "USD", "entryObBids"],
        ["orderBookAskUsd", numeric(row.orderBookAskUsd), "USD", "entryObAsks"],
        [
          "orderBookRatio",
          numeric(row.orderBookRatio),
          "ratio",
          "entryObRatio",
        ],
        ["spotVolume24h", numeric(row.spotVolume24h), "USD", "entrySpotVol24h"],
        [
          "spotVolumeMarketCapPct",
          numeric(row.spotVolumeMarketCapPct),
          "%",
          "entrySpotMcapPct",
        ],
        ["marketCapUsd", numeric(row.marketCapUsd), "USD", "marketCapUsd"],
        ["liqLong1h", numeric(row.liqLong1h), "USD", "entryLiqLong1h"],
        ["liqLong24h", numeric(row.liqLong24h), "USD", "entryLiqLong24h"],
        ["liqRatio", numeric(row.liqRatio), "ratio", "entryLiqRatio"],
        ["liqReason", row.liqReason, "category", "entryLiqReason"],
      ];
      const btcRegime =
        row.decisionMetrics?.btcRegime ?? row.impulseDecisionMetrics?.btcRegime;
      raw.push([
        "btcRegime",
        typeof btcRegime === "string" ? btcRegime : null,
        "category",
        "tracked decision-time snapshot field: decisionMetrics.btcRegime",
      ]);
      const provenance = row.entryMetricsProvenance ?? {};
      return raw.map(([key, value, unit, sourceField]) => {
        const saved =
          provenance[key] ??
          provenance[sourceField] ??
          provenance[
            sourceField.replace(/^tracked_signals entry-time field: /, "")
          ];
        const savedSource =
          saved && typeof saved === "object" && "source" in saved
            ? String(saved.source)
            : null;
        const savedObservedAt =
          saved && typeof saved === "object" && "observedAt" in saved
            ? String(saved.observedAt)
            : null;
        const effectiveSource =
          savedSource ??
          (value != null && sourceField.startsWith("signals.")
            ? `signals entry-time field: ${sourceField}`
            : null);
        const source =
          effectiveSource ??
          (value == null
            ? "not_recorded_at_entry"
            : `legacy_unverified_entry_field:${sourceField}`);
        return {
          key,
          value: value == null ? null : value,
          unit,
          provenance: source,
          provenanceCohort: classifyRelationProvenance(effectiveSource),
          observedAt: savedObservedAt,
        };
      });
    };
    const closedTrades: RelationTrade[] = [];
    const availability = new Map<
      string,
      {
        pattern: string;
        version: string;
        indicator: string;
        unit: string;
        provenanceCohort: string;
        availableCount: number;
        missingCount: number;
        provenanceCounts: Map<string, number>;
        observedAtMin: string | null;
        observedAtMax: string | null;
      }
    >();
    let measurableClosedOutcomeCount = 0;
    let unknownClosedOutcomeCount = 0;
    let nonTerminalReadySnapshotCount = 0;
    for (const row of rows) {
      const pattern = row.pattern ?? row.snapshotPattern ?? "unknown";
      const metrics = buildMetrics(row);
      for (const metric of metrics) {
        const key = `${pattern}|${row.indicatorVersion}|${metric.key}|${metric.provenanceCohort}`;
        const item = availability.get(key) ?? {
          pattern,
          version: row.indicatorVersion,
          indicator: metric.key,
          unit: metric.unit,
          provenanceCohort: metric.provenanceCohort,
          availableCount: 0,
          missingCount: 0,
          provenanceCounts: new Map<string, number>(),
          observedAtMin: null,
          observedAtMax: null,
        };
        if (metric.value == null) item.missingCount += 1;
        else item.availableCount += 1;
        item.provenanceCounts.set(
          metric.provenance,
          (item.provenanceCounts.get(metric.provenance) ?? 0) + 1,
        );
        if (metric.observedAt) {
          if (!item.observedAtMin || metric.observedAt < item.observedAtMin)
            item.observedAtMin = metric.observedAt;
          if (!item.observedAtMax || metric.observedAt > item.observedAtMax)
            item.observedAtMax = metric.observedAt;
        }
        availability.set(key, item);
      }
      const terminal = CLOSED_TRADE_OUTCOME_STATUSES.includes(
        row.status as (typeof CLOSED_TRADE_OUTCOME_STATUSES)[number],
      );
      if (!terminal) {
        nonTerminalReadySnapshotCount += 1;
        continue;
      }
      const pnl = relationOutcomePnl({
        status: row.status,
        cancelReason: row.cancelReason,
        exitPrice: row.exitPrice,
        pnlPercent: row.pnlPercent,
        sentimentKey: pattern,
      });
      if (pnl == null) unknownClosedOutcomeCount += 1;
      else measurableClosedOutcomeCount += 1;
      const context = row.snapshotContext ?? {};
      const entry = finitePositive(row.entryPrice);
      const support = finitePositive(context.nearestSupport);
      const resistance = finitePositive(context.nearestResistance);
      const supportDistancePct =
        entry != null && support != null && support <= entry
          ? ((entry - support) / entry) * 100
          : null;
      const resistanceDistancePct =
        entry != null && resistance != null && resistance >= entry
          ? ((resistance - entry) / entry) * 100
          : null;
      closedTrades.push({
        pattern,
        version: row.indicatorVersion,
        pnlPercent: pnl,
        terminal: true,
        metrics,
        supportDistancePct,
        resistanceDistancePct,
      });
    }
    const rangeCohorts = new Map<
      string,
      {
        pattern: string;
        version: string;
        oneHour: string;
        fourHour: string;
        open: number;
        closed: number;
        unknownOutcome: number;
        atLeast10Pct: number;
        totalRawPnl: number;
      }
    >();
    for (const row of rows) {
      const context = row.snapshotContext;
      if (typeof context?.rangeObservationVersion !== "string") continue;
      const oneHour =
        typeof context.range1hState === "string"
          ? context.range1hState
          : "unknown";
      const fourHour =
        typeof context.range4hState === "string"
          ? context.range4hState
          : "unknown";
      const pattern = row.pattern ?? row.snapshotPattern ?? "unknown";
      const key = JSON.stringify([
        pattern,
        row.indicatorVersion,
        oneHour,
        fourHour,
      ]);
      const group = rangeCohorts.get(key) ?? {
        pattern,
        version: row.indicatorVersion,
        oneHour,
        fourHour,
        open: 0,
        closed: 0,
        unknownOutcome: 0,
        atLeast10Pct: 0,
        totalRawPnl: 0,
      };
      if (row.status === "active" || row.status === "in_run") {
        group.open++;
      } else if (
        CLOSED_TRADE_OUTCOME_STATUSES.includes(
          row.status as (typeof CLOSED_TRADE_OUTCOME_STATUSES)[number],
        )
      ) {
        const pnl = relationOutcomePnl({
          status: row.status,
          cancelReason: row.cancelReason,
          exitPrice: row.exitPrice,
          pnlPercent: row.pnlPercent,
          sentimentKey: pattern,
        });
        if (pnl == null) group.unknownOutcome++;
        else {
          group.closed++;
          group.totalRawPnl += pnl;
          if (pnl >= 10) group.atLeast10Pct++;
        }
      }
      rangeCohorts.set(key, group);
    }
    const data = aggregateIndicatorRelations(closedTrades);
    res.json({
      observationOnly: true,
      decisionUse: false,
      data,
      rangeCohorts: [...rangeCohorts.values()].map(
        ({ totalRawPnl, ...group }) => ({
          ...group,
          averageRawPnlPercent:
            group.closed > 0 ? totalRawPnl / group.closed : null,
          lowSample: group.closed < 20,
        }),
      ),
      targetAudit,
      metadata: {
        contractVersion: "abneon-indicator-relations-v2",
        source:
          "ready frozen ABNeon snapshots + linked historical tracked_signals/signals entry fields; no live market reads",
        cohort: {
          maxReadySnapshots: ABNEON_RELATION_MAX_READY_SNAPSHOTS,
          readySnapshotsReturned: rows.length,
          boundedCohortMayBeTruncated:
            rows.length === ABNEON_RELATION_MAX_READY_SNAPSHOTS,
          closedOutcomes:
            measurableClosedOutcomeCount + unknownClosedOutcomeCount,
          measurableClosedOutcomes: measurableClosedOutcomeCount,
          unknownClosedOutcomes: unknownClosedOutcomeCount,
          nonTerminalReadySnapshots: nonTerminalReadySnapshotCount,
          lowSampleThreshold: 10,
        },
        grouping: {
          patternAndIndicatorVersionAreAlwaysSeparate: true,
          proximityBands: ["0–1%", ">1–3%", ">3–5%", ">5%", "unknown"],
          proximityBasis:
            "absolute nearest S/R distance from entry as percent of entry; only support below or equal to entry and resistance above or equal to entry are valid",
          averageRawPnlPercent:
            "arithmetic mean of measured, actual closed-trade PnL; bu_stop is normalized by existing raw-PnL rules",
          outcomesAtLeast10Pct: "closed trade raw PnL >= +10%",
          targetAudit:
            "Legacy shadow variants only. Confirmed hits require requested <= captured <= hit < close event times and measured actual trade PnL. All other eligible targets have unknown touch, not a miss. Delta applies only to confirmed hits as an illustrative full-exit-at-target comparison; no full-cohort counterfactual PnL is inferred. At least 20 measured closures per version/pattern/variant are required for a sufficient cohort.",
        },
        indicatorAvailability: [...availability.values()].map((entry) => ({
          pattern: entry.pattern,
          version: entry.version,
          indicator: entry.indicator,
          unit: entry.unit,
          provenanceCohort: entry.provenanceCohort,
          availableCount: entry.availableCount,
          missingCount: entry.missingCount,
          observedAtRange: {
            earliest: entry.observedAtMin,
            latest: entry.observedAtMax,
          },
          provenanceCounts: [...entry.provenanceCounts.entries()].map(
            ([provenance, count]) => ({ provenance, count }),
          ),
        })),
        indicatorFieldSet: [
          "CVD 15m/30m/1h/4h; OI 30m/1h/4h/24h; spot/futures volume multiples and signals volume24h/avgVolume; spot/futures taker net buy; spot net buy 1h/4h/24h; funding rate; RSI 1h; entry price momentum 1h/3h and signal priceChangePercent; BTC 24h change, dominance and frozen decisionMetrics.btcRegime when recorded; whale index; order-book bid/ask USD and ratio; spot volume 24h and spot volume/market-cap percent; market cap; liquidation long 1h/24h and ratio/reason.",
        ],
        indicatorKeys: [
          ...new Set(
            [...availability.values()].map((entry) => entry.indicator),
          ),
        ],
        availabilityScope:
          "counts and provenance cover all returned ready active-pattern snapshots, including open trades; data outcome groups include closed trades only",
        provenanceCohorts: {
          fire_time:
            "signal_fire, signal-row entry fields, or BingX closed-candle capture source",
          prescan_snapshot:
            "entryMetricsProvenance marks a prior same-cycle prescan observation; kept separate",
          reconstructed:
            "source explicitly identifies historical reconstruction; never combined with fire_time groups",
          unknown:
            "source is absent, retry/unavailable, or otherwise unverified; never combined with captured cohorts",
        },
        bucketDefinitions: {
          explicitMetricRanges: RELATION_METRIC_BUCKETS,
          otherNumericMetricRanges: [
            "<0",
            "0–1",
            "1–5",
            "5–10",
            "≥10",
          ] as const,
          categoricalValues:
            "Each observed string value is its own bucket; booleans are true/false.",
        },
        unavailable:
          "Null entry fields are counted as missing; no live/current metric fallback is used.",
      },
    });
  } catch (err) {
    req.log.error({ err }, "altbullet-indicator-relations error");
    res.status(500).json({ error: "Failed to get ABNeon indicator relations" });
  }
});

// GET /api/tracker/altbullet-indicator-analysis — comparison of the user's
// custom 4H observation against completed tracked-signal outcomes. This endpoint
// is intentionally descriptive: it does not feed any scanner gate.
router.get("/tracker/altbullet-indicator-analysis", async (req, res) => {
  try {
    const pattern = req.query.pattern as string | undefined;
    const trackedSignalConditions = [activeTrackedPatternCondition()];
    if (pattern && pattern !== "all") {
      trackedSignalConditions.push(
        eq(trackedSignalsTable.sentimentKey, pattern),
      );
    }

    // A cancellation is a measurable trade only when the close recorded both
    // a positive exit price and a finite PnL. This covers entered stale/smart
    // cancels and ghost cleanup while excluding no-entry/admin/unknown rows.
    const finitePnlCondition = sql<boolean>`
      ${trackedSignalsTable.pnlPercent} <> 'NaN'::real
      AND ${trackedSignalsTable.pnlPercent} <> 'Infinity'::real
      AND ${trackedSignalsTable.pnlPercent} <> '-Infinity'::real
    `;
    const nonFinitePnlCondition = sql<boolean>`
      ${trackedSignalsTable.pnlPercent} IN (
        'NaN'::real,
        'Infinity'::real,
        '-Infinity'::real
      )
    `;
    const measurableCancellationCondition = and(
      eq(trackedSignalsTable.status, "cancelled"),
      isNotNull(trackedSignalsTable.exitPrice),
      gt(trackedSignalsTable.exitPrice, 0),
      isNotNull(trackedSignalsTable.pnlPercent),
      finitePnlCondition,
    );
    const closedTradeEligibilityCondition = or(
      not(eq(trackedSignalsTable.status, "cancelled")),
      measurableCancellationCondition,
    );
    const excludedUnmeasurableCancellationCondition = and(
      eq(trackedSignalsTable.status, "cancelled"),
      or(
        isNull(trackedSignalsTable.exitPrice),
        lte(trackedSignalsTable.exitPrice, 0),
        isNull(trackedSignalsTable.pnlPercent),
        nonFinitePnlCondition,
      ),
    );
    const [
      rows,
      closedTradeCountRows,
      excludedCancellationCountRows,
      pendingSnapshotCountRows,
      unavailableReasonRows,
    ] = await Promise.all([
      db
        .select({
          verdict: altBulletIndicatorSnapshotsTable.verdict,
          indicatorVersion: altBulletIndicatorSnapshotsTable.indicatorVersion,
          sentimentKey: trackedSignalsTable.sentimentKey,
          checks: altBulletIndicatorSnapshotsTable.checks,
          context: altBulletIndicatorSnapshotsTable.context,
          trackedId: trackedSignalsTable.id,
          entryPrice: trackedSignalsTable.entryPrice,
          peakPrice: trackedSignalsTable.peakPrice,
          isShort: trackedSignalsTable.isShort,
          drawdownMinPct: signalDrawdownExtremaTable.minPctFromEntry,
          snapshotStatus: altBulletIndicatorSnapshotsTable.status,
          status: trackedSignalsTable.status,
          cancelReason: trackedSignalsTable.cancelReason,
          exitPrice: trackedSignalsTable.exitPrice,
          pnlPercent: trackedSignalsTable.pnlPercent,
        })
        .from(altBulletIndicatorSnapshotsTable)
        .innerJoin(
          trackedSignalsTable,
          eq(
            altBulletIndicatorSnapshotsTable.signalId,
            trackedSignalsTable.signalId,
          ),
        )
        .leftJoin(
          signalDrawdownExtremaTable,
          eq(signalDrawdownExtremaTable.signalId, trackedSignalsTable.id),
        )
        .where(and(...trackedSignalConditions)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(trackedSignalsTable)
        .where(
          and(
            ...trackedSignalConditions,
            inArray(trackedSignalsTable.status, CLOSED_TRADE_OUTCOME_STATUSES),
            closedTradeEligibilityCondition,
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(trackedSignalsTable)
        .where(
          and(
            ...trackedSignalConditions,
            excludedUnmeasurableCancellationCondition,
          ),
        ),
      db
        .select({
          pending: sql<number>`count(*)::int`,
          retrying: sql<number>`count(*) filter (
              where ${signalsTable.altBulletSnapshotRetryAfter} is not null
            )::int`,
          nextRetryAt: sql<Date | null>`min(${signalsTable.altBulletSnapshotRetryAfter})`,
        })
        .from(signalsTable)
        .innerJoin(
          trackedSignalsTable,
          eq(signalsTable.id, trackedSignalsTable.signalId),
        )
        .where(
          and(
            ...trackedSignalConditions,
            isNotNull(signalsTable.altBulletSnapshotRequestedAt),
          ),
        ),
      db
        .select({
          reason: sql<string>`
            CASE
              WHEN ${altBulletIndicatorSnapshotsTable.context}->>'retryReason' = 'retry_budget_exhausted'
                THEN 'retry_budget_exhausted'
              WHEN ${altBulletIndicatorSnapshotsTable.context}->>'retryReason' = 'retry_window_expired'
                THEN 'retry_window_expired'
              WHEN ${altBulletIndicatorSnapshotsTable.error} LIKE '%Недостаточно 1H/4H свечей%'
                THEN 'insufficient_candles'
              WHEN ${altBulletIndicatorSnapshotsTable.error} ~* '(lease|cancelled|aborted|timeout)'
                THEN 'legacy_transient_failure'
              ELSE 'market_unavailable'
            END
          `,
          count: sql<number>`count(*)::int`,
        })
        .from(altBulletIndicatorSnapshotsTable)
        .innerJoin(
          trackedSignalsTable,
          eq(
            altBulletIndicatorSnapshotsTable.signalId,
            trackedSignalsTable.signalId,
          ),
        )
        .where(
          and(
            ...trackedSignalConditions,
            eq(altBulletIndicatorSnapshotsTable.status, "unavailable"),
          ),
        )
        .groupBy(
          sql`CASE
            WHEN ${altBulletIndicatorSnapshotsTable.context}->>'retryReason' = 'retry_budget_exhausted'
              THEN 'retry_budget_exhausted'
            WHEN ${altBulletIndicatorSnapshotsTable.context}->>'retryReason' = 'retry_window_expired'
              THEN 'retry_window_expired'
            WHEN ${altBulletIndicatorSnapshotsTable.error} LIKE '%Недостаточно 1H/4H свечей%'
              THEN 'insufficient_candles'
            WHEN ${altBulletIndicatorSnapshotsTable.error} ~* '(lease|cancelled|aborted|timeout)'
              THEN 'legacy_transient_failure'
            ELSE 'market_unavailable'
          END`,
        ),
    ]);
    const closedTrades = closedTradeCountRows[0]?.count ?? 0;
    const excludedUnmeasurableCancellations =
      excludedCancellationCountRows[0]?.count ?? 0;
    const pendingSnapshots = pendingSnapshotCountRows[0]?.pending ?? 0;
    const retryingSnapshots = pendingSnapshotCountRows[0]?.retrying ?? 0;
    const nextRetryAt = pendingSnapshotCountRows[0]?.nextRetryAt ?? null;
    const unavailableReasons = unavailableReasonRows.map((row) => ({
      reason: row.reason,
      count: row.count,
    }));
    const requestedVersion =
      (req.query.version as string | undefined) ?? ALT_BULLET_INDICATOR_VERSION;
    const versions = [
      ...new Set(
        rows.map((row) => row.indicatorVersion).filter((v): v is string => !!v),
      ),
    ];
    const scopedRows = rows.filter(
      (row) => row.indicatorVersion === requestedVersion,
    );
    const trackedIds = scopedRows.map((row) => row.trackedId);
    const samples = trackedIds.length
      ? await db
          .select({
            signalId: signalTrajectoryLogTable.signalId,
            elapsedMs: signalTrajectoryLogTable.elapsedMs,
            pctFromEntry: signalTrajectoryLogTable.pctFromEntry,
            snapshotAt: signalTrajectoryLogTable.snapshotAt,
            status: signalTrajectoryLogTable.status,
          })
          .from(signalTrajectoryLogTable)
          .where(inArray(signalTrajectoryLogTable.signalId, trackedIds))
      : [];
    const sampleMap = new Map<number, typeof samples>();
    for (const sample of samples)
      sampleMap.set(sample.signalId, [
        ...(sampleMap.get(sample.signalId) ?? []),
        sample,
      ]);
    const aggregates = aggregateAltBulletAnalysis(
      scopedRows.map((row) => ({
        ...row,
        trajectorySamples: sampleMap.get(row.trackedId) ?? [],
      })),
    );
    const {
      groups,
      closedSnapshots,
      totalSnapshots,
      readySnapshots,
      unavailableSnapshots,
    } = aggregates;

    res.json({
      observationOnly: true,
      legacyAuditOnly: true,
      decisionUse: false,
      sample: {
        closedSnapshots,
        minimumClosedSnapshots: ALT_BULLET_MIN_CLOSED_SNAPSHOTS,
        sufficient: closedSnapshots >= ALT_BULLET_MIN_CLOSED_SNAPSHOTS,
        closedTrades,
        coverageRate:
          closedTrades > 0 ? (closedSnapshots / closedTrades) * 100 : null,
        totalSnapshots,
        readySnapshots,
        unavailableSnapshots,
        pendingSnapshots,
        retryingSnapshots,
        nextRetryAt,
        unavailableReasons,
        excludedUnmeasurableCancellations,
      },
      recommendation: getAltBulletAnalysisRecommendation({
        closedSnapshots,
        groups,
      }),
      definition:
        "Анализируются измеримые завершённые позиции: profit, stop_loss, breakeven, expired, bu_stop и cancelled с положительным exitPrice и конечным pnlPercent. Отмены без подтверждённого выхода или PnL исключаются из coverage и success rate. Успех = profit или bu_stop; открытые сигналы не входят в сравнение.",
      groups,
      version: requestedVersion,
      availableVersions: versions,
      dimensions: {
        version: aggregates.byVersion,
        checkState: aggregates.byCheckState,
        pattern: aggregates.byPattern,
        btcRegime: aggregates.byBtcRegime,
      },
      trajectory: aggregates.trajectory,
    });
  } catch (err) {
    req.log.error({ err }, "altbullet-indicator-analysis error");
    res.status(500).json({ error: "Failed to get indicator analysis" });
  }
});

const altBulletTpShadowAnalysisPath =
  "/tracker/altbullet-take-profit-shadow-analysis";
router.get(altBulletTpShadowAnalysisPath, async (req, res) => {
  try {
    const experimentVersion =
      (req.query.experimentVersion as string | undefined) ??
      ALT_BULLET_TP_EXPERIMENT_VERSION;
    const rows = await db
      .select({
        variant: altBulletTakeProfitShadowTable.variant,
        status: altBulletTakeProfitShadowTable.status,
        eligibilityReason: altBulletTakeProfitShadowTable.eligibilityReason,
        outcome: altBulletTakeProfitShadowTable.outcome,
        sentimentKey: altBulletTakeProfitShadowTable.sentimentKey,
        indicatorVersion: altBulletTakeProfitShadowTable.indicatorVersion,
        targetPct: altBulletTakeProfitShadowTable.targetPct,
        targetAtr: altBulletTakeProfitShadowTable.targetAtr,
        terminalStatus: altBulletTakeProfitShadowTable.terminalStatus,
      })
      .from(altBulletTakeProfitShadowTable)
      .where(
        eq(altBulletTakeProfitShadowTable.experimentVersion, experimentVersion),
      );

    type Bucket = {
      total: number;
      eligible: number;
      tracking: number;
      hitOpen: number;
      completed: number;
      targetBeforeTerminal: number;
      terminalBeforeTarget: number;
      ambiguous: number;
      historicalAmbiguous: number;
      notEligible: number;
      targetPctSum: number;
      targetPctCount: number;
      targetAtrSum: number;
      targetAtrCount: number;
    };
    const emptyBucket = (): Bucket => ({
      total: 0,
      eligible: 0,
      tracking: 0,
      hitOpen: 0,
      completed: 0,
      targetBeforeTerminal: 0,
      terminalBeforeTarget: 0,
      ambiguous: 0,
      historicalAmbiguous: 0,
      notEligible: 0,
      targetPctSum: 0,
      targetPctCount: 0,
      targetAtrSum: 0,
      targetAtrCount: 0,
    });
    const add = (bucket: Bucket, row: (typeof rows)[number]) => {
      bucket.total += 1;
      if (row.status === "not_eligible") bucket.notEligible += 1;
      else bucket.eligible += 1;
      if (row.status === "tracking") bucket.tracking += 1;
      if (row.status === "hit") bucket.hitOpen += 1;
      if (row.status === "completed") bucket.completed += 1;
      if (row.status === "historical_ambiguous")
        bucket.historicalAmbiguous += 1;
      if (row.outcome === "target_before_terminal")
        bucket.targetBeforeTerminal += 1;
      if (row.outcome === "terminal_before_target")
        bucket.terminalBeforeTarget += 1;
      if (row.outcome === "ambiguous") bucket.ambiguous += 1;
      if (row.targetPct != null && Number.isFinite(row.targetPct)) {
        bucket.targetPctSum += row.targetPct;
        bucket.targetPctCount += 1;
      }
      if (row.targetAtr != null && Number.isFinite(row.targetAtr)) {
        bucket.targetAtrSum += row.targetAtr;
        bucket.targetAtrCount += 1;
      }
    };
    const variants = new Map<string, Bucket>();
    const patterns = new Map<string, Bucket>();
    const reasons = new Map<string, number>();
    const indicatorVersions = new Set<string>();
    for (const row of rows) {
      const variant = variants.get(row.variant) ?? emptyBucket();
      variants.set(row.variant, variant);
      add(variant, row);
      const patternKey = row.sentimentKey ?? "unknown";
      const pattern = patterns.get(patternKey) ?? emptyBucket();
      patterns.set(patternKey, pattern);
      add(pattern, row);
      if (row.eligibilityReason) {
        reasons.set(
          row.eligibilityReason,
          (reasons.get(row.eligibilityReason) ?? 0) + 1,
        );
      }
      indicatorVersions.add(row.indicatorVersion);
    }
    const serialize = ([key, bucket]: [string, Bucket]) => ({
      key,
      ...bucket,
      hitRate:
        bucket.completed > 0
          ? (bucket.targetBeforeTerminal / bucket.completed) * 100
          : null,
      averageTargetPct:
        bucket.targetPctCount > 0
          ? bucket.targetPctSum / bucket.targetPctCount
          : null,
      averageTargetAtr:
        bucket.targetAtrCount > 0
          ? bucket.targetAtrSum / bucket.targetAtrCount
          : null,
    });

    res.json({
      observationOnly: true,
      legacyAuditOnly: true,
      changesTradingState: false,
      experimentVersion,
      indicatorVersions: [...indicatorVersions],
      definition:
        "Теневые цели ABNeon фиксируются при immutable snapshot. FastCycle записывает первое наблюдаемое касание до обработки live-выходов; цели не меняют стоп, BE, trailing, Telegram или статус позиции.",
      variants: [...variants.entries()].map(serialize),
      patterns: [...patterns.entries()].map(serialize),
      ineligibleReasons: [...reasons.entries()].map(([reason, count]) => ({
        reason,
        count,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "altbullet-take-profit-shadow-analysis error");
    res
      .status(500)
      .json({ error: "Failed to get ABNeon take-profit shadow analysis" });
  }
});

// GET /api/tracker/drawdown-risk-analysis — observational risk bands from
// direction-aware minima, normalized by each position's personal stop.
router.get("/tracker/drawdown-risk-analysis", async (req, res) => {
  try {
    const pattern = req.query.pattern as string | undefined;
    const conditions = [
      activeTrackedPatternCondition(),
      inArray(trackedSignalsTable.status, DRAWDOWN_OUTCOME_STATUSES),
      lcStatsExclusionSql(
        sql`${trackedSignalsTable.id}`,
        sql`${trackedSignalsTable.sentimentKey}`,
      ),
    ];

    const rows = await db
      .select({
        signalId: trackedSignalsTable.id,
        sentimentKey: trackedSignalsTable.sentimentKey,
        status: trackedSignalsTable.status,
        detectedAt: trackedSignalsTable.detectedAt,
        finalPnlPct: trackedSignalsTable.pnlPercent,
        minPctFromEntry: signalDrawdownExtremaTable.minPctFromEntry,
        minObservedAt: signalDrawdownExtremaTable.minObservedAt,
        stopLossPct: trackedSignalsTable.stopLossPct,
      })
      .from(trackedSignalsTable)
      .leftJoin(
        signalDrawdownExtremaTable,
        eq(trackedSignalsTable.id, signalDrawdownExtremaTable.signalId),
      )
      .where(and(...conditions));

    const signalIds = rows.map((row) => row.signalId);
    const trajectoryRows =
      signalIds.length === 0
        ? []
        : await db
            .select({
              signalId: signalTrajectoryLogTable.signalId,
              snapshotAt: signalTrajectoryLogTable.snapshotAt,
              peakPct: signalTrajectoryLogTable.peakPct,
            })
            .from(signalTrajectoryLogTable)
            .where(inArray(signalTrajectoryLogTable.signalId, signalIds));
    const trajectoryBySignal = new Map<
      number,
      Array<{ snapshotAt: Date; peakPct: number | null }>
    >();
    for (const point of trajectoryRows) {
      const trajectory = trajectoryBySignal.get(point.signalId) ?? [];
      trajectory.push({
        snapshotAt: point.snapshotAt,
        peakPct: point.peakPct,
      });
      trajectoryBySignal.set(point.signalId, trajectory);
    }

    const analysisRows = rows.map((row) => ({
      signalId: row.signalId,
      sentimentKey: row.sentimentKey,
      status: row.status,
      detectedAt: row.detectedAt,
      finalPnlPct: row.finalPnlPct,
      minPctFromEntry: row.minPctFromEntry,
      minObservedAt: row.minObservedAt,
      stopLossPct: row.stopLossPct,
      trajectory: trajectoryBySignal.get(row.signalId) ?? [],
    }));
    if (pattern && pattern !== "all") {
      const fullCohort = buildDrawdownRiskAnalysis(analysisRows);
      res.json(
        buildDrawdownRiskAnalysis(
          analysisRows.filter((row) => row.sentimentKey === pattern),
          {
            forwardMinimumEligible: 20,
            forwardCohortSufficient: fullCohort.forward.sufficient,
          },
        ),
      );
      return;
    }

    res.json(buildDrawdownRiskAnalysis(analysisRows));
  } catch (err) {
    req.log.error({ err }, "drawdown-risk-analysis error");
    res.status(500).json({ error: "Failed to get drawdown risk analysis" });
  }
});

// GET /api/admin/backtest-spot-mcap — backtest: сколько сигналов заблокировал бы гейт spotVol < 1% MCap
// Целевые паттерны — те, где нет никакого spot vol условия (только они получат новый гейт)
router.get("/admin/backtest-spot-mcap", requireAdminToken, async (req, res) => {
  try {
    const { sql } = await import("drizzle-orm");
    // Паттерны с существующим spot vol gate — НЕ трогаем
    const WITH_SPOT_VOL: string[] = [];
    // Целевые паттерны (без spot vol) — им добавим 1% MCap
    const TARGET = ["bullish_accumulation"];

    const byPattern = await db.execute(sql`
      SELECT
        sentiment_key,
        COUNT(*)::int                                                                        AS total,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NULL)::int                            AS no_data,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::int   AS would_block,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::int  AS would_pass,
        ROUND(MIN(entry_spot_mcap_pct)::numeric, 3)                                         AS min_pct,
        ROUND(AVG(entry_spot_mcap_pct)::numeric, 2)                                         AS avg_pct,
        COUNT(*) FILTER (WHERE status = 'stop_loss' AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::int AS stops_below,
        COUNT(*) FILTER (WHERE status = 'profit'    AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::int AS profits_below,
        COUNT(*) FILTER (WHERE status = 'stop_loss' AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::int AS stops_above,
        COUNT(*) FILTER (WHERE status = 'profit'    AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::int AS profits_above,
        ROUND(AVG(pnl_percent) FILTER (WHERE status IN ('profit','stop_loss','expired') AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::numeric, 2) AS avg_closed_pnl_below,
        ROUND(AVG(pnl_percent) FILTER (WHERE status IN ('profit','stop_loss','expired') AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::numeric, 2) AS avg_closed_pnl_above
      FROM tracked_signals
      WHERE sentiment_key = ANY(${TARGET})
      GROUP BY sentiment_key
      ORDER BY total DESC
    `);

    const summary = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                                        AS total,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NULL)::int                            AS no_data,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::int   AS would_block,
        COUNT(*) FILTER (WHERE entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::int  AS would_pass,
        COUNT(*) FILTER (WHERE status = 'stop_loss' AND entry_spot_mcap_pct < 1.0)::int    AS stops_blocked,
        COUNT(*) FILTER (WHERE status = 'profit'    AND entry_spot_mcap_pct < 1.0)::int    AS profits_blocked,
        ROUND(AVG(pnl_percent) FILTER (WHERE status IN ('profit','stop_loss','expired') AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct < 1.0)::numeric, 2) AS avg_pnl_blocked,
        ROUND(AVG(pnl_percent) FILTER (WHERE status IN ('profit','stop_loss','expired') AND entry_spot_mcap_pct IS NOT NULL AND entry_spot_mcap_pct >= 1.0)::numeric, 2) AS avg_pnl_passed
      FROM tracked_signals
      WHERE sentiment_key = ANY(${TARGET})
    `);

    res.json({
      ok: true,
      targetPatterns: TARGET,
      withSpotVolAlready: WITH_SPOT_VOL,
      summary: summary.rows[0],
      byPattern: byPattern.rows,
    });
  } catch (err) {
    req.log.error({ err }, "admin/backtest-spot-mcap error");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/scanner/pattern-debug/rejected-tokens?hours=3&pattern=&symbol=
// Последняя причина отказа по каждому токену и паттерну (scan_reject_log).
router.get(
  "/scanner/pattern-debug/rejected-tokens",
  requireAdminToken,
  async (req, res) => {
    const rawHours = Number(req.query.hours ?? 3);
    const hours = Number.isFinite(rawHours)
      ? Math.min(Math.max(rawHours, 1), 72)
      : 3;
    const pattern =
      typeof req.query.pattern === "string" ? req.query.pattern.trim() : "";
    const symbol =
      typeof req.query.symbol === "string"
        ? req.query.symbol
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9_-]/g, "")
        : "";
    try {
      const hidden = PDB_HIDDEN_PATTERN_KEYS;
      // Source: pattern_decision_snapshots (covers every active pattern incl.
      // liquidation_cascade, with the reject-time price). Candle extremes come
      // from stored post-decision 15m trajectory when it exists.
      const result = await db.execute(sql`
        SELECT t.symbol, t.pattern, t.reason, t.cycle_at, t.price24h,
               t.entry_price, t.trajectory_status,
               c.max_high, c.min_low, c.candles
          FROM (
            SELECT * FROM (
              SELECT DISTINCT ON (symbol, pattern_key)
                     id, symbol, pattern_key AS pattern,
                     decision_reason AS reason, decision_at AS cycle_at,
                     (entry_metrics->>'price24h')::float AS price24h,
                     entry_price, trajectory_status
                FROM pattern_decision_snapshots
               WHERE decision_at > now() - (${hours} * interval '1 hour')
                 AND decision_kind IN ('rejected', 'blocked', 'deferred')
                 ${pattern ? sql`AND pattern_key = ${pattern}` : sql``}
                 ${symbol ? sql`AND symbol ILIKE ${symbol + "%"}` : sql``}
                 ${
                   hidden.length > 0
                     ? sql`AND pattern_key NOT IN (${sql.join(
                         hidden.map((h) => sql`${h}`),
                         sql`, `,
                       )})`
                     : sql``
                 }
               ORDER BY symbol, pattern_key, decision_at DESC
            ) d
            ORDER BY cycle_at DESC
            LIMIT 500
          ) t
          LEFT JOIN LATERAL (
            SELECT max(high) AS max_high, min(low) AS min_low,
                   count(*)::int AS candles
              FROM pattern_backfill_candles pc
             WHERE pc.decision_snapshot_id = t.id
          ) c ON true
         ORDER BY t.cycle_at DESC
      `);
      let prices = new Map<string, number>();
      try {
        const tickers = await getFutureTickers();
        prices = new Map(
          tickers
            .map((tk) => [tk.symbol, Number(tk.lastPrice)] as const)
            .filter(([, v]) => Number.isFinite(v) && v > 0),
        );
      } catch (err) {
        req.log.warn({ err }, "rejected-tokens: ticker fetch failed");
      }
      const pct = (v: unknown, base: number) =>
        v === null || v === undefined || !(Number(v) > 0)
          ? null
          : (Number(v) / base - 1) * 100;
      const rows = result.rows.map((r) => {
        const row = r as Record<string, unknown>;
        const entry = Number(row.entry_price);
        const hasEntry = Number.isFinite(entry) && entry > 0;
        const now = prices.get(String(row.symbol)) ?? null;
        return {
          symbol: row.symbol,
          pattern: row.pattern,
          reason: row.reason,
          cycle_at: row.cycle_at,
          price24h: row.price24h ?? null,
          entryPrice: hasEntry ? entry : null,
          nowPct: hasEntry && now ? pct(now, entry) : null,
          peakPct: hasEntry ? pct(row.max_high, entry) : null,
          troughPct: hasEntry ? pct(row.min_low, entry) : null,
          candles: row.candles ?? 0,
        };
      });
      res.json({ hours, rows });
    } catch (err) {
      req.log.error({ err }, "pattern-debug rejected-tokens error");
      res.status(500).json({ error: "DB error" });
    }
  },
);

// GET /api/scanner/pattern-debug/aggregate — агрегат по паттернам: checked/passed/topRejections за последние N циклов
router.get(
  "/scanner/pattern-debug/aggregate",
  requireAdminToken,
  async (req, res) => {
    const cycles = Math.max(1, Math.min(Number(req.query.cycles ?? 20), 200));
    try {
      // Паттерны удалённые из активного скоринга — фильтруются из агрегата.
      // ВАЖНО: определяем ДО запросов — latestRow query использует этот список
      // чтобы найти последний цикл с РЕАЛЬНЫМИ (не удалёнными) паттернами.
      // Если брать просто MAX(cycleNumber), можно попасть на цикл где только
      // исторические/удалённые паттерны → fromCycle смотрит не туда → patterns=[].
      const DELETED_PATTERNS_ARRAY = PDB_HIDDEN_PATTERN_KEYS;
      const DELETED_PATTERNS = new Set(DELETED_PATTERNS_ARRAY);

      // Cycle numbers are globally allocated and may contain gaps after an
      // interrupted worker. Select identities, not latestCycle - N.
      const persistedCycleRows = await db
        .selectDistinct({ cycleNumber: patternDebugLogTable.cycleNumber })
        .from(patternDebugLogTable)
        .where(
          and(
            isNull(patternDebugLogTable.symbol),
            isNotNull(patternDebugLogTable.cycleNumber),
            not(inArray(patternDebugLogTable.pattern, DELETED_PATTERNS_ARRAY)),
            sql`${patternDebugLogTable.pattern} not like 'liqgate_%'`,
          ),
        )
        .orderBy(sql`${patternDebugLogTable.cycleNumber} DESC NULLS LAST`)
        .limit(cycles + 1);
      const persistedCycles = persistedCycleRows.flatMap((row) =>
        row.cycleNumber == null ? [] : [row.cycleNumber],
      );
      const currentCycle =
        Object.keys(lastPatternDebug).length > 0
          ? lastPatternDebugCycleNumber
          : null;
      const selectedCycles = selectLatestPatternDebugCycles(
        persistedCycles,
        cycles,
        currentCycle,
      );
      const persistedCycleSet = new Set(persistedCycles);
      const includeCurrentInAggregate =
        currentCycle !== null && !persistedCycleSet.has(currentCycle);
      const latestCycle = selectedCycles[0] ?? 0;

      // Читаем aggregate-строки (symbol IS NULL) за последние N циклов
      const rows = await db
        .select({
          pattern: patternDebugLogTable.pattern,
          cycleNumber: patternDebugLogTable.cycleNumber,
          checked: patternDebugLogTable.checked,
          passed: patternDebugLogTable.passed,
          rejectedAt: patternDebugLogTable.rejectedAt,
        })
        .from(patternDebugLogTable)
        .where(
          and(
            isNull(patternDebugLogTable.symbol),
            inArray(patternDebugLogTable.cycleNumber, selectedCycles),
          ),
        )
        .orderBy(asc(patternDebugLogTable.cycleNumber));

      // Агрегируем по паттерну
      const byPattern = new Map<
        string,
        {
          checked: number;
          passed: number;
          rejectedAt: Record<string, number>;
          cycles: number;
        }
      >();
      const addAggregateRow = (row: {
        pattern: string;
        checked: number;
        passed: number;
        rejectedAt: string | null;
      }) => {
        if (DELETED_PATTERNS.has(row.pattern)) return;
        const e = byPattern.get(row.pattern) ?? {
          checked: 0,
          passed: 0,
          rejectedAt: {},
          cycles: 0,
        };
        e.checked += row.checked;
        e.passed += row.passed;
        e.cycles += 1;
        if (row.rejectedAt) {
          try {
            const gates = JSON.parse(row.rejectedAt) as Record<string, number>;
            for (const [gate, count] of Object.entries(gates)) {
              e.rejectedAt[gate] =
                (e.rejectedAt[gate] ?? 0) + (count as number);
            }
          } catch {
            /* ignore */
          }
        }
        byPattern.set(row.pattern, e);
      };
      for (const row of rows) addAggregateRow(row);

      const toPatternRow = (
        pattern: string,
        e: {
          checked: number;
          passed: number;
          rejectedAt: Record<string, number>;
          cycles: number;
        },
      ) => {
        const totalRejections = Object.values(e.rejectedAt).reduce(
          (s, v) => s + v,
          0,
        );
        const topRejections = Object.entries(e.rejectedAt)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 7)
          .map(([gate, count]) => ({
            gate,
            count,
            pct:
              totalRejections > 0
                ? +((count / totalRejections) * 100).toFixed(1)
                : 0,
          }));
        const topRejectCoverage = +topRejections
          .reduce((s, r) => s + r.pct, 0)
          .toFixed(1);
        const totalGates = Object.keys(e.rejectedAt).length;
        return {
          pattern,
          checked: e.checked,
          passed: e.passed,
          passRate:
            e.checked > 0 ? +((e.passed / e.checked) * 100).toFixed(1) : 0,
          cycles: e.cycles,
          topRejections,
          topRejectCoverage,
          totalGates,
        };
      };

      if (includeCurrentInAggregate && currentCycle !== null) {
        for (const [pattern, live] of Object.entries(lastPatternDebug)) {
          if (pattern.startsWith("liqgate_")) continue;
          if (DELETED_PATTERNS.has(pattern)) continue;
          addAggregateRow({
            pattern,
            checked: live.checked,
            passed: live.passed,
            rejectedAt: JSON.stringify(live.rejectedAt),
          });
        }
      }
      const patterns = [...byPattern.entries()]
        .filter(([p]) => !p.startsWith("liqgate_")) // pseudo-keys — отдельно
        .map(([pattern, e]) => toPatternRow(pattern, e))
        .sort((a, b) => b.checked - a.checked);

      res.json({
        cyclesRequested: cycles,
        latestCycle,
        liveSnapshot: lastPatternDebug,
        patterns,
      });
    } catch (err) {
      req.log.error({ err }, "pattern-debug/aggregate: DB error");
      res.status(500).json({ error: String(err) });
    }
  },
);

// GET /api/admin/prescan-snapshots — per-cycle metric trajectory while token was in prescan pool
// ?symbol=BTC-USDT&since=ISO&until=ISO&limit=50
router.get("/admin/prescan-snapshots", requireAdminToken, async (req, res) => {
  const symbol = String(req.query["symbol"] ?? "").trim();
  if (!symbol) {
    res.status(400).json({ error: "symbol required" });
    return;
  }
  const limit = Math.min(
    parseInt(String(req.query["limit"] ?? "50")) || 50,
    200,
  );
  const since = req.query["since"]
    ? new Date(String(req.query["since"]))
    : null;
  const until = req.query["until"]
    ? new Date(String(req.query["until"]))
    : null;
  try {
    const conditions: ReturnType<typeof eq>[] = [
      eq(prescanSnapshotsTable.symbol, symbol),
    ];
    if (since) conditions.push(gte(prescanSnapshotsTable.cycleAt, since));
    if (until) conditions.push(lte(prescanSnapshotsTable.cycleAt, until));
    const rows = await db
      .select({
        cycleAt: prescanSnapshotsTable.cycleAt,
        p24h: prescanSnapshotsTable.p24h,
        p1h: prescanSnapshotsTable.p1h,
        oi30m: prescanSnapshotsTable.oi30m,
        oi1h: prescanSnapshotsTable.oi1h,
        oi4h: prescanSnapshotsTable.oi4h,
        volMult: prescanSnapshotsTable.volMult,
        spotVolUsd24h: prescanSnapshotsTable.spotVolUsd24h,
        futSpotRatio: prescanSnapshotsTable.futSpotRatio,
        whaleIndex: prescanSnapshotsTable.whaleIndex,
        snf1h: prescanSnapshotsTable.snf1h,
        fundingRate: prescanSnapshotsTable.fundingRate,
        obRatio: prescanSnapshotsTable.obRatio,
        cvd30m: prescanSnapshotsTable.cvd30m,
        cvd1h: prescanSnapshotsTable.cvd1h,
        cvd4h: prescanSnapshotsTable.cvd4h,
        cyclesInPool: prescanSnapshotsTable.cyclesInPool,
      })
      .from(prescanSnapshotsTable)
      .where(and(...conditions))
      .orderBy(asc(prescanSnapshotsTable.cycleAt))
      .limit(limit);
    res.json({ rows });
  } catch (err) {
    req.log.error({ err }, "prescan-snapshots error");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
