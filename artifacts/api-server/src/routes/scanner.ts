import { logger } from "../lib/logger.js";
import { cgTimedFetch } from "../lib/cg_latency.js";
import { withAggregatedKlineVolume } from "../lib/aggregated-kline-volume.js";
import { getFutureTickers } from "../lib/bingx.js";
import { Router } from "express";
import {
  getScannerState,
  getDiscoveryScannerLeaseStatus,
  startScanner,
  stopScanner,
  runScannerCycle,
  getScannerCandidates,
  getLastCycleCandidates,
  getLastCycleAt,
  lastLayerDebug,
  lastPatternDebug,
  getPrescanEntry,
  getLiveMarketData,
  getCachedPrice,
} from "../lib/scanner.js";
import {
  isBingxExclusive,
  isBinanceSpotListed,
  areBinanceListingsLoaded,
} from "../lib/coinglass_listings.js";
import {
  getCgSupportedCoinsSet,
  CG_SYMBOL_ALIAS,
} from "../lib/coinglass_oi.js";
import {
  ACTIVE_PATTERN_KEYS,
  PDB_HIDDEN_PATTERN_KEYS,
} from "../lib/dead-patterns.js";
import { getCached, setCached } from "../lib/routeCache.js";
import {
  buildMemberScannerCandidatesResponse,
  getScannerCandidatesCacheKey,
  normalizeMemberSearchQuery,
} from "../lib/scanner-candidates-view.js";
import {
  sendDailyReport,
  sendWeeklyDigest,
  runAuditReport,
  getWatcherJobTimings,
} from "../lib/watcher.js";
import { getApiConnected } from "../lib/apiHealth.js";
import { getTelegramDeliveryHealth } from "../lib/telegram-photo-outbox.js";
import {
  db,
  liqCascadeWatchTable,
  prescanHistoryTable,
  prescanSnapshotsTable,
  oiWatchTable,
  prescanTrackerTable,
  patternDebugLogTable,
  trackedSignalsTable,
  signalsTable,
  inflowOutflowL14PoolTable,
  scanRejectLogTable,
  getDbPoolSnapshot,
  getSchedulerPoolSnapshot,
} from "@workspace/db";
import {
  eq,
  desc,
  inArray,
  and,
  gte,
  isNotNull,
  sql,
  notInArray,
  ne,
} from "drizzle-orm";
import {
  broadcastBatchAlert,
  resolvePrimarySignalPolicyContext,
  type AlphaResult,
} from "../lib/telegram.js";
import { requireAdminToken } from "../middleware/adminAuth.js";
import {
  requireAuthenticatedDashboardAccess,
  requireDashboardOwner,
} from "../middleware/dashboardAccess.js";
import {
  getAllSpotNetflow,
  getCacheUpdatedAt,
} from "../lib/spot-netflow-cache.js";
import { ANALYSIS_BLOCKED_SYMBOLS } from "../lib/excluded-signal-symbols.js";
import { buildMemberSymbolStatusHistory } from "../lib/scanner-member-symbol-history.js";
import { createScannerBotHealthHandler } from "../lib/scanner-health.js";
import { getPatternTrajectoryBacklogStatus } from "../lib/pattern-decision-history.js";
import {
  analyzeStealthWindowCalibration,
  STEALTH_WINDOW_VERSION,
  type StealthWindowOutcome,
  type StealthWindowReplayRow,
} from "../lib/stealth-window-calibration.js";

const router = Router();
const ACTIVE_PATTERN_KEYS_SQL = sql.join(
  ACTIVE_PATTERN_KEYS.map((key) => sql`${key}`),
  sql`, `,
);

// Read-only snapshot of the server-side Spot NetFlow cache. The cache refreshes
// in the watcher, so dashboard readers never invoke CoinGlass directly.
router.get("/scanner/spot-netflow", (_req, res) => {
  res.json({
    entries: getAllSpotNetflow(),
    updatedAt: getCacheUpdatedAt() || null,
  });
});

router.get("/scanner/status", async (req, res) => {
  try {
    const cacheKey = "scanner:status";
    const hit = getCached<object>(cacheKey);
    if (hit) {
      res.json(hit);
      return;
    }

    const [state, discoveryLease] = await Promise.all([
      getScannerState(),
      getDiscoveryScannerLeaseStatus(),
    ]);
    const result = {
      running: state.running,
      lastScanAt: state.lastScanAt?.toISOString() ?? null,
      scanStartedAt: state.scanStartedAt?.toISOString() ?? null,
      nextScanAt: state.nextScanAt?.toISOString() ?? null,
      totalSignals: state.totalSignals,
      signalsToday: state.signalsToday,
      marketsScanned: state.marketsScanned,
      telegramConnected: state.telegramConnected,
      bingxConnected: state.bingxConnected,
      coinglassConnected: getApiConnected("coinglass"),
      coinalyzeConnected: getApiConnected("coinalyze"),
      coinGeckoConnected: getApiConnected("coingecko"),
      coinPaprikaConnected: getApiConnected("coinpaprika"),
      scanIntervalMs: state.scanIntervalMs,
      isScanning: state.isScanning,
      lastScanDurationMs: state.lastScanDurationMs,
      lastFailureAt: state.lastFailureAt?.toISOString() ?? null,
      lastFailureReason: state.lastFailureReason,
      retryAt: state.retryAt?.toISOString() ?? null,
      activeMarketLeaseExpiresAt:
        state.activeMarketLeaseExpiresAt?.toISOString() ?? null,
      database: {
        appPool: getDbPoolSnapshot(),
        schedulerPool: getSchedulerPoolSnapshot(),
        discoveryLease: {
          busy: discoveryLease.busy,
          ownerToken: discoveryLease.ownerToken,
          acquiredAt: discoveryLease.acquiredAt?.toISOString() ?? null,
          heartbeatAt: discoveryLease.heartbeatAt?.toISOString() ?? null,
          expiresAt: discoveryLease.expectedExpiryAt?.toISOString() ?? null,
        },
      },
      oiWatch: {
        lastInsertAt: state.oiWatchLastInsertAt?.toISOString() ?? null,
        insertErrors: state.oiWatchInsertErrors,
        lastInsertError: state.oiWatchLastInsertError,
        insertsLastScan: state.oiWatchInsertsLastScan,
        cgTimeoutsLastScan: state.cgTimeoutsLastScan,
      },
      cgLatency: state.lastCgTelemetry
        ? {
            timeoutPct: state.lastCgTelemetry.cgTimeoutPct,
            p50Ms: state.lastCgTelemetry.cgP50Ms,
            p95Ms: state.lastCgTelemetry.cgP95Ms,
            maxMs: state.lastCgTelemetry.cgMaxMs,
            req: state.lastCgTelemetry.cgReq,
            reqPerMin: state.lastCgTelemetry.cgReqPerMin,
            elLagP95Ms: state.lastCgTelemetry.elLagP95Ms,
            windowMin: state.lastCgTelemetry.windowMin,
          }
        : null,
    };
    setCached(cacheKey, result, 15_000);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get scanner status");
    res.status(500).json({ error: "Failed to get scanner status" });
  }
});

// Owner-only, aggregate delivery state. No message body, event key, or
// recipient identifier leaves the durable outbox through this endpoint.
router.get(
  "/scanner/bot-health",
  requireAdminToken,
  createScannerBotHealthHandler({
    getScannerState,
    getTelegramDeliveryHealth,
    getDiscoveryScannerLeaseStatus,
    getWatcherJobTimings,
    getApiConnected,
    pingDatabase: async () => {
      await db.execute(sql`SELECT 1`);
    },
    getDbPoolSnapshot,
    getSchedulerPoolSnapshot,
  }),
);

router.get(
  "/scanner/pattern-trajectory-status",
  requireAdminToken,
  async (req, res) => {
    try {
      const cacheKey = "scanner:pattern-trajectory-status";
      const hit = getCached<object>(cacheKey);
      if (hit) {
        res.json(hit);
        return;
      }
      const result = await getPatternTrajectoryBacklogStatus();
      setCached(cacheKey, result, 60_000);
      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Failed to get pattern trajectory status");
      res
        .status(500)
        .json({ error: "Failed to get pattern trajectory status" });
    }
  },
);

