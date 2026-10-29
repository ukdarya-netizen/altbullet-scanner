import {
  getStealthOi4hAtBreakout,
  stealthOi4hPasses,
  stealth1hVolumeRatioPasses,
} from "./stealth-oi-breakout-filter.js";
import { calcStealthScore } from "./stealth-score.js";
import { registerProcessHealthSource } from "./process-health.js";
import {
  STEALTH_FIRE_WINDOW_MS,
  evaluateBreakoutQuality,
  recordStealthCutoff,
  recordStealthVerdict,
} from "./stealth-verdict-journal.js";
import { getKlinesWithDeepHistory } from "./auto-range-deep-history.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  reportAggregatedOiCoverage,
  reportUnlockListAvailability,
} from "./apiHealth.js";
import { logger } from "./logger.js";
import { saveDailyOiSnapshots } from "./whaleTracker.js";
import {
  getFutureTickers,
  getFutureTicker,
  getKlines,
  getOrderBookAnalysis,
  getAllFundingRates,
  testConnection as testBingX,
  type BingXTicker,
  type BingXKline,
} from "./bingx.js";
import { getCgAskBids } from "./coinglass_orderbook.js";
import {
  broadcastBatchAlert,
  broadcastRawAlert,
  testConnection as testTelegram,
} from "./telegram.js";
import {
  trackSignal,
  takeTrackSignalError,
  discardUntrackedSignal,
  cancelUndeliveredTrackedSignal,
  consumeObAtFire,
  reconcileDeliveredSignalsMissingTracker,
} from "./watcher.js";
import { getTrendingRank } from "./trending.js";
import { bingxKlineCodec, packedToClosedCandles } from "./auto-range-packed.js";
import { getLiquidations } from "./liquidations.js";
import {
  batchGetCoinglassOI,
  clearCoinglassOICache,
  getCoinglassOI,
  CoinglassOutageError,
  getCgSupportedCoinsSet,
  refreshCgSupportedCoins,
  drainCgOiBreakerTrips,
  drainCgOiSourceCounts,
  CG_SYMBOL_ALIAS,
  type CoinglassOIResult,
} from "./coinglass_oi.js";
import { isBingxExclusive, isBinanceSpotListed } from "./coinglass_listings.js";
import {
  aggregatedVolume24hUsd,
  drainCoinsMarketsLoadStats,
  loadCycleCoinsMarketsSnapshot,
  refreshAggregatedVolume24h,
} from "./coinglass_vol24h.js";
import {
  prefetchNetflowBatch,
  getNetflowBatchEntry,
  getAggregatedFuturesTakerNetBuyPct15m,
  getAggFuturesTakerHistory,
  getAggregatedFuturesVolume30m,
  getAggFuturesVolumeByInterval,
  getAggregatedFuturesVolumeSeries30m,
  resetNetflowTelemetry,
  getNetflowTelemetry,
} from "./coinglass_taker.js";
import {
  coinglassGovernorCollectionSizes,
  drainCoinglassGovernorTimings,
} from "./coinglass_governor.js";
import { recordCoinglassCycleMetrics } from "./coinglass-cycle-metrics.js";
import {
  drainLoopTiming,
  markLoopSegment,
  resetLoopTiming,
  runLoopSymbol,
} from "./loop-timing.js";
import { flushCgTrace, setTracedArmSymbols } from "./coinglass-arm-trace.js";
import {
  loadAutoRangeHistory,
  needsResave,
  saveAutoRangeHistory,
} from "./auto-range-history-store.js";
import { snapshotCgTelemetry, type CgTelemetrySnapshot } from "./cg_latency.js";
import { getSpotCvdMtf, getSpotCvdAndVolume } from "./coinglass_spot_cvd.js";
import { evaluateNeonFlowGate, reactionTakerNetUsd } from "./neon-flow-gate.js";
import { fetchMarketCap } from "./whale_watch_v2.js";
import {
  getSpotPoolEntry,
  MIN_SPOT_VOL_MCAP_FRACTION,
  triggerRefresh,
} from "./spotPool.js";
import { getSpotTakerFlow } from "./coinglass_spot_taker.js";
import {
  fetchLiqCoinList,
  fetchLiqOrders,
  getCachedLiqDataEx,
} from "./coinglass_liquidation.js";
import { getSpotVolume } from "./coinglass_spot_volume.js";
import { getFsVolume } from "./coinglass_fs_volume.js";
import { getUpcomingUnlocks } from "./coinglass_unlock.js";
import { getTokenWhaleIndex } from "./whale_index.js";
import { getCoinglassCurrentFunding } from "./coinglass_funding.js";
import { getSpotNetflowEntry } from "./spot-netflow-cache.js";
import { formatMarketLinks } from "./telegram-chart-link.js";
import {
  capturePlmEntryPrice3hSnapshot,
  capturePlmFutTakerShadowWithFallback,
  capturePlmOi30mShadowAtFire,
  PLM_OI30M_FIRE_FETCH_OPTIONS,
} from "./plm-decision-snapshot.js";
import {
  db,
  getDbPoolSnapshot,
  getSchedulerPoolSnapshot,
  signalsTable,
  settingsTable,
  oiBaselinesTable,
  oiWatchTable,
  trackedSignalsTable,
  prescanTrackerTable,
  prescanHistoryTable,
  patternDebugLogTable,
  marketCapCacheTable,
  scanRejectLogTable,
  prescanSnapshotsTable,
  type InsertSignal,
  type InsertPrescanSnapshot,
} from "@workspace/db";
import { dbWriteBestEffort, dbWriteStrict } from "./dbWriteFast.js";
import {
  recordPatternDecisionEventsBatch,
  scannerRejectedDecisionEventKey,
} from "./pattern-decision-history.js";
import { dbReadWithRetry } from "./dbReadWithRetry.js";
import { getMarketRequestBudgetSnapshot } from "./marketRequestBudget.js";
import { createScannerCycleAbort } from "./scannerCycleAbort.js";
import {
  AUTO_RANGE_HISTORY_CACHE_LIMIT,
  AUTO_RANGE_HISTORY_CONCURRENCY,
  AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE,
  resolveAutoRange1hReplayWindow,
  autoRangeHistoryFetchLimit,
  autoRangeHistoryCandleLimit,
  AUTO_RANGE_HISTORY_MIN_CLOSED_CANDLES,
  AUTO_RANGE_HISTORY_SUCCESSFUL_SHORT_RETRY_MS,
  AUTO_RANGE_HISTORY_TRANSIENT_RETRY_MS,
  AUTO_RANGE_HISTORY_WARMUP_BUDGET_MS,
  AutoRangeHistoryQueue,
  createAutoRangeHistoryScope,
  serializeAutoRangeHistoryError,
} from "./auto-range-history.js";
import { resolveScannerLiveness } from "./scanner-startup-recovery.js";
import {
  ScannerCycleSettlementFence,
  ScannerRecoveryScheduler,
  shouldRetainLeaseReleaseFailure,
} from "./scannerRecovery.js";
import {
  BA_REJECT_TELEMETRY_WINDOW_MS,
  type BullishAccumulationOiPath,
  classifyBullishAccumulationOiPath,
  getBullishAccumulationP24hTelemetrySource,
  isBullishAccumulationP24hAllowed,
} from "./bullish-accumulation-calibration.js";
import {
  assertMarketCycleLeaseOwnership,
  DISCOVERY_SCANNER_LEASE,
  getSchedulerLeaseStatus,
  SchedulerLeaseAcquireError,
  SchedulerLeaseLostError,
  SchedulerLeaseReleaseError,
  type MarketCycleLeaseContext,
  runOutsideMarketCycleLease,
  withSchedulerLease,
} from "./schedulerLease.js";
import { marketCycleLeaseContext } from "./marketCycleContext.js";
import { DurableTelemetryQueue } from "./telemetryQueue.js";
import {
  analyzeStealthStructure,
  analyzeStealthContinuationShelf,
  claimStealthTechnicalKlineFallback,
  confirmStealthOneHourBreakout,
  normalizeClosedBreakoutCandles,
  refineStealthBreakoutEntry,
  type BreakoutEvidence,
} from "./breakout-analysis.js";
import {
  autoRangeIdentityFromResult,
  calculateStealthAtr,
  isLiveStealthBreakoutSource,
  sameStealthAutoRangeInstance,
  type StealthBreakoutParticipationTelemetry,
} from "./stealth-breakout-armed.js";
import { isAnalysisBlockedSymbol } from "./excluded-signal-symbols.js";
import {} from "./stealth-wider-range-veto.js";
import { recheckFrozenOneHourRange } from "./stealth-range-recheck.js";
import { checkStealthLevelOnSrv2 } from "./stealth-srv2-level-check.js";
import {
  checkStealthCandleGate,
  applyStealthLiveVolumeRule,
  checkStealthVolumeGate,
  observeSignalCandleVolume,
  type CandleVolumeObservation,
} from "./stealth-volume-gate.js";
import {
  detectAutoRangePine,
  detectAutoRangePine1h,
  anchoredAutoRangeWindow,
  type AutoRangePineResult,
} from "./auto-range-pine.js";
import {
  buildAutoRangeLifecycleKey,
  selectAutoRangeVenueConfirmation,
} from "./auto-range-venue-confirmation.js";
import {
  AUTO_RANGE_EXTERNAL_VENUES,
  AUTO_RANGE_VENUE_HISTORY_CONCURRENCY,
  AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE,
  autoRangeVenueHistoryQueue,
  fetchAutoRangeVenueHistory,
} from "./auto-range-venue-history.js";
import type { LcObVenue } from "./lc-ob-wait.js";
import {
  claimStealthArmForFire,
  evaluateDurableStealthArm,
  listActiveAutoRange4hArms,
  listSecondaryOneHourArmSymbols,
  markStealthArmConsumed,
  recordStealthQualifiedBlocker,
  markStealthArmFired,
  persistStealthAutoRangeConfirmingVenues,
  sweepExpiredStealthArmClaims,
  closeStaleQualifiedStealthArms,
  STALE_FIRE_WINDOW_REASON,
  terminalizeDisabledAutoRangeArms,
  recordStealthDecisionMetrics,
} from "./stealth-breakout-armed-store.js";
import { scheduleAltBulletIndicatorSnapshot } from "./altbullet-indicator.js";
import { buildStealthAbneonArmSnapshotSafely } from "./stealth-abneon-arm-snapshot.js";
import {
  computeSupportZones,
  evaluateAbneonSupportBounce,
  resolveFrozenZone,
  evaluateOrderBlockSupportBounce,
  hasConsecutiveClosesBelow,
  NEON_SWEEP_RECLAIM_BARS,
} from "./stealth-abneon-detectors.js";
import {
  getFrozenStealthAbneonLevel,
  listQualifiedAbneonSupportBounces,
  persistStealthAbneonShadow,
  persistNeonEvaluationSnapshot,
  claimAbneonSupportBounceForFire,
  markAbneonSupportBounceConsumed,
  releaseAbneonSupportBounceClaim,
  renewAbneonSupportBounceClaim,
  routePersistedNeonSupportBounces,
  classifyAbneonFirePersistenceFailure,
  supportBounceQualificationTime,
  terminalizeAbneonSupportBounceClaim,
  terminalizeBrokenQualifiedNeonSupport,
  expireOfferedNeonSupportEvents,
} from "./stealth-abneon-shadow-store.js";
import {
  buildStealthScanWorklist,
  buildStealthScanPool,
  selectStealthRangeScanCandidates,
  shouldContinueAfterStealthEvaluation,
  evaluateRangeLifecycleOnce,
  shouldSkipForNegativeShortOiWithout24h,
  canDeliverQualifiedRangeArm,
} from "./stealth-scan-pool.js";
import {
  buildNeonUniverse,
  mergeQualifiedNeonEventsOldestFirst,
  runNeonUniverseOrchestration,
} from "./neon-universe-orchestration.js";
import { isPreservedDecommissionedPattern } from "./dead-patterns.js";
import {
  shouldBlockConfirmedFireForMissingSpotVolume,
  IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_30M,
  IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_4H,
  DARK_FLOW_MIN_VOLMULT,
  PREBREAKOUT_DARK_FLOW_MIN_VOLMULT,
  PREBREAKOUT_MIN_VOLMULT,
  BA_MIN_FUT_VOLMULT,
  QUIET_ACCUM_VOLMULT_MIN,
  QUIET_ACCUM_VOLMULT_MAX,
  QUIET_ACCUM_SPOT_TAKER_MIN,
  SPOT_TAKER_SELL_DOMINANCE,
  SPOT_TAKER_HEAVY_SELL,
} from "./scanner-patterns.js";
import { describeLcStateForScan } from "./liq-cascade-watcher.js";
import {
  prescanTelemetryOutboxStore,
  type PrescanTelemetryItem,
} from "./telemetryOutbox.js";
import { gte, gt, lt, sql, eq, ne, and, inArray, desc } from "drizzle-orm";
import {
  STEALTH_FRESH_HIGH_METHOD,
  lastClosedHourStart,
  scanFreshHighHour,
  type FreshHighEvent,
} from "./stealth-fresh-high.js";
import {
  STEALTH_RANGE_4H_METHOD,
  H4_MS as STEALTH_R4H_H4_MS,
  evaluateRange4hBreakout,
  lastClosed4hStart,
  type Range4hDecision,
} from "./stealth-range-4h.js";

// Owner 2026-10-28: Stealth fires only from the experimental fresh-24H-high
// detection (live, no shadow). The quiet-zone / Range arm detection no longer
// fires; its arms keep their bookkeeping and expire on their own.
// Owner 2026-10-29: ABNeon confirms only on the closed 1H candle (see the
// armed-zone block in the Neon evaluation).
const NEON_15M_CONFIRMATION_LIVE = false;
const STEALTH_LEGACY_DETECTION_LIVE = false as boolean;
// Owner 2026-10-29: the fresh 24H-high detection is off; Stealth fires on a
// closed 4H Range breakout with volume and buyers (stealth-range-4h.ts).
const STEALTH_FH_LIVE = false as boolean;
const STEALTH_R4H_LIVE = true as boolean;
type Range4hEvent = Range4hDecision & {
  symbol: string;
  detectedAt: number;
  takerNetUsd: number | null;
  spotCvd4h: boolean | null;
  quoteVolume24h: number | null;
};
const stealthRange4hQueue = new Map<string, Range4hEvent>();
let stealthRange4hLastCandle = 0;
let stealthRange4hRunning = false;
let stealthRange4hTimer: NodeJS.Timeout | null = null;

/**
 * Evaluates the last closed 4H candle of every BingX USDT perpetual once
 * (45 s after the close). Structure first (public 4H candles); aggregated
 * volume, takers and spot CVD are fetched only for structural breakouts.
 */
async function runStealthRange4h(now = Date.now()): Promise<void> {
  if (!STEALTH_R4H_LIVE || stealthRange4hRunning) return;
  const candleStart = lastClosed4hStart(now);
  const closeAt = candleStart + STEALTH_R4H_H4_MS;
  if (candleStart <= stealthRange4hLastCandle) return;
  if (now < closeAt + STEALTH_FH_SCAN_DELAY_MS) return;
  if (now > closeAt + STEALTH_FH_EVENT_TTL_MS) {
    stealthRange4hLastCandle = candleStart;
    return;
  }
  stealthRange4hRunning = true;
  const stats: Record<string, number> = { symbols: 0, errors: 0 };
  const passes: string[] = [];
  try {
    const tickers = await getFutureTickers();
    const symbols = tickers
      .filter((t) => t.symbol.endsWith("-USDT") && t.symbol !== "BTC-USDT")
      .map((t) => ({ symbol: t.symbol, qv: Number.parseFloat(t.quoteVolume) }));
    if (symbols.length === 0) throw new Error("no BingX tickers");
    stats.symbols = symbols.length;
    const count = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
    let next = 0;
    const worker = async () => {
      while (next < symbols.length) {
        const { symbol, qv } = symbols[next++]!;
        try {
          const rows = await getKlines(symbol, "4h", 400,
            candleStart - 399 * STEALTH_R4H_H4_MS, closeAt - 1);
          const candles = rows
            .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
            .filter((c) => Number.isFinite(c.time) && c.time <= candleStart && c.close > 0)
            .sort((a, b) => a.time - b.time);
          if (candles.at(-1)?.time !== candleStart) { count("stealth_r4h_candle_missing"); continue; }
          // Structure without volume first: only breakouts cost CoinGlass calls.
          const structural = evaluateRange4hBreakout(candles, null);
          if (structural.reason !== "stealth_r4h_volume_unknown") { count(structural.reason); continue; }
          const volumes = await getAggFuturesVolumeByInterval(symbol, "4h", 21).catch(() => null);
          const decision = evaluateRange4hBreakout(candles, volumes);
          if (!decision.pass) { count(decision.reason); continue; }
          const [takerBars, spot] = await Promise.all([
            getAggFuturesTakerHistory(symbol, 24).catch(() => null),
            getSpotCvdAndVolume(symbol, { bypassCache: true }).catch(() => null),
          ]);
          const takerNetUsd = reactionTakerNetUsd(takerBars, candleStart, Date.now(), STEALTH_R4H_H4_MS);
          const spotCvd4h = spot?.cvd.available ? spot.cvd.cvd4h : null;
          const flow = evaluateNeonFlowGate({ takerNetUsd, spotCvd1h: spotCvd4h });
          if (!flow.pass) {
            count(`stealth_r4h_flow_${flow.reason}`);
            _symRej(symbol, "stealth_breakout", `stealth_r4h_flow_${flow.reason}`, null, decision.volRatio, null, null, "rejected",
              { rangeTop: decision.rangeTop, volRatio: decision.volRatio, takerNetUsd, spotCvd4h });
            continue;
          }
          count("stealth_r4h_pass");
          passes.push(symbol);
          stealthRange4hQueue.set(`${symbol}:${candleStart}`, {
            ...decision, symbol, detectedAt: Date.now(), takerNetUsd, spotCvd4h,
            quoteVolume24h: Number.isFinite(qv) ? qv : null,
          });
        } catch {
          stats.errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
    stealthRange4hLastCandle = candleStart;
    logger.info(
      { candle: new Date(candleStart).toISOString(), stats, passes, durationMs: Date.now() - now },
      "Stealth 4H Range breakout scan done",
    );
  } catch (err) {
    logger.warn({ err, candle: new Date(candleStart).toISOString() }, "Stealth 4H Range breakout scan failed; retrying");
  } finally {
    stealthRange4hRunning = false;
  }
}
/** A fresh-high event older than this after its candle close is not fired. */
const STEALTH_FH_EVENT_TTL_MS = 30 * 60_000;
const STEALTH_FH_SCAN_DELAY_MS = 45_000;
const STEALTH_FH_HOUR_MS = 60 * 60_000;
const stealthFreshHighQueue = new Map<
  string,
  FreshHighEvent & { quoteVolume24h: number | null }
>();
let stealthFreshHighLastHour = 0;
let stealthFreshHighRunning = false;
let stealthFreshHighTimer: NodeJS.Timeout | null = null;

/** Evaluates the last closed 1H candle of every BingX USDT perpetual once. */
async function runStealthFreshHighHour(now = Date.now()): Promise<void> {
  if (!STEALTH_FH_LIVE || stealthFreshHighRunning) return;
  const hourStart = lastClosedHourStart(now);
  const closeAt = hourStart + STEALTH_FH_HOUR_MS;
  if (hourStart <= stealthFreshHighLastHour) return;
  if (now < closeAt + STEALTH_FH_SCAN_DELAY_MS) return;
  if (now > closeAt + STEALTH_FH_EVENT_TTL_MS) {
    stealthFreshHighLastHour = hourStart;
    return;
  }
  stealthFreshHighRunning = true;
  try {
    const volumes = new Map<string, number>();
    const { events, stats } = await scanFreshHighHour(hourStart, {
      listSymbols: async () => {
        const tickers = await getFutureTickers();
        const out: string[] = [];
        for (const t of tickers) {
          if (!t.symbol.endsWith("-USDT") || t.symbol === "BTC-USDT") continue;
          const qv = Number.parseFloat(t.quoteVolume);
          if (Number.isFinite(qv)) volumes.set(t.symbol, qv);
          out.push(t.symbol);
        }
        if (out.length === 0) throw new Error("no BingX tickers");
        return out;
      },
      // startTime/endTime keep these candles out of the shared bars store.
      loadCandles: (symbol) =>
        getKlines(
          symbol,
          "1h",
          120,
          hourStart - 119 * STEALTH_FH_HOUR_MS,
          closeAt - 1,
        ),
      hasCandleAtOrBefore: async (symbol, time) =>
        (
          await getKlines(
            symbol,
            "1h",
            5,
            time - 4 * STEALTH_FH_HOUR_MS,
            time,
          )
        ).length > 0,
      concurrency: 6,
    });
    stealthFreshHighLastHour = hourStart;
    for (const ev of events) {
      stealthFreshHighQueue.set(`${ev.symbol}:${ev.candleTime}`, {
        ...ev,
        quoteVolume24h: volumes.get(ev.symbol) ?? null,
      });
    }
    logger.info(
      {
        candle: new Date(hourStart).toISOString(),
        stats,
        passes: events.map((e) => e.symbol),
        durationMs: Date.now() - now,
      },
      "Stealth fresh-24H-high hourly scan done",
    );
  } catch (err) {
    logger.warn(
      { err, candle: new Date(hourStart).toISOString() },
      "Stealth fresh-24H-high hourly scan failed; retrying",
    );
  } finally {
    stealthFreshHighRunning = false;
  }
}

const STEALTH_QUIET_ZONE_4H_EXPERIMENT_VERSION =
  "quiet-zone-4h-breakout-v1" as const;

// Range Breakout fires on a closed 4H Pine breakout (two closed 1H holding
// candles) or on a closed 1H Pine breakout (closed-30m refinement).
// Owner decision 2026-10-10: 4H Range Breakout removed; only 1H creates trades.
const AUTO_RANGE_LIVE_ENABLED = false;
const AUTO_RANGE_1H_LIVE_ENABLED = true;
type AutoRangeTimeframe = "1h" | "4h";
const autoRangeEnabled = (timeframe: AutoRangeTimeframe) =>
  timeframe === "1h" ? AUTO_RANGE_1H_LIVE_ENABLED : AUTO_RANGE_LIVE_ENABLED;
const autoRangeCacheKey = (symbol: string, timeframe: AutoRangeTimeframe) =>
  `${timeframe}:${symbol}`;
const AUTO_RANGE_MIN_CLOSED_CANDLES = AUTO_RANGE_HISTORY_MIN_CLOSED_CANDLES;
// 1H state depends on the replay start. Owner 2026-10-18: replay N=2000 bars
// (weekly-anchored start, so 2000..2168 bars) instead of the former 600.
const AUTO_RANGE_1H_REPLAY_WINDOW = resolveAutoRange1hReplayWindow();

/** Armed symbols missing from the BingX universe are closed only after this grace. */
const ARM_SYMBOL_MISSING_GRACE_MS = 48 * 60 * 60 * 1000;
const armSymbolMissingSince = new Map<string, number>();

const KLINE_1H_LOOKBACK = 300;
const KLINE_4H_LOOKBACK = 300;
const neonDailyKlinesCache = new Map<
  string,
  { fetchedAt: number; rows: BingXKline[] }
>();
let autoRangeDisabledArmsSwept = false;

let autoRangeScanCursor = 0;
// A 2000-bar replay per symbol is heavy; the result only changes when a new
// closed 1H candle arrives or the weekly-anchored window start moves.
const oneHourRangeReplayMemo = new Map<
  string,
  {
    lastTime: number;
    firstTime: number;
    length: number;
    result: AutoRangePineResult;
  }
>();
const autoRangeHistoryQueue = new AutoRangeHistoryQueue<BingXKline>({
  countClosedCandles: (candles) =>
    normalizeClosedBreakoutCandles(candles).length,
  codec: bingxKlineCodec,
  requiredClosedCandles: AUTO_RANGE_MIN_CLOSED_CANDLES,
  fetchLimit: autoRangeHistoryFetchLimit(AUTO_RANGE_1H_REPLAY_WINDOW),
  cacheLimit: AUTO_RANGE_HISTORY_CACHE_LIMIT,
  candleLimit: autoRangeHistoryCandleLimit(AUTO_RANGE_1H_REPLAY_WINDOW),
  queueLimit: AUTO_RANGE_HISTORY_CACHE_LIMIT,
  maxItemsPerCycle: AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE,
  concurrency: AUTO_RANGE_HISTORY_CONCURRENCY,
  transientRetryMs: AUTO_RANGE_HISTORY_TRANSIENT_RETRY_MS,
  successfulShortHistoryRetryMs: AUTO_RANGE_HISTORY_SUCCESSFUL_SHORT_RETRY_MS,
  onFetched: (key, candles, lastFetchAt) => {
    void dbWriteBestEffort("auto-range-history/save", () =>
      saveAutoRangeHistory(key, candles, lastFetchAt),
    );
  },
});

registerProcessHealthSource("auto_range_history", () => {
  // Compact Float64Array storage: bytes are the real typed-array size.
  const { symbols, candles, packedBytes } = autoRangeHistoryQueue.cacheStats();
  return { entries: symbols, bytes: packedBytes, candles };
});

/** Restores persisted Auto Range history so a restart does not empty the cache. */
export async function hydrateAutoRangeHistoryFromDb(): Promise<void> {
  const stats = await loadAutoRangeHistory((key, candles, lastFetchAt) =>
    autoRangeHistoryQueue.hydrate(key, candles, lastFetchAt),
  );
  logger.info(
    { ...stats, ready: autoRangeHistoryQueue.readyKeys().length },
    "Auto Range history restored from database",
  );
  // Rows are re-saved slowly so their fetch time never ages past the load cutoff.
  setInterval(
    () => {
      const due = autoRangeHistoryQueue
        .readyKeys()
        .filter((key) => needsResave(key))
        .slice(0, 20);
      for (const key of due) {
        void dbWriteBestEffort("auto-range-history/resave", () =>
          saveAutoRangeHistory(
            key,
            autoRangeHistoryQueue.getCandles(key),
            autoRangeHistoryQueue.getLastFetchAt(key),
          ),
        );
      }
    },
    10 * 60 * 1000,
  ).unref();
}

/** Snapshot of Auto Range history readiness for coverage reporting. */
export function autoRangeHistoryCoverage(symbols: readonly string[]) {
  const out = { total: symbols.length, ready1h: 0, ready4h: 0 };
  for (const symbol of symbols) {
    if (autoRangeHistoryQueue.isHistoryReady(autoRangeCacheKey(symbol, "1h")))
      out.ready1h++;
    if (autoRangeHistoryQueue.isHistoryReady(autoRangeCacheKey(symbol, "4h")))
      out.ready4h++;
  }
  return out;
}

/** PLM retired from live trading; rows and history stay in the database. */
const PLM_LIVE_ENABLED = false as boolean;
function mergeAutoRangeHistory(
  symbol: string,
  incoming: readonly BingXKline[],
  timeframe: AutoRangeTimeframe = "4h",
): void {
  const key = autoRangeCacheKey(symbol, timeframe);
  autoRangeHistoryQueue.merge(key, incoming);
}

function scheduleAutoRangeHistoryFetch(
  symbol: string,
  priority = 0,
  timeframe: AutoRangeTimeframe = "4h",
): void {
  if (!autoRangeEnabled(timeframe)) return;
  const key = autoRangeCacheKey(symbol, timeframe);
  autoRangeHistoryQueue.enqueue(key, priority);
}

function getAutoRangeClosedCandles(
  symbol: string,
  timeframe: AutoRangeTimeframe = "4h",
): ReturnType<typeof normalizeClosedBreakoutCandles> {
  const key = autoRangeCacheKey(symbol, timeframe);
  // Partial prefetch candles give a different (wrong) Range; wait for the
  // completed full-history fetch.
  if (!autoRangeHistoryQueue.isHistoryReady(key)) return [];
  const packed = autoRangeHistoryQueue.getPackedRows(key);
  if (packed) return packedToClosedCandles(packed);
  return normalizeClosedBreakoutCandles(
    autoRangeHistoryQueue.getCandles(key) ?? [],
  );
}

// ── Concurrency helper ──────────────────────────────────────────────────────
// Runs fn on each item with at most `concurrency` items in-flight at once.
// Used for parallel pre-fetching of klines and SpotCVD before the scan loop.
/** Qualified signals of one batch are persisted and queued in parallel. */
const CONFIRMED_FIRE_CONCURRENCY = 6;

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (items.length === 0) return;
  const iter = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (let step = iter.next(); !step.done; step = iter.next()) {
        if (signal?.aborted) return;
        // A hard cycle timeout/lease loss must stop workers before they begin
        // another symbol. Network clients receive the same abort signal.
        assertMarketCycleLeaseOwnership("scanner concurrent work");
        await fn(step.value);
        if (signal?.aborted) return;
        assertMarketCycleLeaseOwnership("scanner concurrent work");
      }
    }),
  );
}

export interface ScannerState {
  running: boolean;
  lastScanAt: Date | null;
  /** Last cycle whose work completed and whose shared lease was released. */
  lastSuccessfulScanAt: Date | null;
  /** Compatibility status exposed by scanner API routes. */
  scanStartedAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureReason: string | null;
  retryAt: Date | null;
  activeMarketLeaseExpiresAt: Date | null;
  nextScanAt: Date | null;
  marketsScanned: number;
  scanIntervalMs: number;
  bingxConnected: boolean;
  telegramConnected: boolean;
  /** Когда последний раз успешно вставили запись в oiWatchTable (любой путь) */
  oiWatchLastInsertAt: Date | null;
  /** Сколько INSERT'ов в oiWatchTable упало с исключением с момента старта сервера */
  oiWatchInsertErrors: number;
  /** Текст последнего пойманного исключения при INSERT в oiWatchTable */
  oiWatchLastInsertError: string | null;
  /** Сколько записей в oiWatchTable успешно создано в последнем скан-цикле */
  oiWatchInsertsLastScan: number;
  /** Сколько токенов получили cgTimeout/cgBuilding fallback в последнем скан-цикле */
  cgTimeoutsLastScan: number;
  /** true пока performScan выполняется */
  isScanning: boolean;
  /** Длительность последнего завершённого скана в мс */
  lastScanDurationMs: number | null;
  /** Телеметрия CoinGlass последнего завершённого скана (null до первого скана) */
  lastCgTelemetry: CgTelemetrySnapshot | null;
  /** Durable recovery state is mirrored locally when the database is unavailable. */
  scannerFailureReason: ScannerFailureReason | null;
  scannerFailureAt: Date | null;
  scannerLeaseExpectedExpiryAt: Date | null;
}

const state: ScannerState = {
  running: false,
  lastScanAt: null,
  lastSuccessfulScanAt: null,
  scanStartedAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  retryAt: null,
  activeMarketLeaseExpiresAt: null,
  nextScanAt: null,
  marketsScanned: 0,
  scanIntervalMs: 600_000,
  bingxConnected: false,
  telegramConnected: false,
  oiWatchLastInsertAt: null,
  oiWatchInsertErrors: 0,
  oiWatchLastInsertError: null,
  oiWatchInsertsLastScan: 0,
  cgTimeoutsLastScan: 0,
  isScanning: false,
  lastScanDurationMs: null,
  lastCgTelemetry: null,
  scannerFailureReason: null,
  scannerFailureAt: null,
  scannerLeaseExpectedExpiryAt: null,
};

let controlPlaneUnavailableSince: Date | null = null;

/**
 * Персистентный кеш глобальных объёмов из CoinGlass (volUsd).
 * Накапливается между сканами — не сбрасывается.
 * Ключ: baseSymbol без USDT (например "DYDX"), значение: volUsd в USD.
 * После 1-го скана используется вместо BingX-объёма для пре-скрина Layer 2.
 */
const cgVolumeCache = new Map<string, number>();

// Whale Tracker: дневной снимок OI пишется 1 раз в сутки (UTC), не каждый скан-цикл —
// иначе saveDailyOiSnapshots() делает ~500 лишних SELECT на дубли каждые ~10 мин.
let lastOiSnapshotDate: string | null = null;

// ── Persistent Pre-screen Tracker ───────────────────────────────────────────
// Ловит Ghost Pump: токены которые стабильно держатся в топ-N prescan 2+ цикла
// без полноценного OI/vol сигнала — ранняя поимка на старте движения.
interface PrescanEntry {
  firstPrice24h: number; // price24h% при первом появлении в топ-N
  lastPrice24h: number; // актуальное price24h% (обновляется каждый цикл)
  firstSeenAt: number; // timestamp первого появления
  firstPrice: number; // цена при первом появлении (для расчёта реального движения)
  cycleCount: number; // сколько циклов подряд в топ-N
  bestRank: number; // лучший ранг в топ-N (1 = самый горячий)
  lastScore: number; // activity score последнего цикла (тренд)
  firstScore: number; // activity score первого цикла (база для тренда)
  lastPrice: number; // текущая цена (для алерта)
  lastFiredAt: number; // timestamp последнего алерта (кулдаун)
  lastCvdOk?: boolean; // последняя CVD проверка: cvdRising2 (2 цикла нетто-покупок)
  lastNetBuyPct?: number; // последний netBuyPct (%) из getCoinglassTakerFlow
  lastOi30m?: number | null; // OI 30m %
  lastOi1h?: number | null; // OI 1h %
  lastOi4h?: number | null; // OI 4h %
  lastOi24h?: number | null; // OI 24h %
  lastPrice1h?: number | null; // Изменение цены за последний 1ч (2×30m свечи назад)
  lastPrice3h?: number | null; // Изменение цены за последние 3ч (6×30m свечи назад)
  lastCvd15m?: boolean | null; // spot CVD 15m verdict (последняя 1 × 15m свеча)
  lastCvd30m?: boolean | null; // spot CVD 30m verdict
  lastCvd1h?: boolean | null; // spot CVD 1h TF verdict
  lastCvd4h?: boolean | null; // spot CVD 4h TF verdict
  lastVolMult?: number | null; // BingX 30m volume multiplier (curVol/avgVol)
  lastAvgVol?: number | null; // среднее агрегированное (CoinGlass) 30m volume в USDT, прошлый цикл
  prevVolMult?: number | null; // volMult предыдущего цикла (для расчёта ускорения)
  firstOi30m?: number | null; // OI 30m % при первом попадании в prescan (entry snapshot)
  firstOi1h?: number | null; // OI 1h % при первом попадании в prescan
  firstOi4h?: number | null; // OI 4h % при первом попадании в prescan
  firstObRatio?: number | null; // bid/ask ratio при первом попадании в prescan
  lastObRatio?: number | null; // bid/ask ratio последнего цикла (обновляется при каждом OB-фетче)
  firstFundingRate?: number | null; // funding rate при первом попадании (raw decimal)
  firstWhaleIndex?: number | null; // Whale Index при первом попадании (lazy: из batchUpdateWhaleIndex)
  firstSnf1h?: number | null; // Spot NetFlow 1h % при первом попадании (lazy: из SNF кэша)
  lastCgTimedOut?: boolean; // последний CG запрос упал по таймауту (≠ BingX Only)
  cgNoDataCount?: number; // сколько ПОДРЯД циклов CG вернул available=false+timedOut=false
  lastSkipReason?: string | null; // причина пропуска в последнем цикле: "no_pattern" | "late_pump" | null
  lastOiAt?: number | null; // timestamp последнего обновления OI данных (Date.now())
  prevOi30m?: number | null; // OI 30m % прошлого цикла (для расчёта ускорения)
  prevOi4h?: number | null; // OI 4h % прошлого цикла
  oiAccel30m?: number | null; // ускорение OI 30m: lastOi30m / prevOi30m (>1 = растёт)
  oi4hConsecGrowth?: number; // счётчик: сколько подряд циклов OI4h растёт
  // ── Межцикловые счётчики ────────────────────────────────────────────────────
  volAccelSpike?: boolean; // объём удвоился за цикл (lastVolMult/prevVolMult ≥ 2.0) + cycleCount ≥ 5
  cvdPositiveCycles?: number; // сколько циклов подряд CVD 30m положительный (сбрасывается при первом минусе)
  takerPositiveCycles?: number; // сколько циклов подряд taker netBuyPct > 0 (прокси: cvd30m === true)
  // ── Спот тейкер (только дашборд, не влияет на паттерны) ─────────────────────
  lastSpotTakerNetBuy?: number | null; // netBuyPct% последней 30m спот свечи
  lastSpotTakerDominance?: "buy" | "sell" | "neutral" | null;
  lastSpotTakerExchange?: "aggregated" | null;
  // ── Спот объём 1h (CoinGlass pairs-markets, только дашборд) ──────────────────
  lastSpotVol1h?: number | null; // суммарный спот объём за 1h по всем биржам (USD)
  prevSpotVol1h?: number | null; // прошлый цикл
  lastSpotVol4h?: number | null; // суммарный спот объём за 4h
  lastSpotNetBuy1h?: number | null; // (buy-sell)/(buy+sell)*100 за 1h
  spotVolAvg1h?: number | null; // скользящее среднее 5 циклов (для вычисления mult)
  spotVolCycles?: number; // сколько циклов накоплено
  droppedFromPoolCycles?: number; // счётчик "льготных" циклов после выпадения из currentTopSymbols
  // (пока spotVolCycles < 2 — не удаляем сразу, см. SPOT_VOL_GRACE_CYCLES)
  bingxDirectOI?: number | null; // OI из /v2/quote/openInterest (для BingX-exclusive токенов)
  layers?: string[]; // prescan layers текущего цикла: WL/L1/L2/.../L8
  // ── Futures vs Spot Volume (CoinGlass futures_spot_volume_ratio, Binance+OKX+Bybit) ─
  futVolUsd24h?: number | null; // фьючерсный объём 24h USD
  spotVolUsd24h?: number | null; // спотовый объём 24h USD
  futSpotRatio?: number | null; // futVolUsd24h / spotVolUsd24h
  futVolPctMcap?: number | null; // futVolUsd24h / mcapUsd * 100
  spotVolPctMcap?: number | null; // spotVolUsd24h / mcapUsd * 100
  lastWhaleIndex?: number | null; // Whale Index по токену (CoinGlass, Binance futures); обновляется раз в цикл для OI Watch + топ prescan
  hasFiredBefore?: boolean; // true после первого сброса cycleCount (resetPrescanCycleCount) — подавляет повторный freshMoverRisk
}
const prescanTracker = new Map<string, PrescanEntry>();
// Содержит все символы BingX фьючерсов из последнего скан-цикла.
// Обновляется после getFutureTickers() — используется для различия
// "нет на BingX" vs "есть на BingX, но вне топ-N пресканера".
const bingxFuturesSymbols = new Set<string>();
// Neon qualified events already offered to a scan (symbol:triggerCandleTime).
const neonOfferedEventKeys = new Set<string>();

const _latestFrMap = new Map<string, number>();
let _latestFrMapUpdatedAt = 0;
const FUNDING_RATE_MAX_AGE_MS = 20 * 60_000;
// Impulse Buy decision-time diagnostics remain recorded alongside the
// ordinary signal lifecycle.
const IMPULSE_BUY_LIVE_FIRE_ENABLED = true;
const SPOT_VOL_GRACE_CYCLES = 3;

function getFreshFundingRate(symbol: string, now = Date.now()): number | null {
  if (
    _latestFrMapUpdatedAt <= 0 ||
    now - _latestFrMapUpdatedAt > FUNDING_RATE_MAX_AGE_MS
  ) {
    return null;
  }
  return _latestFrMap.get(symbol) ?? null;
}

async function refreshLatestFundingRates(): Promise<number> {
  const snapshot = await getAllFundingRates();
  if (snapshot.size === 0) {
    if (
      _latestFrMapUpdatedAt > 0 &&
      Date.now() - _latestFrMapUpdatedAt > FUNDING_RATE_MAX_AGE_MS
    ) {
      _latestFrMap.clear();
      _latestFrMapUpdatedAt = 0;
    }
    return 0;
  }
  _latestFrMap.clear();
  for (const [symbol, rate] of snapshot) _latestFrMap.set(symbol, rate);
  _latestFrMapUpdatedAt = Date.now();
  return snapshot.size;
}

// Кэш quoteVolume для Layer 4: per-token EMA дельт между циклами.
// Структура: { prev — quoteVolume прошлого цикла; ema — бегущая EMA дельт или null (прогрев) }
// Холодный старт: 1-й цикл → prev=curVol, ema=null, gate не проверяется.
//                2-й цикл → ema=delta1, gate не проверяется (только инициализация).
//                3-й цикл+ → нормальный gate: delta > ema * 2.5 && delta > VOL_AWAKEN_MIN_DELTA_USD.
const prevQuoteVolCache = new Map<
  string,
  { prev: number; ema: number | null }
>();

// Минимальная абсолютная дельта объёма за цикл для L4 gate (USD).
// Защита от ложных пробуждений тихих токенов: у них EMA ≈ 0, и 2.5× от нуля → всё пройдёт.
// $50k delta/цикл ≈ базовый объём токена $288k+/день — нижняя граница осмысленного сигнала.

// Layer 8: Steady Climbers — трекер устойчивого роста цены между циклами.
// Каждые ~10 минут обновляем lastPrice для ВСЕХ ~520 токенов.
// Если цена растёт на +0.8–8% подряд 3+ цикла → токен инжектируется в глубокий скан.
const steadyClimbMap = new Map<
  string,
  { growthCycles: number; lastPrice: number }
>();

// Постоянный кэш последних известных live-данных по символу.
// В отличие от prescanTracker, записи НИКОГДА не удаляются (только перезаписываются).
// Используется как fallback в getLiveMarketData для открытых позиций,
// чья монета уже "остыла" и выпала из топ-N prescan.
const lastKnownLiveData = new Map<
  string,
  {
    oi30m: number | null;
    oi1h: number | null;
    oi4h: number | null;
    oi24h: number | null;
    cvd15m: boolean | null;
    cvd30m: boolean | null;
    cvd1h: boolean | null;
    cvd4h: boolean | null;
    netBuyPct: number | null;
    price1h: number | null;
    price24h: number | null;
    spotTakerNetBuy: number | null;
    spotTakerDominance: string | null;
    whaleIndex: number | null;
    updatedAt: number;
  }
>();
// Throttle для "греется" алертов: символ → timestamp последней отправки
// const heatingAlertThrottle = new Map<string, number>(); // DISABLED: HeatingAlert отключён
// Фильтры: топ-10 + 3 цикла подряд (~30 мин) — только горячие токены с устойчивым присутствием
const _PERSIST_MIN_CYCLES = 3;
const _PERSIST_MIN_PRICE24H = 5.0; // % 24h изменение (стандартный ghost pump)
const _PERSIST_MAX_PRICE24H = 12.0; // % 24h cap — не стрелять если движение уже случилось
const _PERSIST_MAX_RANK = 30; // топ-30 (расширено с топ-10)
const _PERSIST_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4ч между алертами одного токена
// Ранний ghost pump: ловим накопление ДО старта движения
const _PERSIST_EARLY_MIN_CYCLES = 2; // 2 цикла (~20 мин) — раньше стандартного
const _PERSIST_EARLY_MAX_RANK = 10; // только топ-10 — самые горячие
const _PERSIST_EARLY_MAX_PRICE24H = 10.0; // цена ещё не двинулась сильно — накопление
function isConfirmedDetection(detection: DetectionResult | null): boolean {
  return (
    detection != null &&
    "__isConfirmedFire" in detection &&
    detection.__isConfirmedFire === true
  );
}
let _scanEndFence: Promise<void> = Promise.resolve();
const SCAN_END_FENCE_MAX_MS = 90_000;
const TELEMETRY_POOL_DELAY_MS = 8 * 60_000;

const _telemetryQueue = new DurableTelemetryQueue<PrescanTelemetryItem>({
  recoveryDelayMs: TELEMETRY_POOL_DELAY_MS,
  store: prescanTelemetryOutboxStore,
  write: async (item) =>
    runOutsideMarketCycleLease(async () => {
      if (item.kind === "history") {
        await _writeTelemetryHistory(item.rows);
      } else if (item.kind === "snapshots") {
        await _writeTelemetrySnapshots(item.rows);
      }
    }),
  onRetry: (err, item, attempt) => {
    logger.warn(
      { err, kind: item.kind, attempt, dedupKey: item.dedupKey },
      "telemetryWriter: durable write failed — will retry after restart-safe backoff",
    );
  },
});

/** Start durable telemetry recovery before a scanner begins producing new rows. */
export async function startTelemetryOutbox(): Promise<void> {
  await _telemetryQueue.start();
}
async function _writeTelemetryHistory(
  rows: Array<typeof prescanHistoryTable.$inferInsert>,
): Promise<void> {
  if (rows.length === 0) return;
  // TTL cleanup before insert (best-effort, non-blocking — failure does not
  // prevent the insert and does not count as a write failure).
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  await dbWriteBestEffort("prescanHistory/cleanup-delete", () =>
    db.delete(prescanHistoryTable).where(lt(prescanHistoryTable.ts, cutoff)),
  );
  // dbWriteBestEffort returns null on failure — treat that as a hard error so
  // the TelemetryQueue retries the item rather than silently dropping the rows.
  const result = await dbWriteBestEffort(
    "prescanHistory/insert",
    () => db.insert(prescanHistoryTable).values(rows).onConflictDoNothing(),
    { perAttemptTimeoutMs: 8000, attempts: 3 },
  );
  if (result === null) {
    throw new Error(
      `prescanHistory/insert: all attempts failed for ${rows.length} rows`,
    );
  }
  logger.info(
    { count: rows.length },
    "Prescan history saved (telemetry queue)",
  );
}

async function _writeTelemetrySnapshots(
  rows: InsertPrescanSnapshot[],
): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 150;
  let savedCount = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const result = await dbWriteBestEffort(
      "prescanSnapshots/insert",
      () =>
        db.insert(prescanSnapshotsTable).values(chunk).onConflictDoNothing(),
      { perAttemptTimeoutMs: 8000, attempts: 3 },
    );
    if (result !== null) savedCount += chunk.length;
  }
  // Throw on any chunk failure so TelemetryQueue retries the whole item rather
  // than silently accepting a partial write and dropping the unwritten rows.
  // The item is immutable (rows were captured synchronously at scan-end), so
  // retrying is safe — the same rows will be re-inserted on the next attempt.
  if (savedCount < rows.length) {
    throw new Error(
      `prescanSnapshots/insert: partial write — saved ${savedCount}/${rows.length} rows`,
    );
  }
  logger.info(
    { attempted: rows.length, saved: savedCount },
    "Prescan snapshots saved (telemetry queue)",
  );
}

// ── Cycle candidates snapshot ─────────────────────────────────────────────────
// Сохраняется после каждого цикла — для вкладки "Кандидаты цикла" в UI.
interface CycleCandidateEntry {
  symbol: string;
  layers: string[]; // ["L1", "L3"] — источники попадания в батч
  price24h: number;
  price: number;
  score: number;
  cycledAt: number; // unix ms
}
let lastCycleCandidates: CycleCandidateEntry[] = [];
let lastCycleAt: number | null = null;

export interface LayerDebugStats {
  exhaustedByTicker: number;
  l3CandidatesTotal: number;
  l3PassedToBatch: number;
  l4CandidatesTotal: number;
  l4PassedToBatch: number;
  l5CandidatesTotal: number;
  l5PassedToBatch: number;
  l8SteadyGrowthCycles: number;
  l8PassedToBatch: number;
  l8bOiLeadersTotal: number;
  l8bInsertedToWatch: number;
  l6cRescuedTotal: number;
  quietPrescanAdded: number;
  l10LiqCascadeAdded: number;
  l15WhalePositionAdded: number;
  cycleNumber: number;
}
export let lastLayerDebug: LayerDebugStats = {
  exhaustedByTicker: 0,
  l3CandidatesTotal: 0,
  l3PassedToBatch: 0,
  l4CandidatesTotal: 0,
  l4PassedToBatch: 0,
  l5CandidatesTotal: 0,
  l5PassedToBatch: 0,
  l8SteadyGrowthCycles: 0,
  l8PassedToBatch: 0,
  l8bOiLeadersTotal: 0,
  l8bInsertedToWatch: 0,
  l6cRescuedTotal: 0,
  quietPrescanAdded: 0,
  l10LiqCascadeAdded: 0,
  l15WhalePositionAdded: 0,
  cycleNumber: 0,
};

export interface PatternDebugEntry {
  checked: number;
  passed: number;
  rejectedAt: Record<string, number>;
}
const _pdbNew = (): PatternDebugEntry => ({
  checked: 0,
  passed: 0,
  rejectedAt: {},
});
export function _pdbCheck(key: string) {
  markLoopSegment(key);
  const e = (lastPatternDebug[key] ??= _pdbNew());
  e.checked++;
}
const _pdbSymbolStore = new AsyncLocalStorage<{
  passed: Set<string>;
  context: PatternDebugCandidateContext | null;
}>();
export function _pdbPass(key: string) {
  const e = (lastPatternDebug[key] ??= _pdbNew());
  e.passed++;
  _pdbSymbolStore.getStore()?.passed.add(key);
}
function withCandleRealVolume(
  metrics: Record<string, unknown> | undefined,
  observation: CandleVolumeObservation | null,
): Record<string, unknown> | undefined {
  if (observation === null) return metrics;
  return { ...(metrics ?? {}), candleRealVolume: observation };
}
type PatternDebugCandidateContext = Readonly<{
  symbol: string;
  entryPrice: number | null;
  oi30m: number | null;
  volMult: number | null;
  price24h: number | null;
  prescanCycles: number | null;
  impulseBuyMetrics?: Record<string, unknown>;
  priceLedMomentumMetrics?: Record<string, unknown>;
}>;
// Set from immutable values once the symbol reaches pattern evaluation. Calls
// before a canonical pattern exists never set/use this context.
// Per-symbol (AsyncLocalStorage): scan workers run concurrently, so a module-level
// variable let one symbol's rejects be logged under another symbol's context.
const _pdbCtx = {
  get value(): PatternDebugCandidateContext | null {
    return _pdbSymbolStore.getStore()?.context ?? null;
  },
  set value(next: PatternDebugCandidateContext | null) {
    const store = _pdbSymbolStore.getStore();
    if (store) store.context = next;
  },
};
export function _pdbReject(key: string, gate: string) {
  const e = (lastPatternDebug[key] ??= _pdbNew());
  e.rejectedAt[gate] = (e.rejectedAt[gate] ?? 0) + 1;
  const context = _pdbCtx.value;
  if (context) {
    _symRej(
      context.symbol,
      key,
      gate,
      context.oi30m,
      context.volMult,
      context.price24h,
      context.prescanCycles,
      undefined,
      key === "impulse_buy"
        ? context.impulseBuyMetrics
        : key === "price_led_momentum"
          ? context.priceLedMomentumMetrics
          : undefined,
      context.entryPrice,
    );
  }
}
// Инициализирует запись в lastPatternDebug без инкремента счётчиков.
export function _pdbEnsure(key: string) {
  lastPatternDebug[key] ??= _pdbNew();
}

// ── Diagnostic-only: паттерн прошёл свой внутренний гейт (_pdbPass) — но
// _pdbPass не хранит символ, только агрегатный счётчик за цикл. Для редких
// паттернов (0-3 прохода за цикл) это делает невозможным трассировку "прошёл
// гейт → дошёл до сигнала ИЛИ потерян на cooldown/chronic-token/alphaScore
// ниже по пайплайну" (та же категория проблемы, что и spot_taker_lead —
// сигнал теряется НЕ на своём гейте, а на отдельном фильтре дальше).
// Пишем symbol + cycleNumber в pattern_debug_log (cvdDiag="passed_gate"),
// чтобы потом сверить с signals/tracked_signals по времени и символу.
// Не влияет на поведение — только диагностика. Best-effort, fire-and-forget.
// bulletScore/detKey are only known in loop2 (Phase 3, over `candidates`), while the
// gate-pass itself happens in loop1 (Phase 1, over `usdtTickers`) — see _passedGatePatternsMap
// which bridges the two loops per symbol (same convention as _spotCvdMapScan).
function diagPatternPassed(
  pattern: string,
  sym: string,
  bulletScore?: number | null,
  detKey?: string | null,
): void {
  // Строка добавляется в очередь _pendingDiagRows и сбрасывается одним bulk INSERT
  // в конце performScan (flushPendingDiagRows). Устраняет 100+ per-symbol inserts
  // mid-scan, конкурирующих с основными reads за Neon pool.
  _pendingDiagRows.push({
    pattern,
    cycleNumber: scanCycleCounter,
    checked: 0,
    passed: 0,
    rejectedAt:
      bulletScore !== undefined || detKey !== undefined
        ? JSON.stringify({
            bulletScore: bulletScore ?? null,
            detKey: detKey ?? null,
          })
        : null,
    symbol: sym,
    cvdDiag:
      bulletScore !== undefined || detKey !== undefined
        ? "passed_gate_scored"
        : "passed_gate",
  });
}

export let lastPatternDebug: Record<string, PatternDebugEntry> = {};
const lastCycleLayers = new Map<string, string[]>(); // symbol → prescan layers для текущего цикла

// ── Pending pattern_debug rows queue ─────────────────────────────────────────
// diagPatternPassed / diagCvdIfOiRejected накапливают строки сюда mid-scan.
// flushPendingDiagRows() сбрасывает одним bulk INSERT в конце цикла, после того
// как основные DB-reads скана завершились и пул освободился.
const _pendingDiagRows: Array<{
  pattern: string;
  cycleNumber: number;
  checked: number;
  passed: number;
  rejectedAt: string | null;
  symbol: string;
  cvdDiag: string | null;
}> = [];

async function flushPendingDiagRows(): Promise<void> {
  if (_pendingDiagRows.length === 0) return;
  const rows = _pendingDiagRows.splice(0); // drain atomically
  await dbWriteBestEffort(
    "flushDiagRows",
    () => db.insert(patternDebugLogTable).values(rows),
    {
      perAttemptTimeoutMs: 8000,
      retryDelayMs: 2000,
    },
  );
}

// ── Scan reject log — per-symbol per-pattern причины отклонения ───────────────
// Три уровня: (a) gate — ранние фильтры (exhaustedPump/deepNeg/cvdFail/contra/stalePump)
//             (b) inline pre-check — паттерн-специфичные условия до det
//             (c) no_match — прошёл все гейты, ни один паттерн не сработал
// Накапливается в _symRejLog весь цикл; persistSymRejectLog() вызывается в НАЧАЛЕ
// следующего цикла (вместе с persistPatternDebugSnapshot и flushPendingDiagRows).
let _symRejCycleAt = new Date(0);
// Current-cycle 30m close per symbol: lets direct _symRej() rejects (which do
// not pass a price) keep an entry price so their forward path can be evaluated.
const _symRejCycleClose = new Map<string, { cycleMs: number; price: number }>();
let _symRejDedupCycleMs = 0;
const _symRejDedup = new Set<string>();
const _symRejLog: Array<{
  cycleAt: Date;
  symbol: string;
  pattern: string;
  reason: string;
  oi30m: number | null;
  volMult: number | null;
  price24h: number | null;
  prescanCycles: number | null;
  decisionKind: "rejected" | "blocked" | "deferred";
  decisionMetrics?: Record<string, unknown>;
  decisionEntryPrice: number | null;
  zoneBottom: number | null;
  zoneTop: number | null;
}> = [];

/**
 * Support zone (bottom/top) matching a persisted Neon event level, plus the
 * next zone below it. Uses the bot's own 4H zone detector on closed candles.
 */
function neonZonesForLevel(
  fourHour: Parameters<typeof normalizeClosedBreakoutCandles>[0],
  level: number,
  armCandleTime: number,
): {
  zone: { bottom: number; top: number } | null;
  lower: { bottom: number; top: number } | null;
} {
  const closed = normalizeClosedBreakoutCandles(fourHour);
  // Same zone the detector itself holds for this frozen level.
  const zone = resolveFrozenZone(closed, armCandleTime, level);
  const below = computeSupportZones(closed)
    .filter((candidate) => candidate.top < zone.bottom * 0.999)
    .sort((a, b) => b.top - a.top)[0];
  return { zone, lower: below ?? null };
}

/** Closes a Stealth arm and writes the refusal reason to scan_reject_log. */
async function consumeStealthArmLogged(
  armId: number,
  reason: string,
  symbol: string,
): Promise<void> {
  _symRej(
    symbol,
    "stealth_breakout",
    reason,
    null,
    null,
    null,
    null,
    "rejected",
  );
  await markStealthArmConsumed(armId, reason);
}

function _symRej(
  symbol: string,
  pattern: string,
  reason: string,
  oi30m: number | null,
  vol: number | null,
  price24h: number | null,
  cycles: number | null,
  decisionKind: "rejected" | "blocked" | "deferred" = "rejected",
  decisionMetrics?: Record<string, unknown>,
  decisionEntryPrice: number | null = null,
): void {
  const cycleMs = _symRejCycleAt.getTime();
  if (decisionEntryPrice === null) {
    const known = _symRejCycleClose.get(symbol);
    if (known && known.cycleMs === cycleMs && known.price > 0) {
      decisionEntryPrice = known.price;
    }
  }
  if (_symRejDedupCycleMs !== cycleMs) {
    _symRejDedup.clear();
    _symRejDedupCycleMs = cycleMs;
  }
  const dedupKey = `${pattern}\u0000${symbol}\u0000${reason}\u0000${decisionKind}`;
  if (_symRejDedup.has(dedupKey)) return;
  _symRejDedup.add(dedupKey);
  // Universal decision-time flow snapshot for EVERY pattern and reason, frozen
  // at the moment of the decision (owner order 2026-10-10). Caller-supplied
  // metrics keep priority; missing values stay null, never reconstructed.
  const _pe = prescanTracker.get(symbol);
  const flowSnapshot = {
    capturedAt: Date.now(),
    oiObservedAt: _pe?.lastOiAt ?? null,
    oi30m: _pe?.lastOi30m ?? null,
    oi1h: _pe?.lastOi1h ?? null,
    oi4h: _pe?.lastOi4h ?? null,
    oi24h: _pe?.lastOi24h ?? null,
    cvd15m: _pe?.lastCvd15m ?? null,
    cvd30m: _pe?.lastCvd30m ?? null,
    cvd1h: _pe?.lastCvd1h ?? null,
    cvd4h: _pe?.lastCvd4h ?? null,
    cvdPositiveCycles: _pe?.cvdPositiveCycles ?? null,
    netBuyPct: _pe?.lastNetBuyPct ?? null,
    spotTakerNetBuy: _pe?.lastSpotTakerNetBuy ?? null,
    spotTakerDominance: _pe?.lastSpotTakerDominance ?? null,
    spotVol1h: _pe?.lastSpotVol1h ?? null,
    spotVol4h: _pe?.lastSpotVol4h ?? null,
    spotNetBuy1h: _pe?.lastSpotNetBuy1h ?? null,
    futVolMult: _pe?.lastVolMult ?? null,
    futSpotRatio: _pe?.futSpotRatio ?? null,
    whaleIndex: _pe?.lastWhaleIndex ?? null,
    obRatio: _pe?.lastObRatio ?? null,
    price1h: _pe?.lastPrice1h ?? null,
    price3h: _pe?.lastPrice3h ?? null,
    fundingRate: getFreshFundingRate(symbol),
  };
  _symRejLog.push({
    cycleAt: _symRejCycleAt,
    symbol,
    pattern,
    reason,
    oi30m,
    volMult: vol,
    price24h,
    prescanCycles: cycles,
    decisionKind,
    decisionMetrics: { flowSnapshot, ...(decisionMetrics ?? {}) },
    decisionEntryPrice,
    zoneBottom:
      typeof decisionMetrics?.zoneBottom === "number"
        ? decisionMetrics.zoneBottom
        : null,
    zoneTop:
      typeof decisionMetrics?.zoneTop === "number"
        ? decisionMetrics.zoneTop
        : null,
  });
}

// Near-miss telemetry for the p24h BA gate. The in-memory set avoids a DB
// write on every scan; a failed best-effort write is released for a later
// scan retry. The DB transaction makes rolling-deploy workers idempotent.
const _baP24hTelemetryPending = new Map<string, number>();
function recordBullishAccumulationP24hRejection(input: {
  symbol: string;
  priceAtLog: number | null;
  price24h: number;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  volMult: number | null;
  spotVolMult: number | null;
  prescanCycles: number | null;
  observedAt: Date;
}): void {
  const source = getBullishAccumulationP24hTelemetrySource(
    input.symbol,
    input.observedAt,
  );
  const now = Date.now();
  for (const [key, createdAt] of _baP24hTelemetryPending) {
    if (createdAt < now - 2 * BA_REJECT_TELEMETRY_WINDOW_MS) {
      _baP24hTelemetryPending.delete(key);
    }
  }
  if (_baP24hTelemetryPending.has(source)) return;
  _baP24hTelemetryPending.set(source, now);

  void (async () => {
    const written = await dbWriteBestEffort(
      "bullishAccumulation/p24h-missed-candidate",
      () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${source}))`,
          );
          await tx.execute(sql`
            INSERT INTO missed_signals_log (
              symbol, source, reason, pattern, price_at_log,
              price_24h_pct, oi_30m_pct, oi_1h_pct, oi_4h_pct,
              vol_mult, spot_vol_mult, prescan_cycles, logged_at
            )
            SELECT
              ${input.symbol}, ${source}, 'price24h_too_high_5pct',
              'bullish_accumulation', ${input.priceAtLog}, ${input.price24h},
              ${input.oi30m}, ${input.oi1h}, ${input.oi4h},
              ${input.volMult}, ${input.spotVolMult},
              ${input.prescanCycles}, ${input.observedAt}
            WHERE NOT EXISTS (
              SELECT 1 FROM missed_signals_log WHERE source = ${source}
            )
          `);
        }),
      { perAttemptTimeoutMs: 5000, attempts: 2, retryDelayMs: 1000 },
    );
    if (written === null) {
      _baP24hTelemetryPending.delete(source);
      logger.warn(
        { symbol: input.symbol, source },
        "BullishAccumulation p24h telemetry write failed; retry next scan",
      );
    }
  })();
}

const IMPULSE_SHADOW_WINDOW_MS = 30 * 60_000;
const _impulseShadowPending = new Map<string, number>();
function recordImpulseBuyShadowCandidate(input: {
  symbol: string;
  priceAtLog: number;
  price24h: number;
  price3h: number;
  price1h: number | null;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  volMult: number;
  spotVolMult: number | null;
  futTakerNetBuyPct: number | null;
  fundingRate: number | null;
  liqLong1h: number | null;
  liqLong24h: number | null;
  liqRatio: number | null;
  liqRatioAbove015Shadow: boolean;
  liqCacheStale: boolean | null;
  liqCacheAgeMs: number | null;
  cvd30m: boolean | null;
  cvd1h: boolean | null;
  candleBodyPct: number;
  candleVolumeMult: number;
  candleCloseStrength: number;
  candleClosedAt: Date;
  score: number;
  components: ImpulseBuyDecision["components"];
  observedAt: Date;
}): void {
  const bucket = Math.floor(
    input.observedAt.getTime() / IMPULSE_SHADOW_WINDOW_MS,
  );
  const source = `impulse_buy:shadow:${input.symbol}:${bucket}`;
  if (_impulseShadowPending.has(source)) return;
  _impulseShadowPending.set(source, Date.now());
  const metricsJson = JSON.stringify({
    price24h: input.price24h,
    price3h: input.price3h,
    price1h: input.price1h,
    oi30m: input.oi30m,
    oi1h: input.oi1h,
    oi4h: input.oi4h,
    volMult: input.volMult,
    spotVolMult: input.spotVolMult,
    futTakerNetBuyPct: input.futTakerNetBuyPct,
    fundingRate: input.fundingRate,
    liqLong1h: input.liqLong1h,
    liqLong24h: input.liqLong24h,
    liqRatio: input.liqRatio,
    liqRatioAbove015Shadow: input.liqRatioAbove015Shadow,
    liqCacheStale: input.liqCacheStale,
    liqCacheAgeMs: input.liqCacheAgeMs,
    cvd30m: input.cvd30m,
    cvd1h: input.cvd1h,
    candleBodyPct: input.candleBodyPct,
    candleVolumeMult: input.candleVolumeMult,
    candleCloseStrength: input.candleCloseStrength,
    candleClosedAt: input.candleClosedAt.toISOString(),
    score: input.score,
    components: input.components,
  });
  void (async () => {
    const written = await dbWriteBestEffort(
      "impulseBuy/shadow-candidate",
      () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${source}))`,
          );
          await tx.execute(sql`
            INSERT INTO missed_signals_log (
              symbol, source, reason, pattern, price_at_log,
              price_24h_pct, oi_30m_pct, oi_1h_pct, oi_4h_pct,
              vol_mult, spot_vol_mult, logged_at,
              decision_score, decision_metrics_json
            )
            SELECT
              ${input.symbol}, ${source},
              ${
                input.liqRatioAbove015Shadow
                  ? "liq_ratio_above_0_15_shadow"
                  : "baseline_pass_shadow"
              },
              'impulse_buy', ${input.priceAtLog}, ${input.price24h},
              ${input.oi30m}, ${input.oi1h}, ${input.oi4h},
              ${input.volMult}, ${input.spotVolMult}, ${input.observedAt},
              ${input.score}, ${metricsJson}::jsonb
            WHERE NOT EXISTS (
              SELECT 1 FROM missed_signals_log WHERE source = ${source}
            )
          `);
        }),
      { perAttemptTimeoutMs: 5000, attempts: 2, retryDelayMs: 1000 },
    );
    if (written === null) _impulseShadowPending.delete(source);
  })();
}

const LIVE_PATTERNS_FOR_REJECT_GAPS = [
  "stealth_breakout",
  "impulse_buy",
  "neon_support_bounce",
  "liquidation_cascade",
] as const;

// Decision-event batches whose scan_reject_log rows are already committed but
// whose pattern_decision_snapshots write failed. Retried without re-inserting
// the scan_reject_log rows (a retry used to insert them a second time).
let _symRejDecisionRetry: Array<(typeof _symRejLog)[number]> = [];
// Single-flight: two overlapping calls used to copy the same _symRejLog rows.
let _symRejPersistChain: Promise<void> = Promise.resolve();

function persistSymRejectLog(): Promise<void> {
  const run = _symRejPersistChain.then(
    () => persistSymRejectLogOnce(),
    () => persistSymRejectLogOnce(),
  );
  _symRejPersistChain = run.catch(() => undefined);
  return run;
}

async function persistSymRejectLogOnce(): Promise<void> {
  assertMarketCycleLeaseOwnership("scan reject-log insert");
  if (_symRejLog.length === 0 && _symRejDecisionRetry.length === 0) return;
  const rows = [..._symRejLog]; // copy first — splice right after the insert commits
  let rowsInserted = false;
  const decisionRows = [..._symRejDecisionRetry, ...rows];
  try {
    // The application pool has server/client query limits. Waiting for this
    // insert to settle is safe and avoids an orphan query after the caller has
    // moved on to a new scanner cycle.
    // Visible gaps: every scanned symbol must show a decision for every live
    // pattern. When a pattern left no reason (and the symbol was not stopped by
    // an early gate that explains why no pattern ran), write an explicit marker
    // instead of silence. Markers go only to scan_reject_log, never to the
    // permanent decision-event store, so gaps can be found and closed.
    const gapRows: Array<(typeof rows)[number]> = [];
    {
      const bySymbol = new Map<
        string,
        { patterns: Set<string>; first: (typeof rows)[number] }
      >();
      for (const row of rows) {
        const key = `${row.cycleAt.getTime()}\u0000${row.symbol}`;
        const entry = bySymbol.get(key);
        if (entry) entry.patterns.add(row.pattern);
        else
          bySymbol.set(key, { patterns: new Set([row.pattern]), first: row });
      }
      for (const { patterns, first } of bySymbol.values()) {
        if (patterns.has("gate")) continue;
        for (const pattern of LIVE_PATTERNS_FOR_REJECT_GAPS) {
          if (patterns.has(pattern)) continue;
          gapRows.push({
            cycleAt: first.cycleAt,
            symbol: first.symbol,
            pattern,
            reason:
              pattern === "liquidation_cascade"
                ? describeLcStateForScan(first.symbol)
                : "decision_reason_not_recorded",
            oi30m: first.oi30m,
            volMult: first.volMult,
            price24h: first.price24h,
            prescanCycles: first.prescanCycles,
            decisionKind: "rejected",
            decisionEntryPrice: null,
            zoneBottom: null,
            zoneTop: null,
          });
        }
      }
    }
    if (rows.length > 0) {
      await db
        .insert(scanRejectLogTable)
        .values(
          [...rows, ...gapRows].map(
            ({ decisionEntryPrice: _decisionEntryPrice, ...row }) => row,
          ),
        );
      // Committed: these rows must never be inserted again.
      _symRejLog.splice(0, rows.length);
      rowsInserted = true;
    }
    const decisionsWritten = await recordPatternDecisionEventsBatch(
      decisionRows.map((row) => ({
        eventKey: scannerRejectedDecisionEventKey(
          row.cycleAt,
          row.pattern,
          row.symbol,
          row.reason,
          row.decisionKind,
        ),
        symbol: row.symbol,
        patternKey: row.pattern,
        decisionKind: row.decisionKind,
        reason: row.reason,
        decisionAt: row.cycleAt,
        entryPrice: row.decisionEntryPrice,
        metrics: {
          oi30m: row.oi30m,
          volMult: row.volMult,
          price24h: row.price24h,
          prescanCycles: row.prescanCycles,
          ...(row.decisionMetrics ?? {}),
        },
        provenance: {
          record: "scanner",
          capture: "sym_reject_batch",
          cycle_at: row.cycleAt.toISOString(),
          entry_price:
            row.decisionEntryPrice !== null
              ? "scanner_current_30m_kline_close"
              : "not_recorded",
        },
        completeness: {
          missing_semantics:
            "null_or_absent_means_not_recorded_not_reconstructed",
          oi30m: row.oi30m !== null,
          volMult: row.volMult !== null,
          price24h: row.price24h !== null,
          entryPrice: row.decisionEntryPrice !== null,
          prescanCycles: row.prescanCycles !== null,
          decisionMetricsCaptured: row.decisionMetrics !== undefined,
        },
        source: "scanner_sym_reject",
      })),
    );
    if (!decisionsWritten) {
      throw new Error("pattern decision batch persistence failed");
    }
    _symRejDecisionRetry = [];
    // Cleanup: keep last 3 days to prevent unbounded growth
    void dbWriteBestEffort(
      "ScanRejectLog: cleanup",
      () =>
        db
          .delete(scanRejectLogTable)
          .where(
            lt(
              scanRejectLogTable.cycleAt,
              new Date(Date.now() - 3 * 24 * 3600_000),
            ),
          ),
      { attempts: 1 },
    );
  } catch (err) {
    if (rowsInserted) {
      // Only the decision-event batch failed; retry it alone next flush.
      _symRejDecisionRetry = decisionRows.slice(-30_000);
    }
    if (err instanceof SchedulerLeaseLostError) throw err;
    logger.warn(
      { err, count: rows.length, rowsInserted },
      "ScanRejectLog: write failed, keeping for next cycle",
    );
    if (_symRejLog.length > 30_000)
      _symRejLog.splice(0, _symRejLog.length - 15_000);
  }
}

// ── Persist pattern-debug snapshot before reset ────────────────────────────────
// lastPatternDebug раньше жил только в памяти и обнулялся каждый performScan()
// (~10 мин) — недельная статистика по отклонениям паттернов терялась. Пишем
// снапшот текущего цикла в pattern_debug_log перед сбросом (по аналогии с
// missed_signals_log). Best-effort: сбой записи не должен ломать цикл скана.
async function persistPatternDebugSnapshot(cycleNumber: number): Promise<void> {
  const entries = Object.entries(lastPatternDebug);
  if (entries.length === 0) return;
  const rows = entries.map(([pattern, e]) => ({
    pattern,
    cycleNumber,
    checked: e.checked,
    passed: e.passed,
    rejectedAt: JSON.stringify(e.rejectedAt),
  }));
  // dbWriteBestEffort: 8с таймаут + 2 попытки — защищает от silent hang.
  // Голый await db.insert() без таймаута зависает когда Neon pool под нагрузкой
  // в конце скана: try/catch никогда не срабатывает, данные теряются молча.
  await dbWriteBestEffort(
    "persistPatternDebugSnapshot",
    () =>
      db.transaction(async (tx) => {
        // pattern_debug_log predates a unique aggregate-row constraint. Keep
        // retries and two scanner owners idempotent with one transaction-scoped
        // advisory lock and a guarded insert for (pattern, cycle, symbol=NULL).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`pattern_debug_snapshot:${cycleNumber}`}))`,
        );
        for (const row of rows) {
          await tx.execute(sql`
            INSERT INTO pattern_debug_log
              (pattern, cycle_number, checked, passed, rejected_at)
            SELECT
              ${row.pattern}, ${row.cycleNumber}, ${row.checked},
              ${row.passed}, ${row.rejectedAt}
            WHERE NOT EXISTS (
              SELECT 1
                FROM pattern_debug_log
               WHERE pattern = ${row.pattern}
                 AND cycle_number = ${row.cycleNumber}
                 AND symbol IS NULL
            )
          `);
        }
      }),
    { perAttemptTimeoutMs: 8000, attempts: 2, retryDelayMs: 1000 },
  );
}

const PATTERN_DEBUG_CYCLE_SEQUENCE = "pattern_debug_cycle_number_seq";
const PATTERN_DEBUG_CYCLE_SEQUENCE_LOCK =
  "pattern_debug_cycle_number_sequence_schema";

/**
 * Allocate the durable identity before a real scan starts. The sequence is
 * initialized only while it is absent; an existing sequence is never reset,
 * because another worker may already own an allocated-but-not-yet-persisted
 * value.
 */
async function allocatePatternDebugCycleNumber(): Promise<number> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${PATTERN_DEBUG_CYCLE_SEQUENCE_LOCK}))`,
    );
    const sequence = await tx.execute(
      sql`SELECT to_regclass(${"public." + PATTERN_DEBUG_CYCLE_SEQUENCE}) AS relation`,
    );
    const relation = (sequence.rows[0] as { relation?: unknown } | undefined)
      ?.relation;
    if (relation == null) {
      await tx.execute(sql`CREATE SEQUENCE pattern_debug_cycle_number_seq`);
      const maxCycleResult = await tx.execute(
        sql`SELECT MAX(cycle_number)::bigint AS max_cycle FROM pattern_debug_log`,
      );
      const maxCycle = (
        maxCycleResult.rows[0] as { max_cycle?: unknown } | undefined
      )?.max_cycle;
      if (maxCycle == null) {
        await tx.execute(
          sql`SELECT setval('public.pattern_debug_cycle_number_seq', 1, false)`,
        );
      } else {
        await tx.execute(
          sql`SELECT setval('public.pattern_debug_cycle_number_seq', ${maxCycle}, true)`,
        );
      }
    }
    const next = await tx.execute(
      sql`SELECT nextval('public.pattern_debug_cycle_number_seq') AS cycle_number`,
    );
    return (next.rows[0] as { cycle_number?: unknown } | undefined)
      ?.cycle_number;
  });
  const cycleNumber = Number(result);
  if (!Number.isSafeInteger(cycleNumber) || cycleNumber < 1) {
    throw new Error(
      `Invalid durable Pattern Debug cycle number: ${String(result)}`,
    );
  }
  return cycleNumber;
}

// ── In-memory OI Watch confirming fallback ────────────────────────────────────
// Используется когда DB INSERT для confirming-записей падает из-за connection timeout.
// Зеркалирует поля oi_watch таблицы необходимые для логики окна подтверждения.
// TTL: 90 минут — записи старше удаляются при каждом скане.
interface ConfirmingWatchEntry {
  symbol: string;
  triggerTf: string;
  oiChange: number;
  priceAtEntry: number;
  volumeMultiplier: number;
  sentimentKey: string | null;
  addedAt: Date;
  expiresAt: Date;
  avgVolume: number;
  oi30mChange: number | null;
  oi1hChange: number | null;
  oi24hChange: number | null;
}
const confirmingWatchMap = new Map<string, ConfirmingWatchEntry>();
const CONFIRMING_WATCH_TTL_MS = 90 * 60 * 1000; // 90 минут
// Volume Breakout Spot: независимый кулдаун (не связан с VB Futures lastFiredAt)
const _vbSpotLastFiredAt = new Map<string, number>();

// Последняя известная цена для OI Watch символов — обновляется в confirming-цикле.
// Используется в getStatusSnapshot() как фолбэк когда символ выпал из prescanTracker.
// Только display: не влияет ни на какие gate-условия.
const oiWatchPriceCache = new Map<string, number>();

// market_cap_cache DB кэш (module-level, 5 мин TTL).
// Используется в getScannerCandidates как fallback для mcapUsd когда spotPool не заполнен.
// Не влияет ни на какие gate-условия — только для display Спот/MCap%.
let _mcapDbCache: Map<string, number | null> = new Map();
let _mcapDbCacheAt = 0;
const MCAP_DB_CACHE_TTL_MS = 5 * 60_000;
/**
 * Определяет volStatusReason для OI Watch по данным спот CVD.
 * Значения: "confirmed" | "cvd_unavail" | "cvd_negative"
 */
function cgVolStatusReason(
  spotCvd: {
    available: boolean;
    cvd1h: boolean | null;
    cvd4h: boolean | null;
  } | null,
): string {
  if (!spotCvd?.available) return "cvd_unavail";
  if (spotCvd.cvd1h === false || spotCvd.cvd4h === false) return "cvd_negative";
  return "confirmed";
}
/**
 * OI baseline — time-based.
 * Activity-score approach: the same "hot" tokens are scanned every 10 min,
 * so we can build baselines quickly and measure OI delta over ~20-60 min.
 */
interface OIBaseline {
  oi: number;
  takenAt: number;
}
const oiBaseline = new Map<string, OIBaseline>();
const MAX_BASELINE_AGE_MS = 60 * 60 * 1000; // baseline older than 60 min is too stale

/** Fetch fresh market price for a symbol at the moment of oiWatchTable insert.
 *  Prevents stale priceAtEntry caused by long scan loops (10-15 min lag). */
async function getFreshPrice(
  symbol: string,
  fallback: number,
): Promise<number> {
  try {
    const ticker = await getFutureTicker(symbol);
    if (ticker) {
      const p = parseFloat((ticker as any).lastPrice);
      if (p > 0) return p;
    }
  } catch {
    /* non-critical */
  }
  return fallback;
}

/** Load OI baselines from DB on startup so restarts don't cause blind spots */
async function loadBaselinesFromDb(): Promise<void> {
  try {
    const rows = await db.select().from(oiBaselinesTable);
    const cutoff = Date.now() - MAX_BASELINE_AGE_MS;
    let loaded = 0;
    for (const row of rows) {
      const takenAt = row.takenAt.getTime();
      if (takenAt >= cutoff) {
        oiBaseline.set(row.symbol, { oi: row.oi, takenAt });
        loaded++;
      }
    }
    logger.info({ loaded, total: rows.length }, "OI baselines loaded from DB");
  } catch (err) {
    logger.warn(
      { err },
      "Failed to load OI baselines from DB — starting fresh",
    );
  }
}

let _lastBaselinePersist = 0;
const BASELINE_PERSIST_INTERVAL_MS = 5 * 60 * 1000; // persist to DB every 5 min

/** Persist changed baselines to DB (called after each scan) */
async function persistBaselinesToDb(): Promise<void> {
  const now = Date.now();
  if (now - _lastBaselinePersist < BASELINE_PERSIST_INTERVAL_MS) return;
  _lastBaselinePersist = now;
  const values = [...oiBaseline.entries()].map(([symbol, b]) => ({
    symbol,
    oi: b.oi,
    takenAt: new Date(b.takenAt),
  }));
  if (values.length === 0) return;
  // dbWriteBestEffort: Promise.race с таймаутом 8с — защищает от зависания
  // Neon на выполнении INSERT (connectionTimeoutMillis защищает только acquire,
  // но не выполнение запроса), что ранее убивало loop скана на часы.
  await dbWriteBestEffort(
    "persistBaselinesToDb",
    () =>
      db
        .insert(oiBaselinesTable)
        .values(values)
        .onConflictDoUpdate({
          target: oiBaselinesTable.symbol,
          set: { oi: sql`excluded.oi`, takenAt: sql`excluded.taken_at` },
        }),
    { perAttemptTimeoutMs: 8000, attempts: 1 },
  );
}

// ── Prescan Tracker persistence ───────────────────────────────────────────────

/** On startup: restore prescan entries from DB so cycleCount survives rebuilds.
 *  Entries older than 24h are ignored (stale, token likely cooled down).
 *  Retries once after a 12s delay if the first attempt throws (Neon pool timeout
 *  at startup permanently leaves the tracker empty otherwise). */
async function loadPrescanFromDb(): Promise<void> {
  async function attempt(): Promise<void> {
    const read = await dbReadWithRetry(
      "Prescan tracker startup load",
      () =>
        db
          .select()
          .from(prescanTrackerTable)
          .orderBy(desc(prescanTrackerTable.updatedAt))
          .limit(1_000),
      1,
      0,
      5_000,
    );
    if (!read.ok) {
      throw new Error("Prescan tracker startup load timed out");
    }
    const rows = read.value;
    const cutoff = Date.now() - 72 * 60 * 60 * 1000; // 72h cutoff
    let loaded = 0;
    for (const row of rows) {
      const updatedAt = row.updatedAt.getTime();
      if (updatedAt < cutoff) continue; // skip stale entries
      prescanTracker.set(row.symbol, {
        firstPrice24h: row.firstPrice24h,
        lastPrice24h: row.lastPrice24h ?? row.firstPrice24h, // DB-персистированное значение; фолбэк на first при холодном старте
        firstSeenAt: row.firstSeenAt,
        firstPrice: row.firstPrice,
        cycleCount: row.cycleCount,
        bestRank: row.bestRank,
        lastScore: row.firstScore,
        firstScore: row.firstScore,
        lastPrice: row.lastPrice ?? row.firstPrice,
        lastFiredAt: row.lastFiredAt,
        lastOi30m: row.lastOi30m ?? undefined,
        lastOi1h: row.lastOi1h ?? undefined,
        lastOi4h: row.lastOi4h ?? undefined,
        lastOi24h: row.lastOi24h ?? undefined,
        lastPrice1h: row.lastPrice1h ?? undefined,
        prevOi30m: row.prevOi30m ?? undefined,
        prevOi4h: row.prevOi4h ?? undefined,
        cvdPositiveCycles: row.cvdPositiveCycles ?? undefined,
        takerPositiveCycles: row.takerPositiveCycles ?? undefined,
        oiAccel30m: row.oiAccel30m ?? undefined,
        oi4hConsecGrowth: row.oi4hConsecGrowth ?? undefined,
        spotVolCycles: row.spotVolCycles ?? undefined,
        lastSpotVol1h: row.lastSpotVol1h ?? undefined,
        prevSpotVol1h: row.prevSpotVol1h ?? undefined,
        lastSpotVol4h: row.lastSpotVol4h ?? undefined,
        lastSpotNetBuy1h: row.lastSpotNetBuy1h ?? undefined,
        spotVolAvg1h: row.spotVolAvg1h ?? undefined,
        layers: row.layers ?? [],
        futVolUsd24h: row.futVolUsd24h ?? undefined,
        spotVolUsd24h: row.spotVolUsd24h ?? undefined,
        futSpotRatio: row.futSpotRatio ?? undefined,
        futVolPctMcap: row.futVolPctMcap ?? undefined,
        spotVolPctMcap: row.spotVolPctMcap ?? undefined,
        firstOi30m: row.firstOi30m ?? undefined,
        firstOi1h: row.firstOi1h ?? undefined,
        firstOi4h: row.firstOi4h ?? undefined,
        firstObRatio: row.firstObRatio ?? undefined,
        firstFundingRate: row.firstFundingRate ?? undefined,
        firstWhaleIndex: row.firstWhaleIndex ?? undefined,
        firstSnf1h: row.firstSnf1h ?? undefined,
        lastWhaleIndex: row.lastWhaleIndex ?? undefined,
        lastNetBuyPct: row.lastNetBuyPct ?? undefined,
        lastSpotTakerNetBuy: row.lastSpotTakerNetBuy ?? undefined,
        lastSpotTakerDominance:
          (row.lastSpotTakerDominance as
            | "buy"
            | "sell"
            | "neutral"
            | undefined) ?? undefined,
        lastCvd15m: row.lastCvd15m ?? undefined,
        lastCvd30m: row.lastCvd30m ?? undefined,
        lastCvd1h: row.lastCvd1h ?? undefined,
        lastCvd4h: row.lastCvd4h ?? undefined,
        lastVolMult: row.lastVolMult ?? undefined,
        hasFiredBefore: row.hasFiredBefore ?? false,
      });
      loaded++;
    }
    logger.info(
      { loaded, total: rows.length },
      "Prescan tracker loaded from DB",
    );
  }

  try {
    await attempt();
  } catch (firstErr) {
    logger.warn(
      { err: firstErr },
      "Failed to load prescan tracker from DB — retrying in 12s",
    );
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    try {
      await attempt();
    } catch (secondErr) {
      logger.warn(
        { err: secondErr },
        "Failed to load prescan tracker from DB after retry — starting fresh",
      );
    }
  }
}

/** Split-brain fix (autoscale deployment can run 1-N concurrent instances,
 *  each with its own in-memory prescanTracker Map — loadPrescanFromDb() only
 *  runs once at startup, so an instance that never personally fetched spot
 *  volume for a symbol keeps spotVolMult=null forever even though another
 *  instance's fetch is already sitting in the DB).
 *  Runs frequently (every 5 min) and adopts DB state ONLY when it's strictly
 *  ahead of what this instance has observed itself (dbCycles > localCycles) —
 *  never clobbers data this instance already fetched more recently. */
async function refreshSpotVolFromDb(): Promise<void> {
  const symbols = Array.from(prescanTracker.keys());
  if (symbols.length === 0) return;
  try {
    const read = await dbReadWithRetry(
      "Prescan tracker SpotVol resync",
      () =>
        db
          .select({
            symbol: prescanTrackerTable.symbol,
            spotVolCycles: prescanTrackerTable.spotVolCycles,
            spotVolAvg1h: prescanTrackerTable.spotVolAvg1h,
            lastSpotVol1h: prescanTrackerTable.lastSpotVol1h,
            prevSpotVol1h: prescanTrackerTable.prevSpotVol1h,
            lastSpotVol4h: prescanTrackerTable.lastSpotVol4h,
            lastSpotNetBuy1h: prescanTrackerTable.lastSpotNetBuy1h,
            futVolUsd24h: prescanTrackerTable.futVolUsd24h,
            spotVolUsd24h: prescanTrackerTable.spotVolUsd24h,
            futSpotRatio: prescanTrackerTable.futSpotRatio,
            futVolPctMcap: prescanTrackerTable.futVolPctMcap,
            spotVolPctMcap: prescanTrackerTable.spotVolPctMcap,
          })
          .from(prescanTrackerTable)
          .where(inArray(prescanTrackerTable.symbol, symbols)),
      1,
      0,
      5_000,
    );
    if (!read.ok) {
      logger.warn(
        { symbols: symbols.length },
        "SpotVol DB resync skipped after bounded prescan read timeout",
      );
      return;
    }
    const rows = read.value;
    let adopted = 0;
    for (const row of rows) {
      const pe = prescanTracker.get(row.symbol);
      if (!pe) continue;
      const dbCycles = row.spotVolCycles ?? 0;
      const localCycles = pe.spotVolCycles ?? 0;
      if (
        dbCycles > localCycles &&
        row.spotVolAvg1h != null &&
        row.lastSpotVol1h != null
      ) {
        pe.spotVolCycles = dbCycles;
        pe.spotVolAvg1h = row.spotVolAvg1h;
        pe.lastSpotVol1h = row.lastSpotVol1h ?? pe.lastSpotVol1h;
        pe.prevSpotVol1h = row.prevSpotVol1h ?? pe.prevSpotVol1h;
        pe.lastSpotVol4h = row.lastSpotVol4h ?? pe.lastSpotVol4h;
        pe.lastSpotNetBuy1h = row.lastSpotNetBuy1h ?? pe.lastSpotNetBuy1h;
        adopted++;
      }
      // FS volume fields: always adopt latest non-null values regardless of cycleCount
      if (row.futVolUsd24h != null) pe.futVolUsd24h = row.futVolUsd24h;
      if (row.spotVolUsd24h != null) pe.spotVolUsd24h = row.spotVolUsd24h;
      if (row.futSpotRatio != null) pe.futSpotRatio = row.futSpotRatio;
      if (row.futVolPctMcap != null) pe.futVolPctMcap = row.futVolPctMcap;
      if (row.spotVolPctMcap != null) pe.spotVolPctMcap = row.spotVolPctMcap;
    }
    if (adopted > 0) {
      logger.info(
        { adopted, checked: symbols.length },
        "SpotVol DB resync: adopted fresher state from another instance",
      );
    }
  } catch (err) {
    logger.warn({ err }, "SpotVol DB resync failed");
  }
}

/** Capture prescan snapshot rows synchronously from the current prescanTracker
 *  state and enqueue them for deferred DB write via _telemetryQueue.
 *
 *  Rows are captured right now (prescanTracker is live and accurate) and handed
 *  to the single-flight telemetry writer.  The writer applies a single
 *  TELEMETRY_POOL_DELAY_MS recovery wait before its first write so the Neon
 *  pool has time to recover from the scan — equivalent to the previous 8-min
 *  inline delay, but shared across all queued items instead of repeating per
 *  item. The captured batch is persisted to the durable outbox before this
 *  function resolves. Returns the number of rows accepted by that outbox. */
async function enqueuePrescanSnapshots(): Promise<number> {
  try {
    const now = new Date();
    const entries = Array.from(prescanTracker.entries());
    if (entries.length === 0) return 0;
    // Capture data synchronously — prescanTracker will be mutated by next cycle
    const rows: InsertPrescanSnapshot[] = entries.map(([symbol, pe]) => ({
      symbol,
      cycleAt: now,
      p24h: pe.lastPrice24h ?? null,
      p1h: pe.lastPrice1h ?? null,
      price: pe.lastPrice || null,
      oi30m: pe.lastOi30m ?? null,
      oi1h: pe.lastOi1h ?? null,
      oi4h: pe.lastOi4h ?? null,
      volMult: pe.lastVolMult ?? null,
      spotVolUsd24h: pe.spotVolUsd24h ?? null,
      futSpotRatio: pe.futSpotRatio ?? null,
      whaleIndex: pe.lastWhaleIndex ?? null,
      snf1h:
        getSpotNetflowEntry(symbol)?.netPct1h ?? pe.lastSpotNetBuy1h ?? null,
      fundingRate: _latestFrMap.get(symbol) ?? pe.firstFundingRate ?? null,
      obRatio: pe.lastObRatio ?? pe.firstObRatio ?? null,
      cvd30m: pe.lastCvd30m ?? null,
      cvd1h: pe.lastCvd1h ?? null,
      cvd4h: pe.lastCvd4h ?? null,
      cyclesInPool: pe.cycleCount,
    }));
    await _telemetryQueue.enqueue({
      dedupKey: `snapshots:${now.toISOString()}`,
      kind: "snapshots",
      rows,
    });
    return rows.length;
  } catch (err) {
    logger.warn(
      { err },
      "enqueuePrescanSnapshots: capture or durable outbox insert failed",
    );
    return 0;
  }
}

/** Persist current prescan tracker state to DB (upsert all active entries).
 *  Splits into batches of 15 rows to avoid Neon connection timeout on large INSERTs. */
/** cycleCount at which each symbol was last written to DB — skips unchanged rows */
const _prescanWrittenCycles = new Map<string, number>();

async function savePrescanToDb(): Promise<void> {
  assertMarketCycleLeaseOwnership("prescan tracker persistence");
  try {
    const allEntries = Array.from(prescanTracker.entries());
    if (allEntries.length === 0) return;

    // Only UPSERT entries whose cycleCount advanced since last DB write.
    // Tokens not processed this cycle have unchanged cycleCount → skip.
    const entries = allEntries.filter(
      ([sym, e]) =>
        (e.cycleCount ?? 0) > (_prescanWrittenCycles.get(sym) ?? -1),
    );

    const skipped = allEntries.length - entries.length;
    if (skipped > 0) {
      logger.debug(
        { skipped, dirty: entries.length, total: allEntries.length },
        "savePrescanToDb: skipping unchanged rows",
      );
    }

    if (entries.length > 0) {
      const now = new Date();
      // Lazy-init firstSnf1h: set once from the live SNF cache (same source as snf1h in logs).
      // Runs every savePrescanToDb until each entry gets a non-null SNF value.
      for (const [sym, e] of entries) {
        if (e.firstSnf1h == null) {
          const _firstSnf = getSpotNetflowEntry(sym);
          if (_firstSnf?.netPct1h != null) e.firstSnf1h = _firstSnf.netPct1h;
        }
      }
      const values = entries.map(([symbol, e]) => ({
        symbol,
        cycleCount: e.cycleCount,
        firstSeenAt: e.firstSeenAt,
        bestRank: e.bestRank,
        firstPrice: e.firstPrice,
        firstPrice24h: e.firstPrice24h,
        firstScore: e.firstScore,
        lastFiredAt: e.lastFiredAt,
        updatedAt: now,
        lastPrice: e.lastPrice,
        lastOi30m: e.lastOi30m ?? null,
        lastOi1h: e.lastOi1h ?? null,
        lastOi4h: e.lastOi4h ?? null,
        lastOi24h: e.lastOi24h ?? null,
        lastPrice1h: e.lastPrice1h ?? null,
        prevOi30m: e.prevOi30m ?? null,
        prevOi4h: e.prevOi4h ?? null,
        cvdPositiveCycles: e.cvdPositiveCycles ?? null,
        takerPositiveCycles: e.takerPositiveCycles ?? null,
        oiAccel30m: e.oiAccel30m ?? null,
        oi4hConsecGrowth: e.oi4hConsecGrowth ?? null,
        lastSpotVol1h: e.lastSpotVol1h ?? null,
        prevSpotVol1h: e.prevSpotVol1h ?? null,
        lastSpotVol4h: e.lastSpotVol4h ?? null,
        lastSpotNetBuy1h: e.lastSpotNetBuy1h ?? null,
        spotVolAvg1h: e.spotVolAvg1h ?? null,
        spotVolCycles: e.spotVolCycles ?? 0,
        layers: e.layers ?? [],
        futVolUsd24h: e.futVolUsd24h ?? null,
        spotVolUsd24h: e.spotVolUsd24h ?? null,
        futSpotRatio: e.futSpotRatio ?? null,
        futVolPctMcap: e.futVolPctMcap ?? null,
        spotVolPctMcap: e.spotVolPctMcap ?? null,
        // first_oi_* — передаём текущие значения; COALESCE в conflict SET сохранит только первые
        firstOi30m: e.lastOi30m ?? null,
        firstOi1h: e.lastOi1h ?? null,
        firstOi4h: e.lastOi4h ?? null,
        // first_* — устанавливаются при входе; COALESCE не перезапишет
        firstObRatio: e.firstObRatio ?? null,
        firstFundingRate: e.firstFundingRate ?? null,
        firstWhaleIndex: e.firstWhaleIndex ?? null,
        firstSnf1h: e.firstSnf1h ?? null,
        lastWhaleIndex: e.lastWhaleIndex ?? null,
        lastPrice24h: e.lastPrice24h,
        lastNetBuyPct: e.lastNetBuyPct ?? null,
        lastSpotTakerNetBuy: e.lastSpotTakerNetBuy ?? null,
        lastSpotTakerDominance: e.lastSpotTakerDominance ?? null,
        lastCvd15m: e.lastCvd15m ?? null,
        lastCvd30m: e.lastCvd30m ?? null,
        lastCvd1h: e.lastCvd1h ?? null,
        lastCvd4h: e.lastCvd4h ?? null,
        lastVolMult: e.lastVolMult ?? null,
        hasFiredBefore: e.hasFiredBefore ?? false,
      }));

      const BATCH_SIZE = 15;
      for (let i = 0; i < values.length; i += BATCH_SIZE) {
        assertMarketCycleLeaseOwnership("prescan tracker upsert");
        const batch = values.slice(i, i + BATCH_SIZE);
        await dbWriteBestEffort("prescanTracker/upsert-batch", () =>
          db
            .insert(prescanTrackerTable)
            .values(batch)
            .onConflictDoUpdate({
              target: prescanTrackerTable.symbol,
              set: {
                // GREATEST — защита от dual-process: worker после рестарта не обнуляет
                // счётчик другого процесса который уже накопил больший cycleCount.
                cycleCount: sql`GREATEST(${prescanTrackerTable.cycleCount}, excluded.cycle_count)`,
                bestRank: sql`excluded.best_rank`,
                lastFiredAt: sql`excluded.last_fired_at`,
                updatedAt: sql`excluded.updated_at`,
                lastPrice: sql`excluded.last_price`,
                lastOi30m: sql`excluded.last_oi_30m`,
                lastOi1h: sql`excluded.last_oi_1h`,
                lastOi4h: sql`excluded.last_oi_4h`,
                lastOi24h: sql`excluded.last_oi_24h`,
                lastPrice1h: sql`excluded.last_price_1h`,
                prevOi30m: sql`excluded.prev_oi_30m`,
                prevOi4h: sql`excluded.prev_oi_4h`,
                cvdPositiveCycles: sql`excluded.cvd_positive_cycles`,
                takerPositiveCycles: sql`excluded.taker_positive_cycles`,
                oiAccel30m: sql`excluded.oi_accel_30m`,
                oi4hConsecGrowth: sql`excluded.oi_4h_consec_growth`,
                lastSpotVol1h: sql`COALESCE(excluded.last_spot_vol_1h, ${prescanTrackerTable.lastSpotVol1h})`,
                prevSpotVol1h: sql`COALESCE(excluded.prev_spot_vol_1h, ${prescanTrackerTable.prevSpotVol1h})`,
                lastSpotVol4h: sql`COALESCE(excluded.last_spot_vol_4h, ${prescanTrackerTable.lastSpotVol4h})`,
                lastSpotNetBuy1h: sql`COALESCE(excluded.last_spot_net_buy_1h, ${prescanTrackerTable.lastSpotNetBuy1h})`,
                spotVolAvg1h: sql`COALESCE(excluded.spot_vol_avg_1h, ${prescanTrackerTable.spotVolAvg1h})`,
                spotVolCycles: sql`GREATEST(${prescanTrackerTable.spotVolCycles}, excluded.spot_vol_cycles)`,
                layers: sql`excluded.layers`,
                futVolUsd24h: sql`COALESCE(excluded.fut_vol_usd_24h,  ${prescanTrackerTable.futVolUsd24h})`,
                spotVolUsd24h: sql`COALESCE(excluded.spot_vol_usd_24h, ${prescanTrackerTable.spotVolUsd24h})`,
                futSpotRatio: sql`COALESCE(excluded.fut_spot_ratio,   ${prescanTrackerTable.futSpotRatio})`,
                futVolPctMcap: sql`excluded.fut_vol_pct_mcap`,
                spotVolPctMcap: sql`excluded.spot_vol_pct_mcap`,
                // COALESCE: сохраняем первое значение — при повторных UPDATE не перезаписываем
                firstOi30m: sql`COALESCE(${prescanTrackerTable.firstOi30m}, excluded.first_oi_30m)`,
                firstOi1h: sql`COALESCE(${prescanTrackerTable.firstOi1h},  excluded.first_oi_1h)`,
                firstOi4h: sql`COALESCE(${prescanTrackerTable.firstOi4h},  excluded.first_oi_4h)`,
                firstObRatio: sql`COALESCE(${prescanTrackerTable.firstObRatio}, excluded.first_ob_ratio)`,
                firstFundingRate: sql`COALESCE(${prescanTrackerTable.firstFundingRate}, excluded.first_funding_rate)`,
                // COALESCE: сохраняем первое ненулевое значение (Whale Index / SNF1h ставятся лениво при первом батче)
                firstWhaleIndex: sql`COALESCE(${prescanTrackerTable.firstWhaleIndex}, excluded.first_whale_index)`,
                firstSnf1h: sql`COALESCE(${prescanTrackerTable.firstSnf1h}, excluded.first_snf_1h)`,
                // COALESCE: WI обновляется только раз в несколько циклов (батч) — сохраняем предыдущее значение если новое null
                lastWhaleIndex: sql`COALESCE(excluded.last_whale_index, ${prescanTrackerTable.lastWhaleIndex})`,
                // last_price_24h: сохраняем ненулевое значение — NULLIF защищает от перезаписи нулём
                lastPrice24h: sql`COALESCE(NULLIF(excluded.last_price_24h, 0), ${prescanTrackerTable.lastPrice24h}, excluded.last_price_24h)`,
                // Taker / CVD: COALESCE — если в этом цикле поле не обновлялось (null), сохраняем предыдущее DB-значение
                lastNetBuyPct: sql`COALESCE(excluded.last_net_buy_pct,          ${prescanTrackerTable.lastNetBuyPct})`,
                lastSpotTakerNetBuy: sql`COALESCE(excluded.last_spot_taker_net_buy,   ${prescanTrackerTable.lastSpotTakerNetBuy})`,
                lastSpotTakerDominance: sql`COALESCE(excluded.last_spot_taker_dominance, ${prescanTrackerTable.lastSpotTakerDominance})`,
                lastCvd15m: sql`COALESCE(excluded.last_cvd_15m, ${prescanTrackerTable.lastCvd15m})`,
                lastCvd30m: sql`COALESCE(excluded.last_cvd_30m, ${prescanTrackerTable.lastCvd30m})`,
                lastCvd1h: sql`COALESCE(excluded.last_cvd_1h,  ${prescanTrackerTable.lastCvd1h})`,
                lastCvd4h: sql`COALESCE(excluded.last_cvd_4h,  ${prescanTrackerTable.lastCvd4h})`,
                // lastVolMult: COALESCE — сохраняем последнее ненулевое значение (данные могут
                // временно пропадать при CG таймаутах). Персистируем чтобы liq_cascade и другие
                // фоновые паттерны могли читать entryFutVolMult через prescanE?.lastVolMult.
                lastVolMult: sql`COALESCE(excluded.last_vol_mult, ${prescanTrackerTable.lastVolMult})`,
                // has_fired_before: однажды true — навсегда true (OR)
                hasFiredBefore: sql`${prescanTrackerTable.hasFiredBefore} OR excluded.has_fired_before`,
              },
            }),
        );
      }

      // Mark written cycleCount so next call skips these unless they change again
      for (const [sym, e] of entries) {
        _prescanWrittenCycles.set(sym, e.cycleCount ?? 0);
      }

      logger.debug(
        {
          count: values.length,
          skipped,
          batches: Math.ceil(values.length / BATCH_SIZE),
        },
        "Prescan tracker saved to DB",
      );
    }

    // Cleanup uses ALL in-memory entries (not just dirty subset) to correctly
    // identify which DB rows are still active.
    const activeSymbols = allEntries.map(([s]) => s);

    // dbWriteBestEffort: защита от зависания при нагрузке на Neon pool
    assertMarketCycleLeaseOwnership("prescan tracker cleanup");
    await dbWriteBestEffort("prescanTracker/cleanup-delete", () =>
      db.delete(prescanTrackerTable).where(
        sql`symbol NOT IN (${sql.join(
          activeSymbols.map((s) => sql`${s}`),
          sql`, `,
        )}) AND updated_at < NOW() - INTERVAL '15 minutes'`,
      ),
    );
  } catch (err) {
    if (err instanceof SchedulerLeaseLostError) throw err;
    logger.warn({ err }, "Failed to save prescan tracker to DB");
  }
}

/** Batch-update Whale Index for high-priority tokens after each scan cycle.
 *  Fire-and-forget: updates prescanTracker in-memory; persisted on next savePrescanToDb().
 *  Targets: OI Watch active + top-30 prescan by score + active tracked signals (≤70 symbols).
 *  Uses getTokenWhaleIndex cache (10-min TTL) — no redundant CG calls within one cycle. */
async function batchUpdateWhaleIndex(): Promise<void> {
  try {
    const [oiWatchRows, activeSignalRows] = await Promise.all([
      db
        .select({ symbol: oiWatchTable.symbol })
        .from(oiWatchTable)
        .where(
          and(
            inArray(oiWatchTable.status, ["watching", "confirming"]),
            gt(oiWatchTable.expiresAt, new Date()),
          ),
        ),
      db
        .select({ symbol: trackedSignalsTable.symbol })
        .from(trackedSignalsTable)
        .where(inArray(trackedSignalsTable.status, ["active", "in_run"])),
    ]);
    const topPrescan = Array.from(prescanTracker.entries())
      .sort((a, b) => b[1].lastScore - a[1].lastScore)
      .slice(0, 30)
      .map(([sym]) => sym);
    const symbolSet = new Set([
      ...oiWatchRows.map((r) => r.symbol),
      ...activeSignalRows.map((r) => r.symbol),
      ...topPrescan,
    ]);
    const symbols = Array.from(symbolSet).slice(0, 70);
    if (symbols.length === 0) return;
    const activeSymbols = new Set(activeSignalRows.map((r) => r.symbol));
    const candidateSymbols = new Set(topPrescan);
    await runConcurrent(symbols, 3, async (symbol) => {
      const wi = await getTokenWhaleIndex(symbol, {
        priority: activeSymbols.has(symbol)
          ? "critical"
          : candidateSymbols.has(symbol)
            ? "high"
            : "low",
      });
      const pe = prescanTracker.get(symbol);
      if (pe && wi !== null) {
        pe.lastWhaleIndex = wi;
        if (pe.firstWhaleIndex == null) pe.firstWhaleIndex = wi; // lazy-init: первое ненулевое WI
      }
    });
    logger.debug({ count: symbols.length }, "batchUpdateWhaleIndex: completed");
  } catch (err) {
    logger.warn({ err }, "batchUpdateWhaleIndex failed");
  }
}

/** Fetch spot volume for all prescan tracker symbols and persist to DB.
 *  Runs as fire-and-forget after each scan AND on a 60-min periodic timer
 *  (first run 2 min after startup) so data appears without waiting for scan completion. */
let _spotVolBatchInFlight: Promise<void> | null = null;

async function runSpotVolBatchWork(): Promise<void> {
  const symbols = Array.from(prescanTracker.keys());
  if (symbols.length === 0) return;
  // Keep the background batch bounded. Each worker makes one spot-volume and
  // one FS-volume request in parallel, so at most four symbols (eight external
  // requests) are in flight instead of one request pair for every prescan row.
  const BATCH_CONCURRENCY = 4;
  let spotVolUpdated = 0;
  let spotVolNoData = 0;
  let fsVolUpdated = 0;
  await runConcurrent(symbols, BATCH_CONCURRENCY, async (sym) => {
    const pe = prescanTracker.get(sym);
    if (!pe) return;
    const [spotVolume, fsVolume] = await Promise.allSettled([
      getSpotVolume(sym),
      getFsVolume(sym),
    ]);

    // ── Pairs-markets: spot 1h/4h/netBuyPct + running average ──────────────
    if (spotVolume.status === "fulfilled" && spotVolume.value.available) {
      const sv = spotVolume.value;
      pe.prevSpotVol1h = pe.lastSpotVol1h ?? null;
      pe.lastSpotVol1h = sv.volumeUsd1h;
      pe.lastSpotVol4h = sv.volumeUsd4h;
      pe.lastSpotNetBuy1h = sv.netBuyPct1h;
      pe.spotVolCycles = (pe.spotVolCycles ?? 0) + 1;
      if (pe.spotVolAvg1h == null) {
        pe.spotVolAvg1h = sv.volumeUsd1h;
      } else {
        pe.spotVolAvg1h = (pe.spotVolAvg1h * 4 + (sv.volumeUsd1h ?? 0)) / 5;
      }
      spotVolUpdated++;
    } else {
      spotVolNoData++;
    }

    // ── FS volume ratio: absolute 24h futures + spot (Binance+OKX+Bybit) ───
    if (fsVolume.status === "fulfilled" && fsVolume.value.available) {
      const fv = fsVolume.value;
      pe.futVolUsd24h = fv.futVolUsd24h;
      pe.spotVolUsd24h = fv.spotVolUsd24h;
      pe.futSpotRatio = fv.futSpotRatio;
      // %mcap: use spotPool mcapUsd as fallback; null if not available
      const mcap = getSpotPoolEntry(sym)?.mcapUsd ?? null;
      pe.futVolPctMcap =
        fv.futVolUsd24h && mcap ? (fv.futVolUsd24h / mcap) * 100 : null;
      pe.spotVolPctMcap =
        fv.spotVolUsd24h && mcap ? (fv.spotVolUsd24h / mcap) * 100 : null;
      // Populate cgVolumeCache with futures volume (used for L2 ranking)
      if (fv.futVolUsd24h) {
        const base = sym.replace(/-?USDT$/i, "").replace(/-/g, "");
        cgVolumeCache.set(base, fv.futVolUsd24h);
      }
      fsVolUpdated++;
    }
  });
  logger.info(
    {
      symbols: symbols.length,
      concurrency: BATCH_CONCURRENCY,
      spotUpdated: spotVolUpdated,
      spotNoData: spotVolNoData,
      fsUpdated: fsVolUpdated,
    },
    "SpotVol+FsVol batch complete",
  );
  if (spotVolUpdated > 0 || fsVolUpdated > 0) {
    await saveSpotVolToDb().catch((e) =>
      logger.warn(
        { err: e },
        "SpotVol: saveSpotVolToDb failed after all retries",
      ),
    );
  }
}

function runSpotVolBatch(): Promise<void> {
  if (_spotVolBatchInFlight) {
    logger.debug("SpotVol+FsVol batch already running — joining existing work");
    return _spotVolBatchInFlight;
  }

  _spotVolBatchInFlight = runSpotVolBatchWork().finally(() => {
    _spotVolBatchInFlight = null;
  });
  return _spotVolBatchInFlight;
}

/** Lightweight spot-vol-only DB persist. Runs after the spot vol fire-and-forget batch.
 *  Only touches the 6 spot-vol fields, only for symbols that already have data.
 *  Uses targeted UPDATE per symbol (not a full INSERT upsert) to minimise Neon pool pressure.
 *  Retries up to 3× with backoff so Neon connection timeouts don't silently drop the data. */
async function saveSpotVolToDb(): Promise<void> {
  const entries = Array.from(prescanTracker.entries()).filter(
    ([, e]) => (e.spotVolCycles ?? 0) > 0 && e.lastSpotVol1h != null,
  );
  if (entries.length === 0) {
    logger.info("SpotVol DB save: no symbols with spot vol data");
    return;
  }
  const BATCH_SIZE = 20;
  const MAX_RETRIES = 3;
  let saved = 0;
  let failed = 0;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await Promise.all(
          batch.map(([symbol, e]) =>
            db
              .update(prescanTrackerTable)
              .set({
                lastSpotVol1h: e.lastSpotVol1h ?? null,
                prevSpotVol1h: e.prevSpotVol1h ?? null,
                lastSpotVol4h: e.lastSpotVol4h ?? null,
                lastSpotNetBuy1h: e.lastSpotNetBuy1h ?? null,
                spotVolAvg1h: e.spotVolAvg1h ?? null,
                spotVolCycles: sql`GREATEST(${prescanTrackerTable.spotVolCycles}, ${e.spotVolCycles ?? 1})`,
                ...(e.futVolUsd24h != null
                  ? { futVolUsd24h: e.futVolUsd24h }
                  : {}),
                ...(e.spotVolUsd24h != null
                  ? { spotVolUsd24h: e.spotVolUsd24h }
                  : {}),
                ...(e.futSpotRatio != null
                  ? { futSpotRatio: e.futSpotRatio }
                  : {}),
                ...(e.futVolPctMcap != null
                  ? { futVolPctMcap: e.futVolPctMcap }
                  : {}),
                ...(e.spotVolPctMcap != null
                  ? { spotVolPctMcap: e.spotVolPctMcap }
                  : {}),
              })
              .where(eq(prescanTrackerTable.symbol, symbol)),
          ),
        );
        saved += batch.length;
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES)
          await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    if (lastErr) {
      failed += batch.length;
      logger.warn(
        { err: lastErr, batchIdx: i / BATCH_SIZE + 1 },
        "SpotVol DB: batch failed after retries",
      );
    }
  }
  logger.info(
    { total: entries.length, saved, failed },
    "SpotVol DB save complete",
  );
  // Diagnostic: verify actual DB state after UPDATE
  try {
    const check = await db.execute(sql`
      SELECT COUNT(*) as not_null_count,
             MIN(spot_vol_avg_1h) as min_avg,
             MAX(spot_vol_avg_1h) as max_avg,
             (SELECT symbol || ':' || COALESCE(spot_vol_avg_1h::text, 'NULL') || '/' || spot_vol_cycles::text
              FROM prescan_tracker WHERE spot_vol_avg_1h IS NOT NULL LIMIT 1) as sample
      FROM prescan_tracker WHERE spot_vol_avg_1h IS NOT NULL`);
    logger.info(
      { dbCheck: check.rows[0] },
      "SpotVol DB verify: post-save check",
    );
    const symCheck = await db.execute(sql`
      SELECT symbol, spot_vol_avg_1h, spot_vol_cycles FROM prescan_tracker
      WHERE symbol = ${entries[0]?.[0] ?? "NONE"} LIMIT 1`);
    logger.info(
      { symCheck: symCheck.rows[0], firstSym: entries[0]?.[0] },
      "SpotVol DB verify: first symbol check",
    );
  } catch (e) {
    logger.warn({ err: e }, "SpotVol DB verify: check failed");
  }
}

/** Capture prescan history rows synchronously from the current prescanTracker
 *  state and enqueue them for deferred DB write via _telemetryQueue.
 *
 *  Rows are captured *right now* (prescanTracker is live and accurate), then
 *  handed off to the single-flight telemetry writer which applies one pool-
 *  recovery delay before writing.  This replaces the previous pattern where
 *  row capture happened *after* a 45s delay, meaning the next scan had already
 *  mutated prescanTracker and the rows were stale or missing.
 *
 *  Returns the number of rows accepted by the durable outbox (for logging). */
async function enqueuePrescanHistory(
  scored: Array<{ ticker: { symbol: string }; score: number }>,
): Promise<number> {
  try {
    const now = new Date();
    const rows = scored
      .map((s) => {
        const sym = s.ticker.symbol;
        const entry = prescanTracker.get(sym);
        if (!entry) return null;
        return {
          symbol: sym,
          ts: now,
          cycleCount: entry.cycleCount,
          rank: null as number | null,
          score: s.score,
          price24h: entry.lastPrice24h ?? null,
          price1h: entry.lastPrice1h ?? null,
          oi30m: entry.lastOi30m ?? null,
          oi1h: entry.lastOi1h ?? null,
          oi4h: entry.lastOi4h ?? null,
          oi24h: entry.lastOi24h ?? null,
          volMult: entry.lastVolMult ?? null,
          cvd30m: entry.lastCvd30m ?? null,
          cvd1h: entry.lastCvd1h ?? null,
          netBuyPct: entry.lastNetBuyPct ?? null,
          spotTakerNetBuy: entry.lastSpotTakerNetBuy ?? null,
          oiAccel30m: entry.oiAccel30m ?? null,
          futSpotRatio: entry.futSpotRatio ?? null,
          whaleIndex: entry.lastWhaleIndex ?? null,
          snf1h: getSpotNetflowEntry(sym)?.netPct1h ?? null,
          obRatio: entry.lastObRatio ?? entry.firstObRatio ?? null,
        } satisfies typeof prescanHistoryTable.$inferInsert;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) return 0;
    await _telemetryQueue.enqueue({
      dedupKey: `history:${now.toISOString()}`,
      kind: "history",
      rows,
    });
    return rows.length;
  } catch (err) {
    logger.warn(
      { err },
      "enqueuePrescanHistory: capture or durable outbox insert failed",
    );
    return 0;
  }
}

interface SymbolSignalState {
  firstSignalAt: Date;
  signalCount: number;
  cumulativeOiChange: number;
}
const signalHistory = new Map<string, SymbolSignalState>();

let scanTimer: ReturnType<typeof setTimeout> | null = null;
let lastScanHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let autoRangeBackgroundWarmupTimer: ReturnType<typeof setInterval> | null =
  null;
let autoRangeBackgroundWarmupRunning = false;

/**
 * Drains the Auto Range history queue between scans. The in-scan warmup is
 * capped per 30-minute scan, which left most symbols without 4H history.
 * Shares the same queue (running-key guard prevents duplicate fetches).
 */
async function runAutoRangeBackgroundWarmup(): Promise<void> {
  if (autoRangeBackgroundWarmupRunning) return;
  if (!AUTO_RANGE_LIVE_ENABLED && !AUTO_RANGE_1H_LIVE_ENABLED) return;
  if (autoRangeHistoryQueue.queueSize === 0) return;
  autoRangeBackgroundWarmupRunning = true;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Auto Range background warmup deadline")),
    40_000,
  );
  try {
    const stats = await autoRangeHistoryQueue.fetchBatch({
      signal: controller.signal,
      fetchHistory: (key, limit) => {
        if (controller.signal.aborted) throw controller.signal.reason;
        const timeframe: AutoRangeTimeframe = key.startsWith("1h:")
          ? "1h"
          : "4h";
        return getKlinesWithDeepHistory(
          key.slice(3),
          timeframe,
          limit,
          AUTO_RANGE_MIN_CLOSED_CANDLES,
          (candles) => normalizeClosedBreakoutCandles(candles).length,
          { strictPayload: true },
        );
      },
    });
    if (stats.attempted > 0) {
      logger.info(
        {
          attempted: stats.attempted,
          succeeded: stats.succeeded,
          shortHistory: stats.shortHistory,
          failed: stats.failed,
          cancelled: stats.cancelled,
          queuedRemaining: stats.queuedRemaining,
          replayWindow: AUTO_RANGE_1H_REPLAY_WINDOW,
          ...autoRangeHistoryQueue.cacheStats(),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        },
        "Auto Range background history warmup",
      );
    }
  } catch (error) {
    logger.warn(
      { error: serializeAutoRangeHistoryError(error) },
      "Auto Range background history warmup failed",
    );
  } finally {
    clearTimeout(timer);
    autoRangeBackgroundWarmupRunning = false;
  }
}
let activeScanAbortController: AbortController | null = null;
const scannerRecoveryScheduler = new ScannerRecoveryScheduler();
const scannerCycleSettlementFence = new ScannerCycleSettlementFence();
const SCANNER_SETTLEMENT_FENCE_GRACE_MS = 2 * 60_000;
// The discovery owner must recover quickly after a DB incident. It gets a
// dedicated lease connection, so frequent heartbeats do not compete with
// analytics/backfill traffic. A worker that cannot renew is terminated before
// this short TTL can hand ownership to another process.
const DISCOVERY_SCANNER_LEASE_TTL_MS = 90_000;
const DISCOVERY_SCANNER_LEASE_HEARTBEAT_MS = 15_000;
const DISCOVERY_SCANNER_LEASE_RELEASE_TIMEOUT_MS = 3_000;
export type ScannerWorkerRestartDetails = {
  reason: "settlement_fence_stuck" | "discovery_lease_lost";
  pendingSince: Date | null;
  graceExpiresAt: Date | null;
};
let scannerWorkerRestartHandler:
  | ((details: ScannerWorkerRestartDetails) => void)
  | null = null;
let scanCycleCounter = 0; // global PostgreSQL cycle id, also used for quiet prescan
let activePatternDebugCycleNumber: number | null = null;
let activePatternDebugCyclePrepared = false;
export let lastPatternDebugCycleNumber: number | null = null;
const SCANNER_LEASE_RETRY_MS = 60_000;
const SCANNER_RETRY_MAX_MS = 5 * 60_000;
const SCANNER_CONTROL_PLANE_RETRY_MS = 15_000;
let scannerRetryAttempt = 0;
let scannerLeaseAcquireInFlight = false;

type ScannerFailureReason =
  | "startup_db_or_transport_error"
  | "startup_lease_lost"
  | "lease_busy"
  | "lease_lost"
  | "lease_release_failed"
  | "scan_hard_timeout"
  | "settlement_fence_pending"
  | "settlement_fence_stuck"
  | "lease_control_plane_unavailable"
  | "scheduled_scan_error";

type ScannerFailureDiagnostics = {
  capturedAt: string;
  activePhase: string;
  phaseAgeMs: number | null;
  pendingOperations: Array<{ kind: string; ageMs: number }>;
  marketRequestBudget: ReturnType<typeof getMarketRequestBudgetSnapshot>;
  applicationDbPool: ReturnType<typeof getDbPoolSnapshot>;
  schedulerDbPool: ReturnType<typeof getSchedulerPoolSnapshot>;
};

interface PendingScannerFailure {
  reason: ScannerFailureReason;
  failedAt: Date;
  expectedLeaseExpiryAt: Date | null;
  diagnostics: ScannerFailureDiagnostics;
}

interface PendingScannerSuccess {
  completedAt: Date;
  durationMs: number;
}

let pendingScannerFailure: PendingScannerFailure | null = null;
let pendingScannerSuccess: PendingScannerSuccess | null = null;
let scannerRecoveryPersistenceInFlight = false;
let activeScannerPhase = "idle";
let activeScannerPhaseStartedAt: number | null = null;
const pendingScannerOperations = new Map<
  string,
  { kind: string; startedAt: number }
>();
let scannerOperationSequence = 0;

// Memory diagnostics: size of every long-lived module-level collection.
registerProcessHealthSource("scanner_collections", () => {
  const sizes: Record<string, number> = {
    armSymbolMissingSince: armSymbolMissingSince.size,
    neonDailyKlinesCache: neonDailyKlinesCache.size,
    oneHourRangeReplayMemo: oneHourRangeReplayMemo.size,
    cgVolumeCache: cgVolumeCache.size,
    prescanTracker: prescanTracker.size,
    bingxFuturesSymbols: bingxFuturesSymbols.size,
    latestFrMap: _latestFrMap.size,
    prevQuoteVolCache: prevQuoteVolCache.size,
    steadyClimbMap: steadyClimbMap.size,
    lastKnownLiveData: lastKnownLiveData.size,
    lastCycleCandidates: lastCycleCandidates.length,
    lastPatternDebug: Object.keys(lastPatternDebug).length,
    lastCycleLayers: lastCycleLayers.size,
    pendingDiagRows: _pendingDiagRows.length,
    symRejCycleClose: _symRejCycleClose.size,
    symRejDedup: _symRejDedup.size,
    symRejLog: _symRejLog.length,
    symRejDecisionRetry: _symRejDecisionRetry.length,
    baP24hTelemetryPending: _baP24hTelemetryPending.size,
    impulseShadowPending: _impulseShadowPending.size,
    confirmingWatchMap: confirmingWatchMap.size,
    vbSpotLastFiredAt: _vbSpotLastFiredAt.size,
    oiWatchPriceCache: oiWatchPriceCache.size,
    mcapDbCache: _mcapDbCache.size,
    oiBaseline: oiBaseline.size,
    prescanWrittenCycles: _prescanWrittenCycles.size,
    signalHistory: signalHistory.size,
    pendingScannerOperations: pendingScannerOperations.size,
  };
  return {
    entries: Object.values(sizes).reduce((a, n) => a + n, 0),
    ...sizes,
  };
});
registerProcessHealthSource("coinglass_governor_collections", () =>
  coinglassGovernorCollectionSizes(),
);
// Database write/read queues: waiting requests on both pools.
registerProcessHealthSource("db_pools", () => {
  const app = getDbPoolSnapshot();
  const sched = getSchedulerPoolSnapshot();
  return {
    entries: app.waiting + sched.waiting,
    appTotal: app.total,
    appIdle: app.idle,
    appWaiting: app.waiting,
    schedulerTotal: sched.total,
    schedulerIdle: sched.idle,
    schedulerWaiting: sched.waiting,
  };
});

/** Per-cycle step offsets (measurement only, stored with cycle metrics). */
let cycleStepSink: {
  startMs: number;
  steps: Array<{ step: string; atMs: number }>;
} | null = null;
function markCycleStep(step: string): void {
  if (cycleStepSink)
    cycleStepSink.steps.push({
      step,
      atMs: Date.now() - cycleStepSink.startMs,
    });
}

function setScannerPhase(phase: string): void {
  markCycleStep(`phase:${phase}`);
  if (activeScannerPhase !== phase) {
    activeScannerPhase = phase;
    activeScannerPhaseStartedAt = phase === "idle" ? null : Date.now();
  }
}

async function trackScannerOperation<T>(
  kind: string,
  work: () => Promise<T>,
): Promise<T> {
  const id = `${kind}:${++scannerOperationSequence}`;
  pendingScannerOperations.set(id, { kind, startedAt: Date.now() });
  try {
    return await work();
  } finally {
    pendingScannerOperations.delete(id);
  }
}

function captureScannerFailureDiagnostics(): ScannerFailureDiagnostics {
  const now = Date.now();
  return {
    capturedAt: new Date(now).toISOString(),
    activePhase: activeScannerPhase,
    phaseAgeMs: activeScannerPhaseStartedAt
      ? now - activeScannerPhaseStartedAt
      : null,
    pendingOperations: [...pendingScannerOperations.values()].map(
      (operation) => ({
        kind: operation.kind,
        ageMs: now - operation.startedAt,
      }),
    ),
    marketRequestBudget: getMarketRequestBudgetSnapshot(),
    applicationDbPool: getDbPoolSnapshot(),
    schedulerDbPool: getSchedulerPoolSnapshot(),
  };
}

/**
 * Failure and success records are written in order. When the DB is down, a
 * later success must not overtake and erase the failure that explains why the
 * scanner paused. Each recovery attempt replays the pending state.
 */
async function flushScannerRecoveryState(): Promise<void> {
  if (scannerRecoveryPersistenceInFlight) return;
  scannerRecoveryPersistenceInFlight = true;
  try {
    const failure = pendingScannerFailure;
    if (failure) {
      const saved = await dbWriteBestEffort(
        "scanner recovery failure state",
        () =>
          db
            .update(settingsTable)
            .set({
              scannerFailureAt: failure.failedAt,
              scannerFailureReason: failure.reason,
              scannerFailureDiagnosticsJson: JSON.stringify(
                failure.diagnostics,
              ),
              scannerLeaseExpectedExpiryAt: failure.expectedLeaseExpiryAt,
            })
            .returning({ id: settingsTable.id }),
        { attempts: 1 },
      );
      if (!saved) return;
      if (pendingScannerFailure === failure) pendingScannerFailure = null;
    }

    const success = pendingScannerSuccess;
    if (!success) return;
    const saved = await dbWriteBestEffort(
      "scanner successful completion state",
      () =>
        db
          .update(settingsTable)
          .set({
            scannerLastScanAt: success.completedAt,
            scannerLastScanDurationMs: success.durationMs,
            scannerFailureAt: null,
            scannerFailureReason: null,
            scannerFailureDiagnosticsJson: null,
            scannerLeaseExpectedExpiryAt: null,
          })
          .returning({ id: settingsTable.id }),
      { attempts: 1 },
    );
    if (saved && pendingScannerSuccess === success) {
      pendingScannerSuccess = null;
    }
  } finally {
    scannerRecoveryPersistenceInFlight = false;
  }
}

function scannerRetryDelay(reason: ScannerFailureReason): number {
  if (
    reason === "lease_busy" ||
    reason === "lease_lost" ||
    reason === "lease_release_failed" ||
    reason === "settlement_fence_pending"
  ) {
    return SCANNER_LEASE_RETRY_MS;
  }
  const initialDelay =
    reason === "lease_control_plane_unavailable"
      ? SCANNER_CONTROL_PLANE_RETRY_MS
      : SCANNER_LEASE_RETRY_MS;
  const delay = Math.min(
    initialDelay * Math.pow(2, scannerRetryAttempt),
    SCANNER_RETRY_MAX_MS,
  );
  scannerRetryAttempt++;
  return delay;
}

function scheduleScannerRetry(
  reason: ScannerFailureReason,
  expectedLeaseExpiryAt: Date | null = null,
): void {
  if (!state.running) return;
  const delay = scannerRetryDelay(reason);
  if (scanTimer) clearTimeout(scanTimer);
  state.nextScanAt = new Date(Date.now() + delay);
  state.retryAt = state.nextScanAt;
  scanTimer = scannerRecoveryScheduler.schedule(delay, scheduledScan);
  logger.info(
    {
      reason,
      retryInMs: delay,
      nextScanAt: state.nextScanAt,
      expectedLeaseExpiryAt,
    },
    "Scanner recovery retry scheduled",
  );
}

function recordScannerFailure(
  reason: ScannerFailureReason,
  expectedLeaseExpiryAt: Date | null = null,
): void {
  // The first retry after an uncertain release usually sees the original lease
  // as busy. Preserve its TTL for the watchdog instead of overwriting it with
  // the less useful generic contention reason.
  if (
    shouldRetainLeaseReleaseFailure(
      {
        reason: state.scannerFailureReason,
        expectedLeaseExpiryAt: state.scannerLeaseExpectedExpiryAt,
      },
      reason,
    )
  ) {
    void flushScannerRecoveryState();
    return;
  }
  const failedAt = new Date();
  if (reason === "lease_control_plane_unavailable") {
    controlPlaneUnavailableSince ??= failedAt;
  } else {
    controlPlaneUnavailableSince = null;
  }
  const diagnostics = captureScannerFailureDiagnostics();
  state.scannerFailureReason = reason;
  state.scannerFailureAt = failedAt;
  state.scannerLeaseExpectedExpiryAt = expectedLeaseExpiryAt;
  state.lastFailureAt = failedAt;
  state.lastFailureReason = reason;
  state.activeMarketLeaseExpiresAt = expectedLeaseExpiryAt;
  // A newer failure supersedes any success that has not reached the DB yet.
  pendingScannerSuccess = null;
  pendingScannerFailure = {
    reason,
    failedAt,
    expectedLeaseExpiryAt,
    diagnostics,
  };
  logger.error(
    { reason, expectedLeaseExpiryAt, diagnostics },
    "Scanner failure diagnostics captured",
  );
  void flushScannerRecoveryState();
}

function recordScannerSuccess(completedAt: Date, durationMs: number): void {
  scannerRetryAttempt = 0;
  controlPlaneUnavailableSince = null;
  state.lastScanAt = completedAt;
  state.lastSuccessfulScanAt = completedAt;
  state.lastScanDurationMs = durationMs;
  state.scannerFailureReason = null;
  state.scannerFailureAt = null;
  state.scannerLeaseExpectedExpiryAt = null;
  state.lastFailureAt = null;
  state.lastFailureReason = null;
  state.retryAt = null;
  state.activeMarketLeaseExpiresAt = null;
  pendingScannerSuccess = { completedAt, durationMs };
  void flushScannerRecoveryState();
}

function observeLateLeaseRelease(
  cycle: Promise<unknown>,
  phase: "scheduled" | "startup",
): void {
  void cycle.catch((err) => {
    if (!(err instanceof SchedulerLeaseReleaseError)) return;
    recordScannerFailure("lease_release_failed", err.expectedExpiryAt);
    scheduleScannerRetry("lease_release_failed", err.expectedExpiryAt);
    logger.error(
      {
        err,
        phase,
        retryInMs: SCANNER_LEASE_RETRY_MS,
        expectedLeaseExpiryAt: err.expectedExpiryAt,
      },
      "Late scanner cleanup reported an uncertain lease release; retry updated",
    );
  });
}

function fenceTimedOutCycle(cycle: Promise<unknown>): void {
  recordScannerFailure("settlement_fence_pending");
  let restartRequested = false;
  scannerCycleSettlementFence.hold(
    cycle,
    () => {
      if (!state.running) return;
      if (restartRequested) return;
      scheduleScannerRetry(
        state.scannerFailureReason ?? "settlement_fence_pending",
        state.scannerLeaseExpectedExpiryAt,
      );
      logger.info(
        "Timed-out scanner cycle finally settled; recovery retry may resume",
      );
    },
    {
      graceMs: SCANNER_SETTLEMENT_FENCE_GRACE_MS,
      onGraceExpired: (fence) => {
        restartRequested = true;
        recordScannerFailure("settlement_fence_stuck");
        const details: ScannerWorkerRestartDetails = {
          reason: "settlement_fence_stuck",
          pendingSince: fence.pendingSince,
          graceExpiresAt: fence.graceExpiresAt,
        };
        requestScannerWorkerRestart(
          details,
          "Scanner settlement fence did not settle; worker restart is required",
        );
      },
    },
  );
}

function requestScannerWorkerRestart(
  details: ScannerWorkerRestartDetails,
  message: string,
): void {
  logger.fatal({ ...details }, message);
  if (!scannerWorkerRestartHandler) {
    logger.error(
      { ...details },
      "Scanner worker restart handler is unavailable; manual restart is required",
    );
    return;
  }
  scannerWorkerRestartHandler(details);
}

/**
 * A local settlement fence can only be cleared by terminating the old process.
 * The deployment entrypoint installs a supervisor restart handler; tests can
 * inject a harmless recorder instead of exiting the test worker.
 */
export function setScannerWorkerRestartHandler(
  handler: ((details: ScannerWorkerRestartDetails) => void) | null,
): void {
  scannerWorkerRestartHandler = handler;
}

// ── Settings ────────────────────────────────────────────────────────────────
async function getSettings() {
  const rows = await db.select().from(settingsTable).limit(1);
  if (rows.length === 0) {
    const inserted = await db
      .insert(settingsTable)
      .values({
        volumeMultiplier: 3,
        oiChangePercent: 8,
        fundingRateThreshold: 0.0005,
        scanIntervalMs: 300_000,
        telegramEnabled: true,
        maxSymbols: 200,
      })
      .returning();
    return inserted[0];
  }
  return rows[0];
}

import {
  buildCanonicalSignalFirePrice,
  type SentimentResult,
  type DetectionResult,
  type AlphaResult,
  classifyAlphaGrade,
  detectSentiment,
  calcBulletScore,
  classifyImpulseBuyLiqShadow,
  evaluateImpulseBuy,
  normalizeImpulseTakerNetBuyPct,
  shouldEmitImpulseBuyLive,
  resolveImpulseBuyScannerFlow,
  shouldBypassImpulseBuyCommonGate,
  evaluatePattern,
  resolveEntrySpotVolMult,
  type ImpulseBuyDecision,
} from "./scanner-patterns.js";

// ── Main scan ────────────────────────────────────────────────────────────────
//
// The body is wrapped so a lease abort, timeout, or unexpected exception cannot
// leave a checked Whale Watch evaluation without a terminal result. The wrapper
// also persists this cycle immediately; the next-cycle drain below remains for
// compatibility with the other diagnostic queues.
async function performScan(lease: MarketCycleLeaseContext): Promise<{
  signalsFound: number;
  marketsScanned: number;
  durationMs: number;
}> {
  try {
    return await performScanBody(lease);
  } finally {
    const cycleNumber = activePatternDebugCycleNumber;
    if (cycleNumber !== null && activePatternDebugCyclePrepared) {
      try {
        // This runs after normal completion and after every failure/abort path,
        // so checked === passed + rejected is true before the row is persisted.
        await persistPatternDebugSnapshot(cycleNumber);
      } catch (err) {
        logger.warn(
          { err, cycleNumber },
          "Pattern debug current-cycle persistence failed",
        );
      }
      try {
        // Reject reasons must be visible right after the cycle, not 30 min
        // later. Rows are only spliced after a confirmed write, so the
        // next-cycle flush cannot duplicate them.
        await persistSymRejectLog();
      } catch (err) {
        logger.warn(
          { err, cycleNumber },
          "ScanRejectLog current-cycle persistence failed",
        );
      }
      lastPatternDebugCycleNumber = cycleNumber;
      activePatternDebugCycleNumber = null;
      activePatternDebugCyclePrepared = false;
    } else if (cycleNumber !== null) {
      activePatternDebugCycleNumber = null;
      activePatternDebugCyclePrepared = false;
    }
  }
}

type OneHourRangeArmInput = {
  symbol: string;
  slot: "primary" | "secondary";
  structure: BreakoutEvidence;
  fourHourCandles: ReturnType<typeof normalizeClosedBreakoutCandles>;
  oneHourCandles: ReturnType<typeof normalizeClosedBreakoutCandles>;
  refinementCandles: ReturnType<typeof normalizeClosedBreakoutCandles>;
  evaluatedAt: number;
  allowCreate: boolean;
  legacyBreakoutLevel: number | null;
  participationTelemetry?: StealthBreakoutParticipationTelemetry;
  identity: ReturnType<typeof autoRangeIdentityFromResult>;
  result: AutoRangePineResult;
  fastVolumePass: boolean;
  prefetchedVolumes?: {
    "1h"?: ReadonlyMap<number, number> | null;
    "4h"?: ReadonlyMap<number, number> | null;
  };
  marketCapUsd?: number | null;
};

/** One call site for every 1H Range arm evaluation (main loop and early pass). */
async function evaluateOneHourRangeArm(input: OneHourRangeArmInput) {
  return evaluateDurableStealthArm({
    symbol: input.symbol,
    structure: input.structure,
    breakoutCandles4h: input.fourHourCandles,
    breakoutCandles1h: input.oneHourCandles,
    refinementCandles: input.refinementCandles,
    evaluatedAt: input.evaluatedAt,
    allowCreate: input.allowCreate,
    levelSource: "auto_range_1h",
    legacyBreakoutLevel: input.legacyBreakoutLevel,
    experimentVersion: "auto-range-pine-v1-1h",
    technicalMode: "auto_range_1h",
    atr: calculateStealthAtr(input.oneHourCandles) ?? undefined,
    participationTelemetry: input.participationTelemetry,
    autoRangeIdentity: input.identity,
    autoRangeBreakoutEvent: input.result.latestUpsideBreakout,
    autoRangeStatus: input.result.status,
    fastVolumePass: input.fastVolumePass,
    marketCapUsd:
      input.marketCapUsd !== undefined
        ? input.marketCapUsd
        : (await fetchMarketCap(input.symbol).catch(() => null))?.mcap,
    prefetchedVolumes: input.prefetchedVolumes,
    armSlot: input.slot,
  });
}

/** Replay-window 1H Range detection shared by the scan loop and the early arm pass. */
function detectOneHourRangeMemoized(
  symbol: string,
  candles: ReturnType<typeof getAutoRangeClosedCandles>,
): AutoRangePineResult {
  const window = anchoredAutoRangeWindow(
    candles,
    60 * 60 * 1000,
    AUTO_RANGE_1H_REPLAY_WINDOW,
  );
  const memo = oneHourRangeReplayMemo.get(symbol);
  if (
    memo &&
    memo.lastTime === window.at(-1)?.time &&
    memo.firstTime === window[0]?.time &&
    memo.length === window.length
  )
    return memo.result;
  const result = detectAutoRangePine1h(
    window.map((candle) => ({ ...candle, closed: true })),
  );
  if (window.length > 0)
    oneHourRangeReplayMemo.set(symbol, {
      lastTime: window[window.length - 1]!.time,
      firstTime: window[0]!.time,
      length: window.length,
      result,
    });
  return result;
}

// No 30m candle can have closed after the breakout inside this window, so an
// empty 30m refinement is the true state, not missing data.
const EARLY_ARM_PASS_MAX_AGE_MS = 25 * 60 * 1000;
const EARLY_ARM_PASS_BUDGET_MS = 120_000;
const EARLY_ARM_PASS_CONCURRENCY = 6;

/**
 * Runs right after the 1H candle closes, before the slow prefetch phases:
 * armed 1H Range arms get their breakout/qualification check immediately
 * (owner 2026-10-19: qualification within minutes of the close, not 13-17).
 * It only qualifies/closes existing arms (never creates) and does not fire;
 * the fire path stays in the main loop. No participation telemetry is written
 * here (the OI/CVD prefetch has not run) and no "unavailable" record is made;
 * on any missing data the arm is left untouched for the main loop.
 */
async function runEarlyOneHourArmPass(
  lease: { throwIfLost: (what: string) => void },
  cycleStartMs: number,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  if (
    !AUTO_RANGE_1H_LIVE_ENABLED ||
    now - hourStart > EARLY_ARM_PASS_MAX_AGE_MS
  ) {
    return { skipped: true };
  }
  const rows = await db.execute(sql`
    SELECT symbol,
           bool_or(COALESCE(decision_json ->> 'armSlot', 'primary') = 'secondary') AS has_secondary
    FROM stealth_breakout_armed_setups
    WHERE level_source = 'auto_range_1h' AND status = 'armed'
    GROUP BY symbol
  `);
  const targets = rows.rows as Array<{
    symbol: string;
    has_secondary: boolean;
  }>;
  const deadline = Date.now() + EARLY_ARM_PASS_BUDGET_MS;
  const emptyStructure = analyzeStealthStructure([]);
  let evaluated = 0;
  let qualified = 0;
  let failed = 0;
  let earlySkippedNoData = 0;
  let earlyBudgetNotRun = 0;
  let earlyKlinesShort = 0;
  let earlyCandleStale = 0;
  let earlyNoBreakout = 0;
  let earlyBreakoutOlder = 0;
  let earlyBreakoutThisHour = 0;
  const qualifiedSymbols: string[] = [];
  await runConcurrent(targets, EARLY_ARM_PASS_CONCURRENCY, async (target) => {
    if (Date.now() > deadline) {
      earlyBudgetNotRun++;
      return;
    }
    lease.throwIfLost("early 1H arm pass");
    const symbol = target.symbol;
    try {
      const fresh = await getKlines(symbol, "1h", KLINE_1H_LOOKBACK);
      // Candle fetch failed or is short: the arm stays untouched for the
      // main loop. No decision is made on stale in-memory history.
      if (fresh.length < 2) {
        earlyKlinesShort++;
        return;
      }
      mergeAutoRangeHistory(symbol, fresh, "1h");
      const candles = getAutoRangeClosedCandles(symbol, "1h");
      const last = candles.at(-1);
      if (
        !last ||
        last.time !== hourStart - 3_600_000 ||
        candles.length < AUTO_RANGE_MIN_CLOSED_CANDLES
      ) {
        earlyCandleStale++;
        return;
      }
      const result = detectOneHourRangeMemoized(symbol, candles);
      const event = result.latestUpsideBreakout;
      // Older breakouts need real 30m hold data: leave them to the main loop.
      if (event && event.breakoutCloseTime < hourStart) {
        earlyBreakoutOlder++;
        return;
      }
      if (event) earlyBreakoutThisHour++;
      else earlyNoBreakout++;
      // One CoinGlass volume request per symbol; the same map is handed to the
      // arm evaluation so it is not requested a second time.
      const [volumes, mcap] = await Promise.all([
        getAggFuturesVolumeByInterval(
          symbol,
          "1h",
          Math.min(4500, candles.length + 5),
        ).catch(() => null),
        event
          ? fetchMarketCap(symbol).catch(() => null)
          : Promise.resolve(null),
      ]);
      const earlyVolumes = volumes ?? null;
      if (event) {
        // Observed breakout-candle volume and market cap are recorded with the
        // decision. If CoinGlass/CoinGecko did not answer, do not write an
        // "unavailable" decision: leave the arm to the main loop.
        const eventCandle = candles.find(
          (candle) => candle.time + 3_600_000 === event.breakoutCloseTime,
        );
        if (
          !volumes ||
          !eventCandle ||
          !(volumes.get(eventCandle.time) !== undefined) ||
          !mcap?.mcap
        ) {
          earlySkippedNoData++;
          return;
        }
      }
      const earlyMcap = mcap?.mcap ?? null;
      const identity = autoRangeIdentityFromResult(result, last.time, "1h");
      const capturedAt = Date.now();
      const slots: Array<"primary" | "secondary"> = target.has_secondary
        ? ["primary", "secondary"]
        : ["primary"];
      for (const slot of slots) {
        const outcome = await evaluateOneHourRangeArm({
          symbol,
          slot,
          structure: emptyStructure,
          fourHourCandles: [],
          oneHourCandles: candles,
          refinementCandles: [],
          evaluatedAt: capturedAt,
          allowCreate: false,
          legacyBreakoutLevel: null,
          identity,
          result,
          fastVolumePass: false,
          // Volume already fetched above is reused; with no breakout event no
          // volume evidence is needed, so nothing is requested again.
          prefetchedVolumes: { "1h": earlyVolumes },
          marketCapUsd: event ? earlyMcap : undefined,
        });
        if (outcome.status === "qualified") {
          qualified++;
          qualifiedSymbols.push(symbol);
        }
      }
      evaluated++;
    } catch (err) {
      failed++;
      logger.warn({ err, symbol }, "Early 1H arm check failed");
    }
  });
  return {
    armedSymbols: targets.length,
    evaluated,
    qualified,
    failed,
    skippedNoData: earlySkippedNoData,
    budgetNotRun: earlyBudgetNotRun,
    klinesShort: earlyKlinesShort,
    candleNotLatest: earlyCandleStale,
    noBreakout: earlyNoBreakout,
    breakoutOlderThanHour: earlyBreakoutOlder,
    breakoutThisHour: earlyBreakoutThisHour,
    qualifiedSymbols,
    startOffsetMs: now - cycleStartMs,
    elapsedMs: Date.now() - now,
  };
}

async function performScanBody(lease: MarketCycleLeaseContext): Promise<{
  signalsFound: number;
  marketsScanned: number;
  durationMs: number;
}> {
  lease.throwIfLost("scanner start");
  if (!autoRangeDisabledArmsSwept) {
    try {
      const invalidated = AUTO_RANGE_1H_LIVE_ENABLED
        ? 0
        : await terminalizeDisabledAutoRangeArms("auto_range_1h");
      autoRangeDisabledArmsSwept = true;
      if (invalidated > 0) {
        logger.warn(
          { invalidated },
          "Invalidated pending 1H Auto Range arms after retirement",
        );
      }
    } catch (error) {
      logger.warn(
        { error },
        "Could not terminalize disabled 1H Auto Range arms; live qualification remains gated",
      );
    }
  }
  const startTime = Date.now();
  cycleStepSink = { startMs: startTime, steps: [] };
  setScannerPhase("previous-tail-drain");
  const durableCycleNumber = await allocatePatternDebugCycleNumber();
  scanCycleCounter = durableCycleNumber;
  activePatternDebugCycleNumber = durableCycleNumber;
  activePatternDebugCyclePrepared = false;
  // Флаги ставим ДО первых await — watchdog никогда не увидит «старый» lastScanAt
  // в фазах до скана (persistPatternDebugSnapshot, persistSymRejectLog, getSettings).
  // Ранее стояли на ~50 строк ниже, после нескольких await, что давало ложные
  // watchdog-алерты если Neon pool зависал на 25+ мин в начале цикла.
  state.scanStartedAt = new Date();
  // Keep lastScanAt populated for older internal consumers; the public API now
  // exposes scanStartedAt explicitly so the dashboard never has to guess.
  state.lastScanAt = state.scanStartedAt;
  state.isScanning = true;
  logger.info(
    {
      scanCycle: scanCycleCounter,
      ownerToken: lease.ownerToken,
      startedAt: state.scanStartedAt,
    },
    "Scanner cycle started after discovery lease acquired",
  );
  const recoveredStealthClaims = await sweepExpiredStealthArmClaims(startTime);
  if (
    recoveredStealthClaims.armed > 0 ||
    recoveredStealthClaims.qualified > 0 ||
    recoveredStealthClaims.firing > 0
  ) {
    logger.warn(
      recoveredStealthClaims,
      "Swept expired Stealth arm claims before market filtering",
    );
  }
  try {
    const staleClosed = await closeStaleQualifiedStealthArms(startTime);
    if (staleClosed > 0)
      logger.warn(
        { staleClosed },
        "Closed qualified Stealth arms past the 2h fire window",
      );
  } catch (err) {
    logger.warn({ err }, "Stale qualified Stealth arm closure failed");
  }
  // Cross-process: Worker B infers isScanning = scannerScanStartedAt > scannerLastScanAt
  void dbWriteBestEffort(
    "scannerScanStartedAt",
    () =>
      db.update(settingsTable).set({
        // Backfill one pre-existing completed scan before replacing its start
        // timestamp with the new cycle. This makes the status available on the
        // first cycle after adding durable duration storage.
        scannerLastScanDurationMs: sql`
          CASE
            WHEN ${settingsTable.scannerLastScanDurationMs} IS NULL
              AND ${settingsTable.scannerLastScanAt} IS NOT NULL
              AND ${settingsTable.scannerScanStartedAt} IS NOT NULL
              AND ${settingsTable.scannerLastScanAt} >= ${settingsTable.scannerScanStartedAt}
            THEN GREATEST(
              0,
              (EXTRACT(EPOCH FROM (${settingsTable.scannerLastScanAt} - ${settingsTable.scannerScanStartedAt})) * 1000)::INTEGER
            )
            ELSE ${settingsTable.scannerLastScanDurationMs}
          END
        `,
        scannerScanStartedAt: state.scanStartedAt,
      }),
    { attempts: 1 },
  );

  // ── Drain previous scan's background work (bounded) ──────────────────────
  // Await the previous cycle's fire-and-forget tail tasks (prescan history,
  // DB snapshot, whale index, spot taker/vol batches) with a hard cap so a
  // slow previous batch never blocks this scan beyond SCAN_END_FENCE_MAX_MS.
  let canScheduleScanEndWork = true;
  {
    const _fenceStart = Date.now();
    let fenceTimedOut = false;
    const fenceTimer = setTimeout(() => {
      fenceTimedOut = true;
    }, SCAN_END_FENCE_MAX_MS);
    await Promise.race([
      _scanEndFence,
      new Promise<void>((resolve) =>
        setTimeout(resolve, SCAN_END_FENCE_MAX_MS),
      ),
    ]);
    clearTimeout(fenceTimer);
    const _fenceMs = Date.now() - _fenceStart;
    if (fenceTimedOut) {
      // Do not overwrite the still-running fence with another cycle's tail
      // work. Skipping non-critical enrichment for this cycle is preferable to
      // an unbounded chain that starves the next active scan and the DB pool.
      canScheduleScanEndWork = false;
      logger.warn(
        { fenceMs: _fenceMs, cap: SCAN_END_FENCE_MAX_MS },
        "scan-end fence timed out — deferring this cycle's background enrichment",
      );
    } else if (_fenceMs > 1000) {
      logger.info(
        { fenceMs: _fenceMs, cap: SCAN_END_FENCE_MAX_MS },
        "⏳ scan-end fence: waited for previous cycle's background work",
      );
    }
  }
  const _spotVolDiag = {
    notInMap: 0,
    noAvg: 0,
    noLast: 0,
    hasMult: 0,
    sample: [] as Array<{
      sym: string;
      inMap: boolean;
      avg: number | null;
      last: number | null;
      cycles: number | null;
    }>,
  };
  resetNetflowTelemetry();
  lastLayerDebug = {
    exhaustedByTicker: 0,
    l3CandidatesTotal: 0,
    l3PassedToBatch: 0,
    l4CandidatesTotal: 0,
    l4PassedToBatch: 0,
    l5CandidatesTotal: 0,
    l5PassedToBatch: 0,
    l8SteadyGrowthCycles: 0,
    l8PassedToBatch: 0,
    l8bOiLeadersTotal: 0,
    l8bInsertedToWatch: 0,
    l6cRescuedTotal: 0,
    quietPrescanAdded: 0,
    l10LiqCascadeAdded: 0,
    l15WhalePositionAdded: 0,
    cycleNumber: scanCycleCounter,
  };
  // Записываем снапшот ПРЕДЫДУЩЕГО цикла пока pool свежий (простоял ~10 мин без нагрузки).
  // await (не void) — начало скана, pool свободен, блокировка ~10-50ms, данные гарантированы.
  // Вызов ДО сброса: lastPatternDebug и _pendingDiagRows ещё содержат данные цикла N-1.
  // ScanRejectLog: flush предыдущего цикла пока pool свежий.
  // Аналогично PDB/DiagRows: в конце скана Neon pool перегружен → таймаут накапливает 1173+ строк.
  // В начале следующего цикла pool простоял ~10 мин и принимает INSERT мгновенно.
  await persistSymRejectLog();
  if (
    Object.keys(lastPatternDebug).length > 0 &&
    lastPatternDebugCycleNumber !== null
  ) {
    await persistPatternDebugSnapshot(lastPatternDebugCycleNumber);
  }
  await flushPendingDiagRows();
  lastPatternDebug = {};
  activePatternDebugCyclePrepared = true;

  const settings = await getSettings();

  // T3 warmup is deliberately bounded and awaited. Leaving it as `void` meant
  // an abort-ignoring request could outlive the scanner cycle without appearing
  // in its fence or diagnostics.
  await trackScannerOperation("network:liq-cache-warmup", async () => {
    await Promise.allSettled([fetchLiqCoinList(), fetchLiqOrders()]);
  });

  // Очищаем устаревшие записи signalHistory (TTL: 48 часов).
  // Без TTL история растёт вечно — символы которые давно не скануются остаются в памяти.
  const TTL_MS = 48 * 60 * 60 * 1000;
  for (const [sym, st] of signalHistory.entries()) {
    if (Date.now() - st.firstSignalAt.getTime() > TTL_MS) {
      signalHistory.delete(sym);
    }
  }

  // Sweep: помечаем все OI Watch записи у которых истёк expiresAt.
  // Без этого символы выпавшие из топ-пресскана висят в "watching"/"confirming" вечно.
  try {
    // ВАЖНО: firedAt здесь НЕ проставляем — это поле означает момент реального
    // срабатывания сигнала (алерт в Telegram), а не момент технической зачистки
    // просроченной записи. Ранее ошибочно проставлялось в этом же UPDATE, из-за
    // чего "confirmed" записи выглядели как fired→expired (ложное подозрение на
    // гонку процессов) — на деле broadcastBatchAlert тут никогда не вызывался.
    // dbWriteBestEffort: защита от зависания при нагрузке на Neon pool
    await dbWriteBestEffort("oiWatch/expired-sweep", () =>
      db
        .update(oiWatchTable)
        .set({ status: "expired" })
        .where(
          and(
            inArray(oiWatchTable.status, ["watching", "confirming"]),
            lt(oiWatchTable.expiresAt, new Date()),
          ),
        ),
    );
  } catch (err) {
    logger.warn({ err }, "OI Watch expired sweep failed");
  }

  // Очищаем кэш CoinGlass перед каждым сканом — данные всегда свежие
  clearCoinglassOICache();
  logger.info("Starting AltBullet Scanner (15m TF, 30m OI, multi-pattern)...");

  state.oiWatchInsertsLastScan = 0;
  state.cgTimeoutsLastScan = 0;

  let tickers;
  try {
    tickers = await getFutureTickers();
    await refreshAggregatedVolume24h();
  } catch (err) {
    logger.error({ err }, "Failed to fetch BingX tickers");
    state.bingxConnected = false;
    throw new Error("Scanner cannot complete without BingX tickers", {
      cause: err,
    });
  }
  state.bingxConnected = true;
  // Owner blacklist: blocked symbols never enter any scan stage.
  tickers = tickers.filter(
    (t) => !isAnalysisBlockedSymbol((t as BingXTicker).symbol),
  );

  // Обновляем множество символов BingX (для isBingXFutures)
  bingxFuturesSymbols.clear();
  for (const t of tickers) bingxFuturesSymbols.add((t as BingXTicker).symbol);

  // ── Activity-score pre-screening (ALL tokens, 1 API call) ───────────────────
  // Score every USDT token using already-fetched ticker data (free, no extra calls).
  // Hot tokens (big price move + big volume) get deep-scanned every 10 min,
  // so OI baselines build up within 20 min — not 100 min like with rotation.
  //
  // score = abs(priceChange24h%) × log10(quoteVolumeUSD + 1)
  // This ranks: tokens with big price moves in liquid markets first.
  // Exclude index/stock trackers (NCS*, NCC*, symbols with "2USD" — e.g. NCSKSPY2USD-USDT)
  const isCryptoFuture = (symbol: string) => {
    const base = symbol.replace("-USDT", "");
    return (
      !base.includes("2USD") &&
      !base.startsWith("NCS") &&
      !base.startsWith("NCC") &&
      !base.startsWith("NCFX")
    );
  };

  const scored = tickers
    .filter((t) => t.symbol.endsWith("-USDT") && isCryptoFuture(t.symbol))
    .map((t) => {
      const _pe = prescanTracker.get(t.symbol);
      // BingX периодически сбрасывает openPrice → priceChangePercent≈0 для реальных муверов.
      // Исправление: если у токена есть сохранённый lastPrice24h из предыдущих циклов
      // (записывается с защитой "bxVal || existing" — не затирается нулём),
      // используем его для scoring. Новые токены без истории — BingX fallback.
      const bxP24h = parseFloat(t.priceChangePercent) || 0;
      const ownP24h = _pe?.lastPrice24h ?? null;
      const effectiveP24h =
        ownP24h !== null && Math.abs(ownP24h) > Math.abs(bxP24h)
          ? ownP24h
          : bxP24h;
      const pctChange = Math.abs(effectiveP24h);
      const vol = aggregatedVolume24hUsd(t.symbol);
      const baseScore = pctChange * Math.log10(vol + 1);
      const volAccel =
        _pe?.lastVolMult && _pe?.prevVolMult && _pe.prevVolMult > 0
          ? _pe.lastVolMult / _pe.prevVolMult
          : 1.0;
      const accelBonus = volAccel >= 2.0 ? 2.0 : volAccel >= 1.5 ? 1.5 : 1.0;
      // Бонус за ускорение OI: если oi30m растёт от цикла к циклу — токен поднимается в топ.
      const oiAccel = _pe?.oiAccel30m ?? 1.0;
      const oiAccelBonus =
        oiAccel >= 3.0
          ? 1.4
          : oiAccel >= 2.0
            ? 1.25
            : oiAccel >= 1.5
              ? 1.1
              : 1.0;
      const score = baseScore * accelBonus * oiAccelBonus;
      return { ticker: t, score };
    })
    .sort((a, b) => b.score - a.score);

  // ── Layer 0: user watchlist — always scanned regardless of rank ──────────────
  const watchlistSymbols: string[] = String(settings.watchlist ?? "")
    .split(",")
    .map((s: string) => s.trim().toUpperCase())
    .filter((s: string) => s.length > 0)
    .map((s: string) => (s.includes("-") ? s : `${s}-USDT`)); // auto-append -USDT if missing

  const watchlistSet = new Set([...watchlistSymbols]);
  const watchlistTickers = tickers.filter((t) => watchlistSet.has(t.symbol));
  const watchlistSymbolsFound = new Set(watchlistTickers.map((t) => t.symbol));

  // ── Exhausted pump pre-filter (free — BingX ticker data, no extra API calls) ─
  // Монеты с >25% за 24h уже отработали свой памп. Новый сигнал невозможен —
  // это подтверждено паттерном (exhausted pump filter на глубоком скане).
  // Исключаем ЗДЕСЬ чтобы не тратить дорогие слоты CoinGlass API на мёртвые монеты.
  // Исключение: watchlist — пользователь явно хочет их отслеживать.
  const isExhaustedByTicker = (sym: string, pctChange24h: string): boolean => {
    if (watchlistSet.has(sym)) return false;
    const _raw = parseFloat(pctChange24h) || 0;
    // BingX возвращает 0 при ресете 24h-окна — берём сохранённое kline-проверенное
    // значение из prescanTracker, иначе перегретый токен (KOMA +80%) проходит фильтр.
    const pct =
      _raw !== 0 ? _raw : (prescanTracker.get(sym)?.lastPrice24h ?? 0);
    // Убираем только явно перегретые (памп >40%) или обвальные (<-40%) токены.
    // Диапазон -40%..+40% остаётся в пуле: накопление на дипе (-28% и т.п.) — валидный сигнал.
    const exhausted = pct > 40 || pct < -40;
    if (exhausted && pct > 40) {
    }
    return exhausted;
  };

  // ── Layer 1: top-N by activity score (current hot movers)
  const activityLimit = settings.maxSymbols; // default 50
  const topByActivity = scored
    .filter(
      (s) => !isExhaustedByTicker(s.ticker.symbol, s.ticker.priceChangePercent),
    )
    .slice(0, activityLimit)
    .map((s) => s.ticker);
  const activeSymbols = new Set(topByActivity.map((t) => t.symbol));
  lastLayerDebug.exhaustedByTicker = scored.filter((s) => {
    const p = parseFloat(s.ticker.priceChangePercent);
    return p > 40 || p < -40;
  }).length;

  // ── Layer 2: top-200 by volume — BingX только как fallback для первого скана.
  //    После 1-го скана используем cgVolumeCache (global volUsd от CoinGlass):
  //    DYDX с $246M OI и высоким global volume попадёт в пул даже при низком BingX-объёме.
  const useCgVolume = cgVolumeCache.size > 0;
  const topByVolume = [...scored]
    .filter(
      (s) => !isExhaustedByTicker(s.ticker.symbol, s.ticker.priceChangePercent),
    )
    .sort((a, b) => {
      const symA = a.ticker.symbol.replace("USDT", "").replace("-", "");
      const symB = b.ticker.symbol.replace("USDT", "").replace("-", "");
      const volA = useCgVolume
        ? (cgVolumeCache.get(symA) ??
          cgVolumeCache.get(a.ticker.symbol) ??
          aggregatedVolume24hUsd(a.ticker.symbol))
        : aggregatedVolume24hUsd(a.ticker.symbol);
      const volB = useCgVolume
        ? (cgVolumeCache.get(symB) ??
          cgVolumeCache.get(b.ticker.symbol) ??
          aggregatedVolume24hUsd(b.ticker.symbol))
        : aggregatedVolume24hUsd(b.ticker.symbol);
      return volB - volA;
    })
    .slice(0, 200)
    .map((s) => s.ticker)
    .filter(
      (t) =>
        !activeSymbols.has(t.symbol) && !watchlistSymbolsFound.has(t.symbol),
    );

  // ── OI Universe Discovery: CoinGlass OI для ВСЕХ ~500 токенов ────────────────
  // Первичный фильтр — OI спайк на любом ТФ. Токены с глобальным ростом OI
  // попадают в пул независимо от объёма на BingX.
  // Standard plan: 300 req/min, 50ms задержка. Холодный старт: ~500 × 50ms ≈ 25с.
  // Кэш TTL 5 мин — повторные обращения в deep scan мгновенны (данные уже в кэше).
  const allBingxSymbols = scored.map((s) => s.ticker.symbol);
  logger.info(
    { count: allBingxSymbols.length },
    "OI Universe Discovery: CoinGlass OI для всех токенов...",
  );
  // prefetchNetflowBatch — 1 запрос заменяет 10 per-symbol taker-вызовов для топ-100 символов
  // Карта цен для кросс-валидации CoinGlass OI против прямого BingX OI
  // (ловит коллизии коротких/общих тикеров типа US-USDT — см. coinglass_oi.ts).
  const bingxPriceMap = new Map<string, number>();
  for (const s of scored) {
    const p = parseFloat(s.ticker.lastPrice);
    if (Number.isFinite(p) && p > 0) bingxPriceMap.set(s.ticker.symbol, p);
  }
  // Определяем токены без CG-покрытия — пропускаем в batch-запросе (экономия ~3-4 мин/цикл).
  // PRIMARY: GET /api/futures/supported-coins → официальный список монет CoinGlass.
  //   Токен не в списке → 100% BingX-exclusive, skip навсегда.
  //   Токен в списке   → CG должен иметь данные; cgNoDataCount не используется как gate.
  // FALLBACK: если whitelist не загружен, проверяем только ограниченный
  // high-priority набор. Это сохраняет сигнализацию на ликвидных рынках, но не
  // превращает сбой discovery endpoint в сотни дорогих OI-запросов.
  // A missing whitelist cuts OI coverage from 557 to 100 symbols for the whole
  // cycle (seen 2026-10-19 05:22). Retry once at critical priority first.
  if (getCgSupportedCoinsSet() === null) {
    await refreshCgSupportedCoins().catch(() => undefined);
  }
  const cgSupportedCoins = getCgSupportedCoinsSet();
  const CG_WHITELIST_DEGRADED_CAP = 100;
  const cgDiscoverySymbols =
    cgSupportedCoins === null
      ? Array.from(
          new Set([
            ...watchlistTickers.map((ticker) => ticker.symbol),
            ...allBingxSymbols,
          ]),
        ).slice(0, CG_WHITELIST_DEGRADED_CAP)
      : allBingxSymbols;
  if (cgSupportedCoins === null) {
    logger.warn(
      {
        totalSymbols: allBingxSymbols.length,
        selectedSymbols: cgDiscoverySymbols.length,
        cap: CG_WHITELIST_DEGRADED_CAP,
      },
      "CoinGlass supported-coins unavailable — using bounded OI discovery",
    );
  }
  const cgNoDataSkipSet = new Set<string>(
    [...prescanTracker.entries()]
      .filter(([sym, pe]) => {
        const base = sym.replace("-USDT", "");
        const cgBase = CG_SYMBOL_ALIAS[base] ?? base;
        if (cgSupportedCoins !== null) {
          return !cgSupportedCoins.has(cgBase);
        }
        return (
          (pe.cgNoDataCount ?? 0) >= 3 && (pe.cgNoDataCount ?? 0) % 12 !== 0
        );
      })
      .map(([sym]) => sym),
  );

  // ── Phase 0 hard timeout ─────────────────────────────────────────────────────
  // Защита от бесконечного зависания batchGetCoinglassOI (и остальных prefetch).
  // 22-мин abortFlag (Phase 2) не покрывает этот участок — если CG виснет на
  // TCP-уровне без RST/FIN, Promise.all ждал бы бесконечно и watchdog через 70+мин
  // бил тревогу. При срабатывании — пустая OI map; prescan-stale fallback ниже
  // (~строки 2280-2319) восстановит OI из prescanTracker (данные прошлого цикла).
  const PHASE0_TIMEOUT_MS = 4 * 60 * 1000; // 4 мин
  const _earlyArmPass = await runEarlyOneHourArmPass(lease, startTime).catch(
    (err) => {
      logger.warn({ err }, "Early 1H arm pass failed");
      return { error: String(err) } as Record<string, unknown>;
    },
  );
  setScannerPhase("phase-0-external-prefetch");
  const _phase0StartMs = Date.now();
  const _cycleMetricPhases: Record<string, unknown> = {
    earlyArmPass: _earlyArmPass,
    phase0StartOffsetMs: _phase0StartMs - startTime,
  };
  const phase0Abort = new AbortController();
  const phase0Signal = AbortSignal.any([lease.signal, phase0Abort.signal]);
  let phase0TimedOut = false;
  const phase0Timeout = setTimeout(() => {
    phase0TimedOut = true;
    phase0Abort.abort(new Error("Phase 0 prefetch deadline exceeded"));
    logger.warn(
      { timeoutMs: PHASE0_TIMEOUT_MS },
      "⏱ Phase 0 prefetch deadline reached; waiting for aborted transport to drain",
    );
  }, PHASE0_TIMEOUT_MS);
  // CoinGlass request order: live arm symbols first, then prescan, then the rest.
  const cgScheduleArms = new Set<string>();
  try {
    markCycleStep("armRows-load");
    const armRows = await db.execute(sql`
      SELECT DISTINCT symbol, status FROM stealth_breakout_armed_setups
      WHERE status IN ('armed', 'qualified', 'firing')
    `);
    const tracedArmSymbols: string[] = [];
    for (const row of armRows.rows as Array<{
      symbol: string;
      status: string;
    }>) {
      cgScheduleArms.add(row.symbol);
      if (row.status !== "armed") tracedArmSymbols.push(row.symbol);
    }
    setTracedArmSymbols(tracedArmSymbols);
  } catch (err) {
    logger.warn({ err }, "CoinGlass schedule: arm symbols unavailable");
  }
  const cgSchedulePrescan = new Set<string>(prescanTracker.keys());
  // Stats of an earlier batch call that never reached its cycle drain (aborted
  // attempt) must not be added to this cycle's totals; log them instead.
  {
    const stale = drainCgOiSourceCounts();
    if (stale.calls.length > 0) {
      logger.warn(
        {
          calls: stale.calls.map((c) => ({
            label: c.label,
            requested: c.requested,
            historyRequests: c.history.requested,
          })),
        },
        "Dropped CoinGlass OI batch stats left over from a call outside this cycle",
      );
    }
  }
  // One coins-markets snapshot (all pages, critical priority, live data) at the
  // start of the OI phase; the same map is used by the whole batch.
  const _snapT0 = Date.now();
  const cycleSnapshot = await marketCycleLeaseContext.run(
    { ...lease, signal: phase0Signal },
    () => loadCycleCoinsMarketsSnapshot(phase0Signal),
  );
  const _snapshotMs = Date.now() - _snapT0;
  const phase0Results = await marketCycleLeaseContext.run(
    { ...lease, signal: phase0Signal },
    () =>
      Promise.allSettled([
        trackScannerOperation("network:coinglass-oi-batch", () =>
          batchGetCoinglassOI(
            cgDiscoverySymbols,
            bingxPriceMap,
            cgNoDataSkipSet,
            phase0Signal,
            { arms: cgScheduleArms, prescan: cgSchedulePrescan },
            {
              // No snapshot after the retries: still snapshot mode (empty rows
              // => snapshot_unavailable), never the per-symbol path.
              snapshot: cycleSnapshot ?? {
                rows: new Map(),
                loadedAt: Date.now(),
              },
              label: "scanner",
            },
          ),
        ),
        trackScannerOperation("network:coinglass-netflow-batch", () =>
          prefetchNetflowBatch(),
        ),
        trackScannerOperation("network:bingx-funding-batch", () =>
          refreshLatestFundingRates(),
        ),
      ]),
  );
  clearTimeout(phase0Timeout);
  lease.throwIfLost("phase 0 prefetch");
  const coinglassOIMap =
    phase0Results[0].status === "fulfilled"
      ? phase0Results[0].value
      : new Map<string, CoinglassOIResult>();
  const _phase0Ms = Date.now() - _phase0StartMs;
  {
    let _cgAvail = 0;
    for (const sym of cgDiscoverySymbols)
      if (coinglassOIMap.get(sym)?.available) _cgAvail++;
    reportAggregatedOiCoverage(_cgAvail, cgDiscoverySymbols.length);
    const oiReasons: Record<string, number> = {};
    // Symbol lists for reasons that need a mapping/coverage fix (owner can see
    // which tickers are affected, not only the count).
    const oiReasonSymbols: Record<string, string[]> = {
      collision: [],
      unsupported: [],
    };
    for (const sym of cgDiscoverySymbols) {
      const r = coinglassOIMap.get(sym);
      if (r?.available) continue;
      const reason = r
        ? (r.unavailableReason ?? "no_reason_aborted")
        : "no_result";
      oiReasons[reason] = (oiReasons[reason] ?? 0) + 1;
      oiReasonSymbols[reason]?.push(sym);
    }
    _cycleMetricPhases.oiPhase = {
      deadlineMs: PHASE0_TIMEOUT_MS,
      elapsedMs: Date.now() - _phase0StartMs,
      timedOut: phase0TimedOut,
      requested: cgDiscoverySymbols.length,
      universe: allBingxSymbols.length,
      available: _cgAvail,
      notAvailableByReason: oiReasons,
      collisionSymbols: oiReasonSymbols.collision,
      unsupportedSymbols: oiReasonSymbols.unsupported,
      missedDeadline:
        (oiReasons["no_reason_aborted"] ?? 0) + (oiReasons["no_result"] ?? 0),
      breakerSkipped: oiReasons["breaker_skip"] ?? 0,
      source: drainCgOiSourceCounts(),
      snapshot: {
        waitedMs: _snapshotMs,
        pinned: cycleSnapshot
          ? { loadedAt: cycleSnapshot.loadedAt, rows: cycleSnapshot.rows.size }
          : null,
        loads: drainCoinsMarketsLoadStats(),
      },
    };
    _cycleMetricPhases.autoRangeHistoryAtCycleStart =
      autoRangeHistoryCoverage(allBingxSymbols);
  }
  logger.info(
    {
      phase0Ms: _phase0Ms,
      phase0TimedOut,
      oiSymbolsRequested: cgDiscoverySymbols.length,
      oiUniverseSize: allBingxSymbols.length,
      fundingSymbols:
        phase0Results[2]?.status === "fulfilled" ? phase0Results[2].value : 0,
      fundingAgeMs:
        _latestFrMapUpdatedAt > 0 ? Date.now() - _latestFrMapUpdatedAt : null,
    },
    "⏱ Scan Phase 0: external prefetch",
  );
  const _phase1StartMs = Date.now();

  // ── Whale Tracker: дневной снимок OI (1 раз в сутки, UTC) ──────────────────
  // saveDailyOiSnapshots() сама игнорирует дубли (symbol+date), но гейт по дате
  // здесь нужен чтобы не делать ~500 лишних SELECT на дубли каждый скан-цикл.
  const todayUtc = new Date().toISOString().slice(0, 10);
  if (todayUtc !== lastOiSnapshotDate) {
    lastOiSnapshotDate = todayUtc;
    const priceMap = new Map<string, number>();
    const volume24hMap = new Map<string, number>();
    for (const s of scored) {
      priceMap.set(s.ticker.symbol, parseFloat(s.ticker.lastPrice) || 0);
      volume24hMap.set(
        s.ticker.symbol,
        aggregatedVolume24hUsd(s.ticker.symbol),
      );
    }
    saveDailyOiSnapshots(coinglassOIMap, priceMap, volume24hMap).catch((err) =>
      logger.error({ err }, "Whale Tracker: daily OI snapshot save failed"),
    );
  }

  // ── Prescan OI refresh (early, unconditional) ──────────────────────────────
  // coinglassOIMap содержит данные для всех ~500 токенов.
  // OI пишется в prescanTracker также внутри глубокого скана (строки ~1460),
  // НО туда попадают только токены из usdtTickers (топ-N по activity score,
  // отфильтрованные isExhaustedByTicker >25%).
  // Токены в prescanTracker с price24h > 25% вылетают из usdtTickers →
  // их OI-поля никогда не обновляются → показывают "BingX Only" навсегда.
  // Решение: обновляем OI для ВСЕХ prescan-записей прямо здесь, из только
  // что полученного coinglassOIMap — до глубокого скана.
  for (const [sym, pe] of prescanTracker.entries()) {
    const cg = coinglassOIMap.get(sym);
    if (!cg) continue;
    if (cg.available) {
      // prevOi30m приходит прямо из OHLC candle[-2] — цикл-сдвиг больше не нужен.
      // History missing => prevOi30m null (no substitution, gates see unavailable).
      pe.prevOi30m = cg.prevOi30m ?? null;
      pe.prevOi4h = pe.lastOi4h ?? null;
      pe.lastOi30m = cg.oiChange30m ?? null;
      pe.lastOi1h = cg.oiChange1h ?? null;
      pe.lastOi4h = cg.oiChange4h ?? null;
      pe.lastOi24h = cg.oiChange24h ?? null;
      pe.lastCgTimedOut = false;
      pe.cgNoDataCount = 0;
      pe.lastOiAt = Date.now();
      // Ускорение OI 30m: отношение текущего к предыдущему (оба должны быть > 0).
      pe.oiAccel30m =
        pe.prevOi30m != null && pe.prevOi30m > 0 && (pe.lastOi30m ?? 0) > 0
          ? (pe.lastOi30m ?? 0) / pe.prevOi30m
          : null;
      // Подряд 4h-периодов роста OI — из OHLC напрямую (точнее, чем per-cycle счётчик).
      pe.oi4hConsecGrowth = cg.historyMissing
        ? undefined
        : (cg.oi4hConsecFromOhlc ?? 0);
    } else if (cg.timedOut) {
      pe.lastCgTimedOut = true;
      // cgNoDataCount НЕ сбрасываем: CG timeout ≠ токен покрывается CoinGlass.
      // Подтверждённые BingX-only токены не должны терять статус при временных сбоях CG.
    } else {
      // available=false + timedOut=false → пустой ответ CoinGlass.
      // НЕ помечаем сразу "BingX only" — может быть временный сбой API, формат символа, rate limit.
      // Только после 3 ПОДРЯД пустых ответов считаем подтверждённым отсутствием данных.
      logger.debug(
        { symbol: sym },
        "CG OI: available=false, timedOut=false — токен не покрывается CoinGlass",
      );
      pe.cgNoDataCount = (pe.cgNoDataCount ?? 0) + 1;
      if (pe.cgNoDataCount >= 3) {
        pe.lastCgTimedOut = false; // 3+ циклов подряд: действительно нет данных
      } else {
        pe.lastCgTimedOut = true; // 1-2 цикла: трактуем как временный сбой, ретраим в след цикле
      }
    }
  }

  // ── Prescan OI DB refresh: обновляем стейл-записи в DB ───────────────────
  // Токены удалённые из in-memory prescanTracker (вышли из топ-N или isExhaustedByTicker)
  // оставляют в DB запись с null OI-полями → UI показывает "BingX only" ошибочно.
  // Решение: если CG знает токен (available=true) — записываем свежие OI данные прямо в DB,
  // минуя in-memory tracker. Fire-and-forget, не блокирует скан-цикл.
  void (async () => {
    try {
      const inMemSymbols = new Set(prescanTracker.keys());
      markCycleStep("dbRead-4726");
      const read = await dbReadWithRetry(
        "Prescan OI stale-row refresh",
        () =>
          db
            .select({ symbol: prescanTrackerTable.symbol })
            .from(prescanTrackerTable)
            .orderBy(desc(prescanTrackerTable.updatedAt))
            .limit(1_000),
        1,
        0,
        4_000,
      );
      if (!read.ok) {
        logger.warn(
          "Prescan OI DB refresh skipped after bounded tracker read timeout",
        );
        return;
      }
      const dbRows = read.value;
      const now = new Date();
      let updated = 0;
      for (const { symbol } of dbRows) {
        if (inMemSymbols.has(symbol)) continue;
        const cg = coinglassOIMap.get(symbol);
        if (!cg?.available) continue;
        // void + dbWriteBestEffort: per-symbol в цикле — зависание без таймаута умножается
        // на кол-во символов; fire-and-forget (некритичное обновление OI)
        void dbWriteBestEffort("prescanTracker/oi-update", () =>
          db
            .update(prescanTrackerTable)
            .set({
              lastOi30m: cg.oiChange30m ?? null,
              lastOi1h: cg.oiChange1h ?? null,
              lastOi4h: cg.oiChange4h ?? null,
              lastOi24h: cg.oiChange24h ?? null,
              // false = "CG asked, no data" (vs null = never asked, true = timed out)
              lastCgTimedOut: false,
              updatedAt: now,
            })
            .where(eq(prescanTrackerTable.symbol, symbol)),
        );
        updated++;
      }
      if (updated > 0)
        logger.debug(
          { updated },
          "Prescan OI DB refresh: стейл-записи обновлены",
        );
    } catch (err) {
      logger.warn({ err }, "Prescan OI DB refresh: ошибка");
    }
  })();

  const tickerBySymbol = new Map(
    scored.map((s) => [s.ticker.symbol, s.ticker]),
  );
  const topByVolumeSet = new Set(topByVolume.map((t) => t.symbol));

  const oiMoverTickers: BingXTicker[] = [];
  let _l3Total = 0;
  for (const [sym, oi] of coinglassOIMap.entries()) {
    if (!oi.available) continue;
    const hasSpike =
      (oi.oiChange30m !== null && Math.abs(oi.oiChange30m) >= 6.0) ||
      (oi.oiChange1h !== null && Math.abs(oi.oiChange1h) >= 3.0) ||
      (oi.oiChange4h !== null && Math.abs(oi.oiChange4h) >= 8.0) ||
      (oi.oiChange24h !== null && Math.abs(oi.oiChange24h) >= 10.0);
    if (!hasSpike) continue;
    _l3Total++;
    if (
      activeSymbols.has(sym) ||
      watchlistSymbolsFound.has(sym) ||
      topByVolumeSet.has(sym)
    )
      continue;
    const ticker = tickerBySymbol.get(sym);
    if (!ticker) continue;
    if (isExhaustedByTicker(sym, ticker.priceChangePercent)) continue;
    oiMoverTickers.push(ticker);
  }
  lastLayerDebug.l3CandidatesTotal = _l3Total;
  lastLayerDebug.l3PassedToBatch = oiMoverTickers.length;
  if (oiMoverTickers.length > 0) {
    logger.info(
      {
        count: oiMoverTickers.length,
        symbols: oiMoverTickers.slice(0, 10).map((t) => t.symbol),
      },
      "🌐 OI Universe Discovery: найдены OI movers за пределами топ-N BingX",
    );
  }

  // ── Layer 4: BingX Volume Awakening — объём растёт без OI и без activity score ─
  // Ловит монеты которые «просыпаются» по объёму до того как price24h вырос
  // достаточно для попадания в Layer 1/2/3.
  //
  // Формула: per-token EMA дельт quoteVolume между соседними циклами (~10 мин).
  // Gate: delta > ema * 2.5 && delta > VOL_AWAKEN_MIN_DELTA_USD
  //
  // EMA (α=0.3): адаптируется к нормальному ритму каждого токена.
  // Токен с постоянно высокими дельтами имеет высокую базу → относительный порог защищает.
  // Абсолютный пол $50k → защита от "2.5× от нуля" для тихих токенов.
  //
  // Холодный старт (2 цикла прогрева, gate не проверяется):
  //   Цикл 1: нет записи → prev=curVol, ema=null, пропуск.
  //   Цикл 2: ema=null → ema=delta, пропуск (инициализация, не сравнение).
  //   Цикл 3+: нормальный gate.
  const volAwakenSet = new Set([
    ...activeSymbols,
    ...watchlistSymbolsFound,
    ...topByVolumeSet,
    ...oiMoverTickers.map((t) => t.symbol),
  ]);
  const volAwakenTickers: BingXTicker[] = [];
  for (const s of scored) {
    const sym = s.ticker.symbol;
    if (volAwakenSet.has(sym)) continue;

    const _price24h = parseFloat(s.ticker.priceChangePercent) || 0;
    const curVol = aggregatedVolume24hUsd(sym);
    const cached = prevQuoteVolCache.get(sym);

    // Всегда обновляем кэш ДО gate — иначе токены вне price24h-диапазона
    // теряют дельту в момент перехода в диапазон (Fix A, сохраняем поведение).
    if (!cached) {
      // Цикл 1: первое наблюдение — только затравка, no gate.
      prevQuoteVolCache.set(sym, { prev: curVol, ema: null });
      continue;
    }
    const { prev: prevVol, ema: prevEma } = cached;
    const delta = curVol - prevVol;

    if (prevEma === null) {
      // Цикл 2: инициализируем EMA = delta (без gate — нечего сравнивать).
      prevQuoteVolCache.set(sym, { prev: curVol, ema: Math.max(0, delta) });
      continue;
    }

    // Цикл 3+: обновляем EMA и проверяем gate.
    // Math.max снаружи: отрицательная delta РЕАЛЬНО тянет EMA вниз (симметрично),
    // но итоговое значение не уходит в минус. Если бы клампали delta до подстановки
    // (Math.max(0,delta)), EMA не реагировала бы на затухание — база залипала бы
    // на прошлом спайке надолго.
    const newEma = Math.max(0, 0.3 * delta + 0.7 * prevEma);
    prevQuoteVolCache.set(sym, { prev: curVol, ema: newEma });

    // ── Layer 4: Spot Volume surge ───────────────────────────────────────────
    // Единственное условие: спот объём 1h вырос ≥2x vs 5-цикловое среднее.
    // Фьюч-дельта (delta > EMA × 2.5) убрана — Layer 4 теперь только спот.
    {
      const _peL4 = prescanTracker.get(sym);
      if (_peL4?.spotVolAvg1h && _peL4?.lastSpotVol1h) {
        lastLayerDebug.l4CandidatesTotal++;
      }
      if (
        (_peL4?.spotVolCycles ?? 0) >= 2 &&
        _peL4?.spotVolAvg1h &&
        _peL4?.lastSpotVol1h
      ) {
        const spotMult = _peL4.lastSpotVol1h / _peL4.spotVolAvg1h;
        if (spotMult >= 1.5) {
          const ticker = tickerBySymbol.get(sym);
          if (ticker) {
            volAwakenTickers.push(ticker);
            volAwakenSet.add(sym);
          }
          continue;
        }
      }
    }
  }
  if (volAwakenTickers.length > 0) {
    logger.info(
      {
        count: volAwakenTickers.length,
        symbols: volAwakenTickers.slice(0, 10).map((t) => t.symbol),
      },
      "📊 Layer 4 Volume Awakening: монеты с ускорением объёма вне топ-N",
    );
  }
  lastLayerDebug.l4PassedToBatch = volAwakenTickers.length;
  {
    const l4PrescanWithSpotData = [...prescanTracker.values()].filter(
      (pe) =>
        pe.spotVolAvg1h && pe.lastSpotVol1h && (pe.spotVolCycles ?? 0) >= 2,
    ).length;
    logger.info(
      { total: l4PrescanWithSpotData, passed: volAwakenTickers.length },
      "📊 L4 debug: токенов с spotVol данными / прошло в батч",
    );
  }

  // ── Layer 5: OI Acceleration — ускоряющийся OI без объёмного спайка ──────────
  // Детектирует паттерн "Slow Whale Bleed" (тип ROSE): OI маленький (0.3–1%/30m),
  // но растёт от цикла к циклу: prev=0.3% → cur=0.58% → oiAccel=1.9x.
  // Ни Layer 1–4 не ловят: нет volMult спайка, OI ниже порогов Layer 3.
  // Необходимо: prevOi30m > 0 (значит CG отвечал в прошлом цикле тоже).
  const oiAccelSet = new Set([
    ...activeSymbols,
    ...watchlistSymbolsFound,
    ...topByVolumeSet,
    ...oiMoverTickers.map((t) => t.symbol),
    ...volAwakenTickers.map((t) => t.symbol),
  ]);
  const oiAccelTickers: BingXTicker[] = [];
  for (const [sym, pe] of prescanTracker.entries()) {
    if (oiAccelSet.has(sym)) continue;
    if ((pe.lastOi30m ?? 0) < 0.3) continue; // минимальный OI сигнал
    if ((pe.prevOi30m ?? 0) < 0.15) continue; // прошлый цикл тоже был положительный
    if ((pe.oiAccel30m ?? 0) < 1.3) continue; // ускорение ≥1.3x — не случайный шум
    const ticker = tickerBySymbol.get(sym);
    if (!ticker) continue;
    if (isExhaustedByTicker(sym, ticker.priceChangePercent)) continue;
    oiAccelTickers.push(ticker);
    oiAccelSet.add(sym);
  }
  if (oiAccelTickers.length > 0) {
    logger.info(
      {
        count: oiAccelTickers.length,
        symbols: oiAccelTickers.slice(0, 8).map((t) => {
          const pe = prescanTracker.get(t.symbol);
          return `${t.symbol}(oi=${pe?.lastOi30m?.toFixed(2)}%,x${pe?.oiAccel30m?.toFixed(1)})`;
        }),
      },
      "📈 Layer 5 OI Accel: токены с ускоряющимся OI добавлены в батч",
    );
  }
  lastLayerDebug.l5PassedToBatch = oiAccelTickers.length;

  // ── Layer 8: Steady Climbers — устойчивый рост цены между циклами ────────────
  // Ловит токены которые методично растут +0.8–8% каждые ~10 минут, не попадая
  // в Layer 1-7 (нет объёмного спайка, нет OI-данных или OI слабый).
  // Пример: HOME росло +5-6%/цикл → на момент первого прескана уже +39.9%.
  // Обновляем steadyClimbMap для ВСЕХ ~520 токенов каждый цикл — не только тех,
  // что прошли другие слои. Инжект только если 3+ цикла подряд рост + не перегрет.
  const steadyClimberExcludeSet = new Set([
    ...activeSymbols,
    ...watchlistSymbolsFound,
    ...topByVolumeSet,
    ...oiMoverTickers.map((t) => t.symbol),
    ...volAwakenTickers.map((t) => t.symbol),
    ...oiAccelTickers.map((t) => t.symbol),
  ]);
  const steadyClimberTickers: BingXTicker[] = [];
  const steadyClimberAdded = new Set<string>();

  for (const s of scored) {
    const sym = s.ticker.symbol;
    const curPrice = parseFloat(s.ticker.lastPrice) || 0;
    // BingX возвращает 0 при ресете 24h-окна → fallback на kline-проверенный lastPrice24h,
    // иначе перегретый токен (p24h < 40 гейт) проходит в Layer 8 при реальном росте >40%.
    const _rawP24hSc = parseFloat(s.ticker.priceChangePercent) || 0;
    const price24h =
      _rawP24hSc !== 0
        ? _rawP24hSc
        : (prescanTracker.get(sym)?.lastPrice24h ?? 0);

    const prev = steadyClimbMap.get(sym);
    if (prev && prev.lastPrice > 0 && curPrice > 0) {
      const growthPct = ((curPrice - prev.lastPrice) / prev.lastPrice) * 100;
      if (growthPct >= 0.8 && growthPct <= 8.0) {
        steadyClimbMap.set(sym, {
          growthCycles: prev.growthCycles + 1,
          lastPrice: curPrice,
        });
      } else {
        steadyClimbMap.set(sym, { growthCycles: 0, lastPrice: curPrice });
      }
    } else {
      steadyClimbMap.set(sym, { growthCycles: 0, lastPrice: curPrice });
    }

    const entry = steadyClimbMap.get(sym)!;
    if (
      entry.growthCycles >= 2 && // 3+ точек роста подряд
      price24h >= 0 &&
      price24h < 40 && // не падающий и не перегрет (нижний порог 3%→0%: ранняя детекция при price24h 0-3%)
      !steadyClimberExcludeSet.has(sym)
    ) {
      const ticker = tickerBySymbol.get(sym);
      if (ticker) {
        steadyClimberTickers.push(ticker);
        steadyClimberAdded.add(sym);
      }
    }
  }

  if (steadyClimberTickers.length > 0) {
    logger.info(
      {
        count: steadyClimberTickers.length,
        symbols: steadyClimberTickers.slice(0, 10).map((t) => {
          const e = steadyClimbMap.get(t.symbol);
          return `${t.symbol}(${e?.growthCycles}cyc,p24:${(parseFloat(t.priceChangePercent) || 0).toFixed(1)}%)`;
        }),
      },
      "📈 Layer 8 Steady Climbers: токены с устойчивым ростом добавлены в батч",
    );
  }
  lastLayerDebug.l8SteadyGrowthCycles = [...steadyClimbMap.values()].filter(
    (e) => e.growthCycles >= 2,
  ).length;
  lastLayerDebug.l8PassedToBatch = steadyClimberTickers.length;

  // Impulse Buy has no p24 gate. Symbols excluded from the ordinary activity
  // and volume layers solely because p24 is outside -40..+40 must still reach
  // the deep scan, where the closed-candle Impulse formula is evaluated.
  const impulseP24UnrestrictedTickers = scored
    .filter((s) =>
      isExhaustedByTicker(s.ticker.symbol, s.ticker.priceChangePercent),
    )
    .map((s) => s.ticker);
  const usdtTickers = [
    ...watchlistTickers,
    ...topByActivity,
    ...topByVolume,
    ...oiMoverTickers,
    ...volAwakenTickers,
    ...oiAccelTickers,
    ...steadyClimberTickers,
    ...impulseP24UnrestrictedTickers,
  ];
  // Freeze the ordinary pattern universe before Quiet Prescan and OI Watch
  // injections. Symbols added only by those sources are Stealth-only.
  const normalScanTickers = [...usdtTickers];
  const scanLimit = activityLimit;

  // ── Quiet Prescan Scan: каждые 3 цикла проверяем паттерны для тихих токенов ──
  // Токены которые давно в prescanTracker (cycleCount > 5) но не попали в активный батч
  // (не прошли Layer 1-4 в этом цикле) никогда не проходят проверку паттернов.
  // Каждые 3 скана добавляем до 50 таких токенов в usdtTickers для полного deep scan.
  // OI данные для них уже свежие (обновлены выше из coinglassOIMap).
  // Сортировка: по lastOi30m desc — самые сильные OI-сигналы первыми.
  if (scanCycleCounter > 1 && scanCycleCounter % 3 === 0) {
    const activeBatchSet = new Set(usdtTickers.map((t) => t.symbol));
    const scoredMap = new Map(scored.map((s) => [s.ticker.symbol, s.ticker]));
    const quietTickers = [...prescanTracker.entries()]
      .filter(
        ([sym, pe]) =>
          !activeBatchSet.has(sym) &&
          Date.now() - (pe.firstSeenAt ?? Date.now()) >= 30 * 60_000,
      )
      .sort(([, a], [, b]) => (b.lastOi30m ?? 0) - (a.lastOi30m ?? 0))
      .slice(0, 50)
      .flatMap(([sym]) => {
        const t = scoredMap.get(sym);
        return t ? [t] : [];
      });
    if (quietTickers.length > 0) {
      usdtTickers.push(...quietTickers);
      logger.info(
        {
          count: quietTickers.length,
          cycle: scanCycleCounter,
          symbols: quietTickers.slice(0, 5).map((t) => t.symbol),
        },
        "🔬 Quiet Prescan: тихие токены добавлены в батч для проверки паттернов",
      );
    }
    lastLayerDebug.quietPrescanAdded = quietTickers.length;
  }

  // ── Layer 7: OI Watch Orphans — cg_building/cg_timeout без prescan ───────────
  // Токены попавшие в OI Watch через cg_building/cg_timeout никогда не проходят
  // prescan → whale_futures условия для них никогда не проверяются.
  // Пример: ROSE (Slow Whale Bleed) — OI накапливается тихо, ни один Layer 1–6
  // не замечает, но cg_building поймал. Инжектируем в батч для полного deep scan.
  {
    const orphanBatchSet = new Set(usdtTickers.map((t) => t.symbol));
    try {
      markCycleStep("orphanRows");
      const orphanRows = await db
        .select({ symbol: oiWatchTable.symbol })
        .from(oiWatchTable)
        .where(
          and(
            inArray(oiWatchTable.triggerTf, [
              "cg_building",
              "cg_timeout",
              "oi24h_accum",
            ]),
            inArray(oiWatchTable.status, ["watching", "confirming"]),
            gt(oiWatchTable.expiresAt, new Date()),
          ),
        )
        .limit(80);
      const scoredBySymbol = new Map(
        scored.map((s) => [s.ticker.symbol, s.ticker]),
      );
      const orphanTickers: BingXTicker[] = [];
      for (const row of orphanRows) {
        if (orphanBatchSet.has(row.symbol)) continue;
        const ticker = scoredBySymbol.get(row.symbol);
        if (!ticker) continue;
        orphanTickers.push(ticker);
        orphanBatchSet.add(row.symbol);
      }
      if (orphanTickers.length > 0) {
        usdtTickers.push(...orphanTickers);
        logger.info(
          {
            count: orphanTickers.length,
            symbols: orphanTickers.map((t) => t.symbol),
          },
          "🔍 Layer 7 OI Watch Orphans: cg_building/cg_timeout/oi24h_accum токены добавлены в батч",
        );
      }
    } catch (err) {
      logger.debug(
        { err },
        "Layer 7 OI Watch Orphans: DB query failed (non-critical)",
      );
    }
  }

  const cgBlindRescueTagSet = new Set<string>(); // заполняется в блоке L6c ниже
  const oiLeaderTagSet = new Set<string>(); // заполняется в блоке L8b ниже

  // Layer 6c (Coinalyze blind OI rescue) removed: owner rule, aggregate-only,
  // no OI fallback to another source.

  // ── Layer 8: Proactive OI 24h Leaders → OI Watch ────────────────────────────
  // Берёт топ-100 по OI 24h из CoinGlass coins-markets (данные уже в coinglassOIMap)
  // и немедленно добавляет в OI Watch (status=watching, 12ч). Не ждёт паттерна —
  // это проактивный пул наблюдения. Layer 7 гарантирует инжекцию в батч следующего цикла.
  // Критерии: OI24h ≥ 8%, price24h -5..35%, не перегретые.
  // После вставки — добавляем в usdtTickers текущего цикла для немедленного глубокого скана.
  {
    const layer8Set = new Set(usdtTickers.map((t) => t.symbol));
    const layer8BySymbol = new Map(
      scored.map((s) => [s.ticker.symbol, s.ticker]),
    );
    const oi24hLeaders: Array<{
      symbol: string;
      oi24h: number;
      price: number;
      price24h: number;
      oi30m: number | null;
      oi1h: number | null;
    }> = [];

    for (const [sym, oi] of coinglassOIMap.entries()) {
      if (!oi.available) continue;
      const oi24h = oi.oiChange24h ?? 0;
      if (oi24h < 8) continue;
      const ticker8 = layer8BySymbol.get(sym);
      if (!ticker8) continue;
      const price24h = parseFloat(ticker8.priceChangePercent) || 0;
      if (price24h < -5 || price24h > 40) {
        if (price24h > 40) {
        }
        continue;
      }
      if (isExhaustedByTicker(sym, ticker8.priceChangePercent)) continue;
      const price = parseFloat(ticker8.lastPrice) || 0;
      if (price <= 0) continue;
      oi24hLeaders.push({
        symbol: sym,
        oi24h,
        price,
        price24h,
        oi30m: oi.oiChange30m ?? null,
        oi1h: oi.oiChange1h ?? null,
      });
    }

    oi24hLeaders.sort((a, b) => b.oi24h - a.oi24h);
    const top100Leaders = oi24hLeaders.slice(0, 50);

    if (top100Leaders.length > 0) {
      logger.info(
        {
          total: oi24hLeaders.length,
          taking: top100Leaders.length,
          top5: top100Leaders
            .slice(0, 5)
            .map((e) => `${e.symbol}(oi24h:${e.oi24h.toFixed(1)}%)`),
        },
        "📈 Layer 8: OI 24h лидеры — проверяем для проактивной вставки в OI Watch",
      );

      // Один запрос — все символы уже в вотче (избегаем N запросов в цикле)
      let alreadyWatchingSet = new Set<string>();
      try {
        const watchingRows = await db
          .select({ symbol: oiWatchTable.symbol })
          .from(oiWatchTable)
          .where(inArray(oiWatchTable.status, ["watching", "confirming"]));
        alreadyWatchingSet = new Set(watchingRows.map((r) => r.symbol));
      } catch {
        /* non-critical — если падает, пропускаем цикл */
      }

      let layer8Inserted = 0;
      const layer8NewTickers: BingXTicker[] = [];
      for (const entry of top100Leaders) {
        if (alreadyWatchingSet.has(entry.symbol)) continue;
        try {
          await dbWriteStrict("oiWatch/L8-insert", () =>
            db.insert(oiWatchTable).values({
              symbol: entry.symbol,
              triggerTf: "oi24h_accum",
              oiChange: entry.oi24h,
              priceAtEntry: entry.price,
              volumeMultiplier: 1.0,
              sentimentKey: null,
              status: "watching",
              addedAt: new Date(),
              expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12ч
              avgVolume: 0,
              isVolConfirmed: false,
              oi30mChange: entry.oi30m,
              oi1hChange: entry.oi1h,
              oi24hChange: entry.oi24h,
              price1hChange: null,
              price24hChange: entry.price24h,
              volStatusReason: null,
              entryVolMult: 1.0,
              entryCgTurnover: null,
            }),
          );
          alreadyWatchingSet.add(entry.symbol); // дедуп внутри цикла
          layer8Inserted++;
          state.oiWatchLastInsertAt = new Date();
          state.oiWatchInsertsLastScan++;

          // Добавляем в батч текущего цикла для немедленного глубокого скана
          if (!layer8Set.has(entry.symbol)) {
            const t8 = layer8BySymbol.get(entry.symbol);
            if (t8) {
              layer8NewTickers.push(t8);
              layer8Set.add(entry.symbol);
              oiLeaderTagSet.add(entry.symbol);
            }
          }
        } catch (err) {
          state.oiWatchInsertErrors++;
          state.oiWatchLastInsertError =
            err instanceof Error ? err.message : String(err);
          logger.debug(
            { err, symbol: entry.symbol },
            "Layer 8: OI Watch insert failed (non-critical)",
          );
        }
      }
      if (layer8NewTickers.length > 0) usdtTickers.push(...layer8NewTickers);
      if (layer8Inserted > 0) {
        logger.info(
          {
            inserted: layer8Inserted,
            injectedToBatch: layer8NewTickers.length,
          },
          "📈 Layer 8: OI 24h лидеры добавлены в OI Watch (12ч) + в батч текущего цикла",
        );
      }
      lastLayerDebug.l8bOiLeadersTotal = oi24hLeaders.length;
      lastLayerDebug.l8bInsertedToWatch = layer8Inserted;
    }
  }

  // ── Cycle candidates snapshot (for UI tab) ───────────────────────────────────
  {
    const wlSet = new Set(watchlistTickers.map((t) => t.symbol));
    const actSet = new Set(topByActivity.map((t) => t.symbol));
    const volSet = new Set(topByVolume.map((t) => t.symbol));
    const oiSet = new Set(oiMoverTickers.map((t) => t.symbol));
    const vaSet = new Set(volAwakenTickers.map((t) => t.symbol));
    const oacSet = new Set(oiAccelTickers.map((t) => t.symbol));
    const scSet = new Set(steadyClimberTickers.map((t) => t.symbol));
    const scoreMap = new Map(scored.map((s) => [s.ticker.symbol, s.score]));
    const seen = new Set<string>();
    lastCycleCandidates = [];
    lastCycleLayers.clear();
    for (const t of usdtTickers) {
      lease.throwIfLost("scanner symbol processing");
      if (seen.has(t.symbol)) continue;
      seen.add(t.symbol);
      const layers: string[] = [];
      if (wlSet.has(t.symbol)) layers.push("WL");
      if (actSet.has(t.symbol)) layers.push("L1");
      if (volSet.has(t.symbol)) layers.push("L2");
      if (oiSet.has(t.symbol)) layers.push("L3");
      if (vaSet.has(t.symbol)) layers.push("L4");
      if (oacSet.has(t.symbol)) layers.push("L5");
      if (cgBlindRescueTagSet.has(t.symbol)) layers.push("L6c");
      if (oiLeaderTagSet.has(t.symbol)) layers.push("L8b");
      // L8: поведенческий тег — навешивается на любой токен в пуле у которого
      // 3+ цикла устойчивого роста, независимо от того через какой слой он попал.
      // scSet — discovery (не дублирует пул); steadyClimbMap — полная поведенческая картина.
      {
        const sc = steadyClimbMap.get(t.symbol);
        const p24 = parseFloat(t.priceChangePercent) || 0;
        if (sc && sc.growthCycles >= 2 && p24 >= 0 && p24 < 40)
          layers.push("L8");
        else if (scSet.has(t.symbol)) layers.push("L8");
      }
      if (layers.length === 0) layers.push("L7");
      lastCycleLayers.set(t.symbol, layers);
      const _pe = prescanTracker.get(t.symbol);
      if (_pe) _pe.layers = layers;
      lastCycleCandidates.push({
        symbol: t.symbol,
        layers,
        price24h: parseFloat(t.priceChangePercent) || 0,
        price: parseFloat(t.lastPrice) || 0,
        score: scoreMap.get(t.symbol) ?? 0,
        cycledAt: Date.now(),
      });
    }
    lastCycleAt = Date.now();
    lastLayerDebug.cycleNumber = scanCycleCounter;
  }

  // ── Spot Pool: запускаем фоновое обновление кэша (non-blocking) ──────────────
  // Первый цикл — кэш холодный, фильтр пропускает оптимистично.
  // Через 30 мин кэш прогреется и ранний фильтр начнёт отсекать неликвид до klines.
  triggerRefresh(usdtTickers.map((t) => t.symbol));

  const topScore = scored[0]?.score?.toFixed(1) ?? "0";
  logger.info(
    {
      count: usdtTickers.length,
      watchlist: watchlistTickers.length,
      byActivity: topByActivity.length,
      byVolume: topByVolume.length,
      byOI: oiMoverTickers.length,
      bySteadyClimb: steadyClimberTickers.length,
      volSource: useCgVolume
        ? `CoinGlass(cache=${cgVolumeCache.size})`
        : "BingX",
      totalTokens: scored.length,
      topScore,
      top5: scored
        .slice(0, 5)
        .map((s) => `${s.ticker.symbol}(${s.score.toFixed(1)})`),
      watchlistSymbols: watchlistTickers.map((t) => t.symbol),
    },
    "Pre-screened tokens for deep scan",
  );

  // ── Persistent Pre-screen Tracker: обновляем счётчики ───────────────────────
  // Символы, впервые добавленные в prescanTracker в этом цикле.
  // После завершения всех update-циклов запускаем фоновый batch-fetch OB для них.
  const _newPrescanSyms: string[] = [];
  {
    const nowTs = Date.now();

    // currentTopSymbols включает ВСЕ слои глубокого скана: Layer 1 (activity),
    // Layer 3 (OI movers) и Layer 4 (VolAwaken) + watchlist.
    // Ранее — только Layer 1 → OI-муверы за пределами топ-50 удалялись каждый цикл
    // и никогда не накапливали cycleCount и OI-данные.
    const currentTopSymbols = new Set([
      ...topByActivity.map((t) => t.symbol),
      ...oiMoverTickers.map((t) => t.symbol),
      ...volAwakenTickers.map((t) => t.symbol),
      ...watchlistTickers.map((t) => t.symbol),
      ...oiAccelTickers.map((t) => t.symbol), // Layer 5 — иначе удаляются каждый цикл
      ...steadyClimberTickers.map((t) => t.symbol), // Layer 8 — без этого false-exit каждый цикл
    ]);

    // Удаляем токены, которые вышли из пула глубокого скана в этом цикле.
    // Сохраняем cycleCount перед удалением — если токен вернётся в следующем цикле
    // (напр. L2-токен с нестабильной активностью), он продолжит счёт, а не сбросится в 1.
    const savedCycleCounts = new Map<string, number>();
    // Reject-reason lookup: _symRejSnap was snapshotted at cycle start BEFORE
    // persistSymRejectLog() spliced _symRejLog — prior-cycle reasons are available here.
    for (const sym of prescanTracker.keys()) {
      if (!currentTopSymbols.has(sym)) {
        const pe = prescanTracker.get(sym)!;

        // Coverage-фикс: если spot_vol_* ещё не накопил 2 цикла — держим кандидата
        // в пуле ещё немного, вместо немедленного удаления (см. SPOT_VOL_GRACE_CYCLES).
        const needsSpotVolGrace = (pe.spotVolCycles ?? 0) < 2;
        if (needsSpotVolGrace) {
          pe.droppedFromPoolCycles = (pe.droppedFromPoolCycles ?? 0) + 1;
          if (pe.droppedFromPoolCycles <= SPOT_VOL_GRACE_CYCLES) {
            continue; // ещё один льготный цикл — не удаляем
          }
        }

        savedCycleCounts.set(sym, pe.cycleCount);
        prescanTracker.delete(sym);
      } else {
        // Вернулся в пул до истечения льготного периода — сбрасываем счётчик.
        const pe = prescanTracker.get(sym);
        if (pe && pe.droppedFromPoolCycles) pe.droppedFromPoolCycles = 0;
      }
    }

    // Обновляем или добавляем токены из Layer 1 (с трекингом score и ранга)
    for (let rank = 0; rank < scored.slice(0, activityLimit).length; rank++) {
      const s = scored[rank]!;
      const sym = s.ticker.symbol;
      const price24h = parseFloat(s.ticker.priceChangePercent) || 0;

      // Экстремальный памп или дамп: цена улетела >300% или <-300% за 24ч — в prescan не добавляем.
      // Явная знаковая проверка: price24h хранится со знаком (отрицательный = падение).
      if (price24h > 300 || price24h < -300) {
        prescanTracker.delete(sym);
        continue;
      }

      const lastPrice = parseFloat(s.ticker.lastPrice) || 0;
      const rankOneBased = rank + 1;
      const existing = prescanTracker.get(sym);
      if (existing) {
        existing.cycleCount++;
        // Сохраняем последнее ненулевое значение: BingX иногда возвращает "0" для priceChangePercent
        // при мизерном futures-объёме или в момент ресета 24h-окна — перетирать корректные данные нулём не нужно.
        existing.lastPrice24h = price24h || existing.lastPrice24h;
        existing.lastPrice = lastPrice;
        existing.lastScore = s.score;

        if (rankOneBased < existing.bestRank) existing.bestRank = rankOneBased;
      } else {
        const prevCount = savedCycleCounts.get(sym) ?? 0;
        prescanTracker.set(sym, {
          firstPrice24h: price24h,
          lastPrice24h: price24h,
          firstSeenAt: nowTs,
          firstPrice: lastPrice,
          cycleCount: prevCount + 1,
          bestRank: rankOneBased,
          lastScore: s.score,
          firstScore: s.score,
          lastPrice: lastPrice,
          lastFiredAt: 0,
          firstFundingRate: _latestFrMap.get(sym) ?? null,
        });
        _newPrescanSyms.push(sym);
      }
    }

    // Обновляем или добавляем токены из Layer 3 (OI movers), Layer 4 (VolAwaken), Layer 8 (Steady Climbers).
    // Они сканируются глубоко — должны накапливать cycleCount и получать OI-данные.
    for (const ticker of [
      ...oiMoverTickers,
      ...volAwakenTickers,
      ...steadyClimberTickers,
    ]) {
      const sym = ticker.symbol;
      const price24h = parseFloat(ticker.priceChangePercent) || 0;
      // Явная знаковая проверка: price24h хранится со знаком.
      if (price24h > 300 || price24h < -300) {
        prescanTracker.delete(sym);
        continue;
      }
      const lastPrice = parseFloat(ticker.lastPrice) || 0;
      const existing = prescanTracker.get(sym);
      if (existing) {
        existing.cycleCount++;
        existing.lastPrice24h = price24h || existing.lastPrice24h;
        existing.lastPrice = lastPrice;
      } else {
        const prevCount = savedCycleCounts.get(sym) ?? 0;
        prescanTracker.set(sym, {
          firstPrice24h: price24h,
          lastPrice24h: price24h,
          firstSeenAt: nowTs,
          firstPrice: lastPrice,
          cycleCount: prevCount + 1,
          bestRank: activityLimit + 1, // за пределами топ-N activity
          lastScore: 0,
          firstScore: 0,
          lastPrice: lastPrice,
          lastFiredAt: 0,
          firstFundingRate: _latestFrMap.get(sym) ?? null,
        });
        _newPrescanSyms.push(sym);
      }
    }

    // Обновляем или добавляем токены из Layer 0 (watchlist).
    // Они включены в currentTopSymbols (не удаляются из prescanTracker),
    // но без этого блока никогда не получали prescanTracker.set() →
    // inPrescan = false, price = null для watchlist-токенов.
    for (const ticker of watchlistTickers) {
      const sym = (ticker as BingXTicker).symbol;
      const price24h =
        parseFloat((ticker as BingXTicker).priceChangePercent) || 0;
      const lastPrice = parseFloat((ticker as BingXTicker).lastPrice) || 0;
      const existing = prescanTracker.get(sym);
      if (existing) {
        existing.cycleCount++;
        existing.lastPrice24h = price24h || existing.lastPrice24h;
        existing.lastPrice = lastPrice;
      } else {
        const prevCount = savedCycleCounts.get(sym) ?? 0;
        prescanTracker.set(sym, {
          firstPrice24h: price24h,
          lastPrice24h: price24h,
          firstSeenAt: nowTs,
          firstPrice: lastPrice,
          cycleCount: prevCount + 1,
          bestRank: 9999, // watchlist — вне ранжирования по активности
          lastScore: 0,
          firstScore: 0,
          lastPrice: lastPrice,
          lastFiredAt: 0,
          firstFundingRate: _latestFrMap.get(sym) ?? null,
        });
        _newPrescanSyms.push(sym);
      }
    }
  }

  // This DB save belongs to the bounded scan-end fence below. Starting it here
  // as `void` used to leave an orphaned Neon write when the cycle was aborted.

  // Fetch order-book data under the cycle signal; the endpoint's own deadline
  // composes with it, so no caller-side race can leave HTTP running behind us.
  // firstObRatio будет null при первом savePrescanToDb() этого цикла, но запишется
  // в следующем цикле через COALESCE в conflict SET.
  if (_newPrescanSyms.length > 0) {
    markCycleStep("prescan-orderbook");
    await trackScannerOperation("network:prescan-orderbook", async () => {
      try {
        const toFetch = _newPrescanSyms.slice(0, 15);
        await runConcurrent(
          toFetch,
          4,
          async (sym: string) => {
            const ob = await getOrderBookAnalysis(sym, 20).catch(() => null);
            if (ob?.bidAskRatio != null) {
              const pe = prescanTracker.get(sym);
              if (pe) {
                if (pe.firstObRatio == null) {
                  pe.firstObRatio = ob.bidAskRatio;
                }
                pe.lastObRatio = ob.bidAskRatio;
              }
            }
          },
          lease.signal,
        );
      } catch {
        // best-effort enrichment
      }
    });
  }

  // ── Phase 1: CoinGlass OI universe уже загружен на этапе OI Discovery ────────
  // coinglassOIMap содержит данные для всех ~500 токенов (из кэша или API).
  // Повторного запроса не нужно — данные свежие (только что получены выше).
  const oiMoversCount = oiMoverTickers.length;
  // cgVolumeCache is now populated from runSpotVolBatch (FS volume ratio endpoint: futures_vol_usd 24h).
  // The old cgVolUsd path (from OI snapshot) is always null since OHLC migration — nothing to update here.
  logger.info(
    {
      universe: allBingxSymbols.length,
      oiMovers: oiMoversCount,
      scanPool: usdtTickers.length,
      cgCacheSize: cgVolumeCache.size,
    },
    "CoinGlass OI universe complete",
  );

  // Phase 2: gather alpha candidates (klines + volume + pattern)
  const candidates: {
    symbol: string;
    price: number;
    priceChange30m: number;
    price1hChange: number | null;
    price3hChange: number;
    price4hChange: number; // Изменение цены за 4ч (8×30m) — для пост-памп фильтра
    price24hChange: number; // Изменение цены за 24ч — для gate на перегрев
    currentVolume: number;
    avgVolume: number;
    volumeMultiplier: number;
    oiChangePercent: number; // Best (max abs) из 5m/30m/1h OI — для скоринга
    oiChange1h: number | null; // Сырое 1h значение — для отображения в сигнале
    oiChange4h: number | null; // Сырое 4h значение — для отображения в сигнале
    oiChange24h: number | null; // Сырое 24h значение — для отображения в сигнале
    openInterest: number; // CoinGlass global OI in USD (or 0)
    sentiment: SentimentResult;
    coinglassOI: CoinglassOIResult;
    oiTriggerTf: string; // Какой ТФ сработал: "short", "30m", "short+30m", etc.
    isRepeatSignal: boolean; // символ уже был в сигналах за последние 24ч
    isConfirmedFire: boolean; // из confirming-очереди — пропускаем watching, стреляем сразу
    stealthArmId?: number; // frozen Stealth setup claimed by this candidate
    stealthDedupArmIds?: number[];
    stealthDetectionMethod?:
      | "quiet_zone_breakout"
      | "abneon_support_bounce"
      | typeof STEALTH_FRESH_HIGH_METHOD
      | typeof STEALTH_RANGE_4H_METHOD;
    stealthRangeConfirmingVenues?: string[];
    stealthBingxOnly?: boolean;
    stealthEntryPath?: string | null;
    stealthVolumeUnconfirmed?: boolean;
    stealthRangeLifecycleKey?: string | null;
    neonSupportBounceEvent?: {
      frozenLevel: number;
      armCandleTime: number;
      triggerCandleTime: number;
      confluence?: string | null;
    };
    isScalpOnly: boolean; // MTF Spot CVD: старшие ТФ (1h/4h) не подтверждают
    futVolMult: number; // оригинальный фьюч BingX volMult (до замены на спот)
    spotVol24h: number | null; // абсолютный спот-объём $ за 24ч (из SpotPool)
    futVol24hUsd: number; // агрегированный (CoinGlass) объём 24ч $ — для защиты от коллизий тикеров CG
    impulseDecision?: ImpulseBuyDecision;
    impulseFundingRate?: number | null;
    impulseSpotVolumeMultiplier?: number | null;
    impulseOi30m?: number | null;
    impulseCandleClosedAt?: Date | null;
    futTakerNetBuyPct?: number | null;
    plmSpotVolMult?: number | null;
    decisionMetrics?: Record<string, unknown>;
    baOiPath?: BullishAccumulationOiPath | null;
  }[] = [];

  // Track top-performers for debug log (even if they don't pass)
  const debugTop: {
    symbol: string;
    vol: number;
    cgOI: number | null;
    price: number;
  }[] = [];

  // TTL-очистка in-memory confirming fallback (записи старше 90 мин удаляем)
  const nowTtl = Date.now();
  for (const [sym, entry] of confirmingWatchMap) {
    if (nowTtl - entry.addedAt.getTime() > CONFIRMING_WATCH_TTL_MS) {
      confirmingWatchMap.delete(sym);
    }
  }

  // Skip reason counters for INFO-level diagnostics
  const _otherSkipReason = new Map<string, string>();
  const skipCount = {
    noKlines: 0,
    exhaustedPump: 0,
    deepNegative: 0,
    noOiNoVol: 0,
    contraSignal: 0,
    lowVolume: 0,
    repeatSignal: 0,
    stalePump: 0, // exit pump (vol>>OI) / ghost pump guard
    cooldown: 0, // stop-loss / cancelled / chronic token cooldown
    priceGate: 0, // цена не выросла ≥+0.5% от firstPrice за 3+ цикла
    noConfirming: 0, // OI Watch confirming window failed / insert failed
    priceTooHigh: 0, // stale signal (price moved too much) / runaway
    cvdFail: 0, // CVD негативный (MTF spot CVD, main CVD, confirmed fire)
    takerFail: 0, // Taker Flow негативный / funding перегрет
    spotFailNoData: 0, // SpotVol/MCap gate — нет данных в кэше/живом запросе
    spotFailLow: 0, // SpotVol/MCap gate — данные есть, но ниже порога 0.15%
    latePump: 0, // глобальный фильтр поздней записи: price3h > 8%
    wiObBear: 0, // WI < 0 + OB bear — оба медвежьи
    other: 0,
  };
  // gateRejectLog: per-token "почему не дошёл до deepScan" — для диагностики узких мест.
  // Только токены с реальным сигналом: prescan-tracked ИЛИ vol≥1.5x ИЛИ OI≥2%.
  // Группируется по gate и логируется одним entry в конце цикла — grep "GATE REJECT LOG".
  const gateRejectLog: Array<{
    sym: string;
    gate: string;
    oi30m: string;
    vol: string;
    price: string;
    extra: string;
  }> = [];
  const oiPassCount = { t30: 0, t1h: 0, t4h: 0, t24h: 0, anyOiPass: 0 };
  let spotFailLogCount = 0; // лимит диагностических логов на цикл

  const now = Date.now();
  _symRejCycleAt = new Date(now);

  // ── Pre-scan fresh prices для confirming inserts ─────────────────────────────
  // CoinGlass batch уже занял 8+ мин. Kline close = закрытие свечи (0-30 мин назад).
  // Чтобы priceAtEntry в confirming был реальной ценой в момент добавления —
  // берём свежий тикер прямо перед per-symbol loop.
  const confirmPriceMap = new Map<string, number>();
  try {
    markCycleStep("confirm-tickers");
    const confirmTickers = await getFutureTickers();
    for (const t of confirmTickers) {
      const p = parseFloat((t as any).lastPrice);
      if (p > 0) confirmPriceMap.set((t as any).symbol, p);
    }
  } catch {
    /* non-critical — falls back to kline close */
  }

  // Hard cap: если Neon/CoinGlass лагают и скан затягивается — прерываем через 22 мин.
  // Следующий запланированный скан (через ~5 мин) подберёт оставшиеся символы.
  // 22 мин < WATCHDOG_WARN_MS (35 мин) — watchdog никогда не видит "мёртвый" сканер.
  // Отсчёт от реального старта цикла (startTime), а не от этой точки: ранний
  // arm-проход и Phase 0 (до 5+ мин) раньше не входили в лимит, и цикл с
  // «Scan complete» на 27,65 мин упирался в 28-мин SCAN_HARD_TIMEOUT во время
  // финализации → scan_hard_timeout + settlement_fence_pending + watchdog.
  // 24 мин оставляют 4 мин на финализацию (PDB/reject-log/release lease).
  const MAX_SCAN_CYCLE_MS = 24 * 60_000;
  const cycleStartedAt = startTime;
  let symbolsProcessed = 0;

  // ── Pre-load OI Watch active entries (одним запросом до loop) ─────────────────
  // Заменяет два per-symbol SELECT внутри loop: cgFallbackConfirmingRows + alreadyQueued.
  // При Neon timeout — fallback false (консервативно: не добавляем дубли в OI Watch).
  const cgFallbackConfirmingSet = new Set<string>();
  const oiWatchActiveSet = new Set<string>();
  try {
    const oiWatchRows = await db
      .select({
        symbol: oiWatchTable.symbol,
        status: oiWatchTable.status,
        triggerTf: oiWatchTable.triggerTf,
      })
      .from(oiWatchTable)
      .where(inArray(oiWatchTable.status, ["watching", "confirming"]));
    for (const r of oiWatchRows) {
      oiWatchActiveSet.add(r.symbol);
      if (
        r.status === "confirming" &&
        ["cg_timeout", "cg_building", "dark_flow"].includes(r.triggerTf)
      ) {
        cgFallbackConfirmingSet.add(r.symbol);
      }
    }
    logger.debug(
      { total: oiWatchRows.length, fallback: cgFallbackConfirmingSet.size },
      "OI Watch pre-load done",
    );
  } catch (err) {
    logger.warn(
      { err },
      "OI Watch pre-load failed — per-symbol DB queries disabled, cgFallback=false",
    );
  }

  // Символы для batch expire после loop (вместо per-symbol await внутри loop)
  const oiWatchToExpire: string[] = [];

  // CVD snapshot по символу — заполняется в главном цикле, читается при signalsToInsert.push
  const _spotCvdMapScan = new Map<
    string,
    Awaited<ReturnType<typeof getSpotCvdMtf>>
  >();
  // symbol → spotVolMult (lastSpotVol1h / spotVolAvg1h), рассчитан в loop1.
  // Мост в loop2/confirmed-fire для универсальной записи entrySpotVolMult:
  // раньше поле заполнялось только на spot_vol_* путях (res._spotVolMult),
  // из-за чего в tracked_signals было 20 non-null строк из сотен сигналов.
  const _spotVolMultMapScan = new Map<string, number>();

  // Патерны, прошедшие свой внутренний гейт в loop1 (по символу) — читается в loop2,
  // когда уже известны bulletScore/finalSentiment.key, чтобы diagPatternPassed мог
  // однозначно показать: срезался ли конкретный проход на alphaScore<5 или на приоритете det.
  const _passedGatePatternsMap = new Map<string, string[]>();
  const _markPassedGate = (symbol: string, pattern: string) => {
    const arr = _passedGatePatternsMap.get(symbol);
    if (arr) arr.push(pattern);
    else _passedGatePatternsMap.set(symbol, [pattern]);
  };

  // Stealth evaluates the complete current Prescan/OI Watch universe, while
  // keeping symbols injected here isolated from every other pattern.
  // This is the true normal-market snapshot. `usdtTickers` may already have
  // supplemental symbols from other discovery paths and must not become the
  // generic 30m/CG/full-strategy universe.
  const genericScanTickers = [...normalScanTickers];
  const stealthTickerBySymbol = new Map(
    tickers.map((ticker) => [ticker.symbol, ticker]),
  );
  // Reviewed false entries remain observation-only until a distinct, valid
  // Stealth signal fires. Do not rely on their old active tracker status to
  // keep either symbol in the scan pool after neutral reclassification.
  markCycleStep("reviewed-watch-read");
  const reviewedWatchRead = await dbReadWithRetry(
    "Reviewed Stealth observation watch",
    () =>
      db.execute(sql`
        SELECT t.symbol
          FROM tracked_signals t
         WHERE (t.id, t.signal_id, t.symbol) IN (
           (1910, 10452, 'APEX-USDT'),
           (1909, 10363, 'MEW-USDT')
         )
           AND t.sentiment_key = 'stealth_breakout'
           AND (
             t.status IN ('active', 'in_run')
             OR (
               t.status = 'reclassified'
               AND t.cancel_reason = 'false_breakout_reclassified'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM tracked_signals newer
              WHERE newer.symbol = t.symbol
                AND newer.sentiment_key = 'stealth_breakout'
                AND newer.id > t.id
                AND newer.status <> 'reclassified'
           )
      `),
    1,
    0,
    4_000,
  );
  if (!reviewedWatchRead.ok) {
    logger.error("Reviewed Stealth observation watch unavailable this cycle");
  }
  const reviewedWatchSymbols = reviewedWatchRead.ok
    ? (reviewedWatchRead.value.rows as Array<{ symbol: string }>).map(
        (row) => row.symbol,
      )
    : [];
  let activeRangeArms: Awaited<
    ReturnType<typeof listActiveAutoRange4hArms>
  >["arms"] = [];
  let activeRangeArmTotal = 0;
  let secondaryOneHourArmSymbols = new Set<string>();
  if (AUTO_RANGE_1H_LIVE_ENABLED) {
    try {
      markCycleStep("secondary-arm-symbols");
      secondaryOneHourArmSymbols = await listSecondaryOneHourArmSymbols();
    } catch (err) {
      logger.warn({ err }, "Secondary 1H Range arm list unavailable");
    }
  }
  if (AUTO_RANGE_LIVE_ENABLED || AUTO_RANGE_1H_LIVE_ENABLED) {
    try {
      // Every armed arm of a live timeframe is visited each cycle: paging 50
      // per cycle delayed 1H breakout checks by hours for out-of-top symbols.
      const activeRangeArmPage = await listActiveAutoRange4hArms(
        1000,
        autoRangeScanCursor,
        [
          ...(AUTO_RANGE_LIVE_ENABLED ? (["auto_range_4h"] as const) : []),
          ...(AUTO_RANGE_1H_LIVE_ENABLED ? (["auto_range_1h"] as const) : []),
        ],
      );
      activeRangeArms = activeRangeArmPage.arms;
      activeRangeArmTotal = activeRangeArmPage.totalCount;
      autoRangeScanCursor = activeRangeArmPage.nextCursor;
    } catch (err) {
      logger.warn({ err }, "Active 4H Range arm scan candidates unavailable");
    }
  }
  const activeRangeArmSymbols = new Set(
    activeRangeArms.map((arm) => arm.symbol),
  );
  // Prescan union is unconditional; OI Watch is an independent augmentation.
  // A failed OI query must never remove current Prescan symbols.
  let stealthPool = buildStealthScanPool({
    normalTickers: normalScanTickers,
    tickerBySymbol: stealthTickerBySymbol,
    rangeArmSymbols: activeRangeArmSymbols,
    prescanSymbols: [...prescanTracker.keys(), ...reviewedWatchSymbols],
    oiWatchSymbols: [],
  });
  let stealthOnlySymbols = stealthPool.supplementalSymbols;
  let activeOiWatchSymbols: string[] = [];
  try {
    markCycleStep("active-oi-watch-rows");
    const activeOiWatchRows = await db
      .select({ symbol: oiWatchTable.symbol })
      .from(oiWatchTable)
      .where(
        and(
          inArray(oiWatchTable.status, ["watching", "confirming"]),
          gt(oiWatchTable.expiresAt, new Date()),
        ),
      );
    activeOiWatchSymbols = activeOiWatchRows.map((row) => row.symbol);
    stealthPool = buildStealthScanPool({
      normalTickers: normalScanTickers,
      tickerBySymbol: stealthTickerBySymbol,
      rangeArmSymbols: activeRangeArmSymbols,
      prescanSymbols: [...prescanTracker.keys(), ...reviewedWatchSymbols],
      oiWatchSymbols: activeOiWatchSymbols,
    });
    stealthOnlySymbols = stealthPool.supplementalSymbols;
    logger.info(
      {
        total: stealthPool.tickers.length,
        supplemental: stealthOnlySymbols.size,
      },
      "Stealth pool union ready (normal pool preserved)",
    );
  } catch (err) {
    logger.debug(
      { err, supplemental: stealthOnlySymbols.size },
      "Stealth pool OI Watch union unavailable",
    );
  }
  // A Range-arm-only ticker gets no Neon, Whale Watch, or generic pattern
  // eligibility. Symbols independently present in Prescan/OI Watch retain
  // their pre-existing Stealth-only supplemental eligibility.
  const existingStealthSupplementalSymbols = new Set([
    ...prescanTracker.keys(),
    ...reviewedWatchSymbols,
    ...activeOiWatchSymbols,
  ]);
  const rangeOnlyArmSymbols = new Set(
    [...activeRangeArmSymbols].filter(
      (symbol) =>
        !genericScanTickers.some((ticker) => ticker.symbol === symbol) &&
        !existingStealthSupplementalSymbols.has(symbol),
    ),
  );
  const persistedDeliveryTickers: typeof usdtTickers = [];

  // Delivery is sourced from the durable qualified ledger, not only from
  // this cycle's detector result. Keep the queue bounded and oldest-first so
  // a restart or an unrelated gate failure cannot lose a valid event.
  let persistedNeonSupportEvents = new Map<
    string,
    {
      frozenLevel: number;
      armCandleTime: number;
      triggerCandleTime: number;
      confluence?: string | null;
    }
  >();
  try {
    // Owner 2026-10-25: Neon enters at detection or not at all. A qualified
    // event that was already offered to a scan and did not fire is closed
    // instead of waiting for later gates to pass at a higher price.
    const listedNeon = await listQualifiedAbneonSupportBounces(100);
    const alreadyOffered = listedNeon.filter((row) =>
      neonOfferedEventKeys.has(`${row.symbol}:${row.triggerCandleTime}`),
    );
    if (alreadyOffered.length > 0) {
      await expireOfferedNeonSupportEvents(alreadyOffered.map((r) => r.id));
      for (const row of alreadyOffered) {
        neonOfferedEventKeys.delete(`${row.symbol}:${row.triggerCandleTime}`);
      }
    }
    const offeredIds = new Set(alreadyOffered.map((row) => row.id));
    persistedNeonSupportEvents = routePersistedNeonSupportBounces(
      listedNeon.filter((row) => !offeredIds.has(row.id)),
    );
    for (const symbol of persistedNeonSupportEvents.keys()) {
      const ticker = stealthTickerBySymbol.get(symbol);
      if (
        ticker &&
        !genericScanTickers.some((item) => item.symbol === symbol) &&
        !persistedDeliveryTickers.some((item) => item.symbol === symbol)
      ) {
        persistedDeliveryTickers.push(ticker);
        stealthOnlySymbols.add(symbol);
        rangeOnlyArmSymbols.delete(symbol);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Neon Support Bounce qualified queue unavailable");
  }
  const neonUniverse = buildNeonUniverse(
    genericScanTickers.map((ticker) => ticker.symbol),
    [...stealthOnlySymbols].filter(
      (symbol) => !rangeOnlyArmSymbols.has(symbol),
    ),
    [],
    persistedDeliveryTickers.map((ticker) => ticker.symbol),
  );
  const neonUniverseTickers = neonUniverse.neonSymbols
    .map((symbol) => stealthTickerBySymbol.get(symbol))
    .filter((ticker): ticker is (typeof usdtTickers)[number] =>
      Boolean(ticker),
    );
  // The normal scan list is intentionally smaller than the Stealth pool.
  // Explicitly carry these reviewed observations into the symbol loop; a
  // pool entry alone does not cause 4H/1H evaluation.
  const reviewedWatchTickers = stealthPool.tickers.filter(
    (ticker) =>
      reviewedWatchSymbols.includes(ticker.symbol) &&
      stealthOnlySymbols.has(ticker.symbol) &&
      !persistedDeliveryTickers.some((item) => item.symbol === ticker.symbol),
  );
  const normalScanSymbols = genericScanTickers.map((ticker) => ticker.symbol);
  const normalScanSymbolSet = new Set(normalScanSymbols);
  const reviewedWatchSymbolSet = new Set(reviewedWatchSymbols);
  const persistedDeliverySymbolSet = new Set(
    persistedDeliveryTickers.map((ticker) => ticker.symbol),
  );
  const ordinarySupplementalSymbols = [
    ...new Set([
      ...prescanTracker.keys(),
      ...reviewedWatchSymbols,
      ...activeOiWatchSymbols,
      // Independent Range sweep (owner decision 2026-10-03): every current
      // BingX ticker is eligible for Range-only arming in the rotating
      // supplemental window, regardless of activity/volume/Prescan/OI
      // membership. Range-only symbols are never evaluated by other patterns.
      ...stealthTickerBySymbol.keys(),
    ]),
  ].filter(
    (symbol) =>
      !normalScanSymbolSet.has(symbol) &&
      !activeRangeArmSymbols.has(symbol) &&
      !reviewedWatchSymbolSet.has(symbol) &&
      !persistedDeliverySymbolSet.has(symbol),
  );
  const rangeScanSelection = selectStealthRangeScanCandidates({
    activeRangeSymbols: activeRangeArms.map((arm) => arm.symbol),
    supplementalSymbols: ordinarySupplementalSymbols,
    tickerBySymbol: stealthTickerBySymbol,
    normalSymbols: normalScanSymbols,
    reviewedWatchSymbols,
    persistedDeliverySymbols: [...persistedDeliverySymbolSet],
    supplementalCursor: stealthSupplementalScanCursor,
    rangeLimit: 1000,
    // Owner 2026-10-21: every universe symbol is evaluated each cycle.
    supplementalLimit: ordinarySupplementalSymbols.length,
  });
  stealthSupplementalScanCursor = rangeScanSelection.nextSupplementalCursor;
  const rangeOnlyLoopSymbols = rangeScanSelection.rangeOnlySymbols;
  const rangeArmsMissingTicker = activeRangeArms.filter(
    (arm) =>
      !normalScanSymbolSet.has(arm.symbol) &&
      !stealthTickerBySymbol.has(arm.symbol),
  ).length;
  const rangeArmsAvailable = activeRangeArms.filter(
    (arm) =>
      !normalScanSymbolSet.has(arm.symbol) &&
      stealthTickerBySymbol.has(arm.symbol),
  ).length;
  const rangeArmsAlreadyNormal = activeRangeArms.filter((arm) =>
    normalScanSymbolSet.has(arm.symbol),
  ).length;
  const ordinaryTickersAvailable = ordinarySupplementalSymbols.filter(
    (symbol) => stealthTickerBySymbol.has(symbol),
  ).length;
  const ordinarySupplementalsSelected = rangeScanSelection.tickers.filter(
    (ticker) => !activeRangeArmSymbols.has(ticker.symbol),
  ).length;
  logger.info(
    {
      activeRangeArmTotal,
      rangeArmsInPage: activeRangeArms.length,
      rangeArmsMissingTicker,
      rangeArmsSelected: rangeScanSelection.selectedRangeSymbols.size,
      rangeArmsAlreadyNormal,
      rangeArmsDeferredOutsidePage: Math.max(
        0,
        activeRangeArmTotal - activeRangeArms.length,
      ),
      rangeArmsAvailableButNotSelectedInPage: Math.max(
        0,
        rangeArmsAvailable - rangeScanSelection.selectedRangeSymbols.size,
      ),
      ordinarySupplementalsAvailable: ordinaryTickersAvailable,
      ordinarySupplementalsSelected,
      ordinarySupplementalsMissingTicker:
        ordinarySupplementalSymbols.length - ordinaryTickersAvailable,
      ordinarySupplementalsDeferred: Math.max(
        0,
        ordinaryTickersAvailable - ordinarySupplementalsSelected,
      ),
    },
    "Bounded Stealth Range scan selection",
  );
  // Legacy OI stages remain persisted for history/monitoring, but are no longer
  // sampled or promoted into the live Whale Watch path.
  const stealthScanWorklist = buildStealthScanWorklist({
    normalTickers: genericScanTickers,
    persistedDeliveryTickers,
    reviewedWatchTickers,
    selectedSupplementalTickers: rangeScanSelection.tickers,
    prioritySymbols: rangeScanSelection.selectedRangeSymbols,
  });
  usdtTickers.splice(0, usdtTickers.length, ...stealthScanWorklist);

  // ── Parallel pre-fetch: klines + SpotCVD for all scan symbols ──────────────
  // Converts N sequential awaits (~300ms each) into two concurrent batches running
  // in parallel with each other. This is the primary cycle-time improvement.
  //
  // Klines: one worker fetches all three timeframes for a symbol. 4h defines
  // structure, 1h confirms the close, and 30m is only entry refinement.
  // SpotCVD: concurrency 5 (matches CG 5-key rotation). Results go into the module-
  //   level 3-min cache inside getSpotCvdMtf — the loop's getSpotCvdMtf calls return
  //   instantly from cache. No changes needed to the loop CVD logic.
  const klinesPrefetch = new Map<string, BingXKline[]>();
  const klines1hPrefetch = new Map<string, BingXKline[]>();
  const klines4hPrefetch = new Map<string, BingXKline[]>();
  const neonKlines1hPrefetch = new Map<string, BingXKline[]>();
  const neonKlines4hPrefetch = new Map<string, BingXKline[]>();
  const neonKlines1dPrefetch = new Map<string, BingXKline[]>();
  const technicalFallbackState = {
    prefetchTimedOut: false,
    attempts: 0,
  };
  const MAX_TECHNICAL_KLINE_FALLBACKS = 24;
  const ARM_HISTORY_REFRESH_PER_CYCLE = 60;
  let armHistoryRefreshes = 0;
  const autoRangeWatchlistSymbols = new Set(
    watchlistTickers.map((ticker) => ticker.symbol),
  );
  {
    setScannerPhase("phase-1-prefetch");
    const _prefetchStart = Date.now();
    // Hard cap: если CoinGlass медленный (SpotTakerFlow 12с/символ × ~72 батча = ~14 мин),
    // pre-warm завершаем принудительно через 3 мин.
    // FIX: после deadline воркеры проверяют prefetchAborted.value и не стартуют новые
    // запросы — предотвращаем ситуацию когда runConcurrent продолжает работать в фоне
    // параллельно с главным сканом и создаёт лишнюю нагрузку на CG API.
    const MAX_PREFETCH_MS = 3 * 60 * 1000;
    const prefetchAbort = new AbortController();
    const prefetchSignal = AbortSignal.any([
      lease.signal,
      prefetchAbort.signal,
    ]);
    const prefetchDeadlineTimer = setTimeout(() => {
      technicalFallbackState.prefetchTimedOut = true;
      prefetchAbort.abort(new Error("Phase 1 prefetch deadline exceeded"));
    }, MAX_PREFETCH_MS);

    if (AUTO_RANGE_LIVE_ENABLED || AUTO_RANGE_1H_LIVE_ENABLED) {
      try {
        const persistedRangeArms = await db.execute(sql`
          SELECT DISTINCT symbol, level_source
          FROM stealth_breakout_armed_setups
          WHERE level_source IN ('auto_range_4h', 'auto_range_1h')
            AND status IN ('armed', 'qualified', 'firing')
        `);
        // Arms on symbols that left the live BingX universe (offline /
        // delisted / non-crypto) have no klines: scheduling them made the
        // same ~14 symbols fail every warmup cycle.
        const liveBingxSymbols = new Set<string>(allBingxSymbols);
        // Armed (never qualified) arms on blocked or delisted symbols can no
        // longer be evaluated and would stay "armed" forever. Close them
        // explicitly (the DB trigger journals the transition).
        if (liveBingxSymbols.size >= 300) {
          const deadSymbols = [
            ...new Set(
              (persistedRangeArms.rows as Array<{ symbol: string }>).map(
                (row) => row.symbol,
              ),
            ),
          ].filter((symbol) => {
            if (isAnalysisBlockedSymbol(symbol)) return true;
            if (liveBingxSymbols.has(symbol)) {
              armSymbolMissingSince.delete(symbol);
              return false;
            }
            // Owner 2026-10-20: a short BingX offline window or ticker change
            // must not drop an armed symbol. Close only after the symbol has
            // been absent from every cycle for the full grace period.
            const missingSince =
              armSymbolMissingSince.get(symbol) ?? Date.now();
            armSymbolMissingSince.set(symbol, missingSince);
            return Date.now() - missingSince >= ARM_SYMBOL_MISSING_GRACE_MS;
          });
          if (deadSymbols.length > 0) {
            const closed = await db.execute(sql`
              UPDATE stealth_breakout_armed_setups
              SET status = 'invalidated',
                  terminal_reason = 'symbol_not_tradable_or_blocked',
                  decision_at = now(),
                  updated_at = now()
              WHERE level_source IN ('auto_range_4h', 'auto_range_1h')
                AND status = 'armed'
                AND symbol IN (${sql.join(
                  deadSymbols.map((symbol) => sql`${symbol}`),
                  sql`, `,
                )})
            `);
            logger.info(
              { symbols: deadSymbols.length, arms: closed.rowCount ?? 0 },
              "Closed armed Auto Range arms on blocked or delisted symbols",
            );
          }
        }
        for (const row of persistedRangeArms.rows as Array<{
          symbol: string;
          level_source: string;
        }>) {
          if (
            isAnalysisBlockedSymbol(row.symbol) ||
            !liveBingxSymbols.has(row.symbol)
          )
            continue;
          scheduleAutoRangeHistoryFetch(
            row.symbol,
            3,
            row.level_source === "auto_range_1h" ? "1h" : "4h",
          );
        }
      } catch (error) {
        logger.warn(
          { error },
          "Unable to prioritize persisted Auto Range arms for history warmup",
        );
      }
      // Broad market symbols are background work. Current watchlist/scan
      // candidates below promote their entries; active durable arms rank first.
      for (const symbol of allBingxSymbols) {
        scheduleAutoRangeHistoryFetch(symbol, 0);
        // 1H history is the fast path (SAND-type breakouts): rank it above 4H.
        scheduleAutoRangeHistoryFetch(symbol, 1, "1h");
      }
      for (const symbol of prescanTracker.keys()) {
        scheduleAutoRangeHistoryFetch(symbol, 1);
        scheduleAutoRangeHistoryFetch(symbol, 2, "1h");
      }
      const rangeHistorySymbols = new Set([
        ...activeRangeArmSymbols,
        ...rangeOnlyLoopSymbols,
      ]);
      for (const symbol of rangeHistorySymbols) {
        const priority = activeRangeArmSymbols.has(symbol)
          ? 3
          : autoRangeWatchlistSymbols.has(symbol)
            ? 2
            : 1;
        for (const venue of AUTO_RANGE_EXTERNAL_VENUES) {
          autoRangeVenueHistoryQueue.enqueue(symbol, venue, priority);
        }
      }
    }

    const prefetchWork = marketCycleLeaseContext.run(
      { ...lease, signal: prefetchSignal },
      () =>
        Promise.allSettled([
          runConcurrent(
            usdtTickers,
            8,
            async (ticker) => {
              const [thirtyMinute, oneHour, fourHour] =
                await Promise.allSettled([
                  getKlines(ticker.symbol, "30m", 49),
                  getKlines(ticker.symbol, "1h", KLINE_1H_LOOKBACK),
                  getKlines(ticker.symbol, "4h", KLINE_4H_LOOKBACK),
                ]);
              if (
                thirtyMinute.status === "fulfilled" &&
                thirtyMinute.value.length >= 10
              ) {
                klinesPrefetch.set(ticker.symbol, thirtyMinute.value);
              }
              if (oneHour.status === "fulfilled" && oneHour.value.length >= 2) {
                klines1hPrefetch.set(ticker.symbol, oneHour.value);
                if (AUTO_RANGE_1H_LIVE_ENABLED) {
                  mergeAutoRangeHistory(ticker.symbol, oneHour.value, "1h");
                  scheduleAutoRangeHistoryFetch(
                    ticker.symbol,
                    autoRangeWatchlistSymbols.has(ticker.symbol) ? 2 : 1,
                    "1h",
                  );
                }
              }
              if (
                fourHour.status === "fulfilled" &&
                fourHour.value.length >= 10
              ) {
                klines4hPrefetch.set(ticker.symbol, fourHour.value);
                if (AUTO_RANGE_LIVE_ENABLED) {
                  mergeAutoRangeHistory(ticker.symbol, fourHour.value);
                  scheduleAutoRangeHistoryFetch(
                    ticker.symbol,
                    autoRangeWatchlistSymbols.has(ticker.symbol) ? 2 : 1,
                  );
                }
              }
            },
            prefetchSignal,
          ),
          runConcurrent(
            usdtTickers.filter(
              (ticker) => !rangeOnlyLoopSymbols.has(ticker.symbol),
            ),
            5,
            async (ticker) => {
              // Pre-warm the internal 3-min cache; loop call is instant.
              await getSpotCvdMtf(ticker.symbol).catch(() => null);
            },
            prefetchSignal,
          ),
          // Pre-warm SpotTakerFlow (2-min internal cache) so loop calls are instant.
          runConcurrent(
            usdtTickers.filter(
              (ticker) => !rangeOnlyLoopSymbols.has(ticker.symbol),
            ),
            4,
            async (ticker) => {
              await getSpotTakerFlow(ticker.symbol).catch(() => null);
            },
            prefetchSignal,
          ),
          // Pre-warm SpotVolume (5-min internal cache) so loop calls are instant.
          runConcurrent(
            usdtTickers.filter(
              (ticker) => !rangeOnlyLoopSymbols.has(ticker.symbol),
            ),
            4,
            async (ticker) => {
              await getSpotVolume(ticker.symbol).catch(() => null);
            },
            prefetchSignal,
          ),
          runConcurrent(
            neonUniverseTickers.filter(
              (ticker) =>
                !genericScanTickers.some(
                  (item) => item.symbol === ticker.symbol,
                ),
            ),
            8,
            async (ticker) => {
              const [oneHour, fourHour] = await Promise.allSettled([
                getKlines(ticker.symbol, "1h", KLINE_1H_LOOKBACK),
                getKlines(ticker.symbol, "4h", KLINE_4H_LOOKBACK),
              ]);
              // SRv2 1D zones change once a day: refetch at most hourly.
              const cachedDaily = neonDailyKlinesCache.get(ticker.symbol);
              if (
                cachedDaily &&
                Date.now() - cachedDaily.fetchedAt < 60 * 60 * 1000
              ) {
                neonKlines1dPrefetch.set(ticker.symbol, cachedDaily.rows);
              } else {
                try {
                  const rows = await getKlines(ticker.symbol, "1d", 300);
                  if (rows.length >= 25) {
                    neonDailyKlinesCache.set(ticker.symbol, {
                      fetchedAt: Date.now(),
                      rows,
                    });
                    neonKlines1dPrefetch.set(ticker.symbol, rows);
                  }
                } catch {
                  if (cachedDaily)
                    neonKlines1dPrefetch.set(ticker.symbol, cachedDaily.rows);
                }
              }
              if (oneHour.status === "fulfilled" && oneHour.value.length >= 2) {
                neonKlines1hPrefetch.set(ticker.symbol, oneHour.value);
                if (AUTO_RANGE_1H_LIVE_ENABLED) {
                  mergeAutoRangeHistory(ticker.symbol, oneHour.value, "1h");
                  scheduleAutoRangeHistoryFetch(ticker.symbol, 1, "1h");
                }
              }
              if (
                fourHour.status === "fulfilled" &&
                fourHour.value.length >= 10
              ) {
                neonKlines4hPrefetch.set(ticker.symbol, fourHour.value);
                if (AUTO_RANGE_LIVE_ENABLED) {
                  mergeAutoRangeHistory(ticker.symbol, fourHour.value);
                  scheduleAutoRangeHistoryFetch(ticker.symbol, 1);
                }
              }
            },
            prefetchSignal,
          ),
        ]),
    );
    markCycleStep("await-prefetch-work");
    await prefetchWork.finally(() => clearTimeout(prefetchDeadlineTimer));
    if (AUTO_RANGE_LIVE_ENABLED || AUTO_RANGE_1H_LIVE_ENABLED) {
      const historyScope = createAutoRangeHistoryScope(
        lease.signal,
        AUTO_RANGE_HISTORY_WARMUP_BUDGET_MS,
      );
      const bingxHistoryWarmup = marketCycleLeaseContext.run(
        { ...lease, signal: historyScope.signal },
        () =>
          autoRangeHistoryQueue.fetchBatch({
            signal: historyScope.signal,
            fetchHistory: (key, limit) => {
              if (historyScope.signal.aborted) {
                throw historyScope.signal.reason;
              }
              assertMarketCycleLeaseOwnership(
                "Auto Range history warmup request",
              );
              const timeframe: AutoRangeTimeframe = key.startsWith("1h:")
                ? "1h"
                : "4h";
              const symbol = key.slice(3);
              return getKlinesWithDeepHistory(
                symbol,
                timeframe,
                limit,
                AUTO_RANGE_MIN_CLOSED_CANDLES,
                (candles) => normalizeClosedBreakoutCandles(candles).length,
                { strictPayload: true },
              );
            },
          }),
      );
      void bingxHistoryWarmup
        .then((historyStats) => {
          for (const attempt of historyStats.attempts) {
            const timeframe: AutoRangeTimeframe = attempt.key.startsWith("1h:")
              ? "1h"
              : "4h";
            const symbol = attempt.key.slice(3);
            if (attempt.status === "short_history") {
              logger.warn(
                {
                  symbol,
                  timeframe,
                  rows: attempt.rows,
                  closedCandles: attempt.closedCandles,
                },
                "Auto Range history response confirmed fewer than 900 closed candles; retry is deferred for six hours",
              );
            } else if (
              attempt.status === "cancelled" ||
              attempt.status === "failed"
            ) {
              logger.warn(
                {
                  symbol,
                  timeframe,
                  error: serializeAutoRangeHistoryError(attempt.error),
                  cancelled: attempt.status === "cancelled",
                },
                attempt.status === "cancelled"
                  ? "Auto Range history fetch cancelled; retained for a later scan"
                  : "Auto Range history fetch failed; retained for a short retry",
              );
            }
          }
          if (historyStats.selected > 0 || historyStats.queuedRemaining > 0) {
            logger.info(
              {
                attempted: historyStats.attempted,
                succeeded: historyStats.succeeded,
                shortHistory: historyStats.shortHistory,
                cancelled: historyStats.cancelled,
                failed: historyStats.failed,
                deferred: historyStats.deferred,
                queuedSymbolsRemaining: historyStats.queuedRemaining,
                fetchBudgetPerCycle: AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE,
                estimatedWarmupCyclesRemaining: Math.ceil(
                  historyStats.queuedRemaining /
                    AUTO_RANGE_HISTORY_FETCHES_PER_CYCLE,
                ),
                deadlineExceeded: historyScope.deadlineExceeded,
              },
              "Auto Range history warmup running in the background without extending the scanner cycle",
            );
          }
        })
        .catch((error) => {
          logger.warn(
            { error: serializeAutoRangeHistoryError(error) },
            "Auto Range history warmup failed without blocking the scanner cycle",
          );
        })
        .finally(() => historyScope.dispose());

      const venueHistoryScope = createAutoRangeHistoryScope(
        lease.signal,
        AUTO_RANGE_HISTORY_WARMUP_BUDGET_MS,
      );
      const venueHistoryWarmup = marketCycleLeaseContext.run(
        { ...lease, signal: venueHistoryScope.signal },
        () =>
          autoRangeVenueHistoryQueue.fetchBatch({
            signal: venueHistoryScope.signal,
            fetchHistory: (symbol, venue, now, signal) => {
              if (signal.aborted) throw signal.reason;
              assertMarketCycleLeaseOwnership(
                "Auto Range venue history warmup request",
              );
              return fetchAutoRangeVenueHistory(symbol, venue, now, signal);
            },
          }),
      );
      void venueHistoryWarmup
        .then((historyStats) => {
          for (const attempt of historyStats.attempts) {
            if (attempt.status === "failed" || attempt.status === "unknown") {
              logger.warn(
                {
                  symbol: attempt.symbol,
                  venue: attempt.venue,
                  status: attempt.status,
                  reason: attempt.reason,
                },
                "Auto Range venue history is unknown for this exchange; other venues remain eligible",
              );
            }
          }
          if (historyStats.attempted > 0 || historyStats.queuedRemaining > 0) {
            logger.info(
              {
                ...historyStats,
                fetchBudgetPerCycle: AUTO_RANGE_VENUE_HISTORY_FETCHES_PER_CYCLE,
                maxVenueConcurrency: AUTO_RANGE_VENUE_HISTORY_CONCURRENCY,
                deadlineExceeded: venueHistoryScope.deadlineExceeded,
              },
              "Independent Auto Range venue history warmup progress",
            );
          }
        })
        .catch((error) => {
          logger.warn(
            { error: serializeAutoRangeHistoryError(error) },
            "Independent Auto Range venue history warmup failed without blocking the scanner cycle",
          );
        })
        .finally(() => venueHistoryScope.dispose());
    }
    lease.throwIfLost("phase 1 prefetch");

    const prefetchMs = Date.now() - _prefetchStart;
    _cycleMetricPhases.prefetchPhase = {
      deadlineMs: MAX_PREFETCH_MS,
      elapsedMs: prefetchMs,
      timedOut: technicalFallbackState.prefetchTimedOut,
      totalSymbols: usdtTickers.length,
      klines30mCached: klinesPrefetch.size,
      klines1hCached: klines1hPrefetch.size,
      klines4hCached: klines4hPrefetch.size,
      symbolsMissing30m: Math.max(0, usdtTickers.length - klinesPrefetch.size),
    };
    if (technicalFallbackState.prefetchTimedOut) {
      logger.warn(
        {
          klinesCached: klinesPrefetch.size,
          klines1hCached: klines1hPrefetch.size,
          klines4hCached: klines4hPrefetch.size,
          totalSymbols: usdtTickers.length,
          prefetchMs,
          technicalFallbackLimit: MAX_TECHNICAL_KLINE_FALLBACKS,
        },
        "⚡ Pre-fetch: hard cap hit (CoinGlass slow) — proceeding with partial cache; bounded TA fallback enabled",
      );
    } else {
      logger.info(
        {
          klinesCached: klinesPrefetch.size,
          totalSymbols: usdtTickers.length,
          prefetchMs,
        },
        "⚡ Pre-fetch done: 30m/1h/4h klines + SpotCVD + SpotTakerFlow + SpotVolume parallel",
      );
    }
  }

  const tryTechnicalKlineFallback = async (symbol: string): Promise<void> => {
    const missing1h = !klines1hPrefetch.has(symbol);
    const missing4h = !klines4hPrefetch.has(symbol);
    const claimed = claimStealthTechnicalKlineFallback(
      technicalFallbackState,
      missing1h || missing4h,
      MAX_TECHNICAL_KLINE_FALLBACKS,
    );
    if (!claimed) return;

    const startedAt = Date.now();
    const [oneHour, fourHour] = await Promise.all([
      missing1h
        ? getKlines(symbol, "1h", KLINE_1H_LOOKBACK).catch(() => [])
        : [],
      missing4h
        ? getKlines(symbol, "4h", KLINE_4H_LOOKBACK).catch(() => [])
        : [],
    ]);
    if (missing1h && oneHour.length >= 2) {
      klines1hPrefetch.set(symbol, oneHour);
      if (AUTO_RANGE_1H_LIVE_ENABLED) {
        mergeAutoRangeHistory(symbol, oneHour, "1h");
        scheduleAutoRangeHistoryFetch(
          symbol,
          watchlistSet.has(symbol) ? 2 : 1,
          "1h",
        );
      }
    }
    if (missing4h && fourHour.length >= 10) {
      klines4hPrefetch.set(symbol, fourHour);
      if (AUTO_RANGE_LIVE_ENABLED) {
        mergeAutoRangeHistory(symbol, fourHour);
        scheduleAutoRangeHistoryFetch(symbol, watchlistSet.has(symbol) ? 2 : 1);
      }
    }

    logger.info(
      {
        symbol,
        missing1h,
        missing4h,
        recovered1h: missing1h && oneHour.length >= 2,
        recovered4h: missing4h && fourHour.length >= 10,
        elapsedMs: Date.now() - startedAt,
        attempt: technicalFallbackState.attempts,
        maxAttempts: MAX_TECHNICAL_KLINE_FALLBACKS,
      },
      "Stealth TA kline fallback after incomplete global prefetch",
    );
  };

  // ── Token Unlock filter map (fetched once per scan cycle, 4h cache) ──────────
  // No fail-open: null = unlock list unavailable → symbols are refused
  // with `unlock_data_unavailable` (BTC/ETH exempt as before).
  markCycleStep("unlock-map");
  const _unlockMap = await getUpcomingUnlocks().catch(() => null);
  reportUnlockListAvailability(_unlockMap !== null);
  // Per-symbol warn data (daysUntil 4-7): populated in per-symbol block, read at signal creation
  const _unlockWarnMap = new Map<
    string,
    { daysUntil: number; pctSupply: number }
  >();

  const _phase1Ms = Date.now() - _phase1StartMs;
  logger.info(
    { phase1Ms: _phase1Ms, oiMovers: oiMoverTickers.length },
    "⏱ Scan Phase 1: universe and prescan preparation",
  );
  setScannerPhase("phase-2-symbol-discovery");
  const _phase2StartMs = Date.now();
  const newlyQualifiedNeonEvents = new Map<
    string,
    { frozenLevel: number; armCandleTime: number; triggerCandleTime: number }
  >();
  markCycleStep("neon-universe-orchestration");
  await runNeonUniverseOrchestration({
    genericSymbols: [],
    neonSymbols: neonUniverseTickers,
    evaluateNeon: async (ticker) => {
      const symbol = ticker.symbol;
      const oneHour =
        neonKlines1hPrefetch.get(symbol) ?? klines1hPrefetch.get(symbol) ?? [];
      const fourHour =
        neonKlines4hPrefetch.get(symbol) ?? klines4hPrefetch.get(symbol) ?? [];
      const arm = await getFrozenStealthAbneonLevel({
        symbol,
        method: "abneon_support_bounce",
      });
      const closed4h = normalizeClosedBreakoutCandles(fourHour);
      const closed1h = normalizeClosedBreakoutCandles(oneHour);
      const neonMarketCap = (await fetchMarketCap(symbol).catch(() => null))
        ?.mcap;
      const neonCandles1d = normalizeClosedBreakoutCandles(
        neonKlines1dPrefetch.get(symbol) ?? [],
      );
      let closed15m: typeof closed1h | undefined;
      const runSupport = (candles1h: typeof closed1h) =>
        evaluateAbneonSupportBounce({
          candles4h: closed4h,
          candles1h,
          candles15m: closed15m,
          candles1d: neonCandles1d,
          marketCapUsd: neonMarketCap,
          observedAt: Date.now(),
          frozenLevel: arm?.level,
          armCandleTime: arm?.armedAt,
          sweepReclaimBars: NEON_SWEEP_RECLAIM_BARS,
        });
      // Owner rule: volume is aggregated only. First pass has no volume; the
      // aggregated 1H volume is fetched only when a touch/armed reaction
      // exists and volume is what decides it.
      let support = runSupport(closed1h);
      let volumed1h = closed1h;
      if (
        support.reason === "srv2_touch_without_reaction" ||
        (arm != null && support.status === "armed")
      ) {
        const aggVol = await getAggFuturesVolumeByInterval(
          symbol,
          "1h",
          30,
        ).catch(() => null);
        if (aggVol) {
          volumed1h = closed1h.map((c) => ({
            ...c,
            volumeUsd: aggVol.get(c.time),
          }));
          support = runSupport(volumed1h);
        }
      }
      // Owner 2026-10-22: an armed zone was also confirmed on a closed 15m
      // candle. Owner 2026-10-29: OFF — confirmation on the closed 1H candle
      // only (100-day backtest, 4H zones, sweep k3: +1.41% vs +0.76% per
      // trade, peaks >=10% 29% vs 26%, better in Aug/Sep/Oct). The sweep
      // (wick/short close below the zone with a return) stays.
      if (NEON_15M_CONFIRMATION_LIVE && arm != null && support.status === "armed") {
        const [raw15m, aggVol15m] = await Promise.all([
          getKlines(symbol, "15m", 60).catch(() => null),
          getAggFuturesVolumeByInterval(symbol, "15m", 60).catch(() => null),
        ]);
        if (raw15m && aggVol15m) {
          closed15m = normalizeClosedBreakoutCandles(raw15m).map((c) => ({
            ...c,
            volumeUsd: aggVol15m.get(c.time),
          }));
          support = runSupport(volumed1h);
        }
      }
      const persistedSupport = await persistStealthAbneonShadow({
        symbol,
        result: support,
        observedAt: Date.now(),
      });
      if (support.frozenLevel != null && support.armCandleTime != null) {
        const snapshotAt = Date.now();
        const [spotVol, futTaker, spotCvdVol, funding] = await Promise.all([
          getSpotVolume(symbol).catch(() => null),
          getAggregatedFuturesTakerNetBuyPct15m(symbol, 7000).catch(() => null),
          getSpotCvdAndVolume(symbol).catch(() => null),
          getCoinglassCurrentFunding(symbol).catch(() => null),
        ]);
        const oiAgg = coinglassOIMap.get(symbol);
        const oiOk = oiAgg?.available === true;
        const spotOk = spotVol?.available === true;
        const avg1h = prescanTracker.get(symbol)?.spotVolAvg1h ?? null;
        const refPrice = closed1h.length
          ? closed1h[closed1h.length - 1]!.close
          : null;
        await persistNeonEvaluationSnapshot({
          symbol,
          result: support,
          observedAt: snapshotAt,
          metrics: {
            spotVolMult:
              spotOk && spotVol.volumeUsd1h != null && avg1h && avg1h > 0
                ? spotVol.volumeUsd1h / avg1h
                : null,
            spotVol1hUsd: spotOk ? spotVol.volumeUsd1h : null,
            spotVol24hUsd:
              spotCvdVol?.spotVol24h ?? (spotOk ? spotVol.volumeUsd24h : null),
            spotNetBuyPct1h: spotOk ? spotVol.netBuyPct1h : null,
            futTakerNetBuyPct15m: futTaker?.available
              ? futTaker.netBuyPct
              : null,
            spotCvd: spotCvdVol?.cvd.available
              ? {
                  cvd15m: spotCvdVol.cvd.cvd15m,
                  cvd30m: spotCvdVol.cvd.cvd30m,
                  cvd1h: spotCvdVol.cvd.cvd1h,
                  cvd4h: spotCvdVol.cvd.cvd4h,
                }
              : null,
            oiUsd: oiOk ? (oiAgg.oiUsd ?? null) : null,
            oiChange30m: oiOk ? (oiAgg.oiChange30m ?? null) : null,
            oiChange1h: oiOk ? (oiAgg.oiChange1h ?? null) : null,
            oiChange4h: oiOk ? (oiAgg.oiChange4h ?? null) : null,
            oiChange24h: oiOk ? (oiAgg.oiChange24h ?? null) : null,
            fundingRate: funding ?? null,
            referencePrice: refPrice,
            zoneDistancePct:
              refPrice != null && support.frozenLevel > 0
                ? ((refPrice - support.frozenLevel) / support.frozenLevel) * 100
                : null,
          },
        });
      }
      if (
        persistedSupport?.method === "abneon_support_bounce" &&
        persistedSupport.status === "qualified" &&
        persistedSupport.liveEligible &&
        persistedSupport.triggerCandleTime !== null
      ) {
        newlyQualifiedNeonEvents.set(symbol, {
          frozenLevel: persistedSupport.frozenLevel,
          armCandleTime: persistedSupport.armCandleTime,
          triggerCandleTime: persistedSupport.triggerCandleTime,
        });
      }
      const obArm = await getFrozenStealthAbneonLevel({
        symbol,
        method: "order_block_support_bounce",
      });
      await persistStealthAbneonShadow({
        symbol,
        result: evaluateOrderBlockSupportBounce({
          candles4h: closed4h,
          candles1h: closed1h,
          observedAt: Date.now(),
          frozen: obArm ?? undefined,
        }),
        observedAt: Date.now(),
      });
      return newlyQualifiedNeonEvents.has(symbol) ? ticker : null;
    },
    runGeneric: async () => {},
    signal: lease.signal,
    deadlineAt: cycleStartedAt + MAX_SCAN_CYCLE_MS,
    concurrency: 8,
  });
  lease.throwIfLost("Neon universe evaluation");
  mergeQualifiedNeonEventsOldestFirst(
    persistedNeonSupportEvents,
    newlyQualifiedNeonEvents,
  );
  for (const [symbol, event] of persistedNeonSupportEvents) {
    neonOfferedEventKeys.add(`${symbol}:${event.triggerCandleTime}`);
  }
  for (const symbol of newlyQualifiedNeonEvents.keys()) {
    const ticker = stealthTickerBySymbol.get(symbol);
    if (ticker && !usdtTickers.some((item) => item.symbol === symbol)) {
      usdtTickers.push(ticker);
    }
  }

  // Qualified Neon Support bounces are time-critical: scan them first so the
  // entry is not delayed behind the rest of the cycle.
  if (persistedNeonSupportEvents.size > 0) {
    const neonFirst = usdtTickers.filter((t) =>
      persistedNeonSupportEvents.has(t.symbol),
    );
    if (neonFirst.length > 0) {
      const rest = usdtTickers.filter(
        (t) => !persistedNeonSupportEvents.has(t.symbol),
      );
      usdtTickers.splice(0, usdtTickers.length, ...neonFirst, ...rest);
    }
  }
  // Active Range arms wait for one specific closed 1H candle. A scan cycle
  // takes ~18 min, so an arm evaluated late in the loop saw its breakout
  // 42-49 min after the candle closed (ARC/0G/AXL/WLD 2026-10-19). Evaluate
  // arms first, right after the cycle starts at the hour boundary.
  if (activeRangeArmSymbols.size > 0) {
    const isNeonQueued = (t: { symbol: string }) =>
      persistedNeonSupportEvents.has(t.symbol);
    const neonQueued = usdtTickers.filter(isNeonQueued);
    const armedFirst = usdtTickers.filter(
      (t) => !isNeonQueued(t) && activeRangeArmSymbols.has(t.symbol),
    );
    if (armedFirst.length > 0) {
      const rest = usdtTickers.filter(
        (t) => !isNeonQueued(t) && !activeRangeArmSymbols.has(t.symbol),
      );
      usdtTickers.splice(
        0,
        usdtTickers.length,
        ...neonQueued,
        ...armedFirst,
        ...rest,
      );
    }
  }
  const abortFlag = { value: false };
  const _loopStartedAt = Date.now();
  _cycleMetricPhases.loopStartOffsetMs = _loopStartedAt - startTime;
  markCycleStep("loop-start");
  _cycleMetricPhases.steps = cycleStepSink?.steps ?? [];
  cycleStepSink = null;
  const _loopSymbolTimes: { symbol: string; ms: number }[] = [];
  resetLoopTiming();
  const alphaResults: AlphaResult[] = [];
  const signalsToInsert: InsertSignal[] = [];
  let _phase3AccumMs = 0;
  let _batchStart = 0;
  // Candidates collected so far are graded and fired as one batch. The first
  // batch holds time-critical symbols (qualified Range arms, Neon queue) and
  // runs before the rest of the symbol loop; the second batch runs after it.
  const runCandidateBatch = async (): Promise<void> => {
    const batchCandidates = candidates.slice(_batchStart);
    _batchStart = candidates.length;
    if (batchCandidates.length === 0) return;
    const _batchStartedAt = Date.now();
    // ── FRESH PRICE FETCH ───────────────────────────────────────────────────────
    // CoinGlass batch занял 8+ мин. Klines были взяты в начале скана, поэтому
    // base.price = закрытие свечи из прошлого. Перечитываем текущую цену для
    // каждого кандидата, чтобы трекер и Telegram показывали реальную точку входа.
    const freshPriceMap = new Map<string, number>();
    try {
      const freshTickers = await getFutureTickers();
      for (const t of freshTickers) {
        const p = parseFloat((t as any).lastPrice);
        if (p > 0) freshPriceMap.set((t as any).symbol, p);
      }
      logger.info(
        { fetched: freshPriceMap.size },
        "Fresh ticker prices fetched for candidate entry pricing",
      );
    } catch (err) {
      logger.warn(
        { err },
        "Failed to fetch fresh ticker prices — using kline close as fallback",
      );
    }

    setScannerPhase("phase-3-candidate-evaluation");
    const _batchFireStart = alphaResults.length;
    logger.info(
      { count: batchCandidates.length },
      "Phase 3: grade + score for CoinGlass OI candidates...",
    );

    // Phase 3: grade + score (CoinGlass OI already confirmed in Phase 1)

    for (const base of batchCandidates) {
      lease.throwIfLost("scanner candidate processing");
      const { symbol } = base;

      // CoinGlass OI data already fetched in batch — use directly
      const coinglassOI = base.coinglassOI;
      const globalOiChange = coinglassOI.oiChange30m; // global aggregate
      const globalOiConfirmed = true; // all candidates already passed CoinGlass OI filter

      // Fetch trending rank, liquidations, funding, and spot taker flow all in
      // parallel.  SpotTakerFlow has a 2-min in-process cache so this is safe:
      // pre-fetch warmed it; the call here returns instantly on a cache hit.
      // liquidations result is needed for finalSentiment below — sequencing is
      // preserved because we destructure all four before using any of them.
      const [trending, liquidations, fundingRate, spotTfP2] = await Promise.all(
        [
          getTrendingRank(symbol),
          getLiquidations(symbol, base.futVol24hUsd), // vol24h — collision-check тикеров CG
          getCoinglassCurrentFunding(symbol), // агрегат Binance+Bybit+OKX+BingX, текущий (8h, %)
          getSpotTakerFlow(symbol).catch(() => null), // 2-min cache — instant on hit
        ],
      );
      const markPrice = null; // markPrice/indexPrice были только из BingX — больше не нужны
      const indexPrice = null;

      // Re-detect sentiment now that we have liquidation data.
      // IMPORTANT: archetype direct-fire patterns (stealth_breakout, demark,
      // price_led_momentum) have their sentiment locked
      // in Loop 1 via __isConfirmedFire. detectSentiment() is an unconditional fallback
      // that returns bullish_accumulation for any OI level — calling it again here would
      // overwrite the correct pattern key with BA. Use base.sentiment for confirmed-fire.
      const _pe3 = prescanTracker.get(symbol);
      const finalSentiment = base.isConfirmedFire
        ? base.sentiment
        : detectSentiment(
            base.priceChange30m,
            base.oiChangePercent,
            base.volumeMultiplier,
            liquidations.multiple ?? null,
            base.oiTriggerTf,
            _pe3?.prevOi30m ?? null,
            base.price24hChange,
            _pe3?.cycleCount ?? 0,
          );
      // ── STEP 5: Pre-fetch enrichment for Bullet Score v3 ──────────────────────
      // SNF и CVD — in-memory (sync). Taker (spotTfP2) already fetched above in parallel.
      const _snfEntry = getSpotNetflowEntry(symbol); // sync in-memory
      // spotTfP2 is declared from the parallel Promise.all above
      const _spotCvdScore = _spotCvdMapScan.get(symbol);

      // ── STEP 5: Bullet Score v3 (base=1 + confirmations) ─────────────────────
      let alphaScore = calcBulletScore({
        sentimentKey: finalSentiment.key,
        oi30m: base.oiChangePercent,
        oi1h: base.oiChange1h ?? null,
        oi4h: _pe3?.lastOi4h ?? null,
        prevOi30m: _pe3?.prevOi30m ?? null,
        spotVolMult: base.volumeMultiplier,
        spotCvd1h: _spotCvdScore?.cvd1h ?? null,
        spotCvd4h: _pe3?.lastCvd4h ?? null,
        takerNetBuyPct: spotTfP2?.netBuyPct ?? null,
        takerAvailable: spotTfP2?.available ?? false,
        snfNetPct1h: _snfEntry?.netPct1h ?? null,
        snfNetPct4h: _snfEntry?.netPct4h ?? null,
        fundingRate,
        p24h: base.price24hChange ?? null,
        cycleCount: _pe3?.cycleCount ?? null,
        growthCycles: steadyClimbMap.get(symbol)?.growthCycles ?? null,
      });
      // Stealth uses its own fitted score (2026-10-21, see stealth-score.ts).
      if (finalSentiment.key === "stealth_breakout") {
        const _sbOwnScore = (
          base.decisionMetrics as { stealthScore?: unknown } | undefined
        )?.stealthScore;
        if (typeof _sbOwnScore === "number") alphaScore = _sbOwnScore;
      }
      logger.debug(
        {
          symbol,
          alphaScore,
          oi30m: base.oiChangePercent.toFixed(1),
          oi1h: base.oiChange1h?.toFixed(1) ?? null,
          oi4h: _pe3?.lastOi4h?.toFixed(1) ?? null,
          prevOi30m: _pe3?.prevOi30m?.toFixed(1) ?? null,
          spotVolMult: base.volumeMultiplier.toFixed(2),
          spotCvd1h: _spotCvdScore?.cvd1h ?? null,
          spotCvd4h: _pe3?.lastCvd4h ?? null,
          taker: spotTfP2?.netBuyPct?.toFixed(1) ?? null,
          snf1h: _snfEntry?.netPct1h?.toFixed(1) ?? null,
          funding: fundingRate?.toFixed(3) ?? null,
          p24h: base.price24hChange?.toFixed(1) ?? null,
          cycleCount: _pe3?.cycleCount ?? null,
          growthCycles: steadyClimbMap.get(symbol)?.growthCycles ?? null,
        },
        "Bullet Score v3",
      );

      // ── Score breakdown для Telegram (компактная расшифровка по компонентам) ───
      const _bkParts: string[] = [];
      {
        // base.oiChangePercent is the best-of-windows scoring value (can be the
        // 24h change), so the "30m" label must use the real 30m change.
        const _bkOi = _pe3?.lastOi30m ?? base.oiChangePercent;
        const _bkOi1h = base.oiChange1h ?? null;
        const _bkOi4h = _pe3?.lastOi4h ?? null;
        const _bkPrevOi30m = _pe3?.prevOi30m ?? null;
        const _bkOiParts: string[] = [
          `30m${_bkOi >= 0 ? "+" : ""}${_bkOi.toFixed(1)}%`,
        ];
        if (_bkOi1h != null)
          _bkOiParts.push(`1h${_bkOi1h >= 0 ? "+" : ""}${_bkOi1h.toFixed(1)}%`);
        if (_bkOi4h != null)
          _bkOiParts.push(`4h${_bkOi4h >= 0 ? "+" : ""}${_bkOi4h.toFixed(1)}%`);
        const _bkAccel =
          _bkPrevOi30m != null &&
          _bkPrevOi30m >= 0.3 &&
          _bkOi > _bkPrevOi30m * 1.3;
        _bkParts.push(`OI ${_bkOiParts.join("/")}${_bkAccel ? " ⚡" : ""}`);
        // Impulse Buy is decided by the impulse candle volume, not the cycle
        // volume multiplier, so show the figure the pattern actually used.
        const _bkVol =
          finalSentiment.key === "impulse_buy" &&
          base.impulseDecision?.volumeMultiplier != null
            ? base.impulseDecision.volumeMultiplier
            : base.volumeMultiplier;
        if (_bkVol >= 0.5) _bkParts.push(`Vol ×${_bkVol.toFixed(1)}`);
        const _bkCvd1h = _spotCvdScore?.cvd1h ?? null;
        const _bkCvd4h = _spotCvdScore?.cvd4h ?? null;
        if (_bkCvd1h === true && _bkCvd4h === true)
          _bkParts.push("CVD 1h+4h ✅");
        else if (_bkCvd1h === true && _bkCvd4h === false)
          _bkParts.push("CVD 1h✅/4h⚠️");
        else if (_bkCvd1h === true) _bkParts.push("CVD 1h✅");
        else if (_bkCvd1h === false) _bkParts.push("CVD ⚠️");
        const _bkTaker = spotTfP2?.available
          ? (spotTfP2.netBuyPct ?? null)
          : null;
        if (_bkTaker != null)
          _bkParts.push(
            `Taker ${_bkTaker.toFixed(0)}%${_bkTaker >= 60 ? "✅" : _bkTaker < 45 ? "⚠️" : ""}`,
          );
        // FR убран из breakdown: отдельная строка fundingLine в telegram.ts уже показывает его
        const _bkCyc = _pe3?.cycleCount ?? null;
        void _bkCyc; // cycleCount не выводится в TG
        const _bkGc = steadyClimbMap.get(symbol)?.growthCycles ?? null;
        if (_bkGc != null && _bkGc >= 3) _bkParts.push(`L8×${_bkGc}`);
      }
      let _scoreBreakdown = _bkParts.join(" · ");
      if (
        finalSentiment.key === "impulse_buy" &&
        base.impulseDecision !== undefined
      ) {
        const _impulseParts = Object.entries(base.impulseDecision.components)
          .map(([key, passed]) => `${passed ? "✓" : "✗"}${key}`)
          .join(",");
        _scoreBreakdown += ` · Impulse ${base.impulseDecision.score}/${base.impulseDecision.maxScore} [${_impulseParts}]`;
      }

      // ── STEP 5b: Archetype bonus (архетип детектора → alphaScore) ──────────────
      // Портированная логика оркестратора архетипов (orchestrator.py).
      // Бонусы: B_silent_accumulation +2, D_pullback_continuation +1.
      // Fail-open: нет данных → бонус 0, alphaScore не меняется.
      let _archetypeLabel = "";
      {
        const _aOi30m = base.oiChangePercent; // CG OI 30m %
        const _aOi1h = base.oiChange1h ?? null; // CG OI 1h % (из candidates)
        const _aOi4h = _pe3?.lastOi4h ?? null; // OI 4h % из prescanTracker
        const _aPrevOi4h = _pe3?.prevOi4h ?? null; // OI 4h % предыдущего цикла
        const _aP24h = base.price24hChange; // price 24h %
        const _aP4h = base.price4hChange; // price 4h %
        const _aVol = base.volumeMultiplier; // spotVolMult ?? volMult

        let _archetype = "no_signal";

        // Приоритет 1: B_silent_accumulation — тихая 4h-аккумуляция
        if (
          _aOi4h !== null &&
          _aOi4h >= 4.0 &&
          _aOi30m < 1.0 &&
          _aOi1h !== null &&
          _aOi1h < 2.0 &&
          _aP24h >= 3 &&
          _aP24h <= 25 &&
          _aVol >= 0.5
        ) {
          _archetype = "B_silent_accumulation";

          // Приоритет 2: D_pullback_continuation — откат в тренде
        } else if (
          _aP24h >= 5 &&
          _aP24h <= 25 &&
          _aP4h < -1.5 &&
          (_aOi4h === null || _aOi4h > -3.0)
        ) {
          _archetype = "D_pullback_continuation";
        }

        const _archetypeBonuses: Record<string, number> = {
          B_silent_accumulation: 2,
          D_pullback_continuation: 1,
        };
        const _archetypeBonus = _archetypeBonuses[_archetype] ?? 0;
        if (_archetypeBonus > 0 && finalSentiment.key !== "stealth_breakout") {
          alphaScore = Math.min(10, alphaScore + _archetypeBonus);
          _archetypeLabel = _archetype;
          logger.info(
            {
              symbol,
              archetype: _archetype,
              bonus: `+${_archetypeBonus}`,
              alphaScoreAfter: alphaScore,
            },
            `🔬 Archetype bonus: ${_archetype} → alphaScore +${_archetypeBonus}`,
          );
        }
      }
      if (_archetypeLabel) _scoreBreakdown += ` · 🔬${_archetypeLabel}`;

      // ── STEP 5: Grading ──────────────────────────────────────────────────────────
      // super_alpha — Score ≥ 8 И OI подтвердили 2+ таймфрейма, OR глобальный OI ≥ 15%
      // alpha       — стандартный сигнал (OI сработал на 1+ ТФ)

      // Считаем количество OI таймфреймов которые сработали для этого кандидата
      const oiTfCount =
        base.oiTriggerTf === "steady" ? 2 : base.oiTriggerTf.split("+").length;

      // Grade будет обновлён после OB анализа (bulletScore) — здесь предварительное значение
      let gradeDecision = classifyAlphaGrade(
        alphaScore,
        oiTfCount,
        base.oiChangePercent,
      );
      let { grade, reason: gradeReason } = gradeDecision;

      // ── SPOT TAKER FLOW FILTER: спот buy/sell баланс (Binance / BingX spot) ──────
      // Паттерны: любое buy доминирование (> 0%).
      // spotTfP2 уже поднят в блоке "Pre-fetch enrichment for Bullet Score v2" выше.
      {
        if (spotTfP2?.available) {
          const key = finalSentiment.key;

          if (
            spotTfP2.dominance === "sell" &&
            finalSentiment.key !== "stealth_breakout"
          ) {
            logger.info(
              {
                symbol,
                key,
                spotNetBuyPct: spotTfP2.netBuyPct?.toFixed(1) + "%",
                exchange: spotTfP2.exchange,
              },
              "SKIP: Spot Taker Flow — продавцы доминируют на споте",
            );
            skipCount.takerFail++;
            _symRej(
              symbol,
              key,
              "spot_taker_sell_dominance",
              base.oiChangePercent ?? null,
              base.volumeMultiplier ?? null,
              base.price24hChange ?? null,
              prescanTracker.get(symbol)?.cycleCount ?? null,
              "blocked",
            );
            continue;
          }
        } else {
          logger.debug(
            { symbol },
            "Spot Taker Flow: данные недоступны — фильтр пропущен",
          );
        }
      }

      // ── STEP 6: Order Book Imbalance (CoinGlass агрегированный стакан Binance) ──
      // Запрашиваем только для финальных кандидатов (прошли CVD и все фильтры).
      // Буллиш стакан → бонус до +2 к alpha score.
      // Медвежий стакан → hard gate для volume_breakout.
      const obImbalance = await getCgAskBids(symbol);
      let bulletScore = alphaScore;

      if (obImbalance) {
        bulletScore = Math.min(10, alphaScore + obImbalance.scoreBonus);

        const biasLabel =
          obImbalance.bias === "strong_bull"
            ? "🟢🟢 STRONG BULL"
            : obImbalance.bias === "bull"
              ? "🟢 BULL"
              : obImbalance.bias === "bear"
                ? "🔴 BEAR"
                : "⚪ NEUTRAL";

        logger.info(
          {
            symbol,
            bidAskRatio: obImbalance.bidAskRatio.toFixed(2),
            bidsUsd: obImbalance.bidsUsd.toFixed(0),
            asksUsd: obImbalance.asksUsd.toFixed(0),
            bias: biasLabel,
            scoreBonus:
              obImbalance.scoreBonus > 0 ? `+${obImbalance.scoreBonus}` : "0",
          },
          "📚 Order book (CoinGlass/Binance)",
        );
      } else {
        logger.warn({ symbol }, "📚 Order book: данные недоступны");
      }

      // Диагностика: паттерны, прошедшие свой гейт в loop1 для этого символа — теперь
      // известны bulletScore и итоговый det.key, пишем оба в pattern_debug_log,
      // чтобы точно отличить "срезан на alphaScore<5" от "перехвачен другим паттерном".
      {
        const _passedGate = _passedGatePatternsMap.get(symbol);
        if (_passedGate?.length) {
          for (const _pat of _passedGate) {
            void diagPatternPassed(
              _pat,
              symbol,
              bulletScore,
              finalSentiment.key,
            );
          }
        }
      }

      // Пересчёт grade с учётом OB бонуса
      if (obImbalance && obImbalance.scoreBonus > 0) {
        gradeDecision = classifyAlphaGrade(
          bulletScore,
          oiTfCount,
          base.oiChangePercent,
        );
        grade = gradeDecision.grade;
        gradeReason = gradeDecision.reason;
      }

      // WI + OB двойной медвежий фильтр удалён по решению пользователя (2026-07-28).
      // OB и WI по-прежнему пишутся в сигнал и видны в UI — но больше не блокируют.

      // ── Bullet Score: информационное поле, НЕ блокирующий гейт (2026-07-10) ──
      // Раньше здесь был `if (bulletScore < 5) continue;` — резал сигналы по низкому
      // score. Убрано по решению пользователя: score считается и сохраняется в сигнале
      // (виден в Telegram/БД), но больше не мешает сигналу дойти до signals/Telegram.
      // Паттерн-гейты (условия входа), кулдауны и dedup не изменились.
      if (bulletScore < 5) {
        logger.info(
          { symbol, bulletScore, pattern: finalSentiment.key },
          "INFO: bulletScore < 5 — сигнал всё равно создан (гейт снят)",
        );
      }

      // State tracking
      const prevState = signalHistory.get(symbol);
      const isContinuing = !!prevState;
      const cumulativeOiChange = prevState
        ? prevState.cumulativeOiChange + base.oiChangePercent
        : base.oiChangePercent;

      signalHistory.set(symbol, {
        firstSignalAt: prevState?.firstSignalAt ?? new Date(),
        signalCount: (prevState?.signalCount ?? 0) + 1,
        cumulativeOiChange,
      });

      const tradingViewUrl = `https://www.tradingview.com/chart/?symbol=BINGX:${symbol.replace("-", "")}`;
      const bingxUrl = `https://bingx.com/en/trade/${symbol.replace("-", "")}/`;

      // Используем свежую цену (текущий рынок), а не закрытие kline 8 мин назад.
      // Это предотвращает ситуацию когда трекер видит "вход" по старой цене
      // и сразу стреляет milestone 25%/50% потому что рынок уже ушёл.
      const freshPrice = freshPriceMap.get(symbol) ?? base.price;
      const klineSlippage =
        base.price > 0 ? ((freshPrice - base.price) / base.price) * 100 : 0;

      // ── HighRisk «свежий мувер» ───────────────────────────────────────────────
      // Токен <3 циклов в прескане (нет истории накопления) + цена уже ≥5% за 24ч.
      // Production cohort за 90д (73 fresh / 71 closed): 53.5% отмен против 36.6%
      // у сигналов с историей; favorable close 29.6% против 39.4%, средний пик
      // +5.19% против +9.72%. Это информационная пометка — сигнал НЕ блокируется.
      const _fmEntry = prescanTracker.get(symbol);
      const _fmCycles = _fmEntry?.cycleCount ?? 0;
      const freshMoverRisk =
        _fmCycles < 3 && base.price24hChange >= 5 && !_fmEntry?.hasFiredBefore
          ? { cycles: _fmCycles, price24h: base.price24hChange }
          : null;
      if (freshMoverRisk) {
        logger.info(
          {
            symbol,
            pattern: finalSentiment.key,
            cycles: _fmCycles,
            price24h: base.price24hChange.toFixed(1) + "%",
          },
          "⚠️ HighRisk fresh mover: <3 циклов в прескане + p24h ≥5% — пометка в алерте",
        );
      }
      if (Math.abs(klineSlippage) >= 3) {
        logger.info(
          {
            symbol,
            klineClose: base.price,
            freshPrice,
            slippage: klineSlippage.toFixed(1) + "%",
          },
          "⚠️ Entry price slippage since kline fetch — using fresh price",
        );
      }

      // Every pattern requires aggregated (multi-exchange) data; if any of it is
      // unavailable the signal is not issued (owner rule, applies to all patterns).
      const _aggPattern = finalSentiment.key;
      const _aggFutTaker = normalizeImpulseTakerNetBuyPct(
        await getAggregatedFuturesTakerNetBuyPct15m(symbol, 7000),
      );
      const _aggSpotCvd = await getSpotCvdMtf(symbol, {
        priority: "high",
      }).catch(() => null);
      const _aggPe = prescanTracker.get(symbol);
      let _aggOnDemandSpotVol = false;
      // Stealth breakout is a rare, already-qualified event: complete missing
      // aggregated OI / spot volume on demand (CoinGlass, high priority) instead
      // of waiting for the periodic batches, which skipped qualified breakouts.
      if (
        _aggPattern === "stealth_breakout" ||
        _aggPattern === "neon_support_bounce"
      ) {
        if (!(coinglassOIMap.get(symbol)?.oiUsd ?? 0)) {
          const oiNow = await getCoinglassOI(
            symbol,
            bingxPriceMap.get(symbol) ?? null,
            lease.signal,
            { bypassCache: true, priority: "high" },
          ).catch(() => null);
          if (oiNow?.available && (oiNow.oiUsd ?? 0) > 0) {
            coinglassOIMap.set(symbol, oiNow);
          }
        }
        if (
          !(
            _aggPe?.spotVolAvg1h &&
            _aggPe.lastSpotVol1h != null &&
            Number.isFinite(_aggPe.lastSpotVol1h / _aggPe.spotVolAvg1h)
          )
        ) {
          const sv = await getSpotVolume(symbol, { priority: "high" }).catch(
            () => null,
          );
          if (sv?.available && sv.volumeUsd1h != null) {
            if (_aggPe) {
              _aggPe.lastSpotVol1h = sv.volumeUsd1h;
              _aggPe.lastSpotVol4h = sv.volumeUsd4h;
              _aggPe.spotVolAvg1h = _aggPe.spotVolAvg1h ?? sv.volumeUsd1h;
            } else {
              _aggOnDemandSpotVol = true;
            }
          }
        }
      }
      const _aggMissing: string[] = [];
      if (_aggFutTaker === null) _aggMissing.push("fut_taker");
      if (_aggSpotCvd?.available !== true) _aggMissing.push("spot_cvd");
      if (
        !_aggOnDemandSpotVol &&
        !(
          _aggPe?.spotVolAvg1h &&
          _aggPe.lastSpotVol1h != null &&
          Number.isFinite(_aggPe.lastSpotVol1h / _aggPe.spotVolAvg1h)
        )
      )
        _aggMissing.push("spot_volume");
      if (!(coinglassOIMap.get(symbol)?.oiUsd ?? 0)) _aggMissing.push("oi");
      // Owner 2026-10-17 (FOLKS): for Stealth, fut taker / spot CVD / spot volume
      // are observation-only; only a missing OI blocks. Fires without them.
      // Owner 2026-10-28: the fresh-24H-high detection was fitted on candles
      // only; no aggregated data blocks it (all recorded when available).
      const _aggBlocking =
        _aggPattern === "stealth_breakout"
          ? base.stealthDetectionMethod === STEALTH_FRESH_HIGH_METHOD ||
            base.stealthDetectionMethod === STEALTH_RANGE_4H_METHOD
            ? []
            : _aggMissing.filter((m) => m === "oi")
          : _aggMissing;
      if (_aggPattern === "stealth_breakout" && _aggMissing.length > 0) {
        logger.info(
          { symbol, missing: _aggMissing, blocking: _aggBlocking },
          "Stealth: flow data missing, not blocking (observation-only)",
        );
      }
      if (_aggBlocking.length > 0) {
        logger.info(
          { symbol, pattern: _aggPattern, missing: _aggMissing },
          "SKIP: агрегированные данные недоступны",
        );
        _pdbReject(_aggPattern, "aggregated_data_unavailable");
        _symRej(
          symbol,
          _aggPattern,
          `aggregated_data_unavailable:${_aggMissing.join("+")}`,
          base.oiChangePercent ?? null,
          base.volumeMultiplier ?? null,
          base.price24hChange ?? null,
          _aggPe?.cycleCount ?? null,
          "blocked",
        );
        skipCount.takerFail++;
        continue;
      }
      const plmAggregatedFutTaker: number | null =
        _aggPattern === "price_led_momentum" ? _aggFutTaker : null;

      alphaResults.push({
        symbol,
        grade,
        price: freshPrice,
        priceChange30m: base.priceChange30m,
        currentVolume: base.currentVolume,
        avgVolume: base.avgVolume,
        volumeMultiplier: base.volumeMultiplier,
        oiChangePercent: base.oiChangePercent,
        openInterest: base.openInterest,
        cmcRank: trending.rank,
        cmcSource: trending.source,
        cmcAvailable: trending.available,
        liquidationsUsd: liquidations.liquidationsUsd,
        liquidationsMultiple: liquidations.multiple,
        coinglassAvailable: liquidations.available,
        globalOiChange,
        globalOiConfirmed,
        isNewListing: false,
        isExhaustedSqueeze: false,
        pumpFromOpen: null,
        candleCount: 48,
        sentiment: finalSentiment.label,
        sentimentKey: finalSentiment.key,
        traderAction: finalSentiment.traderAction,
        isContinuing,
        cumulativeOiChange,
        tradingViewUrl,
        bingxUrl,
        oiTriggerTf: base.oiTriggerTf,
        oiChange1h: base.oiChange1h,
        oiChange4h: base.oiChange4h,
        oiChange24h: base.oiChange24h,
        klineSlippage,
        isRepeatSignal: base.isRepeatSignal,
        stealthArmId: base.stealthArmId,
        stealthDedupArmIds: base.stealthDedupArmIds,
        stealthDetectionMethod: base.stealthDetectionMethod,
        stealthLevelSource: (base as any).stealthLevelSource,
        stealthEntryPath: (base as any).stealthEntryPath ?? null,
        stealthVolumeUnconfirmed: base.stealthVolumeUnconfirmed ?? false,
        stealthRangeConfirmingVenues: base.stealthRangeConfirmingVenues ?? null,
        stealthBingxOnly: base.stealthBingxOnly ?? false,
        stealthRangeLifecycleKey: base.stealthRangeLifecycleKey ?? null,
        neonSupportBounceEvent: base.neonSupportBounceEvent,
        fundingRate,
        markPrice,
        indexPrice,
        obImbalance,
        cvdDivergence: false,
        isScalpOnly: base.isScalpOnly,
        alphaScore: bulletScore,
        upcomingUnlock: _unlockWarnMap.get(symbol) ?? null,
        freshMoverRisk,
        scoreBreakdown: _scoreBreakdown,
        price24hChange: base.price24hChange,
        price1hChange: base.price1hChange,
        decisionPrice3h: base.price3hChange,
        gradeReason,
        impulseDecision: base.impulseDecision,
        impulseFundingRate: base.impulseFundingRate,
        impulseSpotVolumeMultiplier: base.impulseSpotVolumeMultiplier,
        impulseOi30m: base.impulseOi30m,
        impulseCandleClosedAt: base.impulseCandleClosedAt,
        futTakerNetBuyPct: base.futTakerNetBuyPct,
        decisionMetrics: base.decisionMetrics,
        plmSpotVolMult: base.plmSpotVolMult,
        baOiPath: base.baOiPath ?? undefined,
      });

      _pdbPass(finalSentiment.key);
      const plmPrice3hSnapshot = capturePlmEntryPrice3hSnapshot(
        finalSentiment.key,
        base.price3hChange,
      );
      const plmFutTakerSnapshot = await capturePlmFutTakerShadowWithFallback({
        sentimentKey: finalSentiment.key,
        batchValue: plmAggregatedFutTaker ?? base.futTakerNetBuyPct,
        loadFallback: async () => null,
      });
      const plmFutTakerShadow = plmFutTakerSnapshot.shadow;
      if (finalSentiment.key === "price_led_momentum") {
        logger.info(
          {
            symbol,
            source: plmFutTakerSnapshot.source,
            value: plmFutTakerSnapshot.value,
            shadow: plmFutTakerSnapshot.shadow,
          },
          "PLM Futures Taker decision snapshot captured",
        );
      }
      signalsToInsert.push({
        symbol,
        type: grade,
        value: base.volumeMultiplier,
        threshold: settings.volumeMultiplier,
        price: freshPrice,
        priceChangePercent: base.priceChange30m,
        volume24h: base.currentVolume,
        avgVolume: base.avgVolume,
        openInterest: base.openInterest,
        oiChangePercent: base.oiChangePercent,
        fundingRate: fundingRate ?? null,
        tradingViewUrl,
        cmcRank: trending.rank ?? null,
        cmcSource: trending.source ?? null,
        liquidationsUsd: liquidations.liquidationsUsd ?? null,
        liquidationsMultiple: liquidations.multiple ?? null,
        sentiment: finalSentiment.label,
        sentimentKey: finalSentiment.key,
        stealthDetectionMethod: base.stealthDetectionMethod ?? null,
        stealthRangeConfirmingVenues: base.stealthRangeConfirmingVenues ?? null,
        stealthRangeLifecycleKey: base.stealthRangeLifecycleKey ?? null,
        alphaScore,
        isContinuing,
        cumulativeOiChange,
        entryCvd15m: _spotCvdMapScan.get(base.symbol)?.cvd15m ?? null,
        entryCvd30m: _spotCvdMapScan.get(base.symbol)?.cvd30m ?? null,
        entryCvd1h: _spotCvdMapScan.get(base.symbol)?.cvd1h ?? null,
        entryCvd4h: _spotCvdMapScan.get(base.symbol)?.cvd4h ?? null,
        entryPrice3h: plmPrice3hSnapshot.entryPrice3h,
        entryPrice3hProvenance: plmPrice3hSnapshot.entryPrice3hProvenance,
        plmP24hCap18Pass:
          finalSentiment.key === "price_led_momentum"
            ? base.price24hChange <= 18
            : null,
        plmFutTakerShadow,
        // Captured only at the actual insert boundary. A Phase-1 OI observation
        // can be stale by the time direct fire or OI Watch creates the signal.
        plmOi30mShadow: null,
        entryScoreBreakdown: _scoreBreakdown,
        entryGradeReason: gradeReason,
        // A qualified Neon event is immutable at the closed reaction candle;
        // retain that event boundary instead of replacing it with enrichment
        // completion time.
        detectedAt: base.neonSupportBounceEvent
          ? new Date(
              Math.min(
                supportBounceQualificationTime(
                  base.neonSupportBounceEvent.triggerCandleTime,
                ),
                Date.now(),
              ),
            )
          : new Date(),
      });

      logger.info(
        { symbol, grade, alphaScore, pattern: finalSentiment.key },
        `✅ ${grade.toUpperCase()} score=${alphaScore}`,
      );
    }

    // ── Символы из confirming-очереди — стреляем немедленно без watching ────────
    // Они уже провели 30-120 мин в confirming. Putting them back in watching
    // creates a second 90-min window with a strict price gate that often kills them.
    const confirmedFireSet = new Set(
      batchCandidates.filter((c) => c.isConfirmedFire).map((c) => c.symbol),
    );
    // ── Route signals through OI Watch (two-stage confirmation) ─────────────────
    // alpha/super_alpha: isVolConfirmed=true, 30-90 min window — fire as soon as conditions hold
    // confirmed_fire:    already in confirming queue → insert + track + broadcast immediately

    const neonSupportClaimOwner = `scanner:${process.pid}:${scanCycleCounter}`;
    const _fireIndices: number[] = [];
    for (let i = _batchFireStart; i < alphaResults.length; i++)
      _fireIndices.push(i);
    await runConcurrent(_fireIndices, CONFIRMED_FIRE_CONCURRENCY, async (i) => {
      const res = alphaResults[i];
      const sig = signalsToInsert[i];
      try {
        // ── DIRECT FIRE: кандидат из confirming-очереди ────────────────────────
        // Пропускаем watching-очередь — сигнал уже подтверждён confirming-циклом.
        // Раньше: confirming → candidates → watching → PATH A (90мин + price gate) → пропуск.
        // Теперь: confirming → candidates → СРАЗУ insert + trackSignal + broadcast.
        if (confirmedFireSet.has(res.symbol)) {
          let neonSupportClaim: { id: number; token: string } | null = null;
          let firedSignalRowId: number | null = null;
          try {
            // ── Spot volume gate ─────────────────────────────────────────────────
            // Основной: спот-объём >= 1% MCap (универсальный гейт, везде без исключений).
            // MCap = null → отказ (confirmed_fire_mcap_unavailable).
            const ALPHA_MIN_SPOT_MCAP_PCT = MIN_SPOT_VOL_MCAP_FRACTION;
            const stealthConfirmed = res.sentimentKey === "stealth_breakout";
            const finalRequestPriority = confirmedFireSet.has(res.symbol)
              ? "critical"
              : "high";
            const [vbsFsVol, mcapData] = await Promise.all([
              getFsVolume(res.symbol, {
                priority: finalRequestPriority,
              }).catch(() => null),
              fetchMarketCap(res.symbol).catch(() => null),
            ]);
            const spotVol24h = vbsFsVol?.spotVolUsd24h ?? null;
            // MCap: только живые данные, без кэша SpotPool.
            const marketCapUsd = mcapData?.mcap ?? null;
            if (
              shouldBlockConfirmedFireForMissingSpotVolume({
                spotVolumeUsd24h: spotVol24h,
                stealthConfirmed,
                sentimentKey: res.sentimentKey,
              })
            ) {
              logger.info(
                {
                  symbol: res.symbol,
                  sentimentKey: res.sentimentKey,
                  coinglassAvailable: res.coinglassAvailable,
                },
                "CONFIRMED FIRE: нет данных спота — сигнал отменён",
              );
              skipCount.spotFailNoData++;
              _symRej(
                res.symbol,
                res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                "confirmed_fire_spot_data_unavailable",
                res.globalOiChange ?? null,
                res.volumeMultiplier ?? null,
                res.price24hChange ?? null,
                prescanTracker.get(res.symbol)?.cycleCount ?? null,
              );
              return;
            }
            if (spotVol24h !== null) {
              if (marketCapUsd === null) {
                // MCap недоступен → отказ (без запасных путей), кроме Stealth.
                if (!stealthConfirmed) {
                  logger.info(
                    { symbol: res.symbol, spotVol24h },
                    "CONFIRMED FIRE: MCap недоступен — сигнал отменён",
                  );
                  skipCount.spotFailLow++;
                  _symRej(
                    res.symbol,
                    res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                    "confirmed_fire_mcap_unavailable",
                    res.globalOiChange ?? null,
                    res.volumeMultiplier ?? null,
                    res.price24hChange ?? null,
                    prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  );
                  return;
                }
              } else if (
                spotVol24h < marketCapUsd * ALPHA_MIN_SPOT_MCAP_PCT &&
                !stealthConfirmed &&
                // Owner 2026-10-25: Neon has no spot/mcap minimum (TAG +30..60%
                // was rejected by it at detection and entered late). BTC was
                // exempt since 2026-10-24.
                res.sentimentKey !== "neon_support_bounce"
              ) {
                const pct = ((spotVol24h / marketCapUsd) * 100).toFixed(3);
                logger.info(
                  { symbol: res.symbol, spotVol24h, marketCapUsd, pct },
                  "CONFIRMED FIRE: спот-объём < 1% MCap — сигнал отменён",
                );
                skipCount.spotFailLow++;
                _symRej(
                  res.symbol,
                  res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                  "confirmed_fire_spot_mcap_below_min",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "rejected",
                  {
                    confirmedFireGate: {
                      spotVol24hUsd: spotVol24h,
                      marketCapUsd,
                      spotMcapPct: (spotVol24h / marketCapUsd) * 100,
                      minPct: ALPHA_MIN_SPOT_MCAP_PCT * 100,
                    },
                  },
                );
                return;
              }
            }

            // Owner 2026-10-22 (live, no shadow): Impulse Buy is not fired when
            // spot volume / mcap is in [6%, 15%). Cohort since the 2026-09-11
            // filters: 1 of 27 reached a +10% peak there (4-6%: 7/17, 15%+:
            // 4/18). No upper ceiling: 15%+ passes. Unknown data is handled by
            // the gates above, not here.
            if (
              res.sentimentKey === "impulse_buy" &&
              spotVol24h !== null &&
              marketCapUsd !== null &&
              marketCapUsd > 0
            ) {
              const _ibSpotMcapPct = (spotVol24h / marketCapUsd) * 100;
              if (_ibSpotMcapPct >= 6 && _ibSpotMcapPct < 15) {
                logger.info(
                  {
                    symbol: res.symbol,
                    spotVol24h,
                    marketCapUsd,
                    pct: _ibSpotMcapPct.toFixed(2),
                  },
                  "CONFIRMED FIRE: Impulse Buy spot vol/mcap 6–15% — сигнал отменён",
                );
                skipCount.spotFailLow++;
                _symRej(
                  res.symbol,
                  "impulse_buy",
                  "impulse_spot_mcap_6_to_15pct",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "rejected",
                  {
                    // The exact values this gate judged (calibration input).
                    confirmedFireGate: {
                      spotVol24hUsd: spotVol24h,
                      marketCapUsd,
                      spotMcapPct: _ibSpotMcapPct,
                    },
                  },
                );
                return;
              }
            }

            // ── Spot Taker Flow Gate (confirmed fire) ────────────────────────────
            // Спот тейкер Binance/BingX — продавцы доминируют → OI от шортов.
            // Данные недоступны → отказ.
            if (
              res.sentimentKey !== "neon_support_bounce" &&
              !stealthConfirmed
            ) {
              const cfSpotTf = await getSpotTakerFlow(res.symbol).catch(
                () => null,
              );
              if (!cfSpotTf?.available) {
                logger.info(
                  { symbol: res.symbol },
                  "CONFIRMED FIRE: агрегированный spot taker недоступен — сигнал отменён",
                );
                skipCount.takerFail++;
                _symRej(
                  res.symbol,
                  res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                  "confirmed_fire_spot_taker_unavailable",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "rejected",
                  {
                    confirmedFireGate: {
                      spotTakerNetBuyPct: cfSpotTf?.netBuyPct ?? null,
                      spotTakerDominance: cfSpotTf?.dominance ?? null,
                      spotVol24hUsd: spotVol24h,
                      marketCapUsd,
                    },
                  },
                );
                return;
              }
              {
                if (cfSpotTf.dominance === "sell") {
                  logger.info(
                    {
                      symbol: res.symbol,
                      spotNetBuyPct: cfSpotTf.netBuyPct?.toFixed(1) + "%",
                      exchange: cfSpotTf.exchange,
                    },
                    "CONFIRMED FIRE: Spot Taker Flow — продавцы доминируют на споте → сигнал пропущен",
                  );
                  skipCount.takerFail++;
                  _symRej(
                    res.symbol,
                    res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                    "confirmed_fire_spot_taker_sell_dominant",
                    res.globalOiChange ?? null,
                    res.volumeMultiplier ?? null,
                    res.price24hChange ?? null,
                    prescanTracker.get(res.symbol)?.cycleCount ?? null,
                    "rejected",
                    {
                      confirmedFireGate: {
                        spotTakerNetBuyPct: cfSpotTf.netBuyPct ?? null,
                        spotTakerDominance: cfSpotTf.dominance ?? null,
                        spotVol24hUsd: spotVol24h,
                        marketCapUsd,
                      },
                    },
                  );
                  return;
                }
                // Owner 2026-10-22 (live): Impulse Buy needs spot taker
                // net-buy > 10% at entry (with the 6–15% spot/mcap cut above).
                if (
                  res.sentimentKey === "impulse_buy" &&
                  !(
                    typeof cfSpotTf.netBuyPct === "number" &&
                    Number.isFinite(cfSpotTf.netBuyPct) &&
                    cfSpotTf.netBuyPct > 10
                  )
                ) {
                  logger.info(
                    {
                      symbol: res.symbol,
                      spotNetBuyPct: cfSpotTf.netBuyPct,
                    },
                    "CONFIRMED FIRE: Impulse Buy spot taker net-buy ≤ 10% — сигнал отменён",
                  );
                  skipCount.takerFail++;
                  _symRej(
                    res.symbol,
                    "impulse_buy",
                    "impulse_spot_taker_netbuy_le_10pct",
                    res.globalOiChange ?? null,
                    res.volumeMultiplier ?? null,
                    res.price24hChange ?? null,
                    prescanTracker.get(res.symbol)?.cycleCount ?? null,
                    "rejected",
                    {
                      confirmedFireGate: {
                        spotTakerNetBuyPct: cfSpotTf.netBuyPct ?? null,
                        spotTakerDominance: cfSpotTf.dominance ?? null,
                        spotVol24hUsd: spotVol24h,
                        marketCapUsd,
                      },
                    },
                  );
                  return;
                }
              }
            }

            // ── Spot vol mult: EMA prescan only, no real-time fallback ────────────
            // getSpotVolume() уже кэширован 5 мин — 0 лишних API-вызовов для свежих токенов.
            // vol1h / (vol24h/24) = текущий часовой объём vs среднечасовой за сутки.
            {
              const _cfPe = prescanTracker.get(res.symbol);
              const _emaSpot =
                _cfPe?.spotVolAvg1h && _cfPe?.lastSpotVol1h
                  ? _cfPe.lastSpotVol1h / _cfPe.spotVolAvg1h
                  : null;
              const _spotMult: number | null = _emaSpot;
              (
                res as typeof res & { _spotVolMult?: number | null }
              )._spotVolMult = _spotMult;

              // bullish_accumulation: спот-активность должна быть живой.
              // Если spot vol < 0.8× его 24h-среднего → фьюч без спота → риск медвежьего OI.
              // Fail-open: нет данных → не блокируем.
              if (
                res.sentimentKey === "bullish_accumulation" &&
                _spotMult !== null &&
                _spotMult < 0.8
              ) {
                logger.info(
                  { symbol: res.symbol, spotVolMult: _spotMult.toFixed(2) },
                  "CONFIRMED FIRE: bullish_accumulation — спот тихий (< 0.8× среднего) → сигнал отменён",
                );
                skipCount.spotFailLow++;
                _symRej(
                  res.symbol,
                  res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                  "confirmed_fire_ba_spot_volume_quiet",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                );
                return;
              }
            }

            {
              const signalLayers =
                lastCycleCandidates.find((c) => c.symbol === res.symbol)
                  ?.layers ?? [];
              logger.info(
                {
                  symbol: res.symbol,
                  pattern: res.sentimentKey ?? sig.sentimentKey,
                  layers: signalLayers,
                },
                `🎯 SIGNAL [${signalLayers.join("+")}] → ${res.sentimentKey ?? sig.sentimentKey}`,
              );
            }
            // The tracker is the PnL source of truth, so its entry price must be
            // exactly the price persisted in signals and rendered in Telegram.
            // Sample it once here, after all gates, rather than independently in
            // each destination.
            // Final defense-in-depth: no scanner path may persist a newly created
            // Bullish Accumulation row, including future fallback/confirmation
            // paths added independently of the main detector.
            if (isPreservedDecommissionedPattern(res.sentimentKey)) {
              if (res.sentimentKey !== "balanced_grind")
                _symRej(
                  res.symbol,
                  res.sentimentKey,
                  "pattern_decommissioned",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );
              return;
            }
            const canonicalFire = buildCanonicalSignalFirePrice({
              entryPrice: await getFreshPrice(res.symbol, res.price),
              signalToPersist: sig,
              telegramSignal: res,
            });
            const _isRStealth =
              res.stealthDetectionMethod === STEALTH_FRESH_HIGH_METHOD ||
              res.stealthDetectionMethod === STEALTH_RANGE_4H_METHOD;
            const _rMetrics = res.decisionMetrics as
              | {
                  stealthFreshHigh?: { stopPrice?: unknown };
                  stealthRange4h?: { stopPrice?: unknown };
                }
              | undefined;
            const _fhStopRaw = _isRStealth
              ? Number(
                  _rMetrics?.stealthRange4h?.stopPrice ??
                    _rMetrics?.stealthFreshHigh?.stopPrice,
                )
              : null;
            const _fhStop =
              _fhStopRaw !== null && Number.isFinite(_fhStopRaw) && _fhStopRaw > 0
                ? _fhStopRaw
                : null;
            if (_isRStealth) {
              // Same rule as the study: the stop must sit > 0.3% below entry.
              if (
                _fhStop === null ||
                !(canonicalFire.entryPrice * 0.997 > _fhStop)
              ) {
                skipCount.noConfirming++;
                _symRej(
                  res.symbol,
                  "stealth_breakout",
                  _fhStop === null
                    ? "stealth_fh_stop_missing"
                    : "stealth_fh_price_at_or_below_stop",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  null,
                  "blocked",
                  undefined,
                  canonicalFire.entryPrice,
                );
                return;
              }
            }
            if (res.sentimentKey === "neon_support_bounce") {
              if (res.neonSupportBounceEvent === undefined) {
                logger.error(
                  { symbol: res.symbol },
                  "CONFIRMED FIRE: Neon Support Bounce is missing frozen event provenance",
                );
                skipCount.noConfirming++;
                _symRej(
                  res.symbol,
                  res.sentimentKey,
                  "neon_missing_event_provenance",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );

                return;
              }
              neonSupportClaim = await claimAbneonSupportBounceForFire({
                symbol: res.symbol,
                ...res.neonSupportBounceEvent,
                owner: neonSupportClaimOwner,
              });
              if (neonSupportClaim === null) {
                logger.info(
                  { symbol: res.symbol },
                  "CONFIRMED FIRE: Neon Support Bounce event claim lost or Stealth has precedence",
                );
                skipCount.noConfirming++;
                _symRej(
                  res.symbol,
                  res.sentimentKey,
                  "neon_claim_lost_or_stealth_precedence",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );

                return;
              }
            }
            const directPlmOi30mSnapshot = await capturePlmOi30mShadowAtFire({
              sentimentKey: res.sentimentKey,
              loadFresh: async () => {
                const freshOi = await getCoinglassOI(
                  res.symbol,
                  canonicalFire.entryPrice,
                  undefined,
                  { ...PLM_OI30M_FIRE_FETCH_OPTIONS, priority: "critical" },
                );
                return freshOi.oiChange30m;
              },
            });
            if (
              res.sentimentKey === "stealth_breakout" &&
              res.stealthArmId !== undefined
            ) {
              const claimed = await claimStealthArmForFire(res.stealthArmId);
              if (!claimed) {
                logger.info(
                  { symbol: res.symbol, armId: res.stealthArmId },
                  "CONFIRMED FIRE: Stealth ARMED claim lost — signal suppressed",
                );
                skipCount.noConfirming++;
                _symRej(
                  res.symbol,
                  "stealth_breakout",
                  "armed_claim_lost_or_expired",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );
                return;
              }
            }
            if (
              neonSupportClaim !== null &&
              !(await renewAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
              }))
            ) {
              logger.warn(
                { symbol: res.symbol },
                "CONFIRMED FIRE: Neon claim ownership lost before signal persistence",
              );
              await releaseAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
                reason: "claim_lost_before_signal_persistence",
              }).catch(() => false);
              return;
            }
            let inserted: typeof signalsTable.$inferSelect | undefined;
            let signalInsertFailure: "retryable" | "nonretryable" | null = null;
            let signalInsertErrMsg = "unknown";
            try {
              // broadcast_window_key: уникальный ключ "symbol:30min_bucket" — ON CONFLICT DO NOTHING
              // гарантирует что только один сигнал для данной монеты попадёт в БД за 30 минут,
              // даже если scanner + watcher + два PID гонятся одновременно.
              const _bwKey = `${res.symbol}:${Math.floor(Date.now() / (30 * 60 * 1000))}`;
              let _rows = await dbWriteStrict(
                "signals/confirmed-fire-insert",
                () =>
                  db
                    .insert(signalsTable)
                    .values({
                      ...canonicalFire.signalToPersist,
                      plmOi30mShadow: directPlmOi30mSnapshot.shadow,
                      broadcastWindowKey: _bwKey,
                      telegramAlertQueued: false,
                      altBulletSnapshotRequestedAt: new Date(),
                      detectedAt: canonicalFire.signalToPersist.detectedAt,
                    })
                    .onConflictDoNothing()
                    .returning(),
              );
              if (_rows.length === 0) {
                // A retried insert whose first attempt already committed returns
                // zero rows too. If the stored row is this very decision (same
                // pattern and identical detection timestamp) adopt it instead of
                // calling our own row a foreign duplicate and dropping the fire.
                const _own = await db
                  .select()
                  .from(signalsTable)
                  .where(eq(signalsTable.broadcastWindowKey, _bwKey))
                  .limit(1);
                const _ownRow = _own[0];
                const _ownTracked =
                  _ownRow === undefined
                    ? []
                    : await db
                        .select({ id: trackedSignalsTable.id })
                        .from(trackedSignalsTable)
                        .where(eq(trackedSignalsTable.signalId, _ownRow.id))
                        .limit(1);
                // Same pattern, never tracked, and either this exact decision or
                // an orphan left by an earlier attempt that died before tracking
                // (older than 90s, so a live worker is not racing us).
                if (
                  _ownRow !== undefined &&
                  _ownRow.sentimentKey === res.sentimentKey &&
                  _ownTracked.length === 0 &&
                  ((canonicalFire.signalToPersist.detectedAt !== undefined &&
                    _ownRow.detectedAt.getTime() ===
                      new Date(
                        canonicalFire.signalToPersist.detectedAt,
                      ).getTime()) ||
                    Date.now() - _ownRow.detectedAt.getTime() > 90_000)
                ) {
                  logger.warn(
                    { symbol: res.symbol, signalId: _ownRow.id },
                    "CONFIRMED FIRE: own committed signal row adopted after conflict",
                  );
                  _rows = [_ownRow];
                }
              }
              if (_rows.length === 0) {
                logger.info(
                  { symbol: res.symbol, windowKey: _bwKey },
                  "CONFIRMED FIRE: broadcast window conflict — duplicate suppressed (DB-level dedup)",
                );
                skipCount.noConfirming++;
                _symRej(
                  res.symbol,
                  res.sentimentKey,
                  "broadcast_window_duplicate",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );

                if (neonSupportClaim !== null) {
                  await terminalizeAbneonSupportBounceClaim({
                    ...neonSupportClaim,
                    owner: neonSupportClaimOwner,
                    reason: "broadcast_window_duplicate_nonretryable",
                  });
                }
                if (
                  res.sentimentKey === "stealth_breakout" &&
                  res.stealthArmId !== undefined
                ) {
                  await consumeStealthArmLogged(
                    res.stealthArmId,
                    "qualified_broadcast_window_conflict",
                    res.symbol,
                  );
                }
                return;
              }
              inserted = _rows[0]!;
              firedSignalRowId = inserted.id;
            } catch (err) {
              signalInsertFailure = classifyAbneonFirePersistenceFailure(err);
              signalInsertErrMsg = (
                err instanceof Error ? err.message : String(err)
              )
                .replace(/\s+/g, " ")
                .slice(0, 160);
              logger.error(
                { err, symbol: res.symbol },
                "CONFIRMED FIRE: signal insert failed after retries — signal dropped",
              );
            }
            if (!inserted) {
              skipCount.noConfirming++;
              _symRej(
                res.symbol,
                res.sentimentKey,
                `signal_insert_failed: ${signalInsertErrMsg}`,
                res.globalOiChange ?? null,
                res.volumeMultiplier ?? null,
                res.price24hChange ?? null,
                prescanTracker.get(res.symbol)?.cycleCount ?? null,
                "blocked",
              );

              if (neonSupportClaim !== null) {
                if (signalInsertFailure === "nonretryable") {
                  await terminalizeAbneonSupportBounceClaim({
                    ...neonSupportClaim,
                    owner: neonSupportClaimOwner,
                    reason: "qualified_signal_insert_nonretryable_error",
                  });
                } else {
                  await releaseAbneonSupportBounceClaim({
                    ...neonSupportClaim,
                    owner: neonSupportClaimOwner,
                    reason: "qualified_signal_insert_retryable_error",
                  });
                }
              }
              // Owner 2026-10-21: the arm stays open until the signal row is
              // written; the qualified arm is re-offered on the next cycle.
              _symRej(
                res.symbol,
                res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                "confirmed_fire_signal_persist_failed",
                res.globalOiChange ?? null,
                res.volumeMultiplier ?? null,
                res.price24hChange ?? null,
                prescanTracker.get(res.symbol)?.cycleCount ?? null,
                "blocked",
              );
              return;
            }
            const _peFire = prescanTracker.get(res.symbol);
            if (
              neonSupportClaim !== null &&
              !(await renewAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
              }))
            ) {
              logger.warn(
                { symbol: res.symbol },
                "CONFIRMED FIRE: Neon claim ownership lost before tracker persistence",
              );
              await releaseAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
                reason: "claim_lost_before_tracker_persistence",
              }).catch(() => false);
              return;
            }
            // Observation only: real CoinGlass volume of the candle that produced
            // the signal (Impulse Buy 30m, Neon Support 1H reaction candle).
            const _candleRealVolume =
              res.sentimentKey === "impulse_buy" && res.impulseCandleClosedAt
                ? await observeSignalCandleVolume(
                    res.symbol,
                    res.impulseCandleClosedAt.getTime() - 30 * 60_000,
                    "30m",
                  )
                : res.sentimentKey === "neon_support_bounce" &&
                    res.neonSupportBounceEvent
                  ? await observeSignalCandleVolume(
                      res.symbol,
                      res.neonSupportBounceEvent.triggerCandleTime,
                      "1h",
                    )
                  : null;
            const tracked = await trackSignal({
              symbol: res.symbol,
              signalId: inserted.id,
              fixedStopPrice: _fhStop,
              signalType: res.grade ?? "alpha",
              sentiment: res.sentiment,
              sentimentKey: res.sentimentKey,
              stealthDetectionMethod: res.stealthDetectionMethod ?? null,
              alphaScore: res.alphaScore,
              entrySource:
                res.sentimentKey === "neon_support_bounce"
                  ? "scan:neon_support_bounce:v1"
                  : "scan",
              entryPrice: canonicalFire.entryPrice,
              entryPrice3h: inserted.entryPrice3h,
              entryPrice3hProvenance: inserted.entryPrice3hProvenance,
              plmP24hCap18Pass:
                res.sentimentKey === "price_led_momentum"
                  ? (res.price24hChange ?? Number.POSITIVE_INFINITY) <= 18
                  : null,
              plmFutTakerShadow: inserted.plmFutTakerShadow,
              plmOi30mShadow: inserted.plmOi30mShadow,
              entryScoreBreakdown: res.scoreBreakdown ?? null,
              entryGradeReason: res.gradeReason ?? null,
              decisionMetrics: withCandleRealVolume(
                res.decisionMetrics ??
                  (res.sentimentKey === "impulse_buy" && res.impulseDecision
                    ? {
                        price24h: res.price24hChange,
                        price3h: res.decisionPrice3h,
                        price1h: res.price1hChange,
                        oi30m: res.impulseOi30m ?? null,
                        oi1h: res.oiChange1h,
                        oi4h: res.oiChange4h,
                        fundingRate: res.impulseFundingRate ?? null,
                        spotVolumeMultiplier:
                          res.impulseSpotVolumeMultiplier ?? null,
                        futTakerNetBuyPct: res.futTakerNetBuyPct ?? null,
                        candleBodyPct: res.impulseDecision.candleBodyPct,
                        candleVolumeMult: res.impulseDecision.volumeMultiplier,
                        candleCloseStrength: res.impulseDecision.closeStrength,
                        candleClosedAt:
                          res.impulseCandleClosedAt?.toISOString() ?? null,
                        score: res.impulseDecision.score,
                        components: res.impulseDecision.components,
                      }
                    : undefined),
                _candleRealVolume,
              ),
              entryOi: res.openInterest > 0 ? res.openInterest : null,
              entryCvd30m: inserted.entryCvd30m ?? null,
              entryCvd1h: inserted.entryCvd1h ?? null,
              entryCvd4h: inserted.entryCvd4h ?? null,
              marketCapUsd: marketCapUsd ?? null,
              entryOi30m: _peFire?.lastOi30m ?? res.globalOiChange ?? null,
              entryOi1h: _peFire?.lastOi1h ?? res.oiChange1h ?? null,
              entryOi4h: _peFire?.lastOi4h ?? res.oiChange4h ?? null,
              entryFutVolMult:
                res.volumeMultiplier > 0 ? res.volumeMultiplier : null,
              entrySpotVolMult: resolveEntrySpotVolMult(
                res.sentimentKey,
                res.plmSpotVolMult,
                (res as typeof res & { _spotVolMult?: number | null })
                  ._spotVolMult ?? _spotVolMultMapScan.get(res.symbol),
              ),
              entrySpotVol24h: spotVol24h ?? null,
              entrySpotMcapPct:
                spotVol24h !== null && marketCapUsd
                  ? (spotVol24h / marketCapUsd) * 100
                  : null,
            });
            if (tracked === false) {
              logger.error(
                { symbol: res.symbol },
                "CONFIRMED FIRE: trackSignal упал — broadcast отменён",
              );
              if (neonSupportClaim !== null) {
                await releaseAbneonSupportBounceClaim({
                  ...neonSupportClaim,
                  owner: neonSupportClaimOwner,
                  reason: "qualified_tracker_persist_retryable_error",
                });
              }
              await discardUntrackedSignal(
                inserted.id,
                "tracker_persist_failed",
              );
              if (
                res.sentimentKey === "stealth_breakout" &&
                res.stealthArmId !== undefined
              ) {
                await consumeStealthArmLogged(
                  res.stealthArmId,
                  "qualified_tracker_persist_failed",
                  res.symbol,
                );
              }
              _symRej(
                res.symbol,
                res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                `confirmed_fire_tracker_persist_failed: ${takeTrackSignalError(res.symbol)}`,
                res.globalOiChange ?? null,
                res.volumeMultiplier ?? null,
                res.price24hChange ?? null,
                prescanTracker.get(res.symbol)?.cycleCount ?? null,
                "blocked",
              );
              return;
            }
            if (tracked === "skip") {
              // Монета уже в трекере (active/in_run) с другим паттерном — НЕ дублируем алерт.
              // Атомарный claim broadcastBatchAlert защищает от двух процессов на одном сигнале,
              // но не от двух РАЗНЫХ сигналов (разные signal.id) на одну монету.
              // "reentry" (accumulation→active) → всё равно отправляем (статус обновлён, новый вход).
              logger.info(
                { symbol: res.symbol, sentimentKey: res.sentimentKey },
                "CONFIRMED FIRE: монета уже активна — broadcast пропущен (duplicate guard)",
              );
              if (neonSupportClaim !== null) {
                await terminalizeAbneonSupportBounceClaim({
                  ...neonSupportClaim,
                  owner: neonSupportClaimOwner,
                  reason: "qualified_duplicate_active_position",
                });
              }
              await discardUntrackedSignal(
                inserted.id,
                "duplicate_or_post_pump",
              );
              if (
                res.sentimentKey === "stealth_breakout" &&
                res.stealthArmId !== undefined
              ) {
                await consumeStealthArmLogged(
                  res.stealthArmId,
                  "qualified_duplicate_active_position",
                  res.symbol,
                );
              }
              _symRej(
                res.symbol,
                res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                "confirmed_fire_duplicate_or_post_pump",
                res.globalOiChange ?? null,
                res.volumeMultiplier ?? null,
                res.price24hChange ?? null,
                prescanTracker.get(res.symbol)?.cycleCount ?? null,
                "blocked",
              );
              return;
            }
            if (tracked !== "reentry") {
              // Свежий сигнал — обнуляем cycleCount для корректного отображения в UI
              // и чтобы не блокировать повторный выстрел гейтом cycleCount > 25.
              resetPrescanCycleCount(res.symbol);
            }
            if (
              res.sentimentKey === "stealth_breakout" &&
              res.stealthArmId !== undefined
            ) {
              const markedFired = await markStealthArmFired(
                res.stealthArmId,
                canonicalFire.telegramSignal.price,
                inserted.id,
                res.stealthDedupArmIds,
              );
              if (!markedFired) {
                logger.error(
                  { symbol: res.symbol, armId: res.stealthArmId },
                  "CONFIRMED FIRE: Stealth ARMED final transition failed — broadcast suppressed",
                );
                await discardUntrackedSignal(
                  inserted.id,
                  "stealth_final_transition_failed",
                );
                _symRej(
                  res.symbol,
                  res.sentimentKey ?? sig.sentimentKey ?? "unknown",
                  "confirmed_fire_stealth_final_transition_failed",
                  res.globalOiChange ?? null,
                  res.volumeMultiplier ?? null,
                  res.price24hChange ?? null,
                  prescanTracker.get(res.symbol)?.cycleCount ?? null,
                  "blocked",
                );
                return;
              }
            }
            if (
              neonSupportClaim !== null &&
              !(await renewAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
              }))
            ) {
              logger.warn(
                { symbol: res.symbol },
                "CONFIRMED FIRE: Neon claim ownership lost before broadcast",
              );
              await releaseAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
                reason: "claim_lost_before_broadcast",
              }).catch(() => false);
              return;
            }
            const telegramEnqueueCount = await broadcastBatchAlert(
              [
                {
                  ...canonicalFire.telegramSignal,
                  spotVol24h,
                  marketCapUsd,
                  entryOb: consumeObAtFire(res.symbol),
                  signalId: inserted.id,
                },
              ],
              { eventKey: `signal:${inserted.id}` },
            );
            scheduleAltBulletIndicatorSnapshot({
              signalId: inserted.id,
              symbol: res.symbol,
              sentimentKey: res.sentimentKey,
            });
            if (telegramEnqueueCount <= 0) {
              logger.error(
                { symbol: res.symbol, signalId: inserted.id },
                "CONFIRMED FIRE: Telegram durable enqueue returned zero; stages retained",
              );
              if (tracked === "new") {
                await cancelUndeliveredTrackedSignal(
                  inserted.id,
                  "telegram_enqueue_failed",
                ).catch((err) => {
                  logger.error(
                    { err, symbol: res.symbol, signalId: inserted.id },
                    "CONFIRMED FIRE: failed enqueue could not cancel new tracker",
                  );
                  return false;
                });
              }
              if (neonSupportClaim !== null) {
                await releaseAbneonSupportBounceClaim({
                  ...neonSupportClaim,
                  owner: neonSupportClaimOwner,
                  reason: "telegram_enqueue_retryable_failure",
                }).catch(() => false);
              }
              return;
            }
            await dbWriteStrict("signals/alert-queued", () =>
              db
                .update(signalsTable)
                .set({ telegramAlertQueued: true })
                .where(eq(signalsTable.id, inserted.id)),
            );
            if (neonSupportClaim !== null) {
              const ownsFinalization = await renewAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
              });
              if (!ownsFinalization) {
                logger.warn(
                  { symbol: res.symbol },
                  "CONFIRMED FIRE: Neon claim ownership lost before finalization",
                );
                await releaseAbneonSupportBounceClaim({
                  ...neonSupportClaim,
                  owner: neonSupportClaimOwner,
                  reason: "claim_lost_before_finalization",
                }).catch(() => false);
                return;
              }
              const finalized = await markAbneonSupportBounceConsumed({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
                reason: "signal_tracker_and_broadcast_persisted",
              });
              if (!finalized) {
                logger.error(
                  { symbol: res.symbol },
                  "CONFIRMED FIRE: Neon claim finalization lost ownership",
                );
                return;
              }
            }
            logger.info(
              {
                symbol: res.symbol,
                grade: res.grade,
                pattern: res.sentimentKey,
              },
              "✅ CONFIRMED FIRE: сигнал выдан напрямую (без watching-очереди)",
            );
          } catch (err) {
            if (neonSupportClaim !== null) {
              await releaseAbneonSupportBounceClaim({
                ...neonSupportClaim,
                owner: neonSupportClaimOwner,
                reason: "confirmed_fire_retryable_error",
              });
            }
            logger.error(
              { err, symbol: res.symbol },
              "CONFIRMED FIRE: ошибка при выстреле",
            );
            if (firedSignalRowId !== null) {
              await discardUntrackedSignal(
                firedSignalRowId,
                "confirmed_fire_unhandled_error",
              ).catch(() => false);
            }
            const _fireErrMsg = (
              err instanceof Error ? err.message : String(err)
            )
              .replace(/\s+/g, " ")
              .slice(0, 160);
            _symRej(
              res.symbol,
              res.sentimentKey ?? sig.sentimentKey ?? "unknown",
              `confirmed_fire_unhandled_error: ${_fireErrMsg}`,
              res.globalOiChange ?? null,
              res.volumeMultiplier ?? null,
              res.price24hChange ?? null,
              prescanTracker.get(res.symbol)?.cycleCount ?? null,
              "blocked",
            );
          }
          return; // не создаём watching entry для этого символа
        }

        const payload = { alphaResult: res, signalRow: sig };

        const watchWindowMin = 360; // 6ч для всех паттернов
        const expiresAt = new Date(Date.now() + watchWindowMin * 60 * 1000);
        const triggerTf = res.oiTriggerTf;
        const isVolConfirmed = true;

        const existing = await db
          .select({ id: oiWatchTable.id, status: oiWatchTable.status })
          .from(oiWatchTable)
          .where(
            and(
              eq(oiWatchTable.symbol, res.symbol),
              inArray(oiWatchTable.status, ["watching", "confirming"]),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          // dbWriteStrict: критичный апдейт OI Watch — бросает при неудаче
          await dbWriteStrict("oiWatch/loop2-update", () =>
            db
              .update(oiWatchTable)
              .set({
                oiChange: res.oiChangePercent,
                volumeMultiplier: res.volumeMultiplier,
                priceAtEntry: res.price,
                price24hChange: res.price24hChange ?? null,
                expiresAt,
                isVolConfirmed,
                signalPayload: payload as any,
              })
              .where(eq(oiWatchTable.id, existing[0].id)),
          );
          logger.info(
            {
              symbol: res.symbol,
              grade: res.grade,
              vol: res.volumeMultiplier.toFixed(1) + "x",
            },
            "👁 OI Watch: обновлён свежими данными",
          );
        } else {
          await dbWriteStrict("oiWatch/loop2-insert", async () => {
            const _freshPrice = await getFreshPrice(res.symbol, res.price);
            return db.insert(oiWatchTable).values({
              symbol: res.symbol,
              triggerTf,
              oiChange: res.oiChangePercent,
              priceAtEntry: _freshPrice,
              volumeMultiplier: res.volumeMultiplier,
              sentimentKey: res.sentimentKey,
              status: "watching",
              addedAt: new Date(),
              expiresAt,
              avgVolume: res.avgVolume,
              isVolConfirmed,
              signalPayload: payload as any,
              price1hChange: null,
              price24hChange: res.price24hChange ?? null,
              // Кандидаты прошли все CVD гейты → объём подтверждён.
              volStatusReason: "confirmed",
              entryVolMult: res.volumeMultiplier,
            });
          });
          logger.info(
            {
              symbol: res.symbol,
              grade: res.grade,
              alphaScore: res.alphaScore,
              vol: res.volumeMultiplier.toFixed(1) + "x",
            },
            "👁 OI Watch: сигнал в очереди — сработает через 2 мин если условия сохранятся",
          );
          state.oiWatchLastInsertAt = new Date();
          state.oiWatchInsertsLastScan++;
        }
      } catch (err) {
        state.oiWatchInsertErrors++;
        state.oiWatchLastInsertError =
          err instanceof Error ? err.message : String(err);
        logger.warn(
          { err, symbol: res.symbol },
          "Ошибка при постановке сигнала в OI Watch",
        );
      }
    });
    _phase3AccumMs += Date.now() - _batchStartedAt;
  };

  const processTicker = async (
    ticker: (typeof usdtTickers)[number],
  ): Promise<void> => {
    if (abortFlag.value) return;
    if (Date.now() - cycleStartedAt > MAX_SCAN_CYCLE_MS) {
      logger.warn(
        {
          symbolsProcessed,
          totalSymbols: usdtTickers.length,
          elapsedMin: Math.round((Date.now() - cycleStartedAt) / 60_000),
        },
        "⏱ Scan cycle hard timeout (22 min) — aborting remaining workers",
      );
      abortFlag.value = true;
      return;
    }
    symbolsProcessed++;
    const symbol = ticker.symbol;
    let canEvaluateNonStealth = !stealthOnlySymbols.has(symbol);
    const isRangeOnlySupplemental = rangeOnlyLoopSymbols.has(symbol);
    const isRangeLifecycleCandidate =
      isRangeOnlySupplemental || activeRangeArmSymbols.has(symbol);
    const _neonSupportBounceEvent: {
      frozenLevel: number;
      armCandleTime: number;
      triggerCandleTime: number;
      confluence?: string | null;
    } | null = isRangeOnlySupplemental
      ? null
      : (persistedNeonSupportEvents.get(symbol) ?? null);
    const _isQueuedNeonSupportBounce = _neonSupportBounceEvent !== null;

    // Per-symbol hard timeout: освобождает воркер если он завис внутри symbolBlock.
    // 22-мин abortFlag проверяется только в начале каждой итерации воркера —
    // не прерывает await внутри символа (getKlines, getSpotCvdMtf, getCG на TCP-hang).
    // Post-detection drop trace: a pattern that was detected but neither became a
    // candidate nor logged a reason must still leave a reject record.
    const _dropSkipSnap = { ...skipCount };
    const _dropCandidatesBefore = candidates.length;
    let _dropDetKey: (() => string | null) | null = null;
    const _impulseBaselinePassed = false;
    const _impulseBaselineCtx: {
      oi30m: number | null;
      volMult: number | null;
      price24h: number | null;
      cycles: number | null;
      price: number | null;
    } | null = null;
    const _symPassStore = {
      passed: new Set<string>(),
      context: null as PatternDebugCandidateContext | null,
    };
    const _symWorkPromise = runLoopSymbol(() =>
      _pdbSymbolStore.run(_symPassStore, async () => {
        try {
          symbolBlock: do {
            if (isAnalysisBlockedSymbol(symbol)) {
              _symRej(
                symbol,
                "gate",
                "analysis_blocked_symbol",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }
            // ── Unlock warning only (owner 2026-10-24: the unlock block is removed) ──
            // Unlock ≤7 days + pctSupply ≥1% adds a Telegram warning. It never
            // rejects a symbol, and missing unlock data does not block either.
            {
              const _base = symbol.replace("-USDT", "");
              const _uf = _unlockMap?.get(_base);
              if (
                _base !== "BTC" &&
                _base !== "ETH" &&
                _uf &&
                _uf.pctSupply >= 1 &&
                _uf.daysUntil <= 7
              ) {
                _unlockWarnMap.set(symbol, {
                  daysUntil: _uf.daysUntil,
                  pctSupply: _uf.pctSupply,
                });
              }
            }

            // Use pre-fetched klines when available. Selected Range lifecycles
            // must not wait on an unrelated 30m retry if refinement is missing.
            const klines =
              klinesPrefetch.get(symbol) ??
              (isRangeLifecycleCandidate
                ? []
                : await getKlines(symbol, "30m", 49));

            const _peStealthBrk = prescanTracker.get(symbol);
            await tryTechnicalKlineFallback(symbol);
            const _sbFourHourCandles = normalizeClosedBreakoutCandles(
              klines4hPrefetch.get(symbol) ?? [],
            );
            const _sbOneHourCandles = normalizeClosedBreakoutCandles(
              klines1hPrefetch.get(symbol) ?? [],
            );
            if (klines.length < 10 && !isRangeLifecycleCandidate) {
              _symRej(
                symbol,
                "gate",
                "insufficient_30m_klines",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }
            // An active 1H arm is only released by a breakout candle that is in
            // the in-memory history. Symbols outside this cycle's prefetch kept a
            // stale history (FOLKS: breakout closed 01:00 UTC, first seen 06:05),
            // so refresh once per cycle when the newest closed candle is old.
            if (
              AUTO_RANGE_1H_LIVE_ENABLED &&
              activeRangeArmSymbols.has(symbol) &&
              armHistoryRefreshes < ARM_HISTORY_REFRESH_PER_CYCLE
            ) {
              const _latestClosedOpen =
                Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
              const _lastInMemory = getAutoRangeClosedCandles(symbol, "1h").at(
                -1,
              )?.time;
              if (
                _lastInMemory === undefined ||
                _lastInMemory < _latestClosedOpen
              ) {
                armHistoryRefreshes++;
                try {
                  const fresh = await getKlines(
                    symbol,
                    "1h",
                    KLINE_1H_LOOKBACK,
                  );
                  if (fresh.length >= 2) {
                    mergeAutoRangeHistory(symbol, fresh, "1h");
                  }
                } catch (err) {
                  logger.warn(
                    { err, symbol },
                    "Active 1H arm history refresh failed; arm evaluates on stored candles",
                  );
                }
              }
            }
            const _sbAutoRangeFourHourCandles = AUTO_RANGE_LIVE_ENABLED
              ? getAutoRangeClosedCandles(symbol)
              : [];
            const _sbAutoRangeOneHourCandles = AUTO_RANGE_1H_LIVE_ENABLED
              ? getAutoRangeClosedCandles(symbol, "1h")
              : [];
            const _sbAutoRangeResult: AutoRangePineResult =
              AUTO_RANGE_LIVE_ENABLED
                ? detectAutoRangePine(
                    _sbAutoRangeFourHourCandles.length >=
                      AUTO_RANGE_MIN_CLOSED_CANDLES
                      ? _sbAutoRangeFourHourCandles
                      : [],
                  )
                : {
                    status: "unknown",
                    reason:
                      "Auto Range live qualification is disabled pending parity validation",
                    activeConfirmedRange: null,
                    latestUpsideBreakout: null,
                  };
            const _sbAutoRangeCandleCutoff =
              _sbAutoRangeFourHourCandles.at(-1)?.time ?? null;
            const _sbAutoRangeIdentity =
              _sbAutoRangeCandleCutoff === null
                ? null
                : autoRangeIdentityFromResult(
                    _sbAutoRangeResult,
                    _sbAutoRangeCandleCutoff,
                  );
            const _sbAutoRangeOneHourLast = _sbAutoRangeOneHourCandles.at(-1);
            const _sbAutoRangeOneHourFresh =
              _sbAutoRangeOneHourLast !== undefined &&
              _sbAutoRangeOneHourLast.time + 60 * 60 * 1000 <= Date.now() &&
              Date.now() - (_sbAutoRangeOneHourLast.time + 60 * 60 * 1000) <
                2 * 60 * 60 * 1000;
            const _sbAutoRangeOneHourResult: AutoRangePineResult =
              AUTO_RANGE_1H_LIVE_ENABLED &&
              _sbAutoRangeOneHourFresh &&
              _sbAutoRangeOneHourCandles.length >= AUTO_RANGE_MIN_CLOSED_CANDLES
                ? detectOneHourRangeMemoized(symbol, _sbAutoRangeOneHourCandles)
                : {
                    status: "unknown",
                    reason:
                      "Auto Range 1H needs fresh, continuous closed-candle history",
                    activeConfirmedRange: null,
                    latestUpsideBreakout: null,
                  };
            const _sbAutoRangeOneHourIdentity =
              _sbAutoRangeOneHourLast === undefined
                ? null
                : autoRangeIdentityFromResult(
                    _sbAutoRangeOneHourResult,
                    _sbAutoRangeOneHourLast.time,
                    "1h",
                  );
            const _sbStructure = analyzeStealthStructure(_sbFourHourCandles);
            const _sbContinuationShelf =
              analyzeStealthContinuationShelf(_sbOneHourCandles);
            const _sbThirtyMinuteCandles =
              normalizeClosedBreakoutCandles(klines);
            const _sbEvaluatedAt = Date.now();
            const _sbAtr = calculateStealthAtr(_sbFourHourCandles);
            const _sbAutoRangeStructure: BreakoutEvidence =
              _sbAutoRangeIdentity === null
                ? _sbStructure
                : {
                    status: "approaching",
                    kind: "horizontal",
                    breakoutSource: "horizontal",
                    timeframe: "4h",
                    score: 0,
                    quietZone: true,
                    breakoutLevel: _sbAutoRangeIdentity.upper,
                    distanceFromLevelPct:
                      _sbAutoRangeFourHourCandles.at(-1)?.close === undefined
                        ? null
                        : ((_sbAutoRangeFourHourCandles.at(-1)!.close -
                            _sbAutoRangeIdentity.upper) /
                            _sbAutoRangeIdentity.upper) *
                          100,
                    barsSinceBreakout: null,
                    touches: 2,
                    roomToResistancePct: null,
                    breakoutTolerance: null,
                    breakoutZone: {
                      lower: _sbAutoRangeIdentity.lower,
                      upper: _sbAutoRangeIdentity.upper,
                    },
                    lifecycle: null,
                    reasons: [
                      "Active confirmed Auto Range Pine range frozen before upside break",
                    ],
                    pivots: [],
                    levels: [
                      {
                        price: _sbAutoRangeIdentity.upper,
                        touches: 2,
                      },
                    ],
                    trendline: null,
                    retestZone: null,
                  };
            const _sbAutoRangeOneHourStructure: BreakoutEvidence =
              _sbAutoRangeOneHourIdentity === null
                ? _sbStructure
                : {
                    ..._sbStructure,
                    status: "approaching",
                    kind: "horizontal",
                    breakoutSource: "horizontal",
                    timeframe: "1h",
                    score: 0,
                    quietZone: true,
                    breakoutLevel: _sbAutoRangeOneHourIdentity.upper,
                    distanceFromLevelPct:
                      _sbAutoRangeOneHourLast === undefined
                        ? null
                        : ((_sbAutoRangeOneHourLast.close -
                            _sbAutoRangeOneHourIdentity.upper) /
                            _sbAutoRangeOneHourIdentity.upper) *
                          100,
                    barsSinceBreakout: null,
                    touches: 2,
                    roomToResistancePct: null,
                    breakoutTolerance: null,
                    breakoutZone: {
                      lower: _sbAutoRangeOneHourIdentity.lower,
                      upper: _sbAutoRangeOneHourIdentity.upper,
                    },
                    lifecycle: null,
                    reasons: [
                      "Active confirmed Auto Range 1H range before a closed upside break",
                    ],
                    pivots: [],
                    levels: [
                      {
                        price: _sbAutoRangeOneHourIdentity.upper,
                        touches: 2,
                      },
                    ],
                    trendline: null,
                    retestZone: null,
                  };
            type AutoRangeVenueCandidate = {
              venue: LcObVenue;
              result: AutoRangePineResult;
              identity: ReturnType<typeof autoRangeIdentityFromResult>;
              fourHourCandles: ReturnType<
                typeof normalizeClosedBreakoutCandles
              >;
              oneHourCandles: ReturnType<typeof normalizeClosedBreakoutCandles>;
              structure: BreakoutEvidence;
            };
            const _sbAutoRangeVenueCandidates: AutoRangeVenueCandidate[] = [
              {
                venue: "bingx",
                result: _sbAutoRangeResult,
                identity: _sbAutoRangeIdentity,
                fourHourCandles: _sbAutoRangeFourHourCandles,
                oneHourCandles: _sbOneHourCandles,
                structure: _sbAutoRangeStructure,
              },
            ];
            for (const venue of AUTO_RANGE_EXTERNAL_VENUES) {
              if (!isRangeLifecycleCandidate) continue;
              const historyRecord = autoRangeVenueHistoryQueue.get(
                symbol,
                venue,
              );
              if (
                historyRecord?.status !== "ready" ||
                historyRecord.history.fourHour.length <
                  AUTO_RANGE_MIN_CLOSED_CANDLES ||
                historyRecord.history.oneHour.length < 2
              ) {
                continue;
              }
              const venueNow = _sbEvaluatedAt;
              const venueLastFourHour = historyRecord.history.fourHour.at(-1);
              const venueLastOneHour = historyRecord.history.oneHour.at(-1);
              if (
                !venueLastFourHour ||
                !venueLastOneHour ||
                venueLastFourHour.time + 4 * 60 * 60_000 > venueNow ||
                venueNow - (venueLastFourHour.time + 4 * 60 * 60_000) >=
                  8 * 60 * 60_000 ||
                venueLastOneHour.time + 60 * 60_000 > venueNow ||
                venueNow - (venueLastOneHour.time + 60 * 60_000) >=
                  2 * 60 * 60_000
              ) {
                continue;
              }
              const venueFourHourCandles = historyRecord.history.fourHour;
              const venueOneHourCandles = historyRecord.history.oneHour;
              const venuePineCandles = venueFourHourCandles.map((candle) => ({
                time: candle.time,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                closed: true,
              }));
              const venueResult = detectAutoRangePine(venuePineCandles);
              const venueCutoff = venueFourHourCandles.at(-1)?.time ?? null;
              const venueIdentity =
                venueCutoff === null
                  ? null
                  : autoRangeIdentityFromResult(
                      venueResult,
                      venueCutoff,
                      "4h",
                      venue,
                    );
              const venueLastCandle = venueFourHourCandles.at(-1);
              const venueStructure: BreakoutEvidence =
                venueIdentity === null
                  ? _sbStructure
                  : {
                      ..._sbStructure,
                      status: "approaching",
                      kind: "horizontal",
                      breakoutSource: "horizontal",
                      timeframe: "4h",
                      score: 0,
                      quietZone: true,
                      breakoutLevel: venueIdentity.upper,
                      distanceFromLevelPct:
                        venueLastCandle === undefined
                          ? null
                          : ((venueLastCandle.close - venueIdentity.upper) /
                              venueIdentity.upper) *
                            100,
                      barsSinceBreakout: null,
                      touches: 2,
                      roomToResistancePct: null,
                      breakoutTolerance: null,
                      breakoutZone: {
                        lower: venueIdentity.lower,
                        upper: venueIdentity.upper,
                      },
                      lifecycle: null,
                      reasons: [
                        `Active confirmed Auto Range Pine range from ${venue}`,
                      ],
                      pivots: [],
                      levels: [{ price: venueIdentity.upper, touches: 2 }],
                      trendline: null,
                      retestZone: null,
                    };
              _sbAutoRangeVenueCandidates.push({
                venue,
                result: venueResult,
                identity: venueIdentity,
                fourHourCandles: venueFourHourCandles,
                oneHourCandles: venueOneHourCandles,
                structure: venueStructure,
              });
            }
            const _sbEarlyCgOI = coinglassOIMap.get(symbol);
            const _sbEarlyOiValue =
              _sbEarlyCgOI?.oiChange30m ?? _peStealthBrk?.lastOi30m ?? null;
            const _sbEarlyParticipationTelemetry = {
              capturedAt: _sbEvaluatedAt,
              oi: {
                value: _sbEarlyOiValue,
                source: _sbEarlyCgOI?.available
                  ? "coinglass_scan_prefetch"
                  : "prescan_tracker",
                available:
                  typeof _sbEarlyOiValue === "number" &&
                  Number.isFinite(_sbEarlyOiValue),
              },
              cvd: {
                value: {
                  cvd15m: _peStealthBrk?.lastCvd15m ?? null,
                  cvd30m: _peStealthBrk?.lastCvd30m ?? null,
                  cvd1h: _peStealthBrk?.lastCvd1h ?? null,
                  cvd4h: _peStealthBrk?.lastCvd4h ?? null,
                },
                source: "prescan_tracker",
                available: [
                  _peStealthBrk?.lastCvd15m,
                  _peStealthBrk?.lastCvd30m,
                  _peStealthBrk?.lastCvd1h,
                  _peStealthBrk?.lastCvd4h,
                ].some((value) => typeof value === "boolean"),
              },
              spotTaker: {
                value: null,
                source: "not_requested_before_range_lifecycle",
                available: false,
              },
            };
            const evaluateAutoRange4hLifecycle = (
              candidate: AutoRangeVenueCandidate,
              participationTelemetry: StealthBreakoutParticipationTelemetry,
            ) =>
              evaluateDurableStealthArm({
                symbol,
                structure: candidate.structure,
                breakoutCandles4h: candidate.fourHourCandles,
                breakoutCandles1h: candidate.oneHourCandles,
                refinementCandles: _sbThirtyMinuteCandles,
                evaluatedAt: _sbEvaluatedAt,
                allowCreate:
                  isLiveStealthBreakoutSource("auto_range_4h") &&
                  candidate.identity !== null,
                levelSource: "auto_range_4h",
                legacyBreakoutLevel: candidate.structure.breakoutLevel,
                experimentVersion: "auto-range-pine-v1",
                technicalMode: "auto_range_4h",
                atr:
                  calculateStealthAtr(candidate.fourHourCandles) ??
                  _sbAtr ??
                  undefined,
                participationTelemetry,
                autoRangeIdentity: candidate.identity,
                autoRangeBreakoutEvent: candidate.result.latestUpsideBreakout
                  ? {
                      ...candidate.result.latestUpsideBreakout,
                      venue: candidate.venue,
                    }
                  : null,
                autoRangeStatus: candidate.result.status,
              });
            const _sbRangeArmedEarlyByVenue = new Map<
              LcObVenue,
              Awaited<ReturnType<typeof evaluateAutoRange4hLifecycle>>
            >();
            await Promise.all(
              _sbAutoRangeVenueCandidates.map(async (candidate) => {
                const result = await evaluateRangeLifecycleOnce({
                  selected:
                    isRangeLifecycleCandidate && AUTO_RANGE_LIVE_ENABLED,
                  priorResult: null,
                  evaluate: () =>
                    evaluateAutoRange4hLifecycle(
                      candidate,
                      _sbEarlyParticipationTelemetry,
                    ),
                });
                if (result !== null) {
                  _sbRangeArmedEarlyByVenue.set(candidate.venue, result);
                }
              }),
            );
            const _sbRangeArmedEarly =
              _sbRangeArmedEarlyByVenue.get("bingx") ?? null;
            if (klines.length < 10) {
              if (isRangeLifecycleCandidate && !klinesPrefetch.has(symbol)) {
                logger.warn(
                  { symbol },
                  "Range lifecycle evaluated without 30m refinement candles after prefetch miss",
                );
              }
              _symRej(
                symbol,
                "gate",
                "insufficient_30m_klines",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }
            // Stealth has one lifecycle; no separate pattern bypass exists.
            // Structural Stealth candidates must reach the closed-30m technical
            // evaluator. This bypass applies only to Stealth structure; all
            // non-Stealth patterns retain their participation/liquidity gates.
            const _sbShelfIsValid =
              _sbContinuationShelf.quietZone &&
              _sbContinuationShelf.breakoutLevel !== null;
            let isStealthTechnicalFire =
              isRangeOnlySupplemental ||
              (_sbStructure.quietZone && _sbStructure.breakoutLevel !== null) ||
              _sbShelfIsValid ||
              _sbAutoRangeIdentity !== null ||
              _sbAutoRangeResult.latestUpsideBreakout !== null ||
              _sbAutoRangeVenueCandidates.some(
                (candidate) =>
                  candidate.identity !== null ||
                  candidate.result.latestUpsideBreakout !== null,
              ) ||
              _sbAutoRangeOneHourIdentity !== null ||
              _sbAutoRangeOneHourResult.latestUpsideBreakout !== null;
            const preSpotEntry = getSpotPoolEntry(symbol);
            // Owner rule 2026-10-18: no aggregate (spot 24h or market cap), no
            // signal. No optimistic pass for missing pool entries.
            if (
              !isStealthTechnicalFire &&
              (!preSpotEntry ||
                preSpotEntry.spotVol24h === null ||
                preSpotEntry.mcapUsd === null)
            ) {
              skipCount.spotFailNoData++;
              _symRej(
                symbol,
                "gate",
                !preSpotEntry || preSpotEntry.spotVol24h === null
                  ? "spot_vol_unavailable"
                  : "mcap_unavailable",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }
            if (
              !isStealthTechnicalFire &&
              preSpotEntry &&
              preSpotEntry.spotVol24h !== null &&
              preSpotEntry.mcapUsd !== null &&
              preSpotEntry.spotVol24h <
                preSpotEntry.mcapUsd * MIN_SPOT_VOL_MCAP_FRACTION
            ) {
              if (spotFailLogCount < 5) {
                const pct = (
                  (preSpotEntry.spotVol24h / preSpotEntry.mcapUsd) *
                  100
                ).toFixed(3);
                logger.info(
                  {
                    symbol,
                    spotVol24h: preSpotEntry.spotVol24h,
                    mcapUsd: preSpotEntry.mcapUsd,
                    pct,
                  },
                  "SPOTFAIL_LOW detail",
                );
                spotFailLogCount++;
              }
              skipCount.spotFailLow++;
              _symRej(
                symbol,
                "gate",
                "spot_fail_low_spot_volume_share",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }

            const current = klines[klines.length - 1];
            // v3.0 Step 3: use last 20 candles for average volume (not all 48)
            const historical = klines.slice(-21, -1);

            const close = parseFloat(current.close) || 0;
            if (close > 0) {
              _symRejCycleClose.set(symbol, {
                cycleMs: _symRejCycleAt.getTime(),
                price: close,
              });
            }
            const open = parseFloat(current.open) || 0;
            if (!close || !open) {
              _symRej(
                symbol,
                "gate",
                "no_close_or_open_price",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }

            // Owner rule: volume is aggregated only (CoinGlass, 7 exchanges, 15m taker
            // buy+sell summed to 30m). BingX candle volume is never used.
            const _aggVolSeries = await getAggregatedFuturesVolumeSeries30m(
              symbol,
            ).catch(() => null);
            const aggVolOf = (
              k: { time: number } | undefined,
            ): number | null =>
              k ? (_aggVolSeries?.get(k.time) ?? null) : null;
            const currentVol = aggVolOf(current) ?? 0;
            const _histVols = historical.map((k) => aggVolOf(k));
            const avgVol =
              _histVols.length === 20 &&
              _histVols.every((v): v is number => v !== null)
                ? _histVols.reduce((s, v) => s + v, 0) / 20
                : 0;

            if (!avgVol && !isStealthTechnicalFire) {
              _symRej(
                symbol,
                "gate",
                "aggregated_volume_unavailable",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }

            const priceChange = ((close - open) / open) * 100;
            const volMult = avgVol > 0 ? currentVol / avgVol : 0;

            // 4h price context: compare current close to close ~8 candles (4h) ago.
            // Используется для пост-памп фильтра в Phase 3.
            const lookback4hIdx = Math.max(0, klines.length - 1 - 8);
            const base4hClose = parseFloat(klines[lookback4hIdx]?.close || "0");
            const price4hChange =
              base4hClose > 0 ? ((close - base4hClose) / base4hClose) * 100 : 0;

            // 1h price context: compare current close to close 2 candles ago (2×30m = 1h).
            // Хранится в prescanTracker для отображения в воронке сканера.
            const lookback1hIdx = Math.max(0, klines.length - 1 - 2);
            const base1hClose = parseFloat(klines[lookback1hIdx]?.close || "0");
            const price1hChange =
              base1hClose > 0
                ? ((close - base1hClose) / base1hClose) * 100
                : null;

            // 3h price context: compare current close to close 6 candles ago (6×30m = 3h).
            // Глобальный фильтр поздней записи: если цена выросла >8% за последние 3ч — поезд ушёл.
            const lookback3hIdx = Math.max(0, klines.length - 1 - 6);
            const base3hClose = parseFloat(klines[lookback3hIdx]?.close || "0");
            const price3h =
              base3hClose > 0 ? ((close - base3hClose) / base3hClose) * 100 : 0;

            // 4h cumulative volume: средний объём последних 8 свечей (4h) vs базовый avgVol (20 свечей).
            // Используется в 4h Momentum Pattern для обнаружения медленных грайндов.
            const recent8 = klines.slice(-9, -1); // 8×30m = 4h, без текущей свечи
            const _recent8Vols = recent8
              .map((k) => aggVolOf(k))
              .filter((v): v is number => v !== null);
            const vol4hAvg =
              _recent8Vols.length >= 4
                ? _recent8Vols.reduce((s, v) => s + v, 0) / _recent8Vols.length
                : 0;
            const volMult4h =
              avgVol > 0 && vol4hAvg > 0 ? vol4hAvg / avgVol : 0;

            // Volume trend: объём за последние 2 закрытые свечи (не текущая).
            // Если хотя бы одна из них >= 1.3x нормы — объём нарастает трендом, не одиночный спайк.
            // Используется как фильтр качества для hidden_accumulation.
            const prev1k = klines[klines.length - 2];
            const prev2k = klines[klines.length - 3];
            const prevVol1 = aggVolOf(prev1k) ?? 0;
            const prevVol2 = aggVolOf(prev2k) ?? 0;
            const prevVol1Mult = avgVol > 0 ? prevVol1 / avgVol : 0;
            const prevVol2Mult = avgVol > 0 ? prevVol2 / avgVol : 0;
            // Тренд объёма: хотя бы одна из 2 предыдущих закрытых свечей тоже была >= 1.3x.
            // Обновляется позже (после spotVolMult) — спот ≥1.3x тоже считается трендом (1.2).
            let isVolTrend = prevVol1Mult >= 1.3 || prevVol2Mult >= 1.3;

            // ── PRE-FILTER: Exhausted pump — price up >20% in 24h AND volume now cooling off ──
            // We DON'T block early breakouts (PIPPIN: 24h=0.84% at signal time).
            // ЕДИНЫЙ источник p24h (фикс KOMA: BingX вернул 0 при ресете 24h-окна →
            // Demark-гейт p24h≤40 увидел "0%" при реальном росте 80%):
            //   1. Собственный расчёт из 30m-klines (48 свечей = ровно 24ч) — независим от BingX ticker
            //   2. Сырой BingX priceChangePercent — если klines короткие
            //   3. prescanTracker.lastPrice24h — последнее ненулевое сохранённое значение
            const _rawP24h = parseFloat(ticker.priceChangePercent) || 0;
            let _klineP24h: number | null = null;
            if (klines.length >= 48) {
              const _k24Open =
                parseFloat(klines[klines.length - 48]!.open) || 0;
              if (_k24Open > 0)
                _klineP24h = ((close - _k24Open) / _k24Open) * 100;
            }
            const price24hChange =
              _klineP24h ??
              (_rawP24h !== 0
                ? _rawP24h
                : (prescanTracker.get(symbol)?.lastPrice24h ?? 0));
            // Расхождение: BingX даёт 0/занижает при ресете окна — логируем для мониторинга.
            if (_klineP24h !== null && Math.abs(_klineP24h - _rawP24h) > 15) {
              logger.warn(
                {
                  symbol,
                  bingxP24h: _rawP24h.toFixed(1),
                  klineP24h: _klineP24h.toFixed(1),
                },
                "p24h mismatch: BingX ticker vs собственный kline-расчёт",
              );
            }
            // Фидбек в prescanTracker: prescan-фильтры (isExhaustedByTicker, overheat-лог)
            // на следующем цикле увидят проверенное значение, а не сырое из BingX.
            {
              const _peP24hFb = prescanTracker.get(symbol);
              if (_peP24hFb && price24hChange !== 0)
                _peP24hFb.lastPrice24h = price24hChange;
            }

            // Evaluate Impulse Buy before every generic p24 pre-filter. Its live
            // formula intentionally has no p24 input or p24 acceptance range.
            const _plmEntry = prescanTracker.get(symbol);
            const _plmSpotNetflow = getSpotNetflowEntry(symbol);
            const _plmSpotVolMult =
              _plmEntry?.spotVolAvg1h &&
              _plmEntry.lastSpotVol1h != null &&
              Number.isFinite(_plmEntry.lastSpotVol1h / _plmEntry.spotVolAvg1h)
                ? _plmEntry.lastSpotVol1h / _plmEntry.spotVolAvg1h
                : null;
            // PLM is retired from live trading (owner decision): no new signals.
            const isPriceLedMomentum = PLM_LIVE_ENABLED;
            // Impulse Buy retains its historical zero-volume unavailable/fail-open
            // semantics; PLM's stricter gate intentionally treats finite zero as low.
            let _impulseSpotVolMult: number | null =
              _plmEntry?.spotVolAvg1h && _plmEntry.lastSpotVol1h
                ? _plmEntry.lastSpotVol1h / _plmEntry.spotVolAvg1h
                : null;
            const _impulseFundingRate = getFreshFundingRate(symbol);
            let _impulseCgOiAtDecision = coinglassOIMap.get(symbol);
            const _impulseLiqAtDecision = getCachedLiqDataEx(
              symbol,
              aggregatedVolume24hUsd(symbol) || undefined,
            );
            const _impulseLiqShadow = classifyImpulseBuyLiqShadow(
              _impulseLiqAtDecision?.longLiq1h ?? null,
              _impulseLiqAtDecision?.longLiq24h ?? null,
            );
            const _closed30m = [...klines]
              .reverse()
              .find((candle) => candle.time + 30 * 60_000 <= Date.now());
            const _impulseCandleClose =
              parseFloat(_closed30m?.close ?? "") || 0;
            // Owner rule: volume is aggregated only (CoinGlass, 7 exchanges), never
            // BingX-only. Fetched for candles whose body is already >=2%.
            // 2026-10-15 (owner): candle body and close strength are no longer
            // gates, so volume/OI/spot are measured for any candle that already
            // passes the cheap decision gates, not only for >=2% bodies.
            const _impulseBodyPct =
              _closed30m && parseFloat(_closed30m.open) > 0
                ? (parseFloat(_closed30m.close) / parseFloat(_closed30m.open) -
                    1) *
                  100
                : null;
            const _impulseMeasureCandle =
              _closed30m !== undefined &&
              _impulseBodyPct !== null &&
              (_impulseBodyPct >= 2 ||
                (price24hChange !== null &&
                  price24hChange !== undefined &&
                  !(price24hChange >= 5 && price24hChange < 10) &&
                  base3hClose > 0 &&
                  price3h < 20 &&
                  _impulseSpotVolMult !== null &&
                  _impulseSpotVolMult >= 2));
            const _impulseAggVol =
              _impulseMeasureCandle && _closed30m
                ? await getAggregatedFuturesVolume30m(
                    symbol,
                    _closed30m.time,
                  ).catch(() => null)
                : null;
            const _impulseBaselineVolumeUsd =
              _impulseAggVol?.baselineVolumeUsd ?? 0;
            const _impulseCandleVolumeUsd =
              _impulseAggVol?.candleVolumeUsd ?? 0;
            // CoinGlass OI30m missing (its ticker-collision check can drop legit
            // data): use Coinalyze cross-exchange aggregate. Never BingX-only OI.
            // Fetched only for candidates whose candle body is already >=2%.
            // The bulk CoinGlass map can miss a listed symbol for a cycle. For a
            // candle that already passes the 2% body, ask CoinGlass for that one
            // symbol (aggregated, cached) before the Coinalyze fallback.
            if (
              _impulseCgOiAtDecision?.oiChange30m == null &&
              _closed30m &&
              parseFloat(_closed30m.open) > 0 &&
              (parseFloat(_closed30m.close) / parseFloat(_closed30m.open) - 1) *
                100 >=
                2
            ) {
              const _cgOd = await getCoinglassOI(
                symbol,
                parseFloat(ticker.lastPrice) || undefined,
              ).catch(() => null);
              if (_cgOd?.available && _cgOd.oiChange30m != null) {
                _impulseCgOiAtDecision = _cgOd;
              }
            }
            const _impulseOi30m: number | null =
              _impulseCgOiAtDecision?.oiChange30m ?? null;
            const _impulseOi30mSource: "coinglass" | null =
              _impulseOi30m !== null ? "coinglass" : null;
            // Owner 2026-10-14: a fast mover outside the prescan tracker must not be
            // rejected as "spot volume unavailable" without a measurement. For a
            // candle that already has a >=2% body, ask CoinGlass directly: last 1h
            // spot volume vs the mean of the 3 preceding hours (4h minus 1h).
            if (
              _impulseSpotVolMult === null &&
              _impulseBodyPct !== null &&
              _impulseBodyPct >= 2
            ) {
              const _sv = await getSpotVolume(symbol, {
                priority: "high",
              }).catch(() => null);
              if (
                _sv?.available &&
                _sv.volumeUsd1h != null &&
                _sv.volumeUsd4h != null
              ) {
                const _prior3hMean = (_sv.volumeUsd4h - _sv.volumeUsd1h) / 3;
                if (_prior3hMean > 0 && _sv.volumeUsd1h > 0) {
                  _impulseSpotVolMult = _sv.volumeUsd1h / _prior3hMean;
                }
              }
            }
            // Futures taker and CVD: the bulk netflow list covers only ~100 symbols
            // and the prescan tracker only tracked ones. Start from those values;
            // only a candidate that passes every other Impulse Buy gate is then
            // measured per symbol from the aggregated CoinGlass sources (same
            // calls PLM uses), so the request limit is not spent on rejects.
            let _impulseFutTakerNetBuyPct: number | null =
              normalizeImpulseTakerNetBuyPct(getNetflowBatchEntry(symbol));
            let _impulseCvd15m = _plmEntry?.lastCvd15m ?? null;
            let _impulseCvd30m = _plmEntry?.lastCvd30m ?? null;
            let _impulseCvd1h = _plmEntry?.lastCvd1h ?? null;
            let _impulseCvd4h = _plmEntry?.lastCvd4h ?? null;
            // Long liquidations 24h at decision (same batch cache as the entry
            // snapshot entry_liq_long24h; 0 there = no data).
            const _impulseLongLiq24h: number | null =
              _impulseLiqAtDecision && _impulseLiqAtDecision.longLiq24h > 0
                ? _impulseLiqAtDecision.longLiq24h
                : null;
            const _buildImpulseInput = (takerCvdMeasured = false) => ({
              candleOpen: parseFloat(_closed30m?.open ?? "") || 0,
              candleHigh: parseFloat(_closed30m?.high ?? "") || 0,
              candleLow: parseFloat(_closed30m?.low ?? "") || 0,
              candleClose: _impulseCandleClose,
              candleVolumeUsd: _impulseCandleVolumeUsd,
              baselineVolumeUsd: _impulseBaselineVolumeUsd,
              volumeMeasured: Boolean(_impulseMeasureCandle),
              takerCvdMeasured,
              spotVolumeMeasured:
                _impulseSpotVolMult !== null ||
                (_impulseBodyPct !== null && _impulseBodyPct >= 2),
              price24h: price24hChange,
              price3h: base3hClose > 0 ? price3h : null,
              oi30m: _impulseOi30m,
              futVolumeMultiplier: volMult > 0 ? volMult : null,
              fundingRate: _impulseFundingRate,
              oi1h: _impulseCgOiAtDecision?.oiChange1h ?? null,
              oi4h: _impulseCgOiAtDecision?.oiChange4h ?? null,
              spotVolumeMultiplier: _impulseSpotVolMult,
              cvd15m: _impulseCvd15m,
              cvd30m: _impulseCvd30m,
              cvd1h: _impulseCvd1h,
              cvd4h: _impulseCvd4h,
              futTakerNetBuyPct: _impulseFutTakerNetBuyPct,
              longLiq24hUsd: _impulseLongLiq24h,
            });
            let _impulseDecision = evaluateImpulseBuy(_buildImpulseInput());
            if (
              _impulseDecision.missingReasons.length === 0 &&
              _impulseDecision.rejectReasons.length > 0 &&
              _impulseDecision.rejectReasons.every(
                (reason) =>
                  reason === "fut_taker_not_measured" ||
                  reason === "cvd_not_measured",
              )
            ) {
              if (_impulseFutTakerNetBuyPct === null) {
                _impulseFutTakerNetBuyPct = normalizeImpulseTakerNetBuyPct(
                  await getAggregatedFuturesTakerNetBuyPct15m(
                    symbol,
                    7000,
                  ).catch(() => undefined),
                );
              }
              if (_impulseCvd1h === null || _impulseCvd4h === null) {
                const _impulseAggCvd = await getSpotCvdMtf(symbol, {
                  priority: "high",
                }).catch(() => null);
                if (_impulseAggCvd?.available === true) {
                  _impulseCvd15m = _impulseAggCvd.cvd15m;
                  _impulseCvd30m = _impulseAggCvd.cvd30m;
                  _impulseCvd1h = _impulseAggCvd.cvd1h;
                  _impulseCvd4h = _impulseAggCvd.cvd4h;
                }
              }
              _impulseDecision = evaluateImpulseBuy(_buildImpulseInput(true));
            }
            const _impulseLiveDecision: ImpulseBuyDecision =
              shouldEmitImpulseBuyLive(
                _impulseDecision,
                IMPULSE_BUY_LIVE_FIRE_ENABLED,
              )
                ? _impulseDecision
                : { ..._impulseDecision, passes: false };

            // 1. Памп уже отыгран: цена выросла >25% за 24h И объём остывает (< 2.5x).
            //    Дополнительно: если 4h объём >= 1.3x — монета ещё активна (многодневный тренд), пропускаем.
            if (
              !_isQueuedNeonSupportBounce &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "p24_exhausted_pump",
              ) &&
              price24hChange > 40 &&
              volMult < IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_30M &&
              volMult4h < IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_4H
            ) {
              logger.info(
                {
                  symbol,
                  price24hChange: price24hChange.toFixed(1) + "%",
                  volMult: volMult.toFixed(2),
                },
                "SKIP: exhausted pump (>25% 24h + vol < 2.5x) — слишком поздно для входа",
              );
              skipCount.exhaustedPump++;
              if (prescanTracker.has(symbol)) {
                const _peEP = prescanTracker.get(symbol)!;
                gateRejectLog.push({
                  sym: symbol,
                  gate: "exhaustedPump",
                  oi30m: _peEP.lastOi30m?.toFixed(2) ?? "n/a",
                  vol: volMult.toFixed(2) + "x",
                  price: priceChange.toFixed(2) + "%",
                  extra: `p24h=${price24hChange.toFixed(1)}%`,
                });
                _symRej(
                  symbol,
                  "gate",
                  "exhaustedPump",
                  _peEP.lastOi30m ?? null,
                  volMult,
                  price24hChange,
                  _peEP.cycleCount,
                );
              }
              // Памп уже случился — помечаем для batch expire после loop (не блокируем scan)
              oiWatchToExpire.push(symbol);
              // Owner 2026-10-17: a symbol with a live Range arm must still reach
              // the Stealth breakout path. The pump IS the breakout; this gate
              // dropped CYBERLEEK/AGT/OTC/SI/SIREN for 15-47 cycles each. Other
              // patterns stay blocked for it.
              if (!activeRangeArmSymbols.has(symbol)) break symbolBlock;
              canEvaluateNonStealth = false;
            }

            // Owner 2026-10-13: the generic p24h < -8% deepNeg gate was removed
            // for every pattern; each pattern keeps its own entry gates.

            const _accumPrescanEntry = prescanTracker.get(symbol);
            // Тихое/дип/трендовое накопление: cvd30m может быть в минусе по природе паттерна.
            // Глобальный CVD hard gate (cvd30m) убивает такие сигналы — обходим его.
            // Вместо этого накопительные паттерны проверяют cvd1h + cvd4h в своём блоке ниже.
            const isHiddenAccumLikely =
              _accumPrescanEntry != null &&
              ((_accumPrescanEntry.lastOi4h ?? 0) >= 1.5 ||
                (_accumPrescanEntry.lastOi1h ?? 0) >= 2.0) &&
              Math.abs(_accumPrescanEntry.lastPrice1h ?? 0) < 5.0;

            // ── MTF SPOT CVD PRE-FILTER (v9) ─────────────────────────────────────────────
            // Первостепенный фильтр: спот должен подтверждать покупки на 30m (hard gate).
            // Если 1h или 4h в минусе — сигнал помечается как "Scalp Only" (риск разворота).
            // Если CoinGlass недоступен → не блокируем сигнал (graceful fallback).
            let spotCvd: Awaited<ReturnType<typeof getSpotCvdMtf>> | null =
              null;
            let isScalpOnly = false;
            let _spotCvdHardBlocked = false;
            let _cvdPrevPositiveCycles = 0; // значение cvdPositiveCycles ДО обновления текущего цикла
            {
              const spotCvdPriority =
                (_accumPrescanEntry?.cycleCount ?? 0) >= 2 ? "high" : "normal";
              if (!isRangeOnlySupplemental) {
                spotCvd = await getSpotCvdMtf(symbol, {
                  priority: spotCvdPriority,
                });
              }
              if (spotCvd) {
                _spotCvdMapScan.set(symbol, spotCvd); // сохраняем для signalsToInsert.push (второй цикл)
              }
              if (spotCvd?.available && spotCvd.hardBlocked) {
                // Defer continue — _maybeSpotDivergence check needs to happen first
                _spotCvdHardBlocked = true;
              }
              if (spotCvd?.available) {
                isScalpOnly = spotCvd.scalpOnly;
                logger.debug(
                  {
                    symbol,
                    cvd30m: spotCvd.cvd30m,
                    cvd1h: spotCvd.cvd1h,
                    cvd4h: spotCvd.cvd4h,
                    scalpOnly: isScalpOnly,
                    isGolden: spotCvd.isGolden,
                  },
                  spotCvd.isGolden
                    ? "✅ MTF SPOT CVD: Golden Signal (все 4 ТФ в плюсе)"
                    : isScalpOnly
                      ? "⚠️ MTF SPOT CVD: 30m ок, но 1h/4h в минусе → Scalp Only"
                      : "✅ MTF SPOT CVD: подтверждено",
                );
              }
              const _prescanForCvd = prescanTracker.get(symbol);
              // Сохраняем значение ДО обновления текущего цикла — используется в history bypass
              // всё равно должна позволить пройти токену с устойчивой историей.
              _cvdPrevPositiveCycles = _prescanForCvd?.cvdPositiveCycles ?? 0;
              if (_prescanForCvd && spotCvd?.available) {
                _prescanForCvd.lastCvdOk = !spotCvd.hardBlocked;
                _prescanForCvd.lastNetBuyPct =
                  spotCvd.cvd30m === true
                    ? 50
                    : spotCvd.cvd30m === false
                      ? -50
                      : 0;
                _prescanForCvd.lastCvd15m = spotCvd.cvd15m;
                _prescanForCvd.lastCvd30m = spotCvd.cvd30m;
                _prescanForCvd.lastCvd1h = spotCvd.cvd1h;
                _prescanForCvd.lastCvd4h = spotCvd.cvd4h;
                // Счётчик spot CVD: сколько циклов подряд spot CVD 30m положительный.
                // Сбрасывается при первом минусе. takerPositiveCycles обновляется ниже,
                // после того как получены реальные данные CoinGlass taker (scanTf).
                const cvd30mPos = spotCvd.cvd30m === true;
                _prescanForCvd.cvdPositiveCycles = cvd30mPos
                  ? (_prescanForCvd.cvdPositiveCycles ?? 0) + 1
                  : 0;
              }
              // Обновляем постоянный кэш CVD-данных (даже если символ потом выпадет из prescan)
              if (spotCvd?.available) {
                const _lk = lastKnownLiveData.get(symbol);
                const _pe2 = prescanTracker.get(symbol);
                lastKnownLiveData.set(symbol, {
                  oi30m: _lk?.oi30m ?? null,
                  oi1h: _lk?.oi1h ?? null,
                  oi4h: _lk?.oi4h ?? null,
                  oi24h: _lk?.oi24h ?? null,
                  cvd15m: spotCvd.cvd15m ?? null,
                  cvd30m: spotCvd.cvd30m ?? null,
                  cvd1h: spotCvd.cvd1h ?? null,
                  cvd4h: spotCvd.cvd4h ?? null,
                  netBuyPct:
                    spotCvd.cvd30m === true
                      ? 50
                      : spotCvd.cvd30m === false
                        ? -50
                        : (_lk?.netBuyPct ?? null),
                  price1h: _lk?.price1h ?? null,
                  price24h: _pe2?.lastPrice24h ?? _lk?.price24h ?? null,
                  spotTakerNetBuy:
                    _pe2?.lastSpotTakerNetBuy ?? _lk?.spotTakerNetBuy ?? null,
                  spotTakerDominance:
                    _pe2?.lastSpotTakerDominance ??
                    _lk?.spotTakerDominance ??
                    null,
                  whaleIndex: _pe2?.lastWhaleIndex ?? _lk?.whaleIndex ?? null,
                  updatedAt: Date.now(),
                });
              }
            }

            // ── STEP 1: PRIMARY FILTER — CoinGlass глобальный OI (агрегат по всем биржам) ──
            // Проверяем 5 таймфреймов: 5m, 30m, 1h, 4h, 24h.
            // Fast Track символы проходят этот блок без проверки OI.
            const cgOI = coinglassOIMap.get(symbol);

            // Owner rule: only aggregated OI; no data = no signal.

            const oi30m = cgOI?.oiChange30m ?? null;
            const oi1h = cgOI?.oiChange1h ?? null;
            const oi4h = cgOI?.oiChange4h ?? null;
            // oi24h: CoinGlass → Coinalyze кэш (без HTTP, батч прогрет выше)
            const oi24h = cgOI?.oiChange24h ?? null;

            // Сохраняем live OI TF данные и 1h цену в prescan tracker для отображения в UI
            {
              const _pe = prescanTracker.get(symbol);
              if (_pe) {
                _pe.lastOi30m = oi30m;
                _pe.lastOi1h = oi1h;
                _pe.lastOi4h = oi4h;
                _pe.lastOi24h = oi24h;
                _pe.lastPrice1h = price1hChange;
                _pe.lastPrice3h = price3h;
                _pe.prevVolMult = _pe.lastVolMult; // сохраняем прошлый цикл перед перезаписью
                _pe.lastVolMult = volMult;
                _pe.lastAvgVol = avgVol;
                // volAccelSpike: объём удвоился за один цикл (~10 мин) + токен долго в prescan
                const _volAccel =
                  _pe.lastVolMult && _pe.prevVolMult && _pe.prevVolMult > 0
                    ? _pe.lastVolMult / _pe.prevVolMult
                    : null;
                _pe.volAccelSpike =
                  _volAccel !== null &&
                  _volAccel >= 2.0 &&
                  (_pe.cycleCount ?? 0) >= 5;
                _pe.lastCgTimedOut = cgOI?.timedOut ?? false;
                if (cgOI?.available) _pe.lastOiAt = Date.now();
              }
              // Обновляем постоянный кэш OI-данных (fallback для выпавших из prescan открытых позиций)
              {
                const _lk = lastKnownLiveData.get(symbol);
                const _pe3 = prescanTracker.get(symbol);
                lastKnownLiveData.set(symbol, {
                  oi30m,
                  oi1h,
                  oi4h,
                  oi24h,
                  cvd15m: _lk?.cvd15m ?? null,
                  cvd30m: _lk?.cvd30m ?? null,
                  cvd1h: _lk?.cvd1h ?? null,
                  cvd4h: _lk?.cvd4h ?? null,
                  netBuyPct: _lk?.netBuyPct ?? null,
                  price1h: price1hChange,
                  price24h: _pe3?.lastPrice24h ?? _lk?.price24h ?? null,
                  spotTakerNetBuy:
                    _pe3?.lastSpotTakerNetBuy ?? _lk?.spotTakerNetBuy ?? null,
                  spotTakerDominance:
                    _pe3?.lastSpotTakerDominance ??
                    _lk?.spotTakerDominance ??
                    null,
                  whaleIndex: _pe3?.lastWhaleIndex ?? _lk?.whaleIndex ?? null,
                  updatedAt: Date.now(),
                });
              }
            }

            const _plmCvd15m = _plmEntry?.lastCvd15m ?? null;
            const _plmCvd30m = _plmEntry?.lastCvd30m ?? null;
            const _plmCvd1h = _plmEntry?.lastCvd1h ?? null;
            const _plmCvd4h = _plmEntry?.lastCvd4h ?? null;
            const _plmSnf1h = _plmSpotNetflow?.netPct1h ?? null;
            const _plmSnf4h = _plmSpotNetflow?.netPct4h ?? null;
            const _plmDecisionMetrics = Object.freeze({
              p24h: price24hChange,
              p3h: price3h,
              snf1h: _plmSnf1h,
              snf4h: _plmSnf4h,
              cvd15m: _plmCvd15m,
              cvd30m: _plmCvd30m,
              cvd1h: _plmCvd1h,
              cvd4h: _plmCvd4h,
              cvdCount: [_plmCvd15m, _plmCvd30m, _plmCvd1h, _plmCvd4h].filter(
                (value) => value === true,
              ).length,
              oi30m: oi30m ?? null,
              oi1h: oi1h ?? null,
              oi4h: oi4h ?? null,
              volume: volMult,
              futVolMult: volMult,
              spotVolMult: _plmSpotVolMult,
              prescanCycles: prescanTracker.get(symbol)?.cycleCount ?? null,
            });
            _pdbCtx.value = Object.freeze({
              symbol,
              entryPrice: close > 0 ? close : null,
              oi30m: oi30m ?? null,
              volMult: volMult ?? null,
              price24h: price24hChange ?? null,
              prescanCycles: prescanTracker.get(symbol)?.cycleCount ?? null,
              priceLedMomentumMetrics: _plmDecisionMetrics,
              impulseBuyMetrics: {
                candleOpen: parseFloat(_closed30m?.open ?? "") || null,
                candleHigh: parseFloat(_closed30m?.high ?? "") || null,
                candleLow: parseFloat(_closed30m?.low ?? "") || null,
                candleClose: _impulseCandleClose || null,
                candleVolumeUsd: _impulseCandleVolumeUsd || null,
                baselineVolumeUsd: _impulseBaselineVolumeUsd || null,
                candleBodyPct: _impulseDecision.candleBodyPct,
                candleVolumeMult: _impulseDecision.volumeMultiplier,
                candleCloseStrength: _impulseDecision.closeStrength,
                candleClosedAt: _closed30m
                  ? new Date(_closed30m.time + 30 * 60_000).toISOString()
                  : null,
                fundingRate: _impulseFundingRate,
                liqLong1h: _impulseLiqAtDecision?.longLiq1h ?? null,
                liqLong24h: _impulseLiqAtDecision?.longLiq24h ?? null,
                liqRatio: _impulseLiqShadow.liquidationRatio,
                liqRatioAbove015Shadow: _impulseLiqShadow.aboveShadowThreshold,
                liqCacheStale: _impulseLiqAtDecision?.stale ?? null,
                liqCacheAgeMs: _impulseLiqAtDecision?.cacheAgeMs ?? null,
                oi30mDecision: _impulseOi30m,
                oi30mSource: _impulseOi30mSource,
                oi1h,
                oi4h,
                price1h: Number.isFinite(price1hChange) ? price1hChange : null,
                price3h: base3hClose > 0 ? price3h : null,
                spotVolumeMultiplier: _impulseSpotVolMult,
                // Exactly the values evaluateImpulseBuy judged (fresh
                // aggregated CVD/taker when measured), not the prescan cache.
                cvd15m: _impulseCvd15m,
                cvd30m: _impulseCvd30m,
                cvd1h: _impulseCvd1h,
                cvd4h: _impulseCvd4h,
                futTakerNetBuyPct: _impulseFutTakerNetBuyPct,
                components: _impulseDecision.components,
              },
            });

            // PLM определяется до общих деривативных фильтров, чтобы OI/Futures
            // метрики оставались только телеметрией, а не скрытыми gate'ами.
            _pdbCheck("impulse_buy");
            if (_impulseDecision.passes) {
              _pdbPass("impulse_buy");
              recordImpulseBuyShadowCandidate({
                symbol,
                priceAtLog: close,
                price24h: price24hChange,
                price3h,
                price1h: price1hChange,
                oi30m,
                oi1h,
                oi4h,
                volMult,
                spotVolMult: _impulseSpotVolMult,
                futTakerNetBuyPct: _impulseFutTakerNetBuyPct,
                fundingRate: _impulseFundingRate,
                liqLong1h: _impulseLiqAtDecision?.longLiq1h ?? null,
                liqLong24h: _impulseLiqAtDecision?.longLiq24h ?? null,
                liqRatio: _impulseLiqShadow.liquidationRatio,
                liqRatioAbove015Shadow: _impulseLiqShadow.aboveShadowThreshold,
                liqCacheStale: _impulseLiqAtDecision?.stale ?? null,
                liqCacheAgeMs: _impulseLiqAtDecision?.cacheAgeMs ?? null,
                cvd30m: _impulseCvd30m,
                cvd1h: _impulseCvd1h,
                candleBodyPct: _impulseDecision.candleBodyPct!,
                candleVolumeMult: _impulseDecision.volumeMultiplier!,
                candleCloseStrength: _impulseDecision.closeStrength!,
                candleClosedAt: new Date(_closed30m!.time + 30 * 60_000),
                score: _impulseDecision.score,
                components: _impulseDecision.components,
                observedAt: new Date(),
              });
            } else {
              const _impulseReject = [
                ..._impulseDecision.missingReasons,
                ..._impulseDecision.rejectReasons,
              ].join("+");
              _pdbReject("impulse_buy", _impulseReject);
              _symRej(
                symbol,
                "impulse_buy",
                _impulseReject,
                oi30m,
                volMult,
                price24hChange,
                _plmEntry?.cycleCount ?? null,
              );
            }

            // ── OI межцикловый gate (1а): оба цикла должны быть положительными ──────────
            // Применяется ТОЛЬКО если CG данные уже накоплены (оба поля не null).
            // Один спайк — шум. Два цикла подряд положительных — накопление.
            // PLM — исключение: его подтверждают цена и спотовый поток, не OI.
            const _oiGatePe = prescanTracker.get(symbol);
            // 30m history was requested for this prescan symbol this cycle and did
            // not arrive: the inter-cycle gate cannot be evaluated. No substitute
            // value is used; the symbol is refused with an explicit code.
            if (
              coinglassOIMap.get(symbol)?.historyMissing === true &&
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "oi_intercycle",
              )
            ) {
              _symRej(
                symbol,
                "gate",
                "oi_history_unavailable",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }
            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "oi_intercycle",
              ) &&
              _oiGatePe?.lastOi30m != null &&
              _oiGatePe?.prevOi30m != null
            ) {
              // Байпас для токенов с сильным суточным OI — они накапливаются тихо,
              // краткосрочные TF при этом могут быть нейтральными или слабо отрицательными.
              const has24hStrength = (_oiGatePe.lastOi24h ?? 0) >= 10.0;
              if (
                !has24hStrength &&
                ((_oiGatePe.lastOi30m ?? 0) <= 0 ||
                  (_oiGatePe.prevOi30m ?? 0) <= 0)
              ) {
                logger.debug(
                  {
                    symbol,
                    lastOi30m: _oiGatePe.lastOi30m,
                    prevOi30m: _oiGatePe.prevOi30m,
                    lastOi24h: _oiGatePe.lastOi24h,
                  },
                  "OI gate: OI не растёт два цикла подряд — пропускаем глубокий скан",
                );
                _symRej(
                  symbol,
                  "gate",
                  "oi_not_growing_two_cycles",
                  null,
                  null,
                  null,
                  null,
                );
                break symbolBlock;
              }
            }

            // spot_divergence: специально ищет токены где cvd30m негативен при позитивных 1h/4h
            // — глобальный CVD gate его системно блокирует до проверки паттерна. Исключаем.
            // anyOiPass объявлена позже в цикле — не используем, остальных условий достаточно.
            const _maybeSpotDivergence =
              spotCvd?.available === true &&
              spotCvd?.cvd1h === true &&
              spotCvd?.cvd4h === true &&
              price24hChange <= 40 &&
              (prescanTracker.get(symbol)?.cycleCount ?? 0) >= 5;

            // Apply deferred MTF CVD hard block (was deferred to allow _maybeSpotDivergence check)
            if (
              !_isQueuedNeonSupportBounce &&
              _spotCvdHardBlocked &&
              !isHiddenAccumLikely &&
              !_maybeSpotDivergence &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "cvd_hard_block",
              )
            ) {
              // ── History bypass: тот же механизм что ACCUM_PATTERN_KEYS ALLOW[history] ──────
              // Если в предыдущих 3+ циклах CVD 5m был стабильно положительным, один «минусовой»
              // цикл не повод блокировать — это может быть краткосрочный откат при накоплении.
              // Страховочный клапан: тейкер активно продаёт (lastNetBuyPct < -30%) → история
              // не перекрывает, блокируем как обычно.
              //
              // СТАНДАРТ CVD-HISTORY BYPASS (общий фильтр, до паттерна):
              //   cycles >= 3, taker > -30% (мягче по давлению).
              //   Высокая планка по циклам — потому что контекст паттерна ещё не известен,
              //   история CVD — единственный аргумент для bypass.
              //   Мягкий тейкер — потому что до паттерна непонятно, какое давление нормально
              //   для конкретного сетапа; блокировать слишком рано значит не дать шанса pattern-детекции.
              //   Если добавляешь новый bypass-путь на уровне общего фильтра — следуй этому стандарту,
              //   не придумывай третий набор цифр без явной причины. На уровне конкретного паттерна
              //   см. стандарт в quiet_oi_accumulation ниже (cycles >= 2, taker >= -10%).
              const _cvdBypassEntry = prescanTracker.get(symbol);
              const _takerActivelyAgainst =
                (_cvdBypassEntry?.lastNetBuyPct ?? 0) < SPOT_TAKER_HEAVY_SELL;
              if (_cvdPrevPositiveCycles >= 3 && !_takerActivelyAgainst) {
                logger.info(
                  {
                    symbol,
                    prevCvdCycles: _cvdPrevPositiveCycles,
                    lastNetBuyPct:
                      _cvdBypassEntry?.lastNetBuyPct?.toFixed(1) ?? "n/a",
                  },
                  "ALLOW[history]: MTF CVD gate — 3+ цикла CVD+ в истории, тейкер нейтральный — пропускаем",
                );
                // fallthrough — не continue
              } else {
                const prescanCycles = _cvdBypassEntry?.cycleCount ?? 0;
                if (prescanCycles >= 3 && spotCvd?.cvd30m !== false) {
                  // Тёплый токен (3+ цикла) + cvd30m не явно отрицательный: soft pass
                  logger.debug(
                    { symbol, prescanCycles, cvd30m: spotCvd?.cvd30m },
                    "CVD soft pass: тёплый токен, cvd30m не отрицательный",
                  );
                } else {
                  // Новый токен или cvd30m явно false — spot vol surge bypass или блок
                  const _svpe = prescanTracker.get(symbol);
                  const _svMult =
                    _svpe?.spotVolAvg1h && _svpe?.lastSpotVol1h
                      ? _svpe.lastSpotVol1h / _svpe.spotVolAvg1h
                      : null;
                  if (_svMult !== null && _svMult >= 3.0) {
                    logger.info(
                      {
                        symbol,
                        spotVolMult: _svMult.toFixed(2) + "x",
                        cycles: prescanCycles,
                        cvd1h: spotCvd?.cvd1h ?? "n/a",
                      },
                      "CVD bypass[hard]: spot vol surge ≥3x → CVD gate пропущен (cvd1h проверит паттерн)",
                    );
                    // fallthrough — spot vol patterns проверим ниже
                  } else {
                    logger.info(
                      {
                        symbol,
                        prescanCycles,
                        cvd30m: spotCvd?.cvd30m,
                        oi30m: oi30m?.toFixed(1) ?? "n/a",
                        vol: volMult.toFixed(2) + "x",
                        price: priceChange.toFixed(2) + "%",
                      },
                      "SKIP [MTF SPOT CVD]: спот не подтверждает покупки (30m в минусе)",
                    );
                    skipCount.cvdFail++;
                    gateRejectLog.push({
                      sym: symbol,
                      gate: "cvdFail",
                      oi30m: oi30m?.toFixed(2) ?? "n/a",
                      vol: volMult.toFixed(2) + "x",
                      price: priceChange.toFixed(2) + "%",
                      extra: `cvd30m=${spotCvd?.cvd30m ?? "n/a"},cycles=${prescanCycles}`,
                    });
                    _symRej(
                      symbol,
                      "gate",
                      "cvdFail",
                      oi30m ?? null,
                      volMult,
                      price24hChange,
                      prescanCycles,
                    );
                    break symbolBlock;
                  }
                }
              }
            }

            // Пороги — дифференцированные по ТФ (минимальный ТФ — 30m):
            const OI_THRESH_30M = 4.0; // снижен с 6% → ловим накопление раньше
            const OI_THRESH_1H = 3.0;
            const OI_THRESH_4H = 5.0; // снижен с 8% → TOP-10 проходит быстрее
            const OI_THRESH_24H = 10.0; // снижен с 20% → стабильный интерес от 10% за сутки
            // Требуем ПОЛОЖИТЕЛЬНЫЙ OI — отрицательный означает закрытие позиций/окончание движения.
            const t30 = oi30m !== null && oi30m >= OI_THRESH_30M;
            const t1h = oi1h !== null && oi1h >= OI_THRESH_1H;
            const t4h = oi4h !== null && oi4h >= OI_THRESH_4H;
            const shortTfNotDumping = oi30m !== null && oi30m > -3; // 30m OI не в глубоком минусе
            const t24h =
              oi24h !== null && oi24h >= OI_THRESH_24H && shortTfNotDumping;

            // ── ФИЛЬТР: памп уже был — кросс-биржевой OI (CoinGlass, агрегат всех бирж) ──
            //
            // CoinGlass = агрегат Binance + Bybit + OKX + BingX + др. → это глобальный сигнал,
            // не привязан к одной бирже. Два случая:
            //
            // A) CoinGlass вернул 24h OI < -15% → шорты закрывались весь день → памп отыгран.
            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "oi24h_contra",
              ) &&
              oi24h !== null &&
              oi24h < -15
            ) {
              logger.debug(
                { symbol, oi24h: oi24h.toFixed(1) + "%" },
                "SKIP: памп уже был — CoinGlass 24h OI < -15% (глобальный агрегат)",
              );
              skipCount.contraSignal++;
              if (oi30m !== null && oi30m >= 2) {
                gateRejectLog.push({
                  sym: symbol,
                  gate: "contra",
                  oi30m: oi30m.toFixed(2),
                  vol: volMult.toFixed(2) + "x",
                  price: priceChange.toFixed(2) + "%",
                  extra: `oi24h=${oi24h.toFixed(1)}%`,
                });
                _symRej(
                  symbol,
                  "gate",
                  "contra_oi24h",
                  oi30m,
                  volMult,
                  price24hChange,
                  prescanTracker.get(symbol)?.cycleCount ?? null,
                );
              }
              break symbolBlock;
            }

            // B) CoinGlass покрывает монету, но 24h поле отсутствует (null) — типично для малых токенов.
            //    В этом случае смотрим краткосрочные TF: если ВСЕ доступные (5m, 30m, 1h) отрицательные
            //    → OI падает по всему фронту → выдавливание лонгов / пост-памп дамп.
            if (
              !_isQueuedNeonSupportBounce &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "oi24h_contra",
              ) &&
              shouldSkipForNegativeShortOiWithout24h({
                coinglassAvailable: cgOI?.available === true,
                oi24h,
                oi30m,
                oi1h,
              })
            ) {
              logger.debug(
                { symbol, oi30m: oi30m?.toFixed(1), oi1h: oi1h?.toFixed(1) },
                "SKIP: 24h OI недоступен, но все краткосрочные TF отрицательные — OI падает по всему фронту",
              );
              skipCount.contraSignal++;
              _symRej(
                symbol,
                "gate",
                "contra_oi_all_short_tf_negative_no_24h",
                null,
                null,
                null,
                null,
              );
              break symbolBlock;
            }

            // "Steady Accumulation": 30m OI умеренный (2–4%) + цена во флэте.
            // Ловит скрытое накопление где 30m OI ниже порога пробоя, но показывает рост.
            const _peTSteady = prescanTracker.get(symbol);
            const _svmTSteady =
              _peTSteady?.spotVolAvg1h && _peTSteady?.lastSpotVol1h
                ? _peTSteady.lastSpotVol1h / _peTSteady.spotVolAvg1h
                : null;
            const tSteady =
              !t30 &&
              !t1h &&
              !t4h &&
              !t24h &&
              oi30m !== null &&
              oi30m >= 2.0 && // 30m OI медленно растёт (2–4%)
              _svmTSteady !== null &&
              _svmTSteady >= 1.2 &&
              Date.now() -
                (prescanTracker.get(symbol)?.firstSeenAt ?? Date.now()) >=
                30 * 60_000; // токен 30+ мин в пресканере

            // Multi-TF confirmation:
            // — 30m — кратчайший ТФ; длинные (1h ≥3%, 4h ≥5%, 24h ≥10%) проходят поодиночке.
            const shortTfsConfirmed = t30;
            const longTfPass = t1h || t4h || t24h;
            const anyOiPass =
              cgOI?.available && (shortTfsConfirmed || longTfPass || tSteady);
            // spot_absorption исключение (2026-07-08): !anyOiPass слишком широкое для этого
            // паттерна — longTfPass (t1h≥3% / t4h≥5% / t24h≥10%) не противоречит тезису
            // "OI не в свежем спайке" (spot_absorption гейтится только на oi30m<4%), а просто
            // означает что OI медленно строился ЧАСЫ назад — это не то же самое, что "уже
            // поймал стандартный OI-паттерн в ЭТОМ цикле". Используем узкую версию: блокируем
            // только если shortTfsConfirmed (реальный свежий спайк 5m+30m) или tSteady (тот же
            // токен уже получил свою запись в oi_watch через STEADY ACCUM в этом же цикле) —
            // иначе будет дублирование сигнала на один и тот же токен.
            const _spotAbsorptionOiBlock = shortTfsConfirmed || tSteady;
            // spot_vol паттерны: нет OI-спайка подтверждённого CoinGlass.
            // BingX-fallback — долгосрочная дельта, не краткосрочный спайк → игнорируем.
            // Если CG недоступен → разрешаем (нет данных о спайке).
            // Если CG доступен и показывает спайк → блокируем.
            const _noOiSpikeForSpotVol =
              cgOI?.available !== true || (!shortTfsConfirmed && !longTfPass);

            if (t30) oiPassCount.t30++;
            if (t1h) oiPassCount.t1h++;
            if (t4h) oiPassCount.t4h++;
            if (t24h) oiPassCount.t24h++;
            if (anyOiPass) oiPassCount.anyOiPass++;

            // ── Фильтр: короткие ТФ + противоречие длинных ────────────────────────────
            // Если сработали только 5м+30м, но 4h или 24h OI глубоко в минусе —
            // весь день шли продажи/выход из позиций, краткосрочный всплеск ложный.
            if (
              !_isQueuedNeonSupportBounce &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "short_tf_conflict",
              ) &&
              shortTfsConfirmed &&
              !longTfPass
            ) {
              if (oi24h !== null && oi24h < -10) {
                logger.debug(
                  { symbol, oi24h: oi24h.toFixed(1) + "%" },
                  "SKIP: 5м+30м ок, но 24ч OI < -10% — дневной слив",
                );
                skipCount.contraSignal++;
                _symRej(
                  symbol,
                  "gate",
                  "oi24h_below_minus10_daily_dump",
                  null,
                  null,
                  null,
                  null,
                );
                break symbolBlock;
              }
              if (oi4h !== null && oi4h < -5) {
                logger.debug(
                  { symbol, oi4h: oi4h.toFixed(1) + "%" },
                  "SKIP: 5м+30м ок, но 4ч OI < -5% — последние 4ч продажи",
                );
                skipCount.contraSignal++;
                _symRej(
                  symbol,
                  "gate",
                  "oi4h_below_minus5",
                  null,
                  null,
                  null,
                  null,
                );
                break symbolBlock;
              }
            }

            // ── Spot Taker Flow ──
            // Кэш 2 мин — повторный вызов дешёвый (cache hit).
            // getSpotTakerFlow: aggregated CoinGlass spot taker only, no fallback.
            const _spotTaker = isRangeOnlySupplemental
              ? null
              : await getSpotTakerFlow(symbol).catch(() => null);

            // Spot taker consecutive cycles update — обновляем счётчик taker netBuyPct > 0.
            // Сбрасывается при первом цикле с netBuyPct <= 0 или при отсутствии данных.
            {
              const _prescanForTaker = prescanTracker.get(symbol);
              if (_prescanForTaker) {
                if (_spotTaker?.available) {
                  _prescanForTaker.takerPositiveCycles =
                    (_spotTaker.netBuyPct ?? 0) > 0
                      ? (_prescanForTaker.takerPositiveCycles ?? 0) + 1
                      : 0;
                  _prescanForTaker.lastSpotTakerNetBuy =
                    _spotTaker.netBuyPct ?? null;
                }
                // Если _spotTaker недоступен — не сбрасываем счётчик, оставляем последнее известное.
              }
            }
            // ── Quiet OI Accumulation (EVAA-тип): микро-OI растёт стабильно, ниже стандартных порогов ──
            // Для микро-токенов где OI 0.2-0.5% за свечу — в 10-30 раз ниже стандартных порогов.
            // Требует cycleCount >= 5: токен давно в пресканере, не одиночный всплеск.
            const prescanAgeMinutes =
              (Date.now() -
                (prescanTracker.get(symbol)?.firstSeenAt ?? Date.now())) /
              60_000;
            const prescanCyclesCurrent = prescanAgeMinutes; // time-based: minutes in prescan
            // Taker gate: текущий цикл спот taker покупает (первичная проверка).
            // Порог тейкера ослаблен 3% → 2% (2026-07-10): одновременное требование низких
            // OI-порогов + Fut Taker было редкой комбинацией — консультант рекомендовал смягчить.
            const _quietTakerOk =
              _spotTaker !== null &&
              _spotTaker.available &&
              (_spotTaker.netBuyPct ?? 0) >= 2;
            // CVD history gate: если taker-данные слабые в ЭТОМ цикле, но spot CVD был
            // положительным 2+ цикла подряд — история накопления достаточна для сигнала.
            // Дополнительное условие: taker не активно отрицательный (>= -10 или нет данных).
            //
            // СТАНДАРТ CVD-HISTORY BYPASS (уровень конкретного паттерна):
            //   cycles >= 2, taker >= -10% (строже по давлению).
            //   Ниже планка по циклам — потому что остальные условия quiet_oi уже жёсткие
            //   (prescanCycles >= 5, oi30m/oi1h/volMult/price-коридор), история CVD добавляет
            //   поверх них, а не заменяет контекст.
            //   Строгий тейкер — потому что паттерн специфически о тихом накоплении:
            //   тейкер -15% при боковой цене прямо противоречит тезису независимо от истории.
            //   Если добавляешь bypass в другой конкретный паттерн — следуй этому стандарту.
            //   На уровне общего фильтра (до паттерна) см. стандарт выше (cycles >= 3, taker > -30%).
            const _quietCvdHistory =
              (prescanTracker.get(symbol)?.cvdPositiveCycles ?? 0) >= 2 &&
              _spotTaker !== null &&
              _spotTaker.available &&
              (_spotTaker.netBuyPct ?? 0) >= SPOT_TAKER_SELL_DOMINANCE;

            // DEBUG: quiet_oi_accumulation near-miss logging
            if (
              canEvaluateNonStealth &&
              !anyOiPass &&
              cgOI?.available === true &&
              prescanCyclesCurrent >= 30
            ) {
              const _qReasons: string[] = [];
              if (oi30m === null || oi30m < 0.2)
                _qReasons.push(`oi30m=${oi30m?.toFixed(2) ?? "null"}<0.2`);
              if (oi1h === null || oi1h < 0.5)
                _qReasons.push(`oi1h=${oi1h?.toFixed(2) ?? "null"}<0.5`);
              if (
                !_spotTaker?.available ||
                (_spotTaker.netBuyPct ?? 999) < QUIET_ACCUM_SPOT_TAKER_MIN
              )
                _qReasons.push(
                  `spottaker=${_spotTaker?.netBuyPct?.toFixed(1) ?? "n/a"}%<3`,
                );
              if (
                volMult < QUIET_ACCUM_VOLMULT_MIN ||
                volMult > QUIET_ACCUM_VOLMULT_MAX
              )
                _qReasons.push(`vol=${volMult.toFixed(2)}x`);
              if (prescanCyclesCurrent < 30)
                _qReasons.push(`ageMin=${prescanCyclesCurrent.toFixed(0)}<30`);
              if (!(price24hChange <= 40))
                _qReasons.push(`price24h=${price24hChange.toFixed(1)}%`);
              if (price3h > 6) _qReasons.push(`price3h=${price3h.toFixed(1)}%`);
              if (_qReasons.length > 0 && _qReasons.length <= 3) {
                logger.info(
                  {
                    symbol,
                    reasons: _qReasons,
                    cycleCount: prescanCyclesCurrent,
                    oi30m: oi30m?.toFixed(2),
                    oi1h: oi1h?.toFixed(2),
                    vol: volMult.toFixed(2),
                    spotNetBuyPct: _spotTaker?.netBuyPct?.toFixed(1),
                    price: priceChange.toFixed(2),
                    price24h: price24hChange.toFixed(1),
                    price3h: price3h.toFixed(1),
                  },
                  "🔬 QUIET_OI_ACCUM near-miss: 1-3 условия не прошли",
                );
              }
            }

            // ── Spot Volume Multiplier: используется вместо фьюч volMult в паттернах ─
            // lastSpotVol1h / spotVolAvg1h — нормированный спот-объём.
            // null если данные ещё не накоплены (spotVolAvg1h = 0 или отсутствует).
            const _peSvm = prescanTracker.get(symbol);
            {
              const _inMap = prescanTracker.has(symbol);
              const _avg = _peSvm?.spotVolAvg1h ?? null;
              const _last = _peSvm?.lastSpotVol1h ?? null;
              if (!_inMap) _spotVolDiag.notInMap++;
              else if (!_avg) _spotVolDiag.noAvg++;
              else if (!_last) _spotVolDiag.noLast++;
              else _spotVolDiag.hasMult++;
              if (_spotVolDiag.sample.length < 5)
                _spotVolDiag.sample.push({
                  sym: symbol,
                  inMap: _inMap,
                  avg: _avg,
                  last: _last,
                  cycles: _peSvm?.spotVolCycles ?? null,
                });
            }
            const spotVolMult =
              _peSvm?.spotVolAvg1h && _peSvm?.lastSpotVol1h
                ? _peSvm.lastSpotVol1h / _peSvm.spotVolAvg1h
                : null;
            if (spotVolMult !== null)
              _spotVolMultMapScan.set(symbol, spotVolMult);
            const _prevSpotVolMult =
              _peSvm?.prevSpotVol1h && _peSvm?.spotVolAvg1h
                ? _peSvm.prevSpotVol1h / _peSvm.spotVolAvg1h
                : null;

            // 1.2: спот ≥1.3x тоже считается "объёмным трендом" — softens gate для токенов,
            // где фьюч-объём тихий но спот уже активен.
            if (spotVolMult !== null && spotVolMult >= 1.3) isVolTrend = true;

            // ── STEALTH BREAKOUT: frozen 4H Range → closed 4H breakout → 1H holds ─
            // Resistance and continuation shelves remain historical audit only.
            // ABNeon and market participation remain observational telemetry.
            const _sbParticipationTelemetry = {
              capturedAt: _sbEvaluatedAt,
              oi: {
                value:
                  typeof oi30m === "number" && Number.isFinite(oi30m)
                    ? oi30m
                    : null,
                source: "scanner_oi30m",
                available: typeof oi30m === "number" && Number.isFinite(oi30m),
              },
              cvd: {
                value: {
                  cvd15m: _peStealthBrk?.lastCvd15m ?? null,
                  cvd30m: _peStealthBrk?.lastCvd30m ?? null,
                  cvd1h: _peStealthBrk?.lastCvd1h ?? null,
                  cvd4h: _peStealthBrk?.lastCvd4h ?? null,
                },
                source: "prescan_tracker",
                available: [
                  _peStealthBrk?.lastCvd15m,
                  _peStealthBrk?.lastCvd30m,
                  _peStealthBrk?.lastCvd1h,
                  _peStealthBrk?.lastCvd4h,
                ].some((value) => typeof value === "boolean"),
              },
              spotTaker: {
                value:
                  _spotTaker?.available === true
                    ? (_spotTaker.netBuyPct ?? null)
                    : null,
                source: "spot_taker",
                available:
                  _spotTaker?.available === true &&
                  typeof _spotTaker.netBuyPct === "number" &&
                  Number.isFinite(_spotTaker.netBuyPct),
              },
            };
            // Shadow-only evidence.  This snapshot is immutable provenance for
            // a newly-created normal quiet-zone arm; it cannot affect the
            // selected level, allowCreate, eligibility, exits, or Telegram.
            const _sbAbneonSnapshot = buildStealthAbneonArmSnapshotSafely({
              frozenStealthLevel: _sbStructure.breakoutLevel,
              candles4h: _sbFourHourCandles,
              candles1h: _sbOneHourCandles,
              capturedAt: _sbEvaluatedAt,
            });
            const _sbLegacyArm = {
              structure: _sbStructure,
              allowCreate: isLiveStealthBreakoutSource("stealth_legacy"),
              levelSource: "stealth_legacy" as const,
              legacyBreakoutLevel: _sbStructure.breakoutLevel,
              experimentVersion: STEALTH_QUIET_ZONE_4H_EXPERIMENT_VERSION,
            };
            // Retired resistance methods keep their existing ARMED audit and
            // historical entry metrics, but cannot create another setup.
            const _sbUseContinuationShelf =
              isLiveStealthBreakoutSource("continuation_shelf");
            // Fast path (owner 2026-10-11): 1H Range breakout candle with spot OR
            // aggregated futures volume >= 10x its 20-bar mean qualifies without
            // the 30m hold. Only fresh events (<= 90 min after the close) are
            // checked, so CoinGlass load stays bounded.
            let _sbFastVolumePass = false;
            const _sbFastEvent = AUTO_RANGE_1H_LIVE_ENABLED
              ? _sbAutoRangeOneHourResult.latestUpsideBreakout
              : null;
            if (
              _sbFastEvent &&
              _sbFastEvent.breakoutCloseTime <= _sbEvaluatedAt &&
              _sbEvaluatedAt - _sbFastEvent.breakoutCloseTime <= 90 * 60_000
            ) {
              try {
                const _sbFastVol = await checkStealthVolumeGate(
                  symbol,
                  _sbFastEvent.breakoutCloseTime - 60 * 60_000,
                  "1h",
                );
                _sbFastVolumePass =
                  (_sbFastVol.futuresRatio ?? 0) >= 10 ||
                  (_sbFastVol.spotRatio ?? 0) >= 10;
                if (_sbFastVolumePass) {
                  logger.info(
                    {
                      symbol,
                      futuresRatio: _sbFastVol.futuresRatio,
                      spotRatio: _sbFastVol.spotRatio,
                    },
                    "Stealth 1H Range fast volume path (>=10x)",
                  );
                }
              } catch (err) {
                logger.debug(
                  { err, symbol },
                  "Stealth fast volume path unavailable",
                );
              }
            }
            // One aggregated-volume request per interval for all arm evaluations
            // of this symbol (legacy, shelf, 1H primary and secondary).
            const _sbVolumeCandles1h = Math.max(
              _sbOneHourCandles.length,
              _sbAutoRangeOneHourCandles.length,
            );
            const [_sbPrefetchVol1h, _sbPrefetchVol4h] = await Promise.all([
              _sbVolumeCandles1h > 0
                ? getAggFuturesVolumeByInterval(
                    symbol,
                    "1h",
                    Math.min(4500, _sbVolumeCandles1h + 5),
                  ).catch(() => null)
                : Promise.resolve(null),
              _sbFourHourCandles.length > 0
                ? getAggFuturesVolumeByInterval(
                    symbol,
                    "4h",
                    Math.min(4500, _sbFourHourCandles.length + 5),
                  ).catch(() => null)
                : Promise.resolve(null),
            ]);
            const _sbPrefetchedVolumes = {
              "1h": _sbPrefetchVol1h,
              "4h": _sbPrefetchVol4h,
            };
            const [_sbLegacyArmed, _sbShelfArmed, _sbRangeOneHourPrimary] =
              await Promise.all([
                evaluateDurableStealthArm({
                  symbol,
                  structure: _sbLegacyArm.structure,
                  breakoutCandles4h: _sbFourHourCandles,
                  breakoutCandles1h: _sbOneHourCandles,
                  refinementCandles: _sbThirtyMinuteCandles,
                  abneonSnapshot: _sbAbneonSnapshot,
                  evaluatedAt: _sbEvaluatedAt,
                  allowCreate:
                    !isRangeOnlySupplemental && _sbLegacyArm.allowCreate,
                  levelSource: _sbLegacyArm.levelSource,
                  legacyBreakoutLevel: _sbLegacyArm.legacyBreakoutLevel,
                  experimentVersion: _sbLegacyArm.experimentVersion,
                  technicalMode: "closed_1h_30m",
                  atr: _sbAtr ?? undefined,
                  participationTelemetry: _sbParticipationTelemetry,
                  prefetchedVolumes: _sbPrefetchedVolumes,
                }),
                evaluateDurableStealthArm({
                  symbol,
                  structure: _sbContinuationShelf,
                  breakoutCandles4h: _sbFourHourCandles,
                  breakoutCandles1h: _sbOneHourCandles,
                  refinementCandles: _sbThirtyMinuteCandles,
                  evaluatedAt: _sbEvaluatedAt,
                  allowCreate:
                    !isRangeOnlySupplemental && _sbUseContinuationShelf,
                  levelSource: "continuation_shelf",
                  legacyBreakoutLevel: _sbLegacyArm.legacyBreakoutLevel,
                  experimentVersion: STEALTH_QUIET_ZONE_4H_EXPERIMENT_VERSION,
                  technicalMode: "closed_1h_30m",
                  atr: _sbAtr ?? undefined,
                  participationTelemetry: _sbParticipationTelemetry,
                  prefetchedVolumes: _sbPrefetchedVolumes,
                }),
                AUTO_RANGE_1H_LIVE_ENABLED
                  ? evaluateOneHourRangeArm({
                      symbol,
                      slot: "primary",
                      structure: _sbAutoRangeOneHourStructure,
                      fourHourCandles: _sbFourHourCandles,
                      oneHourCandles: _sbAutoRangeOneHourCandles,
                      refinementCandles: _sbThirtyMinuteCandles,
                      evaluatedAt: _sbEvaluatedAt,
                      allowCreate: _sbAutoRangeOneHourIdentity !== null,
                      legacyBreakoutLevel: _sbLegacyArm.legacyBreakoutLevel,
                      participationTelemetry: _sbParticipationTelemetry,
                      identity: _sbAutoRangeOneHourIdentity,
                      result: _sbAutoRangeOneHourResult,
                      fastVolumePass: _sbFastVolumePass,
                      prefetchedVolumes: _sbPrefetchedVolumes,
                    })
                  : Promise.resolve({
                      status: "not_armed" as const,
                      reason: "creation_blocked" as const,
                    }),
              ]);
            // Second live arm (owner 2026-10-19): the detector shows a confirmed
            // range that differs from the primary arm's range. The primary stays
            // under its own rule (17.10); the new range gets its own arm.
            // Maximum two live arms per symbol.
            let _sbRangeOneHourSecondary: Awaited<
              ReturnType<typeof evaluateOneHourRangeArm>
            > | null = null;
            if (AUTO_RANGE_1H_LIVE_ENABLED) {
              const _sbPrimaryIdentity =
                "arm" in _sbRangeOneHourPrimary
                  ? _sbRangeOneHourPrimary.arm.autoRangeIdentity
                  : undefined;
              const _sbNeedsSecondary =
                _sbAutoRangeOneHourIdentity !== null &&
                _sbAutoRangeOneHourResult.status === "ready" &&
                _sbPrimaryIdentity !== undefined &&
                _sbPrimaryIdentity !== null &&
                !sameStealthAutoRangeInstance(
                  _sbPrimaryIdentity,
                  _sbAutoRangeOneHourIdentity,
                );
              if (_sbNeedsSecondary || secondaryOneHourArmSymbols.has(symbol)) {
                _sbRangeOneHourSecondary = await evaluateOneHourRangeArm({
                  symbol,
                  slot: "secondary",
                  structure: _sbAutoRangeOneHourStructure,
                  fourHourCandles: _sbFourHourCandles,
                  oneHourCandles: _sbAutoRangeOneHourCandles,
                  refinementCandles: _sbThirtyMinuteCandles,
                  evaluatedAt: _sbEvaluatedAt,
                  allowCreate: _sbNeedsSecondary,
                  legacyBreakoutLevel: _sbLegacyArm.legacyBreakoutLevel,
                  participationTelemetry: _sbParticipationTelemetry,
                  identity: _sbAutoRangeOneHourIdentity,
                  result: _sbAutoRangeOneHourResult,
                  fastVolumePass: _sbFastVolumePass,
                  prefetchedVolumes: _sbPrefetchedVolumes,
                });
              }
            }
            // The fire pipeline consumes one 1H result: the primary, unless only
            // the secondary arm has a confirmed breakout.
            const _sbRangeOneHourArmed =
              _sbRangeOneHourPrimary.status !== "qualified" &&
              _sbRangeOneHourSecondary?.status === "qualified"
                ? _sbRangeOneHourSecondary
                : _sbRangeOneHourPrimary;
            const _sbQualifiedVenueConfirmation =
              selectAutoRangeVenueConfirmation(
                _sbAutoRangeVenueCandidates.flatMap((candidate) => {
                  const armed = _sbRangeArmedEarlyByVenue.get(candidate.venue);
                  if (
                    armed?.status !== "qualified" ||
                    armed.decision.status !== "qualified" ||
                    !armed.arm.autoRangeIdentity
                  ) {
                    return [];
                  }
                  return [
                    {
                      status: "confirmed" as const,
                      venue: candidate.venue,
                      symbol,
                      upper: armed.arm.autoRangeIdentity.upper,
                      lower: armed.arm.autoRangeIdentity.lower,
                      breakoutCloseTime: armed.decision.firstCrossAt,
                      previouslyConfirmedVenues:
                        armed.arm.autoRangeIdentity.confirmingVenues,
                    },
                  ];
                }),
              );
            if (_sbQualifiedVenueConfirmation) {
              const confirmingArmIds = _sbAutoRangeVenueCandidates.flatMap(
                (candidate) => {
                  const armed = _sbRangeArmedEarlyByVenue.get(candidate.venue);
                  if (
                    armed?.status !== "qualified" ||
                    armed.decision.status !== "qualified" ||
                    !armed.arm.autoRangeIdentity
                  ) {
                    return [];
                  }
                  const key = buildAutoRangeLifecycleKey(symbol, {
                    upper: armed.arm.autoRangeIdentity.upper,
                    lower: armed.arm.autoRangeIdentity.lower,
                    breakoutCloseTime: armed.decision.firstCrossAt,
                  });
                  return key === _sbQualifiedVenueConfirmation.lifecycleKey
                    ? [armed.armId]
                    : [];
                },
              );
              try {
                await persistStealthAutoRangeConfirmingVenues({
                  armIds: confirmingArmIds,
                  venues: _sbQualifiedVenueConfirmation.confirmingVenues,
                });
              } catch (error) {
                logger.warn(
                  {
                    symbol,
                    venues: _sbQualifiedVenueConfirmation.confirmingVenues,
                    error,
                  },
                  "Unable to persist immutable Range venue provenance on arms",
                );
              }
            }
            const _sbSelectedRangeVenue =
              _sbQualifiedVenueConfirmation?.selectedVenue ??
              _sbAutoRangeVenueCandidates.find((candidate) =>
                _sbRangeArmedEarlyByVenue.has(candidate.venue),
              )?.venue ??
              "bingx";
            const _sbRangeArmedResult =
              _sbRangeArmedEarlyByVenue.get(_sbSelectedRangeVenue) ??
              (_sbSelectedRangeVenue === "bingx" ? _sbRangeArmedEarly : null);
            const _sbRangeArmed = _sbRangeArmedResult ?? {
              status: "not_armed" as const,
              reason: "creation_blocked" as const,
            };
            // Historical resistance arms still advance their audit/expiry above,
            // but only the frozen 4H Range arm may become a new signal.
            // The live 1H Range arm must be consumed too: it is created and
            // advanced above, so ignoring its result leaves qualified arms to
            // expire unclaimed.
            const _sbWinner =
              AUTO_RANGE_1H_LIVE_ENABLED &&
              _sbRangeOneHourArmed.status === "qualified"
                ? _sbRangeOneHourArmed
                : AUTO_RANGE_LIVE_ENABLED &&
                    _sbRangeArmed.status === "qualified"
                  ? _sbRangeArmed
                  : null;
            const _sbDeduplicatedArmIds: number[] = [];
            if (_sbWinner) {
              for (const other of [_sbRangeOneHourArmed, _sbRangeArmed]) {
                if (
                  other.status === "qualified" &&
                  other.armId !== _sbWinner.armId
                ) {
                  _sbDeduplicatedArmIds.push(other.armId);
                }
              }
            }
            const _sbArmed =
              _sbWinner ??
              (_sbRangeOneHourArmed.status !== "not_armed" &&
              _sbRangeOneHourArmed.status !== "terminal_structure" &&
              (_sbRangeArmed.status === "not_armed" ||
                _sbRangeArmed.status === "terminal_structure")
                ? _sbRangeOneHourArmed
                : _sbRangeArmed);
            const _sbSelectedRangeCandidate =
              _sbAutoRangeVenueCandidates.find(
                (candidate) => candidate.venue === _sbSelectedRangeVenue,
              ) ?? null;
            const _sbEvaluationStructure =
              "arm" in _sbArmed &&
              _sbArmed.arm.levelSource === "continuation_shelf"
                ? _sbContinuationShelf
                : "arm" in _sbArmed &&
                    _sbArmed.arm.levelSource === "auto_range_1h"
                  ? _sbAutoRangeOneHourStructure
                  : "arm" in _sbArmed &&
                      _sbArmed.arm.levelSource === "auto_range_4h"
                    ? (_sbSelectedRangeCandidate?.structure ??
                      _sbAutoRangeStructure)
                    : _sbStructure;
            const _sbFrozenLevel =
              "arm" in _sbArmed
                ? _sbArmed.arm.breakoutLevel
                : _sbEvaluationStructure.breakoutLevel;
            const _sbOneHour = confirmStealthOneHourBreakout(
              { breakoutLevel: _sbFrozenLevel },
              _sbArmed.status !== "not_armed" &&
                "arm" in _sbArmed &&
                _sbArmed.arm.levelSource === "auto_range_4h"
                ? (_sbSelectedRangeCandidate?.oneHourCandles ??
                    _sbOneHourCandles)
                : _sbOneHourCandles,
            );
            const _sbThirtyMinute = refineStealthBreakoutEntry(
              { breakoutLevel: _sbFrozenLevel },
              _sbThirtyMinuteCandles,
            );
            const _sbCvd15m = _peStealthBrk?.lastCvd15m ?? null;
            const _sbCvd30m = _peStealthBrk?.lastCvd30m ?? null;
            const _sbCvd1h = _peStealthBrk?.lastCvd1h ?? null;
            const _sbCvd4h = _peStealthBrk?.lastCvd4h ?? null;
            const _sbSpotTakerNetBuy =
              _spotTaker?.available === true
                ? (_spotTaker.netBuyPct ?? null)
                : null;
            const _sbCvdPositive = [
              _sbCvd15m,
              _sbCvd30m,
              _sbCvd1h,
              _sbCvd4h,
            ].some((value) => value === true);
            // Technical-only mode: keep these flow values for logs
            // and later calibration, but do not use them as a firing gate.
            const _sbFlow = {
              oi: oi30m !== null && oi30m > 0,
              cvd: _sbCvdPositive,
              spotTaker: _sbSpotTakerNetBuy !== null && _sbSpotTakerNetBuy > 0,
            };
            const _sbFlowConfirmations = [
              _sbFlow.oi ? "oi30m" : null,
              _sbFlow.cvd ? "cvd" : null,
              _sbFlow.spotTaker ? "spot_taker" : null,
            ].filter((value): value is string => value !== null);
            // Reaching this point means the scanner's participation, OI, and
            // price-risk gates have not rejected the symbol.
            // Owner 2026-10-17 (BROCCOLIF3B): a qualified arm must not fire on a
            // breakout whose trigger candle closed hours ago (fired 35h late).
            const _sbTriggerAt =
              _sbArmed.status === "qualified" &&
              "confirmation" in _sbArmed.decision
                ? (_sbArmed.decision.confirmation.triggerCandle?.time ?? null)
                : null;
            const _sbBreakoutStale =
              _sbTriggerAt !== null &&
              Date.now() - (_sbTriggerAt + 60 * 60 * 1000) >
                STEALTH_FIRE_WINDOW_MS;
            const _sbPreVolumeFire =
              !_sbBreakoutStale &&
              _sbArmed.status === "qualified" &&
              canDeliverQualifiedRangeArm(_sbArmed, true) &&
              isLiveStealthBreakoutSource(_sbArmed.arm.levelSource);
            // Breakout-candle gate (CoinGlass aggregated): futures >=2x, spot >=2x, bullish.
            // Missing data blocks the entry.
            const _sbVolumeGateBase = _sbPreVolumeFire
              ? await checkStealthCandleGate(
                  symbol,
                  _sbArmed.status === "qualified" &&
                    "confirmation" in _sbArmed.decision
                    ? (_sbArmed.decision.confirmation.triggerCandle?.time ??
                        null)
                    : null,
                  _sbArmed.status === "qualified" &&
                    _sbArmed.arm.levelSource === "auto_range_4h"
                    ? "4h"
                    : "1h",
                  _sbArmed.status === "qualified"
                    ? (_sbArmed.arm.autoRangeIdentity ?? null)
                    : null,
                )
              : null;
            // Momentum filter (owner 2026-10-10): a crossing whose 24h move is
            // already >=4% passes even when the candle body is below the impulse
            // threshold. The OI30m >= +0.04% condition was dropped the same day:
            // on 309 replayed 1H crossings (28 reached +10% first, 57 hit -8%
            // first) "body>=5 OR p24h>=4" caught 15/28 winners with 14 losses vs
            // 9/28 and 12 losses with the OI condition; OI was also unknown for
            // a third of crossings. Unavailable data or a
            // non-bullish candle never passes this way.
            const _sbMomentumCtx =
              _pdbCtx.value !== null && _pdbCtx.value.symbol === symbol
                ? _pdbCtx.value
                : null;
            const _sbMomentumPass =
              _sbVolumeGateBase !== null &&
              !_sbVolumeGateBase.pass &&
              _sbVolumeGateBase.reason !== "candle_not_bullish" &&
              _sbVolumeGateBase.reason !== "unavailable" &&
              _sbVolumeGateBase.reason !== "futures_volume_unavailable" &&
              _sbVolumeGateBase.reason !== "spot_volume_unavailable" &&
              _sbMomentumCtx?.price24h != null &&
              _sbMomentumCtx.price24h >= 4;
            const _sbVolumeGateCandle =
              _sbVolumeGateBase !== null && _sbMomentumPass
                ? {
                    ..._sbVolumeGateBase,
                    pass: true,
                    reason: "momentum_filter_pass" as const,
                  }
                : _sbVolumeGateBase;
            // Owner 2026-10-15: aggregated futures AND spot volume >= 1x.
            const _sbLiveVolume =
              _sbVolumeGateCandle?.pass === true &&
              _sbArmed.status === "qualified" &&
              "confirmation" in _sbArmed.decision &&
              _sbArmed.decision.confirmation.triggerCandle?.time != null
                ? await checkStealthVolumeGate(
                    symbol,
                    _sbArmed.decision.confirmation.triggerCandle.time,
                    _sbArmed.arm.levelSource === "auto_range_4h" ? "4h" : "1h",
                    Date.now(),
                    true,
                  )
                : null;
            const _sbVolumeGate =
              _sbVolumeGateCandle !== null && _sbLiveVolume !== null
                ? applyStealthLiveVolumeRule(_sbVolumeGateCandle, _sbLiveVolume)
                : _sbVolumeGateCandle;
            if (_sbPreVolumeFire && _sbArmed.status === "qualified") {
              const _sbPe = prescanTracker.get(symbol);
              const _sbCtx =
                _pdbCtx.value !== null && _pdbCtx.value.symbol === symbol
                  ? _pdbCtx.value
                  : null;
              void dbWriteBestEffort("stealth/decision-metrics", () =>
                recordStealthDecisionMetrics({
                  armId: _sbArmed.armId,
                  symbol,
                  levelSource: _sbArmed.arm.levelSource,
                  triggerCandleAt:
                    "confirmation" in _sbArmed.decision
                      ? (_sbArmed.decision.confirmation.triggerCandle?.time ??
                        null)
                      : null,
                  outcome: _sbVolumeGate?.pass ? "gate_pass" : "gate_fail",
                  metrics: {
                    oi30m: oi30m ?? null,
                    oi1h: _sbPe?.lastOi1h ?? null,
                    oi4h: _sbPe?.lastOi4h ?? null,
                    cvd15m: _sbCvd15m,
                    cvd30m: _sbCvd30m,
                    cvd1h: _sbCvd1h,
                    cvd4h: _sbCvd4h,
                    spotTakerNetBuyPct: _sbSpotTakerNetBuy,
                    whaleIndex: _sbPe?.lastWhaleIndex ?? null,
                    volMult: _sbCtx?.volMult ?? null,
                    price24h: _sbCtx?.price24h ?? null,
                    entryPrice: _sbCtx?.entryPrice ?? null,
                    frozenLevel: _sbArmed.arm.breakoutLevel,
                    volumeGate: _sbVolumeGate,
                  },
                }),
              );
            }
            if (_sbVolumeGate && !_sbVolumeGate.pass) {
              logger.info(
                {
                  symbol,
                  futuresRatio: _sbVolumeGate.futuresRatio,
                  spotRatio: _sbVolumeGate.spotRatio,
                  reason: _sbVolumeGate.reason,
                  bodyPct: _sbVolumeGate.bodyPct,
                  source: _sbVolumeGate.source,
                  diagnostics: _sbVolumeGate.diagnostics,
                },
                "Stealth breakout held: breakout candle failed body / range-width / bullish rule",
              );
            }
            // Owner order 2026-10-15: the wider-active-range veto is removed.
            // Independent re-check (owner order 2026-10-07, SAND): the frozen 1H
            // range must be the one a fresh Pine replay actually shows.
            const _sbRangeRecheck =
              _sbPreVolumeFire &&
              _sbVolumeGate?.pass === true &&
              _sbArmed.status === "qualified" &&
              _sbArmed.arm.levelSource === "auto_range_1h" &&
              _sbArmed.arm.autoRangeIdentity
                ? await recheckFrozenOneHourRange(
                    symbol,
                    _sbArmed.arm.autoRangeIdentity,
                  )
                : null;
            // Owner decision 2026-10-10: replay is path-dependent. Only a replay
            // that shows a DIFFERENT range blocks; no-breakout/unavailable replay
            // no longer kills a qualified breakout of the frozen level.
            if (_sbRangeRecheck && !_sbRangeRecheck.ok) {
              logger.warn(
                {
                  symbol,
                  reason: _sbRangeRecheck.reason,
                  detail: _sbRangeRecheck.detail,
                },
                "Stealth breakout held: frozen 1H range not confirmed by fresh replay",
              );
            }
            // Owner 2026-10-15 (AT): the broken level must coincide with an
            // SRv2 zone (1% tolerance); a line inside a larger range is not a
            // breakout level.
            const _sbSrv2 =
              _sbPreVolumeFire &&
              _sbVolumeGate?.pass === true &&
              _sbArmed.status === "qualified"
                ? await checkStealthLevelOnSrv2(
                    symbol,
                    _sbArmed.arm.breakoutLevel,
                    _sbArmed.arm.levelSource === "auto_range_4h" ? "4h" : "1h",
                  )
                : null;
            if (_sbSrv2 && !_sbSrv2.ok) {
              logger.warn(
                { symbol, reason: _sbSrv2.reason, detail: _sbSrv2.detail },
                "Stealth breakout held: level not on an SRv2 zone",
              );
            }
            // A breakout whose live price is back below the frozen level is not
            // a breakout (PARTI 2026-10-13: entered 2.7% below the level; 73% of
            // below-level 60d entries were later closed neutral as false).
            const _sbLivePrice = Number.parseFloat(ticker.lastPrice);
            const _sbPriceBelowFrozenLevel =
              _sbArmed.status === "qualified" &&
              Number.isFinite(_sbLivePrice) &&
              _sbLivePrice > 0 &&
              _sbLivePrice < _sbArmed.arm.breakoutLevel;
            // Owner 2026-10-18: 1H breakout candle must close >=1% above the range
            // top with body >= 1 ATR14. Missing data fails open and is journaled.
            const _sbQuality =
              _sbPreVolumeFire &&
              _sbVolumeGate?.pass === true &&
              _sbArmed.status === "qualified" &&
              _sbArmed.arm.levelSource === "auto_range_1h"
                ? evaluateBreakoutQuality(
                    _sbOneHourCandles,
                    _sbTriggerAt,
                    _sbArmed.arm.autoRangeIdentity?.upper ?? null,
                  )
                : null;
            const _sbFilterBlocked = _sbQuality?.pass === false;
            // Owner 2026-10-22: spot CVD 4h > 0 is a mandatory Stealth entry
            // condition (unknown CVD blocks; the arm stays qualified and is
            // re-evaluated next cycle).
            // Owner 2026-10-22: CVD4h > 0 removed (no edge in 3 time folds).
            // Replaced by aggregated OI 1h at the breakout candle close > 1.28%;
            // unknown OI blocks and the qualified arm is re-evaluated later.
            // Owner 2026-10-22: Range height (top-bottom)/bottom must exceed 4.5%;
            // narrow ranges almost never give a working breakout. Unknown
            // bounds block (arm stays qualified).
            const _sbRangeIdentity =
              _sbArmed.status === "qualified"
                ? (_sbArmed.arm.autoRangeIdentity ?? null)
                : null;
            const _sbRangeHeightPct =
              _sbRangeIdentity &&
              _sbRangeIdentity.lower > 0 &&
              _sbRangeIdentity.upper > _sbRangeIdentity.lower
                ? ((_sbRangeIdentity.upper - _sbRangeIdentity.lower) /
                    _sbRangeIdentity.lower) *
                  100
                : null;
            // Owner 2026-10-23: height gate replaced by OI 4h > 4.6% and
            // 1H volume ratio > 1.01x (height stays telemetry only).
            const _sbOneHourVolumeRatio =
              _sbArmed.status === "qualified" &&
              "oneHourVolume" in _sbArmed.decision
                ? (_sbArmed.decision.oneHourVolume?.ratio ?? null)
                : null;
            const _sbVolRatioBlocked = !stealth1hVolumeRatioPasses(
              _sbOneHourVolumeRatio,
            );
            const _sbOi4hAtBreakout =
              _sbPreVolumeFire &&
              _sbVolumeGate?.pass === true &&
              !_sbFilterBlocked &&
              !_sbVolRatioBlocked &&
              _sbArmed.status === "qualified"
                ? await getStealthOi4hAtBreakout(
                    symbol,
                    "firstCrossAt" in _sbArmed.decision &&
                      typeof _sbArmed.decision.firstCrossAt === "number"
                      ? _sbArmed.decision.firstCrossAt
                      : (_sbTriggerAt ?? 0) + 60 * 60 * 1000,
                  )
                : null;
            const _sbOiBlocked = !stealthOi4hPasses(_sbOi4hAtBreakout);
            const isStealthBreakout =
              STEALTH_LEGACY_DETECTION_LIVE &&
              _sbPreVolumeFire &&
              (_sbVolumeGate?.pass ?? false) &&
              !_sbFilterBlocked &&
              !_sbOiBlocked &&
              !_sbVolRatioBlocked &&
              // Owner decision 2026-10-13: a fresh-replay range mismatch no
              // longer blocks (it blocked BATON +35% and AIOT +15%); the recheck
              // result is recorded with the decision metrics instead.
              !_sbPriceBelowFrozenLevel;
            // Owner 2026-10-17 (AGT): SRv2 level check is observation-only.
            isStealthTechnicalFire =
              isStealthTechnicalFire || isStealthBreakout;
            const _sbDecisionMetrics =
              _sbArmed.status === "qualified" &&
              _sbArmed.decision.status === "qualified"
                ? (() => {
                    const confirmationTimes =
                      _sbArmed.decision.refinement.confirmationCandleTimes;
                    const confirmationAt =
                      _sbArmed.decision.refinement.confirmationAt;
                    const entryCandleTime =
                      confirmationTimes[confirmationTimes.length - 1] ?? null;
                    const entryCandle =
                      entryCandleTime === null
                        ? null
                        : (_sbThirtyMinuteCandles.find(
                            (candle) => candle.time === entryCandleTime,
                          ) ?? null);
                    const _sbWidthDiag = _sbVolumeGate?.diagnostics
                      ?.find((d) => d.startsWith("range_width_pct:"))
                      ?.split(":")[1];
                    const _sbScore = calcStealthScore({
                      confirmDistPct:
                        _sbArmed.decision.refinement.distanceFromLevelPct,
                      oneHourVolumeRatio:
                        "oneHourVolume" in _sbArmed.decision
                          ? (_sbArmed.decision.oneHourVolume?.ratio ?? null)
                          : null,
                      rangeWidthPct:
                        _sbWidthDiag !== undefined
                          ? Number(_sbWidthDiag)
                          : null,
                      gateBodyPct: _sbVolumeGate?.bodyPct ?? null,
                      futVolMult: _sbVolumeGate?.futuresRatio ?? null,
                      spotVolMult: _sbVolumeGate?.spotRatio ?? null,
                      p24h: price24hChange,
                      oi4h: _peStealthBrk?.lastOi4h ?? null,
                      cvd4h:
                        _sbCvd4h === null || _sbCvd4h === undefined
                          ? null
                          : _sbCvd4h
                            ? 1
                            : 0,
                    });
                    return {
                      stealthScore: _sbScore,
                      stealthOi4hAtBreakout: _sbOi4hAtBreakout,
                      stealthOneHourVolumeRatio: _sbOneHourVolumeRatio,
                      stealthRangeHeightPct: _sbRangeHeightPct,
                      stealthVolumeGate: _sbVolumeGate,
                      stealthRangeRecheck: _sbRangeRecheck
                        ? _sbRangeRecheck.ok
                          ? { ok: true }
                          : {
                              ok: false,
                              reason: _sbRangeRecheck.reason,
                              detail: _sbRangeRecheck.detail,
                            }
                        : null,
                      stealthWindowShadow: {
                        version: "stealth-30m-hold-v1",
                        frozenLevel: _sbArmed.arm.breakoutLevel,
                        firstCrossAt: _sbArmed.decision.firstCrossAt,
                        confirmationAt,
                        hypotheticalEntryAt: confirmationAt,
                        confirmationCandleTimes: confirmationTimes,
                        hypotheticalEntryPrice: entryCandle?.close ?? null,
                        stopCandidatesPct: [6, 8, 10],
                        sameCandlePolicy: "stop_first",
                        evaluationSource: "pattern_backfill_candles_15m",
                      },
                    };
                  })()
                : undefined;

            // ── PRICE LED MOMENTUM (Архетип C): spot-led momentum ─────────────────────
            // Цена уже движется вверх, а spot-flow и CVD подтверждают импульс.
            // OI и Whale Index сохраняются в entry-метриках, но не являются gate.
            // Полностью игнорирует уровень prescanCycles (накопления нет — цена уже бежит).
            //
            // Gates:
            //   price24hChange ∈ [5, 15]%   — значимое движение, не перегрет
            //   price3h ∈ [1.5, 4.0]%         — рост активен, но не перегрет
            //   spot volume >= 1.1x           — decision-time spot participation
            //   SNF1h > 0 OR SNF4h > 0       — спот-приток положительный
            //   ≥2 из [CVD15m, CVD30m, CVD1h, CVD4h] = true — CVD-подтверждение

            // ── Байпас для cg_timeout/cg_building записей в очереди подтверждения ──────
            // Эти символы пропустили OI-фильтр (CG timeout или OI ниже порога), но уже
            // добавлены в confirming-очередь. Позволяем им дойти до confirming-блока (строка ~1426).
            // Обёрнут в try-catch: DB timeout здесь ранее убивал весь скан символа
            // (Error scanning symbol). При ошибке — fallback false, скан продолжается.
            // cgFallbackConfirming: используем pre-loop кэш (один SELECT до loop вместо per-symbol)
            const isCgFallbackConfirming = cgFallbackConfirmingSet.has(symbol);

            // ── pdb-инструментация для активных inline паттернов (pre-check level) ──
            // Позволяет видеть в pattern_debug/history: сколько раз токен дошёл до
            // pre-check и почему не прошёл. _pdbPass ставится в точке реального срабатывания.
            // _symRej пишет per-symbol reject reason для scan_reject_log (аудит "почему не поймали X").
            {
              // Используем prescanTracker.get() напрямую вместо _pe1 — _pe1 объявлен ниже по коду (TDZ).
              const _prcCycles = prescanTracker.get(symbol)?.cycleCount ?? 0;
              _pdbCheck("neon_support_bounce");
              if (_neonSupportBounceEvent !== null) {
                _pdbPass("neon_support_bounce");
              } else {
                _pdbReject("neon_support_bounce", "qualified_event_missing");
              }

              // stealth_breakout — quiet zone → fresh technical breakout (Архетип E)
              _pdbCheck("stealth_breakout");
              if (isStealthBreakout) {
                _pdbPass("stealth_breakout");
                if (_sbArmed.status === "qualified") {
                  void dbWriteBestEffort("stealth/verdict", () =>
                    recordStealthVerdict({
                      armId: _sbArmed.armId,
                      symbol,
                      levelSource: _sbArmed.arm.levelSource,
                      verdict: "fire_candidate",
                      reason: "all_gates_passed",
                      details: {
                        triggerTime: _sbTriggerAt,
                        level: _sbArmed.arm.breakoutLevel,
                        livePrice: _sbLivePrice,
                        quality: _sbQuality,
                      },
                    }),
                  );
                }
              } else if (_sbVolumeGate && !_sbVolumeGate.pass) {
                // Arm stays qualified; volume may arrive on a later cycle.
                const _sbRejectCode =
                  _sbVolumeGate.reason === "stealth_spot_volume_unavailable"
                    ? "stealth_spot_volume_unavailable"
                    : "breakout_candle_not_impulse";
                // Record the actual measured ratios first (dedup keeps this row).
                {
                  const ctx = _pdbCtx.value;
                  const same =
                    ctx !== null && ctx.symbol === symbol ? ctx : null;
                  _symRej(
                    symbol,
                    "stealth_breakout",
                    _sbRejectCode,
                    same?.oi30m ?? null,
                    same?.volMult ?? null,
                    same?.price24h ?? null,
                    same?.prescanCycles ?? null,
                    "rejected",
                    {
                      stealthVolumeGate: {
                        futuresRatio: _sbVolumeGate.futuresRatio,
                        spotRatio: _sbVolumeGate.spotRatio,
                        bodyPct: _sbVolumeGate.bodyPct,
                        gateReason: _sbVolumeGate.reason,
                        source: _sbVolumeGate.source,
                        diagnostics: _sbVolumeGate.diagnostics ?? null,
                        triggerTime: _sbVolumeGate.triggerTime,
                        // After applyStealthLiveVolumeRule these are the
                        // futures/spot VOLUME-RATIO thresholds (not body/width).
                        minFuturesVolumeRatio: _sbVolumeGate.futuresThreshold,
                        minSpotVolumeRatio: _sbVolumeGate.spotThreshold,
                      },
                    },
                    same?.entryPrice ?? null,
                  );
                }
                if (_sbArmed.status === "qualified") {
                  void dbWriteBestEffort("stealth/last-blocker", () =>
                    recordStealthQualifiedBlocker(
                      _sbArmed.armId,
                      `${_sbRejectCode}:${_sbVolumeGate.reason}`,
                    ),
                  );
                  void dbWriteBestEffort("stealth/verdict", () =>
                    recordStealthVerdict({
                      armId: _sbArmed.armId,
                      symbol,
                      levelSource: _sbArmed.arm.levelSource,
                      verdict: "rejected",
                      reason: `${_sbRejectCode}:${_sbVolumeGate.reason}`,
                      details: {
                        triggerTime: _sbVolumeGate.triggerTime,
                        bodyPct: _sbVolumeGate.bodyPct,
                        futuresRatio: _sbVolumeGate.futuresRatio,
                        spotRatio: _sbVolumeGate.spotRatio,
                        source: _sbVolumeGate.source,
                        missing: _sbVolumeGate.diagnostics ?? null,
                      },
                    }),
                  );
                }
                _pdbReject("stealth_breakout", _sbRejectCode);
              } else if (_sbArmed.status === "qualified") {
                // Persist the exact blocker; a generic "paused" hid why a
                // qualified breakout was not delivered.
                const _sbPausedReason = _sbBreakoutStale
                  ? STALE_FIRE_WINDOW_REASON
                  : !_sbPreVolumeFire
                    ? "qualified_fire_gate_closed"
                    : _sbFilterBlocked
                      ? "filter_dist_body"
                      : _sbVolRatioBlocked
                        ? _sbOneHourVolumeRatio === null
                          ? "volume_ratio_unavailable"
                          : "volume_ratio_below_1_01"
                        : _sbOiBlocked
                          ? _sbOi4hAtBreakout === null
                            ? "oi4h_unavailable"
                            : "oi4h_below_4_6"
                          : _sbPriceBelowFrozenLevel
                            ? "breakout_rejected_below_level"
                            : _sbRangeRecheck && !_sbRangeRecheck.ok
                              ? `qualified_range_recheck_blocked:${_sbRangeRecheck.reason}`
                              : "armed_qualified_paused";
                {
                  const ctx = _pdbCtx.value;
                  const same =
                    ctx !== null && ctx.symbol === symbol ? ctx : null;
                  _symRej(
                    symbol,
                    "stealth_breakout",
                    _sbPausedReason,
                    same?.oi30m ?? null,
                    same?.volMult ?? null,
                    same?.price24h ?? null,
                    same?.prescanCycles ?? null,
                    "rejected",
                    {
                      stealthQualifiedBlock: {
                        reason: _sbPausedReason,
                        preVolumeFire: _sbPreVolumeFire,
                        recheck: _sbRangeRecheck
                          ? _sbRangeRecheck.ok
                            ? { ok: true }
                            : {
                                ok: false,
                                reason: _sbRangeRecheck.reason,
                                detail: _sbRangeRecheck.detail,
                              }
                          : null,
                      },
                    },
                    same?.entryPrice ?? null,
                  );
                }
                _pdbReject("stealth_breakout", _sbPausedReason);
                await dbWriteBestEffort("stealth/last-blocker", () =>
                  recordStealthQualifiedBlocker(
                    _sbArmed.armId,
                    _sbPausedReason,
                  ),
                );
                // Owner order 2026-10-15: live price back below the frozen level
                // only holds the entry this cycle. The breakout already closed
                // above the level, so the arm stays qualified (until its retry
                // window ends) and can still fire when price returns above it.
                void dbWriteBestEffort("stealth/verdict", () =>
                  recordStealthVerdict({
                    armId: _sbArmed.armId,
                    symbol,
                    levelSource: _sbArmed.arm.levelSource,
                    verdict: "held",
                    reason: _sbPausedReason,
                    details: {
                      triggerTime: _sbTriggerAt,
                      level: _sbArmed.arm.breakoutLevel,
                      livePrice: _sbLivePrice,
                      quality: _sbQuality,
                      preVolumeFire: _sbPreVolumeFire,
                    },
                  }),
                );
                if (_sbBreakoutStale || _sbFilterBlocked) {
                  const _sbCutReason = _sbFilterBlocked
                    ? "filter_dist_body"
                    : "stale_fire_window";
                  await dbWriteBestEffort("stealth/cutoff-shadow", () =>
                    recordStealthCutoff({
                      armId: _sbArmed.armId,
                      symbol,
                      levelSource: _sbArmed.arm.levelSource,
                      reason: _sbCutReason,
                      triggerTime: _sbTriggerAt,
                      level: _sbArmed.arm.breakoutLevel,
                      details: {
                        distPct: _sbQuality?.distPct ?? null,
                        bodyAtr: _sbQuality?.bodyAtr ?? null,
                      },
                    }),
                  );
                  await consumeStealthArmLogged(
                    _sbArmed.armId,
                    _sbFilterBlocked
                      ? "qualified_filter_dist_body"
                      : STALE_FIRE_WINDOW_REASON,
                    symbol,
                  );
                } else if (
                  !_sbPriceBelowFrozenLevel &&
                  // Owner 2026-10-23: unavailable OI/volume keeps the arm
                  // qualified and is re-checked next cycle.
                  !(_sbVolRatioBlocked && _sbOneHourVolumeRatio === null) &&
                  !(
                    !_sbVolRatioBlocked &&
                    _sbOiBlocked &&
                    _sbOi4hAtBreakout === null
                  )
                ) {
                  await consumeStealthArmLogged(
                    _sbArmed.armId,
                    "qualified_live_fire_paused",
                    symbol,
                  );
                }
              } else if (_sbArmed.status === "armed") {
                // The reason is the arm's real waiting state, tagged with the
                // level source so 1H and 4H arms are never confused in the log.
                const _sbWaitSource =
                  "arm" in _sbArmed ? _sbArmed.arm.levelSource : "unknown";
                _pdbReject(
                  "stealth_breakout",
                  `armed_${_sbArmed.waitingReason}:${_sbWaitSource}`,
                );
              } else if (_sbArmed.status === "in_flight") {
                _pdbReject("stealth_breakout", "armed_fire_in_flight");
              } else if (_sbArmed.status === "invalidated") {
                _pdbReject(
                  "stealth_breakout",
                  `armed_invalidated_${_sbArmed.decision.reason}`,
                );
              } else if (_sbArmed.status === "expired") {
                _pdbReject("stealth_breakout", "armed_expired");
              } else if (_sbArmed.status === "terminal_structure") {
                _pdbReject("stealth_breakout", "armed_structure_consumed");
              } else if (_sbArmed.status === "not_armed") {
                const reason =
                  AUTO_RANGE_1H_LIVE_ENABLED &&
                  _sbAutoRangeOneHourIdentity !== null &&
                  _sbRangeOneHourArmed.status === "not_armed"
                    ? `range_1h_${_sbRangeOneHourArmed.reason}`
                    : _sbAutoRangeOneHourCandles.length <
                        AUTO_RANGE_MIN_CLOSED_CANDLES
                      ? `range_1h_insufficient_history_${autoRangeHistoryQueue.describeHistoryState(autoRangeCacheKey(symbol, "1h"))}`
                      : !_sbAutoRangeOneHourFresh
                        ? "range_1h_candles_not_fresh"
                        : _sbAutoRangeOneHourResult.status === "unknown"
                          ? "range_1h_replay_unknown"
                          : _sbAutoRangeOneHourIdentity === null
                            ? "range_1h_no_confirmed_range"
                            : `range_1h_${_sbArmed.reason}`;
                _pdbReject("stealth_breakout", reason);
                _symRej(
                  symbol,
                  "stealth_breakout",
                  reason,
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              } else if (_sbStructure.status === "insufficient_data") {
                _pdbReject(
                  "stealth_breakout",
                  "structure_4h_insufficient_data",
                );
                _symRej(
                  symbol,
                  "stealth_breakout",
                  "structure_4h_insufficient_data",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              } else if (!_sbStructure.quietZone) {
                _pdbReject("stealth_breakout", "structure_4h_no_quiet_zone");
                _symRej(
                  symbol,
                  "stealth_breakout",
                  "structure_4h_no_quiet_zone",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              } else if (_sbOneHour.status !== "fresh_breakout") {
                _pdbReject(
                  "stealth_breakout",
                  `breakout_4h_${_sbArmed.status === "qualified" ? "qualified" : _sbOneHour.status}`,
                );
                _symRej(
                  symbol,
                  "stealth_breakout",
                  `breakout_4h_${_sbArmed.status === "qualified" ? "qualified" : _sbOneHour.status}`,
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              } else if (_sbThirtyMinute.status !== "near_level") {
                _pdbReject(
                  "stealth_breakout",
                  `refinement_30m_${_sbThirtyMinute.status}`,
                );
                _symRej(
                  symbol,
                  "stealth_breakout",
                  `refinement_30m_${_sbThirtyMinute.status}`,
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              } else {
                _pdbReject("stealth_breakout", "technical_gate_unmet");
                _symRej(
                  symbol,
                  "stealth_breakout",
                  "technical_gate_unmet",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _prcCycles,
                );
              }
            }

            if (
              !anyOiPass &&
              !tSteady &&
              !isCgFallbackConfirming &&
              !isStealthBreakout &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !_neonSupportBounceEvent &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "oi_watch_fallback",
              )
            ) {
              // ── FALLBACK: токены с недоступным или строящимся OI → OI Watch ─────────
              // Теперь доступен ВСЕМ токенам в батче (не только topByActivity).
              // A) CG timeout — только Layer 1 (activeSymbols): был весь батч → слишком шумно.
              // B) CG Building (OI строится, но ниже порога) — любой токен, cycleCount ≥ 2.
              // C) Dark Flow (устойчивый объём без OI следа) — любой токен, cycleCount ≥ 3 + vol ≥ 2x.
              {
                const dfEntry = prescanTracker.get(symbol);
                const dfCycles = dfEntry?.cycleCount ?? 0;

                // cgTimeout: только топ-активные (Layer 1) — иначе flood мусорными токенами
                if (!cgOI?.available && activeSymbols.has(symbol))
                  state.cgTimeoutsLastScan++;
                const cgTimeoutFallback =
                  !cgOI?.available &&
                  activeSymbols.has(symbol) && // ограничение остаётся — только Layer 1
                  spotVolMult !== null &&
                  spotVolMult >= 1.3 &&
                  (spotVolMult === null || spotVolMult < 2.5) &&
                  priceChange > -5 &&
                  priceChange < 25 &&
                  dfCycles >= 3;

                const buildingTfCount = cgOI?.available
                  ? [oi30m, oi1h].filter((v) => v !== null && v >= 2.0).length
                  : 0;
                // cgBuilding: расширено — любой токен в батче с cycleCount ≥ 2
                const cgBuildingFallback =
                  cgOI?.available &&
                  buildingTfCount >= 2 &&
                  !anyOiPass &&
                  spotVolMult !== null &&
                  spotVolMult >= 1.5 &&
                  dfCycles >= 2;

                // ── DARK FLOW: устойчивая аномальная активность без следа в OI ──────────
                // Расширено: ранее только activeSymbols (Layer 1), теперь весь батч.
                // CoinGlass ЕСТЬ данные, но OI не растёт ни на одном ТФ.
                // Монета 3+ сканов в пре-скрине с объёмом ≥ 2x — устойчивая аномалия.
                const darkFlowTrigger =
                  cgOI?.available && // CG есть — не timeout
                  !cgBuildingFallback && // OI даже слабо не строится
                  !anyOiPass && // OI не прошёл ни один порог
                  dfCycles >= 3 && // 3+ сканов в пресканере
                  volMult >= DARK_FLOW_MIN_VOLMULT && // объём подтверждён
                  Math.abs(priceChange) < 25 && // цена в разумном диапазоне
                  price24hChange < 40; // унифицированный потолок перегрева

                if (
                  cgTimeoutFallback ||
                  cgBuildingFallback ||
                  darkFlowTrigger
                ) {
                  // Не дублируем если символ уже в очереди (watching или confirming)
                  // alreadyQueued: используем pre-loop кэш oiWatchActiveSet
                  if (!oiWatchActiveSet.has(symbol)) {
                    const watchTf = cgTimeoutFallback
                      ? "cg_timeout"
                      : cgBuildingFallback
                        ? "cg_building"
                        : "dark_flow";
                    const watchOi = oi30m ?? oi1h ?? 0;
                    try {
                      await dbWriteStrict(
                        "oiWatch/darkFlow-insert",
                        async () => {
                          const _freshPrice = await getFreshPrice(
                            symbol,
                            close,
                          );
                          return db.insert(oiWatchTable).values({
                            symbol,
                            triggerTf: watchTf,
                            oiChange: watchOi,
                            priceAtEntry: _freshPrice,
                            volumeMultiplier: spotVolMult ?? volMult, // 1.6: спот если есть, иначе фьюч
                            sentimentKey: null,
                            status: "confirming",
                            addedAt: new Date(),
                            // Расширенные окна: dark_flow 6ч, cg_timeout/cg_building 12ч
                            expiresAt: new Date(
                              Date.now() +
                                (watchTf === "dark_flow" ? 6 : 12) *
                                  60 *
                                  60 *
                                  1000,
                            ),
                            avgVolume: avgVol,
                            isVolConfirmed: false,
                            oi30mChange: oi30m,
                            oi1hChange: oi1h,
                            oi24hChange: oi24h ?? null,
                            price1hChange: price1hChange ?? null,
                            price24hChange: price24hChange,
                            volStatusReason: cgVolStatusReason(spotCvd),
                            entryVolMult: volMult,
                            entryCgTurnover:
                              cgOI?.cgVolUsd != null &&
                              cgOI?.oiUsd != null &&
                              cgOI.oiUsd > 0
                                ? cgOI.cgVolUsd / cgOI.oiUsd
                                : null,
                          });
                        },
                      );
                      logger.info(
                        {
                          symbol,
                          reason: watchTf,
                          vol: volMult.toFixed(1) + "x",
                          price: priceChange.toFixed(1) + "%",
                          buildingTfs: buildingTfCount,
                          dfCycles,
                          inLayer1: activeSymbols.has(symbol),
                        },
                        watchTf === "dark_flow"
                          ? "🌑 DARK FLOW: устойчивая активность без OI — добавлен в OI Watch (6ч)"
                          : "👁 ACTIVITY WATCH: кандидат добавлен в OI Watch",
                      );
                      state.oiWatchLastInsertAt = new Date();
                      state.oiWatchInsertsLastScan++;
                      oiWatchActiveSet.add(symbol); // обновляем кэш чтобы не дублировать в этом цикле
                    } catch (err) {
                      state.oiWatchInsertErrors++;
                      state.oiWatchLastInsertError =
                        err instanceof Error ? err.message : String(err);
                      logger.warn(
                        { err, symbol },
                        "dark_flow/activity_watch OI Watch insert failed",
                      );
                    }
                  }
                }
              }

              logger.debug(
                {
                  symbol,
                  vol: volMult.toFixed(2) + "x",
                  vol4h: volMult4h.toFixed(2) + "x",
                  price: priceChange.toFixed(2) + "%",
                  price4h: price4hChange.toFixed(1) + "%",
                  oi30m: oi30m?.toFixed(2) ?? "n/a",
                  oi1h: oi1h?.toFixed(2) ?? "n/a",
                },
                "SKIP: недостаточно объёма или движения цены (vol < 1.0x или price < 2.5%)",
              );
              skipCount.noOiNoVol++;
              break symbolBlock;
            }

            // Какой ТФ сработал (OI path)
            let oiTriggerTf: string;
            let cgOIChange: number;

            if (tSteady) {
              // Steady Accumulation — 5m + 30m одновременно, цена flat
              oiTriggerTf = "steady";
              cgOIChange = oi30m!; // берём 30m как основное значение для скоринга
              logger.info(
                {
                  symbol,
                  oi30m: oi30m!.toFixed(1) + "%",
                  price: priceChange.toFixed(1) + "%",
                },
                "🔍 STEADY ACCUM: Multi-TF OI convergence + flat price",
              );
            } else {
              // Стандартный CoinGlass OI путь
              const triggeredTfs = [
                t30 && "30m",
                t1h && "1h",
                t4h && "4h",
                t24h && "24h",
              ].filter(Boolean) as string[];
              oiTriggerTf = triggeredTfs.join("+");

              const cand30m = t30 ? Math.abs(oi30m!) : 0;
              const cand1h = t1h ? Math.abs(oi1h!) : 0;
              const cand4h = t4h ? Math.abs(oi4h!) : 0;
              const cand24h = t24h ? Math.abs(oi24h!) : 0;
              const bestAbs = Math.max(cand30m, cand1h, cand4h, cand24h);
              cgOIChange =
                bestAbs === cand30m && t30
                  ? oi30m!
                  : bestAbs === cand1h && t1h
                    ? oi1h!
                    : bestAbs === cand4h && t4h
                      ? oi4h!
                      : (oi24h ?? 0); // fallback может быть null (спот-паттерны / L11 инжект без OI) → toFixed крашил скан символа
            }

            // ── STEP 2: LIQUIDITY FILTER — Global Vol24h / OI USD > 0.1 (не «мёртвые» монеты) ──
            const oiUsd = cgOI?.oiUsd;
            const cgVolUsd = cgOI?.cgVolUsd;
            const vol24hUSD = aggregatedVolume24hUsd(symbol);

            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "liquidity_turnover",
              ) &&
              oiUsd &&
              oiUsd > 0 &&
              cgVolUsd &&
              cgVolUsd > 0
            ) {
              const turnoverRatio = cgVolUsd / oiUsd;
              if (turnoverRatio < 0.15) {
                logger.debug(
                  {
                    symbol,
                    turnoverRatio: turnoverRatio.toFixed(3),
                    cgVol: cgVolUsd,
                    oiUsd,
                  },
                  "SKIP: low global turnover ratio (cgVol/OI < 0.15)",
                );
                _otherSkipReason.set(
                  symbol,
                  `low_turnover_to_oi_${turnoverRatio.toFixed(3)}_lt_0.15`,
                );
                skipCount.other++;
                break symbolBlock;
              }
            }

            // ── Ликвидность: относительные фильтры покрывают без абсолютных порогов ───
            // Все фильтры ниже — относительные (volMult, OI%, turnoverRatio, спред).
            // Абсолютных долларовых порогов нет: $15M для BTC — песчинка,
            // $15M для микрокапа — всё что есть. Мёртвые монеты отсеиваются спредом
            // (≥0.5% → пропустить) и volMult (2.5x своей базы).

            // ── FILTER: Exit pump — объём в 4x+ раз больше OI = поздний сброс, не органика ──
            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "exit_pump",
              ) &&
              oiUsd &&
              oiUsd > 0 &&
              cgVolUsd &&
              cgVolUsd > 0
            ) {
              const volToOi = cgVolUsd / oiUsd;
              if (volToOi > 4.0) {
                logger.debug(
                  { symbol, volToOi: volToOi.toFixed(2) },
                  "SKIP: exit pump — объём >> OI (4x+)",
                );
                skipCount.stalePump++;
                gateRejectLog.push({
                  sym: symbol,
                  gate: "stalePump",
                  oi30m: oi30m?.toFixed(2) ?? "n/a",
                  vol: volMult.toFixed(2) + "x",
                  price: priceChange.toFixed(2) + "%",
                  extra: `volToOi=${volToOi.toFixed(1)}x`,
                });
                _symRej(
                  symbol,
                  "gate",
                  "stalePump",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  prescanTracker.get(symbol)?.cycleCount ?? null,
                );
                break symbolBlock;
              }
            }

            // Debug tracking (для лог-сводки по итогам цикла)
            debugTop.push({
              symbol,
              vol: volMult,
              cgOI: cgOIChange || null,
              price: priceChange,
            });

            // ── FILTER: Spread — узкий спред (< 0.5%) если BingX возвращает bid/ask ────
            const bid = parseFloat(ticker.bidPrice ?? "0") || 0;
            const ask = parseFloat(ticker.askPrice ?? "0") || 0;
            if (!_isQueuedNeonSupportBounce && bid > 0 && ask > 0) {
              const spreadPct = ((ask - bid) / ask) * 100;
              if (spreadPct >= 0.5) {
                logger.debug(
                  { symbol, spread: spreadPct.toFixed(3) },
                  "SKIP: spread >= 0.5%",
                );
                _otherSkipReason.set(
                  symbol,
                  `spread_${spreadPct.toFixed(2)}pct_ge_0.5`,
                );
                skipCount.other++;
                break symbolBlock;
              }
            }

            // ── STEP 3: VOLUME FILTER — подтверждение интереса ──────────────────────────
            // Логика порогов объёма:
            //
            // A) "High OI Quiet" — OI ≥ 20% (24h) или ≥ 12% (4h) И цена ≤ 1.5% flat.
            //    Крупный игрок набирает позицию тихо в течение часов/суток.
            //    Порог: 1.8x — минимальное подтверждение объёмом (было 1.0x — слишком много шума).
            //
            // B) "Steady Accum" — 5m+30m одновременно + flat price (мульти-ТФ паттерн).
            //    Порог: 1.8x
            //
            // C) Стандартный путь (импульс, пробой, шорт-сквиз): единый порог 1.0x
            const isHighOiQuiet =
              (t24h && Math.abs(oi24h!) >= 10) ||
              (t4h && Math.abs(oi4h!) >= 12); // 20→10: согласовано с OI_THRESH_24H

            // Экстремальный вариант: OI 4h >= 20% или 24h >= 15% + цена плоская.
            // Китовое накопление — объёмный спайк по определению НЕ придёт в фазе накопления.
            // Снижаем порог до 0.9x — достаточно нормального торгового объёма.
            const isExtremeOiQuiet =
              isHighOiQuiet &&
              ((t4h && Math.abs(oi4h!) >= 20) ||
                (t24h && Math.abs(oi24h!) >= 15)); // 20→15: сильный 24h сигнал, не обязательно экстремальный

            // "Медленное бычье накопление" — цена тихо ползёт вверх (1–8%) при наличии OI.
            // NEAR, GRASS, BLEND/LYN-тип: OI копится несколько часов, объём умеренный (1–2x).
            // Стандартный порог 2.5x их режет. Снижаем до 1.5x при bullish slow accum.
            // Условие: цена 1–8% (есть движение, но не взрыв) + хотя бы один OI ТФ сработал.
            const isBullishSlowAccum = t30 || t1h || t4h || t24h;

            // Порог объёма:
            // - extreme OI quiet (накопление китов): 0.9x
            // - bullish slow accum (медленный бычий): 1.5x
            // - стандарт: 2.5x
            // Победители с НИЗКИМ объёмом: M-USDT(0.80x, +22.1%), PLAYSOUT(1.76x, +21.9%), BNLIFE(0.99x, +3.3%).
            // isOiAccel: OI ускоряется от цикла к циклу — снижаем порог объёма с 2.5 до 1.8x.
            // Позволяет токенам типа ROSE (медленное OI накопление) проходить в deep scan раньше.
            const peAccel = prescanTracker.get(symbol);
            const isOiAccel =
              (peAccel?.oiAccel30m ?? 0) >= 1.8 &&
              (peAccel?.lastOi30m ?? 0) >= 0.3;
            const volThreshold = isExtremeOiQuiet
              ? 0.9
              : isBullishSlowAccum
                ? 1.5
                : isOiAccel
                  ? 1.8
                  : 2.5;

            // Spot vol для gate'а (mcapPct — для логов/будущих фильтров, в условие не входит).
            const _svmMcapUsd = getSpotPoolEntry(symbol)?.mcapUsd ?? null;
            const _spotMcapPct =
              spotVolMult !== null && _peSvm?.lastSpotVol1h && _svmMcapUsd
                ? (_peSvm.lastSpotVol1h / _svmMcapUsd) * 100
                : null;

            // isCgFallbackConfirming: у символа уже есть запись в confirming-очереди
            // с trigger_tf="cg_building"/"cg_timeout" — даём ей дойти до confirming-блока
            // даже при объёме < 2.5x (без этого bypass символ уходит в OI Watch path
            // и никогда не достигает строки ~1684 с проверкой confirming-записи).
            // Архетипные паттерны имеют собственные низкие порогу объёма (≥0.5x / ≥0.8x / нет требования).
            // Они никогда не дойдут до рядков 4918+ если их не вывести из этого блока.
            const _isArchetypeBypass =
              isStealthBreakout ||
              isStealthTechnicalFire ||
              _isQueuedNeonSupportBounce ||
              isPriceLedMomentum ||
              shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "volume_filter",
              );
            if (
              (spotVolMult === null || spotVolMult < volThreshold) &&
              !isCgFallbackConfirming &&
              !_isArchetypeBypass &&
              !_isQueuedNeonSupportBounce
            ) {
              // ── OI WATCH: OI сработал, но объём ещё не подтянулся ────────────────────
              // Вместо того чтобы просто пропустить, ставим монету на наблюдение.
              // Критерии добавления в watch:
              //   1. OI уверенно сработал (хоть один ТФ)
              //   2. Объём пока ниже порога (иначе бы уже дали сигнал)
              //   3. Цена ещё не улетела (< 25% на текущей свече) — зарождение, не поздний вход
              //   4. Не новый листинг (у них своя логика Short Sniper)
              // t24h включён: монеты с устойчивым 24h накоплением (RECALL-тип) тоже попадают в OI Watch
              const oiTriggeredStrongly =
                cgOI?.available && (t30 || t1h || t24h);
              const priceNotYetExploded = Math.abs(priceChange) < 25;
              if (oiTriggeredStrongly && priceNotYetExploded && avgVol > 0) {
                try {
                  // Изменение 2: если ВСЕ доступные TF OI положительные — используем
                  // пониженный порог объёма в OI Watch (кодируем в triggerTf как "all+{tf}")
                  const availableOis = [oi30m, oi1h, oi4h, oi24h].filter(
                    (v) => v !== null,
                  ) as number[];
                  const allAvailablePositive =
                    availableOis.length >= 2 &&
                    availableOis.every((v) => v > 0);
                  const baseTf = t30 ? "30m" : "1h";
                  const triggerTf = allAvailablePositive
                    ? `all+${baseTf}`
                    : baseTf;
                  const triggerOi = t30 ? oi30m! : oi1h!;
                  const expiresAt = new Date(Date.now() + 6 * 3600 * 1000); // +6ч: единое окно OI Watch

                  // Upsert: обновляем активные watching ИЛИ confirming записи, иначе вставляем новую.
                  // Без проверки confirming: cg_timeout/cg_building могли уже создать confirming-запись,
                  // и мы бы вставляли duplicate watching поверх неё (EIGEN-баг).
                  const existing = await db
                    .select({
                      id: oiWatchTable.id,
                      status: oiWatchTable.status,
                    })
                    .from(oiWatchTable)
                    .where(
                      and(
                        eq(oiWatchTable.symbol, symbol),
                        inArray(oiWatchTable.status, [
                          "watching",
                          "confirming",
                        ]),
                      ),
                    )
                    .limit(1);

                  if (existing.length > 0) {
                    // Обновляем OI значение (накапливается)
                    // dbWriteStrict: критичный апдейт состояния PATH B — не должен теряться молча
                    await dbWriteStrict("oiWatch/pathB-update", () =>
                      db
                        .update(oiWatchTable)
                        .set({
                          oiChange: triggerOi,
                          volumeMultiplier: spotVolMult ?? volMult,
                          expiresAt,
                          volStatusReason: cgVolStatusReason(spotCvd),
                        }) // 1.6
                        .where(eq(oiWatchTable.id, existing[0].id)),
                    );
                  } else if (existing.length === 0) {
                    await dbWriteStrict("oiWatch/pathB-insert", async () => {
                      const _freshPrice = await getFreshPrice(symbol, close);
                      return db.insert(oiWatchTable).values({
                        symbol,
                        triggerTf,
                        oiChange: triggerOi,
                        priceAtEntry: _freshPrice,
                        volumeMultiplier: spotVolMult ?? volMult, // 1.6
                        sentimentKey: null,
                        status: "watching",
                        addedAt: new Date(),
                        expiresAt,
                        avgVolume: avgVol,
                        oi30mChange: oi30m,
                        oi1hChange: oi1h,
                        oi24hChange: oi24h ?? null,
                        price1hChange: price1hChange ?? null,
                        price24hChange: price24hChange,
                        volStatusReason: cgVolStatusReason(spotCvd),
                        entryVolMult: volMult,
                        entryCgTurnover:
                          cgOI?.cgVolUsd != null &&
                          cgOI?.oiUsd != null &&
                          cgOI.oiUsd > 0
                            ? cgOI.cgVolUsd / cgOI.oiUsd
                            : null,
                      });
                    });
                    logger.info(
                      {
                        symbol,
                        triggerTf,
                        oiChange: triggerOi.toFixed(2) + "%",
                        vol: volMult.toFixed(2) + "x",
                        price: priceChange.toFixed(2) + "%",
                      },
                      "👁 OI WATCH: добавлен кандидат (OI есть, объём ещё не подтянулся)",
                    );
                    state.oiWatchLastInsertAt = new Date();
                    state.oiWatchInsertsLastScan++;
                  }
                } catch (err) {
                  state.oiWatchInsertErrors++;
                  state.oiWatchLastInsertError =
                    err instanceof Error ? err.message : String(err);
                  logger.warn({ err, symbol }, "OI Watch insert failed");
                  _symRej(
                    symbol,
                    "oi_watch",
                    `oi_watch_insert_failed: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)}`,
                    null,
                    null,
                    null,
                    null,
                    "blocked",
                  );
                }
              }
              logger.debug(
                {
                  symbol,
                  volMult: volMult.toFixed(2),
                  threshold: volThreshold,
                  isHighOiQuiet,
                  isSteady: tSteady,
                },
                "SKIP: volume below threshold",
              );
              skipCount.lowVolume++;
              break symbolBlock;
            }

            if (isHighOiQuiet) {
              logger.info(
                {
                  symbol,
                  oi24h: oi24h?.toFixed(1) + "%",
                  oi4h: oi4h?.toFixed(1) + "%",
                  price: priceChange.toFixed(1) + "%",
                  vol: volMult.toFixed(1) + "x",
                },
                "🏦 HIGH OI QUIET: Large OI + flat price — hidden accumulation/distribution",
              );
            }

            // ── STEP 4: ANTI-STALE FILTER ─────────────────────────────────────────────
            // Если CoinGlass batch занял 8+ минут и монета уже двинулась на >= 20%
            // за последние 2 свечи (60 мин) — это запоздалый сигнал, пропускаем.
            // (было 3 свечи / 15% — слишком агрессивно, пропускали вторые волны)
            const STALE_LOOKBACK = 2; // свечи назад (2 × 30m = 60 мин)
            const STALE_THRESHOLD = 45; // % порог "уже поздно" (увеличено для ракет типа SUP/OWL)
            const staleRefIdx = klines.length - 1 - STALE_LOOKBACK;
            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              staleRefIdx >= 0
            ) {
              const staleRefClose = parseFloat(klines[staleRefIdx].close) || 0;
              if (staleRefClose > 0) {
                const staleMove = Math.abs(
                  ((close - staleRefClose) / staleRefClose) * 100,
                );
                if (staleMove >= STALE_THRESHOLD) {
                  logger.info(
                    {
                      symbol,
                      staleMove: staleMove.toFixed(1) + "%",
                      lookbackCandles: STALE_LOOKBACK,
                    },
                    "SKIP: stale signal — price already moved too much in last 3 candles",
                  );
                  skipCount.priceTooHigh++;
                  break symbolBlock;
                }
              }
            }

            // ── PRICE GROWTH GATE: "присутствие" vs "накопление" ────────────────────────
            // Если токен 3+ циклов в пресканере и цена не выросла ≥ +0.5% от точки первого
            // появления — он не накапливается, а просто присутствует в пуле.
            // Исключения (whitelist): isHiddenAccumLikely — тихое OI-накопление с плоской ценой;
            // _likelyDipAccum: при дипе цена по определению ниже firstPrice — gate убивал бы
            // паттерн структурно до evaluatePattern. det ещё не вычислен, поэтому используем
            // те же условия что detectSentiment: OI ≥4% (снижено с 8% 2026-07-10) + price -0.5..-3% + vol ≥2x.
            const _pe1 = prescanTracker.get(symbol);
            const _likelyDipAccum =
              cgOIChange >= 4 &&
              priceChange >= -3.0 &&
              priceChange < -0.5 &&
              spotVolMult !== null &&
              spotVolMult >= 2.0;
            // Bypass: токен 10+ циклов с устойчивым OI4h ≥2% но ценой в боковике [-5%..+2%]
            // Это классическая тихая аккумуляция без подтверждения цены — не давим gate.
            const _isHighOiLongAccum =
              (_pe1?.lastOi4h ?? 0) >= 2.0 &&
              (_pe1?.cycleCount ?? 0) >= 10 &&
              priceChange >= -5.0 &&
              priceChange <= 2.0;
            {
              const _pgFirst = _pe1?.firstPrice ?? 0;
              const _pgLast = _pe1?.lastPrice ?? 0;
              if (
                (_pe1?.cycleCount ?? 0) >= 3 &&
                _pgFirst > 0 &&
                _pgLast > 0 &&
                _pgLast <= _pgFirst * 1.005 &&
                !_isQueuedNeonSupportBounce &&
                !isStealthTechnicalFire &&
                !isHiddenAccumLikely &&
                !_likelyDipAccum &&
                !_isHighOiLongAccum &&
                !shouldBypassImpulseBuyCommonGate(
                  _impulseLiveDecision,
                  "price_growth",
                )
              ) {
                const _pgMovePct =
                  ((_pgLast / _pgFirst - 1) * 100).toFixed(2) + "%";
                const _pgBlockedPattern: string | undefined = tSteady
                  ? "tSteady_pathb"
                  : undefined;
                logger.debug(
                  {
                    symbol,
                    cycleCount: _pe1!.cycleCount,
                    firstPrice: _pgFirst,
                    lastPrice: _pgLast,
                    movePct: _pgMovePct,
                  },
                  "SKIP: price-gate — цена не выросла ≥ +0.5% от firstPrice за 3+ цикла",
                );
                skipCount.priceGate++;
                break symbolBlock;
              }
            }

            // ── PATTERN EVALUATION (CoinGlass OI + Volume + Price) ────────────────────
            // PDB: оба паттерна evaluatePattern проверяются для каждого токена —
            // считаем здесь все evaluations, не только passes.
            _pdbCheck("bullish_accumulation");
            // PLM takes precedence over the generic OI-driven evaluation. At p24h=5%
            // both patterns can match; letting BA win would silently reintroduce its
            // OI/volume gates and confirmation queue for a spot-led PLM setup.
            let det = _isQueuedNeonSupportBounce
              ? null
              : !canEvaluateNonStealth ||
                  isPriceLedMomentum ||
                  _impulseLiveDecision.passes
                ? null
                : evaluatePattern(
                    cgOIChange,
                    priceChange,
                    spotVolMult !== null ? spotVolMult : volMult,
                    null,
                    settings,
                    oiTriggerTf,
                    _pe1?.prevOi30m ?? null,
                    price24hChange,
                    _pe1?.cycleCount ?? 0,
                  );
            _dropDetKey = () => det?.sentiment.key ?? null;
            // Bullish Accumulation is retired. Keep the detector and calibration
            // helpers available for legacy analysis, but never let a live scan
            // continue into confirmation or signal persistence for this key.
            if (isPreservedDecommissionedPattern(det?.sentiment.key)) {
              if (det!.sentiment.key !== "balanced_grind")
                _pdbReject(det!.sentiment.key, "pattern_decommissioned");
              det = null;
            }
            let _baOiPath: BullishAccumulationOiPath | null = null;
            // Pattern debug: предусловие выполнено (evaluatePattern вернул совпадение)
            if (det) _pdbPass(det.sentiment.key);

            // ── Canonical OI route для bullish_accumulation ─────────────────────────────
            // Четыре взаимоисключающих тезиса:
            //   fresh_oi30m: новый импульс 3.5–5%;
            //   extended_oi30m: восстановленный диапазон 5–10%;
            //   transition_oi30m: восстановленный диапазон 2.5–3.5%;
            //   slow_multitf: спокойный OI30m ≤2.5% + подтверждение OI1h/4h.
            // Route сохраняется в entry_source, чтобы не смешивать результаты.
            if (det?.sentiment.key === "bullish_accumulation") {
              const _baOiDecision = classifyBullishAccumulationOiPath({
                oi30m,
                oi1h,
                oi4h,
              });
              if (!_baOiDecision.allowed) {
                _pdbReject("bullish_accumulation", _baOiDecision.reason);
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  _baOiDecision.reason,
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  {
                    symbol,
                    cgOI30m: cgOIChange.toFixed(2) + "%",
                    oi1h: oi1h?.toFixed(2) ?? "n/a",
                    oi4h: oi4h?.toFixed(2) ?? "n/a",
                    reason: _baOiDecision.reason,
                  },
                  "SKIP bullish_accumulation: OI не соответствует live BA маршрутам",
                );
                det = null;
              } else {
                _baOiPath = _baOiDecision.path;
                logger.info(
                  {
                    symbol,
                    baOiPath: _baOiPath,
                    oi30m: oi30m?.toFixed(2) ?? "n/a",
                    oi1h: oi1h?.toFixed(2) ?? "n/a",
                    oi4h: oi4h?.toFixed(2) ?? "n/a",
                  },
                  "Bullish Accumulation OI route selected",
                );
              }
            }

            // ── Two-cycle OI gate для bullish_accumulation ───────────────────────────────
            // Разовый OI-спайк ≠ накопление. Настоящее накопление = OI растёт 2+ цикла.
            // Fail-open: prevOi30m === null (данных нет) → пропускаем, не блокируем.
            if (det?.sentiment.key === "bullish_accumulation") {
              const _baPrevOi = _pe1?.prevOi30m ?? null;
              // Ретроспектива 774 кейсов: p25 prevOI30m = -1.04%, многие реальные пампы
              // имели слегка отрицательный предыдущий цикл. Порог ослаблен 0 → -0.3
              // (отсекает явный слив OI, но пропускает боковик/незначительный минус).
              if (_baPrevOi !== null && _baPrevOi <= -0.3) {
                _pdbReject("bullish_accumulation", "prev_oi_not_building");
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  "prev_oi_not_building",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  { symbol, prevOi30m: _baPrevOi.toFixed(2) + "%" },
                  "SKIP bullish_accumulation: OI не накапливалось предыдущий цикл (prevOi30m ≤ -0.3)",
                );
                det = null;
              }
            }

            // ── Vol floor для bullish_accumulation ───────────────────────────────────────
            // ПРОБЛЕМА: detectSentiment возвращает bullish_accumulation как безусловный fallback.
            // Сигналы без OI и с низким vol — чистый шум: BILL (-18%), PARTI (-10%).
            // Правило (анализ 6 сигналов, 2026-07-16):
            //   С CG OI ≥ порога настроек:               требуем vol ≥ 1.8x (было 1.5x, 2026-07-16)
            //   Без OI (cgOI недоступен / ниже порога):  требуем vol ≥ 2.5x (было 2.0x, 2026-07-16)
            // spotVolMult приоритетнее volMult (реальный спотовый интерес).
            // Победители: OPENEDEN (2.1x OI≥10%) — проходит; LAB/FHE с 0.6-0.9x — отсечены.
            if (det?.sentiment.key === "bullish_accumulation") {
              const _baEffVol = spotVolMult !== null ? spotVolMult : volMult;
              // _baCgAbove синхронизирован с OI floor выше: cgOI ≥ 3.5% (после реверта с 2.0%).
              // Бэктест: null-группа (OI1h/4h only) = лучший результат (+2.2% avg pnl) — minVol 1.0x.
              // Группа с cgOI 2-3.5% = 50% SL → уже отсечена _baHasStrongOI выше.
              const _baCgAbove =
                (cgOI?.available === true && cgOIChange >= 3.5) ||
                (oi1h !== null && oi1h >= 2.0) ||
                // Выровнен с _baHasStrongOI: oi4h ≥ 2.5% (было 3.0% — несогласованность)
                (oi4h !== null && oi4h >= 2.5);
              const _baMinVol = _baCgAbove ? 1.0 : 1.8;
              if (_baEffVol < _baMinVol) {
                _pdbReject(
                  "bullish_accumulation",
                  _baCgAbove ? "vol_low_with_oi" : "vol_low_no_oi",
                );
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  _baCgAbove ? "vol_low_with_oi" : "vol_low_no_oi",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  {
                    symbol,
                    vol: _baEffVol.toFixed(2),
                    minVol: _baMinVol,
                    hasCgOi: _baCgAbove,
                  },
                  "SKIP bullish_accumulation: объём ниже минимального порога",
                );
                det = null;
              }
            }

            // cycleCount остаётся в entry snapshot для ретроспективного анализа,
            // но не является live-гейтом: время в прескане не доказывает поздний
            // или некачественный вход в Bullish Accumulation.

            // ── OI cross-TF consistency gate ─────────────────────────────────────────────
            // OI1h должен быть неотрицательным если данные есть.
            // KAITO 2026-07-16: OI30m +1.54% но OI1h -0.55%, OI4h -4.39% → OI разворачивается.
            // OI4h < -3%: дистрибуция на старшем ТФ — BA не для этого.
            if (det?.sentiment.key === "bullish_accumulation") {
              if (oi1h !== null && oi1h < 0) {
                _pdbReject("bullish_accumulation", "oi1h_negative");
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  "oi1h_negative",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  { symbol, oi1h: oi1h.toFixed(2) },
                  "SKIP bullish_accumulation: OI1h отрицательный — OI разворачивается",
                );
                det = null;
              } else if (oi4h !== null && oi4h < -5) {
                _pdbReject("bullish_accumulation", "oi4h_unwinding");
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  "oi4h_unwinding",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  { symbol, oi4h: oi4h.toFixed(2) },
                  "SKIP bullish_accumulation: OI4h < -5% — дистрибуция на старшем ТФ",
                );
                det = null;
              }
            }

            // ── p24h cap для bullish_accumulation ────────────────────────────────────────
            // B2 (2026-07-19): 25% → 20%. Анализ сигналов: FLOCK p24h=27.8% → стоп -10.23%,
            // BANK p24h=26.6% → BU стоп; исторически VANRY (73%) и SYN (92%) тоже прошли.
            // B2b (2026-07-19 бэктест 90д): 20% → 10%.
            // Win avg p24h=0.7%, loss avg p24h=16.4%. Бакеты: 0-5%=1w/1sl, 5-10%=0/1,
            // 10-20%=0/0, >20%=0/2 — ни одного победителя выше 5%, удаляем 10-20%+ зону.
            // Калибровка 2026-08-08: 10% → 5%. Верифицировать через неделю.
            if (det?.sentiment.key === "bullish_accumulation") {
              if (!isBullishAccumulationP24hAllowed(price24hChange)) {
                _pdbReject("bullish_accumulation", "price24h_too_high_5pct");
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  "price24h_too_high_5pct",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                recordBullishAccumulationP24hRejection({
                  symbol,
                  priceAtLog: close > 0 ? close : null,
                  price24h: price24hChange,
                  oi30m: oi30m ?? null,
                  oi1h,
                  oi4h,
                  volMult,
                  spotVolMult,
                  prescanCycles: _pe1?.cycleCount ?? null,
                  observedAt: _symRejCycleAt,
                });
                logger.info(
                  { symbol, price24h: price24hChange.toFixed(1) },
                  "BA GATE: p24h > 5% (калибровка 2026-08-08)",
                );
                det = null;
              }
            }

            // ── B3: futures vol floor для bullish_accumulation ───────────────────────────
            // B3 (2026-07-19): минимальный фьюч-объём ≥0.5x. Ретро OI 2-10% зона:
            // fut ≥0.8x → avg_p3h=7.45%, hit_10%=19; fut <0.8x → avg_p3h=3.64%, hit_10%=0.
            // Порог 0.5x (консервативно): блокирует PARTI (0.2x → стоп -10.89%),
            // сохраняет FHE (0.6x → прибыль +4.98%).
            if (det?.sentiment.key === "bullish_accumulation") {
              if (volMult < BA_MIN_FUT_VOLMULT) {
                _pdbReject("bullish_accumulation", "fut_vol_low");
                _symRej(
                  symbol,
                  "bullish_accumulation",
                  "fut_vol_low",
                  oi30m ?? null,
                  volMult,
                  price24hChange,
                  _pe1?.cycleCount ?? null,
                );
                logger.debug(
                  { symbol, futVol: volMult.toFixed(2) },
                  "SKIP bullish_accumulation: futures vol < 0.5x",
                );
                det = null;
              }
            }

            // ── B5: OI4h ceiling для bullish_accumulation ───────────────────────────────
            // Данные 639 сигналов: OI4h > 10% → avg_pnl −1.62% (худший бакет), нет данных → +0.31%.
            // BA — ранний вход; OI4h > 10% = уже горячий, не накопление.
            if (det?.sentiment.key === "bullish_accumulation") {
              const _baOi4h = _pe1?.lastOi4h ?? null;
              if (_baOi4h !== null && _baOi4h > 10) {
                _pdbReject(
                  "bullish_accumulation",
                  `oi4h_too_hot_${_baOi4h.toFixed(1)}pct`,
                );
                logger.debug(
                  { symbol, oi4h: _baOi4h.toFixed(1) },
                  "SKIP bullish_accumulation: OI4h > 10% — токен уже горячий (avg_pnl −1.62%)",
                );
                det = null;
              }
            }

            // ── B6: funding floor для bullish_accumulation ──────────────────────────────
            // Данные: winners avg_funding=+0.003%, losers avg_funding=−0.148%.
            // Очень отрицательный фандинг = рынок шортит нисходящий тренд, не сквиз.
            if (det?.sentiment.key === "bullish_accumulation") {
              const _baFr = _latestFrMap.get(symbol) ?? null;
              if (_baFr !== null && _baFr < -0.0005) {
                _pdbReject(
                  "bullish_accumulation",
                  `funding_neg_${(_baFr * 100).toFixed(3)}pct`,
                );
                logger.debug(
                  { symbol, funding: (_baFr * 100).toFixed(4) + "%" },
                  "SKIP bullish_accumulation: фандинг < −0.05% — нисходящий тренд, не сквиз",
                );
                det = null;
              }
            }

            // ── ФИЛЬТР: накопительные паттерны — требуем объёмный тренд (не одиночный спайк) ──
            // Одна свеча с высоким объёмом может быть шумом (арбитраж, вынос стопов).
            // Если предыдущие 2 закрытые свечи тоже показывают объём >= 1.3x — это ТРЕНД покупок.
            // Данные: SYN (vol=8x но prevVol была нормальная) — убираем такие сигналы.
            // Исключение: isExtremeOiQuiet — при тихом накоплении китов объёмного тренда
            // по определению нет. Сигнал — сам OI, а не объём. Фильтр неприменим.
            // Альтернативный путь через историю: oi4hConsecGrowth >= 3 (OI4h стабильно растёт
            // 3+ цикла подряд) — прокси на устойчивый тренд накопления, заменяет объёмную проверку.
            // Override: Steady Accumulation — 5m+30m одновременный рост + цена flat.
            // С новой философией (только подтверждённые покупки) — НЕ стреляем напрямую при flat цене.
            // Вместо этого добавляем в OI Watch: когда цена тронется на 2%+ — PATH B выстрелит.
            // tSteady попадает сюда с volMult >= 2.5 (иначе ушёл бы в OI Watch раньше).
            if (canEvaluateNonStealth && !det && tSteady) {
              try {
                const existingWatch = await db
                  .select({ id: oiWatchTable.id })
                  .from(oiWatchTable)
                  .where(
                    and(
                      eq(oiWatchTable.symbol, symbol),
                      inArray(oiWatchTable.status, ["watching", "confirming"]),
                    ),
                  )
                  .limit(1);
                if (existingWatch.length === 0) {
                  // dbWriteStrict: критичная запись OI Watch — бросает при неудаче
                  await dbWriteStrict(
                    "oiWatch/steadyAccum-insert",
                    async () => {
                      const _freshPrice = await getFreshPrice(symbol, close);
                      return db.insert(oiWatchTable).values({
                        symbol,
                        triggerTf: "30m",
                        oiChange: oi30m!,
                        priceAtEntry: _freshPrice,
                        volumeMultiplier: spotVolMult ?? volMult, // 1.6
                        sentimentKey: null,
                        status: "watching",
                        addedAt: new Date(),
                        expiresAt: new Date(Date.now() + 6 * 3600 * 1000), // +6ч: единое окно OI Watch
                        avgVolume: avgVol,
                        oi30mChange: oi30m,
                        oi1hChange: oi1h,
                        oi24hChange: oi24h ?? null,
                        price1hChange: price1hChange ?? null,
                        price24hChange: price24hChange,
                        volStatusReason: cgVolStatusReason(spotCvd),
                        entryVolMult: volMult,
                        entryCgTurnover:
                          cgOI?.cgVolUsd != null &&
                          cgOI?.oiUsd != null &&
                          cgOI.oiUsd > 0
                            ? cgOI.cgVolUsd / cgOI.oiUsd
                            : null,
                      });
                    },
                  );
                  logger.info(
                    {
                      symbol,
                      oi30m: oi30m?.toFixed(1),
                      vol: volMult.toFixed(2),
                    },
                    "👁 STEADY ACCUM → OI Watch: flat цена, ждём подтверждения движения",
                  );
                  state.oiWatchLastInsertAt = new Date();
                  state.oiWatchInsertsLastScan++;
                }
              } catch (err) {
                state.oiWatchInsertErrors++;
                state.oiWatchLastInsertError =
                  err instanceof Error ? err.message : String(err);
                logger.warn({ err, symbol }, "tSteady OI Watch insert failed");
                _symRej(
                  symbol,
                  "oi_watch",
                  `oi_watch_tsteady_insert_failed: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)}`,
                  null,
                  null,
                  null,
                  null,
                  "blocked",
                );
              }
              // Не устанавливаем det — продолжаем без прямого сигнала
            }

            // ── SPOT ABSORPTION: CVD standalone detector (Blend/Beat/Folks-тип) ────────
            // Ловит монеты где шорты закрываются (OI нейтральный или слегка падает),
            // но спот-покупки устойчивые — spot absorption перед потенциальным сквизом.
            // Не пересекается с tSteady (tSteady требует flat цены, здесь цена уже растёт).
            // Не пересекается с anyOiPass (здесь OI NOT в зоне стандартных порогов).
            //
            // Условия входа:
            //   cvd30m = true                       — устойчивые спот-покупки (не разовый всплеск)
            //   priceChange: 1%..15%               — рост допустим до 15% (BSB-тип: +9.22% одна свеча)
            //   oi30m < 4.0%                         — OI не растёт взрывом (иначе уже поймал бы tSteady)
            //   volMult >= 1.3x                    — снижено с 1.5x: SYN-тип (1.43x vol) с сильным SpotCVD
            //   !spotAbsorptionOiBlock              — свежий OI-спайк (5m+30m) или tSteady не обнаружен

            // ── GLOBAL LATE-ENTRY FILTER: price3h > 12% → памп уже произошёл 3ч назад ────
            // Порог поднят с 8% до 12%: OI-накопление может продолжаться пока цена растёт.
            if (
              det &&
              det.sentiment.key !== "neon_support_bounce" &&
              price3h > 12
            ) {
              logger.debug(
                {
                  symbol,
                  price3h: price3h.toFixed(1) + "%",
                  pattern: det.sentiment.key,
                },
                "SKIP: late-entry filter — цена выросла >12% за 3ч (поезд ушёл)",
              );
              skipCount.latePump++;
              {
                const _pe = prescanTracker.get(symbol);
                if (_pe) _pe.lastSkipReason = "late_pump";
              }
              _pdbReject(det.sentiment.key, "late_entry_price3h");
              det = null;
            }

            // ── BALANCED GRIND (Архетип F): умеренный рост по всем ТФ ───────────────────
            // Байпас anyOiPass: OI30m/1h/4h все умеренно положительны, ниже порогов anyOiPass.
            // Самый частый архетип (32.3% пампов) — перехватывает «здоровый» рост.
            // Выход: прямой сигнал, стоп -10% (глобальный)
            const _impulseFireFlow =
              resolveImpulseBuyScannerFlow(_impulseLiveDecision);
            if (
              canEvaluateNonStealth &&
              !det &&
              _impulseFireFlow.isConfirmedFire
            ) {
              const _parts = Object.entries(_impulseDecision.components)
                .filter(([, passed]) => passed)
                .map(([name]) => name)
                .join(",");
              det = {
                passes: true,
                oiChangePercent: oi30m ?? 0,
                openInterest: 0,
                sentiment: {
                  key: "impulse_buy",
                  label: "Impulse Buy",
                  traderAction: `LONG (Impulse ${_impulseDecision.score}/${_impulseDecision.maxScore}; ${_parts}; БУ с +5%; частичная фиксация каждые +5%; трейлинг с +15%; начальный стоп -10%)`,
                  oiFalling: false,
                },
              };
              (det as any).__isConfirmedFire = true;
              logger.info(
                {
                  symbol,
                  score: _impulseDecision.score,
                  components: _impulseDecision.components,
                  p24h: price24hChange,
                  p3h: price3h,
                  p1h: price1hChange,
                  futVolMult: volMult,
                  spotVolMult: _impulseSpotVolMult,
                  oi30m,
                  oi1h,
                  oi4h,
                  futTakerNetBuyPct: _impulseFutTakerNetBuyPct,
                  fundingRate: _latestFrMap.get(symbol) ?? null,
                  candleBodyPct: _impulseDecision.candleBodyPct,
                  candleVolumeMult: _impulseDecision.volumeMultiplier,
                  candleCloseStrength: _impulseDecision.closeStrength,
                },
                "⚡ IMPULSE BUY: closed 30m impulse candle + confirmed volume passed",
              );
            }

            // ── STEALTH BREAKOUT: closed 4H Range breakout + two closed 1H holds ──
            if (!det && isStealthBreakout) {
              const _sbDecision =
                _sbArmed.status === "qualified" &&
                "confirmation" in _sbArmed.decision &&
                "refinement" in _sbArmed.decision
                  ? _sbArmed.decision
                  : null;
              const _sbArm =
                "arm" in _sbArmed && _sbArmed.arm ? _sbArmed.arm : null;
              const _sbLevel =
                _sbArm?.breakoutLevel.toPrecision(6) ??
                _sbDecision?.confirmation.breakoutLevel?.toPrecision(6) ??
                "—";
              const _sbModeText =
                _sbArm?.levelSource === "auto_range_1h"
                  ? "Range Breakout 1H"
                  : _sbArm?.levelSource === "auto_range_4h"
                    ? "Range Breakout 4H"
                    : _sbArm?.levelSource === "continuation_shelf"
                      ? "Resistance Breakout"
                      : "legacy Stealth ARMED";
              const _sbBreakoutText =
                _sbArm?.levelSource === "auto_range_1h"
                  ? "пробой Range на закрытой 1H свече и удержание на 30m"
                  : _sbArm?.levelSource === "auto_range_4h"
                    ? "пробой Range на закрытой 4H свече и удержание на 1H"
                    : "пробой сопротивления на закрытой 1H свече и удержание на 30m";
              det = {
                passes: true,
                oiChangePercent: oi30m ?? 0,
                openInterest: 0,
                sentiment: {
                  key: "stealth_breakout",
                  label: "Stealth Breakout",
                  traderAction: `LONG (${_sbModeText} — ${_sbBreakoutText}; уровень ${_sbLevel}; ${_sbDecision?.refinement.timeframe ?? "30m"}: ${_sbDecision?.refinement.status ?? "—"}; дополнительные flow-индикаторы — только наблюдение: ${_sbFlowConfirmations.join(", ") || "нет"} — подтверждённая структура, стоп -10%)`,
                  oiFalling: false,
                },
              };
              (det as any).__isConfirmedFire = true;
              (det as any).__stealthArmId = _sbArmed.armId;
              (det as any).__stealthLevelSource = _sbArm?.levelSource;
              (det as any).__stealthEntryPath =
                (_sbDecision as { entryPath?: string } | null)?.entryPath ??
                null;
              (det as any).__stealthVolumeUnconfirmed =
                _sbVolumeGate?.reason === "volume_unconfirmed";
              (det as any).__stealthDedupArmIds = _sbDeduplicatedArmIds;
              if (_sbArm?.levelSource === "auto_range_4h" && _sbDecision) {
                const venue = _sbArm.autoRangeIdentity?.venue ?? "bingx";
                (det as any).__stealthRangeConfirmingVenues =
                  _sbQualifiedVenueConfirmation?.confirmingVenues ?? [venue];
                (det as any).__stealthRangeLifecycleKey =
                  _sbQualifiedVenueConfirmation?.lifecycleKey ??
                  buildAutoRangeLifecycleKey(symbol, {
                    upper:
                      _sbArm.autoRangeIdentity?.upper ?? _sbArm.breakoutLevel,
                    lower:
                      _sbArm.autoRangeIdentity?.lower ?? _sbArm.breakoutLevel,
                    breakoutCloseTime: _sbDecision.firstCrossAt,
                  });
              }
              logger.info(
                {
                  symbol,
                  structure4hStatus: _sbEvaluationStructure.status,
                  structure4hKind: _sbEvaluationStructure.kind,
                  breakout4hStatus: _sbDecision?.confirmation.status,
                  breakout4hLevel: _sbDecision?.confirmation.breakoutLevel,
                  hold1hStatus: _sbDecision?.refinement.status,
                  hold1hDistancePct:
                    _sbDecision?.refinement.distanceFromLevelPct,
                  levelSource: _sbArm?.levelSource ?? "unknown",
                  experimentVersion: _sbArm?.experimentVersion ?? null,
                  legacyStealthLevel: _sbArm?.legacyBreakoutLevel ?? null,
                  breakoutReasons: [
                    ..._sbEvaluationStructure.reasons,
                    ...(_sbDecision?.confirmation.reasons ?? []),
                    ...(_sbDecision?.refinement.reasons ?? []),
                  ],
                  technicalOnly: true,
                  flowConfirmations: _sbFlowConfirmations,
                  oi30m: oi30m?.toFixed(2) ?? "null",
                  cvd4h: _sbCvd4h,
                  cvd1h: _sbCvd1h,
                  spotTakerNetBuy: _sbSpotTakerNetBuy?.toFixed(1) ?? "null",
                  p24h: price24hChange.toFixed(1),
                },
                "🔵 STEALTH BREAKOUT (E): frozen 4H Range + closed 4H breakout + two closed 1H holds",
              );
            }
            // Neon Support Bounce is intentionally a separate sentiment key.
            // It can only be created from the qualified ABNeon detector event;
            // no POC state, inferred support, or OI fallback may promote it.
            // A qualified quiet-zone Stealth event wins for the same symbol.
            const _neonZones =
              _neonSupportBounceEvent !== null
                ? neonZonesForLevel(
                    klines4hPrefetch.get(symbol) ?? [],
                    _neonSupportBounceEvent.frozenLevel,
                    _neonSupportBounceEvent.armCandleTime,
                  )
                : null;
            const _neonZoneMetrics = {
              zoneBottom: _neonZones?.zone?.bottom ?? null,
              zoneTop:
                _neonZones?.zone?.top ??
                _neonSupportBounceEvent?.frozenLevel ??
                null,
            };
            // Owner 2026-10-15: a price below the 0.5% support band at fire time
            // means the level is broken, not bounced. Hold the qualified event;
            // it may fire later only if price is back at or above the band.
            const _neonPriceNow = parseFloat(ticker.lastPrice);
            const _neonLevelBroken =
              _neonSupportBounceEvent !== null &&
              Number.isFinite(_neonPriceNow) &&
              _neonPriceNow > 0 &&
              _neonPriceNow < _neonSupportBounceEvent.frozenLevel * 0.995;
            // Owner 2026-10-27: broken = 3 consecutive 4H closes >1% below
            // the bottom; a shorter dip that is reclaimed is a sweep.
            const _neonZoneClosedBroken =
              _neonSupportBounceEvent !== null &&
              _neonZones?.zone != null &&
              hasConsecutiveClosesBelow(
                normalizeClosedBreakoutCandles(
                  klines4hPrefetch.get(symbol) ?? [],
                ).filter(
                  (c) => c.time >= _neonSupportBounceEvent.armCandleTime,
                ),
                _neonZones.zone.bottom,
                NEON_SWEEP_RECLAIM_BARS,
              );
            if (_neonZoneClosedBroken && _neonSupportBounceEvent !== null) {
              // The zone is broken (closed 4H below its bottom -1%): release the dead qualified event so the
              // detector arms the next support zone below (owner 2026-10-20).
              void terminalizeBrokenQualifiedNeonSupport({
                symbol,
                frozenLevel: _neonSupportBounceEvent.frozenLevel,
                armCandleTime: _neonSupportBounceEvent.armCandleTime,
                triggerCandleTime: _neonSupportBounceEvent.triggerCandleTime,
              }).catch((err) =>
                logger.warn({ err, symbol }, "Neon broken-zone release failed"),
              );
            }
            if (!det && _neonLevelBroken) {
              _symRej(
                symbol,
                "neon_support_bounce",
                "support_broken_before_entry",
                null,
                null,
                null,
                null,
                "rejected",
                {
                  frozenLevel: _neonSupportBounceEvent!.frozenLevel,
                  priceNow: _neonPriceNow,
                  ..._neonZoneMetrics,
                  ...(_neonLevelBroken
                    ? {
                        nextZoneBottom: _neonZones?.lower?.bottom ?? null,
                        nextZoneTop: _neonZones?.lower?.top ?? null,
                      }
                    : {}),
                },
              );
            }
            // Owner 2026-10-22: no price-vs-zone or "pullback shape" entry filters;
            // a qualified bounce with volume fires, a broken zone waits for the next level.
            // Owner 2026-10-29: the bounce must have buyers — futures takers net
            // buying on the reaction 1H candle and spot CVD 1h > 0 (aggregated;
            // unknown = no signal). A rejected event is not retried later
            // (offered-and-not-fired events expire, owner 2026-10-25).
            let _neonFlowBlocked = false;
            if (!det && _neonSupportBounceEvent !== null && !_neonLevelBroken) {
              const [_neonTakerBars, _neonSpot] = await Promise.all([
                getAggFuturesTakerHistory(symbol, 16).catch(() => null),
                getSpotCvdAndVolume(symbol, { bypassCache: true }).catch(() => null),
              ]);
              const _neonFlow = evaluateNeonFlowGate({
                takerNetUsd: reactionTakerNetUsd(
                  _neonTakerBars,
                  _neonSupportBounceEvent.triggerCandleTime,
                  Date.now(),
                ),
                spotCvd1h: _neonSpot?.cvd.available ? _neonSpot.cvd.cvd1h : null,
              });
              if (!_neonFlow.pass) {
                _neonFlowBlocked = true;
                _symRej(
                  symbol,
                  "neon_support_bounce",
                  `flow_${_neonFlow.reason}`,
                  null,
                  null,
                  null,
                  null,
                  "rejected",
                  {
                    frozenLevel: _neonSupportBounceEvent.frozenLevel,
                    triggerCandleTime: _neonSupportBounceEvent.triggerCandleTime,
                    takerNetUsd: _neonFlow.takerNetUsd,
                    spotCvd1h: _neonFlow.spotCvd1h,
                  },
                );
              }
            }
            if (!det && _neonSupportBounceEvent !== null && !_neonLevelBroken && !_neonFlowBlocked) {
              det = {
                passes: true,
                oiChangePercent: oi30m ?? 0,
                openInterest: 0,
                sentiment: {
                  key: "neon_support_bounce",
                  label: "Neon Support Bounce",
                  traderAction:
                    "LONG (ABNeon retested support + later closed bullish 1H reaction; event-time level frozen)",
                  oiFalling: false,
                },
              };
              (det as any).__isConfirmedFire = true;
              logger.info(
                {
                  symbol,
                  frozenSupport: _neonSupportBounceEvent.frozenLevel,
                  armCandleTime: _neonSupportBounceEvent.armCandleTime,
                  triggerCandleTime: _neonSupportBounceEvent.triggerCandleTime,
                },
                "🟣 NEON SUPPORT BOUNCE: qualified ABNeon event — direct fire",
              );
            }

            // ── PRICE LED MOMENTUM (Архетип C): spot-led momentum ─────────────────────
            // Байпас anyOiPass: PLM определяется ценой и spot-flow, не деривативами.
            // OI и Whale Index остаются в контексте/логах для последующей аналитики.
            // Выход: прямой сигнал, стоп -8%
            if (
              !_isQueuedNeonSupportBounce &&
              canEvaluateNonStealth &&
              !det &&
              isPriceLedMomentum
            ) {
              const _plmPe = prescanTracker.get(symbol);
              const _plmSnf = getSpotNetflowEntry(symbol);
              const _plmOi4hFire = _plmPe?.lastOi4h ?? null;
              const _plmWiFire = _plmPe?.lastWhaleIndex ?? null;
              const _plmCvdsFire = [
                _plmPe?.lastCvd15m === true ? "CVD15m" : null,
                _plmPe?.lastCvd30m === true ? "CVD30m" : null,
                _plmPe?.lastCvd1h === true ? "CVD1h" : null,
                _plmPe?.lastCvd4h === true ? "CVD4h" : null,
              ]
                .filter(Boolean)
                .join("+");
              const _plmSnfStr = (
                _plmSnf?.netPct1h ??
                _plmSnf?.netPct4h ??
                0
              ).toFixed(1);
              det = {
                passes: true,
                oiChangePercent: oi30m ?? 0,
                openInterest: 0,
                sentiment: {
                  key: "price_led_momentum",
                  label: "Price Led Momentum",
                  traderAction: `LONG (p24h +${price24hChange.toFixed(1)}%, p3h +${price3h.toFixed(1)}%, SNF ${_plmSnfStr}%, CVD: ${_plmCvdsFire} — spot-led momentum, OI/WI только для наблюдения, стоп -8%)`,
                  oiFalling: false,
                },
              };
              (det as any).__isConfirmedFire = true;
              logger.info(
                {
                  symbol,
                  p24h: price24hChange.toFixed(1),
                  p3h: price3h.toFixed(1),
                  oi30m: oi30m?.toFixed(2) ?? "null",
                  oi4h: _plmOi4hFire?.toFixed(1) ?? "null",
                  wi: _plmWiFire?.toFixed(0) ?? "null",
                  snf1h: _plmSnf?.netPct1h?.toFixed(1) ?? "null",
                  snf4h: _plmSnf?.netPct4h?.toFixed(1) ?? "null",
                  cvds: _plmCvdsFire,
                },
                "💫 PRICE LED MOMENTUM (C): spot-led momentum — прямой сигнал",
              );
            }

            if (
              !shouldContinueAfterStealthEvaluation({
                supplemental: !canEvaluateNonStealth,
                rangeOnly: isRangeOnlySupplemental,
                detectedPattern: det?.sentiment.key ?? null,
              })
            ) {
              if (canEvaluateNonStealth) {
                // Записываем причину пропуска в prescan-трекере для UI.
                const _pe = prescanTracker.get(symbol);
                if (_pe && _pe.lastSkipReason !== "late_pump") {
                  _pe.lastSkipReason = anyOiPass
                    ? "no_pattern"
                    : !cgOI?.available
                      ? "no_cg_data"
                      : "oi_low";
                }
              }
              break symbolBlock;
            }
            // Паттерн найден — сбрасываем причину пропуска
            {
              const _pe = prescanTracker.get(symbol);
              if (_pe) _pe.lastSkipReason = null;
            }

            // Явный лог "паттерн сработал, символ известен" ДО кулдаунов — раньше был
            // виден только агрегированный passed-счётчик без символа, и когда сигнал
            // пропадал в кулдаунах ниже, невозможно было доказать, какой именно кулдаун
            // его срезал (см. кейс quiet_oi_accumulation passed=1 → 0 сигналов).
            logger.info(
              { symbol, pattern: det!.sentiment.key, cycle: scanCycleCounter },
              "Pattern matched — det assigned, entering cooldown checks",
            );

            // Owner 2026-10-15: all per-symbol cooldowns are removed (cancelled 6h,
            // stop_loss 24h, chronic token 72h, repeat-signal 24h).

            // Repeat marker only (no blocking): the symbol already had a signal in 24h.
            let isRepeatSignal = false;
            {
              const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
              const prev = await db
                .select({ id: trackedSignalsTable.id })
                .from(trackedSignalsTable)
                .where(
                  and(
                    eq(trackedSignalsTable.symbol, symbol),
                    gte(trackedSignalsTable.detectedAt, since24h),
                    ne(trackedSignalsTable.status, "reclassified"),
                  ),
                )
                .limit(1);
              isRepeatSignal = prev.length > 0;
            }

            // OI теперь бонус, а не ворота — отрицательный OI на отдельных ТФ не блокирует сигнал.
            // Исключение 1: если CoinGlass покрывает монету И все краткосрочные ТФ глубоко отрицательные
            // — это явный пост-памп дамп, входить опасно.
            if (
              !_isQueuedNeonSupportBounce &&
              !isStealthTechnicalFire &&
              !isPriceLedMomentum &&
              !shouldBypassImpulseBuyCommonGate(
                _impulseLiveDecision,
                "deep_negative_oi",
              ) &&
              cgOI?.available
            ) {
              const shortTfValues = [oi30m, oi1h].filter(
                (v) => v !== null,
              ) as number[];
              const allDeeplyNegative =
                shortTfValues.length >= 2 && shortTfValues.every((v) => v < -3);
              if (allDeeplyNegative) {
                logger.debug(
                  { symbol, oi30m: oi30m?.toFixed(1), oi1h: oi1h?.toFixed(1) },
                  "SKIP: все краткосрочные OI глубоко отрицательные (< -3%) — пост-памп дамп",
                );
                skipCount.contraSignal++;
                break symbolBlock;
              }
            }

            // ── ОКНО ПОДТВЕРЖДЕНИЯ: 60 минут для всех паттернов ──────────────────────
            // Идея: засёк рост OI → подожди 1 час → проверь что OI всё ещё растёт → сигнал.
            // Это отсекает flash-пампы (OI резко растёт и тут же падает за 10-15 минут).
            // Настоящее накопление держит OI положительным часами.
            //
            // Проверки на 60-й минуте:
            //   • свежий OI (cgOIChange) < -3%   → OI иссяк, накопление закончилось → отмена
            //   • цена откатилась > 5% от точки   → ложный сигнал → отмена
            //   • цена улетела > 20% вверх         → вход слишком дорогой → отмена
            //   • всё остальное                    → СИГНАЛ
            //
            {
              // Время ожидания зависит от ТФ: 4h/24h уже подтверждают многочасовое накопление,
              // долго ждать смысла нет. 30m спайки требуют полного часа проверки.
              // Увеличено с 4ч до 6ч: теперь окно подтверждения 2ч + запас ещё 4ч наблюдения.
              const CONFIRM_EXPIRE_MS = 6 * 60 * 60 * 1000;
              // MAX_RETRACE_PCT определяется ниже — после того как известен тип паттерна (entryTf / sentimentKey).
              const OI_DRAIN_PCT = -3.0;

              const dbConfirmingRows = await db
                .select()
                .from(oiWatchTable)
                .where(
                  and(
                    eq(oiWatchTable.symbol, symbol),
                    eq(oiWatchTable.status, "confirming"),
                  ),
                )
                .limit(1);

              // Мержим DB + in-memory fallback (DB приоритет при дубликатах)
              let confirmingEntry: typeof dbConfirmingRows = dbConfirmingRows;
              if (confirmingEntry.length === 0) {
                const memEntry = confirmingWatchMap.get(symbol);
                if (memEntry && memEntry.expiresAt > new Date()) {
                  confirmingEntry = [
                    {
                      id: -1,
                      symbol: memEntry.symbol,
                      triggerTf: memEntry.triggerTf,
                      oiChange: memEntry.oiChange,
                      priceAtEntry: memEntry.priceAtEntry,
                      volumeMultiplier: memEntry.volumeMultiplier,
                      sentimentKey: memEntry.sentimentKey,
                      status: "confirming",
                      addedAt: memEntry.addedAt,
                      expiresAt: memEntry.expiresAt,
                      avgVolume: memEntry.avgVolume,
                      oi30mChange: memEntry.oi30mChange,
                      oi1hChange: memEntry.oi1hChange,
                      oi24hChange: memEntry.oi24hChange,
                      firedAt: null,
                    } as (typeof dbConfirmingRows)[0],
                  ];
                }
              }

              if (confirmingEntry.length > 0) {
                const entry = confirmingEntry[0];
                const ageMs = Date.now() - new Date(entry.addedAt).getTime();
                const priceFromDetection =
                  ((close - entry.priceAtEntry) / entry.priceAtEntry) * 100;
                // Сохраняем последнюю цену для display в UI — символ может выпасть из prescanTracker
                if (close > 0) oiWatchPriceCache.set(symbol, close);

                // drift4h: изменение цены за последние 4 часа (скользящее окно).
                // Используется вместо priceFromDetection для CONFIRM WAIT — чтобы старые
                // записи (7+ дней в очереди) не блокировались устаревшей точкой входа.
                // 30m свечи → 4h = 8 свечей назад. Берём close той свечи как базу.
                const kline4hAgo =
                  klines.length >= 9 ? klines[klines.length - 9] : klines[0];
                const price4hAgo =
                  parseFloat(kline4hAgo?.close ?? "0") || entry.priceAtEntry;
                const drift4h =
                  price4hAgo > 0
                    ? ((close - price4hAgo) / price4hAgo) * 100
                    : priceFromDetection;

                // Время ожидания определяется по ТФ сохранённому в записи очереди.
                // "4h", "5m+4h" — реальные 4h OI → 30 мин достаточно.
                const entryTf = entry.triggerTf ?? "30m";
                const is4hOI = /\b4h\b/.test(entryTf);
                const is24hOI = /\b24h\b/.test(entryTf);
                const is1hOI = /\b1h\b/.test(entryTf);
                const isSlowPattern = [
                  "dip_accumulation",
                  "spot_divergence",
                  "bullish_accumulation",
                ].includes(entry.sentimentKey ?? "");
                const isImpulseBuy = entry.sentimentKey === "impulse_buy";
                const MAX_RUNAWAY_PCT = isImpulseBuy
                  ? Number.POSITIVE_INFINITY
                  : 10.0;
                // MAX_RETRACE_PCT: Медленные (накопление): -25% — перед памп нормальны глубокие шейк-ауты.
                // OPENEDEN: дал -18-20% откат перед памп +52%. PLAYSOUT: -16% перед +20%.
                const MAX_RETRACE_PCT =
                  isSlowPattern || is24hOI ? -25.0 : -10.0;
                // Окна подтверждения: монета должна удержать накопление перед сигналом.
                const CONFIRM_WINDOW_MS =
                  is4hOI || is24hOI
                    ? 30 * 60 * 1000 // 30 мин: 4h/24h OI — уже подтверждены долгим накоплением
                    : is1hOI
                      ? 60 * 60 * 1000 // 60 мин: 1h OI
                      : 2 * 60 * 60 * 1000; // 2 часа: 30m/5m/steady — накопление требует времени
                const waitMin = Math.round(CONFIRM_WINDOW_MS / 60000);

                if (isSlowPattern) {
                  // Триггер для медленных паттернов: пробой локального хая ИЛИ всплеск объема
                  const recentHighs = klines
                    .slice(-9, -1)
                    .map((k) => parseFloat(k.high) || 0);
                  const recentHigh = Math.max(...recentHighs);
                  const breakout = recentHigh > 0 && close > recentHigh * 1.005; // Пробой на 0.5% выше хая

                  // Дополнительный триггер: всплеск объема на текущей свече (> 3x от avgVolume)
                  // Aggregated (CoinGlass) volume only: current 30m candle vs the
                  // mean of the 20 preceding candles, both in USD.
                  const _slowSeries = await getAggregatedFuturesVolumeSeries30m(
                    symbol,
                  ).catch(() => null);
                  const _slowCurrent =
                    klines[klines.length - 1] === undefined
                      ? null
                      : (_slowSeries?.get(klines[klines.length - 1]!.time) ??
                        null);
                  const _slowHist = klines
                    .slice(-21, -1)
                    .map((k) => _slowSeries?.get(k.time) ?? null);
                  const currentVolume = _slowCurrent ?? 0;
                  const avgVol = _slowHist.every((v): v is number => v !== null)
                    ? _slowHist.reduce((a, v) => a + v, 0) /
                      Math.max(1, _slowHist.length)
                    : 0;
                  const volumeSpike =
                    avgVol > 0 && currentVolume > avgVol * 3.0;

                  if (!breakout && !volumeSpike) {
                    logger.debug(
                      {
                        symbol,
                        close,
                        recentHigh,
                        gap: ((close / recentHigh - 1) * 100).toFixed(2) + "%",
                        currentVolume,
                        avgVol,
                      },
                      "⏳ SLOW PATTERN: ждём пробоя локального хая ИЛИ всплеска объема",
                    );
                    break symbolBlock;
                  }

                  logger.info(
                    {
                      symbol,
                      close,
                      recentHigh,
                      currentVolume,
                      avgVol,
                      trigger: breakout ? "breakout" : "volume_spike",
                    },
                    "✅ SLOW PATTERN: пробой локального хая ИЛИ всплеск объема — сигнал разрешён",
                  );
                  // Триггер сработал — проверяем OI и даём сигнал через стандартные проверки ниже
                }

                // ── OI Watch: накопительные паттерны — те же гейты что и в основном скан-цикле ──
                // Когда det=null (символ не поймали заново) фильтры выше не применяются.
                // Дублируем их здесь чтобы OI Watch путь не был лазейкой.
                const OI_WATCH_ACCUM_KEYS = ["dip_accumulation"];
                if (OI_WATCH_ACCUM_KEYS.includes(entry.sentimentKey ?? "")) {
                  // Vol Trend: предыдущие свечи тоже должны показывать объём
                  if (!isVolTrend && !isExtremeOiQuiet) {
                    logger.debug(
                      {
                        symbol,
                        pattern: entry.sentimentKey,
                        prevVol1: prevVol1Mult.toFixed(2) + "x",
                        prevVol2: prevVol2Mult.toFixed(2) + "x",
                      },
                      "SKIP: OI Watch накоп. паттерн — нет объёмного тренда (предыдущие свечи < 1.3x нормы)",
                    );
                    break symbolBlock;
                  }
                  // Spot CVD: данные обязательны; CVD 1h+4h должны подтверждать накопление
                  if (!spotCvd?.available) {
                    logger.debug(
                      { symbol, pattern: entry.sentimentKey },
                      "SKIP: OI Watch накоп. паттерн — нет данных спота (обязательно для паттерна)",
                    );
                    break symbolBlock;
                  }
                  if (spotCvd.cvd1h !== true || spotCvd.cvd4h !== true) {
                    logger.debug(
                      {
                        symbol,
                        pattern: entry.sentimentKey,
                        cvd1h: spotCvd.cvd1h,
                        cvd4h: spotCvd.cvd4h,
                      },
                      "SKIP: OI Watch накоп. паттерн — спот CVD 1h и/или 4h не подтверждают накопление (false или нет данных)",
                    );
                    break symbolBlock;
                  }
                }

                if (!isSlowPattern && ageMs < CONFIRM_WINDOW_MS) {
                  // Ещё в окне наблюдения. Ранняя отмена если OI уже иссяк или цена рухнула.
                  const earlyOIDrain =
                    cgOI?.available && cgOIChange < OI_DRAIN_PCT;
                  const earlyRetrace = priceFromDetection < MAX_RETRACE_PCT;
                  // OI перестал строиться: был >= 5%, упал ниже 2% — накопление завершилось
                  const earlyOIFaded =
                    cgOI?.available &&
                    cgOIChange < 2.0 &&
                    (entry.oiChange ?? 0) >= 5.0;
                  if (earlyOIDrain || earlyRetrace || earlyOIFaded) {
                    await dbWriteStrict("oiWatch/confirm-earlyCancel", () =>
                      db
                        .update(oiWatchTable)
                        .set({ status: "expired", firedAt: new Date() })
                        .where(eq(oiWatchTable.id, entry.id)),
                    );
                    logger.info(
                      {
                        symbol,
                        tf: entryTf,
                        ageMin: (ageMs / 60000).toFixed(1),
                        oi: cgOIChange.toFixed(1) + "%",
                        drift: priceFromDetection.toFixed(1) + "%",
                      },
                      earlyOIDrain
                        ? "❌ CONFIRM EARLY CANCEL: OI иссяк до окончания ожидания"
                        : earlyOIFaded
                          ? "❌ CONFIRM EARLY CANCEL: OI перестал строиться (< 2%) — накопление завершилось"
                          : "❌ CONFIRM EARLY CANCEL: цена откатилась > 5% — ложный сигнал",
                    );
                    skipCount.noConfirming++;
                    break symbolBlock;
                  }
                  logger.debug(
                    {
                      symbol,
                      tf: entryTf,
                      waitMin,
                      ageMin: (ageMs / 60000).toFixed(1),
                      drift: priceFromDetection.toFixed(1) + "%",
                      freshOI: cgOIChange.toFixed(1) + "%",
                    },
                    `⏳ CONFIRMING: ждём ${waitMin} мин. OI держится.`,
                  );
                  // Обновляем volStatusReason каждый цикл пока токен в confirming — чтобы
                  // фронтенд показывал актуальный статус CVD, а не null (fallback "нет данных CG").
                  if (entry.id > 0) {
                    void db
                      .update(oiWatchTable)
                      .set({ volStatusReason: cgVolStatusReason(spotCvd) })
                      .where(eq(oiWatchTable.id, entry.id))
                      .catch(() => {});
                  }
                  break symbolBlock;
                }

                // Окно закрылось — финальные проверки

                if (cgOI?.available && cgOIChange < OI_DRAIN_PCT) {
                  await dbWriteStrict("oiWatch/confirm-oiDrain", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  );
                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      freshOI: cgOIChange.toFixed(1) + "%",
                    },
                    `❌ CONFIRM FAILED: ${waitMin} мин прошло, но OI упал — накопление закончилось`,
                  );
                  skipCount.noConfirming++;
                  break symbolBlock;
                }

                // OI перестал строиться: был >= 5% при добавлении, теперь ниже 2% — накопление завершилось
                if (
                  cgOI?.available &&
                  cgOIChange < 2.0 &&
                  (entry.oiChange ?? 0) >= 5.0
                ) {
                  await dbWriteStrict("oiWatch/confirm-oiFaded", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  );
                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      currentOI: cgOIChange.toFixed(1) + "%",
                      entryOI: (entry.oiChange ?? 0).toFixed(1) + "%",
                    },
                    "❌ CONFIRM EXPIRED: OI перестал строиться — накопление завершилось",
                  );
                  skipCount.noConfirming++;
                  break symbolBlock;
                }

                if (priceFromDetection < MAX_RETRACE_PCT) {
                  await dbWriteStrict("oiWatch/confirm-priceRetrace", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  );
                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      drift: priceFromDetection.toFixed(1) + "%",
                    },
                    `❌ CONFIRM FAILED: цена откатилась > 5% за ${waitMin} мин — ложный сигнал`,
                  );
                  skipCount.noConfirming++;
                  break symbolBlock;
                }

                if (!isImpulseBuy && priceFromDetection > MAX_RUNAWAY_PCT) {
                  await dbWriteStrict("oiWatch/confirm-priceRunaway", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  );
                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      drift: priceFromDetection.toFixed(1) + "%",
                    },
                    `❌ CONFIRM SKIP: цена ушла > ${MAX_RUNAWAY_PCT}% вверх — вход слишком поздний`,
                  );
                  skipCount.priceTooHigh++;
                  break symbolBlock;
                }

                // Ждём реального начала роста — не входим если цена ещё в минусе или флэте.
                // ZBT-кейс: цена -2.5% → в допуске [-5%..+10%] → сигнал стрелял → вход на дне.
                // ZETA/ATOM/CRV-кейс: цена +0.5% → signal fire → сразу разворот → peak=0% → stale cancel.
                // Исключение: 24h OI — долгосрочное накопление, достаточно любого начала роста.
                // Исключение: dark_flow — активность без OI, сигнал основан на объёме/пре-скрине.
                //   Для него достаточно что цена не рухнула > -5% от точки входа.
                const MIN_POSITIVE_DRIFT = is24hOI
                  ? 0.5
                  : entryTf === "dark_flow"
                    ? -5.0
                    : isSlowPattern
                      ? 1.0 // dip_accum/trend_accum/hidden_accum: цена должна стоять — 2% drift противоречит паттерну
                      : 2.0;
                // Двойной ценовой гейт:
                // 1. drift4h < MIN_POSITIVE_DRIFT — 4h скользящее окно ещё не показало движение.
                // 2. priceFromDetection < priceConfirmFloor — цена ещё не выросла достаточно от точки входа.
                // VVV/AIXBT/PYTH-кейс: drift4h мог быть +2.5% (общий 4h импульс), но
                // priceFromDetection=+0.2% — сигнал стрелял в TG без реального роста.
                const priceConfirmFloor = 1.0;
                if (
                  drift4h < MIN_POSITIVE_DRIFT ||
                  priceFromDetection < priceConfirmFloor
                ) {
                  // ── PRE-BREAKOUT: OI + объём подтверждены, но цена ещё не двинулась ─────
                  // Используем drift4h (скользящее окно 4h) вместо priceFromDetection,
                  // чтобы старые записи (7+ дней) не блокировались устаревшей ценой входа.
                  // GENIUS: oi4h=82%, drift=-6%, 30ч ожидания → памп без сигнала.
                  // IN:     oi4h=52%, drift=-12%, 8.5ч ожидания → то же.
                  // Условия: 2+ ч в очереди, OI или объём подтверждены, не рухнула, не стрелял раньше.
                  // dark_flow: используем volMult >= 2.0 вместо cgOIChange (OI в CG не видно),
                  //            порог краша шире (-10% вместо -5%, т.к. MAX_RETRACE у dark_flow = -10%).
                  const isDarkFlow = entryTf === "dark_flow";
                  const alreadyPreFired = !!(entry.signalPayload as any)
                    ?.preBreakoutFiredAt;
                  const preBreakoutOiOk = isDarkFlow
                    ? volMult >= PREBREAKOUT_DARK_FLOW_MIN_VOLMULT // dark_flow: объём вместо OI
                    : cgOIChange >= 10.0; // нормальный: CG OI >= 10%
                  const preBreakoutMaxCrash = isDarkFlow ? -10.0 : -5.0;
                  if (
                    !alreadyPreFired &&
                    ageMs >= 2 * 60 * 60 * 1000 && // 2+ часа ожидания
                    preBreakoutOiOk && // OI или объём подтверждён
                    volMult >= PREBREAKOUT_MIN_VOLMULT && // объём подтверждён в любом случае
                    priceFromDetection > preBreakoutMaxCrash // цена не рухнула
                  ) {
                    // Помечаем запись — больше не стреляем pre_breakout из этого entry
                    // dbWriteBestEffort: защита от зависания при нагрузке на Neon pool
                    await dbWriteStrict("oiWatch/preBreakoutFired-mark", () =>
                      db
                        .update(oiWatchTable)
                        .set({
                          signalPayload: {
                            ...((entry.signalPayload as any) ?? {}),
                            preBreakoutFiredAt: new Date().toISOString(),
                          },
                        })
                        .where(eq(oiWatchTable.id, entry.id)),
                    );

                    const base = symbol.replace("-USDT", "");
                    const oi4hStr =
                      cgOI?.oiChange4h != null
                        ? `  • OI 4h: <b>+${cgOI.oiChange4h.toFixed(1)}%</b>`
                        : "";
                    const _preMsg = isDarkFlow
                      ? [
                          `🌑 <b>DARK FLOW: ${base}/USDT</b>`,
                          ``,
                          `Устойчивая активность без следа в OI — цена <b>не двинулась</b>`,
                          ``,
                          `  • Объём: <b>${volMult.toFixed(1)}x</b>`,
                          `  • OI CoinGlass: <b>${cgOIChange > 0 ? "+" : ""}${cgOIChange.toFixed(1)}%</b> (ниже порога)`,
                          `  • Дрейф от входа: <b>${priceFromDetection.toFixed(1)}%</b>`,
                          `  • В confirming-очереди: <b>${Math.round(ageMs / 60000)} мин</b>`,
                          ``,
                          `💡 Умные деньги вне OI-радара — жди пробой или объёмный всплеск`,
                          ``,
                          formatMarketLinks(symbol),
                          ``,
                          `#${base} #dark_flow`,
                        ].join("\n")
                      : [
                          `🔍 <b>PRE-BREAKOUT: ${base}/USDT</b>`,
                          ``,
                          `OI и объём подтверждены — цена ещё <b>не двинулась</b>`,
                          ``,
                          `  • OI (global): <b>+${cgOIChange.toFixed(1)}%</b>`,
                          oi4hStr || null,
                          `  • Объём: <b>${volMult.toFixed(1)}x</b>`,
                          `  • Дрейф от входа: <b>${priceFromDetection.toFixed(1)}%</b>`,
                          `  • В очереди: <b>${Math.round(ageMs / 60000)} мин</b>`,
                          ``,
                          `💡 Накопление без старта — жди пробой или объёмный всплеск`,
                          ``,
                          formatMarketLinks(symbol),
                          ``,
                          `#${base} #pre_breakout`,
                        ]
                          .filter((l) => l !== null)
                          .join("\n");

                    // ── Spot volume gate (Pre-Breakout / Dark Flow) ─────────────────────────
                    const [pbFsVol, pbMcapRaw] = await Promise.all([
                      getFsVolume(symbol).catch(() => null),
                      fetchMarketCap(symbol).catch(() => null),
                    ]);
                    const pbSpotVol24h = pbFsVol?.spotVolUsd24h ?? null;
                    const pbMcapUsd = pbMcapRaw?.mcap ?? null;
                    const tag = isDarkFlow ? "DARK FLOW" : "PRE-BREAKOUT";
                    // Нет спота или нет MCap → блок.
                    const pbSpotOk =
                      pbSpotVol24h !== null &&
                      pbMcapUsd !== null &&
                      pbSpotVol24h >= pbMcapUsd * MIN_SPOT_VOL_MCAP_FRACTION;
                    if (!pbSpotOk) {
                      const pct =
                        pbSpotVol24h !== null && pbMcapUsd
                          ? ((pbSpotVol24h / pbMcapUsd) * 100).toFixed(3)
                          : "нет данных";
                      logger.info(
                        { symbol, pbSpotVol24h, pbMcapUsd, pct },
                        pbSpotVol24h === null
                          ? `${tag}: нет данных спота — сигнал отменён`
                          : pbMcapUsd === null
                            ? `${tag}: MCap недоступен — сигнал отменён`
                            : `${tag}: спот-объём < 1% MCap — сигнал отменён`,
                      );
                    } else {
                      try {
                        // Telegram не шлём — ждём полного подтверждения тихо (без спама отменами)
                        logger.info(
                          {
                            symbol,
                            tf: entryTf,
                            oi: cgOIChange.toFixed(1) + "%",
                            vol: volMult.toFixed(1) + "x",
                            drift: priceFromDetection.toFixed(1) + "%",
                            ageMin: Math.round(ageMs / 60000),
                          },
                          isDarkFlow
                            ? "🌑 DARK FLOW: устойчивая активность → в трекер (без TG, ждём подтверждение)"
                            : "🔍 PRE-BREAKOUT: OI+объём подтверждены → в трекер (без TG, ждём движение цены)",
                        );
                        // Сигнал ещё не подтверждён — ждём движение цены (не создаём запись в трекере)
                      } catch (err) {
                        logger.warn(
                          { err, symbol },
                          "PRE-BREAKOUT: ошибка отправки алерта",
                        );
                      }
                    } // end spot ok else
                  }

                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      drift4h: drift4h.toFixed(1) + "%",
                      driftFromEntry: priceFromDetection.toFixed(1) + "%",
                      ageMin: (ageMs / 60000).toFixed(0),
                    },
                    "⏳ CONFIRM WAIT: цена ещё не в росте — ждём старта движения",
                  );
                  break symbolBlock; // не отменяем, просто ждём — expire случится через 6ч если роста не будет
                }

                // Ghost pump guard: 24h памп >30% с остывающим объёмом (< 2.5x) =
                // торговая возможность уже случилась ДО нашего сигнала.
                // Глобальный exhausted pump check ловит >40%, но для confirming-блока строже:
                // токен мог попасть в очередь на старте памп (price ~0%), к моменту подтверждения
                // уже +35% → priceFromDetection всё ещё мал (считается от priceAtEntry, не от дня),
                // поэтому MAX_RUNAWAY_PCT не срабатывает. Ghost pump guard закрывает этот зазор.
                if (
                  !isImpulseBuy &&
                  price24hChange > 40 &&
                  (spotVolMult === null || spotVolMult < 2.5)
                ) {
                  await dbWriteStrict("oiWatch/confirm-ghostPump", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  );
                  confirmingWatchMap.delete(symbol); // убираем из памяти при истечении
                  logger.info(
                    {
                      symbol,
                      tf: entryTf,
                      price24hChange: price24hChange.toFixed(1) + "%",
                      volMult: volMult.toFixed(2),
                      drift: priceFromDetection.toFixed(1) + "%",
                    },
                    "❌ GHOST PUMP: 24h рост >30% + объём остыл — памп случился до сигнала, пропускаем",
                  );
                  skipCount.stalePump++;
                  break symbolBlock;
                }

                // ✅ OI держится, цена пошла вверх — сигнал подтверждён
                // КРИТИЧНО: 3 попытки / 5s — статус "fired" предотвращает двойной выстрел;
                // если UPDATE потерян, следующий цикл может повторно запустить этот entry.
                // Broadcast-dedup в broadcastBatchAlert (атомарный UPDATE+RETURNING) служит
                // финальным барьером от дублированных Telegram-алертов.
                await dbWriteStrict(
                  "oiWatch/confirm-setFired",
                  () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "fired", firedAt: new Date() })
                      .where(eq(oiWatchTable.id, entry.id)),
                  { attempts: 3, perAttemptTimeoutMs: 5000, retryDelayMs: 500 },
                );
                confirmingWatchMap.delete(symbol); // убираем из памяти при выстреле
                // Supersede: гасим другие активные записи того же символа (watching/confirming).
                // Статус fired уже проставлен → они не попадут в WHERE.
                const _supersededRows =
                  (await dbWriteBestEffort("oiWatch/supersede", () =>
                    db
                      .update(oiWatchTable)
                      .set({ status: "expired", volStatusReason: "superseded" })
                      .where(
                        and(
                          eq(oiWatchTable.symbol, symbol),
                          inArray(oiWatchTable.status, [
                            "watching",
                            "confirming",
                          ]),
                        ),
                      )
                      .returning({
                        id: oiWatchTable.id,
                        oi30m: oiWatchTable.oi30mChange,
                        oi1h: oiWatchTable.oi1hChange,
                        oi24h: oiWatchTable.oi24hChange,
                        volMult: oiWatchTable.volumeMultiplier,
                      }),
                  )) ?? [];
                logger.info(
                  {
                    symbol,
                    tf: entryTf,
                    waitMin,
                    ageMin: (ageMs / 60000).toFixed(1),
                    drift: priceFromDetection.toFixed(1) + "%",
                    freshOI: cgOIChange.toFixed(1) + "%",
                  },
                  `✅ CONFIRMED: OI держится ${waitMin} мин, цена стабильна — сигнал разрешён`,
                );
                // Помечаем что кандидат пришёл из confirming-очереди — финальный цикл
                // пропустит watching-очередь и выстрелит напрямую (без PATH A задержки).
                (det as any).__isConfirmedFire = true;
              } else if ((det as any).__isConfirmedFire === true) {
                // ── АРХЕТИПНЫЙ ПРЯМОЙ СИГНАЛ: байпас 2-часовой очереди OI Watch ──────
                // Паттерны stealth_breakout / demark / price_led_momentum
                // устанавливают __isConfirmedFire прямо при детекции.
                // Путь через OI Watch confirming (2ч ожидания) убивал эти сигналы:
                //   • stealth_breakout:  пробой случился → за 2ч остыл → сигнал пропущен
                // Нормальные паттерны НЕ устанавливают __isConfirmedFire при детекции —
                // он выставляется только в строке 5708 по итогам confirming-окна.
                // Поэтому флаг корректно разделяет прямые и косвенные сигналы.
                logger.info(
                  { symbol, pattern: det!.sentiment.key },
                  "🎯 ARCHETYPE DIRECT FIRE: пропуск 2h очереди OI Watch — прямой сигнал",
                );
                // No break — falls through to signal assembly below
              } else {
                // Первый раз видим — сохраняем реальный ТФ, чтобы знать сколько ждать
                const confirmAddedAt = new Date();
                const confirmExpiresAt = new Date(
                  Date.now() + CONFIRM_EXPIRE_MS,
                );
                // Получаем свежую цену заранее — нужна и для DB, и для in-memory fallback
                let confirmPrice = close;
                try {
                  confirmPrice = await getFreshPrice(symbol, close);
                } catch {
                  /* use close */
                }

                try {
                  // Guard: если уже есть watching-запись — не создаём параллельный confirming (EIGEN-баг).
                  // confirmingWatchMap защищает от duplicate confirming, но не от watching→confirming коллизии.
                  const alreadyWatching = await db
                    .select({ id: oiWatchTable.id })
                    .from(oiWatchTable)
                    .where(
                      and(
                        eq(oiWatchTable.symbol, symbol),
                        inArray(oiWatchTable.status, [
                          "watching",
                          "confirming",
                        ]),
                      ),
                    )
                    .limit(1);
                  if (alreadyWatching.length > 0) {
                    logger.debug(
                      { symbol, tf: oiTriggerTf },
                      "PATH A confirming skip: уже есть watching-запись — дублирование предотвращено",
                    );
                  } else {
                    // dbWriteStrict: критичная запись PATH A — бросает при неудаче
                    await dbWriteStrict("oiWatch/pathA-insert", () =>
                      db.insert(oiWatchTable).values({
                        symbol,
                        triggerTf: oiTriggerTf,
                        oiChange: cgOIChange,
                        priceAtEntry: confirmPrice,
                        volumeMultiplier: spotVolMult ?? volMult, // 1.6
                        sentimentKey: det!.sentiment.key,
                        status: "confirming",
                        addedAt: confirmAddedAt,
                        expiresAt: confirmExpiresAt,
                        avgVolume: avgVol,
                        oi30mChange: oi30m,
                        oi1hChange: oi1h,
                        oi24hChange: oi24h ?? null,
                        price1hChange: price1hChange ?? null,
                        price24hChange: price24hChange,
                        entryVolMult: volMult,
                        entryCgTurnover:
                          cgOI?.cgVolUsd != null &&
                          cgOI?.oiUsd != null &&
                          cgOI.oiUsd > 0
                            ? cgOI.cgVolUsd / cgOI.oiUsd
                            : null,
                      }),
                    );
                    // DB INSERT удался — убираем из памяти если там был стейл
                    confirmingWatchMap.delete(symbol);
                    const waitMin =
                      oiTriggerTf.includes("24h") || oiTriggerTf.includes("4h")
                        ? 15
                        : oiTriggerTf.includes("1h")
                          ? 30
                          : 60;
                    logger.info(
                      {
                        symbol,
                        tf: oiTriggerTf,
                        waitMin,
                        price: priceChange.toFixed(1) + "%",
                        oi: cgOIChange.toFixed(1) + "%",
                        pattern: det!.sentiment.key,
                      },
                      `🕐 QUEUED: первое обнаружение — ждём ${waitMin} мин подтверждения OI`,
                    );
                  } // end else: нет watching-записи, INSERT выполнен
                } catch (err) {
                  logger.warn(
                    { err, symbol },
                    "confirming OI Watch insert failed — saving to in-memory fallback",
                  );
                  _symRej(
                    symbol,
                    "oi_watch",
                    `oi_watch_confirming_insert_failed: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)}`,
                    null,
                    null,
                    null,
                    null,
                    "blocked",
                  );
                  // Сохраняем в памяти — следующий скан найдёт запись и продолжит окно подтверждения
                  confirmingWatchMap.set(symbol, {
                    symbol,
                    triggerTf: oiTriggerTf,
                    oiChange: cgOIChange,
                    priceAtEntry: confirmPrice,
                    volumeMultiplier: spotVolMult ?? volMult, // 1.6
                    sentimentKey: det!.sentiment.key,
                    addedAt: confirmAddedAt,
                    expiresAt: confirmExpiresAt,
                    avgVolume: avgVol,
                    oi30mChange: oi30m,
                    oi1hChange: oi1h,
                    oi24hChange: oi24h ?? null,
                  });
                  _otherSkipReason.set(symbol, "confirming_watch_started");
                  skipCount.other++;
                }
                break symbolBlock;
              }
            }

            logger.info(
              {
                symbol,
                globalOI: cgOIChange.toFixed(1) + "%",
                bingxOI:
                  cgOI?.bingxOiChange30m != null
                    ? cgOI.bingxOiChange30m.toFixed(1) + "%"
                    : "n/a",
                vol: volMult.toFixed(1) + "x",
                price: priceChange.toFixed(1) + "%",
                pattern: det!.sentiment.key,
              },
              "CoinGlass OI + Volume PASSED → candidate",
            );

            const safeOI: CoinglassOIResult = cgOI ?? {
              available: false,
              timedOut: false,
              source: "coinglass",
              oiUsd: 0,
              oiChange30m: null,
              prevOi30m: null,
              oiChange1h: null,
              oiChange4h: null,
              oiChange24h: null,
              bingxOiChange30m: null,
              cgVolUsd: null,
              positiveCandles6h: null,
              oiConsecutiveUp: null,
              oi4hConsecFromOhlc: null,
            };

            candidates.push({
              symbol,
              price: close,
              priceChange30m: priceChange,
              price1hChange: price1hChange ?? null,
              price3hChange: price3h,
              price4hChange,
              price24hChange,
              currentVolume: currentVol,
              avgVolume: avgVol,
              volumeMultiplier: spotVolMult ?? volMult, // 1.6
              oiChangePercent: cgOIChange,
              oiChange1h: oi1h,
              oiChange4h: oi4h,
              oiChange24h: oi24h,
              openInterest: safeOI.oiUsd ?? 0,
              sentiment: det!.sentiment,
              coinglassOI: safeOI,
              oiTriggerTf,
              isRepeatSignal,
              isConfirmedFire: isConfirmedDetection(det),
              stealthArmId: (det as any).__stealthArmId,
              stealthDedupArmIds: (det as any).__stealthDedupArmIds,
              stealthDetectionMethod:
                det!.sentiment.key === "stealth_breakout"
                  ? "quiet_zone_breakout"
                  : undefined,
              ...((det as any).__stealthLevelSource
                ? { stealthLevelSource: (det as any).__stealthLevelSource }
                : {}),
              ...((det as any).__stealthEntryPath
                ? { stealthEntryPath: (det as any).__stealthEntryPath }
                : {}),
              ...((det as any).__stealthVolumeUnconfirmed
                ? { stealthVolumeUnconfirmed: true }
                : {}),
              ...((det as any).__stealthRangeConfirmingVenues
                ? {
                    stealthRangeConfirmingVenues: (det as any)
                      .__stealthRangeConfirmingVenues,
                    stealthRangeLifecycleKey: (det as any)
                      .__stealthRangeLifecycleKey,
                  }
                : {}),
              neonSupportBounceEvent:
                det!.sentiment.key === "neon_support_bounce"
                  ? (_neonSupportBounceEvent ?? undefined)
                  : undefined,
              isScalpOnly,
              futVolMult: volMult, // фьюч BingX klines (Phase 2)
              spotVol24h: getSpotPoolEntry(symbol)?.spotVol24h ?? null, // из SpotPool (глобальный)
              futVol24hUsd: vol24hUSD, // для collision-check ликвидаций
              impulseDecision: _impulseDecision,
              impulseFundingRate: _impulseFundingRate,
              impulseSpotVolumeMultiplier: _impulseSpotVolMult,
              impulseOi30m: _impulseOi30m ?? oi30m,
              impulseCandleClosedAt: _closed30m
                ? new Date(_closed30m.time + 30 * 60_000)
                : null,
              futTakerNetBuyPct: _impulseFutTakerNetBuyPct,
              decisionMetrics: isPriceLedMomentum
                ? _plmDecisionMetrics
                : isStealthBreakout
                  ? _sbDecisionMetrics
                  : undefined,
              plmSpotVolMult: isPriceLedMomentum ? _plmSpotVolMult : undefined,
              baOiPath: _baOiPath,
            });
            // no-match: прошёл все гейты, но ни один паттерн не сработал (det===null)
            if (det === null) {
              _symRej(
                symbol,
                "no_match",
                "no_pattern_fired",
                oi30m ?? null,
                volMult,
                price24hChange,
                _pe1?.cycleCount ?? null,
              );
            }
          } while (false);
          // Any pattern that passed its own check but produced neither a candidate
          // nor a recorded reason must leave a record (owner order 2026-10-10).
          for (const _passedKey of _symPassStore.passed) {
            const _cand = candidates
              .slice(_dropCandidatesBefore)
              .find(
                (cand) =>
                  cand.symbol === symbol && cand.sentiment.key === _passedKey,
              );
            if (_cand) continue;
            const _logged = _symRejLog.some(
              (row) =>
                row.cycleAt === _symRejCycleAt &&
                row.symbol === symbol &&
                row.pattern === _passedKey,
            );
            if (_logged) continue;
            const _other = candidates
              .slice(_dropCandidatesBefore)
              .find((cand) => cand.symbol === symbol);
            const _changed = (
              Object.keys(skipCount) as Array<keyof typeof skipCount>
            )
              .filter((k) => skipCount[k] > _dropSkipSnap[k])
              .map(String);
            const _c = _pdbCtx.value;
            const _same = _c !== null && _c.symbol === symbol ? _c : null;
            _symRej(
              symbol,
              _passedKey,
              `baseline_pass_no_fire:${
                _other
                  ? `other_pattern_${_other.sentiment.key}`
                  : (_changed.includes("other") && _otherSkipReason.get(symbol)
                      ? _changed
                          .map((k) =>
                            k === "other" ? _otherSkipReason.get(symbol) : k,
                          )
                          .join("+")
                      : _changed.join("+")) || "unclassified"
              }`,
              _same?.oi30m ?? null,
              _same?.volMult ?? null,
              _same?.price24h ?? null,
              _same?.prescanCycles ?? null,
              "blocked",
              undefined,
              _same?.entryPrice ?? null,
            );
          }
          const _dropKey = _dropDetKey?.() ?? null;
          if (
            _dropKey !== null &&
            candidates.length === _dropCandidatesBefore
          ) {
            const changed = (
              Object.keys(skipCount) as Array<keyof typeof skipCount>
            )
              .filter((k) => skipCount[k] > _dropSkipSnap[k])
              .map(String);
            const deferred = changed.length === 1 && changed[0] === "other";
            const ctx = _pdbCtx.value;
            const same = ctx !== null && ctx.symbol === symbol ? ctx : null;
            _symRej(
              symbol,
              _dropKey,
              deferred
                ? "queued_for_confirmation"
                : `post_detection_dropped:${changed.join("+") || "unclassified"}`,
              same?.oi30m ?? null,
              same?.volMult ?? null,
              same?.price24h ?? null,
              same?.prescanCycles ?? null,
              deferred ? "deferred" : "blocked",
              undefined,
              same?.entryPrice ?? null,
            );
          }
        } catch (err) {
          logger.warn({ symbol, err }, "Error scanning symbol");
          _symRej(
            symbol,
            "scan",
            `symbol_scan_exception: ${(err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").slice(0, 160)}`,
            null,
            null,
            null,
            null,
            "blocked",
          );
        }
      }),
    ); // конец _symWorkPromise IIFE

    // Do not release the worker while the symbol promise is still running.
    // Promise.race used to make a 45s timeout look like cancellation, while
    // the IIFE continued issuing HTTP/DB work in the background and consumed
    // the same Neon/API capacity as newer symbols. All market clients now
    // compose their endpoint timeout with the cycle signal, so awaiting the
    // actual promise is the safe backpressure point.
    const symbolStartedAt = Date.now();
    await _symWorkPromise;
    const symbolElapsedMs = Date.now() - symbolStartedAt;
    _loopSymbolTimes.push({ symbol, ms: symbolElapsedMs });
    if (symbolElapsedMs > 45_000) {
      logger.warn(
        { symbol, elapsedMs: symbolElapsedMs },
        "⏱ Symbol processing exceeded 45s — completed with backpressure",
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  };
  // ── Stealth fresh-24H-high (🧪 experimental, owner 2026-10-28) ──────────
  // Events from the hourly scan of all BingX USDT perpetuals fire in the first
  // batch of the next cycle. Entry = live price; stop = broken 24H high - 1%.
  if (STEALTH_FH_LIVE && stealthFreshHighQueue.size > 0) {
    const _fhNow = Date.now();
    const _fhEvents = [...stealthFreshHighQueue.entries()];
    stealthFreshHighQueue.clear();
    for (const [, ev] of _fhEvents) {
      const closeAt = ev.candleTime + STEALTH_FH_HOUR_MS;
      if (_fhNow - closeAt > STEALTH_FH_EVENT_TTL_MS) {
        _symRej(
          ev.symbol,
          "stealth_breakout",
          "stealth_fh_event_expired_before_fire",
          null,
          null,
          ev.ret24hPct,
          null,
          "blocked",
        );
        continue;
      }
      try {
        const already = await db
          .select({ id: trackedSignalsTable.id })
          .from(trackedSignalsTable)
          .where(
            and(
              eq(trackedSignalsTable.symbol, ev.symbol),
              eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
              gte(trackedSignalsTable.detectedAt, new Date(closeAt)),
            ),
          )
          .limit(1);
        if (already.length > 0) continue;
      } catch (err) {
        logger.warn(
          { err, symbol: ev.symbol },
          "Stealth fresh-high duplicate check failed; event re-queued",
        );
        stealthFreshHighQueue.set(`${ev.symbol}:${ev.candleTime}`, ev);
        continue;
      }
      const fmt = (v: number | null, d = 2) =>
        v === null || !Number.isFinite(v) ? "—" : v.toFixed(d);
      const _fhOi = coinglassOIMap.get(ev.symbol) ?? null;
      candidates.push({
        symbol: ev.symbol,
        price: ev.close,
        priceChange30m: 0,
        price1hChange: null,
        price3hChange: 0,
        price4hChange: 0,
        price24hChange: ev.ret24hPct ?? 0,
        currentVolume: 0,
        avgVolume: 0,
        volumeMultiplier: 0,
        oiChangePercent: _fhOi?.oiChange30m ?? 0,
        oiChange1h: _fhOi?.oiChange1h ?? null,
        oiChange4h: _fhOi?.oiChange4h ?? null,
        oiChange24h: _fhOi?.oiChange24h ?? null,
        openInterest: _fhOi?.oiUsd ?? 0,
        sentiment: {
          key: "stealth_breakout",
          label: "Stealth Breakout",
          traderAction: `LONG (🧪 ЭКСПЕРИМЕНТ — свежий пробой 24ч-хая на закрытой 1H свече; уровень ${ev.prevHigh24?.toPrecision(6) ?? "—"}; база 72ч ${fmt(ev.baseHeightPct, 1)}%; рост 24ч +${fmt(ev.ret24hPct, 1)}%; стоп ${ev.stopPrice?.toPrecision(6) ?? "—"} (уровень −1%); при +1R стоп в Б/У, дальше трейлинг 1R от пика; максимум 72ч)`,
          oiFalling: false,
        },
        coinglassOI: _fhOi ?? {
          available: false,
          timedOut: false,
          source: "coinglass",
          oiUsd: 0,
          oiChange30m: null,
          prevOi30m: null,
          oiChange1h: null,
          oiChange4h: null,
          oiChange24h: null,
          bingxOiChange30m: null,
          cgVolUsd: null,
          positiveCandles6h: null,
          oiConsecutiveUp: null,
          oi4hConsecFromOhlc: null,
        },
        oiTriggerTf: "stealth_fresh_24h_high",
        isRepeatSignal: false,
        isConfirmedFire: true,
        stealthDetectionMethod: STEALTH_FRESH_HIGH_METHOD,
        isScalpOnly: false,
        futVolMult: 0,
        spotVol24h: getSpotPoolEntry(ev.symbol)?.spotVol24h ?? null,
        futVol24hUsd: ev.quoteVolume24h ?? 0,
        decisionMetrics: {
          stealthFreshHigh: {
            version: "stealth-fresh-24h-high-v1",
            candleOpenAt: new Date(ev.candleTime).toISOString(),
            candleClose: ev.close,
            prevHigh24: ev.prevHigh24,
            stopPrice: ev.stopPrice,
            riskPctAtClose: ev.riskPct,
            base72HeightPct: ev.baseHeightPct,
            ret24hPct: ev.ret24hPct,
            newHighsPrev24: ev.newHighsPrev24,
            detectedAt: new Date(ev.detectedAt).toISOString(),
          },
        },
      });
      logger.info(
        {
          symbol: ev.symbol,
          close: ev.close,
          stop: ev.stopPrice,
          base72: ev.baseHeightPct,
          ret24h: ev.ret24hPct,
        },
        "🧪 STEALTH fresh-24H-high candidate queued for confirmed fire",
      );
    }
  }
  // ── Stealth 4H Range breakout (🧪 experimental, owner 2026-10-29) ────────
  // Events from the 4H scan fire in the first batch of the next cycle.
  // Entry = live price; stop = range top - 1%; R exit in the watcher.
  if (STEALTH_R4H_LIVE && stealthRange4hQueue.size > 0) {
    const _r4Now = Date.now();
    const _r4Events = [...stealthRange4hQueue.entries()];
    stealthRange4hQueue.clear();
    for (const [, ev] of _r4Events) {
      const closeAt = ev.candleTime + STEALTH_R4H_H4_MS;
      if (_r4Now - closeAt > STEALTH_FH_EVENT_TTL_MS) {
        _symRej(ev.symbol, "stealth_breakout", "stealth_r4h_event_expired_before_fire",
          null, ev.volRatio, null, null, "blocked");
        continue;
      }
      try {
        const already = await db
          .select({ id: trackedSignalsTable.id })
          .from(trackedSignalsTable)
          .where(
            and(
              eq(trackedSignalsTable.symbol, ev.symbol),
              eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
              gte(trackedSignalsTable.detectedAt, new Date(closeAt)),
            ),
          )
          .limit(1);
        if (already.length > 0) continue;
      } catch (err) {
        logger.warn({ err, symbol: ev.symbol }, "Stealth 4H duplicate check failed; event re-queued");
        stealthRange4hQueue.set(`${ev.symbol}:${ev.candleTime}`, ev);
        continue;
      }
      const fmt = (v: number | null, d = 2) =>
        v === null || !Number.isFinite(v) ? "—" : v.toFixed(d);
      const _r4Oi = coinglassOIMap.get(ev.symbol) ?? null;
      candidates.push({
        symbol: ev.symbol,
        price: ev.close,
        priceChange30m: 0,
        price1hChange: null,
        price3hChange: 0,
        price4hChange: 0,
        price24hChange: 0,
        currentVolume: 0,
        avgVolume: 0,
        volumeMultiplier: ev.volRatio ?? 0,
        oiChangePercent: _r4Oi?.oiChange30m ?? 0,
        oiChange1h: _r4Oi?.oiChange1h ?? null,
        oiChange4h: _r4Oi?.oiChange4h ?? null,
        oiChange24h: _r4Oi?.oiChange24h ?? null,
        openInterest: _r4Oi?.oiUsd ?? 0,
        sentiment: {
          key: "stealth_breakout",
          label: "Stealth Breakout",
          traderAction: `LONG (🧪 ЭКСПЕРИМЕНТ — пробой 4H-ренджа на закрытой 4H свече; верх ренджа ${ev.rangeTop?.toPrecision(6) ?? "—"}; объём ×${fmt(ev.volRatio, 1)} (все биржи); тейкеры и спот в покупке; стоп ${ev.stopPrice?.toPrecision(6) ?? "—"} (верх −1%); при +1R стоп в Б/У, дальше трейлинг 1R от пика; максимум 72ч)`,
          oiFalling: false,
        },
        coinglassOI: _r4Oi ?? {
          available: false,
          timedOut: false,
          source: "coinglass",
          oiUsd: 0,
          oiChange30m: null,
          prevOi30m: null,
          oiChange1h: null,
          oiChange4h: null,
          oiChange24h: null,
          bingxOiChange30m: null,
          cgVolUsd: null,
          positiveCandles6h: null,
          oiConsecutiveUp: null,
          oi4hConsecFromOhlc: null,
        },
        oiTriggerTf: "stealth_range_4h",
        isRepeatSignal: false,
        isConfirmedFire: true,
        stealthDetectionMethod: STEALTH_RANGE_4H_METHOD,
        isScalpOnly: false,
        futVolMult: ev.volRatio ?? 0,
        spotVol24h: getSpotPoolEntry(ev.symbol)?.spotVol24h ?? null,
        futVol24hUsd: ev.quoteVolume24h ?? 0,
        decisionMetrics: {
          stealthRange4h: {
            version: "stealth-range-4h-v1",
            candleOpenAt: new Date(ev.candleTime).toISOString(),
            candleClose: ev.close,
            rangeTop: ev.rangeTop,
            rangeBottom: ev.rangeBottom,
            rangeHours: ev.rangeHours,
            volRatio: ev.volRatio,
            takerNetUsd: ev.takerNetUsd,
            spotCvd4h: ev.spotCvd4h,
            stopPrice: ev.stopPrice,
            riskPctAtClose: ev.riskPct,
            detectedAt: new Date(ev.detectedAt).toISOString(),
          },
        },
      });
      logger.info(
        { symbol: ev.symbol, close: ev.close, stop: ev.stopPrice, volRatio: ev.volRatio },
        "🧪 STEALTH 4H Range breakout candidate queued for confirmed fire",
      );
    }
  }
  let _priorityTickerCount = 0;
  while (
    _priorityTickerCount < usdtTickers.length &&
    (persistedNeonSupportEvents.has(
      usdtTickers[_priorityTickerCount]!.symbol,
    ) ||
      activeRangeArmSymbols.has(usdtTickers[_priorityTickerCount]!.symbol))
  ) {
    _priorityTickerCount++;
  }
  await runConcurrent(
    usdtTickers.slice(0, _priorityTickerCount),
    4,
    processTicker,
  );
  if (_priorityTickerCount > 0 || candidates.length > 0)
    await runCandidateBatch();
  await runConcurrent(
    usdtTickers.slice(_priorityTickerCount),
    4,
    processTicker,
  );

  {
    const sorted = [..._loopSymbolTimes].sort((a, b) => a.ms - b.ms);
    const total = sorted.reduce((a, r) => a + r.ms, 0);
    logger.info(
      {
        loopWallMs: Date.now() - _loopStartedAt,
        symbols: sorted.length,
        meanMs: sorted.length ? Math.round(total / sorted.length) : 0,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)]?.ms ?? 0,
        p90Ms: sorted[Math.floor(sorted.length * 0.9)]?.ms ?? 0,
        slowest: sorted.slice(-8).map((r) => `${r.symbol}:${r.ms}`),
      },
      "⏱ Symbol loop timing",
    );
  }

  // Log top-5 by volume among those that passed CoinGlass OI filter
  const top5 = [...debugTop].sort((a, b) => b.vol - a.vol).slice(0, 5);
  if (top5.length > 0) {
    logger.info(
      {
        top5: top5.map((d) => ({
          symbol: d.symbol,
          vol: d.vol.toFixed(1) + "x",
          globalOI: d.cgOI != null ? d.cgOI.toFixed(1) + "%" : "n/a",
          price: d.price.toFixed(2) + "%",
        })),
      },
      "Top-5 (CoinGlass OI passed) by volume this cycle",
    );
  }

  logger.info(
    {
      oi: {
        t30: oiPassCount.t30,
        t1h: oiPassCount.t1h,
        t4h: oiPassCount.t4h,
        t24h: oiPassCount.t24h,
        anyPass: oiPassCount.anyOiPass,
      },
      skip: {
        exhaustedByTicker: lastLayerDebug.exhaustedByTicker,
        exhaustedPump: skipCount.exhaustedPump,
        deepNeg: skipCount.deepNegative,
        noOiNoVol: skipCount.noOiNoVol,
        lowVol: skipCount.lowVolume,
        stalePump: skipCount.stalePump,
        cooldown: skipCount.cooldown,
        noConfirming: skipCount.noConfirming,
        priceTooHigh: skipCount.priceTooHigh,
        cvdFail: skipCount.cvdFail,
        takerFail: skipCount.takerFail,
        spotFail: skipCount.spotFailLow + skipCount.spotFailNoData,
        contra: skipCount.contraSignal,
        wiObBear: skipCount.wiObBear,
        other: skipCount.other,
      },
      candidates: candidates.length,
    },
    "📊 SCAN SUMMARY: OI пороги + причины пропуска",
  );

  if (gateRejectLog.length > 0) {
    // Сортировка: cvdFail (прошли OI+vol, заблокированы CVD) → contra → stalePump → deepNeg
    const gateOrder: Record<string, number> = {
      cvdFail: 0,
      contra: 1,
      stalePump: 2,
      deepNeg: 3,
    };
    gateRejectLog.sort(
      (a, b) => (gateOrder[a.gate] ?? 9) - (gateOrder[b.gate] ?? 9),
    );
    // Группируем по gate для удобного чтения
    const byGate: Record<string, typeof gateRejectLog> = {};
    for (const e of gateRejectLog) {
      (byGate[e.gate] ??= []).push(e);
    }
    const summary = Object.fromEntries(
      Object.entries(byGate).map(([g, arr]) => [
        g,
        arr.map((e) => `${e.sym}(${e.oi30m},${e.vol},${e.extra})`),
      ]),
    );
    logger.info(
      { count: gateRejectLog.length, byGate: summary },
      "📋 GATE REJECT LOG: токены с сигналом заблокированные гейтом",
    );
  }

  const _phase2Ms = Date.now() - _phase2StartMs;
  logger.info(
    {
      confirmingMapSize: confirmingWatchMap.size,
      confirmingMapSymbols: [...confirmingWatchMap.keys()],
      candidatesCount: candidates.length,
      skipped: skipCount,
      phase2Ms: _phase2Ms,
      phase2OverrunMin:
        _phase2Ms > 10 * 60_000 ? +(_phase2Ms / 60_000).toFixed(1) : undefined,
    },
    "DEBUG: scan cycle snapshot",
  );

  // ── Analytics telemetry: capture rows synchronously, enqueue for deferred write ─
  // enqueuePrescanHistory / enqueuePrescanSnapshots snapshot prescanTracker *right now*
  // (before the next scan can mutate it) and push the captured rows into the
  // _telemetryQueue.  The single-flight writer drains the queue independently of the
  // fence — rows are never lost even when canScheduleScanEndWork=false (fence timeout).
  {
    const historyCount = await enqueuePrescanHistory(scored);
    const snapshotCount = await enqueuePrescanSnapshots();
    logger.info(
      {
        historyEnqueued: historyCount,
        snapshotsEnqueued: snapshotCount,
        queueDepth: _telemetryQueue.depth,
        writerActive: _telemetryQueue.isActive,
      },
      "Telemetry enqueued for deferred write",
    );
  }

  // ── Scan-end background work — fenced to prevent unbounded cross-scan overlap ─
  // prescanHistory and prescanSnapshots are NOT in this fence — they use the
  // telemetry queue above and are immune to fence timeouts.
  // This fence only covers: savePrescanToDb, batchUpdateWhaleIndex.
  if (canScheduleScanEndWork) {
    _scanEndFence = Promise.all([
      // Сохраняем prescan tracker в DB после Phase 2 чтобы lastOi* (обновлённые в Phase 2)
      // попали в базу. Первый savePrescanToDb() в Phase 1 (строка ~772) сохраняет данные
      // прошлого цикла — этот вызов перезаписывает свежими OI значениями.
      savePrescanToDb().catch((err: unknown) => {
        if (err instanceof SchedulerLeaseLostError) {
          logger.info("savePrescanToDb phase2 save cancelled after lease loss");
        } else {
          logger.warn({ err }, "savePrescanToDb (phase2 end) failed");
        }
      }),
      // Whale Index: батч-фетч per-token WI для OI Watch + топ prescan + активных сигналов
      batchUpdateWhaleIndex().catch((e: unknown) =>
        logger.warn({ err: e }, "batchUpdateWhaleIndex failed"),
      ),
    ]).then(() => undefined);
  }
  // Growth leader log — ОТКЛЮЧЁН (2026-07-18): запись лидеров роста остановлена.

  // CoinGlass load for this cycle. Recorded on every exit path (including the
  // no-candidates cycle, which previously skipped it and left counters pooled).
  const _persistCycleMetrics = (
    cycleDurationMs: number,
    governor: ReturnType<typeof drainCoinglassGovernorTimings>,
  ): void => {
    flushCgTrace();
    void dbWriteBestEffort("coinglass-cycle-metrics", () =>
      recordCoinglassCycleMetrics({
        cycleStartedAt: new Date(startTime),
        durationMs: cycleDurationMs,
        governor,
        oiBreakerTrips: drainCgOiBreakerTrips(),
        phases: {
          ..._cycleMetricPhases,
          phase0Ms: _phase0Ms,
          phase0TimedOut,
          phase1Ms: _phase1Ms,
          loopTiming: drainLoopTiming(),
        },
      }),
    );
  };

  if (candidates.length === 0) {
    const nowNoCandidates = new Date();
    state.lastScanAt = nowNoCandidates;
    state.marketsScanned = usdtTickers.length;
    state.isScanning = false;
    state.lastScanDurationMs = Date.now() - startTime;
    logger.info(
      {
        marketsScanned: usdtTickers.length,
        oiMovers: oiMoversCount,
        topActive: scanLimit,
        skipped: {
          exhaustedByTicker: lastLayerDebug.exhaustedByTicker,
          exhaustedPump: skipCount.exhaustedPump,
          deepNeg: skipCount.deepNegative,
          noOiNoVol: skipCount.noOiNoVol,
          lowVolume: skipCount.lowVolume,
          stalePump: skipCount.stalePump,
          cooldown: skipCount.cooldown,
          noConfirming: skipCount.noConfirming,
          priceTooHigh: skipCount.priceTooHigh,
          cvdFail: skipCount.cvdFail,
          takerFail: skipCount.takerFail,
          spotFailNoData: skipCount.spotFailNoData,
          spotFailLow: skipCount.spotFailLow,
          contra: skipCount.contraSignal,
          other: skipCount.other,
        },
      },
      "No candidates this cycle (CoinGlass OI + Volume filters)",
    );
    // Log pattern debug counters (no-candidates path)
    logger.info(
      { patternDebug: lastPatternDebug },
      "Pattern debug: end-of-scan counters",
    );
    _persistCycleMetrics(
      Date.now() - startTime,
      drainCoinglassGovernorTimings(),
    );
    await persistBaselinesToDb();
    // Completion is committed only by recordScannerSuccess after
    // withMarketCycleLease confirms release; a no-candidates scan is still
    // unsafe to report as successful while the shared lease may be stuck.
    return {
      signalsFound: 0,
      marketsScanned: usdtTickers.length,
      durationMs: Date.now() - startTime,
    };
  }

  await runCandidateBatch();

  // ── Batch expire OI Watch confirming (exhausted pump + deep negative) ─────────
  // Собирались в loop в oiWatchToExpire — теперь один UPDATE вместо N per-symbol await.
  if (oiWatchToExpire.length > 0) {
    void db
      .update(oiWatchTable)
      .set({ status: "expired", firedAt: new Date() })
      .where(
        and(
          inArray(oiWatchTable.symbol, oiWatchToExpire),
          eq(oiWatchTable.status, "confirming"),
        ),
      )
      .catch((err: unknown) =>
        logger.warn(
          { err, count: oiWatchToExpire.length },
          "OI Watch batch expire failed",
        ),
      );
  }

  const totalSignals = alphaResults.length;
  const scanAt = new Date();
  state.lastScanAt = scanAt;
  state.marketsScanned = usdtTickers.length;

  const durationMs = Date.now() - startTime;
  state.isScanning = false;
  state.lastScanDurationMs = durationMs;
  const durationMin = +(durationMs / 60000).toFixed(2);
  const _nfTelemetry = getNetflowTelemetry();
  // Латентность CoinGlass + лаг event loop за окно с прошлого скана:
  // отличаем «CoinGlass медленный» (высокий cgP95 при низком elLag) от
  // «инстанс захлебнулся» (высокий elLagP95 → таймауты внешних API вторичны).
  const _cgTel = snapshotCgTelemetry();
  const _cgGovernorSnap = drainCoinglassGovernorTimings();
  state.lastCgTelemetry = _cgTel;
  logger.info(
    {
      signalsFound: totalSignals,
      alphaCount: alphaResults.filter((r) => r.grade === "alpha").length,
      superAlphaCount: alphaResults.filter((r) => r.grade === "super_alpha")
        .length,
      marketsScanned: usdtTickers.length,
      durationMs,
      durationMin,
      takerBatchHits: _nfTelemetry.hits,
      takerBatchMisses: _nfTelemetry.misses,
      takerBatchSize: _nfTelemetry.batchSize,
      takerBatchHitRate:
        _nfTelemetry.hits + _nfTelemetry.misses > 0
          ? Math.round(
              (_nfTelemetry.hits / (_nfTelemetry.hits + _nfTelemetry.misses)) *
                100,
            ) + "%"
          : "n/a",
      cgReq: _cgTel.cgReq,
      cgReqPerMin: _cgTel.cgReqPerMin,
      cgTimeoutPct: _cgTel.cgTimeoutPct + "%",
      cgErrors: _cgTel.cgErrors,
      cgP50Ms: _cgTel.cgP50Ms,
      cgP95Ms: _cgTel.cgP95Ms,
      cgMaxMs: _cgTel.cgMaxMs,
      elLagP50Ms: _cgTel.elLagP50Ms,
      elLagP95Ms: _cgTel.elLagP95Ms,
      elLagMaxMs: _cgTel.elLagMaxMs,
      cgWindowMin: _cgTel.windowMin,
      requestBudget: getMarketRequestBudgetSnapshot(),
      cgGovernor: _cgGovernorSnap,
    },
    "Scan complete",
  );
  _persistCycleMetrics(durationMs, _cgGovernorSnap);

  // ── Ghost Pump: ОТКЛЮЧЁН ─────────────────────────────────────────────────────
  // Паттерн убран из ростера: слишком поздний вход, движение уже случилось к моменту сигнала.
  // prescanTracker.clear() также убран — он мешал Volume Breakout накапливать cycleCount между циклами.

  // Persist OI baselines to DB every 5 min so restarts don't lose context
  await persistBaselinesToDb();

  // Log pattern debug counters at end of scan (persists in logs regardless of HTTP process)
  const _phase3Ms = _phase3AccumMs;
  logger.info(
    {
      patternDebug: lastPatternDebug,
      spotVolDiag: {
        notInMap: _spotVolDiag.notInMap,
        noAvg: _spotVolDiag.noAvg,
        noLast: _spotVolDiag.noLast,
        hasMult: _spotVolDiag.hasMult,
        total:
          _spotVolDiag.notInMap +
          _spotVolDiag.noAvg +
          _spotVolDiag.noLast +
          _spotVolDiag.hasMult,
        sample: _spotVolDiag.sample,
      },
      phase3Ms: _phase3Ms,
      phase3OverrunMin:
        _phase3Ms > 5 * 60_000 ? +(_phase3Ms / 60_000).toFixed(1) : undefined,
    },
    "Pattern debug: end-of-scan counters",
  );

  // Архетипные паттерны — отдельный лог для видимости даже при сбое DB-записи
  const ARCHETYPE_PATTERNS = ["stealth_breakout", "neon_support_bounce"];
  const archetypeStats = Object.fromEntries(
    ARCHETYPE_PATTERNS.map((p) => [
      p,
      lastPatternDebug[p] ?? { checked: 0, passed: 0, rejectedAt: {} },
    ]),
  );
  logger.info({ archetypeStats }, "Archetype pattern stats this cycle");

  // ── Scan-end background work (second batch) — extend fence to include
  // spot taker + spot vol batch updates.  We update _scanEndFence here so
  // the NEXT scan's fence drain covers ALL background tasks launched this cycle.
  // The phase-2-end fence (prescan/whale) already resolves independently; we
  // chain the new tasks onto whatever remains via Promise.allSettled so the
  // fence is always a settled Promise regardless of individual task failures.
  if (canScheduleScanEndWork) {
    const _spotTakerBatch = (async () => {
      const symbols = Array.from(prescanTracker.keys());
      await runConcurrent(symbols, 4, async (symbol) => {
        const spotTaker = await getSpotTakerFlow(symbol).catch(() => null);
        if (!spotTaker?.available) return;
        const pe = prescanTracker.get(symbol);
        if (!pe) return;
        pe.lastSpotTakerNetBuy = spotTaker.netBuyPct;
        pe.lastSpotTakerDominance = spotTaker.dominance;
        pe.lastSpotTakerExchange = spotTaker.exchange;
      });
    })();

    // Batch spot volume update (fire-and-forget, для дашборда, не блокирует также return)
    const _spotVolBatch = runSpotVolBatch().catch((e: unknown) =>
      logger.warn({ err: e }, "runSpotVolBatch failed"),
    );

    // Extend the scan-end fence to also cover these two batches
    _scanEndFence = Promise.allSettled([
      _scanEndFence,
      _spotTakerBatch,
      _spotVolBatch,
    ]).then(() => undefined);
  } else {
    logger.warn(
      "scan-end background enrichment skipped because the prior fence is still active",
    );
  }

  // The current-cycle PDB snapshot is persisted by performScan's scan-level
  // finally. The next cycle still drains the legacy diagnostic/reject queues
  // before resetting them, preserving their established ordering.

  logger.info(
    {
      phase0Ms: _phase0Ms,
      phase0TimedOut,
      phase1Ms: _phase1Ms,
      phase2Ms: _phase2Ms,
      phase3Ms: _phase3Ms,
      totalMs: durationMs,
    },
    "⏱ Scan phase timing summary",
  );

  return {
    signalsFound: totalSignals,
    marketsScanned: usdtTickers.length,
    durationMs,
  };
}

/**
 * Вычисляет задержку до следующего выровненного интервала скана.
 * Например, при интервале 30 мин и текущем времени HH:17:xx →
 * следующий скан будет ровно в HH:30:00 (+ 2с), а не HH:17+30=HH:47.
 * Это устраняет drift: каждый скан попадает в начало 30-минутной свечи.
 */
function msUntilNextBoundary(intervalMs: number): number {
  const now = Date.now();
  const msSinceEpoch = now % intervalMs;
  const msToNext = intervalMs - msSinceEpoch;
  // Добавляем 2 секунды, чтобы гарантированно попасть в новую свечу
  return msToNext + 2000;
}

export async function runScannerCycle(
  options: {
    signal?: AbortSignal;
  } = {},
): Promise<{
  signalsFound: number;
  marketsScanned: number;
  durationMs: number;
} | null> {
  scannerLeaseAcquireInFlight = true;
  let lease;
  try {
    lease = await withSchedulerLease(
      DISCOVERY_SCANNER_LEASE,
      "scanner",
      async (context) => {
        context.throwIfLost("scanner cycle start");
        try {
          const repaired = await reconcileDeliveredSignalsMissingTracker();
          if (repaired > 0) {
            logger.warn(
              { repaired },
              "Recovered delivered signals missing tracker positions",
            );
          }
        } catch (err) {
          // The main scan must still run. A transient repair failure is retried
          // by the next lease owner and cannot create a second tracker row.
          logger.warn(
            { err },
            "Delivered signal tracker reconciliation deferred",
          );
        }
        return await performScan(context);
      },
      {
        ...options,
        ttlMs: DISCOVERY_SCANNER_LEASE_TTL_MS,
        heartbeatMs: DISCOVERY_SCANNER_LEASE_HEARTBEAT_MS,
        releaseTimeoutMs: DISCOVERY_SCANNER_LEASE_RELEASE_TIMEOUT_MS,
        onLeaseLost: (loss) => {
          // The lease context has already aborted all guarded scanner work.
          // Do not crash-loop the worker for one transient scheduler socket
          // failure: scheduledScan only retries after this cycle fully settles.
          recordScannerFailure("lease_lost");
          logger.warn(
            { reason: loss.reason },
            "Discovery lease lost; guarded scanner work cancelled and recovery will retry after settlement",
          );
        },
      },
    );
  } finally {
    scannerLeaseAcquireInFlight = false;
  }
  if (!lease.acquired) return null;
  // Do not advance the durable completion cursor until the shared lease is
  // released. A release timeout means the next scanner cannot yet be trusted
  // to start, even though the work body reached its end.
  recordScannerSuccess(new Date(), lease.value.durationMs);
  return lease.value;
}

async function scheduledScan() {
  if (!state.running) return;
  const scheduledScanStartedAtMs = Date.now();
  if (scannerCycleSettlementFence.isPending()) {
    logger.warn(
      "Scanner recovery deferred until the previous timed-out cycle settles",
    );
    scheduleScannerRetry(
      state.scannerFailureReason ?? "settlement_fence_pending",
      state.scannerLeaseExpectedExpiryAt,
    );
    return;
  }
  // Replays a failure record that could not be persisted while Neon was down.
  void flushScannerRecoveryState();
  let coinglassOutage = false;
  let scannerLeaseBusy = false;
  // Hard limit: если performScan завис (TCP-зависание BingX/Neon без RST/FIN),
  // Promise никогда не резолвится и finally никогда не запускается →
  // reschedule не вызывается, следующий скан не запускается, watchdog кричит 80+ мин.
  // Race с 28-мин таймером гарантирует, что scheduledScan ВСЕГДА завершается,
  // finally сбрасывает isScanning и reschedule запускает следующий цикл.
  // 28 мин < WATCHDOG_WARN_MS (35 мин idle) — после reset watchdog не сработает сразу.
  const _SCAN_HARD_LIMIT_MS = 28 * 60 * 1000;
  const cycleAbort = createScannerCycleAbort();
  activeScanAbortController = cycleAbort.controller;
  let hardTimedOut = false;
  let cycle: Promise<unknown> | null = null;
  try {
    cycle = runScannerCycle({ signal: cycleAbort.signal });
    const scanResult = await Promise.race([
      cycle,
      new Promise<never>((_, reject) => {
        cycleAbort.armHardTimeout(_SCAN_HARD_LIMIT_MS, (error) => {
          hardTimedOut = true;
          // This reaches the lease and the network clients. Promise.race still
          // protects the scheduler from non-cancellable DB connects.
          reject(error);
        });
      }),
    ]);
    scannerLeaseBusy = scanResult === null;
    if (scannerLeaseBusy) {
      recordScannerFailure("lease_busy");
      logger.info(
        { retryInMs: SCANNER_LEASE_RETRY_MS },
        "Scanner deferred by another market-cycle owner; retrying soon",
      );
    }
  } catch (err) {
    if (err instanceof CoinglassOutageError) {
      coinglassOutage = true;
      logger.warn(
        { skipped: err.skipped },
        "Скан отменён: CoinGlass недоступен — повтор через 5 мин",
      );
      try {
        const outageCooldown = new Date(Date.now() - 10 * 60 * 1000);
        const claimed = await dbWriteBestEffort(
          "cgOutage-settingsUpdate",
          () =>
            db
              .update(settingsTable)
              .set({ lastCoinglassOutageAt: new Date() })
              .where(
                sql`id = (SELECT id FROM settings LIMIT 1) AND (last_coinglass_outage_at IS NULL OR last_coinglass_outage_at < ${outageCooldown})`,
              )
              .returning({ id: settingsTable.id }),
          { perAttemptTimeoutMs: 4000, attempts: 1 },
        );
        if (claimed && claimed.length > 0) {
          await broadcastRawAlert(
            `⚠️ CoinGlass API недоступен — скан отменён, повтор через 5 мин`,
          );
        }
      } catch {
        /* Telegram сбой не критичен */
      }
    } else if (hardTimedOut) {
      // The deadline now actively cancels work through the lease and transport
      // layer. A non-cancellable database connect may still unwind later, but
      // it no longer starts new symbols or external requests.
      logger.error(
        {
          stuckMs: _SCAN_HARD_LIMIT_MS,
          requestBudget: getMarketRequestBudgetSnapshot(),
        },
        "⏱ SCAN_HARD_TIMEOUT: scan cancelled; next cycle will start without stale network work",
      );
      recordScannerFailure("scan_hard_timeout");
      // The outer timeout cannot wait for a non-cancellable DB cleanup. If
      // cleanup later reports release uncertainty, it supersedes this generic
      // timeout with the lease's expected expiry.
      if (cycle) observeLateLeaseRelease(cycle, "scheduled");
      if (cycle) fenceTimedOutCycle(cycle);
    } else if (err instanceof SchedulerLeaseAcquireError) {
      recordScannerFailure("lease_control_plane_unavailable");
      logger.warn(
        { err },
        "Discovery scanner could not contact the lease control-plane; optional DB work remains deferred while recovery retries",
      );
    } else if (err instanceof SchedulerLeaseLostError) {
      // The persisted row can remain until its TTL if the same DB incident also
      // blocked release(). Keep retrying every minute rather than forfeiting a
      // whole 30-minute candle after that stale lease expires.
      scannerLeaseBusy = true;
      recordScannerFailure("lease_lost");
      logger.error(
        { err, retryInMs: SCANNER_LEASE_RETRY_MS },
        "Scanner aborted after market-cycle lease loss; retrying when the lease is free",
      );
    } else if (err instanceof SchedulerLeaseReleaseError) {
      scannerLeaseBusy = true;
      recordScannerFailure("lease_release_failed", err.expectedExpiryAt);
      logger.error(
        {
          err,
          retryInMs: SCANNER_LEASE_RETRY_MS,
          expectedLeaseExpiryAt: err.expectedExpiryAt,
        },
        "Scanner completed work but lease release is uncertain; retrying after TTL recovery",
      );
    } else {
      recordScannerFailure("scheduled_scan_error");
      logger.error({ err }, "Scheduled scan error");
    }
  } finally {
    cycleAbort.dispose();
    if (activeScanAbortController === cycleAbort.controller) {
      activeScanAbortController = null;
    }
    // Safety net: если performScan кинул необработанный exception, isScanning
    // могло остаться true — watchdog через 70 мин бил бы тревогу вечно.
    if (state.isScanning) {
      state.isScanning = false;
      state.lastScanAt = state.lastSuccessfulScanAt;
      logger.warn(
        "scheduledScan: isScanning stuck after performScan — force-reset",
      );
    }
  }
  // Reschedule ALWAYS — even if getSettings() fails (DB hiccup).
  // Without this guard the scan loop dies silently on any transient DB error.
  if (state.running) {
    if (scannerLeaseBusy) {
      // Discovery ownership is independent from background market jobs. A
      // retry here only waits for another scanner worker or this scanner's
      // own release recovery, never a watcher/heatmap lease.
      scheduleScannerRetry(
        state.scannerFailureReason === "lease_release_failed"
          ? "lease_release_failed"
          : state.scannerFailureReason === "lease_lost"
            ? "lease_lost"
            : "lease_busy",
        state.scannerLeaseExpectedExpiryAt,
      );
    } else if (coinglassOutage) {
      // CoinGlass down: retry in 5 min instead of normal interval
      const retryMs = 5 * 60 * 1000;
      state.nextScanAt = new Date(Date.now() + retryMs);
      scanTimer = setTimeout(scheduledScan, retryMs);
      logger.info(
        { nextScanIn: "5m", nextScanAt: state.nextScanAt },
        "Retry scan scheduled (CoinGlass outage)",
      );
    } else {
      if (state.scannerFailureReason) {
        scheduleScannerRetry(state.scannerFailureReason);
        return;
      }
      try {
        const settings = await getSettings();
        state.scanIntervalMs = settings.scanIntervalMs;
      } catch (err) {
        logger.warn(
          { err },
          "Failed to load settings for reschedule — keeping current interval",
        );
      }
      // Цикл закончился позже конца своего слота (:00/:30) — следующий
      // запускаем сразу, а не ждём ещё один слот.
      const _slotEndMs =
        (Math.floor(scheduledScanStartedAtMs / state.scanIntervalMs) + 1) *
        state.scanIntervalMs;
      const delay =
        Date.now() >= _slotEndMs
          ? 1000
          : msUntilNextBoundary(state.scanIntervalMs);
      state.nextScanAt = new Date(Date.now() + delay);
      scanTimer = setTimeout(scheduledScan, delay);
      logger.info(
        {
          nextScanIn: `${Math.round(delay / 1000)}s`,
          nextScanAt: state.nextScanAt,
        },
        "Next scan scheduled",
      );
    }
  }
}

export async function startScanner(): Promise<void> {
  if (state.running) return;
  state.running = true;
  if (STEALTH_R4H_LIVE && !stealthRange4hTimer) {
    stealthRange4hTimer = setInterval(() => {
      void runStealthRange4h();
    }, 30_000);
    stealthRange4hTimer.unref();
  }
  if (STEALTH_FH_LIVE && !stealthFreshHighTimer) {
    stealthFreshHighTimer = setInterval(() => {
      void runStealthFreshHighHour();
    }, 30_000);
    stealthFreshHighTimer.unref();
  }
  logger.info("AltBullet Scanner started (15m TF, 30m OI, multi-pattern)");

  // A watchdog restart stays in the same process. Do not let it bypass the
  // fence left by an abort-ignoring old cycle after its DB lease has expired.
  if (scannerCycleSettlementFence.isPending()) {
    logger.warn(
      "Scanner startup deferred until the previous timed-out cycle settles",
    );
    scheduleScannerRetry(
      state.scannerFailureReason ?? "settlement_fence_pending",
      state.scannerLeaseExpectedExpiryAt,
    );
    return;
  }

  let firstScanDelay: number;
  let firstScanFailure: ScannerFailureReason | null = null;
  try {
    state.bingxConnected = await testBingX();
    state.telegramConnected = await testTelegram();

    // Restore persisted scanner context before the first cycle. If a transient
    // database outage blocks this, the scheduled retry can still acquire the
    // lease and run; it must not leave state.running without a timer.
    await loadBaselinesFromDb();
    await loadPrescanFromDb();
    const settings = await getSettings();
    state.scanIntervalMs = settings.scanIntervalMs;

    const initialAbort = createScannerCycleAbort();
    activeScanAbortController = initialAbort.controller;
    const initialCycle = runScannerCycle({ signal: initialAbort.signal });
    let initialTimedOut = false;
    const initialScan = await Promise.race([
      initialCycle,
      new Promise<null>((resolve) => {
        initialAbort.armHardTimeout(28 * 60 * 1000, () => {
          initialTimedOut = true;
          logger.error(
            "Initial scanner cycle exceeded 28 min and was cancelled",
          );
          resolve(null);
        });
      }),
    ]).finally(() => {
      initialAbort.dispose();
      if (activeScanAbortController === initialAbort.controller) {
        activeScanAbortController = null;
      }
    });
    if (initialScan) {
      firstScanDelay = msUntilNextBoundary(settings.scanIntervalMs);
    } else {
      firstScanDelay = 60_000;
      firstScanFailure = initialTimedOut ? "scan_hard_timeout" : "lease_busy";
      recordScannerFailure(firstScanFailure);
      logger.info(
        { retryInMs: firstScanDelay },
        "Initial scan skipped because another worker owns the lease; retrying soon",
      );
      if (initialTimedOut) observeLateLeaseRelease(initialCycle, "startup");
      if (initialTimedOut) fenceTimedOutCycle(initialCycle);
    }
  } catch (err) {
    if (err instanceof CoinglassOutageError) {
      logger.warn(
        { skipped: err.skipped },
        "Первый скан отменён: CoinGlass недоступен — повтор через 5 мин",
      );
      try {
        const outageCooldown = new Date(Date.now() - 10 * 60 * 1000);
        const claimed = await dbWriteBestEffort(
          "cgOutage-settingsUpdate-first",
          () =>
            db
              .update(settingsTable)
              .set({ lastCoinglassOutageAt: new Date() })
              .where(
                sql`id = (SELECT id FROM settings LIMIT 1) AND (last_coinglass_outage_at IS NULL OR last_coinglass_outage_at < ${outageCooldown})`,
              )
              .returning({ id: settingsTable.id }),
          { perAttemptTimeoutMs: 4000, attempts: 1 },
        );
        if (claimed && claimed.length > 0) {
          await broadcastRawAlert(
            `⚠️ CoinGlass API недоступен — скан отменён, повтор через 5 мин`,
          );
        }
      } catch {
        /* Telegram сбой не критичен */
      }
      firstScanDelay = 5 * 60 * 1000;
    } else if (err instanceof SchedulerLeaseReleaseError) {
      firstScanFailure = "lease_release_failed";
      recordScannerFailure(firstScanFailure, err.expectedExpiryAt);
      firstScanDelay = scannerRetryDelay(firstScanFailure);
      logger.error(
        {
          err,
          retryInMs: firstScanDelay,
          expectedLeaseExpiryAt: err.expectedExpiryAt,
        },
        "Initial scanner cycle lease release is uncertain; recovery retry scheduled",
      );
    } else if (err instanceof SchedulerLeaseAcquireError) {
      firstScanFailure = "lease_control_plane_unavailable";
      recordScannerFailure(firstScanFailure);
      firstScanDelay = scannerRetryDelay(firstScanFailure);
      logger.warn(
        { err, retryInMs: firstScanDelay },
        "Initial scanner lease control-plane unavailable; retrying without starting optional background work",
      );
    } else if (err instanceof SchedulerLeaseLostError) {
      firstScanFailure = "startup_lease_lost";
      recordScannerFailure(firstScanFailure);
      firstScanDelay = scannerRetryDelay("lease_lost");
      logger.error(
        { err, retryInMs: firstScanDelay },
        "Initial scanner cycle lost its lease; recovery retry scheduled",
      );
    } else {
      firstScanFailure = "startup_db_or_transport_error";
      recordScannerFailure(firstScanFailure);
      firstScanDelay = scannerRetryDelay(firstScanFailure);
      logger.error(
        { err, retryInMs: firstScanDelay },
        "Scanner startup failed; recovery retry scheduled",
      );
    }
  }

  state.nextScanAt = new Date(Date.now() + firstScanDelay);
  scanTimer = setTimeout(scheduledScan, firstScanDelay);
  logger.info(
    {
      nextScanIn: `${Math.round(firstScanDelay / 1000)}s`,
      nextScanAt: state.nextScanAt,
      reason: firstScanFailure,
    },
    "Next scan scheduled",
  );

  // ── SpotVol periodic timer: 3 быстрых прогрева (t=2/5/8 мин), затем каждые 60 мин ──
  // Прогрев нужен чтобы spotVolCycles≥3 (VBS_MIN_CYCLES) набралось до первого скана
  // (~10-14 мин). После 3 запусков большинство токенов переходят порог и VBS начинает работать.
  // prescanTracker уже загружен из DB к этому моменту.
  void (async () => {
    for (const delayMs of [2 * 60_000, 3 * 60_000, 3 * 60_000]) {
      await new Promise((r) => setTimeout(r, delayMs));
      if (!state.running) return;
      try {
        if (prescanTracker.size > 0) await runSpotVolBatch();
      } catch (err) {
        logger.warn({ err }, "SpotVol warmup: ошибка");
      }
    }
    while (state.running) {
      await new Promise((r) => setTimeout(r, 60 * 60 * 1000));
      try {
        if (prescanTracker.size > 0) await runSpotVolBatch();
      } catch (err) {
        logger.warn({ err }, "SpotVol periodic: ошибка");
      }
    }
  })();

  // ── SpotVol DB resync timer: каждые 5 мин, независимо от батча выше ──
  // Fix для split-brain между инстансами (autoscale — 1-N процессов одновременно,
  // каждый со своей копией prescanTracker в памяти). Подтягивает уже накопленные
  // другими инстансами spotVolAvg1h/spotVolCycles, не трогая своё более свежее состояние.
  void (async () => {
    await new Promise((r) => setTimeout(r, 60 * 1000));
    while (state.running) {
      try {
        if (prescanTracker.size > 0) await refreshSpotVolFromDb();
      } catch (err) {
        logger.warn({ err }, "SpotVol DB resync periodic: ошибка");
      }
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
    }
  })();

  // ── lastScanAt heartbeat: записывает in-memory state в DB каждые 3 мин ───
  // Основная запись fire-and-forget внутри скана падает при Neon pool saturation.
  // Этот таймер работает независимо — status endpoint на Worker B видит свежее время.
  // Также пишет scannerScanStartedAt чтобы Worker B мог вывести isScanning кросс-процессно.
  if (autoRangeBackgroundWarmupTimer)
    clearInterval(autoRangeBackgroundWarmupTimer);
  autoRangeBackgroundWarmupTimer = setInterval(
    () => void runAutoRangeBackgroundWarmup(),
    45_000,
  );
  if (lastScanHeartbeatTimer) clearInterval(lastScanHeartbeatTimer);
  lastScanHeartbeatTimer = setInterval(
    () => {
      if (state.isScanning) {
        if (!state.lastScanAt) return;
        // Keep the completion timestamp untouched while a scan is active:
        // Worker B infers activity from scannerScanStartedAt > scannerLastScanAt.
        // Writing the same start time into both fields made an active remote
        // scan look idle to dashboards and the watchdog.
        const startedAt = state.lastScanAt;
        void dbWriteBestEffort(
          "lastScanAt heartbeat (scanning)",
          () =>
            db.update(settingsTable).set({ scannerScanStartedAt: startedAt }),
          { attempts: 1 },
        );
      } else {
        // Do not turn a failed cycle's start time into a successful completion.
        // The last successful cursor advances only after release succeeds.
        const completedAt = state.lastSuccessfulScanAt;
        if (!completedAt) return;
        void dbWriteBestEffort(
          "lastScanAt heartbeat (idle)",
          () =>
            db.update(settingsTable).set({
              scannerLastScanAt: completedAt,
              scannerLastScanDurationMs: state.lastScanDurationMs,
            }),
          { attempts: 1 },
        );
      }
    },
    3 * 60 * 1000,
  );
}

export async function stopScanner(): Promise<void> {
  state.running = false;
  if (stealthRange4hTimer) {
    clearInterval(stealthRange4hTimer);
    stealthRange4hTimer = null;
  }
  if (stealthFreshHighTimer) {
    clearInterval(stealthFreshHighTimer);
    stealthFreshHighTimer = null;
  }
  state.nextScanAt = null;
  if (activeScanAbortController && !activeScanAbortController.signal.aborted) {
    activeScanAbortController.abort(
      new Error("Scanner stopped; cancelling active cycle"),
    );
  }
  activeScanAbortController = null;
  if (scanTimer) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  scannerRecoveryScheduler.cancelPending();
  if (autoRangeBackgroundWarmupTimer) {
    clearInterval(autoRangeBackgroundWarmupTimer);
    autoRangeBackgroundWarmupTimer = null;
  }
  if (lastScanHeartbeatTimer) {
    clearInterval(lastScanHeartbeatTimer);
    lastScanHeartbeatTimer = null;
  }
  logger.info("Scanner stopped");
}

/** Синхронная проверка — идёт ли скан прямо сейчас. Используется для паузы фоновых джобов. */
export function isScannerActive(): boolean {
  return state.isScanning || scannerCycleSettlementFence.isPending();
}

export type ScannerDbAdmissionBlocker =
  | "lease-acquisition"
  | "scanner-active"
  | "lease-control-plane-recovery";

/**
 * Optional jobs use this local signal in addition to pool metrics and their
 * durable market-cycle checks. It gives discovery a quiet application-pool
 * window while it is acquiring/recovering its independent scheduler lease.
 */
export function getScannerDbAdmissionBlocker(): ScannerDbAdmissionBlocker | null {
  if (scannerLeaseAcquireInFlight) return "lease-acquisition";
  if (isScannerActive()) return "scanner-active";
  return state.scannerFailureReason === "lease_control_plane_unavailable"
    ? "lease-control-plane-recovery"
    : null;
}

export async function getScannerState(): Promise<
  ScannerState & { totalSignals: number; signalsToday: number }
> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalResult, todayResult, settingsRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(signalsTable)
      .then((r) => r[0]),
    db
      .select({ count: sql<number>`count(*)` })
      .from(signalsTable)
      .where(gte(signalsTable.detectedAt, today))
      .then((r) => r[0]),
    db
      .select({
        scannerLastScanAt: settingsTable.scannerLastScanAt,
        scannerScanStartedAt: settingsTable.scannerScanStartedAt,
        scannerLastScanDurationMs: settingsTable.scannerLastScanDurationMs,
        scanIntervalMs: settingsTable.scanIntervalMs,
      })
      .from(settingsTable)
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);

  // Cross-process fallback: use a newer persisted scanner state when this
  // worker has not scanned recently. Autoscaled workers otherwise retain a
  // stale local timestamp after another worker takes the scanner lease.
  let effectiveLastScanAt = state.isScanning
    ? state.lastScanAt
    : state.lastSuccessfulScanAt;
  let effectiveLastScanDurationMs = state.lastScanDurationMs;
  let effectiveScanStartedAt = state.scanStartedAt;
  let effectiveRunning = state.running;
  let effectiveIsScanning =
    state.isScanning || scannerCycleSettlementFence.isPending();
  const intervalMs = settingsRow?.scanIntervalMs ?? state.scanIntervalMs;

  const persistedLastScanAt = settingsRow?.scannerLastScanAt ?? null;
  const persistedStartedAt = settingsRow?.scannerScanStartedAt ?? null;
  const persistedLastScanDurationMs =
    settingsRow?.scannerLastScanDurationMs ?? null;
  const persistedIsScanning =
    persistedStartedAt !== null &&
    (persistedLastScanAt === null || persistedStartedAt > persistedLastScanAt);
  const persistedAnchor = persistedIsScanning
    ? persistedStartedAt
    : persistedLastScanAt;
  const localTimestamp = effectiveLastScanAt?.getTime() ?? 0;

  if (persistedAnchor && persistedAnchor.getTime() > localTimestamp) {
    effectiveLastScanAt = persistedAnchor;
    // Infer running: scanner is alive if last scan was within 2.5× the interval
    const ageMs = Date.now() - persistedAnchor.getTime();
    effectiveRunning = ageMs < intervalMs * 2.5;
    effectiveIsScanning = persistedIsScanning;
  }
  if (
    persistedStartedAt &&
    (!effectiveScanStartedAt ||
      persistedStartedAt.getTime() > effectiveScanStartedAt.getTime())
  ) {
    effectiveScanStartedAt = persistedStartedAt;
  }
  const localCompletionTime = state.lastSuccessfulScanAt?.getTime() ?? 0;
  if (
    persistedLastScanDurationMs != null &&
    persistedLastScanAt != null &&
    persistedLastScanAt.getTime() >= localCompletionTime
  ) {
    effectiveLastScanDurationMs = persistedLastScanDurationMs;
  }

  return {
    ...state,
    lastScanAt: effectiveLastScanAt,
    scanStartedAt: effectiveScanStartedAt,
    lastScanDurationMs: effectiveLastScanDurationMs,
    running: effectiveRunning,
    isScanning: effectiveIsScanning,
    scanIntervalMs: intervalMs,
    totalSignals: Number(totalResult?.count ?? 0),
    signalsToday: Number(todayResult?.count ?? 0),
  };
}

/** Synchronous getter — safe to pass as a callback without circular import issues */
export function getLastScanAt(): Date | null {
  return state.lastSuccessfulScanAt;
}

/** Returns true while performScan() is running. Used by watchdog to avoid false alerts. */
export function getIsScanning(): boolean {
  return state.isScanning || scannerCycleSettlementFence.isPending();
}

/**
 * Deliberately local and dependency-free: this is used by the deployment
 * liveness probe precisely when PostgreSQL lease reads are timing out.
 */
export function getScannerLiveness(now = Date.now()): {
  healthy: boolean;
  reason: string | null;
  failedSince: Date | null;
} {
  return resolveScannerLiveness(
    {
      failureReason: state.scannerFailureReason,
      failureAt: state.scannerFailureAt,
      lastSuccessfulScanAt: state.lastSuccessfulScanAt,
      controlPlaneUnavailableSince,
    },
    now,
  );
}

export type ScannerActivityState =
  | {
      kind: "running";
    }
  | {
      kind: "settlement_fence";
      pendingSince: Date | null;
      graceExpiresAt: Date | null;
      restartRequested: boolean;
    }
  | {
      kind: "idle";
    };

/** Separates real discovery work from an abort-ignoring cycle being fenced. */
export function getScannerActivityState(): ScannerActivityState {
  const fence = scannerCycleSettlementFence.getState();
  if (fence.pending) {
    return {
      kind: "settlement_fence",
      pendingSince: fence.pendingSince,
      graceExpiresAt: fence.graceExpiresAt,
      restartRequested: fence.restartRequested,
    };
  }
  return state.isScanning ? { kind: "running" } : { kind: "idle" };
}

/** Watchdog coordination must inspect the discovery row, never market-cycle. */
export function getDiscoveryScannerLeaseStatus() {
  return getSchedulerLeaseStatus(DISCOVERY_SCANNER_LEASE);
}

export type ScannerRecoveryState = {
  lastSuccessfulScanAt: Date | null;
  failureReason: string | null;
  failureAt: Date | null;
  expectedLeaseExpiryAt: Date | null;
  retryAt: Date | null;
};

/**
 * The watchdog may run in a different API worker, so it reads the durable
 * completion cursor and recovery reason rather than inferring success from a
 * local cycle start timestamp.
 */
export async function getScannerRecoveryState(): Promise<ScannerRecoveryState> {
  try {
    const [row] = await db
      .select({
        scannerLastScanAt: settingsTable.scannerLastScanAt,
        scannerFailureAt: settingsTable.scannerFailureAt,
        scannerFailureReason: settingsTable.scannerFailureReason,
        scannerLeaseExpectedExpiryAt:
          settingsTable.scannerLeaseExpectedExpiryAt,
      })
      .from(settingsTable)
      .limit(1);
    const persistedSuccess = row?.scannerLastScanAt ?? null;
    const localSuccess = state.lastSuccessfulScanAt;
    const lastSuccessfulScanAt =
      persistedSuccess &&
      (!localSuccess || persistedSuccess.getTime() > localSuccess.getTime())
        ? persistedSuccess
        : localSuccess;
    return {
      lastSuccessfulScanAt,
      failureReason: row?.scannerFailureReason ?? state.scannerFailureReason,
      failureAt: row?.scannerFailureAt ?? state.scannerFailureAt,
      expectedLeaseExpiryAt:
        row?.scannerLeaseExpectedExpiryAt ?? state.scannerLeaseExpectedExpiryAt,
      retryAt: state.retryAt,
    };
  } catch (err) {
    logger.warn(
      { err },
      "Scanner recovery DB state unavailable; watchdog will use local control-plane state",
    );
    return {
      lastSuccessfulScanAt: state.lastSuccessfulScanAt,
      failureReason: state.scannerFailureReason,
      failureAt: state.scannerFailureAt,
      expectedLeaseExpiryAt: state.scannerLeaseExpectedExpiryAt,
      retryAt: state.retryAt,
    };
  }
}

export function getLastCycleCandidates() {
  return lastCycleCandidates;
}
export function getLastCycleAt(): number | null {
  return lastCycleAt;
}

/** Возвращает последнюю известную цену символа (prescanTracker → oiWatchPriceCache). */
export function getCachedPrice(symbol: string): number | null {
  return (
    prescanTracker.get(symbol)?.lastPrice ??
    oiWatchPriceCache.get(symbol) ??
    null
  );
}

/** Возвращает true если символ есть в BingX фьючерсах (из последнего скан-цикла). */
export function isBingXFutures(symbol: string): boolean {
  return bingxFuturesSymbols.has(symbol);
}

export interface LiveMarketData {
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  oi24h: number | null;
  cvd15m: boolean | null;
  cvd30m: boolean | null;
  cvd1h: boolean | null;
  cvd4h: boolean | null;
  netBuyPct: number | null;
  price1h: number | null;
  price24h: number | null;
  spotTakerNetBuy: number | null;
  spotTakerDominance: string | null;
  // Дополнительные live-метрики из prescanTracker (обновляются каждый скан-цикл).
  // whaleIndex доступен для токенов в OI Watch + топ prescan.
  whaleIndex: number | null;
  // obRatio не хранится в prescanTracker — всегда null в live.
  // Появится через backfill job (refreshNullEntryMetrics) в течение 30 мин.
  obRatio: number | null;
  /** OI 30m acceleration ratio (lastOi30m / prevOi30m); null if unavailable */
  oiAccel30m: number | null;
  /** Futures vs spot volume ratio (futVolUsd24h / spotVolUsd24h) */
  futSpotRatio: number | null;
}

/**
 * Returns last-known OI and CVD data from the prescan tracker for the given symbols.
 * Data is refreshed every scan cycle (~10 min). Returns only symbols that are currently
 * in the prescan tracker (i.e. were recently in the top-500 by activity score).
 */
/** Последний известный funding rate (raw decimal) из кэша сканера. Null = нет данных. */
export function getLatestFundingRate(symbol: string): number | null {
  return getFreshFundingRate(symbol);
}

export function getPrescanEntry(symbol: string): PrescanEntry | undefined {
  return prescanTracker.get(symbol);
}

/**
 * Сбросить cycleCount токена в prescanTracker до 0 после выстрела сигнала.
 * Без сброса максимальные гейты (cycleCount > 25) навсегда блокируют повторные выстрелы,
 * а колонка «Циклы» в UI показывает время с первого попадания в пул, а не с последнего сигнала.
 */
export function resetPrescanCycleCount(symbol: string): void {
  const pe = prescanTracker.get(symbol);
  if (pe) {
    pe.cycleCount = 0;
    pe.hasFiredBefore = true; // подавляет freshMoverRisk на всех последующих сигналах
  }
}

export function getLiveMarketData(
  symbols: string[],
): Record<string, LiveMarketData> {
  const result: Record<string, LiveMarketData> = {};
  for (const sym of symbols) {
    const e = prescanTracker.get(sym);
    const lk = lastKnownLiveData.get(sym);
    // Приоритет: prescanTracker (свежие данные) → lastKnownLiveData (последние известные)
    if (e) {
      result[sym] = {
        oi30m: e.lastOi30m ?? null,
        oi1h: e.lastOi1h ?? null,
        oi4h: e.lastOi4h ?? null,
        oi24h: e.lastOi24h ?? null,
        cvd15m: e.lastCvd15m ?? null,
        cvd30m: e.lastCvd30m ?? null,
        cvd1h: e.lastCvd1h ?? null,
        cvd4h: e.lastCvd4h ?? null,
        netBuyPct: e.lastNetBuyPct ?? null,
        price1h: e.lastPrice1h ?? null,
        price24h: e.lastPrice24h ?? null,
        spotTakerNetBuy: e.lastSpotTakerNetBuy ?? null,
        spotTakerDominance: e.lastSpotTakerDominance ?? null,
        whaleIndex: e.lastWhaleIndex ?? null,
        obRatio: null,
        oiAccel30m: e.oiAccel30m ?? null,
        futSpotRatio: e.futSpotRatio ?? null,
      };
    } else if (lk) {
      // Символ выпал из prescan (монета остыла), но данные с последнего скана сохранены
      result[sym] = {
        oi30m: lk.oi30m,
        oi1h: lk.oi1h,
        oi4h: lk.oi4h,
        oi24h: lk.oi24h,
        cvd15m: lk.cvd15m ?? null,
        cvd30m: lk.cvd30m,
        cvd1h: lk.cvd1h,
        cvd4h: lk.cvd4h,
        netBuyPct: lk.netBuyPct,
        price1h: lk.price1h,
        price24h: lk.price24h,
        spotTakerNetBuy: lk.spotTakerNetBuy,
        spotTakerDominance: lk.spotTakerDominance,
        whaleIndex: lk.whaleIndex,
        obRatio: null,
        oiAccel30m: null,
        futSpotRatio: null,
      };
    }
  }
  return result;
}

/**
 * Обновляет spot taker данные в live-кэше для конкретного символа.
 * Вызывается из watcher.ts каждый раз когда уже был сделан getSpotTakerFlow запрос,
 * чтобы не делать лишний API-вызов и при этом держать данные свежими для dashboard.
 */
export function updateLiveSpotTaker(
  symbol: string,
  netBuyPct: number | null,
  dominance: "buy" | "sell" | "neutral" | null,
): void {
  const pe = prescanTracker.get(symbol);
  if (pe) {
    pe.lastSpotTakerNetBuy = netBuyPct;
    pe.lastSpotTakerDominance = dominance;
    return;
  }
  const lk = lastKnownLiveData.get(symbol);
  if (lk) {
    lk.spotTakerNetBuy = netBuyPct;
    lk.spotTakerDominance = dominance;
    lk.updatedAt = Date.now();
  } else {
    lastKnownLiveData.set(symbol, {
      oi30m: null,
      oi1h: null,
      oi4h: null,
      oi24h: null,
      cvd15m: null,
      cvd30m: null,
      cvd1h: null,
      cvd4h: null,
      netBuyPct: null,
      price1h: null,
      price24h: null,
      spotTakerNetBuy: netBuyPct,
      spotTakerDominance: dominance,
      whaleIndex: prescanTracker.get(symbol)?.lastWhaleIndex ?? null,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Inject OI/CVD data for a symbol into lastKnownLiveData.
 * Called from background fire cycles (liq_cascade, ob_patterns)
 * so that open positions table shows live-equivalent data even for tokens
 * that are not part of the main prescan batch.
 * Only overwrites fields that are provided (non-undefined); preserves existing values otherwise.
 */
export function injectLiveMarketData(
  symbol: string,
  data: Partial<LiveMarketData>,
): void {
  const ex = lastKnownLiveData.get(symbol);
  lastKnownLiveData.set(symbol, {
    oi30m: data.oi30m !== undefined ? data.oi30m : (ex?.oi30m ?? null),
    oi1h: data.oi1h !== undefined ? data.oi1h : (ex?.oi1h ?? null),
    oi4h: data.oi4h !== undefined ? data.oi4h : (ex?.oi4h ?? null),
    oi24h: data.oi24h !== undefined ? data.oi24h : (ex?.oi24h ?? null),
    cvd15m: data.cvd15m !== undefined ? data.cvd15m : (ex?.cvd15m ?? null),
    cvd30m: data.cvd30m !== undefined ? data.cvd30m : (ex?.cvd30m ?? null),
    cvd1h: data.cvd1h !== undefined ? data.cvd1h : (ex?.cvd1h ?? null),
    cvd4h: data.cvd4h !== undefined ? data.cvd4h : (ex?.cvd4h ?? null),
    netBuyPct:
      data.netBuyPct !== undefined ? data.netBuyPct : (ex?.netBuyPct ?? null),
    price1h: data.price1h !== undefined ? data.price1h : (ex?.price1h ?? null),
    price24h:
      data.price24h !== undefined ? data.price24h : (ex?.price24h ?? null),
    whaleIndex:
      data.whaleIndex !== undefined
        ? data.whaleIndex
        : (ex?.whaleIndex ?? null),
    spotTakerNetBuy:
      data.spotTakerNetBuy !== undefined
        ? data.spotTakerNetBuy
        : (ex?.spotTakerNetBuy ?? null),
    spotTakerDominance:
      data.spotTakerDominance !== undefined
        ? data.spotTakerDominance
        : (ex?.spotTakerDominance ?? null),
    updatedAt: Date.now(),
  });
}

/**
 * Computes exchange listing coverage for a BingX symbol.
 * Uses in-memory sets loaded by refreshBinanceSpotListings + getCgSupportedCoinsSet.
 * Returns null for any field when the underlying data isn't loaded yet.
 */
export function computeTokenCoverage(symbol: string): {
  isBingxExclusive: boolean | null;
  isBinanceSpotListed: boolean | null;
  hasCgFutures: boolean | null;
} {
  const cgFutures = getCgSupportedCoinsSet();
  const base = symbol.replace(/-USDT$/, "").toUpperCase();
  const cgBase = (CG_SYMBOL_ALIAS as Record<string, string>)[base] ?? base;
  return {
    hasCgFutures: cgFutures ? cgFutures.has(cgBase) : null,
    isBinanceSpotListed: isBinanceSpotListed(symbol),
    isBingxExclusive: isBingxExclusive(symbol),
  };
}
/** Returns current scanner candidates: prescan hot list + OI watch queue */
export async function getScannerCandidates(): Promise<{
  prescan: Array<{
    symbol: string;
    cycleCount: number;
    bestRank: number;
    lastPrice24h: number;
    lastPrice: number;
    lastScore: number;
    firstSeenAt: number;
    spotVolCycles?: number | null;
    spotVolMult?: number | null;
    layers: string[];
    lastCvdOk?: boolean | null;
    lastNetBuyPct?: number | null;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
    lastOi24h?: number | null;
    lastPrice1h?: number | null;
    priceMovePct?: number | null;
    lastCvd15m?: boolean | null;
    lastCvd30m?: boolean | null;
    lastCvd1h?: boolean | null;
    lastCvd4h?: boolean | null;
    cgTimedOut?: boolean | null;
    firstPrice?: number | null;
    lastVolMult?: number | null;
    lastSkipReason?: string | null;
    spotVol24h?: number | null;
    spotTakerNetBuy?: number | null;
    spotTakerDominance?: string | null;
    spotTakerExchange?: string | null;
    mcapUsd?: number | null;
    lastAvgVol?: number | null;
    futVolUsd24h?: number | null;
    spotVolUsd24h?: number | null;
    futSpotRatio?: number | null;
    futVolPctMcap?: number | null;
    spotVolPctMcap?: number | null;
    whaleIndex?: number | null;
    oiAccel30m?: number | null;
    isBingxExclusive?: boolean | null;
    isBinanceSpotListed?: boolean | null;
    hasCgFutures?: boolean | null;
  }>;
  oiWatch: Array<{
    id: number;
    symbol: string;
    status: string;
    triggerTf: string;
    oiChange: number;
    priceAtEntry: number;
    currentPrice: number | null;
    volumeMultiplier: number;
    sentimentKey: string | null;
    addedAt: string;
    expiresAt: string;
    oi30m: number | null;
    oi1h: number | null;
    oi24h: number | null;
    price1hChange: number | null;
    price24hChange: number | null;
    currentVolMult: number | null;
    volStatusReason: string | null;
    hasActiveSignal: boolean;
    entryCgTurnover: number | null;
    spotVol24h: number | null;
    spotTakerNetBuy: number | null;
    spotTakerDominance: string | null;
    spotTakerExchange: string | null;
    mcapUsd: number | null;
    entryAvgVol: number | null;
    futureTakerNetBuy: number | null;
    cvd30m: boolean | null;
    cvd1h: boolean | null;
    cvd4h: boolean | null;
    oi4h: number | null;
    whaleIndex: number | null;
    isBingxExclusive: boolean | null;
    isBinanceSpotListed: boolean | null;
    hasCgFutures: boolean | null;
  }>;
  cycleCandidates: Array<{
    symbol: string;
    layers: string[];
    price24h: number;
    price: number;
    score: number;
    cycledAt: number;
    lastOi30m?: number | null;
    lastOi1h?: number | null;
    lastOi4h?: number | null;
    lastOi24h?: number | null;
    lastPrice1h?: number | null;
    lastNetBuyPct?: number | null;
    lastSpotTakerNetBuy?: number | null;
    lastSpotTakerDominance?: string | null;
    lastCvd1h?: boolean | null;
    lastSpotVol1h?: number | null;
    spotVolMult?: number | null;
    whaleIndex?: number | null;
  }>;
  cycleAt: number | null;
}> {
  // Dual-process resilience: prescanTracker is in-memory per-worker.
  // If this worker hasn't scanned yet, fall back to persisted DB rows.
  let prescan: Array<{
    symbol: string;
    cycleCount: number;
    bestRank: number;
    lastPrice24h: number;
    lastPrice: number;
    lastScore: number;
    firstSeenAt: number;
    layers: string[];
    lastCvdOk?: boolean | null;
    lastNetBuyPct?: number | null;
    lastOi4h?: number | null;
    lastOi24h?: number | null;
    lastPrice1h?: number | null;
    priceMovePct?: number | null;
    cgTimedOut?: boolean | null;
    firstPrice?: number | null;
  }>;

  // Fetch active tracked symbols to exclude from prescan display
  const activeTrackedRows = await db
    .select({ symbol: trackedSignalsTable.symbol })
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));
  const activeTrackedSet = new Set(activeTrackedRows.map((r) => r.symbol));

  // ── mcapUsd fallback ────────────────────────────────────────────────────────
  // spotPool (in-memory) обновляется каждые 30 мин, поэтому после рестарта до
  // первого обновления mcapUsd = null. market_cap_cache хранит данные 7 дней —
  // используем как fallback чтобы Спот/MCap% не пропадал после каждого деплоя.
  // Ключ в market_cap_cache — базовый символ без "-USDT" (например, "BTC").
  // Module-level кэш (_mcapDbCache) обновляется раз в 5 мин, не per-request.
  const _mcapNow = Date.now();
  if (_mcapNow - _mcapDbCacheAt > MCAP_DB_CACHE_TTL_MS) {
    const rows = await db
      .select({
        symbol: marketCapCacheTable.symbol,
        mcapUsd: marketCapCacheTable.mcapUsd,
      })
      .from(marketCapCacheTable)
      .where(
        and(
          eq(marketCapCacheTable.source, "coingecko"),
          gte(
            marketCapCacheTable.updatedAt,
            new Date(_mcapNow - 7 * 24 * 3600_000),
          ),
        ),
      )
      .catch(() => [] as { symbol: string; mcapUsd: number | null }[]);
    if (rows.length > 0) {
      _mcapDbCache = new Map(rows.map((r) => [r.symbol, r.mcapUsd]));
      _mcapDbCacheAt = _mcapNow;
    }
  }

  const getMcapUsd = (symbol: string): number | null => {
    const fromPool = getSpotPoolEntry(symbol)?.mcapUsd;
    if (fromPool != null) return fromPool;
    return _mcapDbCache.get(symbol.replace(/-USDT$/, "")) ?? null;
  };

  if (prescanTracker.size > 0) {
    prescan = Array.from(prescanTracker.entries())
      .filter(([symbol]) => !activeTrackedSet.has(symbol))
      .map(([symbol, e]) => ({
        symbol,
        cycleCount: e.cycleCount,
        bestRank: e.bestRank,
        lastPrice24h: e.lastPrice24h,
        lastPrice: e.lastPrice,
        lastScore: e.lastScore,
        firstSeenAt: e.firstSeenAt,
        lastCvdOk: e.lastCvdOk,
        lastNetBuyPct: e.lastNetBuyPct,
        lastOi30m: e.lastOi30m ?? null,
        lastOi1h: e.lastOi1h ?? null,
        lastOi4h: e.lastOi4h ?? null,
        lastOi24h: e.lastOi24h ?? null,
        lastPrice1h: e.lastPrice1h ?? null,
        priceMovePct:
          e.firstPrice > 0
            ? ((e.lastPrice - e.firstPrice) / e.firstPrice) * 100
            : null,
        lastCvd30m: e.lastCvd30m ?? null,
        lastCvd1h: e.lastCvd1h ?? null,
        lastCvd4h: e.lastCvd4h ?? null,
        cgTimedOut: e.lastCgTimedOut ?? null,
        firstPrice: e.firstPrice > 0 ? e.firstPrice : null,
        lastVolMult: e.lastVolMult ?? null,
        lastSkipReason: e.lastSkipReason ?? null,
        lastOiAt: e.lastOiAt ?? null,
        spotVol24h: getSpotPoolEntry(symbol)?.spotVol24h ?? null,
        spotTakerNetBuy: e.lastSpotTakerNetBuy ?? null,
        spotTakerDominance: e.lastSpotTakerDominance ?? null,
        spotTakerExchange: e.lastSpotTakerExchange ?? null,
        mcapUsd: getMcapUsd(symbol),
        lastAvgVol: e.lastAvgVol ?? null,
        spotVolMult:
          e.spotVolAvg1h && e.lastSpotVol1h
            ? e.lastSpotVol1h / e.spotVolAvg1h
            : null,
        prevSpotVolMult:
          e.spotVolAvg1h && e.prevSpotVol1h
            ? e.prevSpotVol1h / e.spotVolAvg1h
            : null,
        spotVolCycles: e.spotVolCycles ?? 0,
        lastSpotNetBuy1h: e.lastSpotNetBuy1h ?? null,
        lastSpotVol1h: e.lastSpotVol1h ?? null,
        lastSpotVol4h: e.lastSpotVol4h ?? null,
        cvd1h: e.lastCvd1h ?? null,
        cvd4h: e.lastCvd4h ?? null,
        layers: e.layers ?? [],
        futVolUsd24h: e.futVolUsd24h ?? null,
        spotVolUsd24h: e.spotVolUsd24h ?? null,
        futSpotRatio: e.futSpotRatio ?? null,
        futVolPctMcap: e.futVolPctMcap ?? null,
        spotVolPctMcap: e.spotVolPctMcap ?? null,
        whaleIndex: e.lastWhaleIndex ?? null,
        oiAccel30m: e.oiAccel30m ?? null,
        ...computeTokenCoverage(symbol),
      }))
      .sort((a, b) => b.lastScore - a.lastScore);
  } else {
    // Fallback: prescanTracker is empty (e.g. loadPrescanFromDb failed).
    // Read directly from DB — persisted CVD/taker fields are available here.
    const read = await dbReadWithRetry(
      "Scanner dashboard prescan fallback",
      () =>
        db
          .select()
          .from(prescanTrackerTable)
          .orderBy(sql`first_score DESC`)
          .limit(200),
      1,
      0,
      4_000,
    );
    if (!read.ok) {
      logger.warn(
        "Scanner dashboard prescan fallback skipped after bounded DB read timeout",
      );
      prescan = [];
    } else {
      const dbRows = read.value;
      prescan = dbRows
        .filter((r) => !activeTrackedSet.has(r.symbol))
        .map((r) => {
          const lp = r.lastPrice ?? r.firstPrice;
          return {
            symbol: r.symbol,
            cycleCount: r.cycleCount,
            bestRank: r.bestRank,
            lastPrice24h: r.lastPrice24h ?? r.firstPrice24h,
            lastPrice: lp,
            lastScore: r.firstScore,
            firstSeenAt: r.firstSeenAt,
            lastCvdOk: null, // derived value, not stored in DB
            lastNetBuyPct: r.lastNetBuyPct ?? null,
            lastOi30m: r.lastOi30m ?? null,
            lastOi1h: r.lastOi1h ?? null,
            lastOi4h: r.lastOi4h ?? null,
            lastOi24h: r.lastOi24h ?? null,
            lastPrice1h: r.lastPrice1h ?? null,
            priceMovePct:
              r.firstPrice > 0 && lp > 0
                ? ((lp - r.firstPrice) / r.firstPrice) * 100
                : null,
            lastCvd30m: r.lastCvd30m ?? null,
            lastCvd1h: r.lastCvd1h ?? null,
            lastCvd4h: r.lastCvd4h ?? null,
            firstPrice: r.firstPrice > 0 ? r.firstPrice : null,
            lastVolMult: null,
            lastSkipReason: null,
            spotVol24h: getSpotPoolEntry(r.symbol)?.spotVol24h ?? null,
            spotTakerNetBuy: r.lastSpotTakerNetBuy ?? null,
            spotTakerDominance:
              (r.lastSpotTakerDominance as "buy" | "sell" | "neutral" | null) ??
              null,
            spotTakerExchange: null, // not persisted in DB
            mcapUsd: getMcapUsd(r.symbol),
            lastAvgVol: null,
            spotVolMult:
              r.spotVolAvg1h && r.lastSpotVol1h
                ? r.lastSpotVol1h / r.spotVolAvg1h
                : null,
            prevSpotVolMult:
              r.spotVolAvg1h && r.prevSpotVol1h
                ? r.prevSpotVol1h / r.spotVolAvg1h
                : null,
            spotVolCycles: r.spotVolCycles ?? 0,
            lastSpotNetBuy1h: r.lastSpotNetBuy1h ?? null,
            lastSpotVol1h: r.lastSpotVol1h ?? null,
            lastSpotVol4h: r.lastSpotVol4h ?? null,
            cvd1h: r.lastCvd1h ?? null,
            cvd4h: r.lastCvd4h ?? null,
            layers: r.layers ?? [],
            futVolUsd24h: r.futVolUsd24h ?? null,
            spotVolUsd24h: r.spotVolUsd24h ?? null,
            futSpotRatio: r.futSpotRatio ?? null,
            futVolPctMcap: r.futVolPctMcap ?? null,
            spotVolPctMcap: r.spotVolPctMcap ?? null,
            whaleIndex: r.lastWhaleIndex ?? null,
            oiAccel30m: r.oiAccel30m ?? null,
            ...computeTokenCoverage(r.symbol),
          };
        });
    }
  }

  const watching = await db
    .select({
      id: oiWatchTable.id,
      symbol: oiWatchTable.symbol,
      status: oiWatchTable.status,
      triggerTf: oiWatchTable.triggerTf,
      oiChange: oiWatchTable.oiChange,
      priceAtEntry: oiWatchTable.priceAtEntry,
      volumeMultiplier: oiWatchTable.volumeMultiplier,
      sentimentKey: oiWatchTable.sentimentKey,
      addedAt: oiWatchTable.addedAt,
      expiresAt: oiWatchTable.expiresAt,
      oi30mChange: oiWatchTable.oi30mChange,
      oi1hChange: oiWatchTable.oi1hChange,
      oi24hChange: oiWatchTable.oi24hChange,
      price1hChange: oiWatchTable.price1hChange,
      price24hChange: oiWatchTable.price24hChange,
      currentVolMult: oiWatchTable.currentVolMult,
      volStatusReason: oiWatchTable.volStatusReason,
      entryCgTurnover: oiWatchTable.entryCgTurnover,
      signalPayload: oiWatchTable.signalPayload,
    })
    .from(oiWatchTable)
    .where(
      and(
        inArray(oiWatchTable.status, ["watching", "confirming"]),
        gt(oiWatchTable.expiresAt, new Date()),
      ),
    )
    .orderBy(oiWatchTable.addedAt);

  const oiWatch = watching.map((r) => {
    // signalPayload stores entry-time snapshot from Loop-2 seeding.
    // Used as fallback when token has dropped out of prescanTracker.
    const _sp = r.signalPayload as {
      entryCvd30m?: boolean | null;
      entryCvd1h?: boolean | null;
      lastSpotTakerNetBuy?: number | null;
      lastNetBuyPct?: number | null;
      alphaResult?: {
        upcomingUnlock?: { daysUntil: number; pctSupply: number } | null;
      };
    } | null;
    const _pe = prescanTracker.get(r.symbol);
    return {
      id: r.id,
      symbol: r.symbol,
      status: r.status,
      triggerTf: r.triggerTf,
      oiChange: r.oiChange,
      priceAtEntry: r.priceAtEntry,
      currentPrice: _pe?.lastPrice ?? oiWatchPriceCache.get(r.symbol) ?? null,
      volumeMultiplier: r.volumeMultiplier,
      sentimentKey: r.sentimentKey ?? null,
      addedAt: r.addedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      oi30m: r.oi30mChange ?? null,
      oi1h: r.oi1hChange ?? null,
      oi24h: r.oi24hChange ?? null,
      price1hChange: r.price1hChange ?? null,
      price24hChange: r.price24hChange ?? null,
      currentVolMult: r.currentVolMult ?? null,
      volStatusReason: r.volStatusReason ?? null,
      hasActiveSignal: activeTrackedSet.has(r.symbol),
      entryCgTurnover: r.entryCgTurnover ?? null,
      spotVol24h: getSpotPoolEntry(r.symbol)?.spotVol24h ?? null,
      spotTakerNetBuy:
        _pe?.lastSpotTakerNetBuy ?? _sp?.lastSpotTakerNetBuy ?? null,
      spotTakerDominance: _pe?.lastSpotTakerDominance ?? null,
      spotTakerExchange: _pe?.lastSpotTakerExchange ?? null,
      mcapUsd: getMcapUsd(r.symbol),
      entryAvgVol: _pe?.lastAvgVol ?? null,
      futureTakerNetBuy: _pe?.lastNetBuyPct ?? _sp?.lastNetBuyPct ?? null,
      // Live prescanTracker CVD data; fallback to signalPayload entry-time snapshot.
      cvd30m: _pe?.lastCvd30m ?? _sp?.entryCvd30m ?? null,
      cvd1h: _pe?.lastCvd1h ?? _sp?.entryCvd1h ?? null,
      cvd4h: _pe?.lastCvd4h ?? null,
      oi4h: _pe?.lastOi4h ?? null,
      oiAccel30m: _pe?.oiAccel30m ?? null,
      futSpotRatio: _pe?.futSpotRatio ?? null,
      upcomingUnlock: _sp?.alphaResult?.upcomingUnlock ?? null,
      whaleIndex: _pe?.lastWhaleIndex ?? null,
      ...computeTokenCoverage(r.symbol),
    };
  });
  return {
    prescan,
    oiWatch,
    cycleCandidates: lastCycleCandidates.map((e) => {
      const pe = prescanTracker.get(e.symbol);
      const spotVolMult =
        pe?.lastSpotVol1h != null &&
        pe?.spotVolAvg1h != null &&
        pe.spotVolAvg1h > 0
          ? pe.lastSpotVol1h / pe.spotVolAvg1h
          : null;
      return {
        ...e,
        lastOi30m: pe?.lastOi30m ?? null,
        lastOi1h: pe?.lastOi1h ?? null,
        lastOi4h: pe?.lastOi4h ?? null,
        lastOi24h: pe?.lastOi24h ?? null,
        lastPrice1h: pe?.lastPrice1h ?? null,
        lastNetBuyPct: pe?.lastNetBuyPct ?? null,
        lastSpotTakerNetBuy: pe?.lastSpotTakerNetBuy ?? null,
        lastSpotTakerDominance: pe?.lastSpotTakerDominance ?? null,
        lastCvd1h: pe?.lastCvd1h ?? null,
        lastSpotVol1h: pe?.lastSpotVol1h ?? null,
        spotVolMult,
        whaleIndex: pe?.lastWhaleIndex ?? null,
        ...computeTokenCoverage(e.symbol),
      };
    }),
    cycleAt: lastCycleAt,
  };
}

/**
 * Пересчитывает price24h для всех токенов в prescanTracker через 1h klines BingX.
 * BingX ticker priceChangePercent считается от открытия СУТОЧНОЙ свечи (UTC midnight),
 * а не от реального момента 24h назад — поэтому токены, выросшие вчера, показывают ~0%.
 * Этот job запускается каждые 20 мин и исправляет lastPrice24h на скользящее значение.
 */
export async function runPrice24hRefreshCycle(): Promise<void> {
  const symbols = Array.from(prescanTracker.keys());
  if (symbols.length === 0) return;

  let updated = 0;
  let failed = 0;

  const CONCURRENCY = 8;
  for (let i = 0; i < symbols.length; i += CONCURRENCY) {
    const batch = symbols.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
          const klines = await getKlines(symbol, "1h", 25);
          if (klines.length < 2) return;

          const price24hAgo = parseFloat(klines[0].open);
          const currentPrice = parseFloat(klines[klines.length - 1].close);

          if (!price24hAgo || !currentPrice || price24hAgo <= 0) return;

          const trueP24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

          const entry = prescanTracker.get(symbol);
          if (entry) {
            entry.lastPrice24h = trueP24h;
            updated++;
          }
        } catch {
          failed++;
        }
      }),
    );
  }

  logger.info(
    { updated, failed, total: symbols.length },
    "Price24h refresh complete (klines rolling 24h)",
  );
}

let stealthSupplementalScanCursor = 0;