router.get(
  "/scanner/stealth-window-calibration",
  requireAdminToken,
  async (req, res) => {
    try {
      const result = await db.execute<{
        tracked_id: number | string;
        entry_at_ms: number | string;
        hypothetical_entry_price: unknown;
        pnl_percent: number | null;
        closed_at_ms: number | string;
        status: string;
        confirmation_times: unknown;
        hypothetical_entry_at: unknown;
        candle_at_ms: number | string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number | null;
      }>(sql`
      SELECT
        t.id AS tracked_id,
        (EXTRACT(EPOCH FROM t.detected_at) * 1000)::bigint AS entry_at_ms,
        t.decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryPrice' AS hypothetical_entry_price,
        t.pnl_percent,
        (EXTRACT(EPOCH FROM t.closed_at) * 1000)::bigint AS closed_at_ms,
        t.status::text AS status,
        t.decision_metrics->'stealthWindowShadow'->'confirmationCandleTimes' AS confirmation_times,
        t.decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryAt' AS hypothetical_entry_at,
        (EXTRACT(EPOCH FROM c.candle_at) * 1000)::bigint AS candle_at_ms,
        c.open, c.high, c.low, c.close, c.volume
      FROM tracked_signals t
      JOIN (
        SELECT DISTINCT ON (tracked_signal_id)
          id,
          tracked_signal_id
        FROM pattern_decision_snapshots
        WHERE decision_kind = 'fired'
          AND trajectory_status = 'complete'
        ORDER BY tracked_signal_id, id DESC
      ) d ON d.tracked_signal_id = t.id
      JOIN pattern_backfill_candles c ON c.decision_snapshot_id = d.id
        AND c.interval = '15m'
      WHERE t.sentiment_key = 'stealth_breakout'
        AND t.decision_metrics->'stealthWindowShadow'->>'version' = ${STEALTH_WINDOW_VERSION}
        AND jsonb_typeof(t.decision_metrics->'stealthWindowShadow'->'confirmationCandleTimes') = 'array'
        AND jsonb_array_length(t.decision_metrics->'stealthWindowShadow'->'confirmationCandleTimes') >= 2
        AND t.decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryAt' IS NOT NULL
        AND (t.decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryPrice')::double precision > 0
        AND t.closed_at IS NOT NULL
        AND t.status::text IN ('profit', 'bu_stop', 'breakeven', 'stop_loss', 'expired')
      ORDER BY t.id, c.candle_at
    `);
      const grouped = new Map<number, StealthWindowReplayRow>();
      for (const row of result.rows) {
        const entryAt = Number(row.hypothetical_entry_at);
        const closedAt = Number(row.closed_at_ms);
        const trackedId = Number(row.tracked_id);
        if (!Number.isFinite(entryAt) || !Number.isFinite(closedAt)) continue;
        if (!Number.isFinite(trackedId)) continue;
        const existing = grouped.get(trackedId);
        const candle = {
          time: Number(row.candle_at_ms),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          volume: Number(row.volume ?? 0),
        };
        if (existing) existing.candles = [...existing.candles, candle];
        else {
          grouped.set(trackedId, {
            entryAt,
            entryPrice: Number(row.hypothetical_entry_price),
            closedAt,
            outcome: row.status as StealthWindowOutcome,
            pnlPct: row.pnl_percent == null ? null : Number(row.pnl_percent),
            candles: [candle],
          });
        }
      }
      const completeRows = [...grouped.values()].filter((row) => {
        const horizonEnd = Math.min(
          row.closedAt,
          row.entryAt + 72 * 60 * 60 * 1000,
        );
        const firstBucket =
          Math.ceil(row.entryAt / (15 * 60 * 1000)) * (15 * 60 * 1000);
        const lastBucket =
          Math.floor(horizonEnd / (15 * 60 * 1000)) * (15 * 60 * 1000);
        const candles = [...row.candles]
          .filter(
            (candle) => candle.time >= firstBucket && candle.time <= lastBucket,
          )
          .sort((a, b) => a.time - b.time);
        const expectedCount =
          lastBucket >= firstBucket
            ? Math.floor((lastBucket - firstBucket) / (15 * 60 * 1000)) + 1
            : 0;
        return (
          expectedCount > 0 &&
          candles.length === expectedCount &&
          candles.every(
            (candle, index) =>
              candle.time === firstBucket + index * 15 * 60 * 1000,
          )
        );
      });
      const period = await db.execute<{
        period_start_ms: number | null;
        period_end_ms: number | null;
        original_fired: number;
        window_qualified: number;
      }>(sql`
      WITH period AS (
        SELECT
          MIN((decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryAt')::double precision) AS start_ms,
          MAX((decision_metrics->'stealthWindowShadow'->>'hypotheticalEntryAt')::double precision) AS end_ms
        FROM tracked_signals
        WHERE sentiment_key = 'stealth_breakout'
          AND decision_metrics->'stealthWindowShadow'->>'version' = ${STEALTH_WINDOW_VERSION}
      )
      SELECT
        MIN(start_ms)::bigint AS period_start_ms,
        MAX(end_ms)::bigint AS period_end_ms,
        COUNT(t.id) FILTER (
          WHERE t.sentiment_key = 'stealth_breakout'
            AND t.detected_at BETWEEN to_timestamp(p.start_ms / 1000.0)
              AND to_timestamp(p.end_ms / 1000.0)
            AND t.status::text IN ('profit', 'bu_stop', 'breakeven', 'stop_loss', 'expired')
        )::int AS original_fired,
        COUNT(t.id) FILTER (
          WHERE t.sentiment_key = 'stealth_breakout'
            AND t.detected_at BETWEEN to_timestamp(p.start_ms / 1000.0)
              AND to_timestamp(p.end_ms / 1000.0)
            AND t.decision_metrics->'stealthWindowShadow'->>'version' = ${STEALTH_WINDOW_VERSION}
            AND jsonb_typeof(t.decision_metrics->'stealthWindowShadow'->'confirmationCandleTimes') = 'array'
            AND jsonb_array_length(
              COALESCE(t.decision_metrics->'stealthWindowShadow'->'confirmationCandleTimes', '[]'::jsonb)
            ) >= 2
        )::int AS window_qualified
      FROM period p
      LEFT JOIN tracked_signals t ON p.start_ms IS NOT NULL AND p.end_ms IS NOT NULL
    `);
      const periodRow = period.rows[0];
      const periodDays =
        periodRow?.period_start_ms != null && periodRow.period_end_ms != null
          ? (Number(periodRow.period_end_ms) -
              Number(periodRow.period_start_ms)) /
            86_400_000
          : null;
      res.json({
        ...analyzeStealthWindowCalibration(completeRows),
        baseline: {
          periodStart: periodRow?.period_start_ms
            ? new Date(Number(periodRow.period_start_ms)).toISOString()
            : null,
          periodEnd: periodRow?.period_end_ms
            ? new Date(Number(periodRow.period_end_ms)).toISOString()
            : null,
          originalFired: Number(periodRow?.original_fired ?? 0),
          windowQualified: Number(periodRow?.window_qualified ?? 0),
          retentionPct:
            Number(periodRow?.original_fired ?? 0) > 0
              ? Number(
                  (
                    (Number(periodRow?.window_qualified ?? 0) /
                      Number(periodRow?.original_fired ?? 0)) *
                    100
                  ).toFixed(2),
                )
              : null,
          originalPerDay:
            periodDays && periodDays > 0
              ? Number(
                  (Number(periodRow?.original_fired ?? 0) / periodDays).toFixed(
                    2,
                  ),
                )
              : null,
          windowPerDay:
            periodDays && periodDays > 0
              ? Number(
                  (
                    Number(periodRow?.window_qualified ?? 0) / periodDays
                  ).toFixed(2),
                )
              : null,
        },
        source:
          "tracked_signals.decision_metrics + complete pattern_backfill_candles 15m",
        excludedRows: grouped.size - completeRows.length,
        liveStopChanged: false,
      });
    } catch (err) {
      req.log.error({ err }, "Failed to calculate Stealth window calibration");
      res
        .status(500)
        .json({ error: "Failed to calculate Stealth window calibration" });
    }
  },
);

router.get("/scanner/prescan-debug", requireAdminToken, async (req, res) => {
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

router.post("/scanner/start", requireAdminToken, async (req, res) => {
  try {
    await startScanner();
    res.json({ success: true, message: "Scanner started" });
  } catch (err) {
    req.log.error({ err }, "Failed to start scanner");
    res
      .status(500)
      .json({ success: false, message: "Failed to start scanner" });
  }
});

router.post("/scanner/stop", requireAdminToken, async (req, res) => {
  try {
    await stopScanner();
    res.json({ success: true, message: "Scanner stopped" });
  } catch (err) {
    req.log.error({ err }, "Failed to stop scanner");
    res.status(500).json({ success: false, message: "Failed to stop scanner" });
  }
});

router.post("/scanner/scan-now", requireAdminToken, async (req, res) => {
  try {
    const result = await runScannerCycle();
    if (!result) {
      res.status(409).json({
        success: false,
        message: "Another market cycle is already running",
      });
      return;
    }
    res.json({
      success: true,
      signalsFound: result.signalsFound,
      marketsScanned: result.marketsScanned,
      durationMs: result.durationMs,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to run scan");
    res.status(500).json({
      success: false,
      signalsFound: 0,
      marketsScanned: 0,
      durationMs: 0,
    });
  }
});

router.get("/scanner/candidates", async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? "50")) || 50, 1),
      150,
    );
    const offset = Math.max(parseInt(String(req.query.offset ?? "0")) || 0, 0);
    const isOwner = res.locals.dashboardIsOwner === true;
    const normalizedQuery = isOwner
      ? ""
      : normalizeMemberSearchQuery(req.query.q);
    const cacheKey = getScannerCandidatesCacheKey(
      isOwner,
      limit,
      offset,
      normalizedQuery,
    );
    const hit = getCached<object>(cacheKey);
    if (hit) {
      res.json(hit);
      return;
    }
    const data = await getScannerCandidates();
    if (!isOwner) {
      const liqCascadeRows = await db
        .select({ symbol: liqCascadeWatchTable.symbol })
        .from(liqCascadeWatchTable)
        .where(eq(liqCascadeWatchTable.status, "watching"));
      const result = buildMemberScannerCandidatesResponse(
        data,
        offset,
        limit,
        liqCascadeRows.map((row) => row.symbol),
        normalizedQuery,
      );
      setCached(cacheKey, result, 20_000);
      res.json(result);
      return;
    }

    const result = {
      ...data,
      prescan: data.prescan.slice(offset, offset + limit),
      oiWatch: data.oiWatch.slice(offset, offset + limit),
      totalPrescan: data.prescan.length,
      totalOiWatch: data.oiWatch.length,
      nextOffset:
        offset + limit < Math.max(data.prescan.length, data.oiWatch.length)
          ? offset + limit
          : null,
    };
    setCached(cacheKey, result, 20_000);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get scanner candidates");
    res.status(500).json({ error: "Failed to get scanner candidates" });
  }
});

router.get("/scanner/symbol-status-history", async (req, res) => {
  const symbol = String(req.query.symbol ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{1,32}-USDT$/.test(symbol)) {
    res.status(400).json({ error: "Valid symbol is required" });
    return;
  }
  try {
    const [prescanRows, oiWatchRows] = await Promise.all([
      db
        .select({
          ts: prescanHistoryTable.ts,
          score: prescanHistoryTable.score,
          price24h: prescanHistoryTable.price24h,
          oi30m: prescanHistoryTable.oi30m,
          oi1h: prescanHistoryTable.oi1h,
          oi4h: prescanHistoryTable.oi4h,
        })
        .from(prescanHistoryTable)
        .where(eq(prescanHistoryTable.symbol, symbol))
        .orderBy(desc(prescanHistoryTable.ts))
        .limit(120),
      db
        .select({
          id: oiWatchTable.id,
          status: oiWatchTable.status,
          triggerTf: oiWatchTable.triggerTf,
          addedAt: oiWatchTable.addedAt,
          expiresAt: oiWatchTable.expiresAt,
          firedAt: oiWatchTable.firedAt,
        })
        .from(oiWatchTable)
        .where(eq(oiWatchTable.symbol, symbol))
        .orderBy(desc(oiWatchTable.addedAt))
        .limit(50),
    ]);
    res.json(buildMemberSymbolStatusHistory(symbol, prescanRows, oiWatchRows));
  } catch (err) {
    req.log.error(
      { err, symbol },
      "Failed to get member symbol status history",
    );
    res.status(500).json({ error: "Failed to get symbol status history" });
  }
});

router.get(
  "/scanner/symbol-indicator-history",
  requireAuthenticatedDashboardAccess,
  async (req, res) => {
    const symbol = String(req.query.symbol ?? "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9]{2,30}-USDT$/.test(symbol)) {
      res.status(400).json({ error: "Valid symbol is required" });
      return;
    }
    try {
      const [snapshots, signalReadings] = await Promise.all([
        db
          .select({
            at: prescanSnapshotsTable.cycleAt,
            price: prescanSnapshotsTable.price,
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
          .where(eq(prescanSnapshotsTable.symbol, symbol))
          .orderBy(desc(prescanSnapshotsTable.cycleAt))
          .limit(1000),
        db
          .select({
            at: trackedSignalsTable.detectedAt,
            pattern: trackedSignalsTable.sentimentKey,
            rsi1h: trackedSignalsTable.entryRsi1h,
            // Keep historical signal annotations available to the retained
            // token chart without adding these retired values to the DB schema.
            rsi5: sql<
              number | null
            >`NULLIF(to_jsonb(${trackedSignalsTable})->>'entry_rsi_5', '')::real`,
            rsi5Divergence: sql<
              string | null
            >`to_jsonb(${trackedSignalsTable})->>'entry_rsi_5_divergence'`,
            williamsR21: sql<
              number | null
            >`NULLIF(to_jsonb(${trackedSignalsTable})->>'entry_williams_r_21', '')::real`,
            williamsR21Ema13: sql<
              number | null
            >`NULLIF(to_jsonb(${trackedSignalsTable})->>'entry_williams_r_21_ema_13', '')::real`,
          })
          .from(trackedSignalsTable)
          .where(eq(trackedSignalsTable.symbol, symbol))
          .orderBy(desc(trackedSignalsTable.detectedAt))
          .limit(100),
      ]);
      res.json({
        symbol,
        snapshots: snapshots.reverse().map((row) => ({
          ...row,
          at: row.at.toISOString(),
        })),
        signalReadings: signalReadings.map((row) => ({
          ...row,
          at: row.at.toISOString(),
          pattern: row.pattern ?? "Неизвестный паттерн",
        })),
      });
    } catch (err) {
      req.log.error({ err, symbol }, "Failed to get symbol indicator history");
      res.status(500).json({ error: "Failed to get symbol indicator history" });
    }
  },
);

router.get(
  "/scanner/symbol-history",
  requireDashboardOwner,
  async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    if (!symbol) {
      res.status(400).json({ error: "symbol is required" });
      return;
    }
    try {
      const [prescanHistory, oiWatchHistory] = await Promise.all([
        db
          .select()
          .from(prescanHistoryTable)
          .where(eq(prescanHistoryTable.symbol, symbol))
          .orderBy(desc(prescanHistoryTable.ts))
          .limit(120),
        db
          .select({
            id: oiWatchTable.id,
            triggerTf: oiWatchTable.triggerTf,
            oiChange: oiWatchTable.oiChange,
            priceAtEntry: oiWatchTable.priceAtEntry,
            volumeMultiplier: oiWatchTable.volumeMultiplier,
            sentimentKey: oiWatchTable.sentimentKey,
            status: oiWatchTable.status,
            addedAt: oiWatchTable.addedAt,
            expiresAt: oiWatchTable.expiresAt,
            firedAt: oiWatchTable.firedAt,
            oi30m: oiWatchTable.oi30mChange,
            oi1h: oiWatchTable.oi1hChange,
            oi24h: oiWatchTable.oi24hChange,
            price1hChange: oiWatchTable.price1hChange,
            price24hChange: oiWatchTable.price24hChange,
            volStatusReason: oiWatchTable.volStatusReason,
          })
          .from(oiWatchTable)
          .where(eq(oiWatchTable.symbol, symbol))
          .orderBy(desc(oiWatchTable.addedAt))
          .limit(50),
      ]);

      const cgFuturesSet = getCgSupportedCoinsSet();
      const listingsLoaded = areBinanceListingsLoaded();
      const symbolBase = symbol.replace(/-USDT$/, "").toUpperCase();
      const cgBase =
        (CG_SYMBOL_ALIAS as Record<string, string>)[symbolBase] ?? symbolBase;
      const coverage = {
        // true = token has CG futures data; null = data not yet loaded
        cgFutures: cgFuturesSet ? cgFuturesSet.has(cgBase) : null,
        // true = token listed on Binance spot; null = data not yet loaded
        binanceSpot: listingsLoaded ? isBinanceSpotListed(symbol) : null,
        // true = token is BingX-exclusive (no CG futures, no Binance spot)
        bingxOnly:
          cgFuturesSet && listingsLoaded ? isBingxExclusive(symbol) : null,
      };

      res.json({
        symbol,
        coverage,
        prescanHistory: prescanHistory.map((r) => ({
          ts: r.ts.toISOString(),
          cycleCount: r.cycleCount,
          rank: r.rank,
          score: r.score,
          price24h: r.price24h,
          price1h: r.price1h,
          oi30m: r.oi30m,
          oi1h: r.oi1h,
          oi4h: r.oi4h,
          oi24h: r.oi24h,
          volMult: r.volMult,
          cvd30m: r.cvd30m,
          cvd1h: r.cvd1h,
          netBuyPct: r.netBuyPct,
          spotTakerNetBuy: r.spotTakerNetBuy,
          oiAccel30m: r.oiAccel30m,
          futSpotRatio: r.futSpotRatio,
        })),
        oiWatchHistory: oiWatchHistory.map((r) => ({
          id: r.id,
          triggerTf: r.triggerTf,
          oiChange: r.oiChange,
          priceAtEntry: r.priceAtEntry,
          volumeMultiplier: r.volumeMultiplier,
          sentimentKey: r.sentimentKey ?? null,
          status: r.status,
          addedAt: r.addedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          firedAt: r.firedAt?.toISOString() ?? null,
          oi30m: r.oi30m ?? null,
          oi1h: r.oi1h ?? null,
          oi24h: r.oi24h ?? null,
          price1hChange: r.price1hChange ?? null,
          price24hChange: r.price24hChange ?? null,
          volStatusReason: r.volStatusReason ?? null,
        })),
      });
    } catch (err) {
      req.log.error({ err }, "Failed to get symbol history");
      res.status(500).json({ error: "Failed to get symbol history" });
    }
  },
);

// GET /api/scanner/inspect?symbols=SOL-USDT,ETH-USDT
// Ручная инспекция символов для виджета "Инспектор" на дашборде: собирает
// текущий срез live-метрик (OI/CVD/volMult/taker) + активный OI Watch + активный
// tracked signal, чтобы пользователь мог проверить конкретную открытую позицию.
router.get("/scanner/inspect", async (req, res) => {
  const raw = String(req.query.symbols ?? "");
  if (!raw) {
    res.status(400).json({ error: "symbols param required (comma-separated)" });
    return;
  }
  const symbols = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ).slice(0, 20);
  if (symbols.length === 0) {
    res.json({ symbols: [] });
    return;
  }

  try {
    const liveData = getLiveMarketData(symbols);

    const [oiWatchRows, trackedRows] = await Promise.all([
      db
        .select({
          id: oiWatchTable.id,
          symbol: oiWatchTable.symbol,
          status: oiWatchTable.status,
          sentimentKey: oiWatchTable.sentimentKey,
          triggerTf: oiWatchTable.triggerTf,
          expiresAt: oiWatchTable.expiresAt,
          addedAt: oiWatchTable.addedAt,
        })
        .from(oiWatchTable)
        .where(
          and(
            inArray(oiWatchTable.symbol, symbols),
            inArray(oiWatchTable.status, ["watching", "confirming"]),
          ),
        ),
      db
        .select({
          id: trackedSignalsTable.id,
          symbol: trackedSignalsTable.symbol,
          status: trackedSignalsTable.status,
          signalType: trackedSignalsTable.signalType,
          sentimentKey: trackedSignalsTable.sentimentKey,
          entryPrice: trackedSignalsTable.entryPrice,
          peakPrice: trackedSignalsTable.peakPrice,
          pnlPercent: trackedSignalsTable.pnlPercent,
          isShort: trackedSignalsTable.isShort,
          detectedAt: trackedSignalsTable.detectedAt,
        })
        .from(trackedSignalsTable)
        .where(
          and(
            inArray(trackedSignalsTable.symbol, symbols),
            notInArray(trackedSignalsTable.status, [
              "profit",
              "stop_loss",
              "cancelled",
              "breakeven",
              "bu_stop",
            ]),
            ne(trackedSignalsTable.status, "reclassified"),
          ),
        )
        .orderBy(desc(trackedSignalsTable.detectedAt)),
    ]);

    const result = symbols.map((symbol) => {
      const pe = getPrescanEntry(symbol);
      const lm = liveData[symbol];
      const oiWatch = oiWatchRows.find((r) => r.symbol === symbol) ?? null;
      const tracked = trackedRows.find((r) => r.symbol === symbol) ?? null;

      return {
        symbol,
        inPrescan: !!pe,
        currentPrice: getCachedPrice(symbol),
        price24h: pe?.lastPrice24h ?? null,
        price1h: lm?.price1h ?? pe?.lastPrice1h ?? null,
        cycleCount: pe?.cycleCount ?? null,
        oi30m: lm?.oi30m ?? pe?.lastOi30m ?? null,
        oi1h: lm?.oi1h ?? pe?.lastOi1h ?? null,
        oi4h: lm?.oi4h ?? pe?.lastOi4h ?? null,
        oi24h: lm?.oi24h ?? pe?.lastOi24h ?? null,
        volMult: pe?.lastVolMult ?? null,
        cvd30m: lm?.cvd30m ?? pe?.lastCvd30m ?? null,
        cvd1h: lm?.cvd1h ?? pe?.lastCvd1h ?? null,
        cvd4h: lm?.cvd4h ?? pe?.lastCvd4h ?? null,
        futureTakerNetBuy: lm?.netBuyPct ?? pe?.lastNetBuyPct ?? null,
        spotTakerNetBuy: lm?.spotTakerNetBuy ?? pe?.lastSpotTakerNetBuy ?? null,
        spotTakerDominance:
          lm?.spotTakerDominance ?? pe?.lastSpotTakerDominance ?? null,
        oiAccel30m: lm?.oiAccel30m ?? pe?.oiAccel30m ?? null,
        futSpotRatio: lm?.futSpotRatio ?? pe?.futSpotRatio ?? null,
        lastSkipReason: pe?.lastSkipReason ?? null,
        lastCgTimedOut: pe?.lastCgTimedOut ?? null,
        oiWatch: oiWatch
          ? {
              id: oiWatch.id,
              status: oiWatch.status,
              sentimentKey: oiWatch.sentimentKey ?? null,
              triggerTf: oiWatch.triggerTf,
              expiresAt: oiWatch.expiresAt.toISOString(),
              addedAt: oiWatch.addedAt.toISOString(),
            }
          : null,
        trackedSignal: tracked
          ? {
              id: tracked.id,
              status: tracked.status,
              signalType: tracked.signalType,
              sentimentKey: tracked.sentimentKey ?? null,
              entryPrice: tracked.entryPrice,
              peakPrice: tracked.peakPrice ?? null,
              pnlPercent: tracked.pnlPercent ?? null,
              isShort: tracked.isShort,
              detectedAt: tracked.detectedAt.toISOString(),
            }
          : null,
      };
    });

    res.json({ symbols: result });
  } catch (err) {
    req.log.error({ err }, "Failed to inspect symbols");
    res.status(500).json({ error: "Failed to inspect symbols" });
  }
});

// POST /api/scanner/resend-signal { signalId: number }
// Одноразовый ручной ресенд уже сохранённого сигнала в Telegram (например, если
// исходная рассылка упала из-за бага в шаблоне). Реконструирует AlphaResult из
// строки signals и вызывает тот же broadcastBatchAlert, что и обычный цикл.
router.post("/scanner/resend-signal", requireAdminToken, async (req, res) => {
  const signalId = Number(req.body?.signalId);
  if (!Number.isFinite(signalId)) {
    res.status(400).json({ error: "signalId (number) required in body" });
    return;
  }
  try {
    const rows = await db
      .select()
      .from(signalsTable)
      .where(eq(signalsTable.id, signalId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "signal not found" });
      return;
    }
    const linkedTrackers = await db
      .select({
        entryPolicyVersion: trackedSignalsTable.entryPolicyVersion,
        splitLimitPrice: trackedSignalsTable.splitLimitPrice,
        policyVersion: trackedSignalsTable.policyVersion,
        entryPrice: trackedSignalsTable.entryPrice,
        originalEntryPrice: trackedSignalsTable.originalEntryPrice,
        stopLossPct: trackedSignalsTable.stopLossPct,
        stopLossPrice: trackedSignalsTable.stopLossPrice,
      })
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.signalId, row.id))
      .limit(1);
    const policy = resolvePrimarySignalPolicyContext(linkedTrackers[0]);
    if (!policy) {
      req.log.warn(
        { signalId, symbol: row.symbol },
        "Manual resend skipped: authoritative tracked position is missing",
      );
      res.status(409).json({
        error: "signal has no authoritative tracked position; resend skipped",
      });
      return;
    }

    const bingxUrl = `https://bingx.com/en-us/perpetual/${row.symbol}/`;
    const alphaResult: AlphaResult = {
      symbol: row.symbol,
      grade: row.type === "super_alpha" ? "super_alpha" : "alpha",
      price: row.price,
      priceChange30m: row.priceChangePercent,
      currentVolume: row.volume24h,
      avgVolume: row.avgVolume,
      volumeMultiplier: row.value,
      oiChangePercent: row.oiChangePercent ?? 0,
      openInterest: row.openInterest,
      cmcRank: row.cmcRank,
      cmcSource: row.cmcSource,
      cmcAvailable: false,
      liquidationsUsd: row.liquidationsUsd,
      liquidationsMultiple: row.liquidationsMultiple,
      coinglassAvailable: false,
      sentiment: row.sentiment ?? "",
      sentimentKey: row.sentimentKey ?? "",
      traderAction: "LONG (кит — спот, розница — фьючи, стоп -5%)",
      alphaScore: row.alphaScore ?? 7,
      isContinuing: row.isContinuing ?? false,
      cumulativeOiChange: row.cumulativeOiChange ?? 0,
      tradingViewUrl: row.tradingViewUrl,
      bingxUrl,
      fundingRate: row.fundingRate,
      signalId: row.id,
    };

    await broadcastBatchAlert([alphaResult], {
      eventKey: `signal-resend:${row.id}:${Date.now()}`,
      policy,
    });
    req.log.info(
      { signalId, symbol: row.symbol },
      "Manual resend-signal broadcast complete",
    );
    res.json({ ok: true, symbol: row.symbol, sentimentKey: row.sentimentKey });
  } catch (err) {
    req.log.error({ err, signalId }, "resend-signal failed");
    res.status(500).json({ error: "resend-signal failed" });
  }
});

// Ручная отправка отчётов (для восстановления пропущенных)
router.post("/reports/send-daily", requireAdminToken, async (req, res) => {
  try {
    await sendDailyReport();
    res.json({ success: true, message: "Daily report sent" });
  } catch (err) {
    req.log.error({ err }, "Failed to send daily report");
    res
      .status(500)
      .json({ success: false, message: "Failed to send daily report" });
  }
});

router.post("/reports/send-weekly", requireAdminToken, async (req, res) => {
  try {
    // bypassDedupe=true: manual trigger should always work regardless of schedule
    await sendWeeklyDigest(undefined, true);
    res.json({ success: true, message: "Weekly digest sent" });
  } catch (err) {
    req.log.error({ err }, "Failed to send weekly digest");
    res
      .status(500)
      .json({ success: false, message: "Failed to send weekly digest" });
  }
});

router.post("/scanner/audit", requireAdminToken, async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Audit started — отчёт придёт в канал через ~1-2 мин",
    });
    // Запускаем после ответа клиенту (не блокируем HTTP)
    runAuditReport().catch((err: unknown) => {
      req.log.error({ err }, "Audit report failed");
    });
  } catch (err) {
    req.log.error({ err }, "Failed to trigger audit");
    res
      .status(500)
      .json({ success: false, message: "Failed to trigger audit" });
  }
});

// ── DEV: Ретроспективный анализ — исторические данные OI/CVD/Volume ──────────
// GET /api/scanner/debug/retro?symbol=SENT-USDT&fromSec=1749434400&toSec=1749456000
// Возвращает: Coinalyze OI history (30min) + BingX klines (30m) + CG OI snapshot + CG taker
router.get("/scanner/debug/retro", requireAdminToken, async (req, res) => {
  const symbol = String(req.query.symbol ?? "SENT-USDT");
  const fromSec = Number(
    req.query.fromSec ?? Math.floor(Date.now() / 1000) - 7200,
  );
  const toSec = Number(req.query.toSec ?? Math.floor(Date.now() / 1000));
  const interval = String(req.query.interval ?? "30min");

  const CA_KEY = process.env.COINALYZE_API_KEY ?? "";
  const CG_KEY = process.env.CoinGlassAPI ?? "";
  const base = symbol.replace("-USDT", "");

  // 1. Coinalyze OI history (30min candles, from/to in unix seconds)
  let oiHistory: { t: string; tSec: number; oi: number; oiChange: number }[] =
    [];
  try {
    const cgSym = `${base}USDT_PERP.A`;
    const url = new URL("https://api.coinalyze.net/v1/open-interest-history");
    url.searchParams.set("symbols", cgSym);
    url.searchParams.set("interval", interval);
    url.searchParams.set("from", String(fromSec));
    url.searchParams.set("to", String(toSec));
    url.searchParams.set("api_key", CA_KEY);
    const r = await fetch(url.toString(), {
      signal: AbortSignal.timeout(12000),
    });
    const j = (await r.json()) as {
      symbol: string;
      history: { t: number; o: number; h: number; l: number; c: number }[];
    }[];
    const rows = j?.[0]?.history ?? [];
    oiHistory = rows.map((c, i) => {
      const prev = i > 0 ? rows[i - 1].c : c.o;
      const changePct = prev > 0 ? ((c.c - prev) / prev) * 100 : 0;
      return {
        t: new Date(c.t * 1000).toUTCString().slice(5, 22),
        tSec: c.t,
        oi: Math.round(c.c),
        oiChange: parseFloat(changePct.toFixed(3)),
      };
    });
  } catch (err) {
    req.log.warn({ err }, "retro: Coinalyze failed");
  }

  // 2. CoinGlass Taker flow — исторические свечи 15m по Binance+Bybit+OKX+Bitget
  // startTime/endTime в миллисекундах — получаем реальные исторические данные
  const cgTaker: {
    exch: string;
    candles: {
      t: string;
      tMs: number;
      buy: number;
      sell: number;
      net: number;
      netPct: number;
    }[];
  }[] = [];
  const takerExchanges = ["Binance", "Bybit", "OKX", "Bitget"] as const;
  const takerSymMap: Record<string, string> = {
    Binance: `${base}USDT`,
    Bybit: `${base}USDT`,
    OKX: `${base}-USDT-SWAP`,
    Bitget: `${base}USDT_UMCBL`,
  };
  // limit=64 → до 16 часов @ 15m
  const takerLimit = Math.min(64, Math.ceil((toSec - fromSec) / 900) + 4);
  await Promise.all(
    takerExchanges.map(async (exch) => {
      try {
        const url = new URL(
          "https://open-api-v4.coinglass.com/api/futures/taker-buy-sell-volume/history",
        );
        url.searchParams.set("symbol", takerSymMap[exch]);
        url.searchParams.set("exchange", exch);
        url.searchParams.set("interval", "15m");
        url.searchParams.set("limit", String(takerLimit));
        url.searchParams.set("startTime", String(fromSec * 1000));
        url.searchParams.set("endTime", String(toSec * 1000));
        const r = await cgTimedFetch(
          url.toString(),
          {
            headers: { "CG-API-KEY": CG_KEY },
            signal: AbortSignal.timeout(8000),
          },
          {
            priority: "low",
            endpoint: "futures/taker-buy-sell-volume/history",
          },
        );
        const j = (await r.json()) as {
          code: string;
          data?: {
            time: number;
            taker_buy_volume_usd: string;
            taker_sell_volume_usd: string;
          }[];
        };
        if (j.code === "0" && j.data?.length) {
          const candles = j.data
            .filter((c) => c.time >= fromSec * 1000 && c.time <= toSec * 1000)
            .map((c) => {
              const buy = parseFloat(c.taker_buy_volume_usd);
              const sell = parseFloat(c.taker_sell_volume_usd);
              const net = buy - sell;
              const tot = buy + sell;
              return {
                t: new Date(c.time).toUTCString().slice(5, 22),
                tMs: c.time,
                buy: Math.round(buy / 1000),
                sell: Math.round(sell / 1000),
                net: Math.round(net / 1000),
                netPct:
                  tot > 0 ? parseFloat(((net / tot) * 100).toFixed(1)) : 0,
              };
            });
          if (candles.length) cgTaker.push({ exch, candles });
        }
      } catch {
        /* non-critical */
      }
    }),
  );

  // 4. BingX klines (30m)
  let bxKlines: {
    t: string;
    tMs: number;
    o: number;
    h: number;
    l: number;
    c: number;
    vol: number;
    priceChg: number;
  }[] = [];
  try {
    const startMs = fromSec * 1000;
    const endMs = toSec * 1000;
    const url = `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=30m&startTime=${startMs}&endTime=${endMs}&limit=100`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const j = (await r.json()) as {
      data?: {
        time: number;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
      }[];
    };
    bxKlines = (await withAggregatedKlineVolume(symbol, "30m", j?.data ?? []))
      .sort((a, b) => a.time - b.time)
      .map((k) => ({
        t: new Date(k.time).toUTCString().slice(5, 22),
        tMs: k.time,
        o: parseFloat(k.open),
        h: parseFloat(k.high),
        l: parseFloat(k.low),
        c: parseFloat(k.close),
        vol: parseFloat(k.volume),
        priceChg: parseFloat(
          (
            ((parseFloat(k.close) - parseFloat(k.open)) / parseFloat(k.open)) *
            100
          ).toFixed(2),
        ),
      }));
  } catch (err) {
    req.log.warn({ err }, "retro: BingX klines failed");
  }

  res.json({ symbol, fromSec, toSec, oiHistory, cgTaker, bxKlines });
});

router.get(
  "/scanner/debug-cg-spot-vol",
  requireAdminToken,
  async (req, res) => {
    const symbol = (req.query.symbol as string) || "SAHARA";
    const key = process.env.CoinGlassAPI!;
    const results: Record<string, any> = {};

    const endpoints = [
      `/api/spot/volume/history?symbol=${symbol}USDT&exchange=Binance&interval=1h&limit=6`,
      `/api/spot/volume/history?symbol=${symbol}USDT&interval=1h&limit=6`,
      `/api/spot/volume/history?symbol=${symbol}&interval=1h&limit=6`,
      `/api/spot/pairs-markets?symbol=${symbol}USDT`,
      `/api/spot/pairs-markets?symbol=${symbol}`,
      `/api/spot/coins-markets?symbol=${symbol}`,
      `/api/spot/aggregated-taker-buy-sell-volume/history?symbol=${symbol}&exchange_list=Binance,Bybit&interval=1h&limit=6`,
    ];

    for (const path of endpoints) {
      try {
        const r = await cgTimedFetch(
          `https://open-api-v4.coinglass.com${path}`,
          {
            headers: { "CG-API-KEY": key },
            signal: AbortSignal.timeout(5000),
          },
          {
            priority: "low",
            endpoint: path.split("?")[0]!.replace(/^\/api\//, ""),
          },
        );
        const body = await r.json();
        results[path] = { status: r.status, data: body };
      } catch (e: any) {
        results[path] = { error: e.message };
      }
    }

    res.json(results);
  },
);

// GET /api/scanner/layer-stats
router.get("/scanner/layer-stats", requireDashboardOwner, async (_req, res) => {
  const cacheKey = "scanner:layer-stats";
  const hit = getCached<object>(cacheKey);
  if (hit) {
    res.json(hit);
    return;
  }

  const candidates = getLastCycleCandidates();
  const stats: Record<string, number> = {};
  for (const c of candidates) {
    for (const l of c.layers) {
      stats[l] = (stats[l] ?? 0) + 1;
    }
  }

  let l4ReadyTokens = 0;
  try {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(prescanTrackerTable)
      .where(
        and(
          gte(prescanTrackerTable.spotVolCycles, 2),
          isNotNull(prescanTrackerTable.spotVolAvg1h),
        ),
      );
    l4ReadyTokens = Number(result[0]?.count ?? 0);
  } catch {
    /* non-critical */
  }

  const result = {
    cycleAt: getLastCycleAt(),
    cycleNumber: lastLayerDebug.cycleNumber,
    totalBatch: candidates.length,
    byLayer: stats,
    l4ReadyTokens,
    debug: lastLayerDebug,
  };
  setCached(cacheKey, result, 30_000);
  res.json(result);
});

// GET /api/scanner/range-breakout-candidates — live Auto Range 1H breakout
// candidates (armed / qualified, not expired). Visible to all active users;
// reject diagnostics stay owner-only.
router.get(
  "/scanner/range-breakout-candidates",
  requireAuthenticatedDashboardAccess,
  async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT s.id, s.symbol, s.level_source, s.status, s.breakout_level,
               s.armed_at, s.expires_at, s.first_cross_at, s.decision_at,
               s.decision_json->>'reason' AS decision_reason,
               s.decision_json#>>'{confirmation,triggerCandle,close}' AS detection_price,
               (SELECT r.reason FROM scan_reject_log r
                 WHERE r.symbol = s.symbol AND r.pattern = 'stealth_breakout'
                   AND r.cycle_at >= s.armed_at
                 ORDER BY r.cycle_at DESC LIMIT 1) AS last_reject,
               (SELECT r.cycle_at FROM scan_reject_log r
                 WHERE r.symbol = s.symbol AND r.pattern = 'stealth_breakout'
                   AND r.cycle_at >= s.armed_at
                 ORDER BY r.cycle_at DESC LIMIT 1) AS last_reject_at
          FROM stealth_breakout_armed_setups s
         WHERE s.level_source = 'auto_range_1h'
           AND s.status IN ('armed', 'qualified')
           AND s.expires_at > now()
           AND s.symbol !~ '^NC(SK|CO|SI)'
           AND s.symbol NOT LIKE '%-USDC'
           AND COALESCE(s.arm_venue, 'bingx') IN ('bingx', 'default', 'secondary')
           AND split_part(s.symbol, '-', 1) NOT LIKE '%USD%'
           AND s.symbol NOT IN (${sql.join(
             [...ANALYSIS_BLOCKED_SYMBOLS, ""].map((s) => sql`${s}`),
             sql`, `,
           )})
         ORDER BY s.status DESC, s.updated_at DESC
      `);
      // One row per symbol: qualified first, then the most recently evaluated
      // arm (rows arrive in that order). Stale duplicate arms are hidden.
      const seenSymbols = new Set<string>();
      // A confirmed breakout stays listed after its retry window closes, until
      // price is back inside the range (cached price at or below the level).
      const uniqueRows = (result.rows as Array<Record<string, unknown>>).filter(
        (r) => {
          if (r.status === "invalidated") {
            const px = getCachedPrice(String(r.symbol));
            if (px === null || !(px > Number(r.breakout_level))) return false;
          }
          const key = String(r.symbol);
          if (seenSymbols.has(key)) return false;
          seenSymbols.add(key);
          return true;
        },
      );
      // The scanner price cache only holds symbols in the current scan batch,
      // so most Range rows had no current price. Fall back to one shared
      // BingX ticker snapshot (30s cache), fail-soft to "—".
      let tickerPrices = getCached<Map<string, number>>("range:ticker-prices");
      if (
        !tickerPrices &&
        uniqueRows.some((r) => getCachedPrice(String(r.symbol)) === null)
      ) {
        try {
          const tickers = await getFutureTickers();
          tickerPrices = new Map<string, number>();
          for (const t of tickers) {
            const px = parseFloat(t.lastPrice);
            if (Number.isFinite(px) && px > 0) tickerPrices.set(t.symbol, px);
          }
          setCached("range:ticker-prices", tickerPrices, 30_000);
        } catch (err) {
          logger.warn({ err }, "range-breakout-candidates ticker fallback");
        }
      }
      res.json({
        candidates: uniqueRows.map((r) => {
          const detRaw =
            r.detection_price == null ? NaN : Number(r.detection_price);
          const detectionPrice =
            Number.isFinite(detRaw) && detRaw > 0 ? detRaw : null;
          const cur =
            getCachedPrice(String(r.symbol)) ??
            tickerPrices?.get(String(r.symbol)) ??
            null;
          const currentPrice = cur !== null && cur > 0 ? cur : null;
          return {
            detectionPrice,
            currentPrice,
            changePct:
              detectionPrice !== null && currentPrice !== null
                ? ((currentPrice - detectionPrice) / detectionPrice) * 100
                : null,
            id: r.id,
            symbol: r.symbol,
            timeframe: r.level_source === "auto_range_4h" ? "4h" : "1h",
            status: r.status === "invalidated" ? "broken_out" : r.status,
            level: r.breakout_level,
            armedAt: r.armed_at,
            expiresAt: r.expires_at,
            firstCrossAt: r.first_cross_at,
            decisionReason: r.decision_reason,
            lastReject:
              res.locals.dashboardIsOwner === true ? r.last_reject : null,
            lastRejectAt:
              res.locals.dashboardIsOwner === true ? r.last_reject_at : null,
          };
        }),
      });
    } catch (err) {
      logger.error({ err }, "range-breakout-candidates failed");
      res.status(500).json({ error: "range_breakout_candidates_failed" });
    }
  },
);

// GET /api/scanner/abneon-candidates — stored armed / qualified / firing
// Neon Support (ABNeon support bounce) setups, read from the same table the
// live logic uses. No market fetches beyond the shared price cache/ticker
// snapshot. Reject diagnostics stay owner-only.
router.get(
  "/scanner/abneon-candidates",
  requireAuthenticatedDashboardAccess,
  async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT DISTINCT ON (s.symbol)
               s.id, s.symbol, s.status, s.frozen_level, s.armed_at,
               s.trigger_candle_at,
               s.terminal_reason AS last_reject,
               CASE WHEN s.terminal_reason IS NULL THEN NULL
                    ELSE s.updated_at END AS last_reject_at
          FROM stealth_abneon_shadow_candidates s
         WHERE s.detection_method = 'abneon_support_bounce'
           AND s.status IN ('armed', 'qualified', 'firing')
           AND s.symbol !~ '^NC(SK|CO|SI)'
           AND s.symbol NOT LIKE '%-USDC'
           AND split_part(s.symbol, '-', 1) NOT LIKE '%USD%'
           AND s.symbol NOT IN (${sql.join(
             [...ANALYSIS_BLOCKED_SYMBOLS, ""].map((b) => sql`${b}`),
             sql`, `,
           )})
         ORDER BY s.symbol, s.updated_at DESC, s.id DESC
      `);
      const rows = result.rows as Array<Record<string, unknown>>;
      let tickerPrices = getCached<Map<string, number>>("range:ticker-prices");
      if (
        !tickerPrices &&
        rows.some((r) => getCachedPrice(String(r.symbol)) === null)
      ) {
        try {
          const tickers = await getFutureTickers();
          tickerPrices = new Map<string, number>();
          for (const t of tickers) {
            const px = parseFloat(t.lastPrice);
            if (Number.isFinite(px) && px > 0) tickerPrices.set(t.symbol, px);
          }
          setCached("range:ticker-prices", tickerPrices, 30_000);
        } catch (err) {
          logger.warn({ err }, "abneon-candidates ticker fallback");
        }
      }
      const isOwner = res.locals.dashboardIsOwner === true;
      const order = { qualified: 0, firing: 1, armed: 2 } as Record<
        string,
        number
      >;
      const candidates = rows
        .map((r) => {
          const level = Number(r.frozen_level);
          const cur =
            getCachedPrice(String(r.symbol)) ??
            tickerPrices?.get(String(r.symbol)) ??
            null;
          const currentPrice = cur !== null && cur > 0 ? cur : null;
          return {
            id: Number(r.id),
            symbol: r.symbol,
            status: r.status,
            level,
            currentPrice,
            distancePct:
              currentPrice !== null && level > 0
                ? ((currentPrice - level) / level) * 100
                : null,
            armedAt: r.armed_at,
            lastReject: isOwner ? r.last_reject : null,
            lastRejectAt: isOwner ? r.last_reject_at : null,
          };
        })
        .sort(
          (a, b) =>
            (order[String(a.status)] ?? 3) - (order[String(b.status)] ?? 3) ||
            Date.parse(String(b.armedAt)) - Date.parse(String(a.armedAt)),
        );
      res.json({ candidates });
    } catch (err) {
      logger.error({ err }, "abneon-candidates failed");
      res.status(500).json({ error: "abneon_candidates_failed" });
    }
  },
);

// GET /api/scanner/pattern-debug
router.get("/scanner/pattern-debug", requireDashboardOwner, (_req, res) => {
  res.json(lastPatternDebug);
});

// Паттерны удалённые из кода — не показываем в PDB-истории (из dead-patterns.ts)
const DELETED_PATTERN_KEYS = new Set(PDB_HIDDEN_PATTERN_KEYS);

// GET /api/scanner/pattern-debug/history — weekly aggregation from pattern_debug_log
// (accumulated across cycles, unlike /scanner/pattern-debug which is the current-cycle snapshot)
router.get(
  "/scanner/pattern-debug/history",
  requireDashboardOwner,
  async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 30);
    try {
      const since = new Date(Date.now() - days * 24 * 3600_000);
      const raw = await db
        .select()
        .from(patternDebugLogTable)
        .where(gte(patternDebugLogTable.loggedAt, since));
      const byPattern = new Map<
        string,
        { checked: number; passed: number; rejectedAt: Record<string, number> }
      >();
      for (const row of raw) {
        if (DELETED_PATTERN_KEYS.has(row.pattern)) continue;
        const e = byPattern.get(row.pattern) ?? {
          checked: 0,
          passed: 0,
          rejectedAt: {},
        };
        e.checked += row.checked;
        e.passed += row.passed;
        if (row.rejectedAt) {
          try {
            const parsed = JSON.parse(row.rejectedAt) as Record<string, number>;
            for (const [gate, count] of Object.entries(parsed)) {
              e.rejectedAt[gate] = (e.rejectedAt[gate] ?? 0) + count;
            }
          } catch {
            /* skip malformed row */
          }
        }
        byPattern.set(row.pattern, e);
      }
      res.json({
        days,
        since: since.toISOString(),
        byPattern: Object.fromEntries(byPattern),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// GET /api/scanner/prescan-stats
router.get(
  "/scanner/prescan-stats",
  requireDashboardOwner,
  async (_req, res) => {
    try {
      const result = await db.execute(sql`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN spot_vol_cycles >= 2 THEN 1 END) as vol_cycles_ge2,
        COUNT(CASE WHEN spot_vol_avg_1h IS NOT NULL THEN 1 END) as avg_not_null,
        COUNT(CASE WHEN spot_vol_cycles >= 2 AND spot_vol_avg_1h IS NOT NULL THEN 1 END) as ready_for_spot,
        MAX(spot_vol_cycles) as max_cycles,
        ROUND(AVG(spot_vol_cycles)::numeric, 2) as avg_cycles
      FROM prescan_tracker
    `);
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

// GET /api/scanner/inflow-outflow — Layer 14: Exchange Inflow/Outflow pool
// Возвращает активные watching-записи из inflow_outflow_l14_pool с вычисленным cycleCount.
router.get(
  "/scanner/inflow-outflow",
  requireDashboardOwner,
  async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(inflowOutflowL14PoolTable)
        .where(eq(inflowOutflowL14PoolTable.status, "watching"))
        .orderBy(desc(inflowOutflowL14PoolTable.detectedAt));

      const now = Date.now();
      const JOB_INTERVAL_MS = 30 * 60 * 1000;
      const day24 = 24 * 60 * 60 * 1000;

      res.json({
        pool: rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          coinSymbol: r.coinSymbol,
          status: r.status,
          detectedAt: r.detectedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
          entryPrice: r.entryPrice ?? null,
          txCount: r.txCount ?? null,
          totalOutflowUsd: r.totalOutflowUsd ?? null,
          exchangeName: r.exchangeName ?? null,
          transferType: r.transferType ?? null,
          cycleCount: Math.max(
            1,
            Math.floor((now - r.detectedAt.getTime()) / JOB_INTERVAL_MS) + 1,
          ),
        })),
        transparency: [],
        stats: {
          activeWatching: rows.length,
          detected24h: rows.filter((r) => now - r.detectedAt.getTime() < day24)
            .length,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);
// GET /api/admin/reject-log?days=7&patterns=BA,TA,BG
// Топ-причины отказов scan_reject_log за период, сгруппированные по (pattern, reason).
// Использует индекс (pattern, cycle_at DESC) — ответ < 200ms.
router.get("/admin/reject-log", requireAdminToken, async (req, res) => {
  try {
    const rawDays = Number(req.query.days ?? 7);
    const days = Number.isFinite(rawDays)
      ? Math.min(Math.max(Math.floor(rawDays), 1), 30)
      : 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const patternsParam =
      typeof req.query.patterns === "string" ? req.query.patterns.trim() : "";
    const patterns = patternsParam
      ? patternsParam
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : [];

    const rows = await db
      .select({
        pattern: scanRejectLogTable.pattern,
        reason: scanRejectLogTable.reason,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(scanRejectLogTable)
      .where(
        patterns.length > 0
          ? and(
              gte(scanRejectLogTable.cycleAt, cutoff),
              inArray(scanRejectLogTable.pattern, patterns),
            )
          : gte(scanRejectLogTable.cycleAt, cutoff),
      )
      .groupBy(scanRejectLogTable.pattern, scanRejectLogTable.reason)
      .orderBy(desc(sql`count(*)`));

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "GET /admin/reject-log failed");
    res.status(500).json({ error: String(err) });
  }
});

// ── Cancel Outcomes ───────────────────────────────────────────────────────────
// Цена монеты через +4ч / +8ч / +24ч после отмены сигнала (stale / smart / no_price).
// Owner-only: содержит PnL, цены входа и причины отмены торговых сигналов.
router.get("/scanner/cancel-outcomes", requireAdminToken, async (req, res) => {
  try {
    const result = await db.execute(sql`
      SELECT
        id, signal_id, symbol, sentiment_key, cancel_reason,
        pnl_at_cancel, price_at_cancel, entry_price,
        sent_at, observed_4h_at, observed_8h_at, observed_24h_at,
        price_4h_pct, price_8h_pct, price_24h_pct
        FROM signal_cancel_outcomes
        WHERE sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
      ORDER BY sent_at DESC
      LIMIT 500
    `);
    res.json({ outcomes: result.rows });
  } catch (err) {
    req.log.error({ err }, "cancel-outcomes: DB error");
    res.status(500).json({ error: "DB error" });
  }
});

// ── Cancel Outcomes Aggregate ─────────────────────────────────────────────────
// Группировка по (cancel_reason, sentiment_key) за последние 30 дней.
// Возвращает: total_cancels, observed_24h, false_cancels, false_cancel_rate, avg_pnl_at_cancel, avg_price_24h_pct.
// false_cancel = price_24h_pct > 5% (сигнал рос после отмены — потенциальная ошибка).
router.get(
  "/scanner/cancel-outcomes/aggregate",
  requireAdminToken,
  async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          cancel_reason,
          sentiment_key,
          COUNT(*)::int                                                        AS total_cancels,
          COUNT(price_24h_pct)::int                                            AS observed_24h,
          COUNT(*) FILTER (WHERE price_24h_pct > 5)::int                       AS false_cancels,
          (ROUND(
            100.0 * COUNT(*) FILTER (WHERE price_24h_pct > 5)::numeric
            / NULLIF(COUNT(price_24h_pct), 0),
            1
          ))::float8                                                           AS false_cancel_rate,
          ROUND(AVG(pnl_at_cancel)::numeric, 2)::float8                       AS avg_pnl_at_cancel,
          ROUND(AVG(price_24h_pct)::numeric, 2)::float8                       AS avg_price_24h_pct
        FROM signal_cancel_outcomes
        WHERE sent_at >= NOW() - INTERVAL '30 days'
          AND sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
        GROUP BY cancel_reason, sentiment_key
        ORDER BY false_cancel_rate DESC NULLS LAST, total_cancels DESC
      `);
      res.json({ rows: result.rows });
    } catch (err) {
      req.log.error({ err }, "cancel-outcomes/aggregate: DB error");
      res.status(500).json({ error: "DB error" });
    }
  },
);

// ── Cancel Outcomes — Weekly Snapshots ────────────────────────────────────────
// Последние 4 недели агрегатов: false_cancel_rate по cancel_reason.
// Используется для 4-week sparkline тренда на Cancel Outcomes странице.
router.get(
  "/scanner/cancel-outcomes/weekly-snapshots",
  requireAdminToken,
  async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT
          snapshot_week, cancel_reason, total, observed,
          false_cancels, false_cancel_rate, avg_pnl, avg_p24h, created_at
        FROM cancel_outcome_weekly_snapshots
        WHERE snapshot_week >= CURRENT_DATE - INTERVAL '28 days'
        ORDER BY snapshot_week ASC, cancel_reason ASC
      `);
      res.json({ snapshots: result.rows });
    } catch (err) {
      req.log.error({ err }, "cancel-outcomes/weekly-snapshots: DB error");
      res.status(500).json({ error: "DB error" });
    }
  },
);

// ── Health Events ─────────────────────────────────────────────────────────────
// СЛЕДИ / ДЕРЖИ / РАССМОТРИ ВЫХОД — исходы через +4ч / +8ч / +24ч после отправки.
// Owner-only: содержит PnL, OI, CVD и entry-данные активных сигналов.
// accuracy — агрегат по message_type на первой отправке для каждого сигнала:
// n/signal_count, event_count, observed (с price_4h_pct), correct, accuracy_pct.
// Цель: ДЕРЖИ ≥ 55% correct (цена выросла), ВЫХОД ≥ 55% correct (цена упала).
router.get("/scanner/health-events", requireAdminToken, async (req, res) => {
  try {
    const [eventsResult, accuracyResult] = await Promise.all([
      db.execute(sql`
        SELECT
          id, signal_id, symbol, sentiment_key, message_type,
          pnl_at_send, oi_30m, turnover,
          cvd_15m, cvd_30m, cvd_1h,
          price_at_send, entry_price,
          sent_at, observed_4h_at, observed_8h_at, observed_24h_at,
          price_4h_pct, price_8h_pct, price_24h_pct
        FROM signal_health_events
        WHERE sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
          AND delivery_status <> 'shadow_price_v1'
        ORDER BY sent_at DESC
        LIMIT 500
      `),
      db.execute(sql`
        WITH active_events AS (
          SELECT *
          FROM signal_health_events
          WHERE sentiment_key IN (${ACTIVE_PATTERN_KEYS_SQL})
            AND delivery_status <> 'shadow_price_v1'
        ),
        first_by_signal_type AS (
          SELECT DISTINCT ON (signal_id, message_type)
            signal_id,
            message_type,
            sent_at,
            price_4h_pct,
            price_8h_pct,
            price_24h_pct
          FROM active_events
          ORDER BY signal_id, message_type, sent_at ASC, id ASC
        ),
        event_counts AS (
          SELECT message_type, COUNT(*)::int AS event_count
          FROM active_events
          GROUP BY message_type
        )
        SELECT
          f.message_type,
          COUNT(*)::int                                          AS n,
          COUNT(*)::int                                          AS signal_count,
          ec.event_count,
          COUNT(f.price_4h_pct)::int                             AS observed,
          COUNT(f.price_24h_pct)::int                            AS observed_24h,
          COUNT(*) FILTER (
            WHERE f.sent_at <= now() - interval '4 hours'
          )::int                                                 AS mature_4h,
          COUNT(*) FILTER (
            WHERE f.sent_at <= now() - interval '24 hours'
          )::int                                                 AS mature_24h,
          ROUND(AVG(f.price_4h_pct)::numeric, 1)::float8         AS avg_4h_pct,
          ROUND(AVG(f.price_8h_pct)::numeric, 1)::float8         AS avg_8h_pct,
          ROUND(AVG(f.price_24h_pct)::numeric, 1)::float8        AS avg_24h_pct,
          -- correct и accuracy_pct определены только для hold и exit.
          -- follow не имеет критерия правильности → NULL.
          CASE WHEN f.message_type IN ('hold', 'exit')
            THEN SUM(CASE
                       WHEN f.message_type = 'exit' AND f.price_4h_pct < 0 THEN 1
                       WHEN f.message_type = 'hold' AND f.price_4h_pct > 0 THEN 1
                       ELSE 0
                     END)::int
            ELSE NULL
          END                                                   AS correct,
          CASE WHEN f.message_type IN ('hold', 'exit')
            THEN ROUND(
              100.0 *
              SUM(CASE
                    WHEN f.message_type = 'exit' AND f.price_4h_pct < 0 THEN 1
                    WHEN f.message_type = 'hold' AND f.price_4h_pct > 0 THEN 1
                    ELSE 0
                  END)
              / NULLIF(COUNT(f.price_4h_pct), 0),
              1
            )::float8
            ELSE NULL
          END                                                   AS accuracy_pct,
          CASE
            WHEN f.message_type = 'follow' THEN NULL
            WHEN COUNT(f.price_4h_pct) < 20 THEN 'insufficient_data'
            ELSE 'preliminary'
          END                                                   AS sample_status
        FROM first_by_signal_type f
        JOIN event_counts ec USING (message_type)
        GROUP BY f.message_type, ec.event_count
        ORDER BY f.message_type
      `),
    ]);
    res.json({ events: eventsResult.rows, accuracy: accuracyResult.rows });
  } catch (err) {
    req.log.error({ err }, "health-events: DB error");
    res.status(500).json({ error: "DB error" });
  }
});

export default router;
