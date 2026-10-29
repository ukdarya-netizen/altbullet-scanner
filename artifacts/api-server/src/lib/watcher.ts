import {
  belowPctOfMcap,
  LC_SMALL_LIQ_1H_PCT_OF_MCAP,
} from "./turnover-threshold.js";
import {
  buildBtcTickerContext,
  parseBtcPrice,
  parseCloseBtc24h,
  type BtcTickerContext,
} from "./btc-ticker-context.js";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import {
  aggregatedVolume24hUsd,
  refreshAggregatedVolume24h,
} from "./coinglass_vol24h.js";
import { runStealthRangeReentries } from "./stealth-range-reentry.js";
import {
  STEALTH_FRESH_HIGH_METHOD,
  resolveFreshHighProtectionLevel,
} from "./stealth-fresh-high.js";
import { maybeRecordStealthHourlySnapshot } from "./stealth-hourly-snapshots.js";
import {
  evaluateLcDetectionCandleGate,
  loadLcDetectionCandle,
  LC_MIN_DETECTION_CANDLE_RANGE_PCT,
} from "./lc-detection-candle-gate.js";
import {
  loadLcDetectionVolume,
  observeLiquidationCandleVolume,
} from "./stealth-volume-gate.js";
import { markTrackerChecked } from "./tracker-heartbeat.js";
import { logger } from "./logger.js";
import { exactStopFill } from "./stop-fill.js";
import {
  classifyTimeoutExit,
  timeoutExitPhotoKind,
} from "./timeout-exit-policy.js";
import { captureTradingSignalAtConfirmation } from "./trading-signal-relay.js";
import { enrollIndicatorTargetCandidatesForTrackedSignal } from "./indicator-target-observations.js";
import { requestedStopDecision } from "./requested-stop-policy.js";
import {
  assertMarketCycleLeaseOwnership,
  runOutsideMarketCycleLease,
  type MarketCycleLeaseContext,
  withMarketCycleLease,
} from "./schedulerLease.js";
import {
  readWatchdogDiscoveryLeaseStatus,
  resolveWatchdogScanState,
  type ScannerWatchdogActivity,
} from "./watchdog-scan-state.js";
import { claimScannerRestartBudget } from "./scanner-restart-budget.js";
import { getOptionalMarketJobDeferral } from "./schedulerBackgroundPolicy.js";
import { runOptionalDbJob } from "./optionalDbAdmission.js";
import {
  db,
  trackedSignalsTable,
  settingsTable,
  oiWatchTable,
  signalsTable,
  oiDailySnapshotsTable,
  marketCapCacheTable,
  prescanSnapshotsTable,
  milestoneNotificationDeliveriesTable,
  subscribersTable,
  dashboardUsersTable,
  subscriptionWarningDeliveriesTable,
  buStopFollowupSnapshotsTable,
  signalTrajectoryLogTable,
  signalDrawdownExtremaTable,
  signalTrailingEventsTable,
  signalTrailingShadowEventsTable,
  signalProfitLockShadowEventsTable,
  reentryShadowEventsTable,
  tradeCalculatorSettingsTable,
  tradeCalculatorMonthlyTable,
  liqCascadeWatchTable,
  lcObWaitTable,
  getDbPoolSnapshot,
} from "@workspace/db";
import { registerProcessHealthSource } from "./process-health.js";
import type {
  TrackedSignal,
  InsertTrackedSignal,
  InsertSignal,
} from "@workspace/db";
import {
  eq,
  and,
  inArray,
  sql,
  lt,
  gte,
  desc,
  gt,
  isNull,
  isNotNull,
  lte,
  or,
} from "drizzle-orm";
import { dbWriteBestEffort, dbWriteStrict } from "./dbWriteFast.js";
import {
  backfillPatternDecisionTrajectories,
  classifyUnfillablePatternDecisionTrajectories,
  reconcilePatternDecisionSnapshots,
  snapshotTrackedDecision,
} from "./pattern-decision-history.js";
import {
  EXCLUDED_SIGNAL_REASON,
  EXCLUDED_SIGNAL_SYMBOLS,
  isSignalSymbolExcluded,
} from "./excluded-signal-symbols.js";
import {
  directionAwarePeak,
  directionAwarePnl,
  isDirectionAwareTrailingHit,
  resolveDirectionAwareTrailingLevel,
  SHADOW_FOLLOW_UPS,
  SHADOW_TRAILING_ACTIVATIONS,
  SHADOW_TRAILING_GAPS,
} from "./trailing-shadow.js";
import {
  isDirectionAwareProfitLockHit,
  PROFIT_LOCK_ACTIVATION_PCT,
  PROFIT_LOCKED_PNL_PCT,
  PROFIT_LOCK_FOLLOW_UPS,
  resolveProfitLockObservationState,
  resolveDirectionAwareProfitLockLevel,
} from "./profit-lock-shadow.js";
import {
  shouldFallbackToTextAfterPhotoFailure,
  shouldRetryExplicitPhotoFailure,
} from "./photo-delivery-policy.js";
import { resolveHealthObservationFlow } from "./health-observation-flow.js";
import {
  drainTelegramPhotoOutbox,
  enqueueTelegramPhotoBroadcast,
  enqueueTelegramPhotoBroadcastAfterClaim,
  enqueueTelegramPhotoClaimPendingRecipientResolution,
  recoverTelegramPhotoRecipientResolution,
  enqueueTelegramTextBroadcast,
  type TelegramPhotoOutboxTransaction,
} from "./telegram-photo-outbox.js";
import { runTelegramPhotoAfterRecipientResolution } from "./telegram-photo-outbox-policy.js";
import {
  claimImpulseRunnerCoreClose,
  claimImpulseRunnerFinalClose,
} from "./impulse-runner-close-db.js";
import {
  formatMarketLinks,
  withoutTradingViewLinks,
} from "./telegram-chart-link.js";
import { telegramReportPlainText } from "./telegram-html.js";
import {
  HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS,
  buildEntryMetricsProvenance,
  buildHistoricalEntryMetricPatch,
} from "./entry-metric-backfill.js";
import {
  DEAD_PATTERN_KEYS,
  isPreservedDecommissionedPattern,
  resolveExplicitOiWatchPattern,
} from "./dead-patterns.js";
import {
  getFutureTickers,
  getFutureTicker,
  getKlines,
  getKlinesRange,
  fetchCVD,
  getFundingRate,
  getOrderBookAnalysis,
  createBingXLastPriceStream,
  type BingXKline,
  type BingXLastPriceStream,
  type BingXLastPriceUpdate,
  type OrderBookAnalysis,
} from "./bingx.js";
import { captureRangeDeviation } from "./range-deviation-capture.js";
import {
  buildEntryVolumeContext,
  type EntryVolumeContext,
} from "./entry-volume-context.js";
import {
  reconcileAltBulletIndicatorSnapshots,
  scheduleAltBulletIndicatorSnapshot,
} from "./altbullet-indicator.js";
import {
  sendMessage,
  sendMessageResult,
  sendPhotoCaptionResult,
  sendPhotoByFileIdResult,
  broadcastBatchAlert,
  broadcastSignalAlert,
  getCanonicalMilestoneTargets,
  getOperationalTelegramRecipientId,
  getTargets,
  type AlphaResult,
} from "./telegram.js";
import {
  buildPendingMilestoneState,
  canRetryPendingMilestone,
  classifyMilestoneSendResult,
  MILESTONE_DELIVERY_LEASE_MS,
  MILESTONE_RETRY_DELAY_MS,
  selectMilestoneRecipientsDueForDispatch,
  selectRemovedMilestoneRecipients,
  shouldFallbackMilestonePhotoToText,
  summarizeMilestoneRecipientStatuses,
  type MilestoneDeliveryOutcome,
  type PendingMilestoneKind,
} from "./milestone-delivery.js";
import {
  claimMilestoneRecipient,
  recordMilestoneRecipientOutcome,
  type MilestoneRecipientOutcomeState,
} from "./milestone-delivery-db.js";
import { getCoinglassOI, getCoinglassOi15mChange } from "./coinglass_oi.js";
import { SPOT_TAKER_SELL_DOMINANCE } from "./scanner-patterns.js";
import { calcLcScore } from "./lc-score.js";
import { getCgAskBids } from "./coinglass_orderbook.js";
import { getCoinglassTakerFlow } from "./coinglass_taker.js";
import { missingAggregatedFireData } from "./aggregated-fire-gate.js";
import { getSpotTakerFlow } from "./coinglass_spot_taker.js";
import {
  registerSnfSymbol,
  getSpotNetflowEntry,
} from "./spot-netflow-cache.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { getFsVolume } from "./coinglass_fs_volume.js";
import { getSpotVolume } from "./coinglass_spot_volume.js";
import {
  calibratePositionHealthMessage,
  classifyPriceConfirmedHealth,
  classifyPositionHealth,
  decideHealthNotification,
  type HealthPriceShadow,
  type PositionHealthState,
} from "./health-alert-policy.js";
import {
  formatMonthlyDigest,
  formatOpenPositionLines,
  formatWeeklyDigest,
  getPreviousDubaiMonthRange,
  loadClosedInPeriod,
} from "./positionsReport.js";
import {
  formatDailyPnlLine,
  getBuStopTakePct,
  getProtectedBuStopExit,
  normalizeClosedPnlPercent,
  summarizeRawPnlPercent,
  summarizePnlWithEstimatedBuStop,
} from "./raw-pnl.js";
import {
  RealtimeTrailingMonitorFence,
  isFreshDurableTrailingStopHit,
  isRealtimeBitcoinBreakevenHit,
  isRealtimeTrailingEventNewer,
  isStartupTrailingStopHit,
  isTrailingStopHit,
  resolveActivatedTrailingStopLevel,
  resolveRealtimeTrailingBoundaryState,
  resolveRealtimeTrailingClose,
  resolveTrailingStopLevel,
  resolveLongTrailingHighWater,
  retryRealtimeTrailingOperation,
  shouldSubscribeRealtimeTrailingPosition,
} from "./trailing-stop.js";
import { getSpotPoolEntry } from "./spotPool.js";
import {
  getPrescanEntry,
  updateLiveSpotTaker,
  injectLiveMarketData,
  _pdbCheck,
  _pdbPass,
  _pdbReject,
  _pdbEnsure,
  getScannerDbAdmissionBlocker,
  isScannerActive,
  runPrice24hRefreshCycle,
  getLatestFundingRate,
  resetPrescanCycleCount,
} from "./scanner.js";
import {
  getBullishAccumulationOiWatchMinPriceMove,
  getBullishAccumulationOiWatchEntrySource,
  getBullishAccumulationOiWatchFireDecision,
} from "./bullish-accumulation-calibration.js";
import { captureBreakoutAnalysisShadowSnapshot } from "./breakout-analysis-shadow.js";
import { getPatternTgLabel } from "./pattern-labels.js";
import { backfillOiHistoryAfterCollisionCleanup } from "./oiHistoryBackfill.js";
import {
  runLiqCascadeWatcherJob,
  getLiqCascadeLayer10Candidates,
  recordLcDecisionReason,
  type LiqCascadeL10Entry,
} from "./liq-cascade-watcher.js";
import {
  fetchLcObCandles,
  fetchLcObVenueCandles,
  LC_OB_SPOT_VENUES,
  claimLcObWaitRelease,
  isLcObZoneMitigated,
  lcObWaitDeadline,
  lcObWaitLeaseReturnStatus,
  selectWaitingZones,
  shouldReleaseLcObWait,
  lcObZoneTrigger,
  LC_OB_WAIT_ENABLED,
  LC_OB_WAIT_RELEASE_LEASE_MS,
  LC_OB_WAIT_TRIGGER_TOLERANCE_PCT,
  type LcObZone,
} from "./lc-ob-wait.js";
import {
  startWhaleIndexUpdater,
  getTokenWhaleIndex,
  getCachedTokenWi,
} from "./whale_index.js";
import { getGlobalAccountRatio } from "./coinglass_global_ratio.js";
import { getCoinglassCurrentFunding } from "./coinglass_funding.js";
import { claimSettingsBroadcast } from "./broadcast-guard.js";
import { getCachedLiqDataEx } from "./coinglass_liquidation.js";
import { fetchMarketCap } from "./whale_watch_v2.js";
import { getAggregatedFuturesVolumeSeries30m } from "./coinglass_taker.js";
import {
  CALCULATOR_CLOSED_STATUSES,
  calculateCalculatorSummary,
  getCalculatorMonthlyCounts,
  getDubaiMonthKey,
  getDubaiMonthStartUtc,
  getNextDubaiMonthBoundary,
  getPreviousDubaiMonthKey,
  type CalculatorTradeRow,
} from "./trade-calculator.js";
import {
  STEALTH_RECLASSIFIED_ARM_IDS,
  STEALTH_RECLASSIFICATION_REASON,
  STEALTH_RECLASSIFIED_SYMBOLS,
  STEALTH_RECLASSIFIED_TRACKED_IDS,
} from "./stealth-breakout-reclassification.js";
import {
  BR_MISSED_MILESTONES,
  IMPULSE_RUNNER_MAX_AGE_MS,
  IMPULSE_RUNNER_POLICY_VERSION,
  isImpulseRunnerFiveDaysOld,
  impulseRunnerAccountingCorrectionEventKey,
  impulseRunnerPnlPercent,
  isImpulseRunnerCoreClosed,
  isImpulseRunnerPolicy,
  nextSequentialMilestone,
  resolveImpulseRunnerEmergencyStopPrice,
  resolveImpulseRunnerExitDecision,
  resolveImpulseRunnerTrailingStopPrice,
  selectImpulseRunnerPolicy,
  findHistoricalRunnerTrailingStopHit,
  brMilestoneEventKey,
  brMilestoneReconstructedPrice,
  isBrMilestoneRecoveryTarget,
} from "./impulse-runner-policy.js";
import { shouldRecoverDeliveredSignal } from "./delivered-signal-recovery-policy.js";
import {
  capturePlmOi30mShadowAtFire,
  PLM_OI30M_FIRE_FETCH_OPTIONS,
  recoverPlmEntryPrice3hSnapshot,
  recoverPlmFutTakerShadow,
  recoverPlmOi30mShadow,
} from "./plm-decision-snapshot.js";
import { getBitcoinDominanceSummary } from "./coinglass_btc_dominance.js";
import {
  STOP_LOSS,
  CANCEL_STOP_LOSS_PCT,
  ACCUMULATION_REENTRY_H,
  ACCUM_SCOUT_COOLDOWN_MS,
  ACCUM_OI_COOLDOWN_MS,
  HEALTH_ADVICE_TELEGRAM_ENABLED,
  REENTRY_SHADOW_ONLY,
  ACCUM_SCOUT_TELEGRAM_ENABLED,
  RE_ENTRY_VOL_MULT,
  FAST_CYCLE_MS,
  MILESTONES,
  getExitProfile,
  getPatternMaxStop,
  getMaxWatchDays,
  getNoTouchStopMs,
  getBuStopMilestone,
  suppressesPreTargetFivePctNotice,
  resolveLongSplitFillAdjustment,
  resolveBuStopProtection,
  SMART_CANCEL_MIN_AGE_MS,
  SINGLE_ENTRY_POLICY_VERSION,
} from "./watcher-config.js";
import {
  cancelReasonFor,
  getCancellationPolicy,
  hasEntryCvdForSmartCancellation,
  hasCompleteCancellationConfirmation,
  isAutomaticCancellationEnabled,
  isDedicatedCancellationPattern,
  getStaleEvaluationPlan,
  shouldRequireCompleteCancellationConfirmation,
} from "./cancellation-policy.js";
import { writeCancellationPrice72hSnapshots } from "./cancellation-price-snapshot.js";
import {
  buildPostCloseFollowupSnapshot,
  POST_CLOSE_TERMINAL_STATUSES,
} from "./post-close-followup.js";
import {
  calculateForwardPricePct,
  shouldBlockLiqCascadeSpotTaker,
  shouldHoldLiqCascadeForRecovery,
} from "./liq-cascade-calibration.js";
import { LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS } from "./liq-cascade-open-reclassification.js";
import { recordLiqCascadeObservation } from "./liq-cascade-observation.js";
import { randomUUID } from "node:crypto";
import {
  SUBSCRIPTION_WARNING_KIND,
  SUBSCRIPTION_WARNING_LEASE_MS,
  buildSubscriptionWarningText,
  classifySubscriptionWarningSendResult,
  isThreeHourWarningWindow,
  mergeSubscriptionWarningRecipients,
  type SubscriptionWarningRecipient,
} from "./subscription-warning.js";

// Момент старта процесса — используется для grace period после рестарта.
// В течение RESTART_GRACE_MS stale-cancel (72ч hard max + OI check) не срабатывает:
// FastCycle должен успеть оценить и перевести сигналы в in_run прежде чем их отменять.

const SERVER_STARTED_AT = Date.now();
const RESTART_GRACE_MS = 30 * 60_000; // 30 минут

// ── OB snapshot cache — trackSignal сохраняет orderbook при выстреле, fire path читает consumeObAtFire ──
// Consume-once: вызов удаляет запись (избегаем stalе данных если сигналы быстро идут подряд).
const _obAtFire = new Map<string, OrderBookAnalysis | null>();
export function consumeObAtFire(symbol: string): OrderBookAnalysis | null {
  const v = _obAtFire.get(symbol) ?? null;
  _obAtFire.delete(symbol);
  return v;
}

// ── Stale-cancel in-memory extension state (сбрасывается при рестарте) ────────
// _vbStaleHoldUntil  : volume_breakout* OI Watch — signal id → hold-until ms
// _haStaleHoldUntil  : hidden_accumulation OI Watch — id → hold-until ms (0 = проверено, не продлено)
// _staleOi4hExtCount : Глобальный OI4h guard — id → число использованных продлений (макс 2)
const _vbStaleHoldUntil = new Map<number, number>();
const _haStaleHoldUntil = new Map<number, number>();
const _staleOi4hExtCount = new Map<number, number>();
const _staleTakerSellCycles = new Map<number, number>(); // счётчик sell циклов для Шаг 1f

const _staleTakerFlipped = new Set<number>(); // флаг: тейкер перевернулся (Шаг 1f)
// Быстрые паттерны: стейл-чек жёсткий, OI4h guard не применяется
const FAST_STALE_PATTERNS = new Set<string>();
/** Минимальный % притока в OI за 4ч относительно mCap токена — считается значительным */
const NETCHANGE_MCAP_THRESHOLD = 0.5;

// ── Signal trajectory: интервалы снапшотов для калибровки паттернов ──────────
// Один ряд на (signal_id, interval_label). FastCycle пишет row когда elapsed ≥ ms.
// ON CONFLICT DO NOTHING — идемпотентно при рестарте.
const TRAJECTORY_INTERVALS = [
  { label: "15m", ms: 15 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "2h", ms: 2 * 60 * 60_000 },
  { label: "4h", ms: 4 * 60 * 60_000 },
  { label: "8h", ms: 8 * 60 * 60_000 },
  { label: "24h", ms: 24 * 60 * 60_000 },
  { label: "48h", ms: 48 * 60 * 60_000 },
  { label: "72h", ms: 72 * 60 * 60_000 },
] as const;
// In-memory set: `${signalId}:${label}` — предотвращает повторные DB-запросы.
// После рестарта — пустой; первый FastCycle вставит due-rows через ON CONFLICT DO NOTHING.
const _trajectoryRecorded = new Set<string>();
// Lowest direction-aware PnL already attempted in this process. The database
// upsert remains the source of truth and handles races between production
// workers; this set only avoids writing the same non-lower observation every
// two-minute cycle.
const _drawdownMinimums = new Map<number, number>();

type RealtimeTrailingCandidate = {
  tracked: typeof trackedSignalsTable.$inferSelect;
  trailingStopLevel: number | null;
  armedAt: Date | null;
  lastEventAt: Date | null;
};
export async function broadcast(text: string): Promise<number> {
  let targets: (number | string)[] = [];
  try {
    targets = await getTargets();
  } catch (err) {
    logger.error({ err }, "broadcast: не удалось получить список получателей");
    return 0;
  }
  if (targets.length === 0) {
    logger.warn(
      "broadcast: нет получателей — сообщение не отправлено (subscribers пуст, channel_id не задан, TELEGRAM_CHAT_ID не настроен)",
    );
    return 0;
  }
  let sentCount = 0;
  for (const t of targets) {
    try {
      const result = await sendMessageResult(t, text, {
        requireActiveSubscription: true,
      });
      if (result.ok) {
        sentCount++;
      } else {
        logger.error(
          {
            target: t,
            recipientRole:
              typeof t === "string" &&
              (t.startsWith("@") || t.startsWith("-100"))
                ? "channel"
                : "direct_chat",
            status: result.status,
            description: result.description,
          },
          "broadcast: Telegram rejected recipient delivery",
        );
      }
    } catch (err) {
      // Ошибка Telegram (таймаут, rate limit и т.д.) не должна ломать весь цикл.
      // Логируем и продолжаем — остальные получатели получат сообщение.
      logger.error(
        { err, target: t },
        "broadcast: не удалось отправить сообщение",
      );
    }
  }
  return sentCount;
}

const _MOONSHOT_IMG = new URL("../assets/moonshot.png", import.meta.url)
  .pathname;
const STOPLOSS_IMG = new URL("../assets/stoploss.png", import.meta.url)
  .pathname;
const MILESTONE5_IMG = new URL("../assets/milestone5.png", import.meta.url)
  .pathname;
const MILESTONE8_IMG = new URL("../assets/milestone8.png", import.meta.url)
  .pathname;

const FIRST_TARGET_IMG = new URL("../assets/first_target.png", import.meta.url)
  .pathname;
const MILESTONE10_IMG = new URL("../assets/milestone10.png", import.meta.url)
  .pathname;
const MILESTONE15_IMG = new URL("../assets/milestone15.png", import.meta.url)
  .pathname;
const MILESTONE20_IMG = new URL("../assets/milestone20.png", import.meta.url)
  .pathname;
const MILESTONE25_IMG = new URL("../assets/milestone25.png", import.meta.url)
  .pathname;
const MILESTONE30_IMG = new URL("../assets/milestone30.png", import.meta.url)
  .pathname;
const MILESTONE35_IMG = new URL("../assets/milestone35.png", import.meta.url)
  .pathname;
const MILESTONE40_IMG = new URL("../assets/milestone40.png", import.meta.url)
  .pathname;
const MILESTONE45_IMG = new URL("../assets/milestone45.png", import.meta.url)
  .pathname;
const MILESTONE160_IMG = new URL("../assets/milestone160.png", import.meta.url)
  .pathname;
const MILESTONE170_IMG = new URL("../assets/milestone170.png", import.meta.url)
  .pathname;
const MILESTONE175_IMG = new URL("../assets/milestone175.png", import.meta.url)
  .pathname;
const MILESTONE180_IMG = new URL("../assets/milestone180.png", import.meta.url)
  .pathname;
const MILESTONE185_IMG = new URL("../assets/milestone185.png", import.meta.url)
  .pathname;
const MILESTONE190_IMG = new URL("../assets/milestone190.png", import.meta.url)
  .pathname;
const MILESTONE195_IMG = new URL("../assets/milestone195.png", import.meta.url)
  .pathname;
const MILESTONE200_IMG = new URL("../assets/milestone200.png", import.meta.url)
  .pathname;
const TARGET_HIT_IMG = new URL("../assets/target_hit.png", import.meta.url)
  .pathname;
const MILESTONE50_IMG = new URL("../assets/milestone50.png", import.meta.url)
  .pathname;
const MILESTONE55_IMG = new URL("../assets/milestone55.png", import.meta.url)
  .pathname;
const MILESTONE60_IMG = new URL("../assets/milestone60.png", import.meta.url)
  .pathname;
const MILESTONE65_IMG = new URL("../assets/milestone65.png", import.meta.url)
  .pathname;
const MILESTONE70_IMG = new URL("../assets/milestone70.png", import.meta.url)
  .pathname;
const MILESTONE75_IMG = new URL("../assets/milestone75.png", import.meta.url)
  .pathname;
const MILESTONE80_IMG = new URL("../assets/milestone80.png", import.meta.url)
  .pathname;
const MILESTONE85_IMG = new URL("../assets/milestone85.png", import.meta.url)
  .pathname;
const MILESTONE90_IMG = new URL("../assets/milestone90.png", import.meta.url)
  .pathname;
const MILESTONE95_IMG = new URL("../assets/milestone95.png", import.meta.url)
  .pathname;
const MILESTONE100_IMG = new URL("../assets/milestone100.png", import.meta.url)
  .pathname;
const MILESTONE105_IMG = new URL("../assets/milestone105.png", import.meta.url)
  .pathname;
const MILESTONE110_IMG = new URL("../assets/milestone110.png", import.meta.url)
  .pathname;
const MILESTONE115_IMG = new URL("../assets/milestone115.png", import.meta.url)
  .pathname;
const MILESTONE120_IMG = new URL("../assets/milestone120.png", import.meta.url)
  .pathname;
const MILESTONE125_IMG = new URL("../assets/milestone125.png", import.meta.url)
  .pathname;
const MILESTONE130_IMG = new URL("../assets/milestone130.png", import.meta.url)
  .pathname;
const MILESTONE135_IMG = new URL("../assets/milestone135.png", import.meta.url)
  .pathname;
const MILESTONE140_IMG = new URL("../assets/milestone140.png", import.meta.url)
  .pathname;
const MILESTONE145_IMG = new URL("../assets/milestone145.png", import.meta.url)
  .pathname;
const MILESTONE150_IMG = new URL("../assets/milestone150.png", import.meta.url)
  .pathname;
const MILESTONE155_IMG = new URL("../assets/milestone155.png", import.meta.url)
  .pathname;
const MILESTONE165_IMG = new URL("../assets/milestone165.png", import.meta.url)
  .pathname;
const CANCEL_IMG = new URL("../assets/cancel.png", import.meta.url).pathname;
const POSITION_UPDATE_IMG = new URL(
  "../assets/position_update.png",
  import.meta.url,
).pathname;
const POSITION_HOLD_IMG = new URL(
  "../assets/position_hold.png",
  import.meta.url,
).pathname;
const POSITION_FOLLOW_IMG = new URL(
  "../assets/position_follow.png",
  import.meta.url,
).pathname;
const POSITION_EXIT_IMG = new URL(
  "../assets/position_exit.png",
  import.meta.url,
).pathname;
const TRAILING_STOP_IMG = new URL(
  "../assets/trailing_stop.png",
  import.meta.url,
).pathname;
const BU_STOP_IMG = new URL("../assets/bu_stop.png", import.meta.url).pathname;
const BREAKEVEN_STOP_IMG = new URL(
  "../assets/breakeven_locked.png",
  import.meta.url,
).pathname;
const IMPULSE_RUNNER_CLOSED_IMG = new URL(
  "../assets/impulse_runner_closed.png",
  import.meta.url,
).pathname;
const EXPIRED_IMG = new URL("../assets/position_expired.png", import.meta.url)
  .pathname;
const WEEKLY_REPORT_IMG = new URL(
  "../assets/weekly_report.png",
  import.meta.url,
).pathname;
const DAILY_REPORT_IMG = new URL("../assets/daily_report.png", import.meta.url)
  .pathname;
const MONTHLY_REPORT_IMG = new URL(
  "../assets/monthly_report.png",
  import.meta.url,
).pathname;
const WATCHDOG_IMG = new URL("../assets/watchdog.png", import.meta.url)
  .pathname;
const RESTART_IMG = new URL("../assets/system_restarted.png", import.meta.url)
  .pathname;
const MANUAL_CHECK_IMG = new URL("../assets/manual_check.png", import.meta.url)
  .pathname;

export async function broadcastPhoto(
  photoPath: string,
  text: string,
  eventKey?: string,
): Promise<number> {
  let targets: (number | string)[] = [];
  try {
    targets = await getTargets({ strict: true });
  } catch (err) {
    logger.error(
      { err },
      "broadcastPhoto: не удалось получить список получателей",
    );
    return 0;
  }
  if (targets.length === 0) return 0;
  return enqueueTelegramPhotoBroadcast({
    photoPath,
    text,
    targets,
    eventKey,
  });
}

export async function broadcastPhotoAfterClaim(
  photoPath: string | (() => string),
  text: string | (() => string),
  eventKey: string,
  claim: (tx: TelegramPhotoOutboxTransaction) => Promise<boolean>,
): Promise<{ claimed: boolean; queued: number }> {
  assertMarketCycleLeaseOwnership("transactional Telegram broadcast");
  try {
    return await runTelegramPhotoAfterRecipientResolution({
      resolveTargets: () => getTargets({ strict: true }),
      enqueueAfterClaim: async (targets) => {
        if (targets.length === 0) {
          logger.warn(
            { eventKey },
            "Transactional Telegram broadcast has no recipients; state claim will still commit",
          );
        }
        return enqueueTelegramPhotoBroadcastAfterClaim({
          photoPath,
          text,
          targets,
          eventKey,
          claim,
        });
      },
      enqueueAfterResolutionFailure: () =>
        enqueueTelegramPhotoClaimPendingRecipientResolution({
          photoPath,
          text,
          eventKey,
          claim,
        }),
    });
  } catch (err) {
    logger.error(
      { err, eventKey },
      "Transactional Telegram broadcast could not resolve recipients",
    );
    throw err;
  }
}

function maxPeakPriceSql(candidate: number) {
  return sql<number>`GREATEST(COALESCE(${trackedSignalsTable.peakPrice}, ${candidate}), ${candidate})`;
}

function maxTrailingStopLevelSql(candidate: number) {
  return sql<number>`GREATEST(COALESCE(${trackedSignalsTable.trailingStopLevel}, ${candidate}), ${candidate})`;
}

function trailingStopArmedAtSql(candidate: number, observedAt: Date) {
  return sql<Date>`CASE
    WHEN ${candidate} > COALESCE(${trackedSignalsTable.trailingStopLevel}, 0)
      THEN ${observedAt}
    ELSE ${trackedSignalsTable.trailingStopArmedAt}
  END`;
}

// Telegram caption limit = 1024 символов. Режем по границе строки с запасом на HTML-теги.
const CAPTION_MAX_LEN = 1000;
const PHOTO_RETRY_DELAY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendPhotoCaptionWithSafeRetry(
  target: number | string,
  photoPath: string,
  caption: string,
) {
  let result = await sendPhotoCaptionResult(target, photoPath, caption);
  if (shouldRetryExplicitPhotoFailure(result)) {
    await sleep(PHOTO_RETRY_DELAY_MS);
    result = await sendPhotoCaptionResult(target, photoPath, caption);
  }
  return result;
}

/**
 * Never falls back to text for an ambiguous timeout/network failure: Telegram
 * may have accepted the photo even though the response was lost.
 */
async function deliverPhotoCaption(
  target: number | string,
  photoPath: string,
  caption: string,
  fallbackText = caption,
): Promise<"photo" | "fallback" | "uncertain"> {
  const photoResult = await sendPhotoCaptionWithSafeRetry(
    target,
    photoPath,
    caption,
  );
  if (photoResult.ok) return "photo";

  if (!shouldFallbackToTextAfterPhotoFailure(photoResult)) {
    logger.warn(
      {
        target,
        status: photoResult.status,
        description: photoResult.description,
      },
      "Telegram photo delivery uncertain — text fallback skipped to prevent duplicate",
    );
    return "uncertain";
  }

  const textResult = await sendMessageResult(target, fallbackText);
  if (!textResult.ok) {
    logger.warn(
      {
        target,
        status: textResult.status,
        description: textResult.description,
      },
      "Telegram text fallback failed after confirmed photo rejection",
    );
  }
  return textResult.ok ? "fallback" : "uncertain";
}

/** Делит текст на { caption, rest }: caption <= maxLen символов (по границе строки), rest — остаток. */
function splitCaptionAndRest(
  text: string,
  maxLen = CAPTION_MAX_LEN,
): { caption: string; rest: string } {
  const lines = text.split("\n");
  let caption = "";
  let i = 0;
  for (; i < lines.length; i++) {
    const candidate = caption ? caption + "\n" + lines[i] : lines[i];
    if (candidate.length > maxLen && caption) break;
    caption = candidate;
  }
  const rest = lines.slice(i).join("\n");
  return { caption, rest };
}

/** Ставит фото, fallback и продолжения в общую recipient-level outbox очередь. */
export async function broadcastPhotoWithText(
  photoPath: string,
  text: string,
  eventKey?: string,
): Promise<number> {
  return broadcastPhoto(photoPath, text, eventKey);
}

/**
 * Fail-open: fetches current OI (30m) and Spot CVD for a symbol.
 * Both getCoinglassOI and getSpotCvdMtf are cached — repeated calls within
 * the same scan cycle are effectively free.
 */
/**
 * Optional health lines must never hold a milestone message hostage: CoinGlass
 * pacing/429 cooldowns can stall these lookups for minutes (STRK/SYN +5/+10
 * milestones stayed "sending" with no Telegram event on 2026-10-08).
 */
const MILESTONE_HEALTH_TIMEOUT_MS = 4_000;
async function fetchMilestoneHealth(
  symbol: string,
  price: number,
): Promise<SpotHealth | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      _fetchSignalHealth(symbol, price).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MILESTONE_HEALTH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function _fetchSignalHealth(
  symbol: string,
  price: number,
): Promise<SpotHealth> {
  const [oi, cvd] = await Promise.all([
    getCoinglassOI(symbol, price).catch(() => null),
    getSpotCvdMtf(symbol).catch(() => null),
  ]);
  return {
    oiPct: oi?.available ? (oi.oiChange30m ?? null) : null,
    cvd15m: cvd?.available ? (cvd.cvd15m ?? null) : null,
    cvd30m: cvd?.available ? (cvd.cvd30m ?? null) : null,
    cvd1h: cvd?.available ? (cvd.cvd1h ?? null) : null,
  };
}

// Разбивает длинный текст на чанки <= maxLen символов по границам строк.
// Telegram лимит = 4096 символов; используем 4000 с запасом на HTML-теги.
export function splitMessageChunks(text: string, maxLen = 4000): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Admin broadcast — отправляет произвольный текст всем подписчикам (для уведомлений об обновлениях) */
export async function adminBroadcast(text: string): Promise<void> {
  await broadcast(text);
}

// Отправляет фото с текстом: caption ≤1024 символов (лимит Telegram),
// остаток — отдельными сообщениями ≤4000 символов каждое.
// При подтверждённом сбое фото — fallback: весь текст отдельными сообщениями.
async function sendPhotoTo(
  photoPath: string,
  text: string,
  targetChatId?: number | string,
): Promise<void> {
  const reportText = withoutTradingViewLinks(text);
  if (targetChatId !== undefined) {
    const { caption, rest } = splitCaptionAndRest(reportText);
    const restChunks = rest ? splitMessageChunks(rest, 4000) : [];
    const outcome = await deliverPhotoCaption(
      targetChatId,
      photoPath,
      caption,
      reportText,
    );
    if (outcome !== "photo") {
      return;
    }
    for (let i = 0; i < restChunks.length; i++) {
      await sendMessage(targetChatId, restChunks[i]!).catch(() => {});
      if (i < restChunks.length - 1)
        await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    // broadcast: broadcastPhotoWithText уже корректно обрабатывает caption overflow
    await broadcastPhotoWithText(photoPath, reportText);
  }
}

import {
  fmtP,
  fmtPct,
  hoursAndDays,
  activeForLine,
  tickerTag,
  patternTag,
  computePnl,
  computePeakPnl,
  nextMilestone,
  nextBitcoinMilestone,
  msgFirstTarget,
  msgTrailingActivated,
  msgMilestone,
  msgTrailingStopHit,
  msgImpulseRunnerCoreClose,
  msgImpulseRunnerFinalClose,
  msgImpulseRunnerAccountingCorrection,
  msgStopLoss,
  msgBUStop,
  msg8PercentHit,
  msgPartialTakeProfit,
  msgPreTargetMilestone,
  msgAccumVolumeBuilding,
  msgAccumOiBuilding,
  msgLateSignal,
  msgHealthUpdate,
  fmtPositionProtectionLine,
  hasEarnedBuProtection,
  msgExpired,
  msgTimeoutTakeProfit,
  msgBreakevenAsStopLoss,
  fmtHealthLine,
  fmtSplitFillMarketContext,
  type SplitFillMarketContext,
  type SpotHealth,
} from "./watcher-formatters.js";

import {
  buildFirstTargetMilestoneTransition,
  buildStartupFirstTargetRecovery,
} from "./milestone-transition.js";

async function fetchSplitFillMarketContext(
  symbol: string,
  currentPrice: number,
): Promise<SplitFillMarketContext> {
  const timeout = <T>(promise: Promise<T>, ms = 4_500): Promise<T | null> =>
    Promise.race([
      promise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]).catch(() => null);

  const [oi, cvd, ob] = await Promise.all([
    timeout(
      getCoinglassOI(symbol, currentPrice, AbortSignal.timeout(4_000), {
        bypassCache: true,
      }),
    ),
    timeout(getSpotCvdMtf(symbol, { bypassCache: true })),
    timeout(getOrderBookAnalysis(symbol, 20)),
  ]);

  return {
    oi30m: oi?.oiChange30m ?? null,
    spotCvdStrength1h: cvd?.cvdStrength1h ?? null,
    spotCvd1h: cvd?.cvd1h ?? null,
    obRatio: ob?.bidAskRatio ?? null,
  };
}

const PENDING_MILESTONE_KINDS = new Set<PendingMilestoneKind>([
  "partial",
  "pre_target",
  "intermediate",
  "first_target",
  "late_target",
  "trailing",
  "milestone",
]);

const MILESTONE_IMAGES: Record<number, string> = {
  5: MILESTONE5_IMG,
  8: MILESTONE8_IMG,
  10: MILESTONE10_IMG,
  15: MILESTONE15_IMG,
  20: MILESTONE20_IMG,
  25: MILESTONE25_IMG,
  30: MILESTONE30_IMG,
  35: MILESTONE35_IMG,
  40: MILESTONE40_IMG,
  45: MILESTONE45_IMG,
  50: MILESTONE50_IMG,
  55: MILESTONE55_IMG,
  60: MILESTONE60_IMG,
  65: MILESTONE65_IMG,
  70: MILESTONE70_IMG,
  75: MILESTONE75_IMG,
  80: MILESTONE80_IMG,
  85: MILESTONE85_IMG,
  90: MILESTONE90_IMG,
  95: MILESTONE95_IMG,
  100: MILESTONE100_IMG,
  105: MILESTONE105_IMG,
  110: MILESTONE110_IMG,
  115: MILESTONE115_IMG,
  120: MILESTONE120_IMG,
  125: MILESTONE125_IMG,
  130: MILESTONE130_IMG,
  135: MILESTONE135_IMG,
  140: MILESTONE140_IMG,
  145: MILESTONE145_IMG,
  150: MILESTONE150_IMG,
  155: MILESTONE155_IMG,
  160: MILESTONE160_IMG,
  165: MILESTONE165_IMG,
  170: MILESTONE170_IMG,
  175: MILESTONE175_IMG,
  180: MILESTONE180_IMG,
  185: MILESTONE185_IMG,
  190: MILESTONE190_IMG,
  195: MILESTONE195_IMG,
  200: MILESTONE200_IMG,
};

function milestoneImageFor(
  tracked: Pick<TrackedSignal, "symbol">,
  milestone: number,
  fallback?: string,
): string | undefined {
  if (
    tracked.symbol === "BTC-USDT" ||
    tracked.symbol === "BTCUSDT" ||
    milestone > 200
  ) {
    return TARGET_HIT_IMG;
  }
  return MILESTONE_IMAGES[milestone] ?? fallback;
}

function isBitcoinTrackedSignal(
  tracked: Pick<TrackedSignal, "symbol">,
): boolean {
  return tracked.symbol === "BTC-USDT" || tracked.symbol === "BTCUSDT";
}

function milestoneOutboxEventKey(
  tracked: Pick<TrackedSignal, "id">,
  kind: PendingMilestoneKind,
  milestone: number,
): string {
  return `milestone:v3:${tracked.id}:${kind}:${milestone}`;
}

async function hasLegacyMilestoneRecipientLedger(
  tracked: Pick<TrackedSignal, "id">,
  kind: PendingMilestoneKind,
  milestone: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: milestoneNotificationDeliveriesTable.id })
    .from(milestoneNotificationDeliveriesTable)
    .where(
      and(
        eq(milestoneNotificationDeliveriesTable.trackedSignalId, tracked.id),
        eq(milestoneNotificationDeliveriesTable.milestone, milestone),
        eq(milestoneNotificationDeliveriesTable.milestoneKind, kind),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function queueMilestoneOutbox(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  params: { text: string; photoPath?: string },
): Promise<MilestoneDeliveryOutcome> {
  try {
    // The outbox transaction writes the immutable recipient snapshot before
    // any request reaches Telegram. Retrying this exact key after a DB timeout
    // is safe and never adds a late subscriber to the old business event.
    const targets = await getTargets({ strict: true });
    if (targets.length === 0) {
      return milestoneDeliveryFailure("No Telegram recipients available");
    }
    const eventKey = milestoneOutboxEventKey(tracked, kind, milestone);
    const queued = params.photoPath
      ? await enqueueTelegramPhotoBroadcast({
          photoPath: params.photoPath,
          text: params.text,
          targets,
          eventKey,
        })
      : await enqueueTelegramTextBroadcast({
          text: params.text,
          targets,
          eventKey,
        });
    return {
      kind: "delivered",
      sentCount: queued || targets.length,
    };
  } catch (err) {
    logger.error(
      { err, trackedSignalId: tracked.id, kind, milestone },
      "Milestone could not be durably queued for Telegram",
    );
    return milestoneDeliveryFailure("Telegram delivery queue unavailable");
  }
}

function isPendingMilestoneKind(
  value: string | null,
): value is PendingMilestoneKind {
  return (
    value != null && PENDING_MILESTONE_KINDS.has(value as PendingMilestoneKind)
  );
}

function milestoneDeliveryFailure(
  description: string,
): MilestoneDeliveryOutcome {
  return { kind: "confirmed_failure", description };
}

async function deliverMilestonePerTarget(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  sendToTarget: (target: number | string) => Promise<MilestoneDeliveryOutcome>,
): Promise<MilestoneDeliveryOutcome> {
  let existingRows = await db
    .select({
      id: milestoneNotificationDeliveriesTable.id,
      target: milestoneNotificationDeliveriesTable.target,
      status: milestoneNotificationDeliveriesTable.status,
      leaseUntil: milestoneNotificationDeliveriesTable.leaseUntil,
    })
    .from(milestoneNotificationDeliveriesTable)
    .where(
      and(
        eq(milestoneNotificationDeliveriesTable.trackedSignalId, tracked.id),
        eq(milestoneNotificationDeliveriesTable.milestone, milestone),
        eq(milestoneNotificationDeliveriesTable.milestoneKind, kind),
      ),
    );

  if (existingRows.length === 0) {
    let targetSnapshot: Awaited<
      ReturnType<typeof getCanonicalMilestoneTargets>
    >;
    try {
      targetSnapshot = await getCanonicalMilestoneTargets();
    } catch (err) {
      logger.error(
        { err },
        "Milestone delivery could not load Telegram recipients",
      );
      return milestoneDeliveryFailure("Telegram recipients unavailable");
    }
    // The first recipient list is immutable for this event. Waiting for an
    // unresolved channel alias prevents a partial snapshot that later adds the
    // same channel under a different identity.
    if (targetSnapshot.unresolvedAliases.length > 0) {
      return milestoneDeliveryFailure(
        `Telegram recipient aliases unresolved: ${targetSnapshot.unresolvedAliases.join(", ")}`,
      );
    }
    if (targetSnapshot.targets.length === 0) {
      return milestoneDeliveryFailure("No Telegram recipients available");
    }

    // Two rolling-deploy workers can observe an empty ledger at once. Elect one
    // snapshot writer per business event so the later worker reads that exact
    // immutable list instead of merging a newer subscriber configuration.
    existingRows = await dbWriteStrict(
      "milestoneDelivery/recipient-snapshot",
      () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`milestone-recipient-snapshot:${tracked.id}:${kind}:${milestone}`}))`,
          );
          const lockedRows = await tx
            .select({
              id: milestoneNotificationDeliveriesTable.id,
              target: milestoneNotificationDeliveriesTable.target,
              status: milestoneNotificationDeliveriesTable.status,
              leaseUntil: milestoneNotificationDeliveriesTable.leaseUntil,
            })
            .from(milestoneNotificationDeliveriesTable)
            .where(
              and(
                eq(
                  milestoneNotificationDeliveriesTable.trackedSignalId,
                  tracked.id,
                ),
                eq(milestoneNotificationDeliveriesTable.milestone, milestone),
                eq(milestoneNotificationDeliveriesTable.milestoneKind, kind),
              ),
            );
          if (lockedRows.length > 0) return lockedRows;

          await tx.insert(milestoneNotificationDeliveriesTable).values(
            targetSnapshot.targets.map((target) => ({
              trackedSignalId: tracked.id,
              milestone,
              milestoneKind: kind,
              target: String(target),
              status: "ready",
            })),
          );
          return targetSnapshot.targets.map((target) => ({
            id: 0,
            target: String(target),
            status: "ready",
            leaseUntil: null,
          }));
        }),
    );
  }
  if (existingRows.length > 0) {
    // The original recipient snapshot does not add later subscribers, but a
    // complete current target resolution may safely terminalize a recipient
    // that was removed before its notification could be sent.
    try {
      const currentTargets = await getCanonicalMilestoneTargets();
      const removedTargets = selectRemovedMilestoneRecipients(
        existingRows,
        currentTargets.targets,
        currentTargets.unresolvedAliases,
      );
      if (removedTargets.length > 0) {
        const removed = new Set(removedTargets);
        existingRows = existingRows.map((row) =>
          removed.has(row.target) ? { ...row, status: "abandoned" } : row,
        );
        await dbWriteBestEffort("milestoneDelivery/recipient-removed", () =>
          db
            .update(milestoneNotificationDeliveriesTable)
            .set({
              status: "abandoned",
              leaseUntil: null,
              claimToken: null,
              lastError: "recipient no longer configured",
            })
            .where(
              and(
                eq(
                  milestoneNotificationDeliveriesTable.trackedSignalId,
                  tracked.id,
                ),
                eq(milestoneNotificationDeliveriesTable.milestone, milestone),
                eq(milestoneNotificationDeliveriesTable.milestoneKind, kind),
                inArray(
                  milestoneNotificationDeliveriesTable.target,
                  removedTargets,
                ),
                or(
                  eq(milestoneNotificationDeliveriesTable.status, "ready"),
                  eq(milestoneNotificationDeliveriesTable.status, "failed"),
                ),
              ),
            ),
        );
      }
    } catch (err) {
      // Retain the immutable recipient ledger when target resolution is
      // unavailable; a partial current list must never abandon a recipient.
      logger.warn(
        { err, trackedSignalId: tracked.id, kind, milestone },
        "Milestone recipient removal check unavailable",
      );
    }
  }
  // Once created, delivery rows are the immutable recipient ledger for this
  // business event. Retrying must not depend on the latest subscriber lookup:
  // that lookup may be unavailable exactly when a DB timeout needs recovery.
  const recipientTargets = existingRows
    .map((row) => Number(row.target))
    .filter(
      (target): target is number =>
        Number.isSafeInteger(target) && target !== 0,
    );

  const targetsDueForDispatch = selectMilestoneRecipientsDueForDispatch(
    existingRows,
    recipientTargets,
    new Date(),
  );

  for (const target of targetsDueForDispatch) {
    const targetKey = String(target);
    const claimed = await dbWriteStrict(
      "milestoneDelivery/recipient-claim",
      () =>
        claimMilestoneRecipient(db, {
          trackedSignalId: tracked.id,
          milestone,
          milestoneKind: kind,
          target: targetKey,
        }),
    );
    if (!claimed) continue;

    let outcome: MilestoneDeliveryOutcome;
    try {
      if (
        LIQ_CASCADE_OPEN_RECLASSIFICATION_TARGETS.some(
          ([trackedId]) => trackedId === tracked.id,
        )
      ) {
        // Only the five reviewed positions need this cutover fence. Hold the
        // advisory lock until the external send finishes; the startup
        // correction takes the same lock before it changes their status.
        outcome = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext('lc_reviewed_milestone'), ${tracked.id})`,
          );
          const current = await tx.execute(
            sql`SELECT status::text AS status FROM tracked_signals WHERE id = ${tracked.id}`,
          );
          if (
            current.rows.length !== 1 ||
            current.rows[0].status === "reclassified"
          ) {
            return {
              kind: "abandoned",
              description: "position moved back to LC observation",
            } as MilestoneDeliveryOutcome;
          }
          return sendToTarget(target);
        });
      } else {
        outcome = await sendToTarget(target);
      }
    } catch (err) {
      outcome = {
        kind: "ambiguous",
        description: err instanceof Error ? err.message : "unknown send error",
      };
    }

    const state: MilestoneRecipientOutcomeState =
      outcome.kind === "delivered"
        ? {
            status: "delivered",
            leaseUntil: null,
            deliveredAt: new Date(),
            lastError: null,
          }
        : outcome.kind === "abandoned"
          ? {
              status: "abandoned",
              leaseUntil: null,
              deliveredAt: null,
              lastError: outcome.description,
            }
          : outcome.kind === "confirmed_failure"
            ? {
                status: "failed",
                leaseUntil: new Date(Date.now() + MILESTONE_RETRY_DELAY_MS),
                deliveredAt: null,
                lastError: outcome.description,
              }
            : {
                status: "ambiguous",
                leaseUntil: new Date(Date.now() + MILESTONE_RETRY_DELAY_MS),
                deliveredAt: null,
                lastError: outcome.description,
              };
    await dbWriteBestEffort("milestoneDelivery/recipient-result", () =>
      recordMilestoneRecipientOutcome(db, {
        id: claimed.id,
        claimToken: claimed.claimToken,
        state,
      }),
    );
  }

  const deliveryRows = await db
    .select({ status: milestoneNotificationDeliveriesTable.status })
    .from(milestoneNotificationDeliveriesTable)
    .where(
      and(
        eq(milestoneNotificationDeliveriesTable.trackedSignalId, tracked.id),
        eq(milestoneNotificationDeliveriesTable.milestone, milestone),
        eq(milestoneNotificationDeliveriesTable.milestoneKind, kind),
      ),
    );
  const summary = summarizeMilestoneRecipientStatuses(
    deliveryRows.map((row) => row.status),
  );
  return summary;
}

const MILESTONE_RECOVERY_BATCH_SIZE = 8;

function milestoneRecipientRole(target: string): "channel" | "direct_chat" {
  return target.startsWith("-100") ? "channel" : "direct_chat";
}

/**
 * Recovers recipient rows independently from tracked_signals.pendingMilestone.
 * A parent signal can legitimately clear after another recipient succeeded;
 * this ledger remains the source of truth for the channel's eventual delivery.
 */
async function reconcileMilestoneRecipientDeliveries(): Promise<number> {
  const now = new Date();
  const dueRead = await dbReadWithRetry("Milestone recipient recovery", () =>
    db
      .select({
        trackedSignalId: milestoneNotificationDeliveriesTable.trackedSignalId,
        milestone: milestoneNotificationDeliveriesTable.milestone,
        milestoneKind: milestoneNotificationDeliveriesTable.milestoneKind,
        target: milestoneNotificationDeliveriesTable.target,
        status: milestoneNotificationDeliveriesTable.status,
        leaseUntil: milestoneNotificationDeliveriesTable.leaseUntil,
        attempts: milestoneNotificationDeliveriesTable.attempts,
        lastError: milestoneNotificationDeliveriesTable.lastError,
      })
      .from(milestoneNotificationDeliveriesTable)
      .where(
        or(
          eq(milestoneNotificationDeliveriesTable.status, "ready"),
          and(
            eq(milestoneNotificationDeliveriesTable.status, "failed"),
            or(
              isNull(milestoneNotificationDeliveriesTable.leaseUntil),
              lte(milestoneNotificationDeliveriesTable.leaseUntil, now),
            ),
          ),
        ),
      )
      .limit(MILESTONE_RECOVERY_BATCH_SIZE * 3),
  );
  if (!dueRead.ok) return 0;

  const events = new Map<string, (typeof dueRead.value)[number]>();
  for (const row of dueRead.value) {
    const key = `${row.trackedSignalId}:${row.milestoneKind}:${row.milestone}`;
    if (!events.has(key)) events.set(key, row);
    if (events.size >= MILESTONE_RECOVERY_BATCH_SIZE) break;
  }
  if (events.size === 0) return 0;

  const trackedRead = await dbReadWithRetry("Milestone recovery signals", () =>
    db
      .select()
      .from(trackedSignalsTable)
      .where(
        inArray(
          trackedSignalsTable.id,
          [...events.values()].map((row) => row.trackedSignalId),
        ),
      ),
  );
  if (!trackedRead.ok) return 0;
  const trackedById = new Map(trackedRead.value.map((row) => [row.id, row]));

  let recovered = 0;
  for (const row of events.values()) {
    const tracked = trackedById.get(row.trackedSignalId);
    if (!tracked || !isPendingMilestoneKind(row.milestoneKind)) {
      logger.error(
        {
          trackedSignalId: row.trackedSignalId,
          milestone: row.milestone,
          milestoneKind: row.milestoneKind,
          recipientRole: milestoneRecipientRole(row.target),
        },
        "Milestone recipient recovery skipped: signal or milestone kind unavailable",
      );
      continue;
    }

    let recoveryPrice =
      tracked.entryPrice > 0
        ? tracked.entryPrice * (1 + row.milestone / 100)
        : tracked.entryPrice;
    let recoveryTrailingStop = tracked.trailingStopLevel ?? recoveryPrice;
    if (row.milestoneKind === "trailing") {
      const exitProfile = getExitProfile(tracked.sentimentKey, tracked.symbol);
      const peakPrice = tracked.peakPrice ?? tracked.entryPrice;
      const peakPnl = computePnl(tracked, peakPrice);
      const verifiedStop = resolveActivatedTrailingStopLevel({
        peakPnlPercent: peakPnl,
        trailingActivationPercent: exitProfile.trailingActivation,
        entryPrice: tracked.entryPrice,
        peakPrice,
        trailingGapPercent: exitProfile.trailingGap,
        persistedTrailingStopLevel: tracked.trailingStopLevel,
      });
      if (verifiedStop === null) {
        logger.error(
          {
            trackedSignalId: tracked.id,
            symbol: tracked.symbol,
            milestone: row.milestone,
            peakPnl,
            trailingActivation: exitProfile.trailingActivation,
          },
          "Milestone recipient recovery abandoned: trailing threshold was never reached",
        );
        await dbWriteBestEffort(
          "milestoneDelivery/invalid-trailing-recovery",
          () =>
            db
              .update(milestoneNotificationDeliveriesTable)
              .set({
                status: "abandoned",
                leaseUntil: null,
                claimToken: null,
                lastError: "durable peak below trailing activation",
              })
              .where(
                and(
                  eq(
                    milestoneNotificationDeliveriesTable.trackedSignalId,
                    tracked.id,
                  ),
                  eq(
                    milestoneNotificationDeliveriesTable.milestone,
                    row.milestone,
                  ),
                  eq(
                    milestoneNotificationDeliveriesTable.milestoneKind,
                    row.milestoneKind,
                  ),
                  or(
                    eq(milestoneNotificationDeliveriesTable.status, "ready"),
                    eq(milestoneNotificationDeliveriesTable.status, "failed"),
                  ),
                ),
              ),
        );
        continue;
      }
      recoveryPrice = peakPrice;
      recoveryTrailingStop = verifiedStop;
    }
    logger.warn(
      {
        trackedSignalId: tracked.id,
        symbol: tracked.symbol,
        milestone: row.milestone,
        milestoneKind: row.milestoneKind,
        recipientRole: milestoneRecipientRole(row.target),
        recipientStatus: row.status,
        attempts: row.attempts,
        leaseUntil: row.leaseUntil,
        lastError: row.lastError,
      },
      "Recovering undelivered milestone recipient",
    );
    await sendMilestoneNotification(
      tracked,
      row.milestoneKind,
      row.milestone,
      recoveryPrice,
      recoveryTrailingStop,
    );
    recovered++;
  }
  return recovered;
}

async function broadcastMilestoneText(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  text: string,
): Promise<MilestoneDeliveryOutcome> {
  if (!(await hasLegacyMilestoneRecipientLedger(tracked, kind, milestone))) {
    return queueMilestoneOutbox(tracked, kind, milestone, { text });
  }
  return deliverMilestonePerTarget(tracked, kind, milestone, async (target) =>
    classifyMilestoneSendResult(await sendMessageResult(target, text)),
  );
}

async function broadcastMilestonePhoto(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  photoPath: string,
  caption: string,
): Promise<MilestoneDeliveryOutcome> {
  if (!(await hasLegacyMilestoneRecipientLedger(tracked, kind, milestone))) {
    return queueMilestoneOutbox(tracked, kind, milestone, {
      photoPath,
      text: caption,
    });
  }
  return deliverMilestonePerTarget(tracked, kind, milestone, async (target) => {
    const photoOutcome = classifyMilestoneSendResult(
      await sendPhotoCaptionResult(target, photoPath, caption),
    );
    if (!shouldFallbackMilestonePhotoToText(photoOutcome)) {
      return photoOutcome;
    }

    // Fallback to text only after an explicit Telegram/local rejection.
    // A timeout may mean Telegram already accepted the photo, so fallback text
    // would itself create a duplicate.
    return classifyMilestoneSendResult(
      await sendMessageResult(target, caption),
    );
  });
}

async function sendMilestoneNotification(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  currentPrice: number,
  trailingStop: number,
): Promise<MilestoneDeliveryOutcome> {
  if (
    kind === "trailing" &&
    computePnl(tracked, currentPrice) + 0.0001 < milestone
  ) {
    logger.error(
      {
        signalId: tracked.id,
        symbol: tracked.symbol,
        milestone,
        snapshotPnl: computePnl(tracked, currentPrice),
        currentPrice,
      },
      "Trailing notification abandoned: snapshot never reached activation",
    );
    return {
      kind: "abandoned",
      description: "trailing snapshot below activation threshold",
    };
  }
  const image = milestoneImageFor(tracked, milestone);
  const health = await fetchMilestoneHealth(tracked.symbol, currentPrice);

  if (kind === "partial") {
    return broadcastMilestonePhoto(
      tracked,
      kind,
      milestone,
      image ?? FIRST_TARGET_IMG,
      msgPartialTakeProfit(
        tracked,
        currentPrice,
        computePnl(tracked, currentPrice),
        health,
      ),
    );
  }
  if (kind === "pre_target") {
    return broadcastMilestonePhoto(
      tracked,
      kind,
      milestone,
      image ?? MILESTONE5_IMG,
      msgPreTargetMilestone(tracked, milestone, currentPrice, null, health),
    );
  }
  if (kind === "intermediate") {
    return broadcastMilestonePhoto(
      tracked,
      kind,
      milestone,
      image ?? MILESTONE8_IMG,
      msg8PercentHit(tracked, currentPrice, null, health),
    );
  }
  if (kind === "late_target") {
    return broadcastMilestonePhoto(
      tracked,
      kind,
      milestone,
      image ?? POSITION_UPDATE_IMG,
      msgLateSignal(
        tracked,
        currentPrice,
        computePnl(tracked, currentPrice),
        health,
      ),
    );
  }
  if (kind === "first_target") {
    return broadcastMilestonePhoto(
      tracked,
      kind,
      milestone,
      image ?? MILESTONE10_IMG,
      msgFirstTarget(tracked, currentPrice, null, health),
    );
  }
  if (kind === "trailing") {
    const text = msgTrailingActivated(
      tracked,
      currentPrice,
      trailingStop,
      null,
      health,
    );
    return image && (milestone === 15 || isBitcoinTrackedSignal(tracked))
      ? broadcastMilestonePhoto(tracked, kind, milestone, image, text)
      : broadcastMilestoneText(tracked, kind, milestone, text);
  }

  const text = msgMilestone(
    tracked,
    milestone,
    currentPrice,
    trailingStop,
    null,
    health,
  );
  return image
    ? broadcastMilestonePhoto(tracked, kind, milestone, image, text)
    : broadcastMilestoneText(tracked, kind, milestone, text);
}

async function finishMilestoneNotification(
  tracked: TrackedSignal,
  kind: PendingMilestoneKind,
  milestone: number,
  currentPrice: number,
  trailingStop: number,
): Promise<boolean> {
  let outcome: MilestoneDeliveryOutcome;
  try {
    outcome = await sendMilestoneNotification(
      tracked,
      kind,
      milestone,
      currentPrice,
      trailingStop,
    );
  } catch (err) {
    logger.error(
      { err, symbol: tracked.symbol, kind, milestone },
      "Milestone delivery threw after dispatch started — automatic retry disabled",
    );
    outcome = {
      kind: "ambiguous",
      description:
        err instanceof Error ? err.message : "unknown delivery error",
    };
  }

  if (outcome.kind === "delivered" || outcome.kind === "abandoned") {
    const cleared = await dbWriteBestEffort(
      "trackedSignal/milestone-delivery-complete",
      () =>
        db
          .update(trackedSignalsTable)
          .set({
            pendingMilestone: null,
            pendingMilestoneKind: null,
            pendingMilestonePrice: null,
            pendingMilestoneTrailingStop: null,
            pendingMilestoneStatus: null,
            pendingMilestoneLeaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(trackedSignalsTable.id, tracked.id),
              eq(trackedSignalsTable.pendingMilestone, milestone),
              eq(trackedSignalsTable.pendingMilestoneKind, kind),
              eq(trackedSignalsTable.pendingMilestoneStatus, "sending"),
            ),
          )
          .returning({ id: trackedSignalsTable.id }),
    );
    if (!cleared || cleared.length === 0) {
      logger.warn(
        { symbol: tracked.symbol, kind, milestone },
        "Milestone was delivered but pending state was retained; it will be cleared without resend",
      );
    }
    logger.info(
      {
        symbol: tracked.symbol,
        kind,
        milestone,
        sentCount: outcome.kind === "delivered" ? outcome.sentCount : 0,
        unavailable: outcome.kind === "abandoned",
      },
      outcome.kind === "delivered"
        ? "Milestone notification durably queued"
        : "Milestone notification closed: all recipients unavailable",
    );
    return true;
  }

  if (outcome.kind === "ambiguous") {
    logger.error(
      {
        symbol: tracked.symbol,
        kind,
        milestone,
        description: outcome.description,
      },
      "Milestone delivery outcome is ambiguous — automatic resend disabled",
    );
    return false;
  }

  const failed = await dbWriteBestEffort(
    "trackedSignal/milestone-delivery-retry",
    () =>
      db
        .update(trackedSignalsTable)
        .set({
          pendingMilestoneStatus: "failed",
          pendingMilestoneLeaseUntil: new Date(
            Date.now() + MILESTONE_RETRY_DELAY_MS,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.id, tracked.id),
            eq(trackedSignalsTable.pendingMilestone, milestone),
            eq(trackedSignalsTable.pendingMilestoneKind, kind),
            eq(trackedSignalsTable.pendingMilestoneStatus, "sending"),
          ),
        )
        .returning({ id: trackedSignalsTable.id }),
  );
  if (!failed || failed.length === 0) {
    logger.error(
      {
        symbol: tracked.symbol,
        kind,
        milestone,
        description: outcome.description,
      },
      "Confirmed milestone failure could not be persisted — resend disabled to prevent duplicates",
    );
    return false;
  }
  logger.warn(
    {
      symbol: tracked.symbol,
      kind,
      milestone,
      description: outcome.description,
    },
    "Milestone notification not delivered — queued for retry",
  );
  return false;
}

async function queueReachedMilestoneAfterClaim(
  tracked: TrackedSignal,
  milestone: number,
  currentPrice: number,
  trailingStop: number,
  claim: (tx: TelegramPhotoOutboxTransaction) => Promise<boolean>,
): Promise<{ claimed: boolean; queued: number }> {
  const health = await fetchMilestoneHealth(tracked.symbol, currentPrice);
  return broadcastPhotoAfterClaim(
    milestoneImageFor(tracked, milestone) ?? POSITION_UPDATE_IMG,
    msgMilestone(tracked, milestone, currentPrice, trailingStop, null, health),
    milestoneOutboxEventKey(tracked, "milestone", milestone),
    claim,
  );
}

async function retryPendingMilestoneNotification(
  tracked: TrackedSignal,
  currentPrice: number,
  trailingStop: number,
): Promise<boolean> {
  const milestone = tracked.pendingMilestone;
  const kind = tracked.pendingMilestoneKind;
  if (!milestone || !isPendingMilestoneKind(kind)) return false;

  const now = new Date();
  if (
    !canRetryPendingMilestone(
      tracked.pendingMilestoneStatus,
      tracked.pendingMilestoneLeaseUntil,
      now,
    )
  ) {
    if (
      tracked.pendingMilestoneStatus === "failed" ||
      (tracked.pendingMilestoneLeaseUntil &&
        tracked.pendingMilestoneLeaseUntil > now)
    ) {
      return true;
    }

    // A legacy direct-send attempt always creates its recipient ledger before
    // the first Telegram request. If no such ledger exists, the old worker
    // died before dispatch and it is safe to recreate the durable v3 outbox
    // event instead of silently deleting the milestone (the FF +10 failure).
    let hasLegacyLedger = true;
    try {
      hasLegacyLedger = await hasLegacyMilestoneRecipientLedger(
        tracked,
        kind,
        milestone,
      );
    } catch (err) {
      logger.warn(
        { err, trackedSignalId: tracked.id, kind, milestone },
        "Pending milestone recovery could not inspect recipient ledger",
      );
      return true;
    }
    if (!hasLegacyLedger) {
      const [reclaimed] = await dbWriteStrict(
        "trackedSignal/milestone-outbox-recovery-claim",
        () =>
          db
            .update(trackedSignalsTable)
            .set({
              pendingMilestoneStatus: "sending",
              pendingMilestoneLeaseUntil: new Date(
                Date.now() + MILESTONE_DELIVERY_LEASE_MS,
              ),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(trackedSignalsTable.id, tracked.id),
                eq(trackedSignalsTable.pendingMilestone, milestone),
                eq(trackedSignalsTable.pendingMilestoneKind, kind),
                or(
                  isNull(trackedSignalsTable.pendingMilestoneStatus),
                  eq(trackedSignalsTable.pendingMilestoneStatus, "sending"),
                ),
                or(
                  isNull(trackedSignalsTable.pendingMilestoneLeaseUntil),
                  lt(trackedSignalsTable.pendingMilestoneLeaseUntil, now),
                ),
              ),
            )
            .returning({ id: trackedSignalsTable.id }),
      );
      if (!reclaimed) return true;
      await finishMilestoneNotification(
        tracked,
        kind,
        milestone,
        tracked.pendingMilestonePrice ?? currentPrice,
        tracked.pendingMilestoneTrailingStop ?? trailingStop,
      );
      return true;
    }

    // A legacy direct-send ledger means that Telegram may already have accepted
    // one recipient request. Preserve it for audit rather than replaying that
    // historical event after this rollout.
    const suppressed = await dbWriteBestEffort(
      "trackedSignal/milestone-ambiguous-clear",
      () =>
        db
          .update(trackedSignalsTable)
          .set({
            pendingMilestone: null,
            pendingMilestoneKind: null,
            pendingMilestonePrice: null,
            pendingMilestoneTrailingStop: null,
            pendingMilestoneStatus: null,
            pendingMilestoneLeaseUntil: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(trackedSignalsTable.id, tracked.id),
              eq(trackedSignalsTable.pendingMilestone, milestone),
              eq(trackedSignalsTable.pendingMilestoneKind, kind),
              or(
                isNull(trackedSignalsTable.pendingMilestoneStatus),
                eq(trackedSignalsTable.pendingMilestoneStatus, "sending"),
              ),
              or(
                isNull(trackedSignalsTable.pendingMilestoneLeaseUntil),
                lt(trackedSignalsTable.pendingMilestoneLeaseUntil, now),
              ),
            ),
          )
          .returning({ id: trackedSignalsTable.id }),
    );
    if (suppressed && suppressed.length > 0) {
      logger.warn(
        { symbol: tracked.symbol, kind, milestone },
        "Ambiguous or legacy milestone pending state cleared without resend",
      );
      return false;
    }
    return true;
  }

  const claimed = await dbWriteStrict(
    "trackedSignal/milestone-retry-claim",
    () =>
      db
        .update(trackedSignalsTable)
        .set({
          pendingMilestoneStatus: "sending",
          pendingMilestoneLeaseUntil: new Date(
            Date.now() + MILESTONE_DELIVERY_LEASE_MS,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.id, tracked.id),
            eq(trackedSignalsTable.pendingMilestone, milestone),
            eq(trackedSignalsTable.pendingMilestoneKind, kind),
            eq(trackedSignalsTable.pendingMilestoneStatus, "failed"),
            or(
              isNull(trackedSignalsTable.pendingMilestoneLeaseUntil),
              lt(trackedSignalsTable.pendingMilestoneLeaseUntil, now),
            ),
          ),
        )
        .returning({ id: trackedSignalsTable.id }),
  );
  if (claimed.length === 0) return true;

  await finishMilestoneNotification(
    tracked,
    kind,
    milestone,
    tracked.pendingMilestonePrice ?? currentPrice,
    tracked.pendingMilestoneTrailingStop ?? trailingStop,
  );
  return true;
}

/**
 * Continue the normal milestone stream after the Impulse Buy core has closed.
 * The runner is still the same position, so lastMilestone remains the single
 * monotonic milestone cursor. A durable peak is used for crash recovery: if a
 * worker missed a live tick, the next cycle can still announce the highest
 * level that the open runner actually reached.
 */
async function processImpulseRunnerMilestone(
  tracked: TrackedSignal,
  runnerPeakPrice: number,
  runnerTrailingStop: number | null,
  options: { sequentialCeiling?: number } = {},
): Promise<boolean> {
  const runnerEntryPrice = tracked.originalEntryPrice ?? tracked.entryPrice;
  const durableRunnerStop =
    runnerTrailingStop ??
    tracked.runnerTrailingStopLevel ??
    resolveImpulseRunnerEmergencyStopPrice(
      runnerEntryPrice,
      tracked.stopLossPct,
      tracked.entryPolicyVersion,
    );

  // Never overwrite an older pending delivery. This also repairs rows whose
  // worker died after the economic milestone claim but before outbox creation.
  if (
    await retryPendingMilestoneNotification(
      tracked,
      runnerPeakPrice,
      durableRunnerStop,
    )
  ) {
    return true;
  }

  const runnerPeakPnl = impulseRunnerPnlPercent(
    runnerEntryPrice,
    runnerPeakPrice,
  );
  const reachedMilestone =
    options.sequentialCeiling == null
      ? nextMilestone(tracked.lastMilestone, runnerPeakPnl)
      : nextSequentialMilestone(
          MILESTONES,
          tracked.lastMilestone,
          runnerPeakPnl,
          options.sequentialCeiling,
        );
  if (reachedMilestone == null) return false;

  const delivery = await queueReachedMilestoneAfterClaim(
    tracked,
    reachedMilestone,
    runnerPeakPrice,
    durableRunnerStop,
    async (tx) => {
      const claimed = await tx
        .update(trackedSignalsTable)
        .set({
          lastMilestone: reachedMilestone,
          runnerPeakPrice: maxPeakPriceSql(runnerPeakPrice),
          runnerTrailingStopLevel:
            runnerTrailingStop == null
              ? trackedSignalsTable.runnerTrailingStopLevel
              : sql<number>`GREATEST(COALESCE(${trackedSignalsTable.runnerTrailingStopLevel}, 0), ${runnerTrailingStop})`,
          peakPrice: maxPeakPriceSql(runnerPeakPrice),
          updatedAt: new Date(),
        })
        .where(
          sql`${trackedSignalsTable.id} = ${tracked.id}
            AND ${trackedSignalsTable.status} = 'in_run'
            AND ${trackedSignalsTable.policyVersion} = ${IMPULSE_RUNNER_POLICY_VERSION}
            AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
            AND ${trackedSignalsTable.runnerState} = 'open'
            AND ${trackedSignalsTable.pendingMilestone} IS NULL
            AND (
              ${trackedSignalsTable.lastMilestone} IS NULL
              OR ${trackedSignalsTable.lastMilestone} < ${reachedMilestone}
            )`,
        )
        .returning({ id: trackedSignalsTable.id });
      return claimed.length > 0;
    },
  );
  if (!delivery.claimed) return true;
  logger.info(
    {
      symbol: tracked.symbol,
      milestone: reachedMilestone,
      runnerPeakPnl: runnerPeakPnl.toFixed(2),
      runnerTrailingStop: durableRunnerStop,
      queued: delivery.queued,
    },
    "FastCycle: IMPULSE RUNNER MILESTONE 🎯",
  );
  return true;
}

// ── Add signal to tracker ─────────────────────────────────────────────────────
// ── Индивидуальный стоп-лосс по Liquidation Heatmap ──────────────────────────
// Эффективная глубина стопа сигнала: персональная (liq heatmap) или стандартная -10%.
// Положительное число — глубина в % от входа.
export function effStopPct(t: {
  symbol?: string | null;
  stopLossPct?: number | null;
}): number {
  if (t.symbol === "BTC-USDT" || t.symbol === "BTCUSDT") {
    return 1;
  }
  return t.stopLossPct != null && t.stopLossPct > 0 ? t.stopLossPct : STOP_LOSS;
}

export function stopLossFill(
  t: {
    sentimentKey?: string | null;
    symbol?: string | null;
    entryPrice: number;
    stopLossPct?: number | null;
  },
  observedPrice: number,
  observedPnl: number,
): { exitPrice: number; pnl: number } {
  return exactStopFill(
    t.sentimentKey,
    t.entryPrice,
    effStopPct(t),
    observedPrice,
    observedPnl,
  );
}

interface LiqStopFields {
  stopLossPrice: number | null;
  stopLossPct: number | null;
  stopSource: "liq_heatmap" | "pattern" | "standard";
  takeTargets: { price: number; pctFromEntry: number; liqUsd: number }[] | null;
}

// Observational closed-bar volume (1H + 30m) for every pattern; fail-open.
async function captureEntryVolumeContext(
  symbol: string,
): Promise<EntryVolumeContext> {
  const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
    Promise.race([
      p,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_500)),
    ]).catch(() => null);
  const toCandles = (rows: BingXKline[] | null) =>
    rows
      ? rows.map((k) => ({
          time: Number(k.time),
          close: Number(k.close),
          volume: Number(k.volume),
        }))
      : null;
  const [k1h, k30m] = await Promise.all([
    withTimeout(
      getKlines(symbol, "1h", 60).then((r) =>
        withAggregatedKlineVolume(symbol, "1h", r),
      ),
    ),
    withTimeout(
      getKlines(symbol, "30m", 60).then((r) =>
        withAggregatedKlineVolume(symbol, "30m", r),
      ),
    ),
  ]);
  return buildEntryVolumeContext({
    candles1h: toCandles(k1h),
    candles30m: toCandles(k30m),
    now: Date.now(),
  });
}

/**
 * Расчёт персонального стопа/тейков по CoinGlass Liquidation Heatmap.
 * 2026-07-15: liq-стоп клампится сверху паттерн-лимитом (PATTERN_MAX_STOP) —
 * раньше кластер на −13…−15% сохранялся как есть и переопределял глобальный −10%
 * (avgLoss −15.45% на проде). Если heatmap недоступен, а у паттерна есть
 * документированный стоп (−5…−8%) — персистим его напрямую (stopSource="pattern"),
 * чтобы effStopPct не падал в глобальный −10%.
 */
async function computeLiqStopFields(
  symbol: string,
  entryPrice: number,
  sentimentKey?: string | null,
): Promise<LiqStopFields> {
  if (symbol === "BTC-USDT" || symbol === "BTCUSDT") {
    return {
      stopLossPrice: entryPrice > 0 ? entryPrice * 0.99 : null,
      stopLossPct: 1,
      stopSource: "pattern",
      takeTargets: null,
    };
  }

  const patternMax = getPatternMaxStop(sentimentKey);

  // liquidation_cascade: heatmap кластеры часто дают -7...-8% стоп, который
  // выносится волатильностью самого каскада (45% стопов = ложные, цена отскочила
  // 10-33% после выхода). Всегда используем паттерн-стоп (-10%).
  // Тейки из heatmap сохраняем если доступны.
  if (sentimentKey === "liquidation_cascade") {
    const fixedStopPrice =
      entryPrice > 0 ? entryPrice * (1 - patternMax / 100) : null;
    return {
      stopLossPrice: fixedStopPrice,
      stopLossPct: patternMax,
      stopSource: "pattern",
      takeTargets: null,
    };
  }

  // Heatmap недоступен: паттерн с документированным стопом → персистим его.
  if (patternMax < STOP_LOSS) {
    return {
      stopLossPrice:
        entryPrice > 0 ? entryPrice * (1 - patternMax / 100) : null,
      stopLossPct: patternMax,
      stopSource: "pattern",
      takeTargets: null,
    };
  }
  return {
    stopLossPrice: null,
    stopLossPct: null,
    stopSource: "standard",
    takeTargets: null,
  };
}

const lastTrackSignalErrors = new Map<string, string>();
/** Последняя ошибка trackSignal по символу — для причины отказа в scan_reject_log. */
export function takeTrackSignalError(symbol: string): string {
  const m = lastTrackSignalErrors.get(symbol) ?? "unknown";
  lastTrackSignalErrors.delete(symbol);
  return m;
}

export async function trackSignal(params: {
  symbol: string;
  signalId: number | null;
  signalType: string;
  sentiment?: string | null;
  sentimentKey?: string | null;
  stealthDetectionMethod?:
    | "quiet_zone_breakout"
    | "abneon_support_bounce"
    | "fresh_24h_high_breakout"
    | "range_4h_breakout"
    | null;
  alphaScore?: number | null;
  entryPrice: number;
  /** true = сигнал шорт (цена должна упасть). Влияет на направление стопа и целей. */
  isShort?: boolean;
  /** Явный override prescanCycles — для фоновых паттернов (liq_cascade и др.),
   *  чьи символы отсутствуют в prescanTracker. Если не передан, берётся из getPrescanEntry. */
  prescanCycles?: number | null;
  entryOi?: number | null;
  initialStatus?: "active";
  entryCvd15m?: boolean | null;
  entryCvd30m?: boolean | null;
  entryCvd1h?: boolean | null;
  entryCvd4h?: boolean | null;
  marketCapUsd?: number | null;
  // Entry metrics snapshot — для анализа качества сигналов post-factum
  entryOi30m?: number | null;
  entryOi1h?: number | null;
  entryOi4h?: number | null;
  entryOi24h?: number | null;
  /** Frozen before the LC fire decision, when supplied by the fire cycle. */
  entryPrice1h?: number | null;
  entryPrice3h?: number | null;
  entryPrice3hProvenance?: string | null;
  plmP24hCap18Pass?: boolean | null;
  plmFutTakerShadow?: string | null;
  plmOi30mShadow?: string | null;
  entryScoreBreakdown?: string | null;
  entryGradeReason?: string | null;
  decisionMetrics?: Record<string, unknown>;
  entryFutTakerNetBuy?: number | null;
  entrySpotVolMult?: number | null;
  entryFutVolMult?: number | null;
  entrySpotVol24h?: number | null;
  entrySpotMcapPct?: number | null;
  entrySpotTakerNetBuy?: number | null;
  entrySpotNetBuy1h?: number | null;
  entrySpotNetBuy4h?: number | null;
  entrySpotNetBuy24h?: number | null;
  entrySource?: string | null;
  // liq_cascade specific trigger params — для ретроспективного анализа
  entryLiqLong1h?: number | null;
  entryLiqLong24h?: number | null;
  entryLiqRatio?: number | null;
  entryLiqReason?: string | null;
  /** Preserve the original fire time when repairing a delivered orphan signal. */
  detectedAt?: Date;
  /** Absolute initial stop (Stealth fresh-24H-high); overrides the pattern stop. */
  fixedStopPrice?: number | null;
}): Promise<"new" | "reentry" | "skip" | false> {
  if (isSignalSymbolExcluded(params.symbol)) {
    logger.info(
      { symbol: params.symbol, signalType: params.signalType },
      "Signal suppressed by excluded-symbol policy",
    );
    return "skip";
  }
  assertMarketCycleLeaseOwnership("tracked signal persistence");
  try {
    // Use the time the signal was detected, rather than the end of enrichment.
    const signalDetectedAt = params.detectedAt ?? new Date();
    const existing = await db
      .select({
        id: trackedSignalsTable.id,
        status: trackedSignalsTable.status,
        entryPrice: trackedSignalsTable.entryPrice,
        signalType: trackedSignalsTable.signalType,
        updatedAt: trackedSignalsTable.updatedAt,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          eq(trackedSignalsTable.symbol, params.symbol),
          inArray(trackedSignalsTable.status, ["active", "in_run"]),
        ),
      )
      .limit(1);

    // Является ли новый сигнал апгрейдом относительно текущего?
    // ghost_pump/ghost_pump_early → alpha/super_alpha: более строгая подтверждённая система
    // Апгрейд: НЕ сбрасываем цену входа и статус — позиция продолжается,
    // но обновляем метаданные (тип, сентимент) чтобы трекер отображал актуальный паттерн.
    const GHOST_TYPES = new Set(["ghost_pump", "ghost_pump_early"]);
    const ALPHA_TYPES = new Set(["alpha", "super_alpha"]);

    if (existing.length > 0) {
      const rec = existing[0];
      const isGhostToAlpha =
        GHOST_TYPES.has(rec.signalType ?? "") &&
        ALPHA_TYPES.has(params.signalType);

      // in_run: монета уже летит — обновляем метаданные если это апгрейд, иначе пропускаем.
      // В любом случае НЕ посылаем повторный алерт (return "skip").
      if (rec.status === "in_run") {
        if (isGhostToAlpha) {
          await dbWriteStrict("trackedSignal/ghost-inRun-upgrade", () =>
            db
              .update(trackedSignalsTable)
              .set({
                signalId: params.signalId,
                signalType: params.signalType,
                sentiment: params.sentiment ?? null,
                sentimentKey: params.sentimentKey ?? null,
                alphaScore: params.alphaScore ?? null,
                updatedAt: new Date(),
              })
              .where(eq(trackedSignalsTable.id, rec.id)),
          );
          logger.info(
            {
              symbol: params.symbol,
              from: rec.signalType,
              to: params.signalType,
            },
            "📈 trackSignal: ghost_pump in_run → alpha (метаданные обновлены, алерт не дублируем)",
          );
        } else {
          logger.info(
            { symbol: params.symbol, status: rec.status, type: rec.signalType },
            "Already in_run — skipping duplicate alert",
          );
        }
        return "skip"; // позиция уже летит — не дублируем алерт
      }

      // Scanner-originated re-entry candidate: evaluate before the generic
      // active duplicate guard, but persist only immutable shadow telemetry.
      const scannerReentryCandidate =
        (params.entryFutVolMult ?? 0) >= RE_ENTRY_VOL_MULT &&
        Date.now() - rec.updatedAt.getTime() >=
          ACCUMULATION_REENTRY_H * 3_600_000;
      if (scannerReentryCandidate) {
        const candidateAt = new Date();
        const boundaryAt = new Date(
          Math.floor(candidateAt.getTime() / 3_600_000) * 3_600_000,
        );
        const eventKey = `track_signal:v1:${rec.id}:${params.signalId ?? "none"}:${boundaryAt.toISOString()}`;
        await dbWriteStrict("trackedSignal/reentry-shadow-candidate", () =>
          db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext(${`reentry:${rec.id}:track_signal:v1`}))`,
            );
            const recent = await tx.execute(sql`
              SELECT 1 FROM reentry_shadow_events
              WHERE tracked_signal_id = ${rec.id} AND source = 'track_signal'
                AND candidate_at > ${new Date(Date.now() - 12 * 3_600_000)}
              LIMIT 1
            `);
            if (recent.rows.length) return;
            await tx
              .insert(reentryShadowEventsTable)
              .values({
                eventKey,
                source: "track_signal",
                detectorVersion: "reentry_shadow_v1",
                trackedSignalId: rec.id,
                symbol: params.symbol,
                pattern: params.sentimentKey ?? params.signalType,
                candidateAt,
                proposedReentryPrice: params.entryPrice,
                originalEntryPrice: rec.entryPrice,
                currentPnlPct: null,
                volumeMultiplier: params.entryFutVolMult ?? null,
                spotVolumeMultiplier: params.entrySpotVolMult ?? null,
                oiEvidence: params.entryOi ?? null,
                cvdEvidence: JSON.stringify({
                  entryCvd15m: params.entryCvd15m ?? null,
                  entryCvd30m: params.entryCvd30m ?? null,
                  entryCvd1h: params.entryCvd1h ?? null,
                  entryCvd4h: params.entryCvd4h ?? null,
                }),
                context: JSON.stringify({
                  source: "scanner",
                  isShort: params.isShort ?? false,
                }),
              })
              .onConflictDoNothing();
          }),
        );
        return "skip";
      }

      // active: позиция уже открыта — НЕ перезаписываем цену входа и НЕ дублируем алерт.
      // Исключение: ghost_pump → alpha апгрейд: обновляем тип и сентимент тихо.
      if (rec.status === "active") {
        if (isGhostToAlpha) {
          await dbWriteStrict("trackedSignal/ghost-active-upgrade", () =>
            db
              .update(trackedSignalsTable)
              .set({
                signalId: params.signalId,
                signalType: params.signalType,
                sentiment: params.sentiment ?? null,
                sentimentKey: params.sentimentKey ?? null,
                alphaScore: params.alphaScore ?? null,
                updatedAt: new Date(),
              })
              .where(eq(trackedSignalsTable.id, rec.id)),
          );
          logger.info(
            {
              symbol: params.symbol,
              from: rec.signalType,
              to: params.signalType,
            },
            "📈 trackSignal: ghost_pump active → alpha (метаданные обновлены, алерт не дублируем)",
          );
        } else {
          logger.info(
            {
              symbol: params.symbol,
              existingEntry: rec.entryPrice,
              newPrice: params.entryPrice,
            },
            "Already active — skipping duplicate alert (entry price protected)",
          );
        }
        return "skip"; // позиция уже активна — не дублируем алерт
      }

      // Accumulation re-entry is a detector candidate only. Never reset the
      // tracked position, send Telegram, or increment the legacy counter.
      const candidateAt = new Date();
      const boundaryAt = new Date(
        Math.floor(candidateAt.getTime() / 3_600_000) * 3_600_000,
      );
      const eventKey = `track_signal:v1:${rec.id}:${params.signalId ?? "none"}:${boundaryAt.toISOString()}`;
      await dbWriteStrict("trackedSignal/reentry-shadow-candidate", () =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`reentry:${rec.id}:track_signal:v1`}))`,
          );
          const recent = await tx.execute(sql`
            SELECT 1 FROM reentry_shadow_events
            WHERE tracked_signal_id = ${rec.id}
              AND source = 'track_signal'
              AND candidate_at > ${new Date(Date.now() - 12 * 3_600_000)}
            LIMIT 1
          `);
          if (recent.rows.length) return;
          await tx
            .insert(reentryShadowEventsTable)
            .values({
              eventKey,
              source: "track_signal",
              detectorVersion: "reentry_shadow_v1",
              trackedSignalId: rec.id,
              symbol: params.symbol,
              pattern: params.sentimentKey ?? params.signalType,
              candidateAt,
              proposedReentryPrice: params.entryPrice,
              originalEntryPrice: rec.entryPrice,
              currentPnlPct: null,
              oiEvidence: params.entryOi ?? null,
              cvdEvidence: JSON.stringify({
                entryCvd15m: params.entryCvd15m ?? null,
                entryCvd30m: params.entryCvd30m ?? null,
                entryCvd1h: params.entryCvd1h ?? null,
                entryCvd4h: params.entryCvd4h ?? null,
              }),
              volumeMultiplier:
                params.entryFutVolMult ?? params.entrySpotVolMult ?? null,
              context: JSON.stringify({
                source: "trackSignal",
                previousStatus: rec.status,
                decisionMetrics: params.decisionMetrics ?? null,
              }),
            })
            .onConflictDoNothing();
        }),
      );
      logger.info(
        { symbol: params.symbol, trackedSignalId: rec.id },
        "trackSignal: re-entry candidate recorded (shadow-only)",
      );
      return "skip";
      /*
       * Historical actionable re-entry implementation intentionally retained
       * below as dead code in git history, not in the lifecycle path.
       */
      /*
        db
          .update(trackedSignalsTable)
          .set({
            signalId: params.signalId,
            signalType: params.signalType,
            sentiment: params.sentiment ?? null,
            sentimentKey: params.sentimentKey ?? null,
            stealthDetectionMethod: params.stealthDetectionMethod ?? null,
            alphaScore: params.alphaScore ?? null,
            entryPrice3h: params.entryPrice3h ?? null,
            entryPrice3hProvenance: params.entryPrice3hProvenance ?? null,
            plmP24hCap18Pass: params.plmP24hCap18Pass ?? null,
            plmFutTakerShadow: params.plmFutTakerShadow ?? null,
            plmOi30mShadow: params.plmOi30mShadow ?? null,
            entryScoreBreakdown: params.entryScoreBreakdown ?? null,
            entryGradeReason: params.entryGradeReason ?? null,
            decisionMetrics: params.decisionMetrics ?? null,
            impulseDecisionMetrics:
              params.sentimentKey === "impulse_buy"
                ? (params.decisionMetrics ?? null)
                : null,
            isShort: params.isShort ?? false,
            entryPrice: params.entryPrice,
            entryOi: params.entryOi ?? null,
            peakPrice: params.entryPrice,
            trailingStopLevel: null,
            lastMilestone: null,
            stopLossPrice: liqReset.stopLossPrice,
            stopLossPct: liqReset.stopLossPct,
            stopSource: liqReset.stopSource,
            takeTargets: liqReset.takeTargets,
            // Новые позиции используют полный единичный вход. NULL split-поля
            // являются важным признаком отсутствия второй заявки.
            entryPolicyVersion: SINGLE_ENTRY_POLICY_VERSION,
            splitLimitPrice: null,
            splitFilledAt: null,
            policyVersion: isBitcoinTrackedSignal({ symbol: params.symbol })
              ? null
              : selectImpulseRunnerPolicy({
                  sentimentKey: params.sentimentKey,
                  isShort: params.isShort,
                }),
            // Freeze the immutable market entry together with the policy.
            originalEntryPrice:
              !isBitcoinTrackedSignal({ symbol: params.symbol }) &&
              selectImpulseRunnerPolicy({
                sentimentKey: params.sentimentKey,
                isShort: params.isShort,
              }) != null
                ? params.entryPrice
                : null,
            runnerState: null,
            coreClosedAt: null,
            coreExitPrice: null,
            corePnlPercent: null,
            coreCloseEventKey: null,
            runnerPeakPrice: null,
            runnerTrailingStopLevel: null,
            runnerTrailingStopArmedAt: null,
            runnerExitPrice: null,
            runnerPnlPercent: null,
            runnerClosedAt: null,
            runnerCloseEventKey: null,
            lastUpdateState: null,
            healthPendingState: null,
            healthPendingCount: 0,
            healthSentTypes: [],
            healthOrdinarySentCount: 0,
            healthLastOrdinaryAt: null,
            status: "active",
            reEntryCount: 0,
            detectedAt: reentryAt,
            updatedAt: new Date(),
          })
          .where(eq(trackedSignalsTable.id, rec.id)),
      );

      logger.info(
        { symbol: params.symbol, oldEntry, newEntry: params.entryPrice },
        "📍 Signal tracker reset (accumulation → active) — fresh entry price",
      );
      await dbWriteBestEffort("trackedSignal/reentry-decision-snapshot", () =>
        snapshotTrackedDecision(rec.id, {
          reentryDecisionAt: reentryAt,
          source: "tracked_signals",
        }),
      );
      return "reentry";
      */
    }

    // ── Пост-памп фильтр: остаточные индикаторы после отработки сигнала ──────
    // После памп OI/объём/тейкер остаются "задранными" ещё несколько часов.
    // Если монета недавно закрылась, а цена ещё не вернулась к уровню предыдущего входа —
    // это остатки старого памп, не новый сетап → пропускаем.
    // Разрешаем новый сигнал когда цена вернётся в пределы 8% от старого входа.
    if (!params.initialStatus) {
      const postPumpWindow = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const recentlyClosed = await db
        .select({
          id: trackedSignalsTable.id,
          status: trackedSignalsTable.status,
          entryPrice: trackedSignalsTable.entryPrice,
        })
        .from(trackedSignalsTable)
        .where(
          and(
            eq(trackedSignalsTable.symbol, params.symbol),
            inArray(trackedSignalsTable.status, ["profit", "stop_loss"]),
            gte(trackedSignalsTable.updatedAt, postPumpWindow),
          ),
        )
        .limit(1);

      if (recentlyClosed.length > 0) {
        const prevEntry = Number(recentlyClosed[0].entryPrice);
        const elevationPct =
          prevEntry > 0
            ? ((params.entryPrice - prevEntry) / prevEntry) * 100
            : 0;
        if (elevationPct > 8) {
          logger.info(
            {
              symbol: params.symbol,
              closedStatus: recentlyClosed[0].status,
              prevEntry,
              currentEntry: params.entryPrice,
              elevationPct: elevationPct.toFixed(1) + "%",
            },
            "🔇 trackSignal: пост-памп — цена ещё задрана выше предыдущего входа, сигнал пропущен",
          );
          return "skip";
        }
      }
    }

    // ── Prescan context at fire time ─────────────────────────────────────────
    const prescanE = getPrescanEntry(params.symbol);
    let price24hAtFire = prescanE?.lastPrice24h ?? null;
    const prescanCycles = params.prescanCycles ?? prescanE?.cycleCount ?? null;

    // ── Универсальное обогащение метрик входа (2026-07-15) ──────────────────
    // Анализ прода показал 87–98% NULL в entry-метриках: паттерны передавали
    // только «свои» поля. Общий знаменатель нужен для сравнения победителей и
    // проигравших. Приоритет: params → prescanTracker (fail-open, null если нет).
    let entryOi30m = params.entryOi30m ?? prescanE?.lastOi30m ?? null;
    let entryOi1h = params.entryOi1h ?? prescanE?.lastOi1h ?? null;
    let entryOi4h = params.entryOi4h ?? prescanE?.lastOi4h ?? null;
    let entryOi24h = params.entryOi24h ?? prescanE?.lastOi24h ?? null;
    let entryPrice1h: number | null =
      params.entryPrice1h !== undefined
        ? params.entryPrice1h
        : (prescanE?.lastPrice1h ?? null);
    if (entryPrice1h === null && params.entryPrice1h === undefined) {
      // background job сигнал (liq_cascade и др.) — prescan не имеет lastPrice1h
      // для этого символа. Вычисляем из 3 × 30m klines (fail-open, timeout 3s).
      const _kl = await Promise.race([
        getKlines(params.symbol, "30m", 4),
        new Promise<BingXKline[]>((_, r) =>
          setTimeout(() => r(new Error("price1h klines timeout")), 3_000),
        ),
      ]).catch(() => [] as BingXKline[]);
      if (_kl.length >= 3) {
        const _c = parseFloat(_kl[_kl.length - 1].close);
        const _b = parseFloat(_kl[_kl.length - 3].close);
        entryPrice1h = _b > 0 ? ((_c - _b) / _b) * 100 : null;
      }
    }
    let entryCvd15m = params.entryCvd15m ?? prescanE?.lastCvd15m ?? null;
    let entryCvd30m = params.entryCvd30m ?? prescanE?.lastCvd30m ?? null;
    let entryCvd1h = params.entryCvd1h ?? prescanE?.lastCvd1h ?? null;
    let entryCvd4h = params.entryCvd4h ?? prescanE?.lastCvd4h ?? null;
    const entryFutVolMult =
      params.entryFutVolMult ?? prescanE?.lastVolMult ?? null;
    let entrySpotTakerNetBuy =
      params.entrySpotTakerNetBuy ?? prescanE?.lastSpotTakerNetBuy ?? null;
    let entrySpotNetBuy1h =
      params.entrySpotNetBuy1h ?? prescanE?.lastSpotNetBuy1h ?? null;
    let entrySpotNetBuy4h = params.entrySpotNetBuy4h ?? null;
    let entrySpotNetBuy24h = params.entrySpotNetBuy24h ?? null;
    // spotVolMult: prescan fallback (lastSpotVol1h / spotVolAvg1h)
    const entrySpotVolMult =
      params.entrySpotVolMult ??
      (prescanE?.spotVolAvg1h &&
      prescanE.lastSpotVol1h &&
      prescanE.spotVolAvg1h > 0
        ? prescanE.lastSpotVol1h / prescanE.spotVolAvg1h
        : null);

    // Funding (BingX) + SpotVol 24h (CoinGlass, кэш 30 мин)
    // — универсально для ВСЕХ сигналов. Никогда не блокируют INSERT: таймаут 4с, любая ошибка → null.
    let entryFundingRate: number | null = null;
    let entryWhaleIndex: number | null = null;
    let entryGlobalLongPct: number | null = null;
    let entryObBids: number | null = null;
    let entryObAsks: number | null = null;
    let entryObRatio: number | null = null;
    let entryFutTakerNetBuy: number | null = params.entryFutTakerNetBuy ?? null;
    let entrySpotVol24h: number | null = params.entrySpotVol24h ?? null;
    let entrySpotMcapPct: number | null = params.entrySpotMcapPct ?? null;
    try {
      const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
        Promise.race([
          p.catch(() => null),
          new Promise<null>((res) => setTimeout(() => res(null), 4000)),
        ]);
      // WI (getTokenWhaleIndex) обращается к CoinGlass,
      // который под нагрузкой отвечает за 5–8с → даём 8с как OB, иначе таймаут = null при записи.
      const withTimeout8s = <T>(p: Promise<T>): Promise<T | null> =>
        Promise.race([
          p.catch(() => null),
          new Promise<null>((res) => setTimeout(() => res(null), 8000)),
        ]);
      // OB: запускаем независимо с таймаутом 8s (вместо 4s) — BingX быстрый, но под нагрузкой
      // event loop может тормозить. Параллельно с основным Promise.all, не блокирует его.
      const _obRace = Promise.race([
        getOrderBookAnalysis(params.symbol, 20).catch(() => null),
        new Promise<null>((res) => setTimeout(() => res(null), 8000)),
      ]);
      const [
        funding,
        tokenWi,
        spotVol24hRaw,
        symbolTicker,
        liveCvd,
        liveTaker,
        liveSpotTaker,
        liveOI,
      ] = await Promise.all([
        withTimeout(getFundingRate(params.symbol)),
        withTimeout8s(getTokenWhaleIndex(params.symbol)),
        entrySpotVol24h === null
          ? withTimeout(
              getFsVolume(params.symbol).then((r) => r.spotVolUsd24h ?? null),
            )
          : Promise.resolve(null),
        // live fallback: тикер символа для price24hAtFire (если prescanE не дал — background job сигнал)
        price24hAtFire === null
          ? withTimeout(getFutureTicker(params.symbol))
          : Promise.resolve(null),
        // live fallback: SpotCVD для background job сигналов (liq_cascade, spot_ob) где prescanE = null
        entryCvd30m === null && entryCvd1h === null && entryCvd4h === null
          ? withTimeout(getSpotCvdMtf(params.symbol))
          : Promise.resolve(null),
        // Futures taker net buy % (CoinGlass) — universal fallback для background job сигналов
        // где prescanE = null и params не передал значение
        entryFutTakerNetBuy === null
          ? withTimeout(getCoinglassTakerFlow(params.symbol).catch(() => null))
          : Promise.resolve(null),
        // Spot taker net buy % — universal live fallback: prescanTracker.lastSpotTakerNetBuy
        // обновляется batch-ом в конце скана, поэтому для main-scan сигналов может быть null.
        // limit=96 даёт 24h свечей → таже функция возвращает 1h/4h/24h агрегаты за 1 CG-запрос.
        // scanner.ts продолжает использовать limit=4 (только дашборд, не DB-хранилище).
        entrySpotTakerNetBuy === null ||
        entrySpotNetBuy4h === null ||
        entrySpotNetBuy24h === null
          ? withTimeout(getSpotTakerFlow(params.symbol, 96))
          : Promise.resolve(null),
        // OI live fallback: для background job сигналов (liq_cascade) prescanE = null
        // → все OI-поля null. Добираем OI из CoinGlass напрямую с тем же 8с таймаутом.
        entryOi30m === null && entryOi1h === null && entryOi4h === null
          ? withTimeout8s(
              getCoinglassOI(params.symbol, params.entryPrice).catch(
                () => null,
              ),
            )
          : Promise.resolve(null),
      ]);
      // OB: ждём результат (уже работает ~4s параллельно с Promise.all, максимум ещё 4s)
      const obResult = await _obRace;
      if (funding?.lastFundingRate != null) {
        const fr = parseFloat(funding.lastFundingRate); // raw decimal: 0.0001 = 0.01%
        if (Number.isFinite(fr)) entryFundingRate = fr;
      }
      if (tokenWi != null && Number.isFinite(tokenWi))
        entryWhaleIndex = tokenWi;
      {
        const gr = await withTimeout8s(
          getGlobalAccountRatio(params.symbol).catch(() => null),
        );
        if (gr != null && Number.isFinite(gr.longPct))
          entryGlobalLongPct = gr.longPct;
      }
      if (spotVol24hRaw != null) entrySpotVol24h = spotVol24hRaw;
      // price24hAtFire: live fallback через тикер символа
      if (price24hAtFire === null && symbolTicker?.priceChangePercent != null) {
        const p = parseFloat(String(symbolTicker.priceChangePercent));
        if (Number.isFinite(p)) price24hAtFire = p;
      }
      // CVD: live fallback для background job сигналов (prescanE = null → все CVD поля были null)
      if (liveCvd?.available) {
        if (entryCvd15m === null) entryCvd15m = liveCvd.cvd15m ?? null;
        if (entryCvd30m === null) entryCvd30m = liveCvd.cvd30m ?? null;
        if (entryCvd1h === null) entryCvd1h = liveCvd.cvd1h ?? null;
        if (entryCvd4h === null) entryCvd4h = liveCvd.cvd4h ?? null;
      }
      // OI: live fallback для background job сигналов (prescanE = null → все OI поля null).
      // Если liveOI пришёл (не null), но поля всё ещё null — применяем.
      if (liveOI) {
        if (entryOi30m === null) entryOi30m = liveOI.oiChange30m ?? null;
        if (entryOi1h === null) entryOi1h = liveOI.oiChange1h ?? null;
        if (entryOi4h === null) entryOi4h = liveOI.oiChange4h ?? null;
        if (entryOi24h === null) entryOi24h = liveOI.oiChange24h ?? null;
      }
      // OB snapshot: кэш для fire path + DB-значения
      _obAtFire.set(params.symbol, obResult ?? null);
      if (obResult) {
        entryObBids = obResult.bidVolumeUsd;
        entryObAsks = obResult.askVolumeUsd;
        entryObRatio = obResult.bidAskRatio;
      }
      // Futures taker net buy %: universal fallback (background job сигналы где prescanE = null)
      if (liveTaker?.available && entryFutTakerNetBuy === null) {
        entryFutTakerNetBuy = liveTaker.netBuyPct ?? null;
      }
      // Spot taker net buy %: universal live fallback (main-scan сигналы: batch-обновление
      // prescanTracker запускается ПОСЛЕ скана, поэтому lastSpotTakerNetBuy = null в момент fire)
      if (liveSpotTaker?.available && entrySpotTakerNetBuy === null) {
        entrySpotTakerNetBuy = liveSpotTaker.netBuyPct ?? null;
      }
      // SNF 1h/4h/24h: PRIMARY — fresh limit=96 запрос (liveSpotTaker, Binance→BingX fallback).
      // Все 3 TF вычислены из одного batch свечей, нет доп. CG-запросов.
      if (liveSpotTaker?.available) {
        if (entrySpotNetBuy1h === null)
          entrySpotNetBuy1h = liveSpotTaker.takerNetBuy1h ?? null;
        if (entrySpotNetBuy4h === null)
          entrySpotNetBuy4h = liveSpotTaker.takerNetBuy4h ?? null;
        if (entrySpotNetBuy24h === null)
          entrySpotNetBuy24h = liveSpotTaker.takerNetBuy24h ?? null;
      }
      // SNF 1h/4h/24h: FALLBACK — batch-кэш CoinGlass spot netflow (каждые 5 мин).
      // Покрывает случай когда liveSpotTaker unavailable (CG timeout / 429).
      // 1h добавлен 2026-08-02: покрывает liq_cascade и другие bg-сигналы где prescanE не имеет lastSpotNetBuy1h.
      if (
        entrySpotNetBuy1h === null ||
        entrySpotNetBuy4h === null ||
        entrySpotNetBuy24h === null
      ) {
        const _snfEntry = getSpotNetflowEntry(params.symbol);
        if (_snfEntry) {
          if (entrySpotNetBuy1h === null)
            entrySpotNetBuy1h = _snfEntry.netPct1h ?? null;
          if (entrySpotNetBuy4h === null)
            entrySpotNetBuy4h = _snfEntry.netPct4h ?? null;
          if (entrySpotNetBuy24h === null)
            entrySpotNetBuy24h = _snfEntry.netPct24h ?? null;
        }
      }
    } catch {
      /* fail-open — метрики не критичны для трекинга */
    }
    // Liq snapshot (ALL patterns) — читает coin-list batch кэш (синхронно, без fetch).
    // Гарантирует что entryLiqLong1h/24h записываются в DB для ВСЕХ паттернов, не только
    // liq_cascade. Позволяет показывать liq-данные в истории закрытых сигналов.
    // liq_cascade переопределяет эти значения точными данными из своего fire-цикла.
    let entryLiqLong1h: number | null = params.entryLiqLong1h ?? null;
    let entryLiqLong24h: number | null = params.entryLiqLong24h ?? null;
    let entryLiqRatio: number | null = params.entryLiqRatio ?? null;
    if (entryLiqLong1h === null && entryLiqLong24h === null) {
      const _liqSnap = getCachedLiqDataEx(params.symbol);
      if (_liqSnap) {
        if (_liqSnap.longLiq1h > 0) entryLiqLong1h = _liqSnap.longLiq1h;
        if (_liqSnap.longLiq24h > 0) entryLiqLong24h = _liqSnap.longLiq24h;
        if (
          entryLiqLong1h !== null &&
          entryLiqLong24h !== null &&
          entryLiqLong24h > 0
        ) {
          entryLiqRatio = entryLiqLong1h / entryLiqLong24h;
        }
      }
    }
    // Регистрируем символ для per-symbol SNF supplement (заполнит map для UI)
    registerSnfSymbol(params.symbol);
    // mcapUsd: params → spotPool → market_cap_cache DB (persistent 7-day fallback)
    // spotPool пуст ~30 мин после рестарта; market_cap_cache заполнен startMarketCapPreloader
    const _mcapPool =
      params.marketCapUsd ?? getSpotPoolEntry(params.symbol)?.mcapUsd ?? null;
    const mcapUsd: number | null =
      _mcapPool ??
      (await db
        .select({ mcapUsd: marketCapCacheTable.mcapUsd })
        .from(marketCapCacheTable)
        .where(
          and(
            eq(marketCapCacheTable.symbol, params.symbol.replace(/-USDT$/, "")),
            eq(marketCapCacheTable.source, "coingecko"),
          ),
        )
        .limit(1)
        .then((r) => r[0]?.mcapUsd ?? null)
        .catch(() => null));
    if (
      entrySpotMcapPct === null &&
      entrySpotVol24h !== null &&
      mcapUsd &&
      mcapUsd > 0
    ) {
      entrySpotMcapPct = (entrySpotVol24h / mcapUsd) * 100;
    }

    // OI Watch entry price — если сигнал пришёл из очереди OI Watch
    let oiWatchEntryPrice: number | null = null;
    try {
      const oiWatchRows = await db
        .select({ priceAtEntry: oiWatchTable.priceAtEntry })
        .from(oiWatchTable)
        .where(
          and(
            eq(oiWatchTable.symbol, params.symbol),
            inArray(oiWatchTable.status, ["watching", "confirming"]),
          ),
        )
        .orderBy(desc(oiWatchTable.addedAt))
        .limit(1);
      oiWatchEntryPrice = oiWatchRows[0]?.priceAtEntry ?? null;
    } catch {
      /* non-critical */
    }

    // Персональный стоп/тейки по Liquidation Heatmap (fail-open → паттерн-стоп или -10%)
    const liqFields =
      params.fixedStopPrice != null &&
      params.fixedStopPrice > 0 &&
      params.fixedStopPrice < params.entryPrice
        ? {
            // Stealth fresh-24H-high: the stop is the broken level - 1%.
            stopLossPrice: params.fixedStopPrice,
            stopLossPct:
              ((params.entryPrice - params.fixedStopPrice) /
                params.entryPrice) *
              100,
            stopSource: "pattern" as const,
            takeTargets: null,
          }
        : await computeLiqStopFields(
            params.symbol,
            params.entryPrice,
            params.sentimentKey,
          );
    const [entryVolumeContext, rangeDeviationContext] = await Promise.all([
      captureEntryVolumeContext(params.symbol),
      captureRangeDeviation(params.symbol, params.entryPrice),
    ]);
    const decisionMetrics: Record<string, unknown> = {
      ...(params.decisionMetrics ?? {}),
      entryVolume: entryVolumeContext,
      rangeDeviation: rangeDeviationContext,
    };

    // BTC.D is observational only: do not allow a provider delay to block a
    // primary signal. Null means the snapshot was unavailable at fire time.
    const entryBtcDominance = await Promise.race([
      getBitcoinDominanceSummary(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]);

    const entryBtc = await Promise.race([
      getBtcTickerContext(),
      new Promise<BtcTickerContext>((resolve) =>
        setTimeout(() => resolve({ change24h: null, price: null }), 1_500),
      ),
    ]);

    // Promise.race с таймаутом 10s: самый критичный INSERT — потеря означает
    // потерю всего трекинга позиции. Timeout бросает, outer catch возвращает false
    // → caller не делает Telegram broadcast (безопасный fail-fast).
    // 10s (не dbWriteBestEffort) — нужен throw при failure, а не silent null.
    assertMarketCycleLeaseOwnership("tracked signal insert");
    const selectedRunnerPolicy = isBitcoinTrackedSignal({
      symbol: params.symbol,
    })
      ? null
      : selectImpulseRunnerPolicy({
          sentimentKey: params.sentimentKey,
          isShort: params.isShort,
        });
    const inserted = await Promise.race([
      db
        .insert(trackedSignalsTable)
        .values({
          symbol: params.symbol,
          signalId: params.signalId,
          signalType: params.signalType,
          sentiment: params.sentiment ?? null,
          sentimentKey: params.sentimentKey ?? null,
          stealthDetectionMethod: params.stealthDetectionMethod ?? null,
          alphaScore: params.alphaScore ?? null,
          isShort: params.isShort ?? false,
          entryPrice: params.entryPrice,
          entryBtc24h: entryBtc.change24h,
          entryBtcPrice: entryBtc.price,
          entryBtcDominance: entryBtcDominance?.current ?? null,
          entryBtcDominanceSource: entryBtcDominance?.source ?? null,
          entryBtcDominanceObservedAt: entryBtcDominance
            ? new Date(entryBtcDominance.updatedAt)
            : null,
          entryOi: params.entryOi ?? null,
          peakPrice: params.entryPrice,
          trailingStopLevel: null,
          policyVersion: selectedRunnerPolicy,
          originalEntryPrice:
            selectedRunnerPolicy === IMPULSE_RUNNER_POLICY_VERSION
              ? params.entryPrice
              : null,
          runnerState: null,
          coreClosedAt: null,
          coreExitPrice: null,
          corePnlPercent: null,
          coreCloseEventKey: null,
          runnerPeakPrice: null,
          runnerTrailingStopLevel: null,
          runnerTrailingStopArmedAt: null,
          runnerExitPrice: null,
          runnerPnlPercent: null,
          runnerClosedAt: null,
          runnerCloseEventKey: null,
          lastMilestone: null,
          stopLossPrice: liqFields.stopLossPrice,
          stopLossPct: liqFields.stopLossPct,
          stopSource: liqFields.stopSource,
          takeTargets: liqFields.takeTargets,
          // Новая политика: полный единичный вход, без второй лимитной заявки.
          entryPolicyVersion: SINGLE_ENTRY_POLICY_VERSION,
          splitLimitPrice: null,
          price24hAtFire,
          entryPrice3h: params.entryPrice3h ?? null,
          entryPrice3hProvenance: params.entryPrice3hProvenance ?? null,
          plmP24hCap18Pass: params.plmP24hCap18Pass ?? null,
          plmFutTakerShadow: params.plmFutTakerShadow ?? null,
          plmOi30mShadow: params.plmOi30mShadow ?? null,
          entryScoreBreakdown: params.entryScoreBreakdown ?? null,
          entryGradeReason: params.entryGradeReason ?? null,
          prescanCycles,
          oiWatchEntryPrice,
          entryCvd15m,
          entryCvd30m,
          entryCvd1h,
          entryCvd4h,
          marketCapUsd: mcapUsd,
          entryOi30m,
          entryOi1h,
          entryOi4h,
          entryOi24h,
          entryPrice1h,
          entryFutTakerNetBuy,
          entrySpotVolMult,
          entryFutVolMult,
          entrySpotVol24h,
          entrySpotMcapPct,
          entrySpotTakerNetBuy,
          entrySpotNetBuy1h,
          entrySpotNetBuy4h,
          entrySpotNetBuy24h,
          entrySource: params.entrySource ?? null,
          decisionMetrics,
          impulseDecisionMetrics:
            params.sentimentKey === "impulse_buy"
              ? (params.decisionMetrics ?? null)
              : null,
          entryLiqLong1h,
          entryLiqLong24h,
          entryLiqRatio,
          entryLiqReason: params.entryLiqReason ?? null,
          entryFundingRate,
          entryWhaleIndex,
          entryGlobalLongPct,
          entryObBids,
          entryObAsks,
          entryObRatio,
          entryMetricsProvenance: buildEntryMetricsProvenance(
            {
              price24hAtFire,
              entryPrice3h: params.entryPrice3h ?? null,
              entryCvd15m,
              entryCvd30m,
              entryCvd1h,
              entryCvd4h,
              entryOi30m,
              entryOi1h,
              entryOi4h,
              entryOi24h,
              entryPrice1h,
              entryFutTakerNetBuy,
              entrySpotVolMult,
              entryFutVolMult,
              entrySpotVol24h,
              entrySpotMcapPct,
              entrySpotTakerNetBuy,
              entrySpotNetBuy1h,
              entrySpotNetBuy4h,
              entrySpotNetBuy24h,
              entryFundingRate,
              entryWhaleIndex,
              entryObBids,
              entryObAsks,
              entryObRatio,
              entryLiqLong1h,
              entryLiqLong24h,
              entryLiqRatio,
            },
            "signal_fire",
            signalDetectedAt,
          ),
          status: params.initialStatus ?? "active",
          reEntryCount: 0,
          detectedAt: signalDetectedAt,
          updatedAt: new Date(),
        } as InsertTrackedSignal)
        .returning({ id: trackedSignalsTable.id }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("trackSignal INSERT timeout (10s)")),
          10_000,
        ),
      ),
    ]);

    logger.info(
      { symbol: params.symbol, price: params.entryPrice },
      "📍 Signal added to tracker",
    );
    const trackedSignalId = inserted[0]?.id;
    if (trackedSignalId != null) {
      if (params.signalId != null) {
        try {
          await Promise.race([
            captureTradingSignalAtConfirmation(params.signalId),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("Trading relay capture timed out")),
                3_000,
              ),
            ),
          ]);
        } catch (error) {
          logger.error(
            { err: error, signalId: params.signalId },
            "Immediate trading relay capture failed; polling will reconcile",
          );
        }
      }
      // Fire-time OI 15m (all patterns): bounded best-effort, written before
      // the decision snapshot so the snapshot carries it. Never blocks tracking.
      await Promise.race([
        (async () => {
          const oi15m = await getCoinglassOi15mChange(params.symbol);
          if (oi15m === null) return;
          await dbWriteBestEffort("trackedSignal/entry-oi-15m", () =>
            db
              .update(trackedSignalsTable)
              .set({ entryOi15m: oi15m })
              .where(eq(trackedSignalsTable.id, trackedSignalId)),
          );
        })().catch((error) =>
          logger.warn(
            { error, trackedSignalId },
            "Entry OI 15m capture failed",
          ),
        ),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]);
      await dbWriteBestEffort("trackedSignal/decision-snapshot", () =>
        snapshotTrackedDecision(trackedSignalId),
      );
      // An immediate best-effort trigger only: the durable periodic reconciliation
      // repairs missed enrollments without delaying tracking or Telegram delivery.
      void enrollIndicatorTargetCandidatesForTrackedSignal(
        trackedSignalId,
      ).catch((error) =>
        logger.warn(
          { error, trackedSignalId },
          "Indicator target enrollment deferred to reconciliation",
        ),
      );
    } else {
      logger.error(
        { symbol: params.symbol },
        "Tracked signal inserted without id; decision snapshot deferred to reconciliation",
      );
    }
    return "new";
  } catch (err) {
    lastTrackSignalErrors.set(
      params.symbol,
      (err instanceof Error ? err.message : String(err))
        .replace(/\s+/g, " ")
        .slice(0, 160),
    );
    logger.error(
      { err, symbol: params.symbol },
      "Failed to add signal to tracker",
    );
    return false; // сигнализируем вызывающему — broadcast нельзя делать
  }
}

/**
 * Remove excluded symbols from operational trading without manufacturing a
 * cancellation or close outcome. Historical terminal trades remain untouched.
 */
export async function reclassifyOpenExcludedSignalSymbols(): Promise<void> {
  const result = await db.transaction(async (tx) => {
    const moved = await tx
      .update(trackedSignalsTable)
      .set({
        status: "reclassified",
        exitPrice: null,
        pnlPercent: null,
        cancelReason: EXCLUDED_SIGNAL_REASON,
        closedAt: null,
        trailingStopLevel: null,
        trailingStopArmedAt: null,
        pendingMilestone: null,
        pendingMilestoneKind: null,
        pendingMilestonePrice: null,
        pendingMilestoneTrailingStop: null,
        pendingMilestoneStatus: null,
        pendingMilestoneLeaseUntil: null,
        lastSmartCancelCheckAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(trackedSignalsTable.symbol, [...EXCLUDED_SIGNAL_SYMBOLS]),
          inArray(trackedSignalsTable.status, ["active", "in_run"]),
          sql`NOT (
            ${trackedSignalsTable.runnerState} = 'open'
            AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
          )`,
        ),
      )
      .returning({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
      });

    if (moved.length > 0) {
      await tx
        .update(milestoneNotificationDeliveriesTable)
        .set({
          status: "abandoned",
          leaseUntil: null,
          claimToken: null,
          lastError: EXCLUDED_SIGNAL_REASON,
        })
        .where(
          and(
            inArray(
              milestoneNotificationDeliveriesTable.trackedSignalId,
              moved.map((row) => row.id),
            ),
            inArray(milestoneNotificationDeliveriesTable.status, [
              "ready",
              "retry",
              "failed",
            ]),
          ),
        );

      const movedIds = sql.join(
        moved.map((row) => sql`${row.id}`),
        sql`, `,
      );
      // Only unsent messages are safe to abandon. Delivered or ambiguous
      // notifications cannot be retracted from Telegram.
      await tx.execute(sql`
        WITH abandoned AS (
          UPDATE telegram_photo_deliveries p
             SET status = 'abandoned',
                 lease_until = NULL,
                 claim_token = NULL,
                 last_error = ${EXCLUDED_SIGNAL_REASON},
                 updated_at = NOW()
           WHERE (
             p.status IN ('ready', 'retry')
             OR (p.status = 'processing' AND p.send_attempted_at IS NULL)
           )
             AND EXISTS (
               SELECT 1 FROM tracked_signals t
                WHERE t.id IN (${movedIds})
                  AND (
                    p.dedup_key = 'signal:' || t.signal_id::text
                    OR p.dedup_key LIKE 'position:' || t.id::text || ':%'
                    OR p.dedup_key LIKE 'milestone:v3:' || t.id::text || ':%'
                  )
             )
          RETURNING p.dedup_key
        )
        UPDATE telegram_delivery_events e
           SET status = 'attention',
               attention_at = COALESCE(e.attention_at, NOW()),
               last_error = ${EXCLUDED_SIGNAL_REASON},
               updated_at = NOW()
         WHERE e.event_key IN (SELECT dedup_key FROM abandoned)
           AND e.status <> 'delivered'
      `);
    }

    const expiredWatches = await tx
      .update(oiWatchTable)
      .set({
        status: "expired",
        volStatusReason: EXCLUDED_SIGNAL_REASON,
      })
      .where(
        and(
          inArray(oiWatchTable.symbol, [...EXCLUDED_SIGNAL_SYMBOLS]),
          inArray(oiWatchTable.status, ["watching", "confirming"]),
        ),
      )
      .returning({ id: oiWatchTable.id });

    return { moved, expiredWatchCount: expiredWatches.length };
  });

  logger.info(
    {
      symbols: [...EXCLUDED_SIGNAL_SYMBOLS],
      reclassifiedOpenPositions: result.moved.length,
      expiredOiWatches: result.expiredWatchCount,
    },
    "Excluded-symbol trading state reconciled",
  );
}

export async function discardUntrackedSignal(
  signalId: number,
  reason: string,
): Promise<boolean> {
  const deleted =
    (await dbWriteBestEffort("signals/discard-untracked", () =>
      db
        .delete(signalsTable)
        .where(
          sql`${signalsTable.id} = ${signalId}
            AND NOT EXISTS (
              SELECT 1 FROM tracked_signals ts
              WHERE ts.signal_id = ${signalsTable.id}
            )`,
        )
        .returning({ id: signalsTable.id }),
    )) ?? [];
  if (deleted.length > 0) {
    logger.info(
      { signalId, reason },
      "Preliminary signal discarded because no tracked position was created",
    );
  }
  return deleted.length > 0;
}

/** Mark a newly-created tracker terminal when durable Telegram enqueue failed. */
export async function cancelUndeliveredTrackedSignal(
  signalId: number,
  reason: string,
): Promise<boolean> {
  const cancelled = await dbWriteStrict(
    "signals/cancel-undelivered-tracker",
    () =>
      db
        .update(trackedSignalsTable)
        .set({
          status: "cancelled",
          cancelReason: reason,
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.signalId, signalId),
            eq(trackedSignalsTable.status, "active"),
          ),
        )
        .returning({ id: trackedSignalsTable.id }),
  );
  if (cancelled.length > 0) {
    logger.warn(
      { signalId, reason },
      "Fresh tracked signal cancelled because durable Telegram enqueue failed",
    );
  }
  return cancelled.length > 0;
}

type DeliveredSignalMissingTrackerRow = {
  id: number;
  symbol: string;
  type: string;
  sentiment: string | null;
  sentimentKey: string | null;
  alphaScore: number | null;
  price: number;
  openInterest: number | null;
  entryCvd15m: boolean | null;
  entryCvd30m: boolean | null;
  entryCvd1h: boolean | null;
  entryCvd4h: boolean | null;
  entryPrice3h: number | null;
  entryPrice3hProvenance: string | null;
  plmP24hCap18Pass: boolean | null;
  plmFutTakerShadow: string | null;
  plmOi30mShadow: string | null;
  entryScoreBreakdown: string | null;
  entryGradeReason: string | null;
  detectedAt: Date | string;
  latestTrackerDetectedAt: Date | string | null;
};

/**
 * Repairs the inverse side of primary-alert atomicity: an older worker may
 * have queued and delivered signal:<id> after the tracker insert failed.
 * Recovery is deliberately limited to recent signals with a confirmed
 * delivered outbox row and runs only while this worker owns the market lease.
 */
export async function reconcileDeliveredSignalsMissingTracker(): Promise<number> {
  assertMarketCycleLeaseOwnership("delivered signal tracker reconciliation");

  // Historical recovery could resurrect an older delivered signal after a
  // newer trade for the same symbol had already closed. Remove only positions
  // created by that recovery path and only when the newer tracker row proves
  // the recovered position is superseded. The open-status predicate makes the
  // correction idempotent across both production workers and future restarts.
  const superseded = await db.execute(sql<{
    id: number;
    symbol: string;
  }>`
    UPDATE tracked_signals recovered
    SET
      status = 'cancelled',
      cancel_reason = 'superseded_recovery',
      exit_price = recovered.entry_price,
      pnl_percent = 0,
      closed_at = now(),
      updated_at = now()
    WHERE recovered.entry_source = 'delivered_signal_recovery'
      AND recovered.status IN ('active', 'in_run')
      AND NOT (
        recovered.runner_state = 'open'
        AND recovered.core_closed_at IS NOT NULL
      )
      AND EXISTS (
        SELECT 1
        FROM tracked_signals newer
        WHERE newer.symbol = recovered.symbol
          AND newer.detected_at > recovered.detected_at
      )
    RETURNING recovered.id, recovered.symbol
  `);
  if (superseded.rows.length > 0) {
    logger.warn(
      {
        count: superseded.rows.length,
        positions: superseded.rows,
      },
      "Closed superseded positions created by delivered-signal recovery",
    );
  }

  const result = await db.execute(sql<DeliveredSignalMissingTrackerRow>`
    SELECT
      s.id,
      s.symbol,
      s.type::text AS type,
      s.sentiment,
      s.sentiment_key AS "sentimentKey",
      s.alpha_score AS "alphaScore",
      s.price,
      s.open_interest AS "openInterest",
      s.entry_cvd_15m AS "entryCvd15m",
      s.entry_cvd_30m AS "entryCvd30m",
      s.entry_cvd_1h AS "entryCvd1h",
      s.entry_cvd_4h AS "entryCvd4h",
      s.entry_price_3h AS "entryPrice3h",
      s.entry_price_3h_provenance AS "entryPrice3hProvenance",
      s.plm_p24h_cap_18_pass AS "plmP24hCap18Pass",
      s.plm_fut_taker_shadow AS "plmFutTakerShadow",
      s.plm_oi30m_shadow AS "plmOi30mShadow",
      s.entry_score_breakdown AS "entryScoreBreakdown",
      s.entry_grade_reason AS "entryGradeReason",
      s.detected_at AS "detectedAt",
      (
        SELECT max(latest.detected_at)
        FROM tracked_signals latest
        WHERE latest.symbol = s.symbol
      ) AS "latestTrackerDetectedAt"
    FROM signals s
    WHERE s.telegram_alert_queued = true
      AND s.detected_at >= now() - interval '48 hours'
      AND EXISTS (
        SELECT 1
        FROM telegram_photo_deliveries d
        WHERE d.dedup_key = 'signal:' || s.id::text
          AND d.status = 'delivered'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tracked_signals ts
        WHERE ts.signal_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tracked_signals newer
        WHERE newer.symbol = s.symbol
          AND newer.detected_at > s.detected_at
      )
    ORDER BY s.detected_at ASC
    LIMIT 20
  `);

  const signals = result.rows as unknown as DeliveredSignalMissingTrackerRow[];
  let repaired = 0;
  for (const signal of signals) {
    const signalDetectedAt =
      signal.detectedAt instanceof Date
        ? signal.detectedAt
        : new Date(signal.detectedAt);
    const latestTrackerDetectedAt =
      signal.latestTrackerDetectedAt == null
        ? null
        : signal.latestTrackerDetectedAt instanceof Date
          ? signal.latestTrackerDetectedAt
          : new Date(signal.latestTrackerDetectedAt);
    if (
      !shouldRecoverDeliveredSignal(signalDetectedAt, latestTrackerDetectedAt)
    ) {
      continue;
    }

    const plmPrice3hSnapshot = recoverPlmEntryPrice3hSnapshot({
      sentimentKey: signal.sentimentKey,
      entryPrice3h: signal.entryPrice3h,
      entryPrice3hProvenance: signal.entryPrice3hProvenance,
    });
    const tracked = await trackSignal({
      symbol: signal.symbol,
      signalId: signal.id,
      signalType: signal.type,
      sentiment: signal.sentiment,
      sentimentKey: signal.sentimentKey,
      alphaScore: signal.alphaScore,
      entryPrice: Number(signal.price),
      entryOi: signal.openInterest != null ? Number(signal.openInterest) : null,
      entryCvd15m: signal.entryCvd15m,
      entryCvd30m: signal.entryCvd30m,
      entryCvd1h: signal.entryCvd1h,
      entryCvd4h: signal.entryCvd4h,
      entryPrice3h: plmPrice3hSnapshot.entryPrice3h,
      entryPrice3hProvenance: plmPrice3hSnapshot.entryPrice3hProvenance,
      plmP24hCap18Pass: signal.plmP24hCap18Pass,
      plmFutTakerShadow: recoverPlmFutTakerShadow({
        sentimentKey: signal.sentimentKey,
        plmFutTakerShadow: signal.plmFutTakerShadow,
      }),
      plmOi30mShadow: recoverPlmOi30mShadow({
        sentimentKey: signal.sentimentKey,
        plmOi30mShadow: signal.plmOi30mShadow,
      }),
      entryScoreBreakdown: signal.entryScoreBreakdown,
      entryGradeReason: signal.entryGradeReason,
      entrySource: "delivered_signal_recovery",
      detectedAt: signalDetectedAt,
      initialStatus: "active",
    });
    if (tracked === "new" || tracked === "reentry") {
      repaired++;
      logger.warn(
        { signalId: signal.id, symbol: signal.symbol },
        "Repaired delivered primary signal missing its tracker position",
      );
    }
  }

  return repaired;
}

// ── Startup reset: normalize stale active signals after server restart ─────────
// Если сервер перезагрузился пока монета двигалась — entry price устарел.
// Вместо молчаливого сброса — отправляем уведомление «Пропущено движение»,
// затем сбрасываем entry до текущей цены чтобы сопровождение продолжалось корректно.
async function sendBotRestartNotification(): Promise<void> {
  // The restart notice is a critical owner-only event. Queue it atomically with
  // the settings claim so a successful claim always has a durable recipient row.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = `🔄 <b>Бот перезапущен. Мониторинг возобновлён.</b>`;
      const delivery = await queueSettingsPhotoBroadcast({
        column: "lastRestartNotifiedAt",
        windowMs: 5 * 60_000,
        eventKey: `restart-notification:${Math.floor(Date.now() / (5 * 60_000))}`,
        photoPath: RESTART_IMG,
        text,
        targets: [getOperationalTelegramRecipientId()],
      });
      if (!delivery.claimed) return;
      if (delivery.queued > 0) {
        logger.info(
          { attempt, queued: delivery.queued },
          "🔄 Bot restart notification queued for confirmed delivery",
        );
        return;
      }
      logger.warn(
        { attempt },
        "Restart notification: claimed without a queued recipient — retry через 60с",
      );
    } catch (err) {
      logger.warn(
        { err, attempt },
        "Restart notification: ошибка (DB/Telegram/getTargets), retry через 60с",
      );
    }

    if (attempt < 3) await new Promise((r) => setTimeout(r, 60_000));
  }
  logger.error(
    "🔄 Restart notification: все 3 попытки провалились — уведомление не отправлено",
  );
}

type SettingsPhotoBroadcastColumn =
  | "lastRestartNotifiedAt"
  | "lastManualCheckSentAt"
  | "lastWatchdogAlertAt";

const SETTINGS_PHOTO_BROADCAST_COLUMNS = {
  lastRestartNotifiedAt: settingsTable.lastRestartNotifiedAt,
  lastManualCheckSentAt: settingsTable.lastManualCheckSentAt,
  lastWatchdogAlertAt: settingsTable.lastWatchdogAlertAt,
} as const;

async function queuePhotoBroadcast(params: {
  eventKey: string;
  photoPath: string;
  text: string;
  targets: Array<number | string>;
}): Promise<number> {
  if (params.targets.length === 0) {
    throw new Error(`No Telegram recipients resolved for ${params.eventKey}`);
  }
  return runOutsideMarketCycleLease(() =>
    enqueueTelegramPhotoBroadcast({
      photoPath: params.photoPath,
      text: params.text,
      targets: params.targets,
      eventKey: params.eventKey,
    }),
  );
}

async function queueSettingsPhotoBroadcast(params: {
  column: SettingsPhotoBroadcastColumn;
  windowMs: number;
  eventKey: string;
  photoPath: string;
  text: string;
  targets: Array<number | string>;
}): Promise<{ claimed: boolean; queued: number }> {
  if (params.targets.length === 0) {
    throw new Error(`No Telegram recipients resolved for ${params.eventKey}`);
  }
  const now = new Date();
  const cutoff = new Date(now.getTime() - params.windowMs);
  const guardedColumn = SETTINGS_PHOTO_BROADCAST_COLUMNS[params.column];

  return runOutsideMarketCycleLease(() =>
    enqueueTelegramPhotoBroadcastAfterClaim({
      photoPath: params.photoPath,
      text: params.text,
      targets: params.targets,
      eventKey: params.eventKey,
      claim: async (transaction) => {
        const claimed = await transaction
          .update(settingsTable)
          .set({ [params.column]: now } as never)
          .where(
            and(
              sql`${settingsTable.id} = (SELECT id FROM settings LIMIT 1)`,
              or(isNull(guardedColumn), lt(guardedColumn, cutoff)),
            ),
          )
          .returning({ id: settingsTable.id });
        return claimed.length === 1;
      },
    }),
  );
}

// ── После рестарта: предупреждение о позициях близко к стопу ─────────────────
// «Близко» = использовано ≥50% буфера стопа (PnL отрицательный, прошло половину пути к стопу).
// Пример: стоп −8%, текущий PnL −4% → предупреждение.
// Отправляется отдельным сообщением с картинкой manual_check.png — независимо от restartNotif.
async function sendNearStopWarning(): Promise<void> {
  try {
    const openPositions = await db
      .select()
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));

    if (openPositions.length === 0) return;

    let tickers: { symbol: string; lastPrice: string }[] = [];
    try {
      tickers = (await getFutureTickers()) as {
        symbol: string;
        lastPrice: string;
      }[];
    } catch {
      return;
    }

    const priceMap = new Map<string, number>();
    for (const t of tickers)
      priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);

    const nearStop: Array<{
      symbol: string;
      sentimentKey: string | null;
      pnl: number;
      stopPct: number;
      remaining: number;
      currentPrice: number;
      isOpenRunner: boolean;
    }> = [];
    for (const pos of openPositions) {
      if (!pos.entryPrice || pos.entryPrice === 0) continue;
      const curPrice = priceMap.get(pos.symbol);
      if (!curPrice) continue;
      const pnl = computePnl(pos, curPrice);
      const isOpenRunner =
        isImpulseRunnerCoreClosed(pos) && pos.runnerState === "open";
      const runnerEntryPrice = pos.originalEntryPrice ?? pos.entryPrice;
      const stopPct = isOpenRunner
        ? ((runnerEntryPrice -
            resolveImpulseRunnerEmergencyStopPrice(
              runnerEntryPrice,
              pos.stopLossPct,
              pos.entryPolicyVersion,
            )) /
            runnerEntryPrice) *
          100
        : effStopPct(pos);
      if (pnl < 0 && Math.abs(pnl) >= stopPct * 0.5) {
        nearStop.push({
          symbol: pos.symbol,
          sentimentKey: pos.sentimentKey,
          pnl,
          stopPct,
          remaining: stopPct - Math.abs(pnl),
          currentPrice: curPrice,
          isOpenRunner,
        });
      }
    }

    if (nearStop.length === 0) return;

    const lines = [
      `⚠️ <b>MANUAL CHECK — позиции близко к стопу</b>`,
      ``,
      ...nearStop.map((p) => {
        const base = p.symbol.replace("-USDT", "");
        const pattern = p.sentimentKey
          ? getPatternTgLabel(p.sentimentKey)
          : "неизвестен";
        return `• <b>${base}</b> ${tickerTag(p.symbol)} | <b>${pattern}</b> | PnL${p.isOpenRunner ? " runner" : ""}: <b>${p.pnl.toFixed(1)}%</b>\n${formatMarketLinks(p.symbol)}`;
      }),
    ];
    const text = withoutTradingViewLinks(lines.join("\n"));

    // Resolve the entire critical audience before claiming the event. If a
    // source is unavailable, no channel-only snapshot is committed.
    const targets = await getTargets({ strict: true });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const delivery = await queueSettingsPhotoBroadcast({
          column: "lastManualCheckSentAt",
          windowMs: 10 * 60_000,
          eventKey: `manual-check:${Math.floor(Date.now() / (10 * 60_000))}`,
          photoPath: MANUAL_CHECK_IMG,
          text,
          targets,
        });
        if (!delivery.claimed) {
          logger.info(
            "Manual Check near-stop: already queued by another worker",
          );
          return;
        }
        if (delivery.queued > 0) {
          logger.warn(
            {
              nearStopCount: nearStop.length,
              symbols: nearStop.map((p) => p.symbol),
              queued: delivery.queued,
            },
            "⚠️ Near-stop positions detected after restart — manual check queued for confirmed delivery",
          );
          return;
        }
        throw new Error("Manual Check claim succeeded without recipient rows");
      } catch (err) {
        if (attempt === 3) throw err;
        logger.warn(
          { err, attempt },
          "Manual Check near-stop: queue failed, retry in 15s",
        );
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "sendNearStopWarning: unable to queue the critical manual check",
    );
  }
}

// ── One-time cleanup: закрываем все открытые ghost_pump позиции ──────────────
// Запускается один раз при старте сервера после отключения паттернов.
// После того как все позиции закрыты, функция молчит (нет open ghost_pump → exit).
export async function runGhostPumpCleanup(): Promise<void> {
  const openGhost = await db
    .select({
      id: trackedSignalsTable.id,
      symbol: trackedSignalsTable.symbol,
      status: trackedSignalsTable.status,
      entryPrice: trackedSignalsTable.entryPrice,
      sentimentKey: trackedSignalsTable.sentimentKey,
      detectedAt: trackedSignalsTable.detectedAt,
      pnlPercent: trackedSignalsTable.pnlPercent,
      peakPrice: trackedSignalsTable.peakPrice,
    })
    .from(trackedSignalsTable)
    .where(
      and(
        inArray(trackedSignalsTable.status, ["active", "in_run"]),
        inArray(trackedSignalsTable.signalType, [
          "ghost_pump",
          "ghost_pump_early",
        ]),
      ),
    );

  if (openGhost.length === 0) return;

  logger.info(
    { count: openGhost.length },
    "🧹 Ghost pump cleanup: закрываем открытые позиции",
  );

  const closedAt = new Date();
  const symbols = openGhost.map((pos) => pos.symbol.replace("-USDT", ""));
  const msg = [
    `🧹 <b>Сброс Ghost Pump позиций</b>`,
    ``,
    `Паттерны <b>Ghost Pump</b> и <b>Anomaly</b> отключены — слишком поздний вход, высокий риск.`,
    ``,
    `Закрыты позиции (${symbols.length}):`,
    openGhost
      .map((pos) => {
        const act = activeForLine(pos.detectedAt, closedAt);
        return `  • #${pos.symbol.replace("-USDT", "")}${act ? ` — ${act.replace("⏱ ", "")}` : ""}`;
      })
      .join("\n"),
    ``,
    `Бот продолжает работу по оставшимся паттернам.`,
  ].join("\n");

  const claimedIds: number[] = [];
  const delivery = await broadcastPhotoAfterClaim(
    CANCEL_IMG,
    msg,
    `cancel:ghost_pump_cleanup:${openGhost
      .map((pos) => pos.id)
      .sort((a, b) => a - b)
      .join(",")}`,
    async (tx) => {
      for (const pos of openGhost) {
        const claimed = await tx
          .update(trackedSignalsTable)
          .set({
            status: "cancelled",
            exitPrice: pos.entryPrice,
            pnlPercent: 0,
            cancelReason: "ghost_pump_cleanup",
            closedAt,
            updatedAt: closedAt,
          })
          .where(
            and(
              eq(trackedSignalsTable.id, pos.id),
              inArray(trackedSignalsTable.status, ["active", "in_run"]),
              sql`NOT (
                ${trackedSignalsTable.runnerState} = 'open'
                AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
              )`,
            ),
          )
          .returning({ id: trackedSignalsTable.id });
        if (claimed.length > 0) claimedIds.push(pos.id);
      }
      return claimedIds.length > 0;
    },
  );
  if (delivery.claimed) {
    const claimedSet = new Set(claimedIds);
    for (const pos of openGhost) {
      if (claimedSet.has(pos.id)) {
        void _writeExitMetrics(pos.id, pos.symbol);
        const _ghostPeakPct =
          pos.peakPrice != null && pos.entryPrice > 0
            ? ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100
            : (pos.pnlPercent ?? 0);
        await recordCloseSnapshot(
          {
            id: pos.id,
            symbol: pos.symbol,
            sentimentKey: pos.sentimentKey,
            detectedAt: pos.detectedAt,
          },
          pos.entryPrice,
          pos.pnlPercent ?? 0,
          _ghostPeakPct,
          "cancelled",
        );
      }
    }
    logger.info(
      { claimed: claimedIds.length, queued: delivery.queued },
      "Ghost pump cleanup: cancellations queued",
    );
  }
}

// ── Одноразовая чистка POWER-USDT ticker-collision (2026-07-10) ─────────────
// Баг: getBingxOiUsdCached() до фикса умножал уже-USD значение BingX OI ещё
// раз на цену — кросс-валидация занижала эталон в ~1/price раз и почти
// всегда либо ложно молчала, либо (для POWER) сама коллизия была реальной
// (CoinGlass отдавал ~$204-240M против настоящих ~$1.8-17M), но live-чек
// имел fail-open дыру: available:false трактовался как "нет данных, не
// блокируем" вместо "обнаружена подозрительная магнитуда, блокируем".
// В итоге oi24h_accumulation сигнал (signal id 716 / tracked id 725) выстрелил
// на day3-снимке $240M, посчитанном ИЗ ТОЙ ЖЕ испорченной коллизии.
// Идемпотентно: отменяет только active/in_run записи POWER-USDT
// oi24h_accumulation и помечает старые corrupted-снимки NULL (>$50M —
// заведомо выше реального OI POWER), чтобы кандидат-запрос их больше не видел.
export async function cleanupPowerCollisionArtifacts(): Promise<void> {
  try {
    const cancelled = await dbWriteStrict("trackedSignal/power-cancel", () =>
      db
        .update(trackedSignalsTable)
        .set({
          status: "cancelled",
          cancelReason: "coinglass_collision_cleanup",
          closedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.symbol, "POWER-USDT"),
            eq(trackedSignalsTable.sentimentKey, "oi24h_accumulation"),
            inArray(trackedSignalsTable.status, ["active", "in_run"] as any[]),
            sql`NOT (
              ${trackedSignalsTable.runnerState} = 'open'
              AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
            )`,
          ),
        )
        .returning({
          id: trackedSignalsTable.id,
          sentimentKey: trackedSignalsTable.sentimentKey,
          detectedAt: trackedSignalsTable.detectedAt,
          entryPrice: trackedSignalsTable.entryPrice,
          pnlPercent: trackedSignalsTable.pnlPercent,
          peakPrice: trackedSignalsTable.peakPrice,
        }),
    );

    for (const r of cancelled) {
      void _writeExitMetrics(r.id, "POWER-USDT");
      const _peakPct =
        r.peakPrice != null && r.entryPrice > 0
          ? ((r.peakPrice - r.entryPrice) / r.entryPrice) * 100
          : (r.pnlPercent ?? 0);
      await recordCloseSnapshot(
        {
          id: r.id,
          symbol: "POWER-USDT",
          sentimentKey: r.sentimentKey,
          detectedAt: r.detectedAt,
        },
        r.entryPrice,
        r.pnlPercent ?? 0,
        _peakPct,
        "cancelled",
      );
    }

    const snapshots = await dbWriteStrict("oiDailySnapshots/power-clear", () =>
      db
        .update(oiDailySnapshotsTable)
        .set({ oiUsd: null, oiChange24h: null })
        .where(
          and(
            eq(oiDailySnapshotsTable.symbol, "POWER-USDT"),
            gt(oiDailySnapshotsTable.oiUsd, 50_000_000),
          ),
        )
        .returning({
          id: oiDailySnapshotsTable.id,
          date: oiDailySnapshotsTable.date,
        }),
    );

    if (cancelled.length > 0 || snapshots.length > 0) {
      logger.info(
        {
          cancelledTracked: cancelled.length,
          clearedSnapshots: snapshots.length,
          dates: snapshots.map((s) => s.date),
        },
        "POWER-USDT collision cleanup: отменён сигнал и очищены испорченные дневные снимки OI",
      );
    }
  } catch (err) {
    logger.error({ err }, "POWER-USDT collision cleanup error");
  }
}

// ── ОТКЛЮЧЕНО (2026-07-10, тот же день что и написана) ────────────────────────
// Первый прогон на проде массово поломал данные: сравнение "CoinGlass oiUsd
// (это АГРЕГАТ по ВСЕМ биржам, см. totalOI в coinglass_oi.ts) vs прямой OI
// ТОЛЬКО на BingX" при ratio>30x некорректно для ликвидных токенов — у BTC,
// ADA, XRP, DOGE, TRX, ARB, APE и ещё ~290 символов доля BingX в глобальном OI
// естественно и легитимно меньше 1/30, это НЕ признак коллизии тикера, а
// нормальная структура рынка (основной объём на Binance/OKX/Bybit).
// Функция ошибочно обнулила 10-дневную историю oi_daily_snapshots для ~300
// символов и ложно отменила рабочий сигнал APE-USDT (id 716/tracked 716,
// cancel_reason=coinglass_collision_cleanup) — единственная НЕ подтверждённая
// вручную отмена среди четырёх (LDO/RSR/AKE — подтверждены ручным сравнением
// заранее, см. память bingx-oi-usd-unit-bug.md, ratio там был 1600x-38000x,
// на порядки выше шума соотношения "агрегат/одна биржа").
// Настоящий признак коллизии — не ratio к BingX, а то, что абсолютная
// величина oiUsd не совместима с ЛЮБОЙ разумной биржевой структурой (см.
// SATS ratio=19486x в живых логах — вот это коллизия). Безопасный
// автоматический вариант этой проверки пока не реализован — ниже узкий,
// вручную проверенный список символов вместо общего скана всех тикеров.
export async function cleanupOiCollisionArtifacts(): Promise<void> {
  // Список пополняется ТОЛЬКО после ручной сверки abs(oi_usd) со здравым
  // смыслом (рыночная капа/объём токена), не одним лишь ratio к BingX-OI.
  const MANUALLY_VERIFIED_COLLISION_SYMBOLS = [
    "POWER-USDT",
    "RSR-USDT",
    "AKE-USDT",
    "TAC-USDT",
    "LDO-USDT",
  ];
  try {
    const cutoff = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const clearedSnapshots = await dbWriteStrict(
      "oiDailySnapshots/collision-clear",
      () =>
        db
          .update(oiDailySnapshotsTable)
          .set({ oiUsd: null, oiChange24h: null })
          .where(
            and(
              inArray(
                oiDailySnapshotsTable.symbol,
                MANUALLY_VERIFIED_COLLISION_SYMBOLS,
              ),
              gte(oiDailySnapshotsTable.date, cutoff),
            ),
          )
          .returning({
            id: oiDailySnapshotsTable.id,
            symbol: oiDailySnapshotsTable.symbol,
          }),
    );

    const cancelledTracked = await dbWriteStrict(
      "trackedSignal/collision-cancel",
      () =>
        db
          .update(trackedSignalsTable)
          .set({
            status: "cancelled",
            cancelReason: "coinglass_collision_cleanup",
            closedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(
                trackedSignalsTable.symbol,
                MANUALLY_VERIFIED_COLLISION_SYMBOLS,
              ),
              eq(trackedSignalsTable.sentimentKey, "oi24h_accumulation"),
              inArray(trackedSignalsTable.status, [
                "active",
                "in_run",
              ] as any[]),
              sql`NOT (
                ${trackedSignalsTable.runnerState} = 'open'
                AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
              )`,
            ),
          )
          .returning({
            id: trackedSignalsTable.id,
            symbol: trackedSignalsTable.symbol,
            sentimentKey: trackedSignalsTable.sentimentKey,
            detectedAt: trackedSignalsTable.detectedAt,
            entryPrice: trackedSignalsTable.entryPrice,
            pnlPercent: trackedSignalsTable.pnlPercent,
            peakPrice: trackedSignalsTable.peakPrice,
          }),
    );

    for (const r of cancelledTracked) {
      void _writeExitMetrics(r.id, r.symbol);
      const _peakPct =
        r.peakPrice != null && r.entryPrice > 0
          ? ((r.peakPrice - r.entryPrice) / r.entryPrice) * 100
          : (r.pnlPercent ?? 0);
      await recordCloseSnapshot(
        {
          id: r.id,
          symbol: r.symbol,
          sentimentKey: r.sentimentKey,
          detectedAt: r.detectedAt,
        },
        r.entryPrice,
        r.pnlPercent ?? 0,
        _peakPct,
        "cancelled",
      );
    }

    if (clearedSnapshots.length > 0 || cancelledTracked.length > 0) {
      logger.info(
        {
          clearedSnapshots: clearedSnapshots.length,
          cancelledTracked: cancelledTracked.map((t) => `${t.symbol}#${t.id}`),
        },
        "OI collision cleanup (ручной whitelist): очищены подтверждённые артефакты",
      );
    }
  } catch (err) {
    logger.error({ err }, "OI collision cleanup error");
  }
}

// ── Разовое восстановление ложной отмены APE-USDT (2026-07-10) ───────────────
// Сломанная версия cleanupOiCollisionArtifacts (см. выше) отменила APE-USDT
// без ручной проверки — единственная неподтверждённая отмена среди четырёх.
// Возвращаем сигнал в активное состояние. Идемпотентно: условие WHERE ловит
// только конкретную запись с этой cancel_reason, повторный запуск — no-op.
export async function restoreFalseApeCancellation(): Promise<void> {
  try {
    const restored = await dbWriteStrict("trackedSignal/ape-restore", () =>
      db
        .update(trackedSignalsTable)
        .set({
          status: "active",
          cancelReason: null,
          closedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.symbol, "APE-USDT"),
            eq(trackedSignalsTable.id, 716),
            eq(trackedSignalsTable.cancelReason, "coinglass_collision_cleanup"),
          ),
        )
        .returning({ id: trackedSignalsTable.id }),
    );

    if (restored.length > 0) {
      logger.info(
        { restored: restored.length },
        "APE-USDT: отменена ложная отмена coinglass_collision_cleanup, сигнал восстановлен",
      );
    }
  } catch (err) {
    logger.error({ err }, "APE-USDT restore error");
  }
}

// ── Разовое восстановление ложной отмены FF-USDT ──────────────────────────────
// FF-USDT (#1273) был закрыт старой stale_oi_vol-логикой до отключения
// автоматических отмен Stealth Breakout. Идемпотентно: WHERE требует
// конкретную запись, паттерн и исходную причину отмены.
export async function restoreFalseStealthBreakoutCancellation(): Promise<void> {
  try {
    const restored = await dbWriteStrict("trackedSignal/ff-restore", () =>
      db
        .update(trackedSignalsTable)
        .set({
          status: "active",
          exitPrice: null,
          pnlPercent: null,
          cancelReason: null,
          closedAt: null,
          lastSmartCancelCheckAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trackedSignalsTable.id, 1273),
            eq(trackedSignalsTable.symbol, "FF-USDT"),
            eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
            eq(trackedSignalsTable.status, "cancelled"),
            eq(trackedSignalsTable.cancelReason, "stale_oi_vol"),
          ),
        )
        .returning({
          id: trackedSignalsTable.id,
          symbol: trackedSignalsTable.symbol,
        }),
    );

    if (restored.length > 0) {
      logger.info(
        { restored: restored.length },
        "FF-USDT: ложная stale_oi_vol отмена отменена, сигнал восстановлен",
      );
    }
  } catch (err) {
    logger.error({ err }, "FF-USDT restore error");
  }
}

/**
 * User-reviewed Stealth rows that never represented a valid current breakout
 * are retained as an audit trail, but are neither open positions nor outcomes.
 * The exact ids fence this one-time correction from touching later signals with
 * the same symbols. HUMA-USDT, S-USDT, and the FLOCK positive control are
 * intentionally absent. Source signals remain for audit and FK integrity;
 * reclassified tracked rows are excluded from trading statistics.
 */
export async function reclassifyFalseStealthBreakouts(): Promise<void> {
  try {
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .update(trackedSignalsTable)
        .set({
          status: "reclassified",
          exitPrice: null,
          pnlPercent: null,
          cancelReason: STEALTH_RECLASSIFICATION_REASON,
          closedAt: null,
          trailingStopLevel: null,
          lastSmartCancelCheckAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(trackedSignalsTable.id, [
              ...STEALTH_RECLASSIFIED_TRACKED_IDS,
            ]),
            inArray(trackedSignalsTable.symbol, [
              ...STEALTH_RECLASSIFIED_SYMBOLS,
            ]),
            eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
            inArray(trackedSignalsTable.status, ["active", "in_run"]),
            sql`NOT (
              ${trackedSignalsTable.runnerState} = 'open'
              AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
            )`,
          ),
        )
        .returning({
          id: trackedSignalsTable.id,
          symbol: trackedSignalsTable.symbol,
        });

      await tx.execute(sql`
        UPDATE stealth_breakout_armed_setups
        SET
          status = 'reclassified',
          terminal_reason = ${STEALTH_RECLASSIFICATION_REASON},
          updated_at = now()
        WHERE id IN (${sql.join(
          STEALTH_RECLASSIFIED_ARM_IDS.map((id) => sql`${id}`),
          sql`, `,
        )})
          AND symbol IN (${sql.join(
            STEALTH_RECLASSIFIED_SYMBOLS.map((symbol) => sql`${symbol}`),
            sql`, `,
          )})
          AND status IN ('armed', 'qualified', 'firing', 'fired')
      `);
      return rows;
    });
    if (result.length > 0) {
      logger.info(
        { count: result.length, symbols: result.map((row) => row.symbol) },
        "Stealth false breakouts moved from positions to neutral observation",
      );
    }
  } catch (err) {
    logger.error({ err }, "Stealth false-breakout reclassification failed");
    throw err;
  }
}

/**
 * One-time correction for the 1000BONK Stealth alert that was emitted from
 * the wrong legacy level. The alert is not a valid trade: keep its durable
 * tracker and ARMED decision as a neutral observation, remove the
 * signal-feed row, and clear only signal-specific foreign-key rows that
 * cannot survive the signal deletion.
 *
 * This is intentionally fenced by exact ids and symbol so a restart cannot
 * affect a later 1000BONK event.
 */
export async function moveInvalid1000BonkStealthToObservation(): Promise<void> {
  const signalId = 3066;
  const trackedId = 1397;
  const armedId = 897;
  const symbol = "1000BONK-USDT";
  const reason = "stealth_false_breakout_reclassified";

  try {
    const result = await db.transaction(async (tx) => {
      const tracked = await tx.execute(sql`
        SELECT id
        FROM tracked_signals
        WHERE id = ${trackedId}
          AND signal_id = ${signalId}
          AND symbol = ${symbol}
          AND sentiment_key = 'stealth_breakout'
          AND status IN ('active', 'in_run')
        FOR UPDATE
      `);

      const signal = await tx.execute(sql`
        SELECT id
        FROM signals
        WHERE id = ${signalId}
          AND symbol = ${symbol}
          AND sentiment_key = 'stealth_breakout'
        FOR UPDATE
      `);

      if (tracked.rows.length === 0 || signal.rows.length === 0) {
        return { tracked: 0, signal: 0 };
      }

      await tx.execute(sql`
        UPDATE tracked_signals
        SET
          status = 'reclassified',
          signal_id = NULL,
          exit_price = NULL,
          pnl_percent = NULL,
          cancel_reason = ${reason},
          closed_at = NULL,
          trailing_stop_level = NULL,
          last_smart_cancel_check_at = NULL,
          updated_at = now()
        WHERE id = ${trackedId}
          AND signal_id = ${signalId}
          AND symbol = ${symbol}
      `);

      await tx.execute(sql`
        UPDATE stealth_breakout_armed_setups
        SET
          status = 'reclassified',
          terminal_reason = ${reason},
          fired_signal_id = NULL,
          updated_at = now()
        WHERE id = ${armedId}
          AND symbol = ${symbol}
          AND fired_signal_id = ${signalId}
          AND status = 'fired'
      `);

      // This table deliberately requires signal_id, so its signal-specific
      // enrichment row must be removed before the parent signal can go.
      await tx.execute(sql`
        DELETE FROM altbullet_indicator_snapshots
        WHERE signal_id = ${signalId}
      `);

      const deleted = await tx.execute(sql`
        DELETE FROM signals
        WHERE id = ${signalId}
          AND symbol = ${symbol}
          AND sentiment_key = 'stealth_breakout'
        RETURNING id
      `);

      return { tracked: 1, signal: deleted.rows.length };
    });

    if (result.signal > 0) {
      logger.warn(
        { signalId, trackedId, armedId, symbol, reason },
        "Invalid 1000BONK Stealth signal moved to neutral observation",
      );
    }
  } catch (err) {
    logger.error(
      { err, signalId, trackedId, armedId, symbol },
      "1000BONK invalid Stealth signal correction failed",
    );
    throw err;
  }
}

// ── Одноразовая очистка сигналов удалённых паттернов (2026-07-15) ─────────────
// В таблице signals накопился шум от паттернов, удалённых из кода (особенно
// oi24h_accumulation — 21 из 60 последних записей). Журнал сделок читает
// tracked_signals — его НЕ трогаем (там живые позиции PUMP/BTC/XAUT и история
// для аналитики). Удаляем только из signals (лента сигналов в UI).
// Идемпотентно: паттерны из списка больше не стреляют, повторный прогон — no-op.
// Dev shell не имеет write-доступа к проду, поэтому фикс едет кодом при деплое
// (см. prod-data-fix-as-code). Можно удалить функцию после подтверждения на проде.
// DEAD_PATTERN_KEYS imported from dead-patterns.ts

export async function cleanupDeadPatternSignals(): Promise<void> {
  try {
    // FK-защита: строки signals, на которые ссылаются tracked_signals.signal_id, не удаляем.
    const deleted = await dbWriteStrict("signals/dead-pattern-delete", () =>
      db
        .delete(signalsTable)
        .where(
          and(
            inArray(signalsTable.sentimentKey, DEAD_PATTERN_KEYS),
            sql`${signalsTable.id} NOT IN (SELECT signal_id FROM tracked_signals WHERE signal_id IS NOT NULL)`,
          ),
        )
        .returning({ id: signalsTable.id }),
    );
    if (deleted.length > 0) {
      logger.info(
        { deleted: deleted.length, keys: DEAD_PATTERN_KEYS.length },
        "🧹 Очистка signals: удалены записи мёртвых паттернов",
      );
    }
  } catch (err) {
    logger.error({ err }, "cleanupDeadPatternSignals error");
  }
}

/** Отменяет открытые позиции (active/in_run) с мёртвыми паттернами.
 *  Идемпотентно: повторный вызов — no-op (строки уже cancelled). */
export async function cancelDeadPatternTrackedSignals(): Promise<void> {
  try {
    const cancelled = await dbWriteStrict(
      "trackedSignal/dead-pattern-cancel",
      () =>
        db
          .update(trackedSignalsTable)
          .set({
            status: "cancelled",
            cancelReason: "dead_pattern",
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(trackedSignalsTable.status, ["active", "in_run"]),
              inArray(trackedSignalsTable.sentimentKey!, DEAD_PATTERN_KEYS),
              sql`NOT (
                ${trackedSignalsTable.runnerState} = 'open'
                AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
              )`,
            ),
          )
          .returning({
            id: trackedSignalsTable.id,
            symbol: trackedSignalsTable.symbol,
            sentimentKey: trackedSignalsTable.sentimentKey,
            detectedAt: trackedSignalsTable.detectedAt,
            entryPrice: trackedSignalsTable.entryPrice,
            pnlPercent: trackedSignalsTable.pnlPercent,
            peakPrice: trackedSignalsTable.peakPrice,
          }),
    );
    for (const r of cancelled) {
      void _writeExitMetrics(r.id, r.symbol);
      const _peakPct =
        r.peakPrice != null && r.entryPrice > 0
          ? ((r.peakPrice - r.entryPrice) / r.entryPrice) * 100
          : (r.pnlPercent ?? 0);
      await recordCloseSnapshot(
        {
          id: r.id,
          symbol: r.symbol,
          sentimentKey: r.sentimentKey,
          detectedAt: r.detectedAt,
        },
        r.entryPrice,
        r.pnlPercent ?? 0,
        _peakPct,
        "cancelled",
      );
    }
    if (cancelled.length > 0) {
      logger.info(
        {
          cancelled: cancelled.length,
          detail: cancelled
            .map((r) => `${r.symbol}(${r.sentimentKey})`)
            .join(", "),
        },
        "🧹 Отменены открытые позиции с мёртвыми паттернами",
      );
    }
  } catch (err) {
    logger.error({ err }, "cancelDeadPatternTrackedSignals error");
  }
}

// Snapshot of the seven OPEN positions confirmed below -5% on 2026-09-23.
// Do not sweep future signals: this is an operator-requested one-time action.
const REQUESTED_STOP_IDS = [1756, 1762, 1782, 1790, 1796, 1798, 1801];

export async function closeRequestedLossesBeforeScanner(): Promise<void> {
  const open = await db
    .select()
    .from(trackedSignalsTable)
    .where(
      and(
        inArray(trackedSignalsTable.id, REQUESTED_STOP_IDS),
        eq(trackedSignalsTable.status, "active"),
      ),
    );
  if (open.length === 0) return;

  // An empty/partial global response is an outage, NOT evidence that every
  // symbol has disappeared. Leave the scanner paused so startup can retry.
  const tickers = await getFutureTickers();
  if (tickers.length < 100) {
    throw new Error(
      `Requested stop: incomplete BingX ticker list (${tickers.length})`,
    );
  }
  const prices = new Map(
    tickers
      .map((ticker) => [ticker.symbol, Number(ticker.lastPrice)] as const)
      .filter(([, price]) => Number.isFinite(price) && price > 0),
  );
  let closed = 0;
  let unavailable = 0;
  for (const tracked of open) {
    let marketPrice = prices.get(tracked.symbol);
    if (marketPrice === undefined) {
      // Recheck an individual missing listing before recording unknown PnL.
      const individual = await getFutureTicker(tracked.symbol);
      const individualPrice = Number(individual?.lastPrice);
      if (
        individual &&
        Number.isFinite(individualPrice) &&
        individualPrice > 0
      ) {
        marketPrice = individualPrice;
      }
    }
    const decision = requestedStopDecision(tracked.entryPrice, marketPrice);
    if (!decision) continue;

    const closedAt = new Date();
    const knownPrice = decision.exitPrice !== null;
    const text = knownPrice
      ? `🛑 <b>Принудительное закрытие по стоп-лоссу</b>\n\n` +
        `<b>${tracked.symbol}</b>\n` +
        `Вход: $${tracked.entryPrice.toPrecision(4)} → Выход: $${decision.exitPrice!.toPrecision(4)}\n` +
        `PnL: <b>${decision.pnlPercent!.toFixed(2)}%</b>\n` +
        `По запросу владельца. #stop_loss`
      : `🛑 <b>Принудительное закрытие по стоп-лоссу</b>\n\n` +
        `<b>${tracked.symbol}</b>\n` +
        `Котировка недоступна: цена выхода и PnL неизвестны.\n` +
        `По запросу владельца. #stop_loss`;
    const delivery = await broadcastPhotoAfterClaim(
      STOPLOSS_IMG,
      text,
      `position:${tracked.id}:requested-stop:2026-09-23`,
      async (tx) => {
        const claimed = await tx
          .update(trackedSignalsTable)
          .set({
            status: "stop_loss",
            exitPrice: decision.exitPrice,
            pnlPercent: decision.pnlPercent,
            closedAt,
            updatedAt: closedAt,
          })
          .where(
            and(
              eq(trackedSignalsTable.id, tracked.id),
              eq(trackedSignalsTable.status, "active"),
              eq(trackedSignalsTable.entryPrice, tracked.entryPrice),
            ),
          )
          .returning({ id: trackedSignalsTable.id });
        return claimed.length > 0;
      },
    );
    if (!delivery.claimed) continue;
    closed++;
    if (!knownPrice) {
      unavailable++;
    } else {
      void _writeExitMetrics(tracked.id, tracked.symbol);
      await recordCloseSnapshot(
        tracked,
        decision.exitPrice!,
        decision.pnlPercent!,
        tracked.peakPrice
          ? computePnl(tracked, tracked.peakPrice)
          : decision.pnlPercent!,
        "stop_loss",
      );
    }
    logger.warn(
      {
        id: tracked.id,
        symbol: tracked.symbol,
        pnl: decision.pnlPercent,
        queued: delivery.queued,
      },
      "Operator-requested stop-loss claimed before scanner",
    );
  }
  logger.info(
    { checked: open.length, closed, unavailable },
    "Operator-requested stop-loss batch completed before scanner",
  );
}

export async function runStartupReset(): Promise<void> {
  // Reconcile these durable operator-requested milestone intents independently from the
  // runner loop. It may enqueue a pending-recipient-resolution job, but never
  // delays the economic startup close.
  void enqueueBrMissedMilestones();

  // Historical versions persisted a sampled post-gap market price for BE.
  // stops. The protected exit must instead remain at entry, with zero PnL for
  // the remaining position.
  try {
    const normalized = await db
      .update(trackedSignalsTable)
      .set({
        exitPrice: trackedSignalsTable.entryPrice,
        pnlPercent: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(trackedSignalsTable.status, "bu_stop"),
          or(
            sql`${trackedSignalsTable.pnlPercent} IS DISTINCT FROM 0`,
            sql`${trackedSignalsTable.exitPrice} IS DISTINCT FROM ${trackedSignalsTable.entryPrice}`,
          ),
        ),
      )
      .returning({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
      });
    if (normalized.length > 0) {
      logger.warn(
        {
          count: normalized.length,
          symbols: normalized.map((row) => row.symbol),
        },
        "Normalized legacy BE stops to protected entry exit",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to normalize legacy BE stop PnL");
  }

  // ── ONE-TIME: restore false no_price_30m cancels from 2026-08-16 ───────────
  // BingX returned HTTP 200 with non-zero error code → empty ticker list
  // → all active signals cancelled. Fixed in bingx.ts + FastCycle guard.
  // IDs confirmed via prod DB query. Idempotent: filter on status+cancel_reason.
  try {
    const _falseNoPriceIds = [
      1180, 1181, 1182, 1199, 1202, 1204, 1205, 1206, 1207,
    ];
    const _restored = await db
      .update(trackedSignalsTable)
      .set({
        status: "active",
        cancelReason: null,
        closedAt: null,
        updatedAt: new Date(),
      })
      .where(
        sql`${trackedSignalsTable.id} = ANY(${sql.raw(`ARRAY[${_falseNoPriceIds.join(",")}]::int[]`)}) AND ${trackedSignalsTable.status} = 'cancelled' AND ${trackedSignalsTable.cancelReason} = 'no_price_30m'`,
      )
      .returning({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
      });
    if (_restored.length > 0) {
      logger.info(
        { symbols: _restored.map((r) => r.symbol) },
        "ONE-TIME: restored false no_price_30m cancels (2026-08-16 BingX outage)",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "ONE-TIME: failed to restore false no_price_30m cancels",
    );
  }

  // Проверяем active (стоп-лосс персональный или -10%)
  // и in_run (трейлинг стоп / бу-стоп)
  const openSignals = await db
    .select()
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));

  if (openSignals.length === 0) return;

  // ── Retry: BingX API нестабилен при холодном старте (таймауты, DNS) ──────
  // 3 попытки с экспоненциальной задержкой. Если все упали — логируем и выходим.
  // НЕ молчим: раньше был просто return, что скрывало пропуск стоп-лоссов.
  let tickers: { symbol: string; lastPrice: string }[] = [];
  let fetchOk = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      tickers = (await getFutureTickers()) as any[];
      fetchOk = true;
      break;
    } catch (err) {
      logger.warn(
        { err, attempt },
        `Startup reset: BingX fetch attempt ${attempt}/3 failed`,
      );
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  if (!fetchOk) {
    logger.error(
      "Startup reset: все попытки получить цены провалились — стоп-лоссы не проверены",
    );
    return;
  }

  const priceMap = new Map<string, number>();
  for (const t of tickers) priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);

  let resetCount = 0;
  for (const tracked of openSignals) {
    const currentPrice = priceMap.get(tracked.symbol);
    if (!currentPrice) continue;

    // ── SPLIT-ENTRY reconciliation ДО стоп-чека ─────────────────────────────
    // Если за время даунтайма цена коснулась лимитки −5% — сначала применяем
    // усреднение (entryPrice → средняя, стоп ниже), и только потом решаем стоп.
    // Иначе рестарт ложно закрывает позиции, которые под сплит-моделью живы.
    if (
      tracked.status === "active" &&
      tracked.lastMilestone == null &&
      !tracked.isShort &&
      tracked.splitLimitPrice != null &&
      tracked.splitFilledAt == null &&
      tracked.entryPolicyVersion == null &&
      currentPrice <= tracked.splitLimitPrice
    ) {
      try {
        const splitFill = resolveLongSplitFillAdjustment({
          entryPrice: tracked.entryPrice,
          splitLimitPrice: tracked.splitLimitPrice,
          stopLossPct: effStopPct(tracked),
        });
        const _avgEntry = splitFill.entryPrice;
        const _newStopPrice = splitFill.stopLossPrice;
        const _resetPeakPrice = splitFill.peakPrice;
        const _origEntry = tracked.originalEntryPrice ?? tracked.entryPrice;
        const _fmtP = (price: number) =>
          price < 1
            ? price.toFixed(6)
            : price < 100
              ? price.toFixed(4)
              : price.toFixed(2);
        const fillMessage =
          `📥 <b>${tracked.symbol} — лимитка −5% сработала пока бот перезапускался</b>\n` +
          `💰 Вход: $${_fmtP(_origEntry)} → средняя $${_fmtP(_avgEntry)} (−2.5%)\n` +
          `🛑 Стоп смещён: $${_fmtP(_newStopPrice)} (−${effStopPct(tracked).toFixed(1)}% от средней)\n` +
          `${formatMarketLinks(tracked.symbol)}\n` +
          `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)}`;
        const filledAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          POSITION_UPDATE_IMG,
          fillMessage,
          `position:${tracked.id}:split_fill`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                originalEntryPrice: _origEntry,
                entryPrice: _avgEntry,
                splitFilledAt: filledAt,
                stopLossPrice: _newStopPrice,
                peakPrice: _resetPeakPrice,
                trailingStopLevel: null,
                trailingStopArmedAt: null,
                updatedAt: filledAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.splitFilledAt} IS NULL AND ${trackedSignalsTable.status} = 'active'`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          tracked.originalEntryPrice = _origEntry;
          tracked.entryPrice = _avgEntry;
          tracked.splitFilledAt = filledAt;
          tracked.stopLossPrice = _newStopPrice;
          tracked.peakPrice = _resetPeakPrice;
          tracked.trailingStopLevel = null;
          tracked.trailingStopArmedAt = null;
          logger.info(
            {
              symbol: tracked.symbol,
              avgEntry: _avgEntry,
              queued: delivery.queued,
            },
            "Startup reset: SPLIT FILL применён до стоп-чека 📥",
          );
        } else {
          // Другой процесс уже применил fill — перечитываем актуальную строку
          const _fresh = await db
            .select()
            .from(trackedSignalsTable)
            .where(eq(trackedSignalsTable.id, tracked.id))
            .limit(1);
          if (_fresh[0]) Object.assign(tracked, _fresh[0]);
        }
      } catch (err) {
        logger.warn(
          { err, symbol: tracked.symbol },
          "Startup reset: split-fill/outbox failed — signal deferred",
        );
        continue;
      }
    }

    // A runner-open row is never evaluated by the legacy startup BE/trailing
    // branches below. Restore its independent durable high-water boundary first
    // and route any hit through the exactly-once runner finalizer.
    if (tracked.status === "in_run" && isImpulseRunnerCoreClosed(tracked)) {
      const startupObservedAt = new Date();
      const runnerEntryPrice = tracked.originalEntryPrice ?? tracked.entryPrice;
      const runnerPeak = Math.max(
        runnerEntryPrice,
        tracked.runnerPeakPrice ?? runnerEntryPrice,
        tracked.peakPrice ?? runnerEntryPrice,
        currentPrice,
      );
      const runnerStop = resolveImpulseRunnerTrailingStopPrice({
        entryPrice: runnerEntryPrice,
        peakPrice: runnerPeak,
        persistedTrailingStopLevel: tracked.runnerTrailingStopLevel,
      });
      await dbWriteBestEffort("trackedSignal/startup-runner-recovery", () =>
        db
          .update(trackedSignalsTable)
          .set({
            runnerPeakPrice: maxPeakPriceSql(runnerPeak),
            runnerTrailingStopLevel:
              runnerStop == null
                ? trackedSignalsTable.runnerTrailingStopLevel
                : sql<number>`GREATEST(COALESCE(${trackedSignalsTable.runnerTrailingStopLevel}, 0), ${runnerStop})`,
            runnerTrailingStopArmedAt:
              runnerStop == null
                ? trackedSignalsTable.runnerTrailingStopArmedAt
                : sql<Date>`COALESCE(${trackedSignalsTable.runnerTrailingStopArmedAt}, ${startupObservedAt})`,
            peakPrice: maxPeakPriceSql(runnerPeak),
            updatedAt: startupObservedAt,
          })
          .where(
            sql`${trackedSignalsTable.id} = ${tracked.id}
              AND ${trackedSignalsTable.status} = 'in_run'
              AND ${trackedSignalsTable.runnerState} = 'open'
              AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL`,
          ),
      );
      const [recoveredRunner] = await db
        .select()
        .from(trackedSignalsTable)
        .where(
          sql`${trackedSignalsTable.id} = ${tracked.id}
            AND ${trackedSignalsTable.status} = 'in_run'
            AND ${trackedSignalsTable.runnerState} = 'open'`,
        )
        .limit(1);
      if (!recoveredRunner) continue;
      Object.assign(tracked, recoveredRunner);
      const durableRunnerPeak = tracked.runnerPeakPrice ?? runnerPeak;
      const durableRunnerStop = tracked.runnerTrailingStopLevel;
      if (
        await reconcileHistoricalRunnerTrailingStop({
          tracked,
          durablePeak: durableRunnerPeak,
          durableStop: durableRunnerStop,
          observedAt: startupObservedAt,
        })
      ) {
        resetCount++;
        continue;
      }
      if (isImpulseRunnerFiveDaysOld(tracked.detectedAt, startupObservedAt)) {
        await closeImpulseRunnerFinalPosition({
          tracked,
          exitPrice: currentPrice,
          peakPrice: durableRunnerPeak,
          priceSource: "startup_reset",
          exitReason: "age_expired",
        });
        resetCount++;
        continue;
      }
      const runnerDecision = resolveImpulseRunnerExitDecision({
        entryPrice: runnerEntryPrice,
        currentPrice,
        peakPrice: durableRunnerPeak,
        persistedStopLossPct: tracked.stopLossPct,
        entryPolicyVersion: tracked.entryPolicyVersion,
        persistedTrailingStopLevel: durableRunnerStop,
      });
      const runnerHit = runnerDecision.hit;
      if (runnerHit) {
        await closeImpulseRunnerFinalPosition({
          tracked,
          exitPrice: runnerDecision.exitPrice!,
          peakPrice: durableRunnerPeak,
          priceSource: "startup_reset",
          exitReason: runnerDecision.reason!,
        });
      }
      resetCount++;
      continue;
    }

    const pnl = computePnl(tracked, currentPrice);
    const startupPersistedPeakPnl =
      tracked.peakPrice != null ? computePnl(tracked, tracked.peakPrice) : null;
    const startupBuProtection = resolveBuStopProtection({
      sentimentKey: tracked.sentimentKey,
      symbol: tracked.symbol,
      lastMilestone: tracked.lastMilestone,
      persistedPeakPnlPercent: startupPersistedPeakPnl,
    });
    const startupActiveBuProtectionEarned =
      tracked.status === "active" && startupBuProtection.earned;

    // An older BTC row can still be "active" after a durable +2% peak.
    // Honor its earned trailing boundary before the generic active BE/stop
    // checks, even if the +1% first-target transition was missed.
    if (tracked.status === "active" && isBitcoinTrackedSignal(tracked)) {
      const exitProfile = getExitProfile(tracked.sentimentKey, tracked.symbol);
      const peakPrice = Math.max(
        tracked.entryPrice,
        tracked.peakPrice ?? tracked.entryPrice,
        currentPrice,
      );
      const trailingStop = resolveActivatedTrailingStopLevel({
        peakPnlPercent: computePnl(tracked, peakPrice),
        trailingActivationPercent: exitProfile.trailingActivation,
        entryPrice: tracked.entryPrice,
        peakPrice,
        trailingGapPercent: exitProfile.trailingGap,
        persistedTrailingStopLevel: tracked.trailingStopLevel,
      });
      if (trailingStop !== null && currentPrice <= trailingStop) {
        const closed = await closeTrailingPosition({
          tracked,
          currentPrice,
          peakPrice,
          trailingStop,
          exitProfile,
          observedAt: new Date(),
          priceSource: "startup_reset",
        });
        if (closed) {
          resetCount++;
          continue;
        }
      }
    }

    // ── active: стоп-лосс (персональный или -10%) ─────────────────────────────
    // NO-TOUCH PERIOD: при рестарте сервера в первые 2ч/4ч — стоп не срабатывает
    // (тот же guard что и в fast cycle). Сигнал был открыт недавно — рынку нужно время.
    if (startupActiveBuProtectionEarned && currentPrice <= tracked.entryPrice) {
      const protectedExit = getProtectedBuStopExit(
        tracked.entryPrice,
        startupBuProtection.protectedProfitPct,
      );
      const closedAt = new Date();
      const delivery = await broadcastPhotoAfterClaim(
        BU_STOP_IMG,
        msgBUStop(
          tracked,
          protectedExit.exitPrice ?? tracked.entryPrice,
          protectedExit.pnlPercent,
          null,
        ),
        `position:${tracked.id}:startup:active_bu_stop`,
        async (tx) => {
          const claimed = await tx
            .update(trackedSignalsTable)
            .set({
              status: "bu_stop",
              exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
              pnlPercent: protectedExit.pnlPercent,
              lastMilestone: Math.max(
                tracked.lastMilestone ?? 0,
                startupBuProtection.milestone,
              ),
              closedAt,
              updatedAt: closedAt,
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
            )
            .returning({ id: trackedSignalsTable.id });
          return claimed.length > 0;
        },
      );
      if (delivery.claimed) {
        void _writeExitMetrics(tracked.id, tracked.symbol);
        await recordCloseSnapshot(
          tracked,
          protectedExit.exitPrice ?? tracked.entryPrice,
          protectedExit.pnlPercent,
          startupPersistedPeakPnl ?? pnl,
          "bu_stop",
        );
        logger.warn(
          {
            symbol: tracked.symbol,
            persistedPeakPnl: startupPersistedPeakPnl,
            queued: delivery.queued,
          },
          "Startup reset: active BE protection recovered and closed",
        );
      }
      resetCount++;
      continue;
    }

    const _startupAgeMs = Date.now() - tracked.detectedAt.getTime();
    if (
      tracked.status === "active" &&
      _startupAgeMs >= getNoTouchStopMs(tracked.sentimentKey) &&
      pnl <= -effStopPct(tracked)
    ) {
      const _fill = stopLossFill(tracked, currentPrice, pnl);
      const msg =
        `🛑 <b>Пропущен стоп-лосс (сервер перезапускался)</b>\n\n` +
        `<b>${tracked.symbol}</b>\n` +
        `Вход: <b>$${tracked.entryPrice.toPrecision(4)}</b> → Выход: <b>$${_fill.exitPrice.toPrecision(4)}</b>\n` +
        `Убыток: <b>${_fill.pnl.toFixed(1)}%</b>\n\n` +
        `Позиция закрыта по стоп-лоссу.\n` +
        `${formatMarketLinks(tracked.symbol)}\n\n` +
        `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} #stop_loss`;
      const closedAt = new Date();
      const delivery = await broadcastPhotoAfterClaim(
        STOPLOSS_IMG,
        msg,
        `position:${tracked.id}:startup:stop_loss`,
        async (tx) => {
          const claimed = await tx
            .update(trackedSignalsTable)
            .set({
              status: "stop_loss",
              exitPrice: _fill.exitPrice,
              pnlPercent: _fill.pnl,
              closedAt,
              updatedAt: closedAt,
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
            )
            .returning({ id: trackedSignalsTable.id });
          return claimed.length > 0;
        },
      );
      if (!delivery.claimed) {
        resetCount++;
        continue;
      } // другой процесс уже закрыл
      void _writeExitMetrics(tracked.id, tracked.symbol);
      await recordCloseSnapshot(
        tracked,
        _fill.exitPrice,
        _fill.pnl,
        tracked.peakPrice ? computePnl(tracked, tracked.peakPrice) : _fill.pnl,
        "stop_loss",
      );
      logger.warn(
        {
          symbol: tracked.symbol,
          status: tracked.status,
          entry: tracked.entryPrice,
          currentPrice,
          pnl: pnl.toFixed(1) + "%",
          queued: delivery.queued,
        },
        "🛑 Startup reset: missed stop-loss (active) — signal closed",
      );
      resetCount++;

      // ── in_run: проверка трейлинг-стопа ────────────────────────────────────
      // Порог первой цели и отступ трейлинга зависят от инструмента.
    } else if (tracked.status === "in_run") {
      const startupObservedAt = new Date();
      const exitProfileSr = getExitProfile(
        tracked.sentimentKey,
        tracked.symbol,
      );
      const highWater = resolveLongTrailingHighWater({
        entryPrice: tracked.entryPrice,
        durablePeakPrice: tracked.peakPrice,
        currentPrice,
        trailingActivationPercent: exitProfileSr.trailingActivation,
        trailingGapPercent: exitProfileSr.trailingGap,
      });
      const observedPeak =
        tracked.isShort === true
          ? (tracked.peakPrice ?? currentPrice)
          : highWater.peakPrice;
      const observedStop = highWater.trailingStopLevel;
      const startupPeakIncreased =
        observedPeak > (tracked.peakPrice ?? tracked.entryPrice);
      const startupStopIncreased =
        observedStop !== null &&
        observedStop > (tracked.trailingStopLevel ?? 0);
      let boundaryArmedByStartupObservation = false;
      if (
        tracked.isShort !== true &&
        (startupPeakIncreased || startupStopIncreased)
      ) {
        const advanced = await db
          .update(trackedSignalsTable)
          .set({
            peakPrice: observedPeak,
            ...(observedStop !== null
              ? {
                  trailingStopLevel: maxTrailingStopLevelSql(observedStop),
                  trailingStopArmedAt: trailingStopArmedAtSql(
                    observedStop,
                    startupObservedAt,
                  ),
                }
              : {}),
            updatedAt: startupObservedAt,
          })
          .where(
            sql`${trackedSignalsTable.id} = ${tracked.id}
              AND ${trackedSignalsTable.status} = 'in_run'
              AND ${trackedSignalsTable.isShort} = false
              AND (
                COALESCE(${trackedSignalsTable.peakPrice}, ${trackedSignalsTable.entryPrice}) < ${observedPeak}
                ${
                  observedStop !== null
                    ? sql`OR COALESCE(${trackedSignalsTable.trailingStopLevel}, 0) < ${observedStop}`
                    : sql``
                }
              )`,
          )
          .returning({
            trailingStopArmedAt: trackedSignalsTable.trailingStopArmedAt,
          });
        boundaryArmedByStartupObservation = advanced.some(
          (row) =>
            row.trailingStopArmedAt?.getTime() === startupObservedAt.getTime(),
        );
      }
      const [freshTracked] = await db
        .select()
        .from(trackedSignalsTable)
        .where(
          and(
            eq(trackedSignalsTable.id, tracked.id),
            eq(trackedSignalsTable.status, "in_run"),
          ),
        )
        .limit(1);
      if (!freshTracked) continue;
      Object.assign(tracked, freshTracked);
      const peak = tracked.peakPrice ?? currentPrice;
      const peakPnl = computePnl(tracked, peak);
      const activatedTrailingStop = resolveActivatedTrailingStopLevel({
        peakPnlPercent: peakPnl,
        trailingActivationPercent: exitProfileSr.trailingActivation,
        entryPrice: tracked.entryPrice,
        peakPrice: peak,
        trailingGapPercent: exitProfileSr.trailingGap,
        persistedTrailingStopLevel: tracked.trailingStopLevel,
      });
      const trailingActive = activatedTrailingStop !== null;
      const trailingStop =
        activatedTrailingStop ??
        resolveTrailingStopLevel({
          entryPrice: tracked.entryPrice,
          peakPrice: peak,
          trailingGapPercent: exitProfileSr.trailingGap,
          persistedTrailingStopLevel: null,
        });
      const trailingHit = isStartupTrailingStopHit({
        currentPrice,
        trailingStopLevel: trailingStop,
        trailingActive,
        trailingStopArmedAt: tracked.trailingStopArmedAt,
        observedAt: startupObservedAt,
        boundaryArmedByStartupObservation,
        startupPeakIncreased,
      });
      const startupProtectedProfitPct = startupBuProtection.protectedProfitPct;
      const startupProtectedExit = getProtectedBuStopExit(
        tracked.entryPrice,
        startupProtectedProfitPct,
      );
      const startupProtectedStopPrice =
        startupProtectedExit.exitPrice ?? tracked.entryPrice;
      const beStopHit =
        !trailingActive && currentPrice < startupProtectedStopPrice;

      if (trailingHit) {
        await closeTrailingPosition({
          tracked,
          currentPrice,
          peakPrice: peak,
          trailingStop,
          exitProfile: exitProfileSr,
          observedAt: startupObservedAt,
          priceSource: "startup_reset",
        });
        resetCount++;
        continue;
      }

      if (trailingHit || beStopHit) {
        // Для трейлинг-стопа фиксируем выход по теоретическому уровню:
        // peak PnL минус gap в процентных пунктах, а не по опрошенной цене.
        const protectedBuExit = beStopHit ? startupProtectedExit : null;
        const exitPrice = protectedBuExit?.exitPrice ?? trailingStop;
        const finalPnl =
          ((exitPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
        // beStopHit = price returned to entry → стоп в БУ (считается как прибыль)
        // trailingHit = трейлинг сработал → profit/stop_loss в зависимости от pnl
        const closedStatus = beStopHit
          ? "bu_stop"
          : finalPnl >= 0
            ? "profit"
            : "stop_loss";
        const recordedPnl =
          normalizeClosedPnlPercent(
            closedStatus,
            finalPnl,
            tracked.sentimentKey,
          ) ?? 0;
        const msg = trailingHit
          ? `🔴 <b>Пропущен трейлинг-стоп (сервер перезапускался)</b>\n\n` +
            `<b>${tracked.symbol}</b>\n` +
            `Вход: <b>$${tracked.entryPrice.toPrecision(4)}</b> → Выход по трейлингу: <b>$${trailingStop.toPrecision(4)}</b>\n` +
            `Пик: <b>$${peak.toPrecision(4)}</b> | Трейлинг уровень: <b>$${trailingStop.toPrecision(4)}</b>\n` +
            `P&L: <b>${recordedPnl >= 0 ? "+" : ""}${recordedPnl.toFixed(1)}%</b>\n\n` +
            `${formatMarketLinks(tracked.symbol)}\n\n${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} #trailing_stop`
          : msgBUStop(tracked, exitPrice, recordedPnl, null);
        const closedAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          trailingHit ? TRAILING_STOP_IMG : BU_STOP_IMG,
          msg,
          `position:${tracked.id}:startup:${trailingHit ? "trailing_stop" : "bu_stop"}`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: closedStatus,
                exitPrice,
                pnlPercent: recordedPnl,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                   AND ${trackedSignalsTable.status} = 'in_run'
                   AND (
                     ${trackedSignalsTable.coreClosedAt} IS NULL
                     OR ${trackedSignalsTable.runnerState} IS DISTINCT FROM 'open'
                   )`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (!delivery.claimed) {
          resetCount++;
          continue;
        } // другой процесс уже закрыл
        void _writeExitMetrics(tracked.id, tracked.symbol);
        if (trailingHit) {
          void recordActualTrailingEvent({
            tracked,
            eventType: "hit",
            observedAt: closedAt,
            peakPrice: peak,
            peakPnlPct: peakPnl,
            currentPrice,
            trailingStopPrice: trailingStop,
            activationPct: exitProfileSr.trailingActivation,
            trailingGapPct: exitProfileSr.trailingGap,
            actualStatus: closedStatus,
            actualExitPrice: exitPrice,
            actualPnlPct: recordedPnl,
            closedAt,
          }).catch(() => null);
        }
        await recordCloseSnapshot(
          tracked,
          exitPrice,
          recordedPnl,
          peakPnl,
          closedStatus,
        );
        logger.warn(
          {
            symbol: tracked.symbol,
            entry: tracked.entryPrice,
            peak,
            currentPrice,
            finalPnl: recordedPnl.toFixed(1) + "%",
            queued: delivery.queued,
          },
          trailingHit
            ? "🔴 Startup reset: missed trailing-stop (in_run) — signal closed"
            : "🔴 Startup reset: missed be-stop (in_run) — signal closed",
        );
        resetCount++;
      }

      // ── active: достигло первой цели пока сервер лежал → переводим в in_run ──
      // ВАЖНО: entryPrice НЕ сбрасываем — это реальная цена входа. Сигнал уже
      // выполнил условие перехода (+10%), поэтому корректный переход — in_run,
      // а не обнуление entry (что скрывает прибыль и ломает трейлинг).
    } else if (
      tracked.status === "active" &&
      pnl >= getExitProfile(tracked.sentimentKey, tracked.symbol).firstTarget
    ) {
      const exitProfile = getExitProfile(tracked.sentimentKey, tracked.symbol);
      const firstTargetTransition = buildStartupFirstTargetRecovery(
        tracked.id,
        exitProfile.firstTarget,
      );
      const startupPeak = Math.max(
        tracked.peakPrice ?? tracked.entryPrice,
        currentPrice,
      );
      const trailingStop = resolveTrailingStopLevel({
        entryPrice: tracked.entryPrice,
        peakPrice: startupPeak,
        trailingGapPercent: exitProfile.trailingGap,
        persistedTrailingStopLevel: tracked.trailingStopLevel,
      });
      // Older BTC positions already announced +1% as a partial milestone.
      // Promote them to in_run without sending a second +1% alert.
      if (
        isBitcoinTrackedSignal(tracked) &&
        (tracked.lastMilestone ?? 0) >= exitProfile.firstTarget
      ) {
        await dbWriteStrict("trackedSignal/startup-btc-in-run", () =>
          db
            .update(trackedSignalsTable)
            .set({
              status: "in_run",
              peakPrice: maxPeakPriceSql(startupPeak),
              ...(computePnl(tracked, startupPeak) >=
              exitProfile.trailingActivation
                ? {
                    trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                    trailingStopArmedAt: trailingStopArmedAtSql(
                      trailingStop,
                      new Date(),
                    ),
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id}
                AND ${trackedSignalsTable.status} = 'active'
                AND ${trackedSignalsTable.pendingMilestone} IS NULL`,
            ),
        );
        resetCount++;
        continue;
      }
      const sign = pnl >= 0 ? "+" : "";
      const btcStartupRecovery = isBitcoinTrackedSignal(tracked);
      const btcStartupTrailingActive =
        btcStartupRecovery &&
        computePnl(tracked, startupPeak) >= exitProfile.trailingActivation;
      const msg =
        (btcStartupRecovery
          ? `₿ <b>BTC достиг уровня +${firstTargetTransition.milestone}% пока бот перезапускался</b>\n\n`
          : `🚀 <b>Цель +${firstTargetTransition.milestone}% достигнута пока бот перезапускался</b>\n\n`) +
        `<b>${tracked.symbol}</b>\n` +
        `Вход: <b>$${tracked.entryPrice.toPrecision(4)}</b> → Сейчас: <b>$${currentPrice.toPrecision(4)}</b>\n` +
        `Профит: <b>${sign}${pnl.toFixed(1)}%</b>\n\n` +
        (btcStartupRecovery
          ? btcStartupTrailingActive
            ? `Сигнал переведён в <b>IN RUN</b>. BTC-трейлинг активен с +2%: стоп отстоит на 1 п.п. от пика. Это не подтверждение биржевого исполнения.\n`
            : `Сигнал переведён в <b>IN RUN</b>. BTC-стоп в Б/У на цене входа; трейлинг включится только при пике +2%. Это не подтверждение биржевого исполнения.\n`
          : `Сигнал переведён в <b>IN RUN</b>. Стоп перенесён в безубыток.\n`) +
        `${formatMarketLinks(tracked.symbol)}\n\n` +
        `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} #in_run`;
      const transitionedAt = new Date();
      const delivery = await broadcastPhotoAfterClaim(
        milestoneImageFor(tracked, firstTargetTransition.imageMilestone) ??
          FIRST_TARGET_IMG,
        msg,
        firstTargetTransition.eventKey,
        async (tx) => {
          const claimed = await tx
            .update(trackedSignalsTable)
            .set({
              status: "in_run",
              peakPrice: maxPeakPriceSql(startupPeak),
              ...(computePnl(tracked, startupPeak) >=
              exitProfile.trailingActivation
                ? {
                    trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                    trailingStopArmedAt: trailingStopArmedAtSql(
                      trailingStop,
                      transitionedAt,
                    ),
                  }
                : {}),
              lastMilestone: firstTargetTransition.lastMilestone,
              updatedAt: transitionedAt,
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
            )
            .returning({ id: trackedSignalsTable.id });
          return claimed.length > 0;
        },
      );
      if (!delivery.claimed) {
        resetCount++;
        continue;
      } // другой процесс уже перевёл
      logger.warn(
        {
          symbol: tracked.symbol,
          entry: tracked.entryPrice,
          currentPrice,
          pnl: pnl.toFixed(1) + "%",
          queued: delivery.queued,
        },
        "🚀 Startup reset: first target reached while down — transitioned to in_run",
      );
      resetCount++;
    }
  }

  if (resetCount > 0) {
    logger.info(
      { resetCount },
      "Startup reset complete: missed moves notified, entries normalized",
    );
  } else {
    logger.info(
      "Startup reset: all active signals are fresh (no reset needed)",
    );
  }
}

// ── Shared DB retry helper для транзиентного истощения Neon-пула ─────────────
// Несколько фоновых джобов (fast/watcher циклы, price-backfill трекеры) делают
// один "начальный" SELECT в начале своего цикла. Раньше каждая функция либо не
// ретраила вовсе (единичный timeout = весь бэкфилл/цикл пропущен без восстановления),
// либо копировала свой собственный retry-loop (как было в runInRunFastCycle).
// Единая обёртка — чтобы чинить устойчивость к пул-таймаутам один раз, а не
// патчить каждый вызов по отдельности при каждом новом всплытии проблемы.
async function dbReadWithRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 5_000,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastErr = err;
      logger.warn(
        { err, attempt },
        `${label}: fetch attempt ${attempt}/${attempts} failed`,
      );
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  logger.error(
    { err: lastErr },
    `${label}: fetch failed after ${attempts} attempts — skipping`,
  );
  return { ok: false };
}

// ── Exit metrics: полный рыночный снапшот при закрытии сигнала ────────────────
// Пишется best-effort ПОСЛЕ каждого перехода в финальный статус (profit/stop_loss/
// cancelled/breakeven/bu_stop). Источник — in-memory prescanTracker (данные
// последнего scan-цикла, до ~14 мин давности) + кэш funding rate. Ноль API-вызовов.
// Null-поля = токен вне prescan в момент закрытия (выпал из топ-N / cold start).
// Fire-and-forget: вызывать как `void _writeExitMetrics(id, symbol)`.
// Экспортируется для admin bulk-cancel в routes/tracker.ts (spot-audit).
export async function _writeExitMetrics(
  id: number,
  symbol: string,
): Promise<void> {
  try {
    const pe = getPrescanEntry(symbol);
    const _fr = getLatestFundingRate(symbol);
    if (!pe && _fr == null) return; // нет никаких данных — не пишем пустую строку
    const _spotVolMult =
      pe?.lastSpotVol1h != null &&
      pe?.spotVolAvg1h != null &&
      pe.spotVolAvg1h > 0
        ? pe.lastSpotVol1h / pe.spotVolAvg1h
        : null;
    await dbWriteBestEffort("trackedSignal/exit-metrics", () =>
      db
        .update(trackedSignalsTable)
        .set({
          exitOi30m: pe?.lastOi30m ?? null,
          exitOi1h: pe?.lastOi1h ?? null,
          exitOi4h: pe?.lastOi4h ?? null,
          exitOi24h: pe?.lastOi24h ?? null,
          exitCvd15m: pe?.lastCvd15m ?? null,
          exitCvd30m: pe?.lastCvd30m ?? null,
          exitCvd1h: pe?.lastCvd1h ?? null,
          exitCvd4h: pe?.lastCvd4h ?? null,
          exitWhaleIndex: pe?.lastWhaleIndex ?? null,
          exitSpotTakerNetBuy: pe?.lastSpotTakerNetBuy ?? null,
          // lastNetBuyPct = ±50 CVD-прокси, не futures taker; используем реальный spot taker.
          exitFutTakerNetBuy: pe?.lastSpotTakerNetBuy ?? null,
          exitSpotNetBuy1h:
            pe?.lastSpotNetBuy1h ??
            getSpotNetflowEntry(symbol)?.netPct1h ??
            null,
          exitSpotVol1h: pe?.lastSpotVol1h ?? null,
          exitSpotVolMult: _spotVolMult,
          exitFutVolMult: pe?.lastVolMult ?? null,
          exitFundingRate: _fr,
          exitPrice1h: pe?.lastPrice1h ?? null,
          exitPrice24h: pe?.lastPrice24h ?? null,
          exitFutSpotRatio: pe?.futSpotRatio ?? null,
        })
        .where(
          and(
            eq(trackedSignalsTable.id, id),
            // Защита от гонки: пишем только если строка всё ещё в финальном
            // статусе (не переоткрыта restore/manual flow между claim и записью).
            inArray(trackedSignalsTable.status, [
              "profit",
              "stop_loss",
              "cancelled",
              "breakeven",
              "bu_stop",
            ]),
          ),
        ),
    );
  } catch (err) {
    logger.warn(
      { err, symbol, id },
      "exit-metrics: write failed (non-critical)",
    );
  }
}

// ── In-memory cooldown для accumulation scouts (сбрасывается при рестарте) ───
// Структура: Map<signalId, { volBuild: timestampMs, oiBuild: timestampMs }>
const accumScoutCooldowns = new Map<
  number,
  { volBuild: number; oiBuild: number }
>();
// hourlyPositionUpdateAt removed — dedup now via lastHourlyAt in DB (atomic across 2 processes)

// ── Main watcher cycle (every 10 min): scouts active signals ──────────────────
// Обрабатывает OI drain, объём и OI-скауты, re-entry check.
// Stop loss / trailing stop / in_run промоут — только FastCycle (каждые 2 мин).
async function runWatcherCycleUnlocked(
  lease: MarketCycleLeaseContext,
): Promise<{
  checked: number;
  updated: number;
}> {
  lease.throwIfLost("watcher start");
  const accumFetch = await dbReadWithRetry("WatcherCycle", () =>
    db
      .select()
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.status, "active")),
  );
  if (!accumFetch.ok) return { checked: 0, updated: 0 };
  const accumSignals = accumFetch.value;

  await reconcileImpulseRunnerCoreCloseDeliveries().catch((err) => {
    logger.warn(
      { err },
      "Impulse runner core-close delivery reconciliation failed",
    );
  });
  await reconcileImpulseRunnerAccountingCorrectionDeliveries().catch((err) => {
    logger.warn(
      { err },
      "Impulse runner accounting correction reconciliation failed",
    );
  });

  if (accumSignals.length === 0) return { checked: 0, updated: 0 };

  logger.info(
    { count: accumSignals.length },
    "Watcher: checking active signals",
  );

  let tickers: { symbol: string; lastPrice: string }[] = [];
  try {
    tickers = (await getFutureTickers()) as any[];
  } catch (err) {
    logger.error({ err }, "Watcher: failed to fetch tickers");
    return { checked: 0, updated: 0 };
  }

  const priceMap = new Map<string, number>();
  for (const t of tickers) priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);

  const updated = 0;

  for (const tracked of accumSignals) {
    lease.throwIfLost("watcher signal processing");
    try {
      const currentPrice = priceMap.get(tracked.symbol);
      if (!currentPrice) continue;

      const pnl = computePnl(tracked, currentPrice);
      const { h: _ageHours } = hoursAndDays(tracked.detectedAt);
      const newPeak = Math.max(currentPrice, tracked.peakPrice ?? currentPrice);
      const peakChanged = newPeak !== tracked.peakPrice;

      // 6h напоминание удалено — сопровождение теперь только по триггеру

      // oi_drop_cvd_confirmed удалён 2026-07-27: бэктест показал 62.5% ошибочных отмен
      // (5 из 8 токенов уходили >10% вверх после отмены). OI 30m временно уходит в -5%
      // при консолидации/ротации — краткосрочный шум не основание для отмены накопления.
      // Accumulation-сигналы живут до normal trade exit или hard timeout (4д).
      const scoutNow = Date.now();
      const cooldowns = accumScoutCooldowns.get(tracked.id) ?? {
        volBuild: 0,
        oiBuild: 0,
      };

      // ── Accumulation scout: pre-fetch klines (используется и здесь, и в re-entry) ──
      let scoutVolMult = 0;
      let scoutSpotVol: number | null = null;
      try {
        const [klines, spotVol] = await Promise.all([
          getKlines(tracked.symbol, "30m", 21),
          getFsVolume(tracked.symbol)
            .then((r) => r.spotVolUsd24h ?? null)
            .catch(() => null),
        ]);
        scoutSpotVol = spotVol;
        if (klines.length >= 5) {
          const current = klines[klines.length - 1];
          const historical = klines.slice(0, -1);
          // Aggregated (CoinGlass) volume only; unavailable data gives 0.
          const _scoutSeries = await getAggregatedFuturesVolumeSeries30m(
            tracked.symbol,
          ).catch(() => null);
          const _scoutVols = historical.map(
            (k) => _scoutSeries?.get(k.time) ?? null,
          );
          const currentVol = _scoutSeries?.get(current.time) ?? 0;
          const avgVol = _scoutVols.every((v): v is number => v !== null)
            ? _scoutVols.reduce((s, v) => s + v, 0) / _scoutVols.length
            : 0;
          scoutVolMult = avgVol > 0 ? currentVol / avgVol : 0;
          // 2.1: спот-объём из prescanTracker (fallback на фьюч если нет данных)
          const _scoutPe = getPrescanEntry(tracked.symbol);
          const scoutSpotVolMult =
            _scoutPe?.spotVolAvg1h && _scoutPe?.lastSpotVol1h
              ? _scoutPe.lastSpotVol1h / _scoutPe.spotVolAvg1h
              : null;
          const effectiveScoutVol = scoutSpotVolMult ?? scoutVolMult;

          // 📡 Объём оживает (2x-3x): ранний сигнал до re-entry порога
          // DB-level guard вместо in-memory: оба процесса разделяют lastVolBuildAt
          // Минимум 1ч с момента входа: иначе elevated vol от самого сигнала
          // триггерит update через 3 минуты после нового сигнала.
          if (
            ACCUM_SCOUT_TELEGRAM_ENABLED &&
            _ageHours >= 1.0 &&
            effectiveScoutVol >= 2.0 &&
            effectiveScoutVol < RE_ENTRY_VOL_MULT
          ) {
            const volBuildThreshold = new Date(
              scoutNow - ACCUM_SCOUT_COOLDOWN_MS,
            );
            const _healthAccumVol = await _fetchSignalHealth(
              tracked.symbol,
              currentPrice,
            ).catch(() => null);
            const volBuildAt = new Date(scoutNow);
            const delivery = await broadcastPhotoAfterClaim(
              POSITION_UPDATE_IMG,
              msgAccumVolumeBuilding(
                tracked,
                currentPrice,
                pnl,
                scoutVolMult,
                scoutSpotVol,
                scoutSpotVolMult,
                _healthAccumVol,
              ),
              `position:${tracked.id}:accum_vol:${volBuildAt.toISOString()}`,
              async (tx) => {
                const claimed = await tx
                  .update(trackedSignalsTable)
                  .set({ lastVolBuildAt: volBuildAt })
                  .where(
                    sql`${trackedSignalsTable.id} = ${tracked.id} AND (${trackedSignalsTable.lastVolBuildAt} IS NULL OR ${trackedSignalsTable.lastVolBuildAt} < ${volBuildThreshold})`,
                  )
                  .returning({ id: trackedSignalsTable.id });
                return claimed.length > 0;
              },
            );
            if (delivery.claimed) {
              accumScoutCooldowns.set(tracked.id, {
                ...(accumScoutCooldowns.get(tracked.id) ?? cooldowns),
                volBuild: scoutNow,
              });
              logger.info(
                {
                  symbol: tracked.symbol,
                  futVolMult: scoutVolMult.toFixed(2),
                  spotVolMult: scoutSpotVolMult?.toFixed(2) ?? "n/a",
                  effectiveVol: effectiveScoutVol.toFixed(2),
                },
                "Watcher: ACCUM VOL BUILDING 📡",
              );
            }
          }
        }
      } catch {
        /* non-critical */
      }

      // 👀 OI растёт при боковике: CoinGlass check с 2ч кулдауном
      // DB-level guard вместо in-memory: оба процесса разделяют lastOiBuildAt
      // Тот же минимальный возраст 1ч — OI elevated сразу после сигнала = шум.
      if (
        ACCUM_SCOUT_TELEGRAM_ENABLED &&
        _ageHours >= 1.0 &&
        Math.abs(pnl) <= 6
      ) {
        try {
          const oiBuildThreshold = new Date(scoutNow - ACCUM_OI_COOLDOWN_MS);
          const cgOI = await getCoinglassOI(tracked.symbol, currentPrice);
          const oiChange = cgOI.oiChange30m ?? null;
          if (cgOI.available && oiChange !== null && oiChange >= 5) {
            const _healthAccumOi = await _fetchSignalHealth(
              tracked.symbol,
              currentPrice,
            ).catch(() => null);
            const oiBuildAt = new Date(scoutNow);
            const delivery = await broadcastPhotoAfterClaim(
              POSITION_UPDATE_IMG,
              msgAccumOiBuilding(
                tracked,
                currentPrice,
                pnl,
                oiChange,
                _healthAccumOi,
              ),
              `position:${tracked.id}:accum_oi:${oiBuildAt.toISOString()}`,
              async (tx) => {
                const claimed = await tx
                  .update(trackedSignalsTable)
                  .set({ lastOiBuildAt: oiBuildAt })
                  .where(
                    sql`${trackedSignalsTable.id} = ${tracked.id} AND (${trackedSignalsTable.lastOiBuildAt} IS NULL OR ${trackedSignalsTable.lastOiBuildAt} < ${oiBuildThreshold})`,
                  )
                  .returning({ id: trackedSignalsTable.id });
                return claimed.length > 0;
              },
            );
            if (delivery.claimed) {
              accumScoutCooldowns.set(tracked.id, {
                ...(accumScoutCooldowns.get(tracked.id) ?? cooldowns),
                oiBuild: scoutNow,
              });
              logger.info(
                { symbol: tracked.symbol, oiChange },
                "Watcher: ACCUM OI BUILDING 👀",
              );
            }
          }
        } catch {
          /* non-critical */
        }
      }

      // ── Re-entry candidate (shadow-only; never a lifecycle transition) ───────
      const hoursInAccumulation =
        (Date.now() - tracked.updatedAt.getTime()) / 3_600_000;
      let reentryCandidateRecorded = false;
      if (
        REENTRY_SHADOW_ONLY &&
        hoursInAccumulation >= ACCUMULATION_REENTRY_H &&
        scoutVolMult >= RE_ENTRY_VOL_MULT
      ) {
        // Bucket the decision to the qualifying candle/hour.  This is both
        // immutable event identity and a DB-level race-safe dedup key.
        const candidateAt = new Date();
        const boundaryAt = new Date(
          Math.floor(candidateAt.getTime() / 3_600_000) * 3_600_000,
        );
        const eventKey = `watcher:v1:${tracked.id}:${boundaryAt.toISOString()}`;
        await dbWriteStrict("reentry-shadow-candidate", () =>
          db.transaction(async (tx) => {
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext(${`reentry:${tracked.id}:watcher:v1`}))`,
            );
            const recent = await tx.execute(sql`
              SELECT 1 FROM reentry_shadow_events
              WHERE tracked_signal_id = ${tracked.id}
                AND source = 'watcher'
                AND candidate_at > ${new Date(Date.now() - 12 * 3_600_000)}
              LIMIT 1
            `);
            if (recent.rows.length) return;
            await tx
              .insert(reentryShadowEventsTable)
              .values({
                eventKey,
                source: "watcher",
                detectorVersion: "reentry_shadow_v1",
                trackedSignalId: tracked.id,
                symbol: tracked.symbol,
                pattern: tracked.sentimentKey ?? tracked.signalType,
                candidateAt,
                proposedReentryPrice: currentPrice,
                originalEntryPrice:
                  tracked.originalEntryPrice ?? tracked.entryPrice,
                currentPnlPct: pnl,
                volumeMultiplier: scoutVolMult,
                spotVolumeMultiplier: scoutSpotVol,
                oiEvidence: tracked.entryOi,
                cvdEvidence: JSON.stringify({
                  entryCvd15m: tracked.entryCvd15m ?? null,
                  entryCvd30m: tracked.entryCvd30m ?? null,
                  entryCvd1h: tracked.entryCvd1h ?? null,
                  entryCvd4h: tracked.entryCvd4h ?? null,
                }),
                context: JSON.stringify({
                  status: tracked.status,
                  hoursInAccumulation,
                  isShort: tracked.isShort,
                  entryDecisionMetrics: tracked.decisionMetrics ?? null,
                }),
              })
              .onConflictDoNothing();
          }),
        );
        reentryCandidateRecorded = true;
        logger.info(
          { symbol: tracked.symbol, volMult: scoutVolMult },
          "Watcher: re-entry candidate recorded (shadow-only)",
        );
      }

      // Update peak silently — GREATEST защищает от гонки двух воркер-процессов:
      // оба могут прочитать старое значение одновременно, но SQL max гарантирует
      // что в БД останется наибольший пик.
      if (peakChanged && !reentryCandidateRecorded) {
        await dbWriteStrict("trackedSignal/accum-peak-update", () =>
          db
            .update(trackedSignalsTable)
            .set({
              peakPrice: sql`GREATEST(COALESCE(${trackedSignalsTable.peakPrice}, ${newPeak}), ${newPeak})`,
              updatedAt: new Date(),
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id}
                AND ${trackedSignalsTable.status} IN ('active','in_run')`,
            ),
        );
      }
    } catch (err) {
      logger.error(
        { err, symbol: tracked.symbol },
        "WatcherCycle: ошибка обработки сигнала (пропускаем)",
      );
    }
  }

  return { checked: accumSignals.length, updated };
}

// ── Daily report (22:00 Самара = 18:00 UTC) ───────────────────────────────────
export async function sendDailyReport(
  targetChatId?: number | string,
  bypassDedupe = false,
): Promise<void> {
  // Атомарный guard: только один из 2 воркер-процессов отправляет плановый отчёт.
  // bypassDedupe=true используется при ручном вызове через дашборд (кнопка "Daily Report").
  if (!targetChatId && !bypassDedupe) {
    const claimed = await claimSettingsBroadcast({
      column: "lastDailyReportAt",
      windowMs: 10 * 60_000,
      label: "Daily report",
    });
    if (!claimed) return;
  }

  // Граница — полночь самарского времени (UTC+4).
  // Было: Date.now() - 24h (скользящее окно) → одни и те же сигналы попадали в 2 отчёта подряд
  // если оба отчёта запустились с интервалом <24h (перезапуск, ручной вызов, дрейф расписания).
  // Теперь: строгая граница по календарному дню Самары — дубликаты исключены.
  const samaraMidnightMs =
    Math.floor((Date.now() + 4 * 3_600_000) / 86_400_000) * 86_400_000 -
    4 * 3_600_000;
  const since = new Date(samaraMidnightMs);

  const allOpen = await db
    .select()
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));

  const closedToday = await db
    .select()
    .from(trackedSignalsTable)
    .where(sql`${trackedSignalsTable.closedAt} >= ${since}`);

  const profitsToday = closedToday.filter((s) => s.status === "profit");
  const buStopsToday = closedToday.filter((s) =>
    ["bu_stop", "breakeven"].includes(s.status),
  );
  const stopsToday = closedToday.filter((s) => s.status === "stop_loss");
  const cancelledToday = closedToday.filter((s) => s.status === "cancelled");
  // Fetch live prices for open positions
  const priceMap = new Map<string, number>();
  if (allOpen.length > 0) {
    try {
      const tickers = (await getFutureTickers()) as any[];
      for (const t of tickers)
        priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);
    } catch {
      /* non-critical — show without live price */
    }
  }

  const lines: string[] = [
    `📊 <b>DAILY REPORT — AltBullet Watcher</b>`,
    `<i>${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "long", year: "numeric" })}</i>`,
    ``,
  ];

  const symBase = (symbol: string) => symbol.replace("-USDT", "");
  const _priceRow = (s: TrackedSignal, curPrice: number | undefined) => {
    if (!s.entryPrice) return "";
    if (!curPrice) return ` | Вход: ${fmtP(s.entryPrice)}`;
    const pnl = ((curPrice - s.entryPrice) / s.entryPrice) * 100;
    const sign = pnl >= 0 ? "+" : "";
    return ` | ${fmtP(s.entryPrice)} → ${fmtP(curPrice)} (${sign}${pnl.toFixed(1)}%)`;
  };
  const priceRowClosed = (s: TrackedSignal) => {
    if (!s.entryPrice) return "";
    const exit = s.exitPrice ?? s.peakPrice;
    if (!exit) return ` | Вход: ${fmtP(s.entryPrice)}`;
    const peak = computePeakPnl(s);
    const peakStr = peak > 0 ? ` | Пик: +${peak.toFixed(1)}%` : "";
    const pnl =
      normalizeClosedPnlPercent(s.status, s.pnlPercent, s.sentimentKey) ?? 0;
    return ` | ${fmtP(s.entryPrice)} → ${fmtP(exit)} (${fmtPct(pnl)})${peakStr}`;
  };

  const patTag = (s: TrackedSignal) =>
    s.sentimentKey ? ` [${getPatternTgLabel(s.sentimentKey)}]` : "";

  // Единый форматтер — тот же что в рестарт-уведомлении, /status кнопке и 4ч апдейте
  lines.push(...formatOpenPositionLines(allOpen, priceMap, false));

  if (profitsToday.length > 0) {
    lines.push(`✅ <b>Закрыто в профит (${profitsToday.length}):</b>`);
    for (const s of profitsToday) {
      lines.push(`  • ${symBase(s.symbol)}${patTag(s)}${priceRowClosed(s)}`);
    }
    lines.push(``);
  }

  if (buStopsToday.length > 0) {
    const bePnl = summarizeRawPnlPercent(buStopsToday).netPercent;
    lines.push(`🛡 BE: ${buStopsToday.length} | PnL: ${fmtPct(bePnl)}`);
    for (const milestone of [5, 8, 10]) {
      const count = buStopsToday.filter((s) => {
        const take = getBuStopTakePct(s.status, s.lastMilestone);
        return milestone === 10
          ? take != null && take >= 10
          : take === milestone;
      }).length;
      lines.push(`  • после +${milestone}%: ${count}`);
    }
    lines.push(``);
  }

  if (stopsToday.length > 0) {
    lines.push(
      `❌ Стоп-лосс: ${stopsToday.length} | PnL: ${fmtPct(summarizeRawPnlPercent(stopsToday).netPercent)}`,
      ``,
    );
  }

  if (cancelledToday.length > 0) {
    lines.push(
      `🚫 Отменено: ${cancelledToday.length} | PnL: ${fmtPct(summarizeRawPnlPercent(cancelledToday).netPercent)}`,
      ``,
    );
  }

  if (allOpen.length === 0 && closedToday.length === 0) {
    lines.push(`Сегодня активных сигналов нет.`);
  }

  const dailyEstimate = summarizePnlWithEstimatedBuStop(closedToday);
  lines.push(``, formatDailyPnlLine(closedToday));
  lines.push(
    `🧮 <b>Отдельная оценка partial + BE (не входит в факт): ${fmtPct(dailyEstimate.pnlWithEstimatedBuStopPercent)}</b>` +
      (dailyEstimate.unavailableBuStopEstimateTrades > 0
        ? ` (${dailyEstimate.unavailableBuStopEstimateTrades} BE без milestone)`
        : ""),
  );
  lines.push(``, `#ежедневный_отчет #daily_report`);

  const fullText = telegramReportPlainText(lines.join("\n"));
  await sendPhotoTo(DAILY_REPORT_IMG, fullText, targetChatId);
  logger.info("Daily report sent");
}

// ── Weekly digest (10:00 Самара = 06:00 UTC, воскресенье) ────────────────────
export async function sendWeeklyDigest(
  targetChatId?: number | string,
  bypassDedupe = false,
): Promise<void> {
  if (!targetChatId && !bypassDedupe) {
    const claimed = await claimSettingsBroadcast({
      column: "lastWeeklyDigestAt",
      windowMs: 10 * 60_000,
      label: "Weekly digest",
    });
    if (!claimed) return;
  }

  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const closed = await loadClosedInPeriod(oneWeekAgo, now);
  await sendPhotoTo(
    WEEKLY_REPORT_IMG,
    formatWeeklyDigest(closed, oneWeekAgo, now),
    targetChatId,
  );
  logger.info({ total: closed.length }, "Weekly digest sent");
}

// ── Monthly digest (30 days stats) ───────────────────────────────────────────
export async function sendMonthlyDigest(
  targetChatId?: number | string,
  bypassDedupe = false,
): Promise<void> {
  if (!targetChatId && !bypassDedupe) {
    const claimed = await claimSettingsBroadcast({
      column: "lastMonthlyDigestAt",
      windowMs: 10 * 60_000,
      label: "Monthly digest",
    });
    if (!claimed) return;
  }

  // Always the previous full calendar month (Asia/Dubai), never the month
  // that just started.
  const { start, end } = getPreviousDubaiMonthRange();
  const closed = await loadClosedInPeriod(start, end);
  await sendPhotoTo(
    MONTHLY_REPORT_IMG,
    formatMonthlyDigest(closed, start),
    targetChatId,
  );
  logger.info({ total: closed.length }, "Monthly digest sent");
}

// ── Market Health: OI + Volume snapshot для апдейтов ─────────────────────────
async function fetchMarketHealth(
  symbol: string,
  priceUsd?: number | null,
): Promise<{
  oiPct: number | null;
  cgTurnover: number | null;
  fundingRate: number | null;
  spotVol24h: number | null;
  futVol24h: number | null;
  futSpotRatio: number | null;
}> {
  let oiPct: number | null = null;
  let cgTurnover: number | null = null;
  let fundingRate: number | null = null;
  let spotVol24h: number | null = null;
  let futVol24h: number | null = null;
  let futSpotRatio: number | null = null;
  try {
    const [cgOI, cgFunding, fsVol] = await Promise.all([
      getCoinglassOI(symbol, priceUsd).catch(() => null),
      getCoinglassCurrentFunding(symbol).catch(() => null),
      getFsVolume(symbol).catch(() => null),
    ]);
    if (cgOI?.available) {
      oiPct = cgOI.oiChange30m ?? null;
      // cgTurnover = futVolUsd24h / oiUsd — доля дневного фьюч-объёма относительно OI.
      // < 0.05 = мёртвый рынок, 0.08–0.15 = норма, >= 0.15 = активно
      if (fsVol?.futVolUsd24h && cgOI.oiUsd && cgOI.oiUsd > 0) {
        cgTurnover = fsVol.futVolUsd24h / cgOI.oiUsd;
      }
    }
    fundingRate = cgFunding;
    spotVol24h = fsVol?.spotVolUsd24h ?? null;
    futVol24h = fsVol?.futVolUsd24h ?? null;
    futSpotRatio = fsVol?.futSpotRatio ?? null;
  } catch {
    /* non-critical */
  }
  return {
    oiPct,
    cgTurnover,
    fundingRate,
    spotVol24h,
    futVol24h,
    futSpotRatio,
  };
}

export async function runWatcherCycle(): Promise<{
  checked: number;
  updated: number;
} | null> {
  const lease = await withMarketCycleLease("watcher", runWatcherCycleUnlocked);
  return lease.acquired ? lease.value : null;
}

// ── Trajectory snapshot writer ────────────────────────────────────────────────
// Вызывается в FastCycle после обновления peak. Не бросает — fail-open.
async function maybeRecordTrajectory(
  tracked: typeof trackedSignalsTable.$inferSelect,
  currentPrice: number,
  pnlPct: number,
  peakPct: number,
): Promise<void> {
  const elapsedMs = Date.now() - tracked.detectedAt.getTime();
  const due = TRAJECTORY_INTERVALS.filter(
    (iv) =>
      elapsedMs >= iv.ms &&
      !_trajectoryRecorded.has(`${tracked.id}:${iv.label}`),
  );
  if (due.length === 0) return;

  const rows = due.map((iv) => ({
    signalId: tracked.id,
    symbol: tracked.symbol,
    sentimentKey: tracked.sentimentKey ?? "unknown",
    intervalLabel: iv.label,
    snapshotAt: new Date(),
    elapsedMs,
    priceAt: currentPrice,
    pctFromEntry: pnlPct,
    peakPct,
    status: tracked.status,
  }));

  try {
    await db
      .insert(signalTrajectoryLogTable)
      .values(rows)
      .onConflictDoNothing();
    for (const iv of due) {
      _trajectoryRecorded.add(`${tracked.id}:${iv.label}`);
    }
    logger.debug(
      { symbol: tracked.symbol, intervals: due.map((iv) => iv.label) },
      "trajectory: snapshot recorded",
    );
  } catch (err) {
    logger.warn(
      { err, symbol: tracked.symbol },
      "trajectory: INSERT failed (non-critical)",
    );
  }
}

// ── Intraday drawdown minimum ───────────────────────────────────────────────────
// FastCycle calls this after computing the current direction-aware PnL and before
// any exit path can continue. Unlike interval snapshots, this summary is
// mutable: only a newly observed lower PnL replaces the stored observation.
// The SQL upsert is atomic across the two production workers.
async function recordDrawdownMinimum(
  tracked: typeof trackedSignalsTable.$inferSelect,
  currentPrice: number,
): Promise<void> {
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isFinite(tracked.entryPrice) ||
    tracked.entryPrice <= 0
  ) {
    return;
  }

  // PnL in the existing exit path is historically long-oriented. Drawdown
  // telemetry must be direction-aware even for a future/rare short signal:
  // an adverse short move is a price rise, while a price fall is profitable.
  const pnlPct =
    ((tracked.isShort
      ? tracked.entryPrice - currentPrice
      : currentPrice - tracked.entryPrice) /
      tracked.entryPrice) *
    100;

  const previousLocalMinimum = _drawdownMinimums.get(tracked.id);
  if (previousLocalMinimum != null && pnlPct >= previousLocalMinimum) {
    return;
  }

  const observedAt = new Date();
  const minElapsedMs = Math.max(
    0,
    observedAt.getTime() - tracked.detectedAt.getTime(),
  );
  _drawdownMinimums.set(tracked.id, pnlPct);

  const written = await dbWriteBestEffort("signal-drawdown/minimum", () =>
    db
      .insert(signalDrawdownExtremaTable)
      .values({
        signalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        minPctFromEntry: pnlPct,
        priceAtMin: currentPrice,
        minObservedAt: observedAt,
        minElapsedMs,
        source: "fast_cycle",
        statusAtMin: tracked.status,
        updatedAt: observedAt,
      })
      .onConflictDoUpdate({
        target: signalDrawdownExtremaTable.signalId,
        set: {
          minPctFromEntry: sql`LEAST(${signalDrawdownExtremaTable.minPctFromEntry}, EXCLUDED.min_pct_from_entry)`,
          priceAtMin: sql`CASE WHEN EXCLUDED.min_pct_from_entry < ${signalDrawdownExtremaTable.minPctFromEntry} THEN EXCLUDED.price_at_min ELSE ${signalDrawdownExtremaTable.priceAtMin} END`,
          minObservedAt: sql`CASE WHEN EXCLUDED.min_pct_from_entry < ${signalDrawdownExtremaTable.minPctFromEntry} THEN EXCLUDED.min_observed_at ELSE ${signalDrawdownExtremaTable.minObservedAt} END`,
          minElapsedMs: sql`CASE WHEN EXCLUDED.min_pct_from_entry < ${signalDrawdownExtremaTable.minPctFromEntry} THEN EXCLUDED.min_elapsed_ms ELSE ${signalDrawdownExtremaTable.minElapsedMs} END`,
          source: sql`CASE WHEN EXCLUDED.min_pct_from_entry < ${signalDrawdownExtremaTable.minPctFromEntry} THEN EXCLUDED.source ELSE ${signalDrawdownExtremaTable.source} END`,
          statusAtMin: sql`CASE WHEN EXCLUDED.min_pct_from_entry < ${signalDrawdownExtremaTable.minPctFromEntry} THEN EXCLUDED.status_at_min ELSE ${signalDrawdownExtremaTable.statusAtMin} END`,
          updatedAt: observedAt,
        },
      }),
  );

  if (written === null) {
    // Retry this observation on the next cycle if the best-effort write hit a
    // transient pool/database failure.
    _drawdownMinimums.delete(tracked.id);
    return;
  }

  logger.debug(
    {
      signalId: tracked.id,
      symbol: tracked.symbol,
      pnlPct,
      source: "fast_cycle",
    },
    "drawdown: new observed minimum recorded",
  );
}

// ── Trailing audit + shadow telemetry ──────────────────────────────────────────
// Both writers below are intentionally separate from the live trailing exit
// branch. Database failures only lose an observation; they never change a trade.
async function recordActualTrailingEvent(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  eventType: "activated" | "hit";
  priceSource?: "fast_cycle" | "bingx_ws_last_price" | "startup_reset";
  observedAt: Date;
  peakPrice: number;
  peakPnlPct: number;
  currentPrice: number;
  trailingStopPrice: number;
  activationPct: number;
  trailingGapPct: number;
  actualStatus?: string;
  actualExitPrice?: number;
  actualPnlPct?: number;
  closedAt?: Date;
}): Promise<void> {
  const { tracked } = input;
  if (!Number.isFinite(tracked.entryPrice) || tracked.entryPrice <= 0) return;
  const isShort = tracked.isShort === true;
  const currentPnlPct = directionAwarePnl(
    tracked.entryPrice,
    input.currentPrice,
    isShort,
  );
  const theoreticalExitPnlPct = directionAwarePnl(
    tracked.entryPrice,
    input.trailingStopPrice,
    isShort,
  );
  const latencyMs =
    input.closedAt == null
      ? null
      : Math.max(0, input.closedAt.getTime() - input.observedAt.getTime());

  await dbWriteBestEffort(`trailing-event/${input.eventType}`, () =>
    db
      .insert(signalTrailingEventsTable)
      .values({
        signalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        eventType: input.eventType,
        isShort,
        activationPct: input.activationPct,
        trailingGapPct: input.trailingGapPct,
        observedAt: input.observedAt,
        peakPrice: input.peakPrice,
        peakPnlPct: input.peakPnlPct,
        currentPrice: input.currentPrice,
        currentPnlPct,
        trailingStopPrice: input.trailingStopPrice,
        theoreticalExitPnlPct,
        actualStatus: input.actualStatus ?? null,
        actualExitPrice: input.actualExitPrice ?? null,
        actualPnlPct: input.actualPnlPct ?? null,
        closedAt: input.closedAt ?? null,
        latencyMs,
        priceSource: input.priceSource ?? "fast_cycle",
      })
      .onConflictDoNothing(),
  );
}

async function closeImpulseRunnerCorePosition(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  currentPrice: number;
  peakPrice: number;
  trailingStop: number;
  exitProfile: ReturnType<typeof getExitProfile>;
  observedAt: Date;
  priceSource: "fast_cycle" | "bingx_ws_last_price" | "startup_reset";
  realtimeMonitorGeneration?: number;
}): Promise<boolean> {
  const { tracked } = input;
  if (!isImpulseRunnerPolicy(tracked.policyVersion)) return false;
  // A milestone claim owns the next user-visible event. Let its durable queue
  // complete before the core-close event so a lower target can never arrive
  // hours after a more advanced close. The SQL guard below closes the race
  // where another worker claims a milestone after this in-memory read.
  if (tracked.pendingMilestone != null) return false;
  const corePrice = Math.max(
    input.trailingStop,
    tracked.trailingStopLevel ?? input.trailingStop,
  );
  const corePnl = computePnl(tracked, corePrice);
  const runnerEntryPrice = tracked.originalEntryPrice ?? tracked.entryPrice;
  const peakPnl = computePeakPnl({ ...tracked, peakPrice: input.peakPrice });
  const runnerPeakPrice = Math.max(
    runnerEntryPrice,
    input.peakPrice,
    tracked.runnerPeakPrice ?? runnerEntryPrice,
  );
  const runnerTrailingStop = resolveImpulseRunnerTrailingStopPrice({
    entryPrice: runnerEntryPrice,
    peakPrice: runnerPeakPrice,
    persistedTrailingStopLevel: tracked.runnerTrailingStopLevel,
  });
  const closedAt = new Date();
  const eventKey = `position:${tracked.id}:${IMPULSE_RUNNER_POLICY_VERSION}:core_close`;
  let persistedCorePrice = corePrice;
  let persistedCorePnl = corePnl;
  let persistedPeakPnl = peakPnl;
  const health = await _fetchSignalHealth(
    tracked.symbol,
    input.currentPrice,
  ).catch(() => null);
  if (
    input.realtimeMonitorGeneration != null &&
    !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
  ) {
    return false;
  }
  const delivery = await broadcastPhotoAfterClaim(
    TRAILING_STOP_IMG,
    () =>
      msgImpulseRunnerCoreClose(
        tracked,
        persistedCorePrice,
        persistedCorePnl,
        persistedPeakPnl,
        health,
      ),
    eventKey,
    async (tx) => {
      if (
        input.realtimeMonitorGeneration != null &&
        !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
      ) {
        return false;
      }
      const claimed = await claimImpulseRunnerCoreClose(tx, {
        trackedSignalId: tracked.id,
        policyVersion: IMPULSE_RUNNER_POLICY_VERSION,
        eventKey,
        trailingStop: input.trailingStop,
        peakPrice: input.peakPrice,
        runnerPeakPrice,
        runnerTrailingStop,
        observedAt: input.observedAt,
        closedAt,
      });
      if (claimed) {
        persistedCorePrice = claimed.coreExitPrice ?? corePrice;
        persistedCorePnl = claimed.corePnlPercent ?? corePnl;
        persistedPeakPnl =
          claimed.entryPrice > 0 && claimed.peakPrice != null
            ? ((claimed.peakPrice - claimed.entryPrice) / claimed.entryPrice) *
              100
            : peakPnl;
      }
      return claimed != null;
    },
  );
  if (!delivery.claimed) return false;
  void recordActualTrailingEvent({
    tracked,
    eventType: "hit",
    priceSource: input.priceSource,
    observedAt: input.observedAt,
    peakPrice: input.peakPrice,
    peakPnlPct: persistedPeakPnl,
    currentPrice: persistedCorePrice,
    trailingStopPrice: persistedCorePrice,
    activationPct: input.exitProfile.trailingActivation,
    trailingGapPct: input.exitProfile.trailingGap,
    actualStatus: "core_closed",
    actualExitPrice: persistedCorePrice,
    actualPnlPct: persistedCorePnl,
    closedAt,
  }).catch(() => null);
  await recordCoreSplitSnapshot(
    tracked,
    persistedCorePrice,
    persistedCorePnl,
    persistedPeakPnl,
  );
  return true;
}

async function reconcileImpulseRunnerCoreCloseDeliveries(): Promise<void> {
  const missing = await db
    .select()
    .from(trackedSignalsTable)
    .where(
      sql`${trackedSignalsTable.policyVersion} = ${IMPULSE_RUNNER_POLICY_VERSION}
        AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
        AND ${trackedSignalsTable.coreExitPrice} IS NOT NULL
        AND ${trackedSignalsTable.corePnlPercent} IS NOT NULL
        AND ${trackedSignalsTable.coreCloseEventKey} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM telegram_delivery_events tde
          WHERE tde.event_key = ${trackedSignalsTable.coreCloseEventKey}
        )`,
    )
    .orderBy(trackedSignalsTable.coreClosedAt)
    .limit(20);

  for (const tracked of missing) {
    const eventKey = tracked.coreCloseEventKey;
    const coreExitPrice = tracked.coreExitPrice;
    const corePnlPercent = tracked.corePnlPercent;
    if (eventKey == null || coreExitPrice == null || corePnlPercent == null) {
      continue;
    }
    const peakPnlPercent = computePeakPnl(tracked);
    const queued = await broadcastPhoto(
      TRAILING_STOP_IMG,
      msgImpulseRunnerCoreClose(
        tracked,
        coreExitPrice,
        corePnlPercent,
        peakPnlPercent,
        null,
      ),
      eventKey,
    );
    if (queued > 0) {
      logger.warn(
        {
          trackedSignalId: tracked.id,
          symbol: tracked.symbol,
          eventKey,
          queued,
        },
        "Recovered missing impulse runner core-close delivery",
      );
    }
  }
}

export async function reconcileImpulseRunnerAccountingCorrectionDeliveries(): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT a.tracked_signal_id, a.prior_pnl_percent
      FROM impulse_runner_accounting_repair_audit a
      JOIN tracked_signals t ON t.id = a.tracked_signal_id
     WHERE t.policy_version = 'impulse_runner_v1'
       AND t.runner_state = 'closed'
       AND a.correction_required = true
       AND t.runner_exit_price > 0
       AND t.runner_pnl_percent IS NOT NULL
       AND t.core_exit_price > 0
       AND t.core_pnl_percent IS NOT NULL
       AND (
         a.prior_pnl_percent IS NULL
         OR ABS(a.prior_pnl_percent - a.corrected_pnl_percent) > 0.0001
       )
       AND NOT EXISTS (
         SELECT 1
           FROM telegram_delivery_events e
          WHERE e.event_key = concat(
            'position:',
            a.tracked_signal_id,
            ':impulse_runner_v1:runner_close_correction:canonical_accounting_v1'
          )
       )
     ORDER BY a.repaired_at, a.tracked_signal_id
     LIMIT 20
  `);

  let reconciled = 0;
  for (const row of candidates.rows as Array<{
    tracked_signal_id: number;
    prior_pnl_percent: number | null;
  }>) {
    const [tracked] = await db
      .select()
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.id, row.tracked_signal_id))
      .limit(1);
    if (
      !tracked ||
      tracked.runnerExitPrice == null ||
      tracked.runnerPnlPercent == null ||
      tracked.coreExitPrice == null ||
      tracked.corePnlPercent == null
    ) {
      continue;
    }

    const eventKey = impulseRunnerAccountingCorrectionEventKey(tracked.id);
    const queued = await broadcastPhoto(
      tracked.runnerPnlPercent >= 0 ? POSITION_EXIT_IMG : POSITION_UPDATE_IMG,
      msgImpulseRunnerAccountingCorrection(
        tracked,
        tracked.runnerExitPrice,
        tracked.coreExitPrice,
        tracked.corePnlPercent,
        tracked.runnerPnlPercent,
        row.prior_pnl_percent,
        tracked.status === "expired"
          ? "expired"
          : tracked.status === "profit"
            ? "profit"
            : "stop_loss",
      ),
      eventKey,
    );
    if (queued > 0) {
      reconciled += 1;
      logger.warn(
        {
          trackedSignalId: tracked.id,
          symbol: tracked.symbol,
          eventKey,
          priorPnlPercent: row.prior_pnl_percent,
          correctedPnlPercent: tracked.runnerPnlPercent,
          queued,
        },
        "Queued impulse runner accounting correction delivery",
      );
    }
  }
  return reconciled;
}

async function closeImpulseRunnerFinalPosition(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  exitPrice: number;
  peakPrice: number;
  priceSource: "fast_cycle" | "bingx_ws_last_price" | "startup_reset";
  exitReason:
    | "emergency_stop"
    | "trailing_stop"
    | "age_expired"
    | "operator_take_profit";
  realtimeMonitorGeneration?: number;
}): Promise<boolean> {
  const { tracked } = input;
  if (
    !isImpulseRunnerPolicy(tracked.policyVersion) ||
    !isImpulseRunnerCoreClosed(tracked) ||
    !Number.isFinite(input.exitPrice) ||
    input.exitPrice <= 0
  ) {
    return false;
  }
  const corePrice = tracked.coreExitPrice ?? tracked.entryPrice;
  const corePnl = tracked.corePnlPercent ?? computePnl(tracked, corePrice);
  const runnerEntryPrice = tracked.originalEntryPrice ?? tracked.entryPrice;
  const runnerPeakPrice = Math.max(
    runnerEntryPrice,
    tracked.runnerPeakPrice ?? runnerEntryPrice,
    input.peakPrice,
  );
  const closedAt = new Date();
  const eventKey =
    `position:${tracked.id}:${IMPULSE_RUNNER_POLICY_VERSION}:runner_close` +
    (input.exitReason === "age_expired" ? ":age_expired" : "");
  const health = await _fetchSignalHealth(
    tracked.symbol,
    input.exitPrice,
  ).catch(() => null);
  if (
    input.realtimeMonitorGeneration != null &&
    !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
  ) {
    return false;
  }
  let persistedExitPrice = input.exitPrice;
  let persistedCorePrice = corePrice;
  let persistedCorePnl = corePnl;
  let persistedRunnerPnl = 0;
  let persistedWeightedPnl = 0;
  let persistedFinalStatus: "profit" | "stop_loss" | "expired" | "bu_stop" =
    "stop_loss";
  let persistedPeakPnl = computePeakPnl({
    ...tracked,
    peakPrice: runnerPeakPrice,
  });
  const delivery = await broadcastPhotoAfterClaim(
    () => IMPULSE_RUNNER_CLOSED_IMG,
    () =>
      msgImpulseRunnerFinalClose(
        tracked,
        persistedExitPrice,
        persistedCorePrice,
        persistedCorePnl,
        persistedRunnerPnl,
        persistedFinalStatus,
        health,
        input.exitReason === "age_expired" ||
          input.exitReason === "operator_take_profit"
          ? input.exitReason
          : undefined,
      ),
    eventKey,
    async (tx) => {
      if (
        input.realtimeMonitorGeneration != null &&
        !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
      ) {
        return false;
      }
      const persisted = await claimImpulseRunnerFinalClose(tx, {
        trackedSignalId: tracked.id,
        policyVersion: IMPULSE_RUNNER_POLICY_VERSION,
        exitPrice: input.exitPrice,
        runnerPeakPrice,
        eventKey,
        closedAt,
        lifetimeClose: input.exitReason === "age_expired",
      });
      if (persisted) {
        persistedExitPrice = persisted.runnerExitPrice ?? input.exitPrice;
        persistedCorePrice = persisted.coreExitPrice ?? corePrice;
        persistedCorePnl = persisted.corePnlPercent ?? corePnl;
        persistedRunnerPnl = persisted.runnerPnlPercent ?? 0;
        persistedWeightedPnl = persisted.pnlPercent ?? 0;
        persistedFinalStatus =
          persisted.status === "expired"
            ? "expired"
            : persisted.status === "bu_stop"
              ? "bu_stop"
              : persisted.status === "profit"
                ? "profit"
                : "stop_loss";
        persistedPeakPnl =
          persisted.originalEntryPrice != null &&
          persisted.originalEntryPrice > 0 &&
          persisted.peakPrice != null
            ? ((persisted.peakPrice - persisted.originalEntryPrice) /
                persisted.originalEntryPrice) *
              100
            : persistedPeakPnl;
      }
      return persisted != null;
    },
  );
  if (!delivery.claimed) return false;
  await recordCloseSnapshot(
    tracked,
    persistedExitPrice,
    persistedWeightedPnl,
    persistedPeakPnl,
    persistedFinalStatus,
  );
  void _writeExitMetrics(tracked.id, tracked.symbol);
  return true;
}

// These two runner positions were already more than five days old when the
// operator requested the new policy. Settle their actual remaining runner at
// a confirmed profitable price BEFORE the new age-expiration policy can run.
const OVERDUE_RUNNER_TAKE_PROFIT_IDS = [1705, 1720];

export async function closeOverdueImpulseRunnersBeforeScanner(): Promise<void> {
  const open = await db
    .select()
    .from(trackedSignalsTable)
    .where(
      and(
        inArray(trackedSignalsTable.id, OVERDUE_RUNNER_TAKE_PROFIT_IDS),
        eq(trackedSignalsTable.status, "in_run"),
        eq(trackedSignalsTable.runnerState, "open"),
        eq(trackedSignalsTable.policyVersion, IMPULSE_RUNNER_POLICY_VERSION),
      ),
    );
  if (open.length === 0) return;
  const tickers = await getFutureTickers();
  if (tickers.length < 100) {
    throw new Error("Overdue runner TP: incomplete BingX ticker list");
  }
  const prices = new Map(
    tickers.map((ticker) => [ticker.symbol, Number(ticker.lastPrice)]),
  );
  for (const tracked of open) {
    const originalEntry = tracked.originalEntryPrice;
    if (
      tracked.coreClosedAt == null ||
      tracked.corePnlPercent == null ||
      originalEntry == null ||
      originalEntry <= 0
    ) {
      throw new Error(
        `Overdue runner TP: incomplete durable state for ${tracked.id}`,
      );
    }
    let price = prices.get(tracked.symbol);
    if (price == null || !Number.isFinite(price) || price <= 0) {
      price = Number((await getFutureTicker(tracked.symbol))?.lastPrice);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `Overdue runner TP: missing current quote for ${tracked.symbol}`,
      );
    }
    const protectedFloor = tracked.runnerTrailingStopLevel ?? originalEntry;
    const exitPrice = Math.max(price, protectedFloor);
    if (exitPrice <= originalEntry) {
      throw new Error(
        `Overdue runner TP: no verified profitable exit for ${tracked.symbol}`,
      );
    }
    const closed = await closeImpulseRunnerFinalPosition({
      tracked,
      exitPrice,
      peakPrice: Math.max(
        tracked.peakPrice ?? originalEntry,
        tracked.runnerPeakPrice ?? originalEntry,
        price,
      ),
      priceSource: "startup_reset",
      exitReason: "operator_take_profit",
    });
    logger.warn(
      {
        id: tracked.id,
        symbol: tracked.symbol,
        quote: price,
        exitPrice,
        closed,
      },
      "Operator-requested overdue Impulse Buy runner take profit",
    );
  }
}

const HISTORICAL_RUNNER_RECONCILIATION_LOOKBACK_MS = 48 * 60 * 60_000;

async function reconcileHistoricalRunnerTrailingStop(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  durablePeak: number;
  durableStop: number | null;
  observedAt: Date;
}): Promise<boolean> {
  const { tracked, durablePeak, durableStop, observedAt } = input;
  if (!isImpulseRunnerCoreClosed(tracked) || tracked.coreClosedAt == null) {
    return false;
  }
  const runnerEntryPrice = tracked.originalEntryPrice ?? tracked.entryPrice;
  const emergencyStop = resolveImpulseRunnerEmergencyStopPrice(
    runnerEntryPrice,
    tracked.stopLossPct,
    tracked.entryPolicyVersion,
  );
  const earliestArmedAt =
    tracked.runnerTrailingStopArmedAt != null
      ? new Date(
          Math.min(
            tracked.coreClosedAt.getTime(),
            tracked.runnerTrailingStopArmedAt.getTime(),
          ),
        )
      : tracked.coreClosedAt;
  const startTime = Math.max(
    earliestArmedAt.getTime(),
    observedAt.getTime() - HISTORICAL_RUNNER_RECONCILIATION_LOOKBACK_MS,
  );
  // A stop found only after the five-day expiration cannot override the
  // observed-price expiry. Keep complete candles strictly before that boundary.
  const historicalUntil = Math.min(
    observedAt.getTime(),
    tracked.detectedAt.getTime() + IMPULSE_RUNNER_MAX_AGE_MS,
  );
  if (startTime >= historicalUntil - 60_000) return false;
  try {
    const candles = await getKlinesRange(
      tracked.symbol,
      "1m",
      startTime,
      historicalUntil - 60_000,
    );
    const historicalCandles = candles.map((candle) => ({
      time: candle.time,
      low: Number(candle.low),
    }));
    const emergencyHit = findHistoricalRunnerTrailingStopHit(
      historicalCandles,
      tracked.coreClosedAt,
      historicalUntil,
      emergencyStop,
    );
    const trailingHit =
      durableStop != null && tracked.runnerTrailingStopArmedAt != null
        ? findHistoricalRunnerTrailingStopHit(
            historicalCandles,
            tracked.runnerTrailingStopArmedAt,
            historicalUntil,
            durableStop,
          )
        : null;
    const useTrailing =
      trailingHit != null &&
      (emergencyHit == null || trailingHit.time <= emergencyHit.time);
    const hit = useTrailing ? trailingHit : emergencyHit;
    const exitPrice = useTrailing ? durableStop! : emergencyStop;
    const exitReason = useTrailing ? "trailing_stop" : "emergency_stop";
    if (!hit) return false;
    logger.warn(
      {
        trackedSignalId: tracked.id,
        symbol: tracked.symbol,
        candleAt: new Date(hit.time).toISOString(),
        candleLow: hit.low,
        durableStop: exitPrice,
        exitReason,
      },
      "Runner historical stop crossing recovered after downtime",
    );
    return closeImpulseRunnerFinalPosition({
      tracked,
      exitPrice,
      peakPrice: durablePeak,
      priceSource: "startup_reset",
      exitReason,
    });
  } catch (err) {
    logger.warn(
      { err, trackedSignalId: tracked.id, symbol: tracked.symbol },
      "Runner historical trailing reconciliation unavailable; live protection continues",
    );
    return false;
  }
}

async function enqueueBrMissedMilestones(): Promise<void> {
  try {
    const [tracked] = await db
      .select({
        id: trackedSignalsTable.id,
        signalId: trackedSignalsTable.signalId,
        symbol: trackedSignalsTable.symbol,
        detectedAt: trackedSignalsTable.detectedAt,
        policyVersion: trackedSignalsTable.policyVersion,
      })
      .from(trackedSignalsTable)
      .where(eq(trackedSignalsTable.id, 1688))
      .limit(1);
    if (
      !tracked ||
      !isBrMilestoneRecoveryTarget({
        id: tracked.id,
        signalId: tracked.signalId,
        symbol: tracked.symbol,
        detectedAt: tracked.detectedAt,
        policyVersion: tracked.policyVersion,
      })
    ) {
      return;
    }
    for (const milestone of BR_MISSED_MILESTONES) {
      try {
        const image = MILESTONE_IMAGES[milestone];
        if (!image) {
          logger.error({ milestone }, "BR milestone recovery image missing");
          continue;
        }
        const price = brMilestoneReconstructedPrice(milestone);
        await broadcastPhotoAfterClaim(
          image,
          [
            `🧭 BR-USDT · восстановленный milestone +${milestone}%`,
            "Задержанное уведомление восстановлено после сбоя доставки.",
            `Цена уровня: ${price.toFixed(6)} · пик: +174.10%.`,
          ].join("\n"),
          brMilestoneEventKey(milestone),
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              // This exact identity-fenced no-op is only the transactional
              // claim for this durable outbox event. It never changes trading
              // or milestone cursor state and survives terminal close.
              .set({ updatedAt: trackedSignalsTable.updatedAt })
              .where(
                and(
                  eq(trackedSignalsTable.id, tracked.id),
                  eq(trackedSignalsTable.signalId, tracked.signalId!),
                  eq(trackedSignalsTable.symbol, tracked.symbol),
                  eq(trackedSignalsTable.detectedAt, tracked.detectedAt),
                  eq(trackedSignalsTable.policyVersion, tracked.policyVersion!),
                ),
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
      } catch (err) {
        logger.warn(
          { err, trackedSignalId: tracked.id, milestone },
          "BR milestone recovery enqueue failed; continuing sequence",
        );
      }
    }
  } catch (err) {
    logger.warn(
      { err, trackedSignalId: 1688 },
      "BR milestone recovery lookup failed; runner close is not blocked",
    );
  }
}

/**
 * Uses the same atomic tracked-signal claim and Telegram outbox boundary for
 * both the two-minute fast cycle and a live price tick. The price source is
 * carried into the immutable event row so an operator can audit why a trailing
 * exit happened.
 */
async function closeTrailingPosition(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  currentPrice: number;
  peakPrice: number;
  trailingStop: number;
  exitProfile: ReturnType<typeof getExitProfile>;
  observedAt: Date;
  priceSource: "fast_cycle" | "bingx_ws_last_price" | "startup_reset";
  realtimeMonitorGeneration?: number;
}): Promise<boolean> {
  const { tracked, currentPrice, peakPrice, trailingStop, exitProfile } = input;
  if (
    tracked.status === "in_run" &&
    isImpulseRunnerPolicy(tracked.policyVersion) &&
    (!isBitcoinTrackedSignal(tracked) || isImpulseRunnerCoreClosed(tracked))
  ) {
    return closeImpulseRunnerCorePosition(input);
  }
  const peakPnl = computePeakPnl({ ...tracked, peakPrice });
  const trailingExitPnl =
    ((trailingStop - tracked.entryPrice) / tracked.entryPrice) * 100;
  if (peakPnl < exitProfile.trailingActivation || trailingExitPnl < 0) {
    logger.error(
      {
        signalId: tracked.id,
        symbol: tracked.symbol,
        peakPnl,
        trailingActivation: exitProfile.trailingActivation,
        trailingStop,
        trailingExitPnl,
      },
      "Trailing close rejected: activation/profit invariant failed",
    );
    return false;
  }
  const health = await fetchMilestoneHealth(tracked.symbol, currentPrice);
  if (
    input.realtimeMonitorGeneration != null &&
    !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
  ) {
    return false;
  }
  const closedAt = new Date();
  const delivery = await broadcastPhotoAfterClaim(
    TRAILING_STOP_IMG,
    msgTrailingStopHit(tracked, currentPrice, peakPnl, trailingExitPnl, health),
    `position:${tracked.id}:profit:trailing_stop`,
    async (tx) => {
      if (
        input.realtimeMonitorGeneration != null &&
        !isRealtimeTrailingMonitorCurrent(input.realtimeMonitorGeneration)
      ) {
        return false;
      }
      const claimed = await tx
        .update(trackedSignalsTable)
        .set({
          status: "profit",
          // Another worker may have raised the level after the observed tick.
          // Close at the higher durable protection, never below it.
          exitPrice: maxTrailingStopLevelSql(trailingStop),
          pnlPercent: sql<number>`((${maxTrailingStopLevelSql(trailingStop)} - ${trackedSignalsTable.entryPrice}) / ${trackedSignalsTable.entryPrice}) * 100`,
          peakPrice: maxPeakPriceSql(peakPrice),
          trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
          trailingStopArmedAt: trailingStopArmedAtSql(
            trailingStop,
            input.observedAt,
          ),
          closedAt,
          updatedAt: closedAt,
        })
        .where(
          sql`${trackedSignalsTable.id} = ${tracked.id}
            AND ${trackedSignalsTable.status} = ${tracked.status}
            AND (
              ${trackedSignalsTable.status} = 'in_run'
              OR (${trackedSignalsTable.status} = 'active'
                AND ${trackedSignalsTable.symbol} IN ('BTC-USDT', 'BTCUSDT'))
            )`,
        )
        .returning({ id: trackedSignalsTable.id });
      return claimed.length > 0;
    },
  );
  if (!delivery.claimed) return false;

  void _writeExitMetrics(tracked.id, tracked.symbol);
  void recordActualTrailingEvent({
    tracked,
    eventType: "hit",
    priceSource: input.priceSource,
    observedAt: input.observedAt,
    peakPrice,
    peakPnlPct: peakPnl,
    currentPrice,
    trailingStopPrice: trailingStop,
    activationPct: exitProfile.trailingActivation,
    trailingGapPct: exitProfile.trailingGap,
    actualStatus: "profit",
    actualExitPrice: trailingStop,
    actualPnlPct: trailingExitPnl,
    closedAt,
  }).catch(() => null);
  await recordCloseSnapshot(
    tracked,
    trailingStop,
    trailingExitPnl,
    peakPnl,
    "profit",
  );
  logger.info(
    {
      signalId: tracked.id,
      symbol: tracked.symbol,
      currentPrice,
      trailingStop,
      trailingExitPnl,
      peakPnl,
      priceSource: input.priceSource,
      observedAt: input.observedAt,
      queued: delivery.queued,
    },
    "Trailing stop hit — position closed and Telegram event queued",
  );
  return true;
}

async function closeRealtimeBitcoinBreakeven(input: {
  tracked: typeof trackedSignalsTable.$inferSelect;
  currentPrice: number;
  peakPrice: number;
  observedAt: Date;
  monitorGeneration: number;
}): Promise<boolean> {
  const { tracked, currentPrice, peakPrice, observedAt, monitorGeneration } =
    input;
  if (
    tracked.status !== "active" ||
    !isBitcoinTrackedSignal(tracked) ||
    currentPrice > tracked.entryPrice ||
    !isRealtimeTrailingMonitorCurrent(monitorGeneration)
  ) {
    return false;
  }

  const protectedExit = getProtectedBuStopExit(tracked.entryPrice, 0);
  const exitPrice = protectedExit.exitPrice ?? tracked.entryPrice;
  const closedAt = new Date();
  const delivery = await broadcastPhotoAfterClaim(
    BU_STOP_IMG,
    msgBUStop(
      { ...tracked, peakPrice },
      exitPrice,
      protectedExit.pnlPercent,
      null,
    ),
    `position:${tracked.id}:bu_stop:realtime_btc`,
    async (tx) => {
      if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return false;
      const claimed = await tx
        .update(trackedSignalsTable)
        .set({
          status: "bu_stop",
          exitPrice,
          pnlPercent: protectedExit.pnlPercent,
          peakPrice: maxPeakPriceSql(peakPrice),
          lastMilestone: sql<number>`GREATEST(COALESCE(${trackedSignalsTable.lastMilestone}, 0), 1)`,
          closedAt,
          updatedAt: closedAt,
        })
        .where(
          sql`${trackedSignalsTable.id} = ${tracked.id}
            AND ${trackedSignalsTable.status} = 'active'
            AND ${trackedSignalsTable.symbol} IN ('BTC-USDT', 'BTCUSDT')
            AND ${trackedSignalsTable.isShort} IS NOT TRUE
            AND GREATEST(COALESCE(${trackedSignalsTable.peakPrice}, ${trackedSignalsTable.entryPrice}), ${peakPrice}) >= ${trackedSignalsTable.entryPrice} * 1.01
            AND COALESCE(${trackedSignalsTable.peakPrice}, ${trackedSignalsTable.entryPrice}) < ${trackedSignalsTable.entryPrice} * 1.02
            AND COALESCE(${trackedSignalsTable.trailingStopLevel}, 0) <= ${trackedSignalsTable.entryPrice}`,
        )
        .returning({ id: trackedSignalsTable.id });
      return claimed.length > 0;
    },
  );
  if (!delivery.claimed) return false;

  void _writeExitMetrics(tracked.id, tracked.symbol);
  await recordCloseSnapshot(
    { ...tracked, peakPrice },
    exitPrice,
    protectedExit.pnlPercent,
    computePeakPnl({ ...tracked, peakPrice }),
    "bu_stop",
  );
  logger.info(
    {
      signalId: tracked.id,
      symbol: tracked.symbol,
      currentPrice,
      peakPrice,
      priceSource: "bingx_ws_last_price",
      observedAt,
      queued: delivery.queued,
    },
    "BTC breakeven reached after realtime +1% peak",
  );
  return true;
}

/**
 * Stealth fresh-24H-high (🧪 experimental) protection in R: the initial stop
 * (stop_loss_price) is handled by the ordinary stop path; once the peak reaches
 * +1R the stop is max(entry, peak - 1R). Closes at that level: B.U. at entry,
 * profit above it. Same claim/broadcast/close-snapshot path as trailing.
 */
export async function runStealthFreshHighProtection(
  getPrice: (symbol: string) => Promise<number | null>,
): Promise<number> {
  const open = await db
    .select()
    .from(trackedSignalsTable)
    .where(
      and(
        eq(trackedSignalsTable.sentimentKey, "stealth_breakout"),
        inArray(trackedSignalsTable.stealthDetectionMethod, [
          STEALTH_FRESH_HIGH_METHOD,
          "range_4h_breakout",
        ]),
        inArray(trackedSignalsTable.status, ["active", "in_run"]),
      ),
    );
  let closed = 0;
  for (const tracked of open) {
    if (tracked.isShort === true) continue;
    const initialStop = tracked.stopLossPrice;
    if (initialStop == null || !(initialStop > 0)) continue;
    const currentPrice = await getPrice(tracked.symbol).catch(() => null);
    if (currentPrice === null || !(currentPrice > 0)) continue;
    const peakPrice = Math.max(
      tracked.peakPrice ?? tracked.entryPrice,
      currentPrice,
    );
    const level = resolveFreshHighProtectionLevel({
      entryPrice: tracked.entryPrice,
      initialStopPrice: initialStop,
      peakPrice,
    });
    if (peakPrice > (tracked.peakPrice ?? tracked.entryPrice)) {
      await dbWriteBestEffort("trackedSignal/fresh-high-peak", () =>
        db
          .update(trackedSignalsTable)
          .set({ peakPrice: maxPeakPriceSql(peakPrice) })
          .where(eq(trackedSignalsTable.id, tracked.id)),
      );
    }
    // Study horizon: 72h from entry, closed at the observed price.
    if (
      Date.now() - tracked.detectedAt.getTime() >=
        STEALTH_FH_MAX_AGE_MS &&
      (level === null || currentPrice > level)
    ) {
      const pnl = computePnl(tracked, currentPrice);
      const status =
        level !== null && pnl > 0
          ? "profit"
          : classifyTimeoutExit({
              pnlPercent: pnl,
              protectedBe: false,
              trailingActive: false,
            });
      const peakPnl = computePeakPnl({ ...tracked, peakPrice });
      const health = await _fetchSignalHealth(
        tracked.symbol,
        currentPrice,
      ).catch(() => null);
      const at = new Date();
      const delivery = await broadcastPhotoAfterClaim(
        status === "stop_loss" ? STOPLOSS_IMG : EXPIRED_IMG,
        status === "profit"
          ? msgTimeoutTakeProfit(
              { ...tracked, peakPrice },
              currentPrice,
              pnl,
              health,
              false,
            )
          : status === "stop_loss"
            ? msgBreakevenAsStopLoss(tracked, currentPrice, pnl, health)
            : msgExpired(tracked, currentPrice, pnl, health),
        `position:${tracked.id}:timeout:${status}`,
        async (tx) => {
          const claimed = await tx
            .update(trackedSignalsTable)
            .set({
              status,
              exitPrice: currentPrice,
              pnlPercent: pnl,
              peakPrice: maxPeakPriceSql(peakPrice),
              closedAt: at,
              updatedAt: at,
            })
            .where(
              and(
                eq(trackedSignalsTable.id, tracked.id),
                inArray(trackedSignalsTable.status, ["active", "in_run"]),
              ),
            )
            .returning({ id: trackedSignalsTable.id });
          return claimed.length > 0;
        },
      );
      if (delivery.claimed) {
        closed++;
        void _writeExitMetrics(tracked.id, tracked.symbol);
        await recordCloseSnapshot(
          { ...tracked, peakPrice },
          currentPrice,
          pnl,
          peakPnl,
          status,
        );
        logger.info(
          { signalId: tracked.id, symbol: tracked.symbol, status, pnl },
          "🧪 Stealth fresh-high 72h lifetime close",
        );
      }
      continue;
    }
    if (level === null || currentPrice > level) continue;
    const isBreakeven = level <= tracked.entryPrice;
    const exitPrice = isBreakeven ? tracked.entryPrice : level;
    const exitPnl = ((exitPrice - tracked.entryPrice) / tracked.entryPrice) * 100;
    const peakPnl = computePeakPnl({ ...tracked, peakPrice });
    const closedAt = new Date();
    const health = isBreakeven
      ? null
      : await fetchMilestoneHealth(tracked.symbol, currentPrice).catch(
          () => null,
        );
    const delivery = await broadcastPhotoAfterClaim(
      isBreakeven ? BU_STOP_IMG : TRAILING_STOP_IMG,
      isBreakeven
        ? msgBUStop({ ...tracked, peakPrice }, exitPrice, 0, null)
        : msgTrailingStopHit(
            { ...tracked, peakPrice },
            currentPrice,
            peakPnl,
            exitPnl,
            health,
          ),
      `position:${tracked.id}:${isBreakeven ? "bu_stop" : "profit"}:fresh_high_r`,
      async (tx) => {
        const claimed = await tx
          .update(trackedSignalsTable)
          .set({
            status: isBreakeven ? "bu_stop" : "profit",
            exitPrice,
            pnlPercent: exitPnl,
            peakPrice: maxPeakPriceSql(peakPrice),
            ...(isBreakeven
              ? {}
              : {
                  trailingStopLevel: maxTrailingStopLevelSql(level),
                  trailingStopArmedAt: trailingStopArmedAtSql(level, closedAt),
                }),
            closedAt,
            updatedAt: closedAt,
          })
          .where(
            and(
              eq(trackedSignalsTable.id, tracked.id),
              inArray(trackedSignalsTable.status, ["active", "in_run"]),
            ),
          )
          .returning({ id: trackedSignalsTable.id });
        return claimed.length > 0;
      },
    );
    if (!delivery.claimed) continue;
    closed++;
    void _writeExitMetrics(tracked.id, tracked.symbol);
    await recordCloseSnapshot(
      { ...tracked, peakPrice },
      exitPrice,
      exitPnl,
      peakPnl,
      isBreakeven ? "bu_stop" : "profit",
    );
    logger.info(
      {
        signalId: tracked.id,
        symbol: tracked.symbol,
        currentPrice,
        level,
        exitPnl,
        peakPnl,
        queued: delivery.queued,
      },
      "🧪 Stealth fresh-high R protection hit — position closed",
    );
  }
  return closed;
}

async function recordTrailingShadowObservations(
  tracked: typeof trackedSignalsTable.$inferSelect,
  currentPrice: number,
): Promise<void> {
  if (
    tracked.status !== "in_run" ||
    !Number.isFinite(tracked.entryPrice) ||
    tracked.entryPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return;
  }

  const observedAt = new Date();
  const isShort = tracked.isShort === true;
  const peakPrice = directionAwarePeak(
    tracked.peakPrice,
    currentPrice,
    tracked.entryPrice,
    isShort,
  );
  const peakPnlPct = directionAwarePnl(tracked.entryPrice, peakPrice, isShort);
  const currentPnlPct = directionAwarePnl(
    tracked.entryPrice,
    currentPrice,
    isShort,
  );

  const freshRows: (typeof signalTrailingShadowEventsTable.$inferInsert)[] = [];
  for (const activationPct of SHADOW_TRAILING_ACTIVATIONS) {
    if (peakPnlPct < activationPct) continue;
    for (const trailingGapPct of SHADOW_TRAILING_GAPS) {
      const virtualStopPrice = resolveDirectionAwareTrailingLevel(
        tracked.entryPrice,
        peakPrice,
        trailingGapPct,
        isShort,
      );
      freshRows.push({
        signalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        isShort,
        activationPct,
        trailingGapPct,
        eventType: "activated",
        observedAt,
        currentPrice,
        currentPnlPct,
        peakPrice,
        peakPnlPct,
        virtualStopPrice,
        actualStatus: null,
        actualExitPrice: null,
        actualPnlPct: null,
      });
      if (
        isDirectionAwareTrailingHit(currentPrice, virtualStopPrice, isShort)
      ) {
        freshRows.push({
          signalId: tracked.id,
          symbol: tracked.symbol,
          sentimentKey: tracked.sentimentKey ?? "unknown",
          isShort,
          activationPct,
          trailingGapPct,
          eventType: "hit",
          observedAt,
          currentPrice,
          currentPnlPct,
          peakPrice,
          peakPnlPct,
          virtualStopPrice,
          actualStatus: null,
          actualExitPrice: null,
          actualPnlPct: null,
        });
      }
    }
  }

  if (freshRows.length > 0) {
    await dbWriteBestEffort("trailing-shadow/activation-hit", () =>
      db
        .insert(signalTrailingShadowEventsTable)
        .values(freshRows)
        .onConflictDoNothing(),
    );
  }

  // Read only the signal's already-recorded virtual hits. The resulting 6/24/72h
  // rows are first observations after their horizon, never hindsight rewrites.
  const hitRows = await db
    .select({
      activationPct: signalTrailingShadowEventsTable.activationPct,
      trailingGapPct: signalTrailingShadowEventsTable.trailingGapPct,
      hitAt: signalTrailingShadowEventsTable.observedAt,
      virtualStopPrice: signalTrailingShadowEventsTable.virtualStopPrice,
    })
    .from(signalTrailingShadowEventsTable)
    .where(
      and(
        eq(signalTrailingShadowEventsTable.signalId, tracked.id),
        eq(signalTrailingShadowEventsTable.eventType, "hit"),
      ),
    );

  const followUpRows = hitRows.flatMap((hit) =>
    SHADOW_FOLLOW_UPS.filter(
      (followUp) =>
        observedAt.getTime() - hit.hitAt.getTime() >= followUp.elapsedMs,
    ).map((followUp) => ({
      signalId: tracked.id,
      symbol: tracked.symbol,
      sentimentKey: tracked.sentimentKey ?? "unknown",
      isShort,
      activationPct: hit.activationPct,
      trailingGapPct: hit.trailingGapPct,
      eventType: followUp.eventType,
      observedAt,
      currentPrice,
      currentPnlPct,
      peakPrice,
      peakPnlPct,
      virtualStopPrice: hit.virtualStopPrice,
      actualStatus: null,
      actualExitPrice: null,
      actualPnlPct: null,
    })),
  );
  if (followUpRows.length > 0) {
    await dbWriteBestEffort("trailing-shadow/follow-up", () =>
      db
        .insert(signalTrailingShadowEventsTable)
        .values(followUpRows)
        .onConflictDoNothing(),
    );
  }
}

async function recordTrailingShadowClose(input: {
  tracked: CloseSnapshotSource;
  priceAt: number;
  pctFromEntry: number;
  peakPct: number;
  closedStatus: string;
}): Promise<void> {
  const { tracked } = input;
  if (
    !Number.isFinite(tracked.entryPrice) ||
    tracked.entryPrice == null ||
    tracked.entryPrice <= 0 ||
    !Number.isFinite(input.priceAt) ||
    input.priceAt <= 0
  ) {
    return;
  }
  const isShort = tracked.isShort === true;
  const entryPrice = tracked.entryPrice;
  const peakPrice = directionAwarePeak(
    tracked.peakPrice,
    input.priceAt,
    entryPrice,
    isShort,
  );
  const peakPnlPct = directionAwarePnl(entryPrice, peakPrice, isShort);
  const observedAt = new Date();
  const rows = SHADOW_TRAILING_ACTIVATIONS.flatMap((activationPct) =>
    SHADOW_TRAILING_GAPS.map((trailingGapPct) => ({
      signalId: tracked.id,
      symbol: tracked.symbol,
      sentimentKey: tracked.sentimentKey ?? "unknown",
      isShort,
      activationPct,
      trailingGapPct,
      eventType: "close",
      observedAt,
      currentPrice: input.priceAt,
      currentPnlPct: input.pctFromEntry,
      peakPrice,
      peakPnlPct,
      virtualStopPrice: resolveDirectionAwareTrailingLevel(
        entryPrice,
        peakPrice,
        trailingGapPct,
        isShort,
      ),
      actualStatus: input.closedStatus,
      actualExitPrice: input.priceAt,
      actualPnlPct: input.pctFromEntry,
    })),
  );
  await dbWriteBestEffort("trailing-shadow/close", () =>
    db
      .insert(signalTrailingShadowEventsTable)
      .values(rows)
      .onConflictDoNothing(),
  );
}

// ── Entry-anchored +10% → +5% profit-lock shadow ─────────────────────────────
// This deliberately has a separate lifecycle from peak-gap trailing candidates:
// it locks a fixed +5% from entry once the observed peak crosses +10%.
type ProfitLockActivationCacheEntry = {
  activationPersisted: boolean;
  peakPrice: number;
  peakPnlPct: number;
  persistedPeakPnlPct: number;
};

const profitLockActivationCache = new Map<
  number,
  ProfitLockActivationCacheEntry
>();
const profitLockActivationMissUntil = new Map<number, number>();
const profitLockLastObservedPrice = new Map<number, number>();
const PROFIT_LOCK_ACTIVATION_MISS_TTL_MS = 15 * 60_000;
let profitLockActivationCacheReady = false;
let profitLockActivationCacheLoad: Promise<void> | null = null;

async function ensureProfitLockActivationCache(): Promise<void> {
  if (profitLockActivationCacheReady) return;
  if (profitLockActivationCacheLoad) return profitLockActivationCacheLoad;

  profitLockActivationCacheLoad = (async () => {
    const activations = await db
      .select({
        signalId: trackedSignalsTable.id,
        peakPrice: signalProfitLockShadowEventsTable.peakPrice,
        peakPnlPct: signalProfitLockShadowEventsTable.peakPnlPct,
      })
      .from(trackedSignalsTable)
      .leftJoin(
        signalProfitLockShadowEventsTable,
        and(
          eq(
            signalProfitLockShadowEventsTable.signalId,
            trackedSignalsTable.id,
          ),
          eq(
            signalProfitLockShadowEventsTable.activationPct,
            PROFIT_LOCK_ACTIVATION_PCT,
          ),
          eq(
            signalProfitLockShadowEventsTable.lockedProfitPct,
            PROFIT_LOCKED_PNL_PCT,
          ),
          eq(signalProfitLockShadowEventsTable.eventType, "activated"),
        ),
      )
      .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));
    profitLockActivationCache.clear();
    profitLockActivationMissUntil.clear();
    const missUntil = Date.now() + PROFIT_LOCK_ACTIVATION_MISS_TTL_MS;
    for (const activation of activations) {
      if (activation.peakPrice === null || activation.peakPnlPct === null) {
        profitLockActivationMissUntil.set(activation.signalId, missUntil);
        continue;
      }
      profitLockActivationCache.set(activation.signalId, {
        activationPersisted: true,
        peakPrice: activation.peakPrice,
        peakPnlPct: activation.peakPnlPct,
        persistedPeakPnlPct: activation.peakPnlPct,
      });
    }
    profitLockActivationCacheReady = true;
    logger.info(
      { activations: activations.length },
      "Profit-lock activation cache hydrated",
    );
  })().finally(() => {
    profitLockActivationCacheLoad = null;
  });
  return profitLockActivationCacheLoad;
}

async function getProfitLockActivation(signalId: number) {
  const [activation] = await db
    .select({
      peakPrice: signalProfitLockShadowEventsTable.peakPrice,
      peakPnlPct: signalProfitLockShadowEventsTable.peakPnlPct,
    })
    .from(signalProfitLockShadowEventsTable)
    .where(
      and(
        eq(signalProfitLockShadowEventsTable.signalId, signalId),
        eq(
          signalProfitLockShadowEventsTable.activationPct,
          PROFIT_LOCK_ACTIVATION_PCT,
        ),
        eq(
          signalProfitLockShadowEventsTable.lockedProfitPct,
          PROFIT_LOCKED_PNL_PCT,
        ),
        eq(signalProfitLockShadowEventsTable.eventType, "activated"),
      ),
    )
    .limit(1);
  return activation ?? null;
}

async function syncProfitLockPeakIfNeeded(
  signalId: number,
  activation: ProfitLockActivationCacheEntry,
): Promise<void> {
  if (!activation.activationPersisted) return;
  if (activation.peakPnlPct <= activation.persistedPeakPnlPct + 0.0001) {
    return;
  }
  const persisted = await dbWriteBestEffort("profit-lock-shadow/peak", () =>
    db
      .update(signalProfitLockShadowEventsTable)
      .set({
        peakPrice: activation.peakPrice,
        peakPnlPct: activation.peakPnlPct,
      })
      .where(
        and(
          eq(signalProfitLockShadowEventsTable.signalId, signalId),
          eq(
            signalProfitLockShadowEventsTable.activationPct,
            PROFIT_LOCK_ACTIVATION_PCT,
          ),
          eq(
            signalProfitLockShadowEventsTable.lockedProfitPct,
            PROFIT_LOCKED_PNL_PCT,
          ),
          eq(signalProfitLockShadowEventsTable.eventType, "activated"),
          sql`${signalProfitLockShadowEventsTable.peakPnlPct} < ${activation.peakPnlPct}`,
        ),
      ),
  );
  if (persisted !== null) {
    activation.persistedPeakPnlPct = activation.peakPnlPct;
  }
}

async function refreshProfitLockActivationAtBoundary(
  signalId: number,
  cachedActivation: ProfitLockActivationCacheEntry | null,
  bypassNegativeCache = false,
): Promise<ProfitLockActivationCacheEntry | null> {
  // This read happens only for a virtual hit or terminal close, never for the
  // ordinary 2-minute active-position observation. It makes independently
  // hydrated watcher workers agree on the extrema used in analytics.
  if (
    !bypassNegativeCache &&
    !cachedActivation &&
    (profitLockActivationMissUntil.get(signalId) ?? 0) > Date.now()
  ) {
    return null;
  }
  const durableActivation = await getProfitLockActivation(signalId);
  if (!durableActivation) {
    profitLockActivationMissUntil.set(
      signalId,
      Date.now() + PROFIT_LOCK_ACTIVATION_MISS_TTL_MS,
    );
    return cachedActivation;
  }
  profitLockActivationMissUntil.delete(signalId);

  if (
    !cachedActivation ||
    durableActivation.peakPnlPct > cachedActivation.peakPnlPct + 0.0001
  ) {
    const refreshed: ProfitLockActivationCacheEntry = {
      activationPersisted: true,
      peakPrice: durableActivation.peakPrice,
      peakPnlPct: durableActivation.peakPnlPct,
      persistedPeakPnlPct: durableActivation.peakPnlPct,
    };
    profitLockActivationCache.set(signalId, refreshed);
    return refreshed;
  }

  // A locally newer pending peak must win the boundary observation and is
  // synchronized before restart can rehydrate a stale durable value.
  cachedActivation.activationPersisted = true;
  cachedActivation.persistedPeakPnlPct = Math.min(
    cachedActivation.persistedPeakPnlPct,
    durableActivation.peakPnlPct,
  );
  await syncProfitLockPeakIfNeeded(signalId, cachedActivation);
  return cachedActivation;
}

async function recordProfitLockShadowObservation(
  tracked: typeof trackedSignalsTable.$inferSelect,
  currentPrice: number,
): Promise<void> {
  if (
    !["active", "in_run"].includes(tracked.status) ||
    !Number.isFinite(tracked.entryPrice) ||
    tracked.entryPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return;
  }

  try {
    await ensureProfitLockActivationCache();
  } catch (err) {
    logger.debug({ err }, "profit-lock-shadow: activation cache unavailable");
    return;
  }

  const observedAt = new Date();
  const isShort = tracked.isShort === true;
  const lockedStopPrice = resolveDirectionAwareProfitLockLevel(
    tracked.entryPrice,
    PROFIT_LOCKED_PNL_PCT,
    isShort,
  );
  let activation = profitLockActivationCache.get(tracked.id) ?? null;
  const isVirtualHitCandidate = isDirectionAwareProfitLockHit(
    currentPrice,
    lockedStopPrice,
    isShort,
  );
  const previousPrice = profitLockLastObservedPrice.get(tracked.id);
  profitLockLastObservedPrice.set(tracked.id, currentPrice);
  const crossedVirtualLock =
    previousPrice != null &&
    !isDirectionAwareProfitLockHit(previousPrice, lockedStopPrice, isShort) &&
    isVirtualHitCandidate;
  const preliminary = resolveProfitLockObservationState({
    entryPrice: tracked.entryPrice,
    currentPrice,
    isShort,
    trackedPeakPrice: tracked.peakPrice,
  });
  // A rebound to the fixed lock level can be below +10% now, so it must look
  // up a prior activation instead of trusting the long-oriented tracked peak.
  if (activation === null && !preliminary.activated && !isVirtualHitCandidate) {
    return;
  }
  if (
    isVirtualHitCandidate &&
    (activation !== null || preliminary.activated || crossedVirtualLock)
  ) {
    activation = await refreshProfitLockActivationAtBoundary(
      tracked.id,
      activation,
      crossedVirtualLock || preliminary.activated,
    );
  }
  const state = resolveProfitLockObservationState({
    entryPrice: tracked.entryPrice,
    currentPrice,
    isShort,
    trackedPeakPrice: tracked.peakPrice,
    activatedPeakPrice: activation?.peakPrice,
  });
  if (!state.activated) return;

  const common = {
    signalId: tracked.id,
    symbol: tracked.symbol,
    sentimentKey: tracked.sentimentKey ?? "unknown",
    isShort,
    activationPct: PROFIT_LOCK_ACTIVATION_PCT,
    lockedProfitPct: PROFIT_LOCKED_PNL_PCT,
    observedAt,
    currentPrice,
    currentPnlPct: state.currentPnlPct,
    peakPrice: state.peakPrice,
    peakPnlPct: state.peakPnlPct,
    lockedStopPrice,
    actualStatus: null,
    actualExitPrice: null,
    actualPnlPct: null,
  };
  const rows: (typeof signalProfitLockShadowEventsTable.$inferInsert)[] = [];
  if (!activation) {
    activation = {
      activationPersisted: false,
      peakPrice: state.peakPrice,
      peakPnlPct: state.peakPnlPct,
      persistedPeakPnlPct: state.peakPnlPct,
    };
    profitLockActivationCache.set(tracked.id, activation);
    profitLockActivationMissUntil.delete(tracked.id);
  } else {
    activation.peakPrice = state.peakPrice;
    activation.peakPnlPct = state.peakPnlPct;
    await syncProfitLockPeakIfNeeded(tracked.id, activation);
  }
  if (!activation.activationPersisted) {
    rows.push({ ...common, eventType: "activated" });
  }
  if (state.virtualHit) {
    rows.push({
      ...common,
      eventType: "hit",
      // The hit represents a virtual fill at the protected level, not the
      // potentially worse first sampled price beyond it.
      currentPrice: state.lockedStopPrice,
      currentPnlPct: PROFIT_LOCKED_PNL_PCT,
    });
  }
  if (rows.length === 0) return;

  const written = await dbWriteBestEffort(
    "profit-lock-shadow/activation-hit",
    () =>
      db
        .insert(signalProfitLockShadowEventsTable)
        .values(rows)
        .onConflictDoNothing(),
  );
  // An ambiguous write keeps a pending activation in memory so the next
  // observation can retry without losing a short-side favorable low.
  if (written !== null && !activation.activationPersisted) {
    activation.activationPersisted = true;
    // A late initial INSERT can have committed with an older peak before this
    // retry reaches ON CONFLICT. Force a monotonic sync before treating the
    // cache peak as durable, so a restart cannot regress the shadow extrema.
    activation.persistedPeakPnlPct = Number.NEGATIVE_INFINITY;
    await syncProfitLockPeakIfNeeded(tracked.id, activation);
  }
}

async function recordProfitLockShadowClose(input: {
  tracked: CloseSnapshotSource;
  priceAt: number;
  closedStatus: string;
}): Promise<boolean> {
  const { tracked } = input;
  if (
    !Number.isFinite(tracked.entryPrice) ||
    tracked.entryPrice == null ||
    tracked.entryPrice <= 0 ||
    !Number.isFinite(input.priceAt) ||
    input.priceAt <= 0
  ) {
    return true;
  }

  const observedAt = new Date();
  const isShort = tracked.isShort === true;
  const activation = await refreshProfitLockActivationAtBoundary(
    tracked.id,
    profitLockActivationCache.get(tracked.id) ?? null,
    true,
  );
  const activationPersisted = activation?.activationPersisted ?? false;
  const state = resolveProfitLockObservationState({
    entryPrice: tracked.entryPrice,
    currentPrice: input.priceAt,
    isShort,
    trackedPeakPrice: tracked.peakPrice,
    activatedPeakPrice: activation?.peakPrice,
  });
  if (!state.activated) return true;

  const common = {
    signalId: tracked.id,
    symbol: tracked.symbol,
    sentimentKey: tracked.sentimentKey ?? "unknown",
    isShort,
    activationPct: PROFIT_LOCK_ACTIVATION_PCT,
    lockedProfitPct: PROFIT_LOCKED_PNL_PCT,
    observedAt,
    currentPrice: input.priceAt,
    currentPnlPct: state.currentPnlPct,
    peakPrice: state.peakPrice,
    peakPnlPct: state.peakPnlPct,
    lockedStopPrice: state.lockedStopPrice,
  };
  const rows: (typeof signalProfitLockShadowEventsTable.$inferInsert)[] = [];
  if (!activationPersisted) {
    rows.push({
      ...common,
      eventType: "activated",
      actualStatus: null,
      actualExitPrice: null,
      actualPnlPct: null,
    });
  }
  if (state.virtualHit) {
    rows.push({
      ...common,
      eventType: "hit",
      currentPrice: state.lockedStopPrice,
      currentPnlPct: PROFIT_LOCKED_PNL_PCT,
      actualStatus: null,
      actualExitPrice: null,
      actualPnlPct: null,
    });
  }
  rows.push({
    ...common,
    eventType: "close",
    actualStatus: input.closedStatus,
    actualExitPrice: input.priceAt,
    actualPnlPct: state.currentPnlPct,
  });

  const written = await dbWriteBestEffort("profit-lock-shadow/close", () =>
    db
      .insert(signalProfitLockShadowEventsTable)
      .values(rows)
      .onConflictDoNothing(),
  );
  if (written !== null) {
    profitLockActivationCache.delete(tracked.id);
    profitLockLastObservedPrice.delete(tracked.id);
  }
  return written !== null;
}

// ── Close trajectory snapshot ─────────────────────────────────────────────────
// Records a single 'close' row in signal_trajectory_log at the moment a signal
// reaches a terminal status (stop_loss / breakeven / bu_stop / cancelled / profit).
// Awaited by each closure path so the write is attempted synchronously with the
// closure notification. Errors are caught and logged but not re-thrown (best-effort).
// If the write fails, reconcileCloseTrajectorySnapshots() at the next restart
// fills the gap using stored exitPrice/pnlPercent/peakPrice from tracked_signals.
// Accepts a minimal source object so startup-cleanup paths (which use partial
// .returning() rows) can call it without fetching the full tracked signal row.
interface CloseSnapshotSource {
  id: number;
  symbol: string;
  sentimentKey: string | null | undefined;
  detectedAt: Date;
  entryPrice?: number;
  peakPrice?: number | null;
  isShort?: boolean;
}

const CLOSE_BTC_24H_CACHE_MS = 60_000;
export { parseCloseBtc24h, parseBtcPrice };
let _btcTickerCache: { value: BtcTickerContext; fetchedAt: number } | undefined;
let _btcTickerFetch: Promise<BtcTickerContext> | null = null;

/** BTC-USDT 24h change and price. Failures are never cached, so one ticker
 * error cannot blank every closure for the next cache window. */
export async function getBtcTickerContext(): Promise<BtcTickerContext> {
  const now = Date.now();
  if (
    _btcTickerCache &&
    now - _btcTickerCache.fetchedAt < CLOSE_BTC_24H_CACHE_MS
  ) {
    return _btcTickerCache.value;
  }
  if (_btcTickerFetch) return _btcTickerFetch;
  _btcTickerFetch = (async () => {
    try {
      const ticker = await getFutureTicker("BTC-USDT");
      const value = buildBtcTickerContext(ticker);
      if (value.change24h != null || value.price != null) {
        _btcTickerCache = { value, fetchedAt: Date.now() };
      }
      return value;
    } catch (err) {
      logger.warn({ err }, "BTC ticker context: fetch failed");
      return { change24h: null, price: null };
    } finally {
      _btcTickerFetch = null;
    }
  })();
  return _btcTickerFetch;
}

async function recordCloseBtcContext(
  signalId: number,
  closedStatus: string,
): Promise<void> {
  const [closeBtc, closeBtcDominance] = await Promise.all([
    getBtcTickerContext(),
    Promise.race([
      getBitcoinDominanceSummary(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
    ]),
  ]);
  const closeBtc24h = closeBtc.change24h;
  const closeBtcPrice = closeBtc.price;
  if (closeBtc24h == null && closeBtcPrice == null && closeBtcDominance == null)
    return;

  await dbWriteBestEffort("trackedSignal/close-btc-context", () =>
    db
      .update(trackedSignalsTable)
      .set({
        ...(closeBtc24h == null
          ? {}
          : {
              closeBtc24h: sql`COALESCE(${trackedSignalsTable.closeBtc24h}, ${closeBtc24h})`,
            }),
        ...(closeBtcPrice == null
          ? {}
          : {
              closeBtcPrice: sql`COALESCE(${trackedSignalsTable.closeBtcPrice}, ${closeBtcPrice})`,
            }),
        ...(closeBtcDominance == null
          ? {}
          : {
              closeBtcDominance: sql`COALESCE(${trackedSignalsTable.closeBtcDominance}, ${closeBtcDominance.current})`,
              closeBtcDominanceSource: sql`COALESCE(${trackedSignalsTable.closeBtcDominanceSource}, ${closeBtcDominance.source})`,
              closeBtcDominanceObservedAt: sql`COALESCE(${trackedSignalsTable.closeBtcDominanceObservedAt}, ${new Date(closeBtcDominance.updatedAt)})`,
            }),
      })
      .where(
        and(
          eq(trackedSignalsTable.id, signalId),
          sql`${trackedSignalsTable.status} = ${closedStatus}`,
          or(
            isNull(trackedSignalsTable.closeBtc24h),
            isNull(trackedSignalsTable.closeBtcPrice),
            isNull(trackedSignalsTable.closeBtcDominance),
          ),
        ),
      ),
  );
}

export async function recordCloseSnapshot(
  tracked: CloseSnapshotSource,
  priceAt: number,
  pctFromEntry: number,
  peakPct: number,
  closedStatus: string,
): Promise<void> {
  // This is intentionally captured only on the live closure path. Startup
  // trajectory reconciliation must not rewrite historical unknowns with the
  // current BTC regime.
  await recordCloseBtcContext(tracked.id, closedStatus);

  // Close telemetry is independent from the trajectory-map dedup below: a
  // process restart may already know the trajectory row while shadow rows still
  // need their final actual outcome.
  void recordTrailingShadowClose({
    tracked,
    priceAt,
    pctFromEntry,
    peakPct,
    closedStatus,
  }).catch(() => null);
  void recordProfitLockShadowClose({
    tracked,
    priceAt,
    closedStatus,
  }).catch(() => null);
  const key = `${tracked.id}:close`;
  if (_trajectoryRecorded.has(key)) return;
  const elapsedMs = Date.now() - tracked.detectedAt.getTime();
  try {
    await db
      .insert(signalTrajectoryLogTable)
      .values({
        signalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        intervalLabel: "close",
        snapshotAt: new Date(),
        elapsedMs,
        priceAt,
        pctFromEntry,
        peakPct,
        status: closedStatus,
      })
      .onConflictDoNothing();
    _trajectoryRecorded.add(key);
  } catch (err) {
    logger.warn(
      { err, symbol: tracked.symbol },
      "trajectory close: INSERT failed (non-critical)",
    );
  }
}

async function recordCoreSplitSnapshot(
  tracked: CloseSnapshotSource,
  priceAt: number,
  pnlPercent: number,
  peakPnl: number,
): Promise<void> {
  try {
    await db
      .insert(signalTrajectoryLogTable)
      .values({
        signalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        intervalLabel: "core_close",
        snapshotAt: new Date(),
        elapsedMs: Date.now() - tracked.detectedAt.getTime(),
        priceAt,
        pctFromEntry: pnlPercent,
        peakPct: peakPnl,
        status: "core_closed",
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.warn({ err, signalId: tracked.id }, "Core split snapshot skipped");
  }
}

// ── Fast cycle (every 2 min): active + in_run for stop-loss / first-target / trailing ──────────
async function runInRunFastCycle(
  realtimeMonitorGeneration = realtimeTrailingMonitorFence.current(),
): Promise<void> {
  // Check active and in_run signals every 2 min for fast stop-loss and target detection
  let fastSignals: (typeof trackedSignalsTable.$inferSelect)[] = [];
  // Retry loop: Neon connection pool may be temporarily exhausted by scanner
  // 3 attempts × 5s delay — scanner batch typically releases within ~3s
  const fastFetch = await dbReadWithRetry("FastCycle", () =>
    db
      .select()
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.status, ["active", "in_run"])),
  );
  if (!fastFetch.ok) return;
  fastSignals = fastFetch.value;
  // Keep the realtime stream's small subscription set aligned with durable
  // state even before its independent 30-second refresh gets a chance to run.
  syncRealtimeTrailingCandidates(fastSignals, realtimeMonitorGeneration);

  try {
    const recovered = await reconcileMilestoneRecipientDeliveries();
    if (recovered > 0) {
      logger.info(
        { recovered },
        "Milestone recipient recovery dispatched pending deliveries",
      );
    }
  } catch (err) {
    logger.warn({ err }, "Milestone recipient recovery failed");
  }
  try {
    await reconcileImpulseRunnerCoreCloseDeliveries();
  } catch (err) {
    logger.warn(
      { err },
      "Impulse runner core-close delivery recovery failed in fast cycle",
    );
  }
  try {
    await reconcileImpulseRunnerAccountingCorrectionDeliveries();
  } catch (err) {
    logger.warn(
      { err },
      "Impulse runner accounting correction recovery failed in fast cycle",
    );
  }

  logger.info(
    {
      fastSignalsCount: fastSignals.length,
      symbols: fastSignals.map((s) => ({
        symbol: s.symbol,
        status: s.status,
        pnl: s.pnlPercent,
      })),
    },
    "DEBUG: fast cycle snapshot",
  );

  logger.info(
    { count: fastSignals.length, symbols: fastSignals.map((s) => s.symbol) },
    "FastCycle: начало цикла",
  );
  if (fastSignals.length === 0) return;

  let tickers: { symbol: string; lastPrice: string }[] = [];
  let fastFetchOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      tickers = (await getFutureTickers()) as any[];
      fastFetchOk = true;
      break;
    } catch (err) {
      logger.warn(
        { err, attempt },
        `FastCycle: BingX fetch attempt ${attempt}/2 failed`,
      );
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!fastFetchOk) {
    logger.error(
      "FastCycle: не удалось получить цены — стоп-лоссы пропущены в этом цикле",
    );
    return;
  }

  // Защита от пустого ответа: BingX обычно возвращает 500+ тикеров.
  // Если список пуст — что-то не так (rate-limit, partial outage). Не отменяем.
  if (tickers.length < 50) {
    logger.error(
      { tickersCount: tickers.length },
      "FastCycle: BingX вернул подозрительно мало тикеров — пропускаем цикл (защита от ложных no_price)",
    );
    return;
  }

  const priceMap = new Map<string, number>();
  const knownOnBingX = new Set<string>(); // все символы из BingX тикеров, даже с ценой 0
  for (const t of tickers) {
    knownOnBingX.add(t.symbol);
    const p = parseFloat(t.lastPrice) || 0;
    if (p > 0) priceMap.set(t.symbol, p);
  }
  markTrackerChecked(
    fastSignals
      .filter((s) => priceMap.has(s.symbol) && s.signalId != null)
      .map((s) => s.signalId as number),
  );

  // The loop is sequential (about 3 s per symbol with I/O), so a full cycle can
  // take minutes. Positions with an unsent milestone or a milestone threshold
  // already crossed are handled first so their messages are not queued behind
  // unrelated symbols (INIT +5% waited ~25 min on 2026-10-23).
  const _fastMilestoneSteps = [5, 8, 10, 15];
  const _fastPriority = (t: (typeof fastSignals)[number]): number => {
    if (t.pendingMilestone != null) return 0;
    const price = priceMap.get(t.symbol);
    if (!price || !(t.entryPrice > 0)) return 2;
    const pnlNow = ((price - t.entryPrice) / t.entryPrice) * 100;
    const last = t.lastMilestone ?? 0;
    return _fastMilestoneSteps.some((m) => pnlNow >= m && last < m) ? 1 : 2;
  };
  const _fastOrdered = fastSignals
    .map((t, index) => ({ t, index, rank: _fastPriority(t) }))
    .sort((x, y) => x.rank - y.rank || x.index - y.index)
    .map((x) => x.t);

  for (const tracked of _fastOrdered) {
    try {
      const currentPrice = priceMap.get(tracked.symbol);
      if (!currentPrice) {
        const cancellationPolicy = getCancellationPolicy(tracked.sentimentKey);
        if (!isAutomaticCancellationEnabled(cancellationPolicy)) {
          logger.info(
            { symbol: tracked.symbol, pattern: tracked.sentimentKey },
            "FastCycle: automatic cancellation disabled — skipping no-price cancellation",
          );
          continue;
        }
        // Если символ ЕСТЬ в тикерах BingX но цена = 0 — временный сбой API.
        // Не отменяем — ждём следующего цикла. no_price_30m применяется только
        // если символ ПОЛНОСТЬЮ отсутствует в списке тикеров BingX.
        if (knownOnBingX.has(tracked.symbol)) {
          logger.debug(
            { symbol: tracked.symbol },
            "FastCycle: цена 0 на BingX — пропускаем цикл (не отмена)",
          );
          continue;
        }
        // Нет цены в течение >30 минут после обнаружения — монета недоступна на BingX.
        // Авто-отмена с уведомлением. Случай BingX down обработан выше (fastFetchOk gate).
        const ageMs = Date.now() - tracked.detectedAt.getTime();
        const NO_PRICE_CANCEL_MS = 30 * 60_000;
        if (
          ageMs > NO_PRICE_CANCEL_MS &&
          !(
            isImpulseRunnerCoreClosed(tracked) && tracked.runnerState === "open"
          )
        ) {
          const closedAt = new Date();
          const msg = [
            `❌ <b>Позиция отменена — цена недоступна</b>`,
            ``,
            `<b>${tracked.symbol}</b>`,
            `Цена не найдена на BingX более ${Math.round(ageMs / 60_000)}м.`,
            `Цена недоступна на BingX — торги приостановлены или символ снят с торгов.`,
            activeForLine(tracked.detectedAt, closedAt),
            ``,
            formatMarketLinks(tracked.symbol),
            ``,
            `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} #cancelled`,
          ]
            .filter(Boolean)
            .join("\n");

          const delivery = await broadcastPhotoAfterClaim(
            CANCEL_IMG,
            msg,
            `cancel:${tracked.id}:no_price_30m`,
            async (tx) => {
              const claimed = await tx
                .update(trackedSignalsTable)
                .set({
                  status: "cancelled",
                  cancelReason: "no_price_30m",
                  closedAt,
                  updatedAt: closedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id}
                    AND ${trackedSignalsTable.status} IN ('active','in_run')
                    AND NOT (
                      ${trackedSignalsTable.runnerState} = 'open'
                      AND ${trackedSignalsTable.coreClosedAt} IS NOT NULL
                    )`,
                )
                .returning({ id: trackedSignalsTable.id });
              if (!claimed.length) return false;
              await _recordCancelOutcomeInClaim(tx, {
                signalId: tracked.id,
                symbol: tracked.symbol,
                sentimentKey: tracked.sentimentKey ?? null,
                cancelReason: "no_price_30m",
                pnlAtCancel: tracked.pnlPercent ?? null,
                priceAtCancel: null,
                entryPrice: tracked.entryPrice ?? null,
                sentAt: closedAt,
              });
              return true;
            },
          );
          if (delivery.claimed) {
            void _writeExitMetrics(tracked.id, tracked.symbol);
            await recordCloseSnapshot(
              tracked,
              0,
              0,
              tracked.peakPrice ? computePnl(tracked, tracked.peakPrice) : 0,
              "cancelled",
            );
            logger.warn(
              {
                symbol: tracked.symbol,
                ageMin: Math.round(ageMs / 60_000),
                queued: delivery.queued,
              },
              "⚠️ FastCycle: no BingX price — signal auto-cancelled",
            );
          }
        }
        continue;
      }

      // ── LEGACY SPLIT-ENTRY FILL: only rows without entry policy version ─────
      // Legacy model: 50% at signal + 50% limit at −5%.
      // При касании: entryPrice → средняя (×0.975 от входа), стоп пересчитывается
      // от средней (тот же %), оригинал сохраняется в originalEntryPrice.
      // Лимитка "отменяется" после первой цели (lastMilestone) или смены статуса.
      // Atomic claim (splitFilledAt IS NULL) — дедуп между двумя prod-процессами.
      if (
        tracked.status === "active" &&
        tracked.lastMilestone == null &&
        !tracked.isShort &&
        tracked.splitLimitPrice != null &&
        tracked.splitFilledAt == null &&
        tracked.entryPolicyVersion == null &&
        currentPrice <= tracked.splitLimitPrice
      ) {
        try {
          const splitFill = resolveLongSplitFillAdjustment({
            entryPrice: tracked.entryPrice,
            splitLimitPrice: tracked.splitLimitPrice,
            stopLossPct: effStopPct(tracked),
          });
          const _avgEntry = splitFill.entryPrice;
          const _newStopPrice = splitFill.stopLossPrice;
          const _resetPeakPrice = splitFill.peakPrice;
          const _origEntry = tracked.originalEntryPrice ?? tracked.entryPrice;
          const _fmtP = (p: number) =>
            p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2);
          const fillMarketContext = await fetchSplitFillMarketContext(
            tracked.symbol,
            currentPrice,
          );
          const fillMarketLines = fmtSplitFillMarketContext(fillMarketContext);
          const fillMarketBlock =
            fillMarketLines.length > 0 ? `${fillMarketLines.join("\n")}\n` : "";
          const fillMessage =
            `📥 <b>${tracked.symbol} — лимитка −5% сработала</b>\n` +
            `💰 Вход: $${_fmtP(_origEntry)} → средняя $${_fmtP(_avgEntry)} (−2.5%)\n` +
            `🛑 Стоп смещён: $${_fmtP(_newStopPrice)} (−${effStopPct(tracked).toFixed(1)}% от средней)\n` +
            fillMarketBlock +
            `${formatMarketLinks(tracked.symbol)}\n` +
            `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)}`;
          const filledAt = new Date();
          const delivery = await broadcastPhotoAfterClaim(
            POSITION_UPDATE_IMG,
            fillMessage,
            `position:${tracked.id}:split_fill`,
            async (tx) => {
              const claimed = await tx
                .update(trackedSignalsTable)
                .set({
                  originalEntryPrice: _origEntry,
                  entryPrice: _avgEntry,
                  splitFilledAt: filledAt,
                  stopLossPrice: _newStopPrice,
                  peakPrice: _resetPeakPrice,
                  trailingStopLevel: null,
                  trailingStopArmedAt: null,
                  updatedAt: filledAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.splitFilledAt} IS NULL AND ${trackedSignalsTable.status} = 'active'`,
                )
                .returning({ id: trackedSignalsTable.id });
              return claimed.length > 0;
            },
          );
          if (delivery.claimed) {
            tracked.originalEntryPrice = _origEntry;
            tracked.entryPrice = _avgEntry;
            tracked.splitFilledAt = filledAt;
            tracked.stopLossPrice = _newStopPrice;
            tracked.peakPrice = _resetPeakPrice;
            tracked.trailingStopLevel = null;
            tracked.trailingStopArmedAt = null;
            logger.info(
              {
                symbol: tracked.symbol,
                origEntry: _origEntry,
                avgEntry: _avgEntry,
                newStop: _newStopPrice,
                queued: delivery.queued,
              },
              "FastCycle: SPLIT FILL — вход усреднён 📥",
            );
          }
          // Whether this worker claimed the fill or another worker won the race,
          // defer stop/target evaluation until the next cycle reads fresh state.
          continue;
        } catch (err) {
          // Fill and its recipient jobs are one unit. Do not evaluate stops or
          // targets from the stale pre-fill entry; retry next cycle instead.
          logger.warn(
            { err, symbol: tracked.symbol },
            "FastCycle: split-fill write failed — retry next cycle",
          );
          continue;
        }
      }

      const pnl = computePnl(tracked, currentPrice);
      const newPeak = Math.max(currentPrice, tracked.peakPrice ?? currentPrice);
      const peakChanged = newPeak !== tracked.peakPrice;
      void recordDrawdownMinimum(tracked, currentPrice).catch(() => null);
      void recordTrailingShadowObservations(tracked, currentPrice).catch(
        (err) =>
          logger.debug(
            { err, signalId: tracked.id },
            "trailing-shadow: observation skipped",
          ),
      );
      void recordProfitLockShadowObservation(tracked, currentPrice).catch(
        (err) =>
          logger.debug(
            { err, signalId: tracked.id },
            "profit-lock-shadow: observation skipped",
          ),
      );

      logger.info(
        {
          symbol: tracked.symbol,
          status: tracked.status,
          pnl: pnl.toFixed(2),
          currentPrice,
          peakChanged,
        },
        "FastCycle: обработка сигнала",
      );
      // Регистрируем символ для per-symbol SNF supplement (заполнит map для UI)
      registerSnfSymbol(tracked.symbol);

      const exitProfile = getExitProfile(tracked.sentimentKey, tracked.symbol);
      const fastPriceObservedAt = new Date();
      const firstTarget = exitProfile.firstTarget;
      const trailingActivation = exitProfile.trailingActivation;

      // Трейлинг активируется только при достижении trailingActivation от входа
      const peakPnlNow = computePnl(tracked, newPeak);
      const persistedPeakPnl =
        tracked.peakPrice != null
          ? computePnl(tracked, tracked.peakPrice)
          : null;
      const activeBuProtection = resolveBuStopProtection({
        sentimentKey: tracked.sentimentKey,
        symbol: tracked.symbol,
        lastMilestone: tracked.lastMilestone,
        persistedPeakPnlPercent: persistedPeakPnl,
      });
      const buStopProtectedProfitPct = activeBuProtection.protectedProfitPct;
      const protectedBuStop = getProtectedBuStopExit(
        tracked.entryPrice,
        buStopProtectedProfitPct,
      );
      const protectedBuStopPrice =
        protectedBuStop.exitPrice ?? tracked.entryPrice;
      const activeBuProtectionEarned =
        tracked.status === "active" && activeBuProtection.earned;
      // Once the standard trailing exit has settled the core, all subsequent
      // management is runner-only. This branch intentionally precedes the
      // normal BE/target exits so legacy logic cannot terminalize the runner.
      if (tracked.status === "in_run" && isImpulseRunnerCoreClosed(tracked)) {
        const runnerPeak = Math.max(
          tracked.originalEntryPrice ?? tracked.entryPrice,
          tracked.runnerPeakPrice ??
            tracked.originalEntryPrice ??
            tracked.entryPrice,
          newPeak,
        );
        const runnerEntryPrice =
          tracked.originalEntryPrice ?? tracked.entryPrice;
        const runnerTrailingStop = resolveImpulseRunnerTrailingStopPrice({
          entryPrice: runnerEntryPrice,
          peakPrice: runnerPeak,
          persistedTrailingStopLevel: tracked.runnerTrailingStopLevel,
        });
        if (
          isImpulseRunnerFiveDaysOld(tracked.detectedAt, fastPriceObservedAt)
        ) {
          const closed = await closeImpulseRunnerFinalPosition({
            tracked,
            exitPrice: currentPrice,
            peakPrice: runnerPeak,
            priceSource: "fast_cycle",
            exitReason: "age_expired",
          });
          if (closed) continue;
        }
        const runnerDecision = resolveImpulseRunnerExitDecision({
          entryPrice: runnerEntryPrice,
          currentPrice,
          peakPrice: runnerPeak,
          persistedStopLossPct: tracked.stopLossPct,
          entryPolicyVersion: tracked.entryPolicyVersion,
          persistedTrailingStopLevel:
            runnerTrailingStop ?? tracked.runnerTrailingStopLevel,
        });
        if (runnerDecision.hit) {
          const closed = await closeImpulseRunnerFinalPosition({
            tracked,
            exitPrice: runnerDecision.exitPrice!,
            peakPrice: runnerPeak,
            priceSource: "fast_cycle",
            exitReason: runnerDecision.reason!,
          });
          if (closed) continue;
        }
        if (
          runnerPeak !== tracked.runnerPeakPrice ||
          (runnerTrailingStop != null &&
            (tracked.runnerTrailingStopLevel == null ||
              runnerTrailingStop > tracked.runnerTrailingStopLevel))
        ) {
          await dbWriteBestEffort("trackedSignal/runner-state", () =>
            db
              .update(trackedSignalsTable)
              .set({
                runnerPeakPrice: maxPeakPriceSql(runnerPeak),
                runnerTrailingStopLevel:
                  runnerTrailingStop == null
                    ? trackedSignalsTable.runnerTrailingStopLevel
                    : sql<number>`GREATEST(COALESCE(${trackedSignalsTable.runnerTrailingStopLevel}, 0), ${runnerTrailingStop})`,
                runnerTrailingStopArmedAt:
                  runnerTrailingStop == null
                    ? trackedSignalsTable.runnerTrailingStopArmedAt
                    : sql<Date>`COALESCE(${trackedSignalsTable.runnerTrailingStopArmedAt}, ${fastPriceObservedAt})`,
                peakPrice: maxPeakPriceSql(runnerPeak),
                updatedAt: fastPriceObservedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'in_run' AND ${trackedSignalsTable.runnerState} = 'open'`,
              ),
          );
        }
        await processImpulseRunnerMilestone(
          tracked,
          runnerPeak,
          runnerTrailingStop,
        );
        continue;
      }
      const activatedTrailingStop = resolveActivatedTrailingStopLevel({
        peakPnlPercent: peakPnlNow,
        trailingActivationPercent: trailingActivation,
        entryPrice: tracked.entryPrice,
        peakPrice: newPeak,
        trailingGapPercent: exitProfile.trailingGap,
        persistedTrailingStopLevel: tracked.trailingStopLevel,
      });
      const trailingActive = activatedTrailingStop !== null;
      const trailingStop =
        activatedTrailingStop ??
        resolveTrailingStopLevel({
          entryPrice: tracked.entryPrice,
          peakPrice: newPeak,
          trailingGapPercent: exitProfile.trailingGap,
          persistedTrailingStopLevel: null,
        });
      // Трейлинг сработал: только если активен и цена пробила уровень вниз
      const trailingHit =
        trailingActive && isTrailingStopHit(currentPrice, trailingStop);
      // Трейлинг только что активировался в этом цикле (пик пересёк порог)
      const trailingJustActivated =
        tracked.status === "in_run" &&
        (tracked.lastMilestone == null ||
          tracked.lastMilestone < trailingActivation) &&
        peakPnlNow >= trailingActivation;

      // ── HARD TRAILING EXIT ───────────────────────────────────────────────────
      // Закрытие по уже активированному трейлингу важнее любых Telegram-очередей,
      // health-запросов и milestone retry. Раньше retryPendingMilestoneNotification()
      // ниже мог сделать continue, а обычный путь закрытия зависел от строгого
      // resolveTargets(): цена уже дошла до трейлинга, но позиция оставалась open.
      //
      // Сначала атомарно фиксируем экономический результат И ставим Telegram
      // событие в outbox. Фактическая отправка выполняется после commit, поэтому
      // второй worker не сможет ни закрыть позицию повторно, ни создать дубль.
      if (
        trailingHit &&
        (tracked.status === "in_run" ||
          (tracked.status === "active" && isBitcoinTrackedSignal(tracked)))
      ) {
        const closed = await closeTrailingPosition({
          tracked,
          currentPrice,
          peakPrice: newPeak,
          trailingStop,
          exitProfile,
          observedAt: new Date(),
          priceSource: "fast_cycle",
        });
        if (closed) continue;
      }

      // Защищённый выход важнее retry Telegram milestone, stale-проверок и
      // любых последующих continue. Для active защита подтверждается milestone
      // или durable peak; in_run уже означает достигнутую первую цель.
      const hardBuProtectionEarned =
        tracked.status === "in_run" ||
        (tracked.status === "active" && activeBuProtectionEarned);
      if (
        hardBuProtectionEarned &&
        !trailingActive &&
        currentPrice <= protectedBuStopPrice
      ) {
        const protectedExit = protectedBuStop;
        const buStopPnl = protectedExit.pnlPercent;
        const closedAt = new Date();
        const statusAtClaim = tracked.status;
        const delivery = await broadcastPhotoAfterClaim(
          BU_STOP_IMG,
          msgBUStop(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            null,
          ),
          `position:${tracked.id}:bu_stop:hard_protection`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "bu_stop",
                exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
                pnlPercent: buStopPnl,
                peakPrice: newPeak,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} = ${statusAtClaim}
                  AND (
                    ${trackedSignalsTable.coreClosedAt} IS NULL
                    OR ${trackedSignalsTable.runnerState} IS DISTINCT FROM 'open'
                  )`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            peakPnlNow,
            "bu_stop",
          );
          logger.info(
            {
              symbol: tracked.symbol,
              statusAtClaim,
              protectedStopPrice: protectedBuStopPrice,
              pnl: buStopPnl,
              queued: delivery.queued,
            },
            "FastCycle: hard BE STOP before retries and stale checks 🛡",
          );
        }
        continue;
      }

      // ── Сохраняем peak НЕМЕДЛЕННО — до любого continue ──────────────────────
      // Без этого continue в stale-check / OI-extended window пропускают строки
      // 1725-1733 и peak никогда не записывается в БД. Монета бьёт +10%, но
      // следующий цикл читает peak=entry из БД → trailing stop не активируется,
      // milestone не шлётся, сигнал отменяется с peak=entry.
      // GREATEST защищает от гонки двух воркер-процессов.
      if (peakChanged) {
        await dbWriteStrict("trackedSignal/fast-peak-update", () =>
          db
            .update(trackedSignalsTable)
            .set({
              peakPrice: maxPeakPriceSql(newPeak),
              ...(trailingActive
                ? {
                    trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                    trailingStopArmedAt: trailingStopArmedAtSql(
                      trailingStop,
                      fastPriceObservedAt,
                    ),
                  }
                : {}),
              updatedAt: fastPriceObservedAt,
            })
            .where(
              sql`${trackedSignalsTable.id} = ${tracked.id}
                AND ${trackedSignalsTable.status} IN ('active','in_run')`,
            ),
        );
      }

      // A previous process may have persisted peak_price and then crashed before
      // last_milestone. Recover the economic BE state before any stop check.
      if (
        activeBuProtectionEarned &&
        (tracked.lastMilestone ?? 0) < activeBuProtection.milestone
      ) {
        const recovered = await dbWriteStrict(
          "trackedSignal/bu-protection-peak-recovery",
          () =>
            db
              .update(trackedSignalsTable)
              .set({
                lastMilestone: activeBuProtection.milestone,
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} = 'active'
                  AND (${trackedSignalsTable.lastMilestone} IS NULL
                    OR ${trackedSignalsTable.lastMilestone} < ${activeBuProtection.milestone})`,
              )
              .returning({ id: trackedSignalsTable.id }),
        );
        if (recovered.length > 0) {
          tracked.lastMilestone = activeBuProtection.milestone;
          logger.warn(
            {
              symbol: tracked.symbol,
              milestone: activeBuProtection.milestone,
              persistedPeakPnl,
            },
            "FastCycle: BE protection recovered from durable peak",
          );
        }
      }

      const ageMs = Date.now() - tracked.detectedAt.getTime();
      const ageHours = ageMs / 3_600_000;
      const ageDays = ageHours / 24;

      // ── Trajectory snapshot (15m/30m/1h/2h/4h/8h/24h/48h/72h) ───────────────
      void maybeRecordTrajectory(tracked, currentPrice, pnl, peakPnlNow).catch(
        () => null,
      );
      void maybeRecordStealthHourlySnapshot(
        tracked,
        currentPrice,
        pnl,
        peakPnlNow,
      ).catch(() => null);

      // Hourly update удалён — сопровождение теперь только по триггеру (4h блок ниже)

      // Уведомление могло не дойти из-за ошибки Telegram/сети. Экономический
      // milestone уже записан, но pending-поля гарантируют повтор до доставки.
      if (
        await retryPendingMilestoneNotification(
          tracked,
          currentPrice,
          trailingStop,
        )
      ) {
        continue;
      }

      // At lifetime, preserve earned protection before classifying the
      // observed price. Only unprotected 0..<5% outcomes remain Expired.
      if (
        ageDays >= getMaxWatchDays(tracked.sentimentKey) &&
        !isImpulseRunnerCoreClosed(tracked)
      ) {
        const timeoutProtection = resolveBuStopProtection({
          sentimentKey: tracked.sentimentKey,
          symbol: tracked.symbol,
          lastMilestone: tracked.lastMilestone,
          persistedPeakPnlPercent: Math.max(
            persistedPeakPnl ?? Number.NEGATIVE_INFINITY,
            peakPnlNow,
          ),
        });
        const timeoutStatus = classifyTimeoutExit({
          pnlPercent: pnl,
          protectedBe:
            !trailingActive &&
            (tracked.status === "in_run" || timeoutProtection.earned),
          trailingActive,
        });
        const protectedExit = getProtectedBuStopExit(
          tracked.entryPrice,
          timeoutProtection.protectedProfitPct,
        );
        // A stop already crossed is handled above for in_run/BTC; keep the
        // earned trailing floor for other positions too if the tick gapped.
        const trailingFloorUsed =
          timeoutStatus === "profit" &&
          trailingActive &&
          currentPrice < trailingStop;
        const timeoutExitPrice =
          timeoutStatus === "bu_stop"
            ? (protectedExit.exitPrice ?? tracked.entryPrice)
            : trailingFloorUsed
              ? trailingStop
              : currentPrice;
        const timeoutPnl =
          timeoutStatus === "bu_stop"
            ? protectedExit.pnlPercent
            : computePnl(tracked, timeoutExitPrice);
        const _healthTimeout = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const timeoutAt = new Date();
        const timeoutPhoto = {
          bu_stop: BU_STOP_IMG,
          stop_loss: STOPLOSS_IMG,
          expired: EXPIRED_IMG,
        }[timeoutExitPhotoKind(timeoutStatus)];
        const delivery = await broadcastPhotoAfterClaim(
          timeoutPhoto,
          timeoutStatus === "bu_stop"
            ? msgBUStop(
                { ...tracked, peakPrice: newPeak },
                timeoutExitPrice,
                timeoutPnl,
                _healthTimeout,
              )
            : timeoutStatus === "profit"
              ? msgTimeoutTakeProfit(
                  { ...tracked, peakPrice: newPeak },
                  timeoutExitPrice,
                  timeoutPnl,
                  _healthTimeout,
                  trailingFloorUsed,
                )
              : timeoutStatus === "stop_loss"
                ? msgBreakevenAsStopLoss(
                    tracked,
                    timeoutExitPrice,
                    timeoutPnl,
                    _healthTimeout,
                  )
                : msgExpired(
                    tracked,
                    timeoutExitPrice,
                    timeoutPnl,
                    _healthTimeout,
                  ),
          `position:${tracked.id}:timeout:${timeoutStatus}`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: timeoutStatus,
                exitPrice: timeoutExitPrice,
                pnlPercent: timeoutPnl,
                peakPrice: maxPeakPriceSql(newPeak),
                ...(timeoutStatus === "bu_stop"
                  ? {
                      lastMilestone: sql<number>`GREATEST(COALESCE(${trackedSignalsTable.lastMilestone}, 0), ${timeoutProtection.milestone})`,
                    }
                  : {}),
                closedAt: timeoutAt,
                updatedAt: timeoutAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} IN ('active','in_run')
                  AND ${trackedSignalsTable.coreClosedAt} IS NULL
                  AND COALESCE(${trackedSignalsTable.peakPrice}, 0) <= ${newPeak}
                  AND COALESCE(${trackedSignalsTable.lastMilestone}, 0)
                    <= ${Math.max(tracked.lastMilestone ?? 0, timeoutProtection.earned ? timeoutProtection.milestone : 0)}
                  AND (
                    ${trackedSignalsTable.trailingStopLevel} IS NULL
                    OR (${trailingActive}
                      AND ${trackedSignalsTable.trailingStopLevel} <= ${trailingStop})
                  )`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            timeoutExitPrice,
            timeoutPnl,
            peakPnlNow,
            timeoutStatus,
          );
          logger.info(
            {
              symbol: tracked.symbol,
              timeoutStatus,
              pnl: timeoutPnl,
              queued: delivery.queued,
            },
            "FastCycle: lifetime close",
          );
        }
        continue;
      }

      // ── STOP-LOSS ПРИОРИТЕТ: проверяется ДО stale-cancel ────────────────────
      // КРИТИЧНО: stale-cancel "market health" блок содержит continue-ы ("рынок жив →
      // продлеваем"), которые ПРОПУСКАЮТ строку ~2368. Без этого раннего чека активный
      // сигнал может уйти в -18% и ниже пока рынок "здоров" по метрикам OI/стакана.
      // getNoTouchStopMs() возвращает 0 для всех паттернов (2026-07-25) — стоп активен
      // с момента открытия сигнала.
      if (
        tracked.status === "active" &&
        !activeBuProtectionEarned &&
        ageMs >= getNoTouchStopMs(tracked.sentimentKey) &&
        pnl <= -effStopPct(tracked)
      ) {
        const stoppedAt = new Date();
        const _fill = stopLossFill(tracked, currentPrice, pnl);
        const delivery = await broadcastPhotoAfterClaim(
          STOPLOSS_IMG,
          msgStopLoss(tracked, _fill.exitPrice, _fill.pnl),
          `position:${tracked.id}:stop_loss:early`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "stop_loss",
                exitPrice: _fill.exitPrice,
                pnlPercent: _fill.pnl,
                closedAt: stoppedAt,
                updatedAt: stoppedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            _fill.exitPrice,
            _fill.pnl,
            peakPnlNow,
            "stop_loss",
          );
          logger.info(
            {
              symbol: tracked.symbol,
              status: tracked.status,
              pnl: _fill.pnl,
              queued: delivery.queued,
            },
            "FastCycle: STOP LOSS (early check) ❌",
          );
        }
        continue;
      }

      // ── STALE SIGNAL: динамическая авто-отмена на основе OI ─────────────────
      // Логика: НЕ ждём 6-8ч статического окна.
      // С 1ч после входа — проверяем CoinGlass OI каждый цикл (~2 мин).
      // Если OI растёт (+2%+ за 30m/5m) → накопление идёт, продлеваем сигнал.
      // Отменяем ТОЛЬКО когда OI иссяк + рынок мёртв одновременно.
      // Статистика: 0 прибыльных из 98 сигналов где peak < 2% к моменту отмены.
      staleEvaluation: if (
        tracked.status === "active" &&
        tracked.peakPrice != null &&
        tracked.entryPrice != null &&
        tracked.entryPrice > 0
      ) {
        const peakPct =
          ((newPeak - tracked.entryPrice) / tracked.entryPrice) * 100;
        if (peakPct < 2.0) {
          const cancellationPolicy = getCancellationPolicy(
            tracked.sentimentKey,
          );
          if (!isAutomaticCancellationEnabled(cancellationPolicy)) {
            break staleEvaluation;
          }

          // ── Pattern-specific stale windows ───────────────────────────────────
          // BA/BG use slower independent windows; LC and Impulse Buy never use
          // normal stale.
          // Their full CVD/OI confirmation is checked below before any cancel path.
          const isDedicatedPolicy =
            isDedicatedCancellationPattern(cancellationPolicy);
          const stalePlan = getStaleEvaluationPlan(
            cancellationPolicy,
            ageHours,
          );
          const shouldRunNormalStale =
            !isDedicatedPolicy || stalePlan.runNormalStale;
          const shouldEvaluateMaxAge = stalePlan.evaluateMaxAge;
          if (isDedicatedPolicy) {
            if (!shouldRunNormalStale && !shouldEvaluateMaxAge) {
              // Skip only stale: smart cancellation has its own later window.
              break staleEvaluation;
            }
          } else if (tracked.sentimentKey?.startsWith("volume_breakout")) {
            // volume_breakout*: бэктест 70.8% hit+10% после stale отмены → расширяем окно.
            // 4ч initial grace (было 1ч). При OI1h ≥ 0 → держим до 10ч (было 5ч).
            if (ageHours < 4.0) continue;
            const vbvHold = _vbStaleHoldUntil.get(tracked.id);
            if (vbvHold != null && Date.now() < vbvHold) continue;
            if (vbvHold == null) {
              try {
                const vbvCgOI = await getCoinglassOI(
                  tracked.symbol,
                  currentPrice,
                );
                const vbvOi1h = vbvCgOI.oiChange1h ?? 0;
                if (vbvOi1h >= 0) {
                  // OI не снижается → держим до 10ч от момента детекта
                  const holdUntil =
                    tracked.detectedAt.getTime() + 10 * 3_600_000;
                  _vbStaleHoldUntil.set(tracked.id, holdUntil);
                  logger.info(
                    {
                      symbol: tracked.symbol,
                      pattern: tracked.sentimentKey,
                      oi1h: vbvOi1h.toFixed(1),
                      ageH: ageHours.toFixed(1),
                    },
                    "⏳ VBV STALE: OI1h ≥ 0% → расширяем окно до 10ч",
                  );
                  continue;
                }
                _vbStaleHoldUntil.set(tracked.id, 0);
                logger.info(
                  {
                    symbol: tracked.symbol,
                    pattern: tracked.sentimentKey,
                    oi1h: vbvOi1h.toFixed(1),
                    ageH: ageHours.toFixed(1),
                  },
                  "⚠️ VBV STALE: OI1h < 0% → запускаем стейл-чек",
                );
              } catch {
                continue;
              }
            }
            // hold = 0 (не продлено) или истёк → идём в обычный стейл-чек
          } else if (tracked.sentimentKey === "hidden_accumulation") {
            // hidden_accumulation: бэктест 49% hit+10% после stale отмены → расширяем окно.
            // 4ч initial grace (было 1ч). При OI1h ≥ 0 → держим до 8ч.
            if (ageHours < 4.0) continue;
            const haHold = _haStaleHoldUntil.get(tracked.id);
            if (haHold != null && Date.now() < haHold) continue;
            if (haHold == null) {
              try {
                const haCgOI = await getCoinglassOI(
                  tracked.symbol,
                  currentPrice,
                );
                const haOi1h = haCgOI.oiChange1h ?? 0;
                if (haOi1h >= 0) {
                  // OI не снижается → держим до 8ч от момента детекта
                  const holdUntil =
                    tracked.detectedAt.getTime() + 8 * 3_600_000;
                  _haStaleHoldUntil.set(tracked.id, holdUntil);
                  logger.info(
                    {
                      symbol: tracked.symbol,
                      oi1h: haOi1h.toFixed(1),
                      ageH: ageHours.toFixed(1),
                    },
                    "⏳ HA STALE: OI1h ≥ 0% → расширяем окно до 8ч",
                  );
                  continue;
                }
                _haStaleHoldUntil.set(tracked.id, 0);
                logger.info(
                  {
                    symbol: tracked.symbol,
                    oi1h: haOi1h.toFixed(1),
                    ageH: ageHours.toFixed(1),
                  },
                  "⚠️ HA STALE: OI1h < 0% → запускаем стейл-чек",
                );
              } catch {
                continue;
              }
            }
            // hold = 0 (не продлено) или истёк → идём в обычный стейл-чек
          } else {
            // Все остальные паттерны: 1ч grace
            if (ageHours < 1.0) continue;
          }

          // Hard max-age 72ч: если peak < 2% и сигнал старше 3 дней — отмена без доп. проверок
          // Grace period: в первые 30 мин после рестарта — пропускаем. FastCycle должен
          // успеть перевести сигнал в in_run или обновить peak прежде чем принять решение.
          if (Date.now() - SERVER_STARTED_AT < RESTART_GRACE_MS) {
            logger.info(
              { symbol: tracked.symbol, ageH: ageHours.toFixed(1) },
              "⏳ STALE SKIP: restart grace period — stale cancel отложен на 30 мин",
            );
            continue;
          }

          // ── Pre-fetch CoinGlass OI для NetChange guard ─────────────────────────
          // getCoinglassOI кэширует 5 мин — повторный вызов в Step 1 ниже бесплатен.
          // Вычисляем netChangePctMcap здесь один раз, используем во всех шагах отмены.
          let _preCgOI: Awaited<ReturnType<typeof getCoinglassOI>> | null =
            null;
          try {
            _preCgOI = await getCoinglassOI(tracked.symbol, currentPrice);
          } catch {
            /* ignore */
          }

          // Dedicated policies can require fail-closed confirmation. Impulse
          // Buy applies it to smart-cancel only; its max-age path retains its
          // own independent OI30m + spot-CVD outflow confirmation below.
          let _policyCvdConfirmation: Awaited<
            ReturnType<typeof getSpotCvdMtf>
          > | null = null;
          if (
            isDedicatedCancellationPattern(cancellationPolicy) &&
            shouldRequireCompleteCancellationConfirmation(
              cancellationPolicy,
              ageHours,
            )
          ) {
            try {
              _policyCvdConfirmation = await getSpotCvdMtf(tracked.symbol);
            } catch {
              /* unavailable data is intentionally handled below */
            }
            if (
              !hasCompleteCancellationConfirmation(cancellationPolicy, {
                entryCvd1h: tracked.entryCvd1h,
                entryCvd4h: tracked.entryCvd4h,
                currentCvd30m: _policyCvdConfirmation?.cvd30m ?? null,
                currentCvd1h: _policyCvdConfirmation?.cvd1h ?? null,
                oi30m: _preCgOI?.oiChange30m ?? null,
                oi4h: _preCgOI?.oiChange4h ?? null,
                oiAvailable: _preCgOI?.available === true,
              })
            ) {
              logger.info(
                {
                  symbol: tracked.symbol,
                  pattern: tracked.sentimentKey,
                  ageH: ageHours.toFixed(1),
                },
                "⏳ CANCEL SKIP: incomplete CVD/OI confirmation for dedicated policy",
              );
              continue;
            }
          }
          const _netChangePctMcap = ((): number | null => {
            const oiUsd = _preCgOI?.oiUsd ?? null;
            const oi4h = _preCgOI?.oiChange4h ?? null;
            const mcap = tracked.marketCapUsd ?? null;
            if (
              oiUsd === null ||
              oi4h === null ||
              oi4h <= 0 ||
              mcap === null ||
              mcap <= 0
            )
              return null;
            return ((oiUsd * oi4h) / 100 / mcap) * 100;
          })();

          // ── NetChange guard: защита от отмены при значительном притоке в OI vs mCap ──
          if (
            _netChangePctMcap !== null &&
            _netChangePctMcap >= NETCHANGE_MCAP_THRESHOLD
          ) {
            logger.info(
              {
                symbol: tracked.symbol,
                ageH: ageHours.toFixed(1),
                oi4hPct: (_preCgOI?.oiChange4h ?? 0).toFixed(1),
                netChangePctMcap: _netChangePctMcap.toFixed(2),
                mcapUsd: tracked.marketCapUsd,
              },
              "⏳ NETCHANGE GUARD: значительный OI-приток vs mCap — откладываем отмену",
            );
            continue;
          }

          if (ageHours >= cancellationPolicy.maxAgeHours) {
            // ── NETCHANGE GATE (max-age): отмена только при двустороннем оттоке ──
            {
              const _72futOI30m = _preCgOI?.oiChange30m ?? null;
              const _72futBothNeg = _72futOI30m !== null && _72futOI30m < 0;
              let _72spotBothNeg = false;
              try {
                const _72spot = await getSpotCvdMtf(tracked.symbol);
                _72spotBothNeg =
                  _72spot.available === true &&
                  _72spot.cvd30m === false &&
                  _72spot.cvd1h === false;
              } catch {
                /* данные недоступны → не отменяем */
              }
              if (!_72futBothNeg || !_72spotBothNeg) {
                logger.info(
                  {
                    symbol: tracked.symbol,
                    ageH: ageHours.toFixed(1),
                    futOI30m:
                      _72futOI30m != null ? _72futOI30m.toFixed(2) : "n/a",
                    futBothNeg: _72futBothNeg,
                    spotBothNeg: _72spotBothNeg,
                  },
                  "⏳ NETCHANGE GATE (max-age): не все TF в оттоке — откладываем отмену",
                );
                continue;
              }
            }
            const _oldIsStopLoss = pnl <= -CANCEL_STOP_LOSS_PCT;
            const closedAt = new Date();
            const maxAgeMessage = [
              _oldIsStopLoss
                ? `🔴⏱ <b>${tracked.symbol.replace("-USDT", "")}</b> — MAX-AGE (${cancellationPolicy.maxAgeHours}ч) — STOP LOSS`
                : `⏱ <b>${tracked.symbol.replace("-USDT", "")}</b> — MAX-AGE (${cancellationPolicy.maxAgeHours}ч)`,
              `Причина: max-age — за ${cancellationPolicy.maxAgeHours}ч цена не поднялась выше +2% от входа`,
              _oldIsStopLoss
                ? `⚠️ Засчитан как стоп лосс (цена ниже входа ≥5%)`
                : `<i>Позиция закрыта принудительно. Попробуем снова при новом сигнале.</i>`,
              `Вход: <b>${tracked.entryPrice!.toPrecision(4)}</b> | Сейчас: <b>${currentPrice.toPrecision(4)}</b> (${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)`,
              activeForLine(tracked.detectedAt, closedAt),
              ``,
              `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} ${_oldIsStopLoss ? "#stop_loss" : "#max_age"}`,
            ]
              .filter(Boolean)
              .join("\n");

            const cancelOutcomeReason = _oldIsStopLoss
              ? "stop_loss"
              : cancelReasonFor("max_age", cancellationPolicy);
            const delivery = await broadcastPhotoAfterClaim(
              _oldIsStopLoss ? BREAKEVEN_STOP_IMG : CANCEL_IMG,
              maxAgeMessage,
              `cancel:${tracked.id}:max_age`,
              async (tx) => {
                const claimed = await tx
                  .update(trackedSignalsTable)
                  .set({
                    status: _oldIsStopLoss ? "stop_loss" : "cancelled",
                    exitPrice: currentPrice,
                    pnlPercent: pnl,
                    cancelReason: cancelOutcomeReason,
                    closedAt,
                    updatedAt: closedAt,
                  })
                  .where(
                    sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
                  )
                  .returning({ id: trackedSignalsTable.id });
                if (!claimed.length) return false;
                await _recordCancelOutcomeInClaim(tx, {
                  signalId: tracked.id,
                  symbol: tracked.symbol,
                  sentimentKey: tracked.sentimentKey ?? null,
                  cancelReason: cancelOutcomeReason,
                  pnlAtCancel: pnl,
                  priceAtCancel: currentPrice,
                  entryPrice: tracked.entryPrice ?? null,
                  sentAt: closedAt,
                });
                return true;
              },
            );
            if (delivery.claimed) {
              void _writeExitMetrics(tracked.id, tracked.symbol);
              await recordCloseSnapshot(
                tracked,
                currentPrice,
                pnl,
                peakPnlNow,
                _oldIsStopLoss ? "stop_loss" : "cancelled",
              );
              logger.info(
                {
                  symbol: tracked.symbol,
                  ageH: ageHours.toFixed(1),
                  pnl: pnl.toFixed(1),
                  queued: delivery.queued,
                },
                "CANCEL: max-age policy, peak < 2%",
              );
            }
            continue;
          }

          // LC intentionally has no normal stale path. After its independent
          // max-age evaluation it falls through to the later smart-cancel path.
          if (isDedicatedPolicy && !shouldRunNormalStale) {
            break staleEvaluation;
          }

          // ── Шаг 1: проверяем OI — накопление ещё идёт? ───────────────────────
          // Используем oiChange30m как основной (15–30 мин динамика).
          // Используем oiChange30m (15–30 мин динамика).
          // Порог 2%: соответствует "вырос на 2-3% за период ожидания".
          type OiResult = "positive" | "negative" | "error";
          let oiResult: OiResult = "error";
          let freshOiPct: number | null = null;
          // cgOIData сохраняем вне try-блока чтобы переиспользовать в шагах 1b и 1c
          let cgOIData: Awaited<ReturnType<typeof getCoinglassOI>> | null =
            null;
          try {
            cgOIData = await getCoinglassOI(tracked.symbol, currentPrice);
            freshOiPct = cgOIData.oiChange30m ?? null;
            if (cgOIData.available && freshOiPct !== null) {
              oiResult = freshOiPct >= 2.0 ? "positive" : "negative";
            }
            // available=false или null → error → ждём (не отменяем при недоступности)
          } catch {
            oiResult = "error";
          }

          if (oiResult === "positive") {
            logger.info(
              {
                symbol: tracked.symbol,
                ageH: ageHours.toFixed(1),
                oiPct: freshOiPct?.toFixed(1),
              },
              "⏳ STALE EXTENDED: OI +2%+ — накопление продолжается, продлеваем",
            );
            continue;
          }
          if (oiResult === "error") {
            logger.info(
              { symbol: tracked.symbol, ageH: ageHours.toFixed(1) },
              "⚠️ STALE: CoinGlass недоступен — переходим к проверке Market Health",
            );
            // fall through к шагам 1b/1c/2
          }

          // ── Шаг 1c: Глобальный OI4h guard (макс 2 продления) ────────────────
          // Если OI за 4ч растёт ≥ +0.5% — накопление ещё идёт, не торопиться.
          // Не применяем к быстрым паттернам (FAST_STALE_PATTERNS).
          if (!FAST_STALE_PATTERNS.has(tracked.sentimentKey ?? "")) {
            const oi4hExtCount = _staleOi4hExtCount.get(tracked.id) ?? 0;
            if (oi4hExtCount < 2) {
              const oi4h = cgOIData?.oiChange4h ?? null;
              if (oi4h !== null && oi4h >= 0.5) {
                _staleOi4hExtCount.set(tracked.id, oi4hExtCount + 1);
                logger.info(
                  {
                    symbol: tracked.symbol,
                    oi4h: oi4h.toFixed(1),
                    ageH: ageHours.toFixed(1),
                    ext: oi4hExtCount + 1,
                  },
                  `⏳ STALE OI4H: OI4h +${oi4h.toFixed(1)}% → продлеваем #${oi4hExtCount + 1}/2`,
                );
                continue;
              }
            }
          }

          // ── Шаг 1e: NetChange / mCap guard ────────────────────────────────────
          // Используем cgOIData (уже загружен в Step 1 выше — свежие данные).
          // Формула: netChange4hUsd = oiUsd × oiChange4h / 100
          //          netChangePctMcap = netChange4hUsd / marketCapUsd × 100
          // Порог 0.5%: значительный институциональный приток за 4ч → не отменяем.
          // (BTC $70B mcap: 0.5% = $350M; small cap $100M: 0.5% = $500K)
          if (!FAST_STALE_PATTERNS.has(tracked.sentimentKey ?? "")) {
            const _oiUsd = cgOIData?.oiUsd ?? null;
            const _oi4h = cgOIData?.oiChange4h ?? null;
            const _mcap = tracked.marketCapUsd ?? null;
            if (
              _oiUsd !== null &&
              _oi4h !== null &&
              _oi4h > 0 &&
              _mcap !== null &&
              _mcap > 0
            ) {
              const nc = ((_oiUsd * _oi4h) / 100 / _mcap) * 100;
              if (nc >= NETCHANGE_MCAP_THRESHOLD) {
                logger.info(
                  {
                    symbol: tracked.symbol,
                    ageH: ageHours.toFixed(1),
                    oi4h: _oi4h.toFixed(1),
                    oiUsd: _oiUsd.toFixed(0),
                    netChangePctMcap: nc.toFixed(2),
                    mcapUsd: _mcap,
                  },
                  "⏳ STALE NETCHANGE: значительный OI-приток vs mCap — продлеваем",
                );
                continue;
              }
            }
          }

          // ── Шаг 1f: Spot Taker Flip — ускоренная отмена при развороте тейкера ────────
          // Spot taker 2+ цикла в sell dominance (netBuyPct < -10%) + CVD 1h отрицательный.
          // Не применяется к FAST_STALE_PATTERNS.
          if (!FAST_STALE_PATTERNS.has(tracked.sentimentKey ?? "")) {
            try {
              const takerStale = await getSpotTakerFlow(tracked.symbol).catch(
                () => null,
              );
              if (takerStale?.available)
                updateLiveSpotTaker(
                  tracked.symbol,
                  takerStale.netBuyPct ?? null,
                  takerStale.dominance ?? null,
                );
              if (
                takerStale?.available &&
                takerStale.dominance === "sell" &&
                (takerStale.netBuyPct ?? 0) < SPOT_TAKER_SELL_DOMINANCE
              ) {
                const sellCycles =
                  (_staleTakerSellCycles.get(tracked.id) ?? 0) + 1;
                _staleTakerSellCycles.set(tracked.id, sellCycles);
                if (sellCycles >= 2) {
                  const cvdConfirm = await getSpotCvdMtf(tracked.symbol).catch(
                    () => null,
                  );
                  if (cvdConfirm?.available && cvdConfirm.cvd1h === false) {
                    logger.info(
                      {
                        symbol: tracked.symbol,
                        sellCycles,
                        netBuyPct: takerStale.netBuyPct?.toFixed(1),
                      },
                      "⚠️ STALE TAKER FLIP: spot taker продаёт 2+ цикла + CVD 1h отрицательный",
                    );
                    _staleTakerFlipped.add(tracked.id);
                  }
                }
              } else {
                _staleTakerSellCycles.set(tracked.id, 0);
              }
            } catch {
              /* некритично */
            }
          }

          // ── Шаг 1d: CVD snapshot delta ────────────────────────────────────────
          // Если при входе CVD 1h/4h был позитивным, а сейчас оба стали отрицательными —
          // спот-накопление сломано. Запоминаем для сообщения об отмене.
          let _cvdFlippedNeg = false;
          if (tracked.entryCvd1h === true || tracked.entryCvd4h === true) {
            try {
              const cvdNow = await getSpotCvdMtf(tracked.symbol);
              if (
                cvdNow.available &&
                cvdNow.cvd1h === false &&
                cvdNow.cvd4h === false
              ) {
                _cvdFlippedNeg = true;
                logger.info(
                  {
                    symbol: tracked.symbol,
                    entryCvd1h: tracked.entryCvd1h,
                    entryCvd4h: tracked.entryCvd4h,
                  },
                  "⚠️ STALE CVD FLIP: CVD был позитивным при входе, сейчас 1h+4h минус — спот-накопление сломано",
                );
              }
            } catch {
              /* CVD некритичен для stale cancel */
            }
          }

          // ── Шаг 1g: Price Structure Break ─────────────────────────────────────
          // Цена -5% от входа + OI 30m отрицательный → тезис сломан структурно.
          let _priceStructureBroken = false;
          {
            const _psOi30m = cgOIData?.oiChange30m ?? null;
            if (pnl <= -5.0 && _psOi30m !== null && _psOi30m < 0) {
              _priceStructureBroken = true;
              logger.info(
                {
                  symbol: tracked.symbol,
                  pnl: pnl.toFixed(1),
                  oi30m: _psOi30m.toFixed(1),
                },
                "⚠️ PRICE STRUCTURE BREAK: цена -5% от входа + OI 30m отрицательный",
              );
            }
          }

          // ── Шаг 2: OI иссяк — проверяем рынок перед отменой ─────────────────
          // Объём или стакан ещё живые → ждём ещё один цикл.
          const healthCheck = await fetchMarketHealth(
            tracked.symbol,
            currentPrice,
          );
          // Aggregated CoinGlass order book (all futures exchanges); unavailable
          // book is never treated as bearish (no cancel reason from it).
          const obCheck = await getCgAskBids(tracked.symbol).catch(() => null);
          const isVolumeDead =
            healthCheck.cgTurnover !== null && healthCheck.cgTurnover < 0.15;
          const isBearishOB = obCheck !== null && obCheck.bias === "bear";
          // 3.4: если фьюч-оборот упал, но спот объём ещё активен (≥0.8x) — не отменяем
          const _stalePreE = getPrescanEntry(tracked.symbol);
          const _staleSpotMult =
            _stalePreE?.spotVolAvg1h && _stalePreE?.lastSpotVol1h
              ? _stalePreE.lastSpotVol1h / _stalePreE.spotVolAvg1h
              : null;
          const cancelByVol =
            isVolumeDead && (_staleSpotMult === null || _staleSpotMult < 0.8);
          const isTakerFlipped = _staleTakerFlipped.has(tracked.id);
          if (!cancelByVol && !isBearishOB && !isTakerFlipped) {
            logger.info(
              {
                symbol: tracked.symbol,
                ageH: ageHours.toFixed(1),
                cgTurnover: healthCheck.cgTurnover,
                spotMult: _staleSpotMult?.toFixed(2) ?? "n/a",
              },
              _staleSpotMult !== null && _staleSpotMult >= 0.8
                ? "⏳ STALE EXTENDED: OI упал, но спот объём ≥0.8x — продлеваем (спот активен)"
                : "⏳ STALE EXTENDED: OI упал, но объём/стакан ещё держат — продлеваем",
            );
            continue;
          }

          // ── Шаг 3: Smart Cancel Override ─────────────────────────────────────
          // Финальная страховка: strong bid wall или OI за 4ч выше настраиваемого порога.
          try {
            const [scSettings] = await db
              .select({
                smartCancelOiPct: settingsTable.smartCancelOiPct,
              })
              .from(settingsTable)
              .limit(1);
            const scOiPct = scSettings?.smartCancelOiPct ?? 5.0;

            const [scOB, scCgOI] = await Promise.all([
              getCgAskBids(tracked.symbol).catch(() => null),
              getCoinglassOI(tracked.symbol, currentPrice).catch(() => null),
            ]);

            const hasStrongBidWall = scOB?.bias === "strong_bull";
            const oi4h = scCgOI?.oiChange4h ?? null;
            const isOiGrowing4h = oi4h !== null && oi4h >= scOiPct;
            // NetChange / mCap — финальная страховка от отмены при значительном притоке
            const _scOiUsd = scCgOI?.oiUsd ?? null;
            const _scMcap = tracked.marketCapUsd ?? null;
            const scNetChangePctMcap =
              _scOiUsd !== null &&
              oi4h !== null &&
              oi4h > 0 &&
              _scMcap !== null &&
              _scMcap > 0
                ? ((_scOiUsd * oi4h) / 100 / _scMcap) * 100
                : null;
            const isNetChangeSignificant =
              scNetChangePctMcap !== null &&
              scNetChangePctMcap >= NETCHANGE_MCAP_THRESHOLD;

            if (hasStrongBidWall || isOiGrowing4h || isNetChangeSignificant) {
              logger.info(
                {
                  symbol: tracked.symbol,
                  reason: hasStrongBidWall
                    ? "strong_bid_wall"
                    : isOiGrowing4h
                      ? "oi_growing_4h"
                      : "net_change_mcap",
                  obBias: scOB?.bias ?? null,
                  oi4h,
                  scOiPct,
                  netChangePctMcap: scNetChangePctMcap?.toFixed(2) ?? null,
                },
                "⚡ Smart Cancel Override: отмена предотвращена — бычьи сигналы активны",
              );
              continue;
            }
          } catch (scErr) {
            logger.warn(
              { err: scErr, symbol: tracked.symbol },
              "Smart Cancel: ошибка проверки — продолжаем отмену",
            );
          }

          // ── NETCHANGE GATE: финальная проверка перед отменой ─────────────────
          // Правило: отменяем ТОЛЬКО если деньги уходят одновременно из фьючей И спота
          // по 30m TF. Если хоть один TF показывает приток → ждём.
          // OI 30m = futures NETCHANGE; SpotCVD 30m + 1h = spot NETCHANGE.
          // При недоступности данных — НЕ отменяем (принцип "не уверен — жди").
          {
            const _ncFutOI30m = cgOIData?.oiChange30m ?? null;
            const _ncFutBothNeg = _ncFutOI30m !== null && _ncFutOI30m < 0;
            let _ncSpotBothNeg = false;
            try {
              const _ncSpot = await getSpotCvdMtf(tracked.symbol);
              // SpotCVD 30m + 1h = устойчивый отток.
              _ncSpotBothNeg =
                _ncSpot.available === true &&
                _ncSpot.cvd30m === false &&
                _ncSpot.cvd1h === false;
            } catch {
              /* данные недоступны → считаем как не подтверждено */
            }
            if (!_ncFutBothNeg || !_ncSpotBothNeg) {
              logger.info(
                {
                  symbol: tracked.symbol,
                  ageH: ageHours.toFixed(1),
                  futOI30m:
                    _ncFutOI30m != null ? _ncFutOI30m.toFixed(2) : "n/a",
                  futBothNeg: _ncFutBothNeg,
                  spotBothNeg: _ncSpotBothNeg,
                },
                "⏳ NETCHANGE GATE: не все TF в оттоке — откладываем stale cancel",
              );
              continue;
            }
          }

          // ── Отмена: OI + объём + стакан — всё мёртво ─────────────────────────
          // NO-TOUCH: в первые 2ч/4ч — cancelled, не stop_loss
          const _staleIsStopLoss =
            pnl <= -CANCEL_STOP_LOSS_PCT &&
            ageMs >= getNoTouchStopMs(tracked.sentimentKey);
          const _staleHealth = await _fetchSignalHealth(
            tracked.symbol,
            currentPrice,
          ).catch(() => null);
          const _staleHealthLine = fmtHealthLine(_staleHealth) || null;
          const staleCancelReason = _priceStructureBroken
            ? `📉 Цена упала на ${Math.abs(pnl).toFixed(1)}% ниже входа при отрицательном OI — тезис сломан`
            : isTakerFlipped
              ? `📊 Спот тейкер 2+ цикла в sell dominance + CVD 1h отрицательный — спрос иссяк`
              : `OI иссяк — накопление не продолжилось`;

          const WF_PAT = [] as string[];
          // Bullish Accumulation is retired; generic lifecycle handling remains
          // enabled for legacy rows already in active/in_run.
          const ACC_PAT: string[] = [];

          const staleHint = _staleIsStopLoss
            ? `⚠️ Засчитан как стоп лосс (цена ниже входа ≥5%)`
            : WF_PAT.includes(tracked.sentimentKey ?? "")
              ? `<i>Кит не активировал позицию в ожидаемое окно. Мониторинг завершён.</i>`
              : ACC_PAT.includes(tracked.sentimentKey ?? "")
                ? `<i>Накопление не переросло в импульс. Возможен повторный вход при новом сигнале.</i>`
                : `<i>Капитал освобождён для новых сделок.</i>`;
          const closedAt = new Date();
          const staleMessage = [
            _staleIsStopLoss
              ? `🔴⏱ <b>${tracked.symbol.replace("-USDT", "")}</b> — STALE CANCEL — STOP LOSS`
              : `⏱ <b>${tracked.symbol.replace("-USDT", "")}</b> — STALE CANCEL`,
            ``,
            staleCancelReason,
            _cvdFlippedNeg
              ? `⚠️ Спот CVD (1h+4h) перевернулся — устойчивая распродажа`
              : null,
            _staleHealthLine,
            ``,
            `💰 Вход: <b>${tracked.entryPrice.toPrecision(4)}</b> | Сейчас: <b>${currentPrice.toPrecision(4)}</b> (${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)`,
            activeForLine(tracked.detectedAt, closedAt),
            ``,
            staleHint,
            `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} ${_staleIsStopLoss ? "#stop_loss" : "#stale_cancel"}`,
          ]
            .filter(Boolean)
            .join("\n");

          const cancelOutcomeReason = _staleIsStopLoss
            ? "stop_loss"
            : cancelReasonFor("stale", cancellationPolicy);
          const delivery = await broadcastPhotoAfterClaim(
            _staleIsStopLoss ? BREAKEVEN_STOP_IMG : CANCEL_IMG,
            staleMessage,
            `cancel:${tracked.id}:stale`,
            async (tx) => {
              const claimed = await tx
                .update(trackedSignalsTable)
                .set({
                  status: _staleIsStopLoss ? "stop_loss" : "cancelled",
                  exitPrice: currentPrice,
                  pnlPercent: pnl,
                  cancelReason: cancelOutcomeReason,
                  closedAt,
                  updatedAt: closedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
                )
                .returning({ id: trackedSignalsTable.id });
              if (!claimed.length) return false;
              await _recordCancelOutcomeInClaim(tx, {
                signalId: tracked.id,
                symbol: tracked.symbol,
                sentimentKey: tracked.sentimentKey ?? null,
                cancelReason: cancelOutcomeReason,
                pnlAtCancel: pnl,
                priceAtCancel: currentPrice,
                entryPrice: tracked.entryPrice ?? null,
                sentAt: closedAt,
              });
              return true;
            },
          );
          if (delivery.claimed) {
            void _writeExitMetrics(tracked.id, tracked.symbol);
            await recordCloseSnapshot(
              tracked,
              currentPrice,
              pnl,
              peakPnlNow,
              _staleIsStopLoss ? "stop_loss" : "cancelled",
            );
            _staleTakerSellCycles.delete(tracked.id);
            _staleTakerFlipped.delete(tracked.id);
            _staleOi4hExtCount.delete(tracked.id);
            logger.info(
              {
                symbol: tracked.symbol,
                ageHours: ageHours.toFixed(1),
                peakPct: peakPct.toFixed(1),
                queued: delivery.queued,
              },
              "FastCycle: STALE CANCEL (dynamic OI check, OI+vol+OB dead)",
            );
          }
          continue;
        }
      }

      // Реальная защита в безубыток: active сигнал уже достиг milestone (стоп перенесён в БУ),
      // цена вернулась к уровню входа (~0%) → закрываем СРАЗУ, не дожидаясь стоп-лосса.
      // Без этой проверки позиция могла падать с +5-9% до -10/-12% и всё равно
      // маркировалась как "bu_stop" (см. CAP -10.17%, TAIKO -11.98%, июль 2026).
      // bullish_accumulation: milestone = 10% (остальные: 5%).
      if (
        tracked.status === "active" &&
        activeBuProtectionEarned &&
        currentPrice !== undefined &&
        currentPrice <= protectedBuStopPrice
      ) {
        const _healthBU1 = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const protectedExit = protectedBuStop;
        const buStopPnl = protectedExit.pnlPercent;
        const closedAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          BU_STOP_IMG,
          msgBUStop(
            tracked,
            protectedExit.exitPrice ?? currentPrice,
            buStopPnl,
            _healthBU1,
          ),
          `position:${tracked.id}:bu_stop:return_to_entry`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "bu_stop",
                exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
                pnlPercent: buStopPnl,
                peakPrice: newPeak,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            peakPnlNow,
            "bu_stop",
          );
          logger.info(
            { symbol: tracked.symbol, pnl: buStopPnl, queued: delivery.queued },
            "FastCycle: BE STOP (active, реальный возврат к entry) 🛡",
          );
        }
        continue;
      }

      // Фолбэк: active сигнал уже достиг milestone (стоп перенесён в БУ), но цена проскочила
      // сразу до -effStop между циклами (гэп/резкое падение) — верхняя проверка не успела
      // поймать возврат к entry. Частичная фиксация уже была → всё равно bu_stop,
      // никогда stop_loss (это не должно срабатываться часто после фикса выше).
      // bullish_accumulation: milestone = 10% (остальные: 5%).
      if (
        tracked.status === "active" &&
        activeBuProtectionEarned &&
        pnl <= -effStopPct(tracked)
      ) {
        const actualStatus = "bu_stop" as const;
        const _healthBU2 = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const protectedExit = protectedBuStop;
        const buStopPnl = protectedExit.pnlPercent;
        const closedAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          BU_STOP_IMG,
          msgBUStop(
            tracked,
            protectedExit.exitPrice ?? currentPrice,
            buStopPnl,
            _healthBU2,
          ),
          `position:${tracked.id}:bu_stop:active_gap`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: actualStatus,
                exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
                pnlPercent: buStopPnl,
                peakPrice: newPeak,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            peakPnlNow,
            "bu_stop",
          );
          logger.info(
            {
              symbol: tracked.symbol,
              pnl: buStopPnl,
              milestone: getBuStopMilestone(
                tracked.sentimentKey,
                tracked.symbol,
              ),
              queued: delivery.queued,
            },
            "FastCycle: BE STOP (fallback: milestone hit → gapped to stop) 🛡",
          );
        }
        continue;
      }

      // Стоп-лосс (персональный по heatmap или стандартный -10%) применяется к ACTIVE,
      // ACCUMULATION и RE_ENTRY (до первой цели). ACCUMULATION = active > 24ч.
      // NO-TOUCH PERIOD: стоп пропускается пока ageMs < getNoTouchStopMs (2ч / 4ч whale).
      if (
        tracked.status === "active" &&
        ageMs >= getNoTouchStopMs(tracked.sentimentKey) &&
        pnl <= -effStopPct(tracked)
      ) {
        const _healthSL = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const closedAt = new Date();
        const _fill = stopLossFill(tracked, currentPrice, pnl);
        const delivery = await broadcastPhotoAfterClaim(
          STOPLOSS_IMG,
          msgStopLoss(tracked, _fill.exitPrice, _fill.pnl, _healthSL),
          `position:${tracked.id}:stop_loss:threshold`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "stop_loss",
                exitPrice: _fill.exitPrice,
                pnlPercent: _fill.pnl,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'active'`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            _fill.exitPrice,
            _fill.pnl,
            peakPnlNow,
            "stop_loss",
          );
          logger.info(
            {
              symbol: tracked.symbol,
              status: tracked.status,
              pnl: _fill.pnl,
              queued: delivery.queued,
            },
            "FastCycle: STOP LOSS (active) ❌",
          );
        }
        continue;
      }

      // Стоп в БУ: in_run, трейлинг ещё не активен, цена вернулась к уровню входа (0%)
      // Позиция защищена — стоп в безубытке считается как прибыль, не как убыток
      if (
        tracked.status === "in_run" &&
        !trailingActive &&
        currentPrice !== undefined &&
        currentPrice <= protectedBuStopPrice
      ) {
        const _healthBU3 = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const protectedExit = protectedBuStop;
        const buStopPnl = protectedExit.pnlPercent;
        const closedAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          BU_STOP_IMG,
          msgBUStop(
            tracked,
            protectedExit.exitPrice ?? currentPrice,
            buStopPnl,
            _healthBU3,
          ),
          `position:${tracked.id}:bu_stop:in_run_return`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "bu_stop",
                exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
                pnlPercent: buStopPnl,
                peakPrice: newPeak,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'in_run' AND ${trackedSignalsTable.coreClosedAt} IS NULL`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            peakPnlNow,
            "bu_stop",
          );
          logger.info(
            { symbol: tracked.symbol, pnl: buStopPnl, queued: delivery.queued },
            "FastCycle: BE STOP 🛡",
          );
        }
        continue;
      }

      // Стоп: in_run, трейлинг ещё не активен, цена упала ниже -10% от входа
      // in_run означает что сигнал уже прошёл +10% (стоп в БУ) → всегда bu_stop
      if (
        tracked.status === "in_run" &&
        !trailingActive &&
        pnl <= -effStopPct(tracked)
      ) {
        const _healthBU4 = await _fetchSignalHealth(
          tracked.symbol,
          currentPrice,
        ).catch(() => null);
        const protectedExit = protectedBuStop;
        const buStopPnl = protectedExit.pnlPercent;
        const closedAt = new Date();
        const delivery = await broadcastPhotoAfterClaim(
          BU_STOP_IMG,
          msgBUStop(
            tracked,
            protectedExit.exitPrice ?? currentPrice,
            buStopPnl,
            _healthBU4,
          ),
          `position:${tracked.id}:bu_stop:in_run_gap`,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                status: "bu_stop",
                exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
                pnlPercent: buStopPnl,
                peakPrice: newPeak,
                closedAt,
                updatedAt: closedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND ${trackedSignalsTable.status} = 'in_run' AND ${trackedSignalsTable.coreClosedAt} IS NULL`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          void _writeExitMetrics(tracked.id, tracked.symbol);
          await recordCloseSnapshot(
            tracked,
            protectedExit.exitPrice ?? tracked.entryPrice,
            buStopPnl,
            peakPnlNow,
            "bu_stop",
          );
          logger.info(
            { symbol: tracked.symbol, pnl: buStopPnl, queued: delivery.queued },
            "FastCycle: BE STOP (in_run, сервер лежал, пропущен BE на 0%) 🛡",
          );
        }
        continue;
      }

      // ── ТРИГГЕРНОЕ СОПРОВОЖДЕНИЕ ──────────────────────────────────────────────
      // Проверяем раз в 4ч, но отправляем только после двух последовательных
      // подтверждений. Обычные сообщения дополнительно имеют cooldown 12ч,
      // лимит 2 на позицию и пожизненный dedup по типу.
      if (
        (tracked.status === "active" || tracked.status === "in_run") &&
        ageMs >= 60 * 60_000
      ) {
        const triggerThreshold = new Date(
          Date.now() - 4 * 3_600_000 + 5 * 60_000,
        );
        const locallyDue =
          tracked.lastPeriodicUpdateAt == null ||
          tracked.lastPeriodicUpdateAt.getTime() < triggerThreshold.getTime();
        if (locallyDue) {
          const periodicAt = new Date();
          try {
            const health4h = await fetchMarketHealth(
              tracked.symbol,
              currentPrice,
            );
            const spotCvd = await getSpotCvdMtf(tracked.symbol).catch(
              () => null,
            );
            // РАССМОТРИ ВЫХОД требует два независимых негативных направления:
            // OI, оборот или агрегированный CVD. Отсутствующая метрика не
            // считается негативным подтверждением.
            const _cvdBadCount =
              spotCvd !== null && spotCvd.available === true
                ? [spotCvd.cvd15m, spotCvd.cvd30m, spotCvd.cvd1h].filter(
                    (v) => v === false,
                  ).length
                : 0;
            const healthState = classifyPositionHealth({
              oiPct: health4h.oiPct,
              turnover: health4h.cgTurnover,
              cvdBadCount: _cvdBadCount,
            });
            const messageHealthState = calibratePositionHealthMessage(
              healthState.state,
              tracked.sentimentKey,
            );
            // A separate forward cohort: known closed candles only, no Telegram.
            // Legacy observations remain unchanged for a fair comparison.
            let priceCandles: Awaited<ReturnType<typeof getKlines>> = [];
            if (healthState.state !== "neutral") {
              try {
                priceCandles = await getKlines(
                  tracked.symbol,
                  "30m",
                  12,
                  undefined,
                  undefined,
                  { strictPayload: true },
                );
              } catch (err) {
                logger.debug(
                  { err, symbol: tracked.symbol },
                  "Health price shadow: closed candles unavailable",
                );
              }
            }
            const priceShadow = classifyPriceConfirmedHealth({
              state: healthState.state,
              price: currentPrice,
              at: periodicAt,
              positionOpenedAt: tracked.detectedAt,
              candles: priceCandles,
            });
            const holdWasDowngraded =
              healthState.state === "hold" && messageHealthState === "follow";
            const holdLine = messageHealthState === "hold";
            const exitLine = messageHealthState === "exit";

            // СЛЕДИ: смешанные сигналы — не hold, не exit, но что-то слабеет
            // Строим конкретный список слабеющих индикаторов
            const followTokens: string[] = [];
            if (health4h.oiPct !== null && health4h.oiPct <= -1)
              followTokens.push(`OI: ${health4h.oiPct.toFixed(1)}%`);
            if (spotCvd?.available === true && _cvdBadCount >= 2) {
              if (spotCvd.cvd15m === false) followTokens.push(`CVD15 ↓`);
              if (spotCvd.cvd30m === false) followTokens.push(`CVD30 ↓`);
              if (spotCvd.cvd1h === false) followTokens.push(`CVD1h ↓`);
            }
            if (health4h.cgTurnover !== null && health4h.cgTurnover < 0.08)
              followTokens.push(
                `Оборот ${(health4h.cgTurnover * 100).toFixed(1)}% OI`,
              );
            if (holdWasDowngraded) {
              followTokens.push(
                "сигнал ДЕРЖИ пока не подтверждён для паттерна",
              );
            }
            const followLine = messageHealthState === "follow";

            let holdExitLine: string | null = null;
            if (exitLine) {
              // РАССМОТРИ ВЫХОД имеет приоритет над ДЕРЖИ, если одновременно
              // видны сильные негативные и позитивные признаки.
              const exitMetricParts: string[] = [];
              if (health4h.oiPct != null) {
                exitMetricParts.push(
                  `OI: ${health4h.oiPct >= 0 ? "+" : ""}${health4h.oiPct.toFixed(1)}%`,
                );
              }
              if (health4h.cgTurnover != null) {
                exitMetricParts.push(
                  `Оборот ${(health4h.cgTurnover * 100).toFixed(1)}% OI`,
                );
              }
              if (spotCvd?.available === true) {
                if (spotCvd.cvd15m === false) exitMetricParts.push("CVD15 ↓");
                if (spotCvd.cvd30m === false) exitMetricParts.push("CVD30 ↓");
                if (spotCvd.cvd1h === false) exitMetricParts.push("CVD1h ↓");
              }
              holdExitLine = `⚠️ РАССМОТРИ ВЫХОД — ${exitMetricParts.join(" | ")}`;
            } else if (holdLine) {
              // ДЕРЖИ: показываем конкретные значения OI, Оборот + CVD если доступен
              const holdCvdParts: string[] = [];
              if (spotCvd?.available === true) {
                if (spotCvd.cvd15m === true) holdCvdParts.push("CVD15 ↑");
                if (spotCvd.cvd30m === true) holdCvdParts.push("CVD30 ↑");
                if (spotCvd.cvd1h === true) holdCvdParts.push("CVD1h ↑");
              }
              const holdCvdStr =
                holdCvdParts.length > 0 ? ` | ${holdCvdParts.join(" ")}` : "";
              const holdMetricParts: string[] = [];
              if (health4h.oiPct != null)
                holdMetricParts.push(
                  `OI: ${health4h.oiPct >= 0 ? "+" : ""}${health4h.oiPct.toFixed(1)}%`,
                );
              if (health4h.cgTurnover != null)
                holdMetricParts.push(
                  `Оборот: ${(health4h.cgTurnover * 100).toFixed(1)}% OI`,
                );
              holdExitLine = `💪 ДЕРЖИ — ${holdMetricParts.join(" | ")}${holdCvdStr}`;
            } else if (followLine) {
              holdExitLine = `👀 СЛЕДИ — ${followTokens.join(" | ")}`;
            }
            // Нейтрально (всё хорошо но не сильно) → молчим

            if (!HEALTH_ADVICE_TELEGRAM_ENABLED) {
              // Claim once for both classifiers, including neutral/unknown.
              // This gives the weekly review a denominator and avoids retrying
              // a neutral evaluation every fast cycle. Never change trade state.
              await db.transaction(async (tx) => {
                const claimed = await tx
                  .update(trackedSignalsTable)
                  .set({ lastPeriodicUpdateAt: periodicAt })
                  .where(
                    and(
                      eq(trackedSignalsTable.id, tracked.id),
                      sql`(${trackedSignalsTable.lastPeriodicUpdateAt} IS NULL OR ${trackedSignalsTable.lastPeriodicUpdateAt} < ${triggerThreshold})`,
                    ),
                  )
                  .returning({ id: trackedSignalsTable.id });
                if (!claimed.length) return;
                if (holdExitLine) {
                  await _recordHealthEventInClaim(tx as any, {
                    signalId: tracked.id,
                    symbol: tracked.symbol,
                    sentimentKey: tracked.sentimentKey ?? null,
                    messageType: holdLine
                      ? "hold"
                      : exitLine
                        ? "exit"
                        : "follow",
                    pnlAtSend: pnl,
                    oi30m: health4h.oiPct ?? null,
                    turnover: health4h.cgTurnover ?? null,
                    cvd15m: spotCvd?.cvd15m ?? null,
                    cvd30m: spotCvd?.cvd30m ?? null,
                    cvd1h: spotCvd?.cvd1h ?? null,
                    priceAtSend: currentPrice,
                    entryPrice: tracked.entryPrice ?? null,
                    sentAt: periodicAt,
                    deliveryStatus: "shadow_only",
                    observationSource: "watcher_shadow",
                  });
                }
                await _recordHealthEventInClaim(tx as any, {
                  signalId: tracked.id,
                  symbol: tracked.symbol,
                  sentimentKey: tracked.sentimentKey ?? null,
                  messageType: priceShadow.state,
                  baselineState: messageHealthState,
                  rawState: healthState.state,
                  shadowEvidence: priceShadow,
                  pnlAtSend: pnl,
                  oi30m: health4h.oiPct ?? null,
                  turnover: health4h.cgTurnover ?? null,
                  cvd15m: spotCvd?.cvd15m ?? null,
                  cvd30m: spotCvd?.cvd30m ?? null,
                  cvd1h: spotCvd?.cvd1h ?? null,
                  priceAtSend: currentPrice,
                  entryPrice: tracked.entryPrice ?? null,
                  sentAt: periodicAt,
                  deliveryStatus: "shadow_price_v1",
                  observationSource: "watcher_price_v1",
                });
              });
            }

            // ── ТРИГГЕР ПО СМЕНЕ СОСТОЯНИЯ ────────────────────────────────
            // Сообщение уходит ТОЛЬКО когда состояние изменилось (neutral→follow,
            // follow→hold, hold→exit, …). Повтор того же состояния каждые 4ч — спам,
            // молчим. Состояние персистится в lastUpdateState (переживает рестарт).
            const _newState: string = messageHealthState;
            const _prevState = tracked.lastUpdateState ?? "neutral";
            const _stateChanged = _newState !== _prevState;
            const notificationDecision = decideHealthNotification({
              state: messageHealthState,
              pendingState: tracked.healthPendingState ?? null,
              pendingCount: tracked.healthPendingCount ?? 0,
              sentTypes: tracked.healthSentTypes ?? [],
              ordinarySentCount: tracked.healthOrdinarySentCount ?? 0,
              lastOrdinaryAt: tracked.healthLastOrdinaryAt ?? null,
              now: periodicAt,
            });

            if (
              resolveHealthObservationFlow(
                HEALTH_ADVICE_TELEGRAM_ENABLED,
                Boolean(holdExitLine),
              ).sendTelegram &&
              holdExitLine &&
              notificationDecision.shouldSend
            ) {
              // Статус стопа — активен или ещё в no-touch окне
              const _ntMs = getNoTouchStopMs(tracked.sentimentKey);
              const _stopIsActive = ageMs >= _ntMs;
              const _effStop = effStopPct(tracked);
              const _stopPriceVal =
                tracked.stopLossPrice ??
                (tracked.entryPrice != null && tracked.entryPrice > 0
                  ? tracked.entryPrice * (1 - _effStop / 100)
                  : null);
              const _stopPriceStr =
                _stopPriceVal != null ? `$${fmtP(_stopPriceVal)} ` : "";
              const positionProtectionLine = fmtPositionProtectionLine(tracked);
              const stopStatusLine = hasEarnedBuProtection(tracked)
                ? ""
                : _stopIsActive
                  ? `🛑 Стоп: ${_stopPriceStr}(−${_effStop.toFixed(0)}%) — активен`
                  : (() => {
                      const _actAt = new Date(
                        tracked.detectedAt.getTime() + _ntMs,
                      );
                      const _actUtc = _actAt.toISOString().slice(11, 16);
                      const _remH = ((_ntMs - ageMs) / 3_600_000).toFixed(1);
                      return `⏱ Стоп ${_stopPriceStr}(−${_effStop.toFixed(0)}%) — активируется в ${_actUtc} UTC (ещё ${_remH}ч)`;
                    })();

              const updateMsg = msgHealthUpdate(
                tracked,
                currentPrice,
                pnl,
                holdExitLine,
                [positionProtectionLine, stopStatusLine],
              );
              const triggerImg = holdLine
                ? POSITION_HOLD_IMG
                : exitLine
                  ? POSITION_EXIT_IMG
                  : POSITION_FOLLOW_IMG;
              const delivery = await broadcastPhotoAfterClaim(
                triggerImg,
                updateMsg,
                `position:${tracked.id}:health:${_newState}`,
                async (tx) => {
                  const claimed = await tx
                    .update(trackedSignalsTable)
                    .set({
                      lastPeriodicUpdateAt: periodicAt,
                      lastUpdateState: _newState,
                      healthPendingState: notificationDecision.nextPendingState,
                      healthPendingCount: notificationDecision.nextPendingCount,
                      healthSentTypes: notificationDecision.nextSentTypes,
                      healthOrdinarySentCount:
                        notificationDecision.nextOrdinarySentCount,
                      healthLastOrdinaryAt:
                        notificationDecision.nextLastOrdinaryAt,
                      updatedAt: periodicAt,
                    })
                    .where(
                      and(
                        eq(trackedSignalsTable.id, tracked.id),
                        sql`(${trackedSignalsTable.lastPeriodicUpdateAt} IS NULL OR ${trackedSignalsTable.lastPeriodicUpdateAt} < ${triggerThreshold})`,
                        sql`COALESCE(${trackedSignalsTable.healthPendingState}, '') = ${tracked.healthPendingState ?? ""}`,
                        eq(
                          trackedSignalsTable.healthPendingCount,
                          tracked.healthPendingCount ?? 0,
                        ),
                      ),
                    )
                    .returning({ id: trackedSignalsTable.id });
                  if (!claimed.length) return false;
                  await _recordHealthEventInClaim(tx, {
                    signalId: tracked.id,
                    symbol: tracked.symbol,
                    sentimentKey: tracked.sentimentKey ?? null,
                    messageType: holdLine
                      ? "hold"
                      : exitLine
                        ? "exit"
                        : "follow",
                    pnlAtSend: pnl,
                    oi30m: health4h.oiPct ?? null,
                    turnover: health4h.cgTurnover ?? null,
                    cvd15m: spotCvd?.cvd15m ?? null,
                    cvd30m: spotCvd?.cvd30m ?? null,
                    cvd1h: spotCvd?.cvd1h ?? null,
                    priceAtSend: currentPrice,
                    entryPrice: tracked.entryPrice ?? null,
                    sentAt: periodicAt,
                  });
                  return true;
                },
              );
              if (delivery.claimed) {
                tracked.lastUpdateState = _newState;
                tracked.healthPendingState =
                  notificationDecision.nextPendingState;
                tracked.healthPendingCount =
                  notificationDecision.nextPendingCount;
                tracked.healthSentTypes = notificationDecision.nextSentTypes;
                tracked.healthOrdinarySentCount =
                  notificationDecision.nextOrdinarySentCount;
                tracked.healthLastOrdinaryAt =
                  notificationDecision.nextLastOrdinaryAt;
                logger.info(
                  {
                    symbol: tracked.symbol,
                    pnl: pnl.toFixed(1),
                    oiPct: health4h.oiPct,
                    cgTurnover: health4h.cgTurnover,
                    state: holdLine ? "hold" : exitLine ? "exit" : "follow",
                    queued: delivery.queued,
                  },
                  "📊 Trigger update queued",
                );
              }
            } else if (HEALTH_ADVICE_TELEGRAM_ENABLED) {
              const claimedPeriodic = await dbWriteBestEffort(
                "trackedSignal/periodic-update-dedup",
                () =>
                  db
                    .update(trackedSignalsTable)
                    .set({
                      lastPeriodicUpdateAt: periodicAt,
                      healthPendingState: notificationDecision.nextPendingState,
                      healthPendingCount: notificationDecision.nextPendingCount,
                      updatedAt: periodicAt,
                    })
                    .where(
                      and(
                        eq(trackedSignalsTable.id, tracked.id),
                        sql`(${trackedSignalsTable.lastPeriodicUpdateAt} IS NULL OR ${trackedSignalsTable.lastPeriodicUpdateAt} < ${triggerThreshold})`,
                        sql`COALESCE(${trackedSignalsTable.healthPendingState}, '') = ${tracked.healthPendingState ?? ""}`,
                        eq(
                          trackedSignalsTable.healthPendingCount,
                          tracked.healthPendingCount ?? 0,
                        ),
                      ),
                    )
                    .returning({ id: trackedSignalsTable.id }),
                { perAttemptTimeoutMs: 4000 },
              );
              if (claimedPeriodic?.length) {
                tracked.healthPendingState =
                  notificationDecision.nextPendingState;
                tracked.healthPendingCount =
                  notificationDecision.nextPendingCount;
              }
              logger.debug(
                {
                  symbol: tracked.symbol,
                  state: _newState,
                  prev: _prevState,
                  reason: notificationDecision.reason,
                },
                "Trigger check: сообщение не отправлено",
              );
            }
          } catch (err) {
            logger.warn(
              { err, symbol: tracked.symbol },
              "Trigger monitor failed",
            );
          }
        }
      }

      // 24h/48h переход в accumulation удалён — нет спонтанных переходов по времени

      // ── SMART CANCEL: CVD 30m + 1h both negative ───────────────────────────
      // Dedicated patterns own their cancellation windows and confirmation
      // requirements. Impulse Buy uses its own six-hour smart-only policy.
      const smartCancellationPolicy = getCancellationPolicy(
        tracked.sentimentKey,
      );
      const smartCancelMinAgeMs = isDedicatedCancellationPattern(
        smartCancellationPolicy,
      )
        ? smartCancellationPolicy.smartGraceHours * 60 * 60 * 1000
        : SMART_CANCEL_MIN_AGE_MS;
      if (
        isAutomaticCancellationEnabled(smartCancellationPolicy) &&
        smartCancellationPolicy.smartCancelEnabled &&
        tracked.status === "active" &&
        ageMs >= smartCancelMinAgeMs
      ) {
        try {
          const spotCvdSC = await getSpotCvdMtf(tracked.symbol);
          const scPnlThreshold = smartCancellationPolicy.smartPnlThreshold;
          if (spotCvdSC.available && pnl <= scPnlThreshold) {
            // Защита: если при входе CVD данных не было (BingX-exclusive токен) —
            // не можем оценить "ухудшение" CVD. Smart cancel не применяем.
            const hasEntryCvd = hasEntryCvdForSmartCancellation(
              smartCancellationPolicy,
              tracked.entryCvd1h,
              tracked.entryCvd4h,
            );
            if (!hasEntryCvd) {
              logger.info(
                { symbol: tracked.symbol, pnl: pnl.toFixed(1) },
                "SMART CANCEL blocked — нет CVD данных при входе (BingX-exclusive), пропускаем",
              );
            } else {
              const allThreeNegative =
                spotCvdSC.cvd30m === false && spotCvdSC.cvd1h === false;
              if (allThreeNegative) {
                // OI guard: dedicated policies must have a complete OI snapshot;
                // the generic path retains its historical fail-open behavior.
                try {
                  const scOI = await getCoinglassOI(
                    tracked.symbol,
                    currentPrice,
                  );
                  if (
                    !hasCompleteCancellationConfirmation(
                      smartCancellationPolicy,
                      {
                        entryCvd1h: tracked.entryCvd1h,
                        entryCvd4h: tracked.entryCvd4h,
                        currentCvd30m: spotCvdSC.cvd30m,
                        currentCvd1h: spotCvdSC.cvd1h,
                        oi30m: scOI.oiChange30m ?? null,
                        oi4h: scOI.oiChange4h ?? null,
                        oiAvailable: scOI.available,
                      },
                    )
                  ) {
                    logger.info(
                      { symbol: tracked.symbol, pattern: tracked.sentimentKey },
                      "SMART CANCEL blocked — incomplete dedicated confirmation",
                    );
                    continue;
                  }
                  if (
                    scOI.available &&
                    scOI.oiChange4h !== null &&
                    scOI.oiChange4h >= smartCancellationPolicy.smartOiHoldPct
                  ) {
                    logger.info(
                      { symbol: tracked.symbol, oi4h: scOI.oiChange4h },
                      "SMART CANCEL blocked — OI 4h positive, whale still holding",
                    );
                    continue;
                  }
                } catch {
                  if (isDedicatedCancellationPattern(smartCancellationPolicy)) {
                    logger.info(
                      { symbol: tracked.symbol, pattern: tracked.sentimentKey },
                      "SMART CANCEL blocked — OI unavailable for dedicated policy",
                    );
                    continue;
                  }
                }

                // ── SMART CANCEL PAUSE v11 ─────────────────────────────────────────
                // Первый цикл: CVD минус → сохраняем метку, НЕ отменяем сразу.
                // Второй цикл >= 4 мин позже: если CVD всё ещё отрицательный → отменяем.
                // Защита от ложных отмен на коротких 5m флуктуациях CVD.
                const SMART_CANCEL_PAUSE_MS = 4 * 60_000;
                if (!tracked.lastSmartCancelCheckAt) {
                  await dbWriteBestEffort(
                    "trackedSignal/smart-cancel-mark",
                    () =>
                      db
                        .update(trackedSignalsTable)
                        .set({
                          lastSmartCancelCheckAt: new Date(),
                          updatedAt: new Date(),
                        })
                        .where(eq(trackedSignalsTable.id, tracked.id)),
                  );
                  logger.info(
                    { symbol: tracked.symbol, pnl: pnl.toFixed(1) },
                    "SMART CANCEL: первый триггер — сохраняем метку, ждём повторного подтверждения",
                  );
                  continue;
                }
                const scPausedMs =
                  Date.now() - tracked.lastSmartCancelCheckAt.getTime();
                if (scPausedMs < SMART_CANCEL_PAUSE_MS) {
                  logger.debug(
                    {
                      symbol: tracked.symbol,
                      pausedSec: Math.round(scPausedMs / 1000),
                    },
                    "SMART CANCEL: пауза — ждём 4 мин до подтверждения",
                  );
                  continue;
                }

                // Цикл 2 (>= 4 мин): перепроверяем CVD — мог восстановиться
                try {
                  const cvdRecheck = await getSpotCvdMtf(tracked.symbol);
                  const cvdRecovered =
                    cvdRecheck.available &&
                    (cvdRecheck.cvd30m === true || cvdRecheck.cvd1h === true);
                  if (cvdRecovered) {
                    // CVD восстановился — сбрасываем маркер, держим позицию
                    await dbWriteBestEffort(
                      "trackedSignal/smart-cancel-reset",
                      () =>
                        db
                          .update(trackedSignalsTable)
                          .set({
                            lastSmartCancelCheckAt: null,
                            updatedAt: new Date(),
                          })
                          .where(eq(trackedSignalsTable.id, tracked.id)),
                    );
                    logger.info(
                      {
                        symbol: tracked.symbol,
                        pnl: pnl.toFixed(1),
                        cvd30m: cvdRecheck.cvd30m,
                        cvd1h: cvdRecheck.cvd1h,
                      },
                      "SMART CANCEL blocked — CVD восстановился, держим позицию",
                    );
                    continue;
                  }
                } catch {
                  /* non-critical: если recheck упал — отменяем как обычно */
                }

                // NO-TOUCH: в первые 2ч/4ч — cancelled, не stop_loss
                const _scIsStopLoss =
                  pnl <= -CANCEL_STOP_LOSS_PCT &&
                  ageMs >= getNoTouchStopMs(tracked.sentimentKey);
                const base = tracked.symbol.replace("-USDT", "");
                const _scCvdParts = spotCvdSC.available
                  ? (
                      [
                        spotCvdSC.cvd15m === false ? "CVD15 ↓" : null,
                        spotCvdSC.cvd30m === false ? "CVD30 ↓" : null,
                        spotCvdSC.cvd1h === false ? "CVD1h ↓" : null,
                      ] as (string | null)[]
                    ).filter(Boolean)
                  : [];
                const _scHealthLine =
                  _scCvdParts.length > 0
                    ? `📈 ${_scCvdParts.join(" | ")}`
                    : null;
                const closedAt = new Date();
                const smartCancelMessage = [
                  _scIsStopLoss
                    ? `🔴🚫 <b>SMART CANCEL — ${base} — STOP LOSS</b>`
                    : `🟣🚫 <b>SMART CANCEL — ${base}</b>`,
                  `Причина: smart — спот CVD (30m + 1h) устойчиво отрицательный, разворот подтверждён`,
                  _scHealthLine,
                  `${fmtP(tracked.entryPrice)} → ${fmtP(currentPrice)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}%)`,
                  activeForLine(tracked.detectedAt, closedAt),
                  ``,
                  _scIsStopLoss
                    ? `⚠️ Засчитан как стоп лосс (цена ниже входа ≥5%)`
                    : null,
                  ``,
                  `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} ${_scIsStopLoss ? "#stop_loss" : "#smart_cancel"}`,
                ]
                  .filter(Boolean)
                  .join("\n");

                const cancelOutcomeReason = _scIsStopLoss
                  ? "stop_loss"
                  : cancelReasonFor("smart", smartCancellationPolicy);
                const delivery = await broadcastPhotoAfterClaim(
                  _scIsStopLoss ? BREAKEVEN_STOP_IMG : CANCEL_IMG,
                  smartCancelMessage,
                  `cancel:${tracked.id}:smart_cancel`,
                  async (tx) => {
                    const claimed = await tx
                      .update(trackedSignalsTable)
                      .set({
                        status: _scIsStopLoss ? "stop_loss" : "cancelled",
                        exitPrice: currentPrice,
                        pnlPercent: pnl,
                        cancelReason: cancelOutcomeReason,
                        closedAt,
                        updatedAt: closedAt,
                      })
                      .where(
                        sql`${trackedSignalsTable.id} = ${tracked.id}
                          AND ${trackedSignalsTable.status} = 'active'
                          AND NOT (
                            ${trackedSignalsTable.coreClosedAt} IS NOT NULL
                            AND ${trackedSignalsTable.runnerState} = 'open'
                          )`,
                      )
                      .returning({ id: trackedSignalsTable.id });
                    if (!claimed.length) return false;
                    await _recordCancelOutcomeInClaim(tx, {
                      signalId: tracked.id,
                      symbol: tracked.symbol,
                      sentimentKey: tracked.sentimentKey ?? null,
                      cancelReason: cancelOutcomeReason,
                      pnlAtCancel: pnl,
                      priceAtCancel: currentPrice,
                      entryPrice: tracked.entryPrice ?? null,
                      sentAt: closedAt,
                    });
                    return true;
                  },
                );
                if (delivery.claimed) {
                  void _writeExitMetrics(tracked.id, tracked.symbol);
                  await recordCloseSnapshot(
                    tracked,
                    currentPrice,
                    pnl,
                    peakPnlNow,
                    _scIsStopLoss ? "stop_loss" : "cancelled",
                  );
                  logger.info(
                    {
                      symbol: tracked.symbol,
                      pnl: pnl.toFixed(1),
                      cvd30m: spotCvdSC.cvd30m,
                      cvd1h: spotCvdSC.cvd1h,
                      queued: delivery.queued,
                    },
                    "FastCycle: SMART CANCEL 5m+30m+1h 🔴",
                  );
                }
                continue;
              }
            } // end else (hadNoCvdAtEntry)
          }
        } catch (scErr) {
          logger.debug(
            { err: scErr, symbol: tracked.symbol },
            "Smart Cancel: ошибка — пропускаем",
          );
        }
      }

      // Для паттернов с BE позже +5 сначала отправляем полноценный progress
      // alert без заявления о переносе стопа. Это относится к BA: +5 и +8
      // информируют о росте, а BE наступает только на собственной цели +10.
      const _buMilestone = getBuStopMilestone(
        tracked.sentimentKey,
        tracked.symbol,
      );
      const lastMilestone = tracked.lastMilestone ?? 0;
      const btcProgressMilestone =
        tracked.status === "active" &&
        isBitcoinTrackedSignal(tracked) &&
        lastMilestone >= _buMilestone
          ? nextBitcoinMilestone(
              tracked.lastMilestone,
              peakPnlNow,
              firstTarget - 1,
            )
          : null;
      if (btcProgressMilestone != null) {
        const delivery = await queueReachedMilestoneAfterClaim(
          tracked,
          btcProgressMilestone,
          currentPrice,
          trailingStop,
          async (tx) => {
            const claimed = await tx
              .update(trackedSignalsTable)
              .set({
                peakPrice: maxPeakPriceSql(newPeak),
                lastMilestone: btcProgressMilestone,
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} = 'active'
                  AND ${trackedSignalsTable.pendingMilestone} IS NULL
                  AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < ${btcProgressMilestone})`,
              )
              .returning({ id: trackedSignalsTable.id });
            return claimed.length > 0;
          },
        );
        if (delivery.claimed) {
          logger.info(
            {
              symbol: tracked.symbol,
              milestone: btcProgressMilestone,
              queued: delivery.queued,
            },
            "FastCycle: BTC 1% MILESTONE 🎯",
          );
        }
        continue;
      }

      if (
        tracked.status === "active" &&
        _buMilestone > 5 &&
        !suppressesPreTargetFivePctNotice(tracked.sentimentKey) &&
        pnl >= 5 &&
        (tracked.lastMilestone ?? 0) < 5
      ) {
        const claimed5 = await dbWriteStrict(
          "trackedSignal/fast-pre-target-5pct",
          () =>
            db
              .update(trackedSignalsTable)
              .set({
                lastMilestone: 5,
                peakPrice: newPeak,
                ...buildPendingMilestoneState(
                  "pre_target",
                  5,
                  currentPrice,
                  trailingStop,
                ),
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id} AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < 5)`,
              )
              .returning({ id: trackedSignalsTable.id }),
        );
        if (claimed5.length > 0) {
          const delivered = await finishMilestoneNotification(
            tracked,
            "pre_target",
            5,
            currentPrice,
            trailingStop,
          );
          logger.info(
            { symbol: tracked.symbol, pnl: pnl.toFixed(2), delivered },
            "FastCycle: PRE-TARGET +5% 🎯",
          );
          if (!delivered) continue;
        }
      }

      // Milestone (5% по умолчанию, 10% для bullish_accumulation):
      // уведомление о частичной фиксации + переносе стопа в БУ (один раз).
      // Отправляем и продолжаем — в том же цикле может сработать FIRST_TARGET.
      if (
        tracked.status === "active" &&
        _buMilestone < firstTarget &&
        pnl >= _buMilestone &&
        (tracked.lastMilestone ?? 0) < _buMilestone
      ) {
        const claimed5 = await dbWriteStrict(
          "trackedSignal/fast-partial-target",
          () =>
            db
              .update(trackedSignalsTable)
              .set({
                lastMilestone: _buMilestone,
                peakPrice: newPeak,
                ...buildPendingMilestoneState(
                  "partial",
                  _buMilestone,
                  currentPrice,
                  trailingStop,
                ),
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.pendingMilestone} IS NULL
                  AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < ${_buMilestone})`,
              )
              .returning({ id: trackedSignalsTable.id }),
        );
        if (claimed5.length > 0) {
          const delivered = await finishMilestoneNotification(
            tracked,
            "partial",
            _buMilestone,
            currentPrice,
            trailingStop,
          );
          logger.info(
            {
              symbol: tracked.symbol,
              pnl: pnl.toFixed(2),
              milestone: _buMilestone,
              delivered,
            },
            `FastCycle: PARTIAL TARGET +${_buMilestone}% 📌`,
          );
          if (isBitcoinTrackedSignal(tracked) || !delivered) continue;
        }
      }

      // Active milestone +8% — промежуточное уведомление между +5% и первой целью
      // Не применяется к whale-паттернам, у которых firstTarget=8 (у них эта точка
      // уже является первой целью и обрабатывается блоком ниже).
      if (
        tracked.status === "active" &&
        firstTarget > 8 &&
        pnl >= 8 &&
        (tracked.lastMilestone ?? 0) < 8
      ) {
        const milestone8Kind = _buMilestone > 8 ? "pre_target" : "intermediate";
        const claimed8 = await dbWriteStrict(
          "trackedSignal/fast-8pct-milestone",
          () =>
            db
              .update(trackedSignalsTable)
              .set({
                lastMilestone: 8,
                peakPrice: newPeak,
                ...buildPendingMilestoneState(
                  milestone8Kind,
                  8,
                  currentPrice,
                  trailingStop,
                ),
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.pendingMilestone} IS NULL
                  AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < 8)`,
              )
              .returning({ id: trackedSignalsTable.id }),
        );
        if (claimed8.length > 0) {
          const delivered = await finishMilestoneNotification(
            tracked,
            milestone8Kind,
            8,
            currentPrice,
            trailingStop,
          );
          logger.info(
            { symbol: tracked.symbol, pnl: pnl.toFixed(2), delivered },
            "FastCycle: MILESTONE +8% 🎯",
          );
          if (!delivered) continue;
        }
      }

      // Active → in_run transition (first target)
      if (tracked.status === "active" && pnl >= firstTarget) {
        if (
          isBitcoinTrackedSignal(tracked) &&
          (tracked.lastMilestone ?? 0) >= firstTarget
        ) {
          // +1% was announced by the older BTC partial-milestone path.
          // No duplicate notification when the exit profile is upgraded.
          await dbWriteStrict("trackedSignal/fast-btc-in-run", () =>
            db
              .update(trackedSignalsTable)
              .set({
                status: "in_run",
                peakPrice: maxPeakPriceSql(newPeak),
                ...(trailingActive
                  ? {
                      trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                      trailingStopArmedAt: trailingStopArmedAtSql(
                        trailingStop,
                        fastPriceObservedAt,
                      ),
                    }
                  : {}),
                updatedAt: fastPriceObservedAt,
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} = 'active'
                  AND ${trackedSignalsTable.pendingMilestone} IS NULL`,
              ),
          );
          continue;
        }
        const firstTargetTransition =
          buildFirstTargetMilestoneTransition(firstTarget);
        const firstTargetKind =
          ageMs / 60000 < 10 && pnl >= 25 ? "late_target" : "first_target";
        const claimedRun = await dbWriteStrict(
          "trackedSignal/fast-to-inRun",
          () =>
            db
              .update(trackedSignalsTable)
              .set({
                status: "in_run",
                peakPrice: newPeak,
                ...(peakPnlNow >= trailingActivation
                  ? {
                      trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                      trailingStopArmedAt: trailingStopArmedAtSql(
                        trailingStop,
                        fastPriceObservedAt,
                      ),
                    }
                  : {}),
                // Первая цель уже отправляется ниже через msgFirstTarget().
                // Фиксируем её и как milestone в той же атомарной записи:
                // иначе следующий fast-cycle видел старое значение (обычно 5%)
                // и повторно отправлял TARGET HIT для +10%.
                lastMilestone: firstTargetTransition.lastMilestone,
                ...buildPendingMilestoneState(
                  firstTargetKind,
                  firstTargetTransition.milestone,
                  currentPrice,
                  trailingStop,
                ),
                updatedAt: new Date(),
              })
              .where(
                sql`${trackedSignalsTable.id} = ${tracked.id}
                  AND ${trackedSignalsTable.status} = 'active'
                  AND ${trackedSignalsTable.pendingMilestone} IS NULL`,
              )
              .returning({ id: trackedSignalsTable.id }),
        );
        if (claimedRun.length === 0) continue; // другой процесс уже сделал переход

        const minutesSinceDetection = ageMs / 60000;
        const isLateSignal = minutesSinceDetection < 10 && pnl >= 25;
        const delivered = await finishMilestoneNotification(
          tracked,
          firstTargetKind,
          firstTargetTransition.milestone,
          currentPrice,
          trailingStop,
        );
        logger.info(
          {
            symbol: tracked.symbol,
            pnl,
            minutesSinceDetection: minutesSinceDetection.toFixed(1),
            delivered,
          },
          isLateSignal
            ? "FastCycle: → IN_RUN (late signal) ⚠️"
            : "FastCycle: → IN_RUN 🚀",
        );
        continue;
      }

      // in_run: trailing stop and milestones
      if (tracked.status === "in_run") {
        // BTC must deliver every earned integer milestone in order before a
        // higher-value trailing transition can advance lastMilestone past it.
        const btcReachedMilestone = isBitcoinTrackedSignal(tracked)
          ? nextBitcoinMilestone(tracked.lastMilestone, peakPnlNow)
          : null;
        if (
          btcReachedMilestone != null &&
          (!trailingJustActivated || btcReachedMilestone < trailingActivation)
        ) {
          const delivery = await queueReachedMilestoneAfterClaim(
            tracked,
            btcReachedMilestone,
            currentPrice,
            trailingStop,
            async (tx) => {
              const claimed = await tx
                .update(trackedSignalsTable)
                .set({
                  peakPrice: maxPeakPriceSql(newPeak),
                  ...(trailingActive
                    ? {
                        trailingStopLevel:
                          maxTrailingStopLevelSql(trailingStop),
                        trailingStopArmedAt: trailingStopArmedAtSql(
                          trailingStop,
                          fastPriceObservedAt,
                        ),
                      }
                    : {}),
                  lastMilestone: btcReachedMilestone,
                  updatedAt: new Date(),
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id}
                    AND ${trackedSignalsTable.status} = 'in_run'
                    AND ${trackedSignalsTable.pendingMilestone} IS NULL
                    AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < ${btcReachedMilestone})`,
                )
                .returning({ id: trackedSignalsTable.id });
              return claimed.length > 0;
            },
          );
          if (delivery.claimed) {
            logger.info(
              {
                symbol: tracked.symbol,
                milestone: btcReachedMilestone,
                queued: delivery.queued,
              },
              "FastCycle: BTC IN_RUN 1% MILESTONE 🎯",
            );
          }
          continue;
        }

        // Трейлинг только что активировался (пик пересёк trailingActivation%)
        if (trailingJustActivated) {
          // ВАЖНО: guard по lastMilestone, а НЕ по trailingStopLevel IS NULL.
          // Ранний peakChanged-апдейт (строка выше) уже выставил trailingStopLevel до
          // того, как мы сюда дошли — IS NULL guard всегда даёт 0 строк → сообщение
          // никогда не отправлялось. Используем lastMilestone как атомарный lock:
          // ставим trailingActivation (15 или 12) — тот же механизм, что у milestone-блока.
          const claimedTrail = await dbWriteStrict(
            "trackedSignal/trailing-activated",
            () =>
              db
                .update(trackedSignalsTable)
                .set({
                  peakPrice: maxPeakPriceSql(newPeak),
                  ...(trailingActive
                    ? {
                        trailingStopLevel:
                          maxTrailingStopLevelSql(trailingStop),
                        trailingStopArmedAt: trailingStopArmedAtSql(
                          trailingStop,
                          fastPriceObservedAt,
                        ),
                      }
                    : {}),
                  lastMilestone: trailingActivation,
                  ...buildPendingMilestoneState(
                    "trailing",
                    trailingActivation,
                    newPeak,
                    trailingStop,
                  ),
                  updatedAt: new Date(),
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id}
            AND ${trackedSignalsTable.status} = 'in_run'
            AND ${trackedSignalsTable.pendingMilestone} IS NULL
            AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < ${trailingActivation})`,
                )
                .returning({ id: trackedSignalsTable.id }),
          );
          if (claimedTrail.length === 0) continue; // другой процесс уже активировал трейлинг
          void recordActualTrailingEvent({
            tracked,
            eventType: "activated",
            observedAt: new Date(),
            peakPrice: newPeak,
            peakPnlPct: peakPnlNow,
            currentPrice,
            trailingStopPrice: trailingStop,
            activationPct: trailingActivation,
            trailingGapPct: exitProfile.trailingGap,
          }).catch(() => null);
          const delivered = await finishMilestoneNotification(
            tracked,
            "trailing",
            trailingActivation,
            newPeak,
            trailingStop,
          );
          logger.info(
            {
              symbol: tracked.symbol,
              pnl: pnl.toFixed(2),
              trailingStop,
              delivered,
            },
            "FastCycle: TRAILING ACTIVATED 🚀",
          );
          continue;
        }

        const reachedMilestone = isBitcoinTrackedSignal(tracked)
          ? null
          : nextMilestone(tracked.lastMilestone, pnl);
        if (reachedMilestone) {
          const delivery = await queueReachedMilestoneAfterClaim(
            tracked,
            reachedMilestone,
            currentPrice,
            trailingStop,
            async (tx) => {
              const claimed = await tx
                .update(trackedSignalsTable)
                .set({
                  peakPrice: maxPeakPriceSql(newPeak),
                  ...(trailingActive
                    ? {
                        trailingStopLevel:
                          maxTrailingStopLevelSql(trailingStop),
                        trailingStopArmedAt: trailingStopArmedAtSql(
                          trailingStop,
                          fastPriceObservedAt,
                        ),
                      }
                    : {}),
                  lastMilestone: reachedMilestone,
                  updatedAt: new Date(),
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${tracked.id}
                    AND ${trackedSignalsTable.status} = 'in_run'
                    AND ${trackedSignalsTable.pendingMilestone} IS NULL
                    AND (${trackedSignalsTable.lastMilestone} IS NULL OR ${trackedSignalsTable.lastMilestone} < ${reachedMilestone})`,
                )
                .returning({ id: trackedSignalsTable.id });
              return claimed.length > 0;
            },
          );
          if (!delivery.claimed) continue; // другой процесс уже отправил этот milestone
          logger.info(
            {
              symbol: tracked.symbol,
              milestone: reachedMilestone,
              queued: delivery.queued,
            },
            "FastCycle: MILESTONE 🎯",
          );
          continue;
        }

        if (peakChanged) {
          await dbWriteBestEffort("trackedSignal/inRun-peak-silent", () =>
            db
              .update(trackedSignalsTable)
              .set({
                peakPrice: maxPeakPriceSql(newPeak),
                ...(trailingActive
                  ? {
                      trailingStopLevel: maxTrailingStopLevelSql(trailingStop),
                      trailingStopArmedAt: trailingStopArmedAtSql(
                        trailingStop,
                        fastPriceObservedAt,
                      ),
                    }
                  : {}),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(trackedSignalsTable.id, tracked.id),
                  eq(trackedSignalsTable.status, "in_run"),
                ),
              ),
          );
        }
      } else if (peakChanged) {
        // Update peak for active signals silently
        await dbWriteBestEffort("trackedSignal/active-peak-silent", () =>
          db
            .update(trackedSignalsTable)
            .set({ peakPrice: newPeak, updatedAt: new Date() })
            .where(
              and(
                eq(trackedSignalsTable.id, tracked.id),
                eq(trackedSignalsTable.status, tracked.status),
              ),
            ),
        );
      }
    } catch (err) {
      logger.error(
        { err, symbol: tracked.symbol },
        "FastCycle: ошибка обработки сигнала (пропускаем)",
      );
    }
  }
}

// ── OI Watch Cycle: checks every 2 min for volume/price confirmation ──────────
export async function runOiWatchCycle(): Promise<void> {
  const now = new Date();

  // Expire stale entries
  await dbWriteBestEffort("oiWatch/stale-expire", () =>
    db
      .update(oiWatchTable)
      .set({ status: "expired" })
      .where(
        and(
          eq(oiWatchTable.status, "watching"),
          lt(oiWatchTable.expiresAt, now),
        ),
      ),
  );

  const watching = await db
    .select()
    .from(oiWatchTable)
    .where(eq(oiWatchTable.status, "watching"));

  if (watching.length === 0) return;

  // Fetch all prices in one call
  let tickers: { symbol: string; lastPrice: string }[] = [];
  try {
    tickers = (await getFutureTickers()) as any[];
  } catch {
    return;
  }

  const priceMap = new Map<string, number>();
  for (const t of tickers) priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);

  for (const w of watching) {
    const currentPrice = priceMap.get(w.symbol);
    if (!currentPrice) continue;

    const priceMovePct =
      ((currentPrice - w.priceAtEntry) / w.priceAtEntry) * 100;

    // Do not fire queued BA watches, including the historical null-pattern
    // fallback. Expire only the watch row; physical signal history is retained.
    const queuedPattern = resolveExplicitOiWatchPattern(
      (w.signalPayload as { alphaResult?: { sentimentKey?: string } } | null)
        ?.alphaResult?.sentimentKey,
      w.sentimentKey,
    );
    if (isPreservedDecommissionedPattern(queuedPattern)) {
      await dbWriteBestEffort("oiWatch/retired-ba", () =>
        db
          .update(oiWatchTable)
          .set({ status: "expired", volStatusReason: "pattern_decommissioned" })
          .where(
            and(eq(oiWatchTable.id, w.id), eq(oiWatchTable.status, "watching")),
          ),
      );
      continue;
    }

    // ── Fill missing OI columns ───────────────────────────────────────────────
    // Записи созданные через prescan-path (isVolConfirmed=true) не содержат OI полей.
    // CoinGlass кэш TTL 5 мин — если сканер уже запрашивал этот символ, вызов мгновенный.
    if (w.oi30mChange === null) {
      // oi5mChange removed, use oi30mChange as proxy
      try {
        const cg = await getCoinglassOI(w.symbol, currentPrice);
        if (cg?.available) {
          await dbWriteBestEffort("oiWatch/fill-missing-oi", () =>
            db
              .update(oiWatchTable)
              .set({
                oi30mChange: cg.oiChange30m ?? null,
                oi1hChange: cg.oiChange1h ?? null,
                oi24hChange: cg.oiChange24h ?? null,
              })
              .where(eq(oiWatchTable.id, w.id)),
          );
        }
      } catch {
        /* non-critical */
      }
    }

    // ── PATH A: Confirmed signal (vol was already ≥ 2x at scanner time) ────────
    // Full payload stored — re-confirm price didn't collapse, then fire full signal.
    if (w.isVolConfirmed && w.signalPayload) {
      const pathAPayload = w.signalPayload as {
        alphaResult: any;
        signalRow: any;
      };
      const pathASentimentKey: string =
        pathAPayload.alphaResult?.sentimentKey ?? "";
      const pathAPrice24h =
        getPrescanEntry(w.symbol)?.lastPrice24h ??
        pathAPayload.alphaResult?.price24hChange ??
        w.price24hChange;
      const pathAPrescan = getPrescanEntry(w.symbol);
      const pathACgOi =
        pathASentimentKey === "bullish_accumulation"
          ? await getCoinglassOI(w.symbol, currentPrice).catch(() => null)
          : null;
      const pathABaDecision = getBullishAccumulationOiWatchFireDecision(
        "path_a",
        pathASentimentKey,
        pathAPrice24h,
        {
          oi30m:
            pathACgOi?.oiChange30m ?? pathAPrescan?.lastOi30m ?? w.oi30mChange,
          oi1h: pathACgOi?.oiChange1h ?? pathAPrescan?.lastOi1h ?? w.oi1hChange,
          oi4h: pathACgOi?.oiChange4h ?? pathAPrescan?.lastOi4h ?? null,
        },
      );

      // Re-check the scanner's canonical BA p24h + OI-route contract because a
      // queued OI Watch entry can fire minutes later with changed market data.
      // Expiring the row before any DB signal insert keeps both worker processes
      // from creating a bypass signal during a rolling deploy.
      if (!pathABaDecision.allowed) {
        if (pathABaDecision.defer) {
          logger.info(
            {
              symbol: w.symbol,
              reason: pathABaDecision.reason,
            },
            "OI Watch PATH A: BA route data incomplete — keeping signal in watching",
          );
          continue;
        }
        await dbWriteBestEffort("oiWatch/pathA-ba-p24h-gate", () =>
          db
            .update(oiWatchTable)
            .set({
              status: "expired",
              volStatusReason: pathABaDecision.reason,
            })
            .where(
              and(
                eq(oiWatchTable.id, w.id),
                eq(oiWatchTable.status, "watching"),
              ),
            ),
        );
        logger.info(
          {
            symbol: w.symbol,
            price24h: pathAPrice24h ?? "missing",
            oi30m:
              pathACgOi?.oiChange30m ??
              pathAPrescan?.lastOi30m ??
              w.oi30mChange,
            oi1h:
              pathACgOi?.oiChange1h ?? pathAPrescan?.lastOi1h ?? w.oi1hChange,
            oi4h: pathACgOi?.oiChange4h ?? pathAPrescan?.lastOi4h ?? null,
            reason: pathABaDecision.reason,
          },
          "OI Watch PATH A: BA canonical entry contract failed — signal expired",
        );
        continue;
      }

      // ── UNIFIED PRICE CONFIRMATION GATE ──────────────────────────────────────
      // Сигнал публикуется ТОЛЬКО если цена уже реально двинулась с момента обнаружения.
      // Статистика: 0 прибыльных сделок из 98 сигналов где итоговый пик < 3%.
      // Окно мониторинга 90 мин — либо цена подтверждает движение, либо сигнал тихо истекает.
      const minPriceMove =
        pathASentimentKey === "bullish_accumulation"
          ? getBullishAccumulationOiWatchMinPriceMove(pathABaDecision.oiPath)
          : 2.0;

      // Если цена ещё не дошла до порога — ждём следующего цикла (не удаляем запись)
      if (priceMovePct < minPriceMove) {
        logger.debug(
          {
            symbol: w.symbol,
            pattern: pathASentimentKey,
            priceMovePct: priceMovePct.toFixed(1),
            required: minPriceMove,
          },
          `OI Watch: ждём подтверждения цены — нужно +${minPriceMove}%, сейчас ${priceMovePct.toFixed(1)}%`,
        );
        continue;
      }

      // Hard dump cancel: если цена упала > 5% с начала watch — монета не туда идёт
      if (priceMovePct < -5) {
        await dbWriteBestEffort("oiWatch/pathA-hard-dump-cancel", () =>
          db
            .update(oiWatchTable)
            .set({ status: "expired" })
            .where(eq(oiWatchTable.id, w.id)),
        );
        logger.info(
          { symbol: w.symbol, priceMovePct: priceMovePct.toFixed(1) },
          "OI Watch: отменён (дамп > 5% с начала watch)",
        );
        continue;
      }

      // CVD финальная проверка: если продажи доминируют в момент выстрела — откладываем
      // Не expire (постоянная потеря) — CVD может кратковременно уходить в минус прямо
      // перед пампом (ликвидации лонгов → разворот). Ждём следующего цикла.
      const cvd = await fetchCVD(w.symbol);
      if (cvd && !cvd.positive) {
        logger.info(
          {
            symbol: w.symbol,
            buyPct: cvd.buyPct.toFixed(1) + "%",
            sellPct: cvd.sellPct.toFixed(1) + "%",
          },
          "🔴 OI Watch PATH A: CVD негативный — откладываем до следующего цикла",
        );
        continue;
      }
      if (cvd) {
        logger.info(
          {
            symbol: w.symbol,
            buyPct: cvd.buyPct.toFixed(1) + "%",
            sellPct: cvd.sellPct.toFixed(1) + "%",
          },
          "🟢 OI Watch PATH A: CVD подтверждён — стреляем",
        );
      }

      try {
        const payload = w.signalPayload as {
          alphaResult: any;
          signalRow: InsertSignal;
        };
        const alphaResult = payload.alphaResult;
        const signalRow = payload.signalRow;

        // ── Spot volume gate (OI Watch PATH A) ──────────────────────────────────
        // Проверяем спот-объём перед выстрелом — токены без реального спот-рынка
        // не должны попадать к подписчикам даже если OI/объём на фьючах аномальные.
        let paSpotVol24h: number | null = null;
        let paMcapUsdA: number | null = null;
        {
          const [paFsVol, paMcapRaw] = await Promise.all([
            getFsVolume(w.symbol).catch(() => null),
            fetchMarketCap(w.symbol).catch(() => null),
          ]);
          const paSpotVol = paFsVol?.spotVolUsd24h ?? null;
          paMcapUsdA = paMcapRaw?.mcap ?? null;
          if (paSpotVol === null) {
            // Fallback 1: getSpotVolume (pairs-markets, ВСЕ биржи — шире чем Binance/OKX/Bybit)
            // getFsVolume возвращает null для токенов без спота на Binance/OKX/Bybit (напр. BingX-exclusive).
            // pairs-markets покрывает Gate.io, KuCoin и др. — даёт реальный спот-объём.
            const svFb = await getSpotVolume(w.symbol).catch(() => null);
            const svFbVol =
              (svFb?.volumeUsd24h ?? 0) > 0 ? svFb!.volumeUsd24h! : null;
            if (svFbVol !== null) {
              paSpotVol24h = svFbVol;
              paMcapUsdA = paMcapRaw?.mcap ?? null;
              logger.info(
                { symbol: w.symbol, spotVol24h: svFbVol },
                "OI Watch PATH A: getFsVolume→null, getSpotVolume (pairs-markets) fallback",
              );
            } else {
              // Fallback 2: SpotPool кэш (обновляется каждые 30 мин, тоже через getFsVolume)
              const poolFallback = getSpotPoolEntry(w.symbol);
              paSpotVol24h = poolFallback?.spotVol24h ?? null;
              paMcapUsdA = paMcapRaw?.mcap ?? poolFallback?.mcapUsd ?? null;
              logger.warn(
                { symbol: w.symbol, spotPoolFallback: paSpotVol24h !== null },
                "OI Watch PATH A: CoinGlass spot недоступен — degraded mode, spot gate пропущен",
              );
            }
          } else {
            paSpotVol24h = paSpotVol;
            if (paMcapUsdA === null || paSpotVol < paMcapUsdA * 0.01) {
              await dbWriteBestEffort("oiWatch/pathA-spot-gate-cancel", () =>
                db
                  .update(oiWatchTable)
                  .set({ status: "expired" })
                  .where(eq(oiWatchTable.id, w.id)),
              );
              const pct = paMcapUsdA
                ? ((paSpotVol / paMcapUsdA) * 100).toFixed(3)
                : "нет MCap";
              logger.info(
                { symbol: w.symbol, paSpotVol, paMcapUsdA, pct },
                "OI Watch PATH A: спот-объём < 1% MCap — сигнал отменён",
              );
              continue;
            }
          }
        }

        {
          const _aggMissing = await missingAggregatedFireData(w.symbol);
          if (_aggMissing.length > 0) {
            logger.info(
              { symbol: w.symbol, missing: _aggMissing },
              "OI Watch PATH A: агрегированные данные недоступны — сигнал не выдан",
            );
            continue;
          }
        }
        // Атомарно захватываем запись ПЕРВЫМ — гарантирует что только один PID
        // вставит сигнал в БД и отправит Telegram (при параллельном деплое).
        // Раньше: insert → trackSignal → claim → broadcast (оба PID вставляли в signals до claim).
        // Теперь: claim → insert → trackSignal → broadcast (только победивший PID пишет в БД).
        const claimedA = await dbWriteStrict("oiWatch/pathA-fire-claim", () =>
          db
            .update(oiWatchTable)
            .set({ status: "fired", firedAt: new Date() })
            .where(
              and(
                eq(oiWatchTable.id, w.id),
                eq(oiWatchTable.status, "watching"),
              ),
            )
            .returning({ id: oiWatchTable.id }),
        );
        if (claimedA.length === 0) continue; // другой PID уже обработал — пропускаем
        // Supersede: гасим другие активные watching/confirming записи того же символа
        const _supersededA =
          (await dbWriteBestEffort("oiWatch/supersede-A", () =>
            db
              .update(oiWatchTable)
              .set({ status: "expired", volStatusReason: "superseded" })
              .where(
                and(
                  eq(oiWatchTable.symbol, w.symbol),
                  inArray(oiWatchTable.status, ["watching", "confirming"]),
                ),
              )
              .returning({
                id: oiWatchTable.id,
                oi30m: oiWatchTable.oi30mChange,
                oi1h: oiWatchTable.oi1hChange,
                oi24h: oiWatchTable.oi24hChange,
                volMult: oiWatchTable.volumeMultiplier,
              }),
          )) ??
          ([] as {
            id: number;
            oi30m: number | null;
            oi1h: number | null;
            oi24h: number | null;
            volMult: number;
          }[]);

        // Insert signal to DB — с broadcast_window_key для дедупликации по символу в 30-мин окне.
        // ON CONFLICT DO NOTHING гарантирует: только один сигнал для монеты попадёт в БД за 30 минут,
        // даже если scanner + watcher или два PID гонятся одновременно.
        const _bwKeyA = `${w.symbol}:${Math.floor(Date.now() / (30 * 60 * 1000))}`;
        const pathAPlmOi30mSnapshot = await capturePlmOi30mShadowAtFire({
          sentimentKey: pathASentimentKey,
          loadFresh: async () =>
            (
              await getCoinglassOI(
                w.symbol,
                currentPrice,
                undefined,
                PLM_OI30M_FIRE_FETCH_OPTIONS,
              )
            ).oiChange30m,
        });
        const _rowsA = await dbWriteStrict("signals/oiWatch-pathA-insert", () =>
          db
            .insert(signalsTable)
            .values({
              ...signalRow,
              price: currentPrice, // обновляем до текущей рыночной цены
              // OI Watch may hold a candidate for hours. Override the queued
              // candidate snapshot with OI30m observed at the actual fire.
              plmOi30mShadow: pathAPlmOi30mSnapshot.shadow,
              broadcastWindowKey: _bwKeyA,
              telegramAlertQueued: false,
              altBulletSnapshotRequestedAt: new Date(),
              detectedAt: new Date(),
            })
            .onConflictDoNothing()
            .returning(),
        );
        if (_rowsA.length === 0) {
          logger.info(
            { symbol: w.symbol, windowKey: _bwKeyA },
            "PATH A: broadcast window conflict — duplicate suppressed (DB-level dedup)",
          );
          continue;
        }
        const inserted = _rowsA[0]!;

        // Start tracking (stop-loss / targets) — проверяем успех
        const tracked = await trackSignal({
          symbol: w.symbol,
          signalId: inserted.id,
          signalType: alphaResult.grade ?? "alpha",
          sentiment: alphaResult.sentiment,
          sentimentKey: alphaResult.sentimentKey,
          alphaScore: alphaResult.alphaScore,
          entrySource:
            alphaResult.sentimentKey === "bullish_accumulation"
              ? getBullishAccumulationOiWatchEntrySource(
                  "path_a",
                  pathABaDecision.oiPath!,
                )
              : "oi_watch/path_a",
          entryPrice: currentPrice,
          entryOi:
            alphaResult.openInterest > 0 ? alphaResult.openInterest : null,
          entryCvd15m: inserted.entryCvd15m ?? null,
          entryCvd30m: inserted.entryCvd30m ?? null,
          entryCvd1h: inserted.entryCvd1h ?? null,
          entryCvd4h: inserted.entryCvd4h ?? null,
          entryPrice3h: inserted.entryPrice3h,
          entryPrice3hProvenance: inserted.entryPrice3hProvenance,
          plmOi30mShadow: inserted.plmOi30mShadow,
          marketCapUsd: paMcapUsdA ?? null,
          entrySpotVol24h: paSpotVol24h ?? null,
          entrySpotMcapPct:
            paSpotVol24h !== null && paMcapUsdA
              ? (paSpotVol24h / paMcapUsdA) * 100
              : null,
        });
        if (tracked === false) {
          logger.error(
            { symbol: w.symbol },
            "PATH A: trackSignal упал — broadcast отменён (слежка не создана)",
          );
          await discardUntrackedSignal(inserted.id, "oi_watch_path_a_failed");
          continue;
        }
        if (tracked === "skip") {
          // Монета уже активна — НЕ дублируем алерт (то же поведение что в scanner и LiqCascade).
          // Раньше здесь был broadcast "всё равно отправляем" — это была причина дублей.
          logger.info(
            { symbol: w.symbol },
            "PATH A: монета уже в трекере — broadcast отменён (duplicate guard)",
          );
          await discardUntrackedSignal(inserted.id, "oi_watch_path_a_skip");
          continue;
        }
        resetPrescanCycleCount(w.symbol);

        // Send full Telegram alert — включаем priceConfirmPct: насколько цена уже прошла
        await broadcastBatchAlert(
          [
            {
              ...alphaResult,
              price: currentPrice,
              priceConfirmPct: priceMovePct,
              spotVol24h: paSpotVol24h,
              marketCapUsd: paMcapUsdA,
              _oiWatchPath: "A",
              entryOb: consumeObAtFire(w.symbol),
              signalId: inserted.id,
            },
          ],
          { eventKey: `signal:${inserted.id}` },
        );
        scheduleAltBulletIndicatorSnapshot({
          signalId: inserted.id,
          symbol: w.symbol,
          sentimentKey: alphaResult.sentimentKey,
        });
        await dbWriteStrict("signals/alert-queued", () =>
          db
            .update(signalsTable)
            .set({ telegramAlertQueued: true })
            .where(eq(signalsTable.id, inserted.id)),
        );

        logger.info(
          {
            symbol: w.symbol,
            grade: alphaResult.grade,
            alphaScore: alphaResult.alphaScore,
            priceMovePct: priceMovePct.toFixed(1),
          },
          "✅ OI Watch → ПОЛНЫЙ СИГНАЛ: подтверждён и отправлен",
        );
      } catch (err) {
        logger.error(
          { err, symbol: w.symbol },
          "OI Watch: ошибка при firing confirmed signal",
        );
      }
      continue; // не падаем в PATH B
    }

    // ── PATH B: Unconfirmed watch (vol was < 2x at scanner time) ────────────────
    // Waiting for volume spike or price breakout to fire a lightweight alert.
    if (priceMovePct < -8) {
      await dbWriteBestEffort("oiWatch/pathB-price-dump-cancel", () =>
        db
          .update(oiWatchTable)
          .set({ status: "expired" })
          .where(eq(oiWatchTable.id, w.id)),
      );
      logger.info(
        { symbol: w.symbol, priceMovePct: priceMovePct.toFixed(1) },
        "OI Watch: expired (price dumped)",
      );
      continue;
    }

    // Если цена уже улетела >20% от точки входа в watch — памп уже случился.
    // Входить сейчас = покупать на хае. BLEND: +61% от точки входа → не стреляем.
    if (priceMovePct >= 20) {
      // Атомарно захватываем запись (AND status='watching') — гарантирует что только один
      // процесс отправит уведомление при параллельном запуске двух инстансов во время деплоя.
      const claimed = await dbWriteBestEffort("oiWatch/pathB-pump-expire", () =>
        db
          .update(oiWatchTable)
          .set({ status: "expired" })
          .where(
            and(eq(oiWatchTable.id, w.id), eq(oiWatchTable.status, "watching")),
          )
          .returning({ id: oiWatchTable.id }),
      );
      if (!claimed || claimed.length === 0) continue; // другой процесс обработал или DB недоступен
      logger.info(
        { symbol: w.symbol, priceMovePct: priceMovePct.toFixed(1) },
        "OI Watch PATH B: expired — памп уже случился (price >= 20% от входа в watch)",
      );
      continue;
    }

    try {
      // Same 20-candle aggregated baseline as the main scanner. BingX klines
      // provide only candle times and price; volume comes from CoinGlass.
      const klines = await getKlines(w.symbol, "30m", 21);
      if (klines.length < 21) continue;

      const cur = klines[klines.length - 1];
      const hist = klines.slice(0, -1);
      const close = parseFloat(cur.close) || 0;
      const _oiSeries = await getAggregatedFuturesVolumeSeries30m(
        w.symbol,
      ).catch(() => null);
      const curVol = _oiSeries?.get(cur.time) ?? 0;
      const _oiHistVols = hist.map((k) => _oiSeries?.get(k.time) ?? null);
      // Stored w.avgVolume may be a pre-aggregation BingX value; never mix it
      // with the aggregated current candle.
      const avgVol = _oiHistVols.every((v): v is number => v !== null)
        ? _oiHistVols.reduce((s, v) => s + v, 0) / _oiHistVols.length
        : 0;
      if (!avgVol) continue;

      const volMult = curVol / avgVol;
      const _currentPriceMove =
        ((close - parseFloat(cur.open)) / parseFloat(cur.open)) * 100;

      // Записываем текущий volMult в БД — фронтенд отображает прогресс к порогу.
      await dbWriteBestEffort("oiWatch/pathB-volMult-update", () =>
        db
          .update(oiWatchTable)
          .set({ currentVolMult: volMult })
          .where(eq(oiWatchTable.id, w.id)),
      );

      // Подтверждение объёма — только CoinGlass агрег. turnover >= 10%.
      // BingX volMult не используется: одна биржа не показатель глобальной активности.
      // Если CoinGlass недоступен — токен остаётся в watching до экспайра.
      let volConfirmed = false; // определяется CoinGlass turnover ниже

      // Если OI отрицательный — накопления нет, это распродажа. Не стреляем.
      if (w.oiChange < 0) {
        await dbWriteBestEffort("oiWatch/pathB-oi-negative-cancel", () =>
          db
            .update(oiWatchTable)
            .set({ status: "expired" })
            .where(eq(oiWatchTable.id, w.id)),
        );
        logger.debug(
          { symbol: w.symbol, oiChange: w.oiChange },
          "OI Watch PATH B: OI отрицательный — сигнал отменён",
        );
        continue;
      }

      // OI cap 20%: если OI при добавлении в watch уже был > 20% — это перегретый лонг/ловушка.
      // Данные: OI 25%+ = 0% win rate. AXL(90%), PIPPIN(56%), MOODENG(23%) — все SL.
      // Было 10% — слишком жёстко: PLAYSOUT (11.33%) попал под фильтр и пропустил памп +20%.
      // Поднято до 20% — совпадает с реальными проблемными случаями (23%+).
      // Исключение: oi24h_accum (Layer 8) — там oiChange это OI ЗА 24Ч у лидеров накопления,
      // это норма 25-100%+ по определению триггера, а не признак перегрева короткого спайка.
      // Защита от реального перегрева для этой ветки уже есть на этапе seeding (scanner.ts
      // Layer 8: price24h должен быть -5%..+35%) — колпак по OI здесь не нужен.
      if (w.triggerTf !== "oi24h_accum" && w.oiChange > 20) {
        await dbWriteBestEffort("oiWatch/pathB-oi-cap-cancel", () =>
          db
            .update(oiWatchTable)
            .set({ status: "expired" })
            .where(eq(oiWatchTable.id, w.id)),
        );
        logger.info(
          { symbol: w.symbol, oiChange: w.oiChange.toFixed(1) + "%" },
          "OI Watch PATH B: OI > 20% — ловушка перегретого лонга, отменяем",
        );
        continue;
      }

      // Если цена уже упала >4% с момента входа в watch — движение идёт против нас.
      // Это либо распродажа, либо OI-рост был за счёт шортов. Отменяем.
      if (priceMovePct < -4.0) {
        await dbWriteBestEffort("oiWatch/pathB-price-drop-cancel", () =>
          db
            .update(oiWatchTable)
            .set({ status: "expired" })
            .where(eq(oiWatchTable.id, w.id)),
        );
        logger.debug(
          { symbol: w.symbol, priceMovePct: priceMovePct.toFixed(1) },
          "OI Watch PATH B: цена упала >4% от входа — сигнал отменён",
        );
        continue;
      }

      // ── ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА: Cross OI должен быть положительным при срабатывании ──
      // Подтягиваем свежие данные CoinGlass — 30m OI отражает текущий импульс.
      // Если он стал отрицательным — накопление завершилось / шорты уже закрыты. Отменяем.
      let cgOI: Awaited<ReturnType<typeof getCoinglassOI>> | null = null;
      try {
        cgOI = await getCoinglassOI(w.symbol, priceMap.get(w.symbol));
      } catch {
        /* non-critical */
      }

      // ── Подтверждение объёма: два обязательных условия ─────────────────────────
      // 1. CoinGlass агрег. turnover >= 15% (vol/OI по всем биржам) — глобальная активность.
      //    Fallback: BingX volMult >= 1.5x если turnover недоступен или ниже порога.
      //    Данные: 0.5-0.68x = шум, MEGA/ZKP прошли с 0.52-0.68x → SL/cancel.
      // 2. Спотовый CVD положительный: cvd30m ИЛИ cvd1h — покупки реальные, не шорт-сквиз.
      // Оба условия должны выполняться одновременно.
      // Если любой источник недоступен — volConfirmed = false, токен остаётся в watching.

      // ── OI межцикловый контроль: early expire если OI падает 2 цикла подряд ──────
      // oiChange30m из свежего CoinGlass запроса; lastOiCheck/prevOiCheck накапливаются в DB.
      const freshOi30m = cgOI?.available ? (cgOI.oiChange30m ?? null) : null;
      if (
        freshOi30m !== null &&
        w.lastOiCheck !== null &&
        w.prevOiCheck !== null &&
        w.prevOiCheck2 !== null
      ) {
        const decline1 = w.prevOiCheck < w.prevOiCheck2;
        const decline2 = w.lastOiCheck < w.prevOiCheck;
        const decline3 = freshOi30m < w.lastOiCheck;
        if (decline1 && decline2 && decline3) {
          await dbWriteBestEffort("oiWatch/pathB-oi-3cycle-decline", () =>
            db
              .update(oiWatchTable)
              .set({ status: "expired" })
              .where(eq(oiWatchTable.id, w.id)),
          );
          logger.info(
            {
              symbol: w.symbol,
              prevOiCheck2: w.prevOiCheck2.toFixed(2),
              prevOiCheck: w.prevOiCheck.toFixed(2),
              lastOiCheck: w.lastOiCheck.toFixed(2),
              freshOi30m: freshOi30m.toFixed(2),
            },
            "OI Watch PATH B: OI падает 3 цикла подряд — early expire",
          );
          continue;
        }
      }
      // Обновляем OI tracking для следующего цикла (non-critical)
      if (freshOi30m !== null) {
        await dbWriteBestEffort("oiWatch/pathB-oi-tracking", () =>
          db
            .update(oiWatchTable)
            .set({
              prevOiCheck2: w.prevOiCheck,
              prevOiCheck: w.lastOiCheck,
              lastOiCheck: freshOi30m,
            })
            .where(eq(oiWatchTable.id, w.id)),
        );
      }

      const cgVolUsd = cgOI?.cgVolUsd ?? null;
      const cgOiUsd = cgOI?.oiUsd ?? null;
      const cgTurnover =
        cgVolUsd && cgOiUsd && cgOiUsd > 0 ? cgVolUsd / cgOiUsd : null;
      // Третий путь: объём вырос на 80%+ с момента входа в watch (межцикловая дельта)
      const entryVolMult_w = w.entryVolMult ?? null;
      const volAccelWatch =
        entryVolMult_w && entryVolMult_w > 0 ? volMult / entryVolMult_w : null;
      // Спот объём: норм. мультипликатор из prescanTracker (lastSpotVol1h / spotVolAvg1h)
      const _peW = getPrescanEntry(w.symbol);
      const spotVolMult =
        _peW?.spotVolAvg1h && _peW?.lastSpotVol1h
          ? _peW.lastSpotVol1h / _peW.spotVolAvg1h
          : null;
      const turnoverOk =
        (cgTurnover !== null && cgTurnover >= 0.15) ||
        (spotVolMult !== null && spotVolMult >= 1.5) ||
        (volAccelWatch !== null && volAccelWatch >= 1.8);

      const spotCvdB = await getSpotCvdMtf(w.symbol).catch(() => null);
      const cvdOk =
        spotCvdB?.available === true &&
        (spotCvdB.cvd30m === true || spotCvdB.cvd1h === true);

      volConfirmed = turnoverOk && cvdOk;

      const volStatusReason: string = !turnoverOk
        ? "no_turnover"
        : spotCvdB === null
          ? "cvd_unavail"
          : !cvdOk
            ? "cvd_negative"
            : "confirmed";

      await dbWriteBestEffort("oiWatch/pathB-volStatus", () =>
        db
          .update(oiWatchTable)
          .set({ volStatusReason })
          .where(
            and(eq(oiWatchTable.id, w.id), eq(oiWatchTable.status, "watching")),
          ),
      );

      logger.info(
        {
          symbol: w.symbol,
          turnover: cgTurnover?.toFixed(3) ?? "n/a",
          turnoverOk,
          cvd30m: spotCvdB?.cvd30m ?? "n/a",
          cvd1h: spotCvdB?.cvd1h ?? "n/a",
          cvdOk,
          volStatusReason,
        },
        "OI Watch PATH B: проверка объёма",
      );

      // OI30m временно может уйти в минус при ротации лонгов; expire только если
      // отрицательны оба ТФ (30m И 1h) — устойчивое снижение, а не шум.
      if (
        cgOI?.available &&
        cgOI.oiChange30m !== null &&
        cgOI.oiChange30m < 0 &&
        cgOI.oiChange1h !== null &&
        cgOI.oiChange1h < 0
      ) {
        await dbWriteBestEffort("oiWatch/pathB-crossOI-cancel", () =>
          db
            .update(oiWatchTable)
            .set({ status: "expired" })
            .where(eq(oiWatchTable.id, w.id)),
        );
        logger.info(
          {
            symbol: w.symbol,
            crossOi30m: cgOI.oiChange30m.toFixed(1) + "%",
            crossOi1h: cgOI.oiChange1h.toFixed(1) + "%",
          },
          "OI Watch PATH B: Cross OI отрицательный на 30m+1h — сигнал отменён",
        );
        continue;
      }

      // ── ФИЛЬТР: для накопления требуем подтверждение ценой ──────────────────────
      // PATH B стреляет когда объём подтвердился. Но для аккумуляционных паттернов
      // нужно чтобы цена ТОЖЕ начала двигаться (>= 2%). Иначе накопление без выстрела.
      // null payload = добавлен из low-vol пути (OI есть, объём не пришёл) = всегда накопление.
      // Токены без движения цены (RARE +0.9%, WAVES +0.76%) остаются в watching до 2h экспайра.
      const pathBSentimentKey =
        (w.signalPayload as any)?.alphaResult?.sentimentKey ??
        w.sentimentKey ??
        null;
      // Legacy low-volume rows have no pattern key, but their fire path has
      // always created a BA tracked signal. Preserve that behavior while
      // applying the BA p24h ceiling to the effective result.
      const isBullishAccumulationPathB =
        pathBSentimentKey === "bullish_accumulation" ||
        pathBSentimentKey === null;
      const pathBTrackedSentimentKey =
        pathBSentimentKey ?? "bullish_accumulation";
      if (isPreservedDecommissionedPattern(pathBTrackedSentimentKey)) {
        await dbWriteBestEffort("oiWatch/pathB-retired-ba", () =>
          db
            .update(oiWatchTable)
            .set({
              status: "expired",
              volStatusReason: "pattern_decommissioned",
            })
            .where(
              and(
                eq(oiWatchTable.id, w.id),
                eq(oiWatchTable.status, "watching"),
              ),
            ),
        );
        continue;
      }
      const pathBPrice24h =
        getPrescanEntry(w.symbol)?.lastPrice24h ?? w.price24hChange;
      const pathBPrescan = getPrescanEntry(w.symbol);
      const pathBBaDecision = getBullishAccumulationOiWatchFireDecision(
        "path_b",
        pathBSentimentKey,
        pathBPrice24h,
        {
          oi30m: cgOI?.oiChange30m ?? pathBPrescan?.lastOi30m ?? w.oi30mChange,
          oi1h: cgOI?.oiChange1h ?? pathBPrescan?.lastOi1h ?? w.oi1hChange,
          oi4h: cgOI?.oiChange4h ?? pathBPrescan?.lastOi4h ?? null,
        },
      );

      // PATH B builds its tracked signal directly. Apply the same canonical BA
      // p24h + OI-route contract before any claim/insert can happen.
      if (!pathBBaDecision.allowed) {
        if (pathBBaDecision.defer) {
          logger.info(
            {
              symbol: w.symbol,
              reason: pathBBaDecision.reason,
            },
            "OI Watch PATH B: BA route data incomplete — keeping signal in watching",
          );
          continue;
        }
        await dbWriteBestEffort("oiWatch/pathB-ba-p24h-gate", () =>
          db
            .update(oiWatchTable)
            .set({
              status: "expired",
              volStatusReason: pathBBaDecision.reason,
            })
            .where(
              and(
                eq(oiWatchTable.id, w.id),
                eq(oiWatchTable.status, "watching"),
              ),
            ),
        );
        logger.info(
          {
            symbol: w.symbol,
            price24h: pathBPrice24h ?? "missing",
            oi30m:
              cgOI?.oiChange30m ?? pathBPrescan?.lastOi30m ?? w.oi30mChange,
            oi1h: cgOI?.oiChange1h ?? pathBPrescan?.lastOi1h ?? w.oi1hChange,
            oi4h: cgOI?.oiChange4h ?? pathBPrescan?.lastOi4h ?? null,
            reason: pathBBaDecision.reason,
          },
          "OI Watch PATH B: BA canonical entry contract failed — signal expired",
        );
        continue;
      }
      // Аномалия добавлена в список "требует подтверждения ценой" (наравне с накоплением).
      // Данные: anomaly win rate 13%, 9 SL из 15. Без OI-поддержки это просто спайк объёма — шум.
      // Требуем price >= 2% перед выстрелом — хотя бы минимальное подтверждение движения.
      const isAccumPatternB = isBullishAccumulationPathB;
      const minPriceMoveB = isAccumPatternB
        ? getBullishAccumulationOiWatchMinPriceMove(pathBBaDecision.oiPath)
        : 2.0;

      if (isAccumPatternB && priceMovePct < minPriceMoveB) {
        logger.debug(
          {
            symbol: w.symbol,
            priceMovePct: priceMovePct.toFixed(1),
            sentimentKey: pathBSentimentKey,
          },
          `OI Watch PATH B: накопление — ждём движения цены >= ${minPriceMoveB}% (держим в watching)`,
        );
        continue; // Остаётся в watching, не меняем статус — ждём пока цена тронется
      }

      // ── TF-фильтр для накопительных паттернов ────────────────────────────────────
      // Одиночный "30m" или "1h" недостаточен — это может быть разовый спайк.
      // Требуем подтверждение минимум двумя ТФ: "all+30m", "all+1h", "1h+4h".
      // Данные: MEGA #2 прошёл с триггером "30m only" → cancel -9.2%.
      const ACCUM_VALID_TF = ["all+30m", "all+1h", "1h+4h"];
      // TF-фильтр применяем ТОЛЬКО когда sentimentKey известен (паттерн уже определён).
      // Fallback-записи (cg_timeout/cg_building/dark_flow/tSteady) имеют sentimentKey=null —
      // они попали в OI Watch не как "single-TF спайк", а из-за недоступности CG или
      // медленного накопления. Для них multi-TF требование семантически неприменимо.
      if (
        isAccumPatternB &&
        pathBSentimentKey !== null &&
        !ACCUM_VALID_TF.includes(w.triggerTf)
      ) {
        logger.info(
          {
            symbol: w.symbol,
            triggerTf: w.triggerTf,
            validTf: ACCUM_VALID_TF,
            sentimentKey: pathBSentimentKey,
          },
          "OI Watch PATH B: накоп. паттерн — triggerTf не прошёл multi-TF фильтр, держим в watching",
        );
        continue;
      }

      // Canonical BA route evaluation above owns the OI thresholds. CoinGlass
      // remains required for PATH B fire so an outage retains instead of emits.
      if (isAccumPatternB) {
        if (!cgOI?.available) {
          logger.info(
            { symbol: w.symbol, sentimentKey: pathBSentimentKey },
            "OI Watch PATH B: накоп. паттерн — CoinGlass недоступен, держим в watching",
          );
          continue;
        }
      }

      let pbSpotVol24h: number | null = null;
      let pbMcapUsdB: number | null = null;
      if (volConfirmed) {
        // ── Spot volume gate (PATH B) ────────────────────────────────────────────
        {
          const [pbFsVol, pbMcapRaw] = await Promise.all([
            getFsVolume(w.symbol).catch(() => null),
            fetchMarketCap(w.symbol).catch(() => null),
          ]);
          const pbSpotVol = pbFsVol?.spotVolUsd24h ?? null;
          const pbMcapUsd = pbMcapRaw?.mcap ?? null;
          pbSpotVol24h = pbSpotVol;
          pbMcapUsdB = pbMcapUsd;
          if (pbSpotVol === null) {
            // CoinGlass временно недоступен — не отменяем сигнал, пропускаем spot gate
            logger.warn(
              { symbol: w.symbol },
              "OI Watch PATH B: CoinGlass spot недоступен — degraded mode, spot gate пропущен",
            );
          } else if (pbMcapUsd === null || pbSpotVol < pbMcapUsd * 0.01) {
            await dbWriteBestEffort("oiWatch/pathB-spot-gate-cancel", () =>
              db
                .update(oiWatchTable)
                .set({ status: "expired" })
                .where(eq(oiWatchTable.id, w.id)),
            );
            const pct = pbMcapUsd
              ? ((pbSpotVol / pbMcapUsd) * 100).toFixed(3)
              : "нет MCap";
            logger.info(
              { symbol: w.symbol, pbSpotVol, pbMcapUsd, pct },
              "OI Watch PATH B: спот-объём < 1% MCap — сигнал отменён",
            );
            continue;
          }
        }

        // Alpha score больше не является блокирующим гейтом — только информационное поле.

        // ── накоп. паттерн spot CVD gate (fallback / tSteady path) ────────────────
        // tSteady-записи (sentimentKey=null) и все накопительные паттерны
        // обязаны проходить spot CVD 1h+4h гейты.
        // Без этого watcher PATH B был «лазейкой» мимо spot CVD проверки.
        //
        // Строгий гейт: раньше блокировал только явный cvd1h/cvd4h === false, а null
        // (данные недоступны или не набрались) пропускал как "не подтверждённо отрицательный".
        // tSteady-записи (sentimentKey=null) обязаны проходить spot CVD 1h+4h гейты.
        let pbEntryCvd15m: boolean | null = null;
        let pbEntryCvd30m: boolean | null = null;
        let pbEntryCvd1h: boolean | null = null;
        let pbEntryCvd4h: boolean | null = null;
        if (!w.signalPayload && w.sentimentKey === null) {
          const fbSpotCvd = await getSpotCvdMtf(w.symbol).catch(() => null);
          if (!fbSpotCvd?.available) {
            // Данных нет — ждём, не отменяем: null ≠ негативный CVD
            logger.info(
              { symbol: w.symbol, sentimentKey: w.sentimentKey },
              "OI Watch PATH B: нет спот CVD данных — откладываем",
            );
            continue;
          }
          if (fbSpotCvd.cvd1h === false && fbSpotCvd.cvd4h === false) {
            // Оба ТФ явно медвежьи (false, не null) — устойчивое давление продаж
            await dbWriteBestEffort("oiWatch/pathB-cvd-bearish-cancel", () =>
              db
                .update(oiWatchTable)
                .set({ status: "expired" })
                .where(eq(oiWatchTable.id, w.id)),
            );
            logger.info(
              {
                symbol: w.symbol,
                sentimentKey: w.sentimentKey,
                cvd1h: fbSpotCvd.cvd1h,
                cvd4h: fbSpotCvd.cvd4h,
              },
              "SKIP OI Watch PATH B: накоп. паттерн fallback — спот CVD 1h+4h оба медвежьи",
            );
            continue;
          }
          if (fbSpotCvd.cvd1h === false && fbSpotCvd.cvd4h !== true) {
            // 1h медвежий и 4h не подтверждает — ждём, не отменяем
            logger.info(
              {
                symbol: w.symbol,
                sentimentKey: w.sentimentKey,
                cvd1h: fbSpotCvd.cvd1h,
                cvd4h: fbSpotCvd.cvd4h,
              },
              "OI Watch PATH B: накоп. паттерн fallback — CVD неоднозначен (1h медвежий) — откладываем",
            );
            continue;
          }
          pbEntryCvd15m = fbSpotCvd.cvd15m ?? null;
          pbEntryCvd30m = fbSpotCvd.cvd30m ?? null;
          pbEntryCvd1h = fbSpotCvd.cvd1h;
          pbEntryCvd4h = fbSpotCvd.cvd4h;
        }

        {
          const _aggMissing = await missingAggregatedFireData(w.symbol);
          if (_aggMissing.length > 0) {
            logger.info(
              { symbol: w.symbol, missing: _aggMissing },
              "OI Watch PATH B: агрегированные данные недоступны — сигнал не выдан",
            );
            continue;
          }
        }
        // Атомарно захватываем запись перед отправкой — защита от дублей при деплое.
        const claimedB = await dbWriteStrict("oiWatch/pathB-fire-claim", () =>
          db
            .update(oiWatchTable)
            .set({ status: "fired", firedAt: new Date() })
            .where(
              and(
                eq(oiWatchTable.id, w.id),
                eq(oiWatchTable.status, "watching"),
              ),
            )
            .returning({ id: oiWatchTable.id }),
        );
        if (claimedB.length === 0) continue; // другой процесс уже обработал
        // Supersede: гасим другие активные watching/confirming записи того же символа
        const _supersededB =
          (await dbWriteBestEffort("oiWatch/supersede-B", () =>
            db
              .update(oiWatchTable)
              .set({ status: "expired", volStatusReason: "superseded" })
              .where(
                and(
                  eq(oiWatchTable.symbol, w.symbol),
                  inArray(oiWatchTable.status, ["watching", "confirming"]),
                ),
              )
              .returning({
                id: oiWatchTable.id,
                oi30m: oiWatchTable.oi30mChange,
                oi1h: oiWatchTable.oi1hChange,
                oi24h: oiWatchTable.oi24hChange,
                volMult: oiWatchTable.volumeMultiplier,
              }),
          )) ??
          ([] as {
            id: number;
            oi30m: number | null;
            oi1h: number | null;
            oi24h: number | null;
            volMult: number;
          }[]);

        // Берём свежие спот-данные из пула для обогащения сигнала
        const bpEntry = getSpotPoolEntry(w.symbol);
        const bpSpotVol24h = bpEntry?.spotVol24h ?? null;
        const bpMcapUsd = bpEntry?.mcapUsd ?? null;

        // Снимок стакана BingX перед отправкой сигнала (PATH B: broadcast идёт до trackSignal)
        const obAtFireB = await getOrderBookAnalysis(w.symbol, 20).catch(
          () => null,
        );

        // Если payload с полным AlphaResult сохранён — используем полный формат с OI по ТФ.
        // Доставку ставим только после INSERT signals, чтобы event key был стабильным
        // при повторах и совместной работе двух worker-процессов.
        let alertResult: AlphaResult;
        if (w.signalPayload) {
          const payload = w.signalPayload as {
            alphaResult: any;
            signalRow: any;
          };
          // signalRow был построен в момент постановки в очередь (scanner.ts CONFIRMED FIRE /
          // OI Watch queueing) — он уже содержит реальный spotCvd 1h/4h, увиденный гейтом тогда.
          // Раньше эти значения терялись (PATH B хардкодил entryCvd*: null при вставке).
          pbEntryCvd15m = payload.signalRow?.entryCvd15m ?? null;
          pbEntryCvd30m = payload.signalRow?.entryCvd30m ?? null;
          pbEntryCvd1h = payload.signalRow?.entryCvd1h ?? null;
          pbEntryCvd4h = payload.signalRow?.entryCvd4h ?? null;
          // Обновляем globalOiChange свежими данными CoinGlass перед отправкой
          const freshGlobalOi =
            cgOI?.oiChange30m ?? payload.alphaResult.globalOiChange ?? null;
          alertResult = {
            ...payload.alphaResult,
            price: currentPrice,
            volumeMultiplier: spotVolMult ?? volMult, // 2.2: спот вместо фьюч
            priceChange30m: priceMovePct,
            globalOiChange: freshGlobalOi,
            spotVol24h: payload.alphaResult.spotVol24h ?? bpSpotVol24h,
            marketCapUsd: payload.alphaResult.marketCapUsd ?? bpMcapUsd,
            _oiWatchPath: "B" as const,
            entryOb: obAtFireB ?? undefined,
          };
        } else {
          // Fallback: payload отсутствует (токен добавлен с низким объёмом без полного скана).
          // Используем уже полученный cgOI (не делаем повторный запрос).
          const base = w.symbol.replace("-USDT", "");
          const tvUrl = `https://www.tradingview.com/chart/?symbol=BINGX:${base}USDT`;
          const bingxUrl = `https://bingx.com/en/trade/${base}USDT/`;
          const waitMin = Math.round(
            (Date.now() - w.addedAt.getTime()) / 60_000,
          );

          // Определяем triggerTf — убираем префикс "all+" если был
          const displayTf = w.triggerTf.replace(/^all\+/, "");

          // Если CoinGlass API недоступен (cgOI = null) — используем сохранённое w.oiChange
          // как значение для сработавшего TF, чтобы в сигнале было видно OI по ТФ, а не просто число.
          const storedOi = w.oiChange;
          const cgOi30m =
            cgOI?.oiChange30m ??
            (displayTf === "30m" || displayTf === "steady" ? storedOi : null);
          const cgOi1h =
            cgOI?.oiChange1h ?? (displayTf === "1h" ? storedOi : null);
          const cgOi4h =
            cgOI?.oiChange4h ?? (displayTf === "4h" ? storedOi : null);
          const cgOi24h =
            cgOI?.oiChange24h ?? (displayTf === "24h" ? storedOi : null);

          alertResult = {
            symbol: w.symbol,
            grade: "alpha",
            price: currentPrice,
            priceChange30m: priceMovePct,
            currentVolume: curVol,
            avgVolume: avgVol,
            volumeMultiplier: spotVolMult ?? volMult, // 2.2: спот вместо фьюч
            oiChangePercent: w.oiChange,
            openInterest: null,
            cmcRank: null,
            cmcSource: null,
            cmcAvailable: false,
            liquidationsUsd: null,
            liquidationsMultiple: null,
            coinglassAvailable: cgOI?.available ?? false,
            globalOiChange: cgOi30m,
            globalOiConfirmed: false,
            isNewListing: false,
            isExhaustedSqueeze: false,
            pumpFromOpen: null,
            candleCount: 48,
            sentiment: "🔭 OI Watch",
            sentimentKey: pathBTrackedSentimentKey,
            traderAction: `Наблюдал ${waitMin} мин — CG turnover подтверждён (объём ${volMult.toFixed(1)}x BingX)`,
            alphaScore: 6,
            isContinuing: false,
            cumulativeOiChange: w.oiChange,
            tradingViewUrl: tvUrl,
            bingxUrl,
            oiTriggerTf: displayTf,
            oiChange1h: cgOi1h,
            oiChange4h: cgOi4h,
            oiChange24h: cgOi24h,
            spotVol24h: bpSpotVol24h,
            marketCapUsd: bpMcapUsd,
            entryOb: obAtFireB ?? undefined,
          };
        }

        // ── Создаём tracked_signal чтобы вотчер мог сопровождать сигнал ─────────
        // PATH B раньше не создавал запись → не было уведомлений о БУ и milestone.
        // Теперь вставляем сигнал и запускаем tracking, как в PATH A.
        try {
          const base = w.symbol.replace("-USDT", "");
          const tvUrl = `https://www.tradingview.com/chart/?symbol=BINGX:${base}USDT.P`;

          // Используем свежую цену из тикера (currentPrice), а не close из kline!
          // close — это цена закрытия 30м свечи, может быть на 30 минут устаревшей.
          // Ошибка: entryPrice: close → бот считал +11% вместо реального +1%.
          const _bwKeyB = `${w.symbol}:${Math.floor(Date.now() / (30 * 60 * 1000))}`;
          const pathBPrice3hSnapshot = recoverPlmEntryPrice3hSnapshot({
            sentimentKey: pathBTrackedSentimentKey,
            entryPrice3h: (w.signalPayload as any)?.signalRow?.entryPrice3h,
            entryPrice3hProvenance: (w.signalPayload as any)?.signalRow
              ?.entryPrice3hProvenance,
          });
          const pathBPlmOi30mSnapshot = await capturePlmOi30mShadowAtFire({
            sentimentKey: pathBTrackedSentimentKey,
            loadFresh: async () =>
              (
                await getCoinglassOI(
                  w.symbol,
                  currentPrice,
                  undefined,
                  PLM_OI30M_FIRE_FETCH_OPTIONS,
                )
              ).oiChange30m,
          });
          const _rowsB = await dbWriteStrict(
            "signals/oiWatch-pathB-insert",
            () =>
              db
                .insert(signalsTable)
                .values({
                  symbol: w.symbol,
                  type: "alpha",
                  value: volMult, // множитель объёма (как в PATH A), не OI
                  threshold: 0,
                  price: currentPrice,
                  priceChangePercent: priceMovePct,
                  volume24h: curVol,
                  avgVolume: w.avgVolume ?? 0,
                  openInterest: null,
                  oiChangePercent: w.oiChange,
                  tradingViewUrl: tvUrl,
                  sentimentKey: pathBTrackedSentimentKey,
                  entryPrice3h: pathBPrice3hSnapshot.entryPrice3h,
                  entryPrice3hProvenance:
                    pathBPrice3hSnapshot.entryPrice3hProvenance,
                  plmOi30mShadow: pathBPlmOi30mSnapshot.shadow,
                  broadcastWindowKey: _bwKeyB,
                  telegramAlertQueued: false,
                  altBulletSnapshotRequestedAt: new Date(),
                  detectedAt: new Date(),
                })
                .onConflictDoNothing()
                .returning(),
          );
          if (_rowsB.length === 0) {
            logger.info(
              { symbol: w.symbol, windowKey: _bwKeyB },
              "OI Watch PATH B: broadcast window conflict — duplicate suppressed (DB-level dedup)",
            );
            continue;
          }
          const inserted = _rowsB[0]!;

          // Если памп уже случился до выстрела (priceMovePct > 10%) — используем
          // оригинальную цену обнаружения как точку отсчёта для peakPct и stale cancel.
          // Иначе stale cancel видит peak=0% и отменяет сигнал где уже было +17%.
          const effectiveEntry =
            priceMovePct > 10 ? w.priceAtEntry : currentPrice;

          // ── trackSignal ПЕРЕД broadcast — чтобы не отправлять если монета уже активна ──
          // Раньше broadcast шёл до trackSignal, и при skip "broadcast уже ушёл — не отменяем".
          // Это была причина дублей (та же монета, другой sentimentKey или второй worker).
          const pbTracked = await trackSignal({
            symbol: w.symbol,
            signalId: inserted.id,
            signalType: "alpha",
            sentiment: null,
            sentimentKey: pathBTrackedSentimentKey,
            alphaScore: 6,
            entryPrice: effectiveEntry,
            entryOi: null,
            entryCvd15m: pbEntryCvd15m,
            entryCvd30m: pbEntryCvd30m,
            entryCvd1h: pbEntryCvd1h,
            entryCvd4h: pbEntryCvd4h,
            entryPrice3h: inserted.entryPrice3h,
            entryPrice3hProvenance: inserted.entryPrice3hProvenance,
            plmOi30mShadow: inserted.plmOi30mShadow,
            entrySource: isBullishAccumulationPathB
              ? getBullishAccumulationOiWatchEntrySource(
                  "path_b",
                  pathBBaDecision.oiPath!,
                )
              : "oi_watch/path_b",
            entryFutVolMult: volMult,
            entryOi30m: w.oi30mChange ?? null,
            entryOi1h: w.oi1hChange ?? null,
            entryOi24h: w.oi24hChange ?? null,
            marketCapUsd: pbMcapUsdB ?? null,
            entrySpotVol24h: pbSpotVol24h ?? null,
            entrySpotMcapPct:
              pbSpotVol24h !== null && pbMcapUsdB
                ? (pbSpotVol24h / pbMcapUsdB) * 100
                : null,
          });

          if (pbTracked === false) {
            logger.error(
              { symbol: w.symbol },
              "OI Watch PATH B: trackSignal упал — broadcast отменён",
            );
            await discardUntrackedSignal(inserted.id, "oi_watch_path_b_failed");
            continue;
          }
          if (pbTracked === "skip") {
            // Монета уже активна — НЕ дублируем алерт (duplicate guard).
            logger.info(
              { symbol: w.symbol },
              "OI Watch PATH B: монета уже в трекере — broadcast отменён (duplicate guard)",
            );
            await discardUntrackedSignal(inserted.id, "oi_watch_path_b_skip");
            continue;
          }

          resetPrescanCycleCount(w.symbol);
          await broadcastBatchAlert(
            [{ ...alertResult, signalId: inserted.id }],
            {
              eventKey: `signal:${inserted.id}`,
            },
          );
          scheduleAltBulletIndicatorSnapshot({
            signalId: inserted.id,
            symbol: w.symbol,
            sentimentKey: pathBTrackedSentimentKey,
          });
          await dbWriteStrict("signals/alert-queued", () =>
            db
              .update(signalsTable)
              .set({ telegramAlertQueued: true })
              .where(eq(signalsTable.id, inserted.id)),
          );
          logger.info(
            {
              symbol: w.symbol,
              entryPrice: effectiveEntry,
              firePriceNow: currentPrice,
              klinesClose: close,
              priceMovePct: priceMovePct.toFixed(1),
            },
            "🔭 OI Watch PATH B: tracked_signal создан — сопровождение активно",
          );
        } catch (trackErr) {
          logger.error(
            { err: trackErr, symbol: w.symbol },
            "OI Watch PATH B: ошибка при создании tracked_signal",
          );
        }

        logger.info(
          {
            symbol: w.symbol,
            volMult: volMult.toFixed(2),
            priceMovePct: priceMovePct.toFixed(1),
            volConfirmed,
          },
          "🔭➡️🚀 OI Watch FIRED (volume confirmed)",
        );
      }
    } catch (err) {
      logger.debug(
        { err, symbol: w.symbol },
        "OI Watch PATH B: klines fetch failed",
      );
    }
  }
}

// ── Subscription expiry job ───────────────────────────────────────────────────

// file_id картинки «Ваша подписка заканчивается» (загружена один раз в Telegram)
const EXPIRY_WARNING_PHOTO_FILE_ID =
  "AgACAgIAAxkDAAI4JGqEZNga67_jqFUa1c4JBlMGlxktAAL6GWsbBhAoSN3kDNfnAAF_HQEAAwIAA3cAAz0E";

interface SubscriptionWarningClaim {
  id: number;
  claimToken: string;
}

function subscriptionWarningClaimConditions(id: number, claimToken: string) {
  return and(
    eq(subscriptionWarningDeliveriesTable.id, id),
    eq(subscriptionWarningDeliveriesTable.claimToken, claimToken),
    eq(subscriptionWarningDeliveriesTable.status, "processing"),
  );
}

/**
 * Claims the warning for one exact chat ID + subscription expiry.
 * A new warning can only be created in the 2–4h window. Only a confirmed
 * Telegram failure can be reclaimed. A stale processing row has an ambiguous
 * outcome, so it stays claimed rather than risking a duplicate user message.
 */
async function claimSubscriptionWarning(
  recipient: SubscriptionWarningRecipient,
  allowNewWarning: boolean,
): Promise<SubscriptionWarningClaim | null> {
  const claimToken = randomUUID();
  const leaseUntil = new Date(Date.now() + SUBSCRIPTION_WARNING_LEASE_MS);
  const keyConditions = and(
    eq(subscriptionWarningDeliveriesTable.chatId, recipient.chatId),
    eq(
      subscriptionWarningDeliveriesTable.warningKind,
      SUBSCRIPTION_WARNING_KIND,
    ),
    eq(
      subscriptionWarningDeliveriesTable.subscribedUntil,
      recipient.subscribedUntil,
    ),
  );

  if (allowNewWarning) {
    const [inserted] = await db
      .insert(subscriptionWarningDeliveriesTable)
      .values({
        chatId: recipient.chatId,
        warningKind: SUBSCRIPTION_WARNING_KIND,
        subscribedUntil: recipient.subscribedUntil,
        status: "processing",
        claimToken,
        leaseUntil,
        attempts: 1,
      })
      .onConflictDoNothing({
        target: [
          subscriptionWarningDeliveriesTable.chatId,
          subscriptionWarningDeliveriesTable.warningKind,
          subscriptionWarningDeliveriesTable.subscribedUntil,
        ],
      })
      .returning({ id: subscriptionWarningDeliveriesTable.id });
    if (inserted) return { id: inserted.id, claimToken };
  }

  const [reclaimed] = await db
    .update(subscriptionWarningDeliveriesTable)
    .set({
      status: "processing",
      claimToken,
      leaseUntil,
      deliveredAt: null,
      lastError: null,
      attempts: sql`${subscriptionWarningDeliveriesTable.attempts} + 1`,
    })
    .where(
      and(
        keyConditions,
        eq(subscriptionWarningDeliveriesTable.status, "failed"),
      ),
    )
    .returning({ id: subscriptionWarningDeliveriesTable.id });
  return reclaimed ? { id: reclaimed.id, claimToken } : null;
}

async function markSubscriptionWarningDelivered(
  claim: SubscriptionWarningClaim,
): Promise<boolean> {
  const [updated] = await db
    .update(subscriptionWarningDeliveriesTable)
    .set({
      status: "delivered",
      deliveredAt: new Date(),
      leaseUntil: null,
      lastError: null,
    })
    .where(subscriptionWarningClaimConditions(claim.id, claim.claimToken))
    .returning({ id: subscriptionWarningDeliveriesTable.id });
  return Boolean(updated);
}

function persistSubscriptionWarningDeliveredInBackground(
  claim: SubscriptionWarningClaim,
  chatId: number,
): void {
  let attempt = 0;
  const retry = async (): Promise<void> => {
    attempt++;
    try {
      const updated = await markSubscriptionWarningDelivered(claim);
      if (!updated) {
        logger.warn(
          { warningDeliveryId: claim.id, chatId, attempt },
          "subscriptionWarning: stopped delivery-marker repair after claim changed",
        );
        return;
      }
      logger.info(
        { warningDeliveryId: claim.id, chatId, attempt },
        "subscriptionWarning: delivery marker repaired",
      );
    } catch (err) {
      logger.error(
        { err, warningDeliveryId: claim.id, chatId, attempt },
        "subscriptionWarning: delivery marker still pending",
      );
      const timer = setTimeout(retry, Math.min(30_000, attempt * 5_000));
      timer.unref();
    }
  };

  const timer = setTimeout(retry, 5_000);
  timer.unref();
}

async function markSubscriptionWarningFailed(
  claim: SubscriptionWarningClaim,
  err: unknown,
): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  const [updated] = await db
    .update(subscriptionWarningDeliveriesTable)
    .set({
      status: "failed",
      leaseUntil: null,
      lastError: message.slice(0, 1_000),
    })
    .where(subscriptionWarningClaimConditions(claim.id, claim.claimToken))
    .returning({ id: subscriptionWarningDeliveriesTable.id });
  return Boolean(updated);
}

function persistSubscriptionWarningFailedInBackground(
  claim: SubscriptionWarningClaim,
  chatId: number,
  err: unknown,
): void {
  let attempt = 0;
  const retry = async (): Promise<void> => {
    attempt++;
    try {
      const updated = await markSubscriptionWarningFailed(claim, err);
      if (!updated) {
        logger.warn(
          { warningDeliveryId: claim.id, chatId, attempt },
          "subscriptionWarning: stopped failure-marker repair after claim changed",
        );
        return;
      }
      logger.info(
        { warningDeliveryId: claim.id, chatId, attempt },
        "subscriptionWarning: failure marker repaired",
      );
    } catch (markErr) {
      logger.error(
        { err: markErr, warningDeliveryId: claim.id, chatId, attempt },
        "subscriptionWarning: failure marker still pending",
      );
      const timer = setTimeout(retry, Math.min(30_000, attempt * 5_000));
      timer.unref();
    }
  };

  const timer = setTimeout(retry, 5_000);
  timer.unref();
}

function logSubscriptionWarningClaimLost(
  claim: SubscriptionWarningClaim,
  chatId: number,
  marker: "delivery" | "failure",
): void {
  logger.warn(
    { warningDeliveryId: claim.id, chatId, marker },
    "subscriptionWarning: claim ownership lost before marker",
  );
}

function logSubscriptionWarningMarkerRetry(
  claim: SubscriptionWarningClaim,
  chatId: number,
  marker: "delivery" | "failure",
  err: unknown,
): void {
  logger.error(
    { err, warningDeliveryId: claim.id, chatId, marker },
    "subscriptionWarning: Telegram result known, DB marker will be retried",
  );
}

function persistSubscriptionWarningResultInBackground(
  claim: SubscriptionWarningClaim,
  chatId: number,
  result:
    | { marker: "delivery" }
    | {
        marker: "failure";
        err: unknown;
      },
): void {
  if (result.marker === "delivery") {
    persistSubscriptionWarningDeliveredInBackground(claim, chatId);
  } else {
    persistSubscriptionWarningFailedInBackground(claim, chatId, result.err);
  }
}

/**
 * Sends a three-hour advance warning. The scheduler runs hourly; the 2–4 hour
 * window guarantees every expiry gets a chance even when a scheduled run drifts.
 * Recipient state is deduplicated by chat ID and expiry across both source tables.
 */
async function runSubscriptionWarningJob(): Promise<void> {
  const warningText = buildSubscriptionWarningText();
  const subscriberRecipients: SubscriptionWarningRecipient[] = [];
  const dashboardRecipients: SubscriptionWarningRecipient[] = [];

  // Load both sources first. Dashboard has precedence for a shared Chat ID,
  // matching the effective-expiry rule used by the subscription-status path.
  try {
    const subs = await db
      .select({
        chatId: subscribersTable.chatId,
        subscribedUntil: subscribersTable.subscribedUntil,
      })
      .from(subscribersTable)
      .where(
        and(
          eq(subscribersTable.active, true),
          sql`${subscribersTable.subscribedUntil} IS NOT NULL`,
          sql`${subscribersTable.subscribedUntil} > NOW()`,
        ),
      );
    for (const sub of subs) {
      if (sub.subscribedUntil) {
        subscriberRecipients.push({
          chatId: sub.chatId,
          subscribedUntil: sub.subscribedUntil,
          source: "subscriber",
        });
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "subscriptionWarning: ошибка при загрузке subscribers",
    );
  }

  try {
    const users = await db
      .select({
        chatId: dashboardUsersTable.chatId,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(
        and(
          eq(dashboardUsersTable.status, "approved"),
          sql`${dashboardUsersTable.subscribedUntil} IS NOT NULL`,
        ),
      );
    for (const u of users) {
      if (!u.chatId) continue;
      const numId = Number(u.chatId);
      if (!Number.isSafeInteger(numId) || numId <= 0 || !u.subscribedUntil)
        continue;
      dashboardRecipients.push({
        chatId: numId,
        subscribedUntil: u.subscribedUntil,
        source: "dashboard",
      });
    }
  } catch (err) {
    logger.error(
      { err },
      "subscriptionWarning: ошибка при загрузке dashboard_users",
    );
  }

  const recipients = mergeSubscriptionWarningRecipients(
    subscriberRecipients,
    dashboardRecipients,
  );
  let claimed = 0;
  let delivered = 0;
  let failed = 0;
  let ambiguous = 0;
  const nowMs = Date.now();
  for (const recipient of recipients.values()) {
    if (recipient.subscribedUntil.getTime() <= nowMs) continue;
    const claim = await claimSubscriptionWarning(
      recipient,
      isThreeHourWarningWindow(recipient.subscribedUntil, nowMs),
    ).catch((err) => {
      logger.error(
        { err, chatId: recipient.chatId, source: recipient.source },
        "subscriptionWarning: не удалось получить claim",
      );
      return null;
    });
    if (!claim) continue;

    claimed++;
    let sendOutcome;
    try {
      sendOutcome = classifySubscriptionWarningSendResult(
        await sendPhotoByFileIdResult(
          recipient.chatId,
          EXPIRY_WARNING_PHOTO_FILE_ID,
          warningText,
        ),
      );
    } catch (err) {
      ambiguous++;
      logger.error(
        { err, chatId: recipient.chatId, source: recipient.source },
        "subscriptionWarning: неоднозначная ошибка транспорта — delivery остаётся claimed",
      );
      continue;
    }

    if (sendOutcome.kind === "ambiguous") {
      ambiguous++;
      logger.error(
        {
          chatId: recipient.chatId,
          source: recipient.source,
          description: sendOutcome.description,
        },
        "subscriptionWarning: timeout/network outcome неоднозначен — retry запрещён",
      );
      continue;
    }

    if (sendOutcome.kind === "confirmed_failure") {
      failed++;
      const err = new Error(sendOutcome.description);
      try {
        if (!(await markSubscriptionWarningFailed(claim, err))) {
          logSubscriptionWarningClaimLost(claim, recipient.chatId, "failure");
        }
      } catch (markErr) {
        logSubscriptionWarningMarkerRetry(
          claim,
          recipient.chatId,
          "failure",
          markErr,
        );
        persistSubscriptionWarningResultInBackground(claim, recipient.chatId, {
          marker: "failure",
          err,
        });
      }
      logger.warn(
        { err, chatId: recipient.chatId, source: recipient.source },
        "subscriptionWarning: ошибка отправки",
      );
      continue;
    }

    try {
      if (!(await markSubscriptionWarningDelivered(claim))) {
        logSubscriptionWarningClaimLost(claim, recipient.chatId, "delivery");
        continue;
      }
      delivered++;
    } catch (err) {
      logSubscriptionWarningMarkerRetry(
        claim,
        recipient.chatId,
        "delivery",
        err,
      );
      persistSubscriptionWarningResultInBackground(claim, recipient.chatId, {
        marker: "delivery",
      });
    }
  }

  if (claimed > 0) {
    logger.info(
      { claimed, delivered, failed, ambiguous },
      "subscriptionWarning: обработка трёхчасовых предупреждений завершена",
    );
  }
}

/**
 * Periodic job — runs every minute.
 * 1. Deactivates bot subscribers whose subscribed_until has passed.
 * 2. Marks dashboard_users whose subscribed_until has passed as expired and
 *    clears their visible session activity immediately.
 * 3. Sends an owner-only summary. The expired user must receive no proactive
 *    Telegram delivery after the exact subscription cutoff.
 */
async function runSubscriptionExpiryJob(): Promise<void> {
  const OWNER_CHAT_ID = Number(
    process.env["OWNER_CHAT_ID"] ?? process.env["TELEGRAM_CHAT_ID"] ?? "0",
  );
  const OWNER_EMAIL = (process.env["OWNER_EMAIL"] ?? "").toLowerCase().trim();

  // ── 1. Deactivate expired bot subscribers ────────────────────────────────────
  let expiredSubscribers: {
    chatId: number;
    username: string | null;
    firstName: string | null;
  }[] = [];
  try {
    expiredSubscribers = await db
      .select({
        chatId: subscribersTable.chatId,
        username: subscribersTable.username,
        firstName: subscribersTable.firstName,
      })
      .from(subscribersTable)
      .where(
        and(
          eq(subscribersTable.active, true),
          sql`${subscribersTable.subscribedUntil} IS NOT NULL`,
          sql`${subscribersTable.subscribedUntil} <= NOW()`,
        ),
      );

    if (expiredSubscribers.length > 0) {
      await db
        .update(subscribersTable)
        .set({ active: false, unsubscribedAt: new Date() })
        .where(
          and(
            eq(subscribersTable.active, true),
            sql`${subscribersTable.subscribedUntil} IS NOT NULL`,
            sql`${subscribersTable.subscribedUntil} <= NOW()`,
          ),
        );
      logger.info(
        { count: expiredSubscribers.length },
        "subscriptionExpiry: деактивированы истёкшие подписчики",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "subscriptionExpiry: ошибка при обработке subscribers",
    );
  }

  // ── 2. Disable expired dashboard users without treating them as blocked ──────
  let expiredDashboardUsers: {
    chatId: string | null;
    name: string;
    email: string;
  }[] = [];
  try {
    const ownerFilter = OWNER_EMAIL
      ? sql`${dashboardUsersTable.email} != ${OWNER_EMAIL}`
      : sql`TRUE`;

    expiredDashboardUsers = await db
      .select({
        chatId: dashboardUsersTable.chatId,
        name: dashboardUsersTable.name,
        email: dashboardUsersTable.email,
      })
      .from(dashboardUsersTable)
      .where(
        and(
          eq(dashboardUsersTable.status, "approved"),
          sql`${dashboardUsersTable.subscribedUntil} IS NOT NULL`,
          sql`${dashboardUsersTable.subscribedUntil} <= NOW()`,
          ownerFilter,
        ),
      );

    if (expiredDashboardUsers.length > 0) {
      const emailsToExpire = expiredDashboardUsers.map((u) => u.email);
      // Keep the expiry predicates in the UPDATE WHERE clause so that if an
      // admin renews a subscription between our SELECT and this UPDATE the
      // row won't be incorrectly blocked (renewed = future subscribed_until).
      await db
        .update(dashboardUsersTable)
        .set({ status: "expired", lastActivityAt: null })
        .where(
          and(
            inArray(dashboardUsersTable.email, emailsToExpire),
            eq(dashboardUsersTable.status, "approved"),
            sql`${dashboardUsersTable.subscribedUntil} IS NOT NULL`,
            sql`${dashboardUsersTable.subscribedUntil} <= NOW()`,
          ),
        );
      logger.info(
        { count: expiredDashboardUsers.length },
        "subscriptionExpiry: помечены истёкшими dashboard_users",
      );
    }

    // Revoke visible sessions for accounts that were already materialized as
    // expired by an older deployment. This is intentionally idempotent.
    await db
      .update(dashboardUsersTable)
      .set({ lastActivityAt: null })
      .where(
        and(
          eq(dashboardUsersTable.status, "expired"),
          sql`${dashboardUsersTable.subscribedUntil} IS NOT NULL`,
          sql`${dashboardUsersTable.subscribedUntil} <= NOW()`,
          sql`${dashboardUsersTable.lastActivityAt} IS NOT NULL`,
          ownerFilter,
        ),
      );
  } catch (err) {
    logger.error(
      { err },
      "subscriptionExpiry: ошибка при обработке dashboard_users",
    );
  }

  const totalExpired = expiredSubscribers.length + expiredDashboardUsers.length;
  if (totalExpired === 0) return;

  // ── 3. Owner summary ─────────────────────────────────────────────────────────
  if (OWNER_CHAT_ID) {
    try {
      const lines: string[] = [
        `⏰ <b>Истекло подписок: ${totalExpired}</b>`,
        ``,
      ];
      for (const sub of expiredSubscribers) {
        const name = sub.firstName ?? sub.username ?? String(sub.chatId);
        lines.push(`• ${name} (TG: <code>${sub.chatId}</code>)`);
      }
      for (const u of expiredDashboardUsers) {
        lines.push(`• ${u.name} (<code>${u.email}</code>)`);
      }
      await sendMessage(OWNER_CHAT_ID, lines.join("\n"));
    } catch (err) {
      logger.warn({ err }, "subscriptionExpiry: ошибка уведомления владельца");
    }
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
let cycleTimer: NodeJS.Timeout | null = null;
let fastTimer: NodeJS.Timeout | null = null;
let stealthReentryTimer: NodeJS.Timeout | null = null;
let stealthFreshHighProtectionTimer: NodeJS.Timeout | null = null;
const STEALTH_FH_PROTECTION_INTERVAL_MS = 20_000;
const STEALTH_FH_MAX_AGE_MS = 72 * 60 * 60 * 1000;
let oiWatchTimer: NodeJS.Timeout | null = null; // независимый таймер OI Watch (не блокирует fast-цикл)
let signalOutcomesTimer: NodeJS.Timeout | null = null;
let postCloseFollowupTimer: NodeJS.Timeout | null = null;
let breakoutAnalysisShadowTimer: NodeJS.Timeout | null = null;
let dailyTimer: NodeJS.Timeout | null = null;
let weeklyTimer: NodeJS.Timeout | null = null;
let monthlyTimer: NodeJS.Timeout | null = null;
let calculatorArchiveTimer: NodeJS.Timeout | null = null;
let calculatorArchiveRetryTimer: NodeJS.Timeout | null = null;
let whaleTimer: NodeJS.Timeout | null = null;
let subscriptionExpiryTimer: NodeJS.Timeout | null = null;

/** Миллисекунды до следующего HH:MM:00 UTC */
function msUntilUtc(
  targetHour: number,
  targetMin: number,
  targetDayOfWeek?: number,
): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(targetMin);
  next.setUTCHours(targetHour);

  if (targetDayOfWeek !== undefined) {
    // Воскресенье = 0
    const currentDay = now.getUTCDay();
    let daysUntil = (targetDayOfWeek - currentDay + 7) % 7;
    // Если сегодня целевой день, но время уже прошло — ждём следующей недели
    if (daysUntil === 0 && next.getTime() <= now.getTime()) {
      daysUntil = 7;
    }
    next.setUTCDate(now.getUTCDate() + daysUntil);
  } else {
    // Ежедневно — если уже прошло сегодня, переносим на завтра
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
  }

  return next.getTime() - now.getTime();
}

/** Миллисекунды до следующего 1-го числа месяца в HH:MM UTC */
function msUntilFirstOfMonth(targetHour: number, targetMin: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
      1,
      targetHour,
      targetMin,
      0,
      0,
    ),
  );
  // Если сейчас уже 1-е число и время ещё не наступило — отправляем сегодня
  if (now.getUTCDate() === 1) {
    const today = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        1,
        targetHour,
        targetMin,
        0,
        0,
      ),
    );
    if (today.getTime() > now.getTime()) return today.getTime() - now.getTime();
  }
  return next.getTime() - now.getTime();
}

/**
 * Freeze the previous Dubai calendar month for every user who has calculator
 * settings. The boundary is passed in by the scheduler (rather than derived
 * from callback execution time), so a delayed timer still calculates exactly
 * up to 00:00 Asia/Dubai.
 *
 * A conditional upsert converts an existing rolling row into an immutable
 * snapshot, but never changes one that was already closed. Records changed
 * after the cutoff are excluded by updated_at; they need a manual revision.
 */
export async function archiveCalculatorMonthAtBoundary(
  boundary: Date,
): Promise<number> {
  if (!Number.isFinite(boundary.getTime())) {
    throw new Error("Calculator archive boundary must be a valid date");
  }

  const currentMonth = getDubaiMonthKey(boundary);
  const archiveMonth = getPreviousDubaiMonthKey(currentMonth);
  const periodClosedAt = getDubaiMonthStartUtc(currentMonth);
  const archiveMonthStart = getDubaiMonthStartUtc(archiveMonth);

  const [settingsRows, rollingRows, tradeRows] = await Promise.all([
    db
      .select({
        userId: tradeCalculatorSettingsTable.userId,
        depositUsdt: tradeCalculatorSettingsTable.depositUsdt,
        leverage: tradeCalculatorSettingsTable.leverage,
        allocationPercent: tradeCalculatorSettingsTable.allocationPercent,
        commissionPercent: tradeCalculatorSettingsTable.commissionPercent,
        updatedAt: tradeCalculatorSettingsTable.updatedAt,
      })
      .from(tradeCalculatorSettingsTable),
    db
      .select()
      .from(tradeCalculatorMonthlyTable)
      .where(eq(tradeCalculatorMonthlyTable.month, archiveMonth)),
    db
      .select({
        status: trackedSignalsTable.status,
        pnlPercent: trackedSignalsTable.pnlPercent,
        closedAt: trackedSignalsTable.closedAt,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          inArray(
            trackedSignalsTable.status,
            CALCULATOR_CLOSED_STATUSES as any,
          ),
          gte(trackedSignalsTable.closedAt, archiveMonthStart),
          lt(trackedSignalsTable.closedAt, periodClosedAt),
          lte(trackedSignalsTable.updatedAt, periodClosedAt),
        ),
      ),
  ]);

  const rows: CalculatorTradeRow[] = tradeRows.flatMap((row) =>
    row.closedAt
      ? [
          {
            status: row.status,
            pnlPercent: row.pnlPercent,
            closedAt: row.closedAt,
          },
        ]
      : [],
  );
  if (settingsRows.length === 0) return 0;

  const rollingByUser = new Map(rollingRows.map((row) => [row.userId, row]));
  const values = settingsRows.flatMap((row) => {
    const rolling = rollingByUser.get(row.userId);
    // The rolling row is created/updated when the user saves calculator
    // settings. For recovery after a delayed timer, it is the point-in-time
    // parameter snapshot from the closed month, not today's live settings.
    if (!rolling && row.updatedAt > periodClosedAt) return [];
    const settings = {
      depositUsdt: Number(rolling?.depositUsdt ?? row.depositUsdt),
      leverage: Number(rolling?.leverage ?? row.leverage),
      allocationPercent: Number(
        rolling?.allocationPercent ?? row.allocationPercent,
      ),
      commissionPercent: Number(
        rolling?.commissionPercent ?? row.commissionPercent,
      ),
    };
    const summary = calculateCalculatorSummary(archiveMonth, rows, settings);
    return [
      {
        userId: row.userId,
        month: archiveMonth,
        ...settings,
        reinvest: false,
        grossPnlUsdt: summary.grossPnlUsdt,
        netPnlUsdt: summary.netPnlUsdt,
        ...getCalculatorMonthlyCounts(summary),
        periodClosedAt,
        calculatedAt: new Date(),
        updatedAt: new Date(),
      },
    ];
  });

  let frozen = 0;
  for (const value of values) {
    const { userId: _userId, month: _month, ...snapshot } = value;
    const result = await db
      .insert(tradeCalculatorMonthlyTable)
      .values(value)
      .onConflictDoUpdate({
        target: [
          tradeCalculatorMonthlyTable.userId,
          tradeCalculatorMonthlyTable.month,
        ],
        set: snapshot,
        // A second worker/retry can only affect an unclosed rolling row.
        // A frozen historical snapshot remains untouched forever.
        setWhere: isNull(tradeCalculatorMonthlyTable.periodClosedAt),
      });
    frozen += Number((result as { rowCount?: number }).rowCount ?? 0);
  }
  logger.info(
    {
      archiveMonth,
      periodClosedAt: periodClosedAt.toISOString(),
      configuredUsers: settingsRows.length,
      frozen,
      tradeRows: rows.length,
    },
    "Calculator month archived",
  );
  return frozen;
}

// ── Job timing tracker ────────────────────────────────────────────────────────
// Обновляется внутри startWatcher() по завершению каждого цикла.
interface _JobTiming {
  label: string;
  intervalMs: number;
  lastRunAt: number | null;
}
const _jobTimings: Record<string, _JobTiming> = {
  fastCycle: {
    label: "Fast Cycle (2мин)",
    intervalMs: 2 * 60_000,
    lastRunAt: null,
  },
  watcherCycle: {
    label: "Watcher Cycle (10мин)",
    intervalMs: 10 * 60_000,
    lastRunAt: null,
  },
  liqCascade: {
    label: "Liq Cascade L10 (3мин)",
    intervalMs: 3 * 60_000,
    lastRunAt: null,
  },
  price24hRefresh: {
    label: "Price24h Refresh (20мин)",
    intervalMs: 20 * 60_000,
    lastRunAt: null,
  },
  backfill: {
    label: "Entry Metrics Backfill (30мин)",
    intervalMs: 30 * 60_000,
    lastRunAt: null,
  },
};

export interface WatcherJobTiming {
  label: string;
  intervalMs: number;
  lastRunAt: number | null;
  overdueMs: number | null;
}

/** Возвращает статус всех фоновых job'ов: время последнего запуска и превышение интервала. */
export function getWatcherJobTimings(): Record<string, WatcherJobTiming> {
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(_jobTimings).map(([key, t]) => [
      key,
      {
        label: t.label,
        intervalMs: t.intervalMs,
        lastRunAt: t.lastRunAt,
        overdueMs:
          t.lastRunAt !== null
            ? Math.max(0, now - t.lastRunAt - t.intervalMs)
            : null,
      } satisfies WatcherJobTiming,
    ]),
  );
}

/**
 * Writes one forward-price snapshot around 6h and 24h after a tracked
 * candidate is rejected or expires without firing. These are candidate
 * outcomes, not traded PnL: they reveal whether a gate suppresses recoveries.
 */
async function fillMissedCandidatePrices(input: {
  sourceLike: string;
  label: string;
}): Promise<void> {
  try {
    const tickers = await getFutureTickers();
    const priceMap = new Map<string, number>(
      tickers.map((t) => [t.symbol, parseFloat(t.lastPrice) || 0]),
    );

    const [need6h, need24h] = await Promise.all([
      db.execute<{ id: number; symbol: string; price_at_log: number }>(sql`
        SELECT id, symbol, price_at_log
        FROM missed_signals_log
        WHERE source LIKE ${input.sourceLike}
          AND price_at_log IS NOT NULL
          AND price_at_log > 0
          AND price_6h_pct IS NULL
          AND logged_at <= NOW() - INTERVAL '6 hours'
        ORDER BY logged_at ASC
        LIMIT 200
      `),
      db.execute<{ id: number; symbol: string; price_at_log: number }>(sql`
        SELECT id, symbol, price_at_log
        FROM missed_signals_log
        WHERE source LIKE ${input.sourceLike}
          AND price_at_log IS NOT NULL
          AND price_at_log > 0
          AND price_24h_pct_after IS NULL
          AND logged_at <= NOW() - INTERVAL '24 hours'
        ORDER BY logged_at ASC
        LIMIT 200
      `),
    ]);

    const makePatches = (
      rows: Array<{ id: number; symbol: string; price_at_log: number }>,
    ) =>
      rows
        .map((row) => {
          const pct = calculateForwardPricePct(
            row.price_at_log,
            priceMap.get(row.symbol) ?? null,
          );
          return pct === null ? null : { id: row.id, pct };
        })
        .filter((row): row is { id: number; pct: number } => row !== null);

    const writePatches = async (
      patches: Array<{ id: number; pct: number }>,
      horizon: "6h" | "24h",
    ) => {
      if (patches.length === 0) return 0;
      const values = sql.join(
        patches.map((row) => sql`(${row.id}::int, ${row.pct}::real)`),
        sql`, `,
      );
      const written = await dbWriteBestEffort(
        `${input.label}/missed-price-${horizon}`,
        () =>
          horizon === "6h"
            ? db.execute(sql`
                UPDATE missed_signals_log AS log
                SET price_6h_pct = values.pct
                FROM (VALUES ${values}) AS values(id, pct)
                WHERE log.id = values.id
                  AND log.price_6h_pct IS NULL
              `)
            : db.execute(sql`
                UPDATE missed_signals_log AS log
                SET price_24h_pct_after = values.pct
                FROM (VALUES ${values}) AS values(id, pct)
                WHERE log.id = values.id
                  AND log.price_24h_pct_after IS NULL
              `),
        { perAttemptTimeoutMs: 5000, attempts: 2, retryDelayMs: 1000 },
      );
      return written === null ? 0 : patches.length;
    };

    const [filled6h, filled24h] = await Promise.all([
      writePatches(makePatches(need6h.rows), "6h"),
      writePatches(makePatches(need24h.rows), "24h"),
    ]);

    logger.info(
      {
        pending6h: need6h.rows.length,
        pending24h: need24h.rows.length,
        filled6h,
        filled24h,
      },
      `${input.label} missed-candidate price backfill complete`,
    );
  } catch (err) {
    logger.warn(
      { err, sourceLike: input.sourceLike },
      `${input.label} missed-candidate price backfill failed`,
    );
  }
}

/**
 * Writes one direction-aware price movement snapshot at least 72 hours after a
 * cancellation. The write is idempotent and leaves rows pending when BingX has
 * no current price instead of recording a misleading zero.
 */
async function fillCancellationPrice72hAfterExit(): Promise<void> {
  try {
    const { pending, written } = await writeCancellationPrice72hSnapshots({
      getTickers: getFutureTickers,
      store: {
        // Filter by the live ticker set in SQL before applying the cap. A
        // delisted old symbol cannot occupy the queue forever and starve newer
        // cancellations.
        findPending: (pricedSymbols) =>
          db
            .select({
              id: trackedSignalsTable.id,
              symbol: trackedSignalsTable.symbol,
              isShort: trackedSignalsTable.isShort,
              exitPrice: trackedSignalsTable.exitPrice,
            })
            .from(trackedSignalsTable)
            .where(
              and(
                sql`(${trackedSignalsTable.cancelReason} IS NOT NULL
                    OR ${trackedSignalsTable.status} = 'bu_stop')
                  AND ${trackedSignalsTable.closedAt} < NOW() - INTERVAL '72 hours'
                  AND ${trackedSignalsTable.price72hAfterExitPct} IS NULL
                  AND ${trackedSignalsTable.exitPrice} IS NOT NULL
                  AND ${trackedSignalsTable.exitPrice} > 0
                  AND ${trackedSignalsTable.status} IN ('cancelled', 'stop_loss', 'bu_stop')`,
                inArray(trackedSignalsTable.symbol, pricedSymbols),
              ),
            )
            .orderBy(trackedSignalsTable.closedAt)
            .limit(200),
        persist: async ({ id, pct, observedAt }) => {
          const updated = await dbWriteBestEffort(
            "trackedSignal/backfill-cancel-price-72h",
            () =>
              db
                .update(trackedSignalsTable)
                .set({
                  price72hAfterExitPct: pct,
                  price72hAfterExitObservedAt: observedAt,
                  updatedAt: observedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${id}
                    AND ${trackedSignalsTable.price72hAfterExitPct} IS NULL
                    AND ${trackedSignalsTable.price72hAfterExitObservedAt} IS NULL`,
                )
                .returning({ id: trackedSignalsTable.id }),
          );
          return Boolean(updated?.length);
        },
      },
    });

    logger.info(
      { pending, written },
      "Cancellation 72h price snapshot backfill complete",
    );
  } catch (err) {
    logger.warn({ err }, "Cancellation 72h price snapshot backfill failed");
  }
}

/**
 * Stores one hourly price observation for every live post-close follow-up
 * window. The unique signal/hour key makes retries and overlapping production
 * workers safe. Missing market prices remain absent rather than becoming zero.
 */
async function fillPostCloseFollowupSnapshots(): Promise<void> {
  try {
    const observedAt = new Date();
    const prices = new Map(
      (await getFutureTickers())
        .map(
          (ticker) =>
            [ticker.symbol, Number.parseFloat(ticker.lastPrice)] as const,
        )
        .filter(([, price]) => Number.isFinite(price) && price > 0),
    );
    if (prices.size === 0) return;

    // Keep a 24-hour grace period after hour 72. The ticker's actual
    // observation time is retained, while its capped sample hour becomes 72.
    const windowStart = new Date(observedAt.getTime() - 96 * 60 * 60 * 1000);
    const signals = await db
      .select({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
        status: trackedSignalsTable.status,
        isShort: trackedSignalsTable.isShort,
        exitPrice: trackedSignalsTable.exitPrice,
        closedAt: trackedSignalsTable.closedAt,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          inArray(trackedSignalsTable.status, [
            ...POST_CLOSE_TERMINAL_STATUSES,
          ]),
          isNotNull(trackedSignalsTable.closedAt),
          gte(trackedSignalsTable.closedAt, windowStart),
          lte(trackedSignalsTable.closedAt, observedAt),
          isNotNull(trackedSignalsTable.exitPrice),
          gt(trackedSignalsTable.exitPrice, 0),
        ),
      );

    const values: (typeof buStopFollowupSnapshotsTable.$inferInsert)[] = [];
    for (const signal of signals) {
      const price = prices.get(signal.symbol);
      if (price == null) continue;
      const snapshot = buildPostCloseFollowupSnapshot(
        signal,
        price,
        observedAt,
      );
      if (snapshot) values.push(snapshot);
    }

    if (values.length === 0) return;
    const inserted = await dbWriteBestEffort(
      "post-close-followup/snapshots",
      () =>
        db
          .insert(buStopFollowupSnapshotsTable)
          .values(values)
          .onConflictDoNothing({
            target: [
              buStopFollowupSnapshotsTable.trackedSignalId,
              buStopFollowupSnapshotsTable.hourAfterClose,
            ],
          })
          .returning({ id: buStopFollowupSnapshotsTable.id }),
    );
    logger.info(
      { candidates: values.length, inserted: inserted?.length ?? 0 },
      "Post-close hourly follow-up snapshots written",
    );
  } catch (err) {
    logger.warn({ err }, "Post-close hourly follow-up failed");
  }
}

/**
 * Captures the first market observation after 6h, 24h and 72h for each
 * virtual +10% → +5% profit-lock hit. It runs after actual closure too, so a
 * real trailing exit cannot hide what the market did after the virtual level.
 */
async function fillProfitLockShadowFollowUps(): Promise<void> {
  try {
    const observedAt = new Date();
    const prices = new Map(
      (await getFutureTickers())
        .map(
          (ticker) =>
            [ticker.symbol, Number.parseFloat(ticker.lastPrice)] as const,
        )
        .filter(([, price]) => Number.isFinite(price) && price > 0),
    );
    if (prices.size === 0) return;

    // Each horizon has a 24-hour grace window. No ticker coverage means no
    // synthetic zero: the missing follow-up remains visible in analytics.
    const windowStart = new Date(observedAt.getTime() - 96 * 60 * 60 * 1000);
    const hits = await db
      .select({
        signalId: signalProfitLockShadowEventsTable.signalId,
        symbol: signalProfitLockShadowEventsTable.symbol,
        sentimentKey: signalProfitLockShadowEventsTable.sentimentKey,
        isShort: signalProfitLockShadowEventsTable.isShort,
        activationPct: signalProfitLockShadowEventsTable.activationPct,
        lockedProfitPct: signalProfitLockShadowEventsTable.lockedProfitPct,
        hitAt: signalProfitLockShadowEventsTable.observedAt,
        lockedStopPrice: signalProfitLockShadowEventsTable.lockedStopPrice,
        peakPrice: signalProfitLockShadowEventsTable.peakPrice,
      })
      .from(signalProfitLockShadowEventsTable)
      .where(
        and(
          eq(signalProfitLockShadowEventsTable.eventType, "hit"),
          gte(signalProfitLockShadowEventsTable.observedAt, windowStart),
          lte(signalProfitLockShadowEventsTable.observedAt, observedAt),
        ),
      );

    const values: (typeof signalProfitLockShadowEventsTable.$inferInsert)[] =
      [];
    for (const hit of hits) {
      const currentPrice = prices.get(hit.symbol);
      if (currentPrice == null || !Number.isFinite(currentPrice)) continue;
      const entryPrice = hit.isShort
        ? hit.lockedStopPrice / (1 - hit.lockedProfitPct / 100)
        : hit.lockedStopPrice / (1 + hit.lockedProfitPct / 100);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

      const currentPnlPct = directionAwarePnl(
        entryPrice,
        currentPrice,
        hit.isShort,
      );
      const peakPrice = directionAwarePeak(
        hit.peakPrice,
        currentPrice,
        entryPrice,
        hit.isShort,
      );
      const peakPnlPct = directionAwarePnl(entryPrice, peakPrice, hit.isShort);
      for (const followUp of PROFIT_LOCK_FOLLOW_UPS) {
        if (observedAt.getTime() - hit.hitAt.getTime() < followUp.elapsedMs) {
          continue;
        }
        values.push({
          signalId: hit.signalId,
          symbol: hit.symbol,
          sentimentKey: hit.sentimentKey,
          isShort: hit.isShort,
          activationPct: hit.activationPct,
          lockedProfitPct: hit.lockedProfitPct,
          eventType: followUp.eventType,
          observedAt,
          currentPrice,
          currentPnlPct,
          peakPrice,
          peakPnlPct,
          lockedStopPrice: hit.lockedStopPrice,
          actualStatus: null,
          actualExitPrice: null,
          actualPnlPct: null,
        });
      }
    }

    if (values.length === 0) return;
    const inserted = await dbWriteBestEffort(
      "profit-lock-shadow/follow-up",
      () =>
        db
          .insert(signalProfitLockShadowEventsTable)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: signalProfitLockShadowEventsTable.id }),
    );
    logger.info(
      { candidates: values.length, inserted: inserted?.length ?? 0 },
      "Profit-lock shadow follow-up snapshots written",
    );
  } catch (err) {
    logger.warn({ err }, "Profit-lock shadow follow-up failed");
  }
}

/**
 * Reconciles missing 'close' trajectory snapshots for already-closed signals.
 * Runs once at startup. Fills gaps caused by:
 *   - Process crashes/restarts between the terminal-status commit and the
 *     recordCloseSnapshot await returning
 *   - Any transient DB errors during recordCloseSnapshot (best-effort helper)
 * Uses stored exitPrice / pnlPercent / peakPrice from tracked_signals.
 * ON CONFLICT DO NOTHING — idempotent; existing 'close' rows are not touched.
 */
async function reconcileCloseTrajectorySnapshots(): Promise<void> {
  try {
    // Drain ALL missing rows in bounded batches to avoid a single large INSERT
    // and to survive pool pressure. Continues until no missing rows remain,
    // with a max-iteration cap to prevent an infinite loop on unexpected data.
    const BATCH = 200;
    const MAX_ITERATIONS = 200; // 40,000 rows max per startup
    let totalFilled = 0;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const missing = await db
        .select({
          id: trackedSignalsTable.id,
          symbol: trackedSignalsTable.symbol,
          sentimentKey: trackedSignalsTable.sentimentKey,
          status: trackedSignalsTable.status,
          detectedAt: trackedSignalsTable.detectedAt,
          closedAt: trackedSignalsTable.closedAt,
          exitPrice: trackedSignalsTable.exitPrice,
          entryPrice: trackedSignalsTable.entryPrice,
          originalEntryPrice: trackedSignalsTable.originalEntryPrice,
          policyVersion: trackedSignalsTable.policyVersion,
          pnlPercent: trackedSignalsTable.pnlPercent,
          peakPrice: trackedSignalsTable.peakPrice,
        })
        .from(trackedSignalsTable)
        .where(
          and(
            inArray(trackedSignalsTable.status, [
              "profit",
              "stop_loss",
              "cancelled",
              "breakeven",
              "bu_stop",
            ]),
            sql`NOT EXISTS (
              SELECT 1 FROM signal_trajectory_log stl
              WHERE stl.signal_id = ${trackedSignalsTable.id}
                AND stl.interval_label = 'close'
            )`,
          ),
        )
        .limit(BATCH)
        .orderBy(sql`${trackedSignalsTable.closedAt} DESC NULLS LAST`);

      if (missing.length === 0) break;

      const rows = missing.map((r) => {
        const closedAt = r.closedAt ?? new Date();
        const elapsedMs = Math.max(
          0,
          closedAt.getTime() - r.detectedAt.getTime(),
        );
        const priceAt = r.exitPrice ?? r.entryPrice;
        const pctFromEntry =
          normalizeClosedPnlPercent(r.status, r.pnlPercent, r.sentimentKey) ??
          0;
        const peakEntryPrice =
          r.policyVersion === IMPULSE_RUNNER_POLICY_VERSION
            ? r.originalEntryPrice
            : r.entryPrice;
        const peakPct =
          r.peakPrice != null && peakEntryPrice != null && peakEntryPrice > 0
            ? ((r.peakPrice - peakEntryPrice) / peakEntryPrice) * 100
            : pctFromEntry;
        return {
          signalId: r.id,
          symbol: r.symbol,
          sentimentKey: r.sentimentKey ?? "unknown",
          intervalLabel: "close" as const,
          snapshotAt: closedAt,
          elapsedMs,
          priceAt,
          pctFromEntry,
          peakPct,
          status: r.status,
        };
      });

      await db
        .insert(signalTrajectoryLogTable)
        .values(rows)
        .onConflictDoNothing();

      totalFilled += rows.length;

      if (missing.length < BATCH) break; // last page — done
    }

    if (totalFilled > 0) {
      logger.info(
        { count: totalFilled },
        "reconcile: backfilled missing 'close' trajectory rows for terminal signals",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "reconcile: close-trajectory reconciliation failed (non-critical)",
    );
  }
}

/**
 * Replays the close-side profit-lock observation when the terminal write was
 * interrupted. This is independent from close trajectory reconciliation:
 * trajectory may have committed while the best-effort shadow write did not.
 */
async function reconcileProfitLockShadowCloseEvents(): Promise<void> {
  try {
    const BATCH = 200;
    const MAX_ITERATIONS = 200;
    let totalFilled = 0;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const missing = await db
        .select({
          id: trackedSignalsTable.id,
          symbol: trackedSignalsTable.symbol,
          sentimentKey: trackedSignalsTable.sentimentKey,
          status: trackedSignalsTable.status,
          entryPrice: trackedSignalsTable.entryPrice,
          exitPrice: trackedSignalsTable.exitPrice,
          pnlPercent: trackedSignalsTable.pnlPercent,
          peakPrice: trackedSignalsTable.peakPrice,
          isShort: trackedSignalsTable.isShort,
          trajectoryPeakPrice: sql<number | null>`CASE
            WHEN ${trackedSignalsTable.isShort} THEN (
              SELECT MIN(stl.price_at)
              FROM signal_trajectory_log stl
              WHERE stl.signal_id = ${trackedSignalsTable.id}
                AND stl.price_at IS NOT NULL
            )
            ELSE (
              SELECT MAX(stl.price_at)
              FROM signal_trajectory_log stl
              WHERE stl.signal_id = ${trackedSignalsTable.id}
                AND stl.price_at IS NOT NULL
            )
          END`,
        })
        .from(trackedSignalsTable)
        .where(
          and(
            inArray(trackedSignalsTable.status, [
              "profit",
              "stop_loss",
              "cancelled",
              "breakeven",
              "bu_stop",
            ]),
            isNotNull(trackedSignalsTable.exitPrice),
            sql`NOT EXISTS (
              SELECT 1 FROM signal_profit_lock_shadow_events pl
              WHERE pl.signal_id = ${trackedSignalsTable.id}
                AND pl.activation_pct = ${PROFIT_LOCK_ACTIVATION_PCT}
                AND pl.locked_profit_pct = ${PROFIT_LOCKED_PNL_PCT}
                AND pl.event_type = 'close'
            )`,
            sql`(
              EXISTS (
                SELECT 1 FROM signal_profit_lock_shadow_events activation
                WHERE activation.signal_id = ${trackedSignalsTable.id}
                  AND activation.activation_pct = ${PROFIT_LOCK_ACTIVATION_PCT}
                  AND activation.locked_profit_pct = ${PROFIT_LOCKED_PNL_PCT}
                  AND activation.event_type = 'activated'
              )
              OR CASE
                WHEN ${trackedSignalsTable.isShort} THEN
                  ${trackedSignalsTable.peakPrice} <= ${trackedSignalsTable.entryPrice} * 0.9
                ELSE
                  ${trackedSignalsTable.peakPrice} >= ${trackedSignalsTable.entryPrice} * 1.1
              END
              OR EXISTS (
                SELECT 1 FROM signal_trajectory_log stl
                WHERE stl.signal_id = ${trackedSignalsTable.id}
                  AND stl.price_at IS NOT NULL
                  AND CASE
                    WHEN ${trackedSignalsTable.isShort} THEN
                      stl.price_at <= ${trackedSignalsTable.entryPrice} * 0.9
                    ELSE
                      stl.price_at >= ${trackedSignalsTable.entryPrice} * 1.1
                  END
              )
            )`,
          ),
        )
        .orderBy(sql`${trackedSignalsTable.closedAt} DESC NULLS LAST`)
        .limit(BATCH);
      if (missing.length === 0) break;

      let persisted = 0;
      for (const row of missing) {
        if (
          await recordProfitLockShadowClose({
            tracked: {
              id: row.id,
              symbol: row.symbol,
              sentimentKey: row.sentimentKey,
              detectedAt: new Date(),
              entryPrice: row.entryPrice,
              peakPrice: row.isShort
                ? (row.trajectoryPeakPrice ?? row.peakPrice)
                : (row.peakPrice ?? row.trajectoryPeakPrice),
              isShort: row.isShort,
            },
            priceAt: row.exitPrice!,
            closedStatus: row.status,
          })
        ) {
          persisted++;
        }
      }
      totalFilled += persisted;
      if (persisted < missing.length || missing.length < BATCH) break;
    }
    if (totalFilled > 0) {
      logger.info(
        { count: totalFilled },
        "reconcile: backfilled missing profit-lock shadow close events",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "reconcile: profit-lock shadow close recovery failed (non-critical)",
    );
  }
}

// ── Analytics recorders — part of the Telegram claim transaction ──────────────
// The tracked-signal state, Telegram outbox row, and analytics record must commit
// together. A background INSERT after the claim can time out under pool pressure
// and permanently leave Health & Outcomes empty.
async function _recordCancelOutcomeInClaim(
  tx: TelegramPhotoOutboxTransaction,
  params: {
    signalId: number;
    symbol: string;
    sentimentKey: string | null;
    cancelReason: string;
    pnlAtCancel: number | null;
    priceAtCancel: number | null;
    entryPrice: number | null;
    sentAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO signal_cancel_outcomes
      (signal_id, symbol, sentiment_key, cancel_reason,
       pnl_at_cancel, price_at_cancel, entry_price, sent_at)
    VALUES (
      ${params.signalId}, ${params.symbol}, ${params.sentimentKey ?? ""},
      ${params.cancelReason},
      ${params.pnlAtCancel ?? null}, ${params.priceAtCancel ?? null},
      ${params.entryPrice ?? null}, ${params.sentAt}
    )
  `);
}

async function _recordHealthEventInClaim(
  tx: TelegramPhotoOutboxTransaction,
  params: {
    signalId: number;
    symbol: string;
    sentimentKey: string | null;
    messageType: PositionHealthState;
    pnlAtSend: number;
    oi30m: number | null;
    turnover: number | null;
    cvd15m: boolean | null;
    cvd30m: boolean | null;
    cvd1h: boolean | null;
    priceAtSend: number;
    entryPrice: number | null;
    sentAt: Date;
    deliveryStatus?: "delivered" | "shadow_only" | "shadow_price_v1";
    observationSource?: "telegram" | "watcher_shadow" | "watcher_price_v1";
    baselineState?: PositionHealthState;
    rawState?: PositionHealthState;
    shadowEvidence?: HealthPriceShadow;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO signal_health_events
      (signal_id, symbol, sentiment_key, message_type,
       pnl_at_send, oi_30m, turnover,
       cvd_15m, cvd_30m, cvd_1h,
       price_at_send, entry_price, sent_at, delivery_status, observation_source,
       baseline_state, raw_state, price_prior_1h_pct, price_prior_4h_pct,
       reference_1h_at, reference_4h_at, shadow_reason)
    VALUES (
      ${params.signalId}, ${params.symbol}, ${params.sentimentKey ?? ""},
      ${params.messageType},
      ${params.pnlAtSend}, ${params.oi30m}, ${params.turnover},
      ${params.cvd15m}, ${params.cvd30m}, ${params.cvd1h},
      ${params.priceAtSend}, ${params.entryPrice}, ${params.sentAt},
      ${params.deliveryStatus ?? "delivered"}, ${params.observationSource ?? "telegram"},
      ${params.baselineState ?? null}, ${params.rawState ?? null},
      ${params.shadowEvidence?.price1hPct ?? null}, ${params.shadowEvidence?.price4hPct ?? null},
      ${params.shadowEvidence?.reference1hAt ?? null}, ${params.shadowEvidence?.reference4hAt ?? null},
      ${params.shadowEvidence?.reason ?? null}
    )
  `);
}

// ── Cancel Outcomes Backfill ──────────────────────────────────────────────────
// Через 4ч / 8ч / 24ч после отмены записываем, что стало с ценой монеты.
// Каждый слот заполняется ТОЛЬКО в своём временном окне (верхняя граница важна):
// если окно пропущено из-за рестарта/даунтайма — слот остаётся NULL.
async function runCancelOutcomesBackfill(): Promise<void> {
  try {
    const result = await db.execute(sql`
      SELECT id, symbol, price_at_cancel, sent_at
      FROM signal_cancel_outcomes
      WHERE price_at_cancel IS NOT NULL
        AND (
          (price_4h_pct  IS NULL AND sent_at > NOW() - INTERVAL '8 hours'  AND sent_at <= NOW() - INTERVAL '4 hours')
          OR
          (price_8h_pct  IS NULL AND sent_at > NOW() - INTERVAL '24 hours' AND sent_at <= NOW() - INTERVAL '8 hours')
          OR
          (price_24h_pct IS NULL AND sent_at > NOW() - INTERVAL '48 hours' AND sent_at <= NOW() - INTERVAL '24 hours')
        )
      ORDER BY sent_at ASC
      LIMIT 40
    `);
    if (!result.rows.length) return;

    const bySymbol = new Map<
      string,
      Array<{
        id: number;
        priceAtCancel: number;
        sentAt: Date;
        price4hPct: unknown;
        price8hPct: unknown;
        price24hPct: unknown;
      }>
    >();
    for (const row of result.rows) {
      const sym = row.symbol as string;
      if (!bySymbol.has(sym)) bySymbol.set(sym, []);
      bySymbol.get(sym)!.push({
        id: row.id as number,
        priceAtCancel: row.price_at_cancel as number,
        sentAt: new Date(row.sent_at as string),
        price4hPct: row.price_4h_pct,
        price8hPct: row.price_8h_pct,
        price24hPct: row.price_24h_pct,
      });
    }

    let updated = 0;
    for (const [symbol, rows] of bySymbol) {
      try {
        const ticker = await getFutureTicker(symbol);
        const currentPrice = ticker ? parseFloat(ticker.lastPrice) : NaN;
        if (!currentPrice || isNaN(currentPrice)) continue;

        for (const row of rows) {
          const ageMs = Date.now() - row.sentAt.getTime();
          const pctChange =
            ((currentPrice - row.priceAtCancel) / row.priceAtCancel) * 100;
          const now = new Date();

          const needs4h =
            row.price4hPct == null &&
            ageMs >= 4 * 3_600_000 &&
            ageMs < 8 * 3_600_000;
          const needs8h =
            row.price8hPct == null &&
            ageMs >= 8 * 3_600_000 &&
            ageMs < 24 * 3_600_000;
          const needs24h =
            row.price24hPct == null &&
            ageMs >= 24 * 3_600_000 &&
            ageMs < 48 * 3_600_000;
          if (!needs4h && !needs8h && !needs24h) continue;

          await db.execute(sql`
            UPDATE signal_cancel_outcomes SET
              price_4h_pct    = CASE WHEN price_4h_pct  IS NULL AND ${needs4h}  THEN ${pctChange} ELSE price_4h_pct  END,
              price_8h_pct    = CASE WHEN price_8h_pct  IS NULL AND ${needs8h}  THEN ${pctChange} ELSE price_8h_pct  END,
              price_24h_pct   = CASE WHEN price_24h_pct IS NULL AND ${needs24h} THEN ${pctChange} ELSE price_24h_pct END,
              observed_4h_at  = CASE WHEN observed_4h_at  IS NULL AND ${needs4h}  THEN ${now} ELSE observed_4h_at  END,
              observed_8h_at  = CASE WHEN observed_8h_at  IS NULL AND ${needs8h}  THEN ${now} ELSE observed_8h_at  END,
              observed_24h_at = CASE WHEN observed_24h_at IS NULL AND ${needs24h} THEN ${now} ELSE observed_24h_at END
            WHERE id = ${row.id}
          `);
          updated++;
        }
      } catch {
        // символ недоступен — пробуем в следующем цикле
      }
    }
    if (updated > 0) {
      logger.debug({ updated }, "runCancelOutcomesBackfill: цены обновлены");
    }
  } catch (err) {
    logger.debug({ err }, "runCancelOutcomesBackfill: ошибка (non-critical)");
  }
}

// ── Health Event Backfill ─────────────────────────────────────────────────────
// Через 4ч / 8ч / 24ч после отправки СЛЕДИ/ДЕРЖИ/РАССМОТРИ записываем,
// как изменилась цена. Это основа для калибровки точности health-сообщений.
async function runHealthEventBackfill(): Promise<void> {
  try {
    // Каждый временной слот заполняется ТОЛЬКО в своё окно наблюдения.
    // Если окно пропущено (рестарт, даунтайм), слот остаётся NULL —
    // записывать устаревшую текущую цену в 4h-слот через 30 часов неверно.
    const result = await db.execute(sql`
      SELECT id, symbol, price_at_send, sent_at
      FROM signal_health_events
      WHERE price_at_send IS NOT NULL
        AND (
          (price_4h_pct  IS NULL AND sent_at > NOW() - INTERVAL '8 hours'  AND sent_at <= NOW() - INTERVAL '4 hours')
          OR
          (price_8h_pct  IS NULL AND sent_at > NOW() - INTERVAL '24 hours' AND sent_at <= NOW() - INTERVAL '8 hours')
          OR
          (price_24h_pct IS NULL AND sent_at > NOW() - INTERVAL '48 hours' AND sent_at <= NOW() - INTERVAL '24 hours')
        )
      ORDER BY sent_at ASC
      LIMIT 40
    `);
    if (!result.rows.length) return;

    // Группируем по символу для минимизации API-вызовов
    const bySymbol = new Map<
      string,
      Array<{
        id: number;
        priceAtSend: number;
        sentAt: Date;
        price4hPct: unknown;
        price8hPct: unknown;
        price24hPct: unknown;
      }>
    >();
    for (const row of result.rows) {
      const sym = row.symbol as string;
      if (!bySymbol.has(sym)) bySymbol.set(sym, []);
      bySymbol.get(sym)!.push({
        id: row.id as number,
        priceAtSend: row.price_at_send as number,
        sentAt: new Date(row.sent_at as string),
        price4hPct: row.price_4h_pct,
        price8hPct: row.price_8h_pct,
        price24hPct: row.price_24h_pct,
      });
    }

    let updated = 0;
    for (const [symbol, rows] of bySymbol) {
      try {
        const ticker = await getFutureTicker(symbol);
        const currentPrice = ticker ? parseFloat(ticker.lastPrice) : NaN;
        if (!currentPrice || isNaN(currentPrice)) continue;

        for (const row of rows) {
          const ageMs = Date.now() - row.sentAt.getTime();
          const pctChange =
            ((currentPrice - row.priceAtSend) / row.priceAtSend) * 100;
          const now = new Date();

          // Верхняя граница — если слот пропущен, не заполняем устаревшими данными
          const needs4h =
            row.price4hPct == null &&
            ageMs >= 4 * 3_600_000 &&
            ageMs < 8 * 3_600_000;
          const needs8h =
            row.price8hPct == null &&
            ageMs >= 8 * 3_600_000 &&
            ageMs < 24 * 3_600_000;
          const needs24h =
            row.price24hPct == null &&
            ageMs >= 24 * 3_600_000 &&
            ageMs < 48 * 3_600_000;
          if (!needs4h && !needs8h && !needs24h) continue;

          await db.execute(sql`
            UPDATE signal_health_events SET
              price_4h_pct    = CASE WHEN price_4h_pct  IS NULL AND ${needs4h}  THEN ${pctChange} ELSE price_4h_pct  END,
              price_8h_pct    = CASE WHEN price_8h_pct  IS NULL AND ${needs8h}  THEN ${pctChange} ELSE price_8h_pct  END,
              price_24h_pct   = CASE WHEN price_24h_pct IS NULL AND ${needs24h} THEN ${pctChange} ELSE price_24h_pct END,
              observed_4h_at  = CASE WHEN observed_4h_at  IS NULL AND ${needs4h}  THEN ${now} ELSE observed_4h_at  END,
              observed_8h_at  = CASE WHEN observed_8h_at  IS NULL AND ${needs8h}  THEN ${now} ELSE observed_8h_at  END,
              observed_24h_at = CASE WHEN observed_24h_at IS NULL AND ${needs24h} THEN ${now} ELSE observed_24h_at END
            WHERE id = ${row.id}
          `);
          updated++;
        }
      } catch {
        // символ недоступен — пропускаем, попробуем в следующем цикле
      }
    }
    if (updated > 0) {
      logger.debug({ updated }, "runHealthEventBackfill: цены обновлены");
    }
  } catch (err) {
    logger.debug({ err }, "runHealthEventBackfill: ошибка (non-critical)");
  }
}

/**
 * Fill re-entry shadow outcomes only while the corresponding observation
 * window is open. A late worker must not turn the current price into a
 * counterfeit historical observation; the NULL is the recorded missed window.
 */
export async function runReentryShadowBackfill(): Promise<void> {
  const result = await db.execute(sql`
    SELECT id, symbol, proposed_reentry_price, candidate_at, context,
           outcome_4h_pct, outcome_8h_pct, outcome_24h_pct
    FROM reentry_shadow_events
    WHERE (
      (outcome_4h_pct IS NULL AND candidate_at > NOW() - INTERVAL '8 hours'
                              AND candidate_at <= NOW() - INTERVAL '4 hours')
      OR (outcome_8h_pct IS NULL AND candidate_at > NOW() - INTERVAL '24 hours'
                               AND candidate_at <= NOW() - INTERVAL '8 hours')
      OR (outcome_24h_pct IS NULL AND candidate_at > NOW() - INTERVAL '48 hours'
                                AND candidate_at <= NOW() - INTERVAL '24 hours')
    )
    ORDER BY candidate_at ASC
    LIMIT 100
  `);
  if (!result.rows.length) return;
  const symbols = [...new Set(result.rows.map((r) => String(r.symbol)))];
  const prices = new Map<string, number>();
  for (const symbol of symbols) {
    try {
      const ticker = await getFutureTicker(symbol);
      const price = ticker ? Number(ticker.lastPrice) : NaN;
      if (Number.isFinite(price) && price > 0) prices.set(symbol, price);
    } catch {
      // A transport miss is not an outcome; leave the row for the next run.
    }
  }
  let updated = 0;
  for (const row of result.rows) {
    const now = new Date();
    const ageMs =
      now.getTime() - new Date(row.candidate_at as string).getTime();
    const price = prices.get(String(row.symbol));
    const entry = Number(row.proposed_reentry_price);
    if (!price || !Number.isFinite(entry) || entry <= 0) continue;
    let pct = ((price - entry) / entry) * 100;
    try {
      if (
        (JSON.parse(String(row.context ?? "{}")) as { isShort?: boolean })
          .isShort
      )
        pct = -pct;
    } catch {
      // Context is diagnostic only; long is the safe legacy default.
    }
    const needs4h =
      row.outcome_4h_pct == null &&
      ageMs >= 4 * 3_600_000 &&
      ageMs < 8 * 3_600_000;
    const needs8h =
      row.outcome_8h_pct == null &&
      ageMs >= 8 * 3_600_000 &&
      ageMs < 24 * 3_600_000;
    const needs24h =
      row.outcome_24h_pct == null &&
      ageMs >= 24 * 3_600_000 &&
      ageMs < 48 * 3_600_000;
    if (!needs4h && !needs8h && !needs24h) continue;
    const write = await db.execute(sql`
      UPDATE reentry_shadow_events SET
        outcome_4h_pct = CASE WHEN outcome_4h_pct IS NULL AND ${needs4h} THEN ${pct} ELSE outcome_4h_pct END,
        outcome_4h_observed_at = CASE WHEN outcome_4h_observed_at IS NULL AND ${needs4h} THEN ${now} ELSE outcome_4h_observed_at END,
        outcome_8h_pct = CASE WHEN outcome_8h_pct IS NULL AND ${needs8h} THEN ${pct} ELSE outcome_8h_pct END,
        outcome_8h_observed_at = CASE WHEN outcome_8h_observed_at IS NULL AND ${needs8h} THEN ${now} ELSE outcome_8h_observed_at END,
        outcome_24h_pct = CASE WHEN outcome_24h_pct IS NULL AND ${needs24h} THEN ${pct} ELSE outcome_24h_pct END,
        outcome_24h_observed_at = CASE WHEN outcome_24h_observed_at IS NULL AND ${needs24h} THEN ${now} ELSE outcome_24h_observed_at END
      WHERE id = ${row.id}
        AND ((outcome_4h_pct IS NULL AND ${needs4h})
          OR (outcome_8h_pct IS NULL AND ${needs8h})
          OR (outcome_24h_pct IS NULL AND ${needs24h}))
    `);
    updated += write.rowCount ?? 0;
  }
  if (updated) logger.debug({ updated }, "re-entry shadow outcomes backfilled");
}

const BU_STOP_PEAK_REPAIR_CUTOFF = new Date("2026-08-28T08:00:00.000Z");

async function repairMisclassifiedBuStopsFromPeak(): Promise<void> {
  const candidates = await dbReadWithRetry(
    "BuStopPeakRepair",
    () =>
      db
        .select()
        .from(trackedSignalsTable)
        .where(
          and(
            eq(trackedSignalsTable.status, "stop_loss"),
            gte(trackedSignalsTable.closedAt, BU_STOP_PEAK_REPAIR_CUTOFF),
            isNotNull(trackedSignalsTable.peakPrice),
          ),
        ),
    2,
    2_000,
  );
  if (!candidates.ok) {
    throw new Error("Unable to read stop-loss candidates for BE peak repair");
  }

  for (const tracked of candidates.value) {
    if (tracked.peakPrice == null) continue;
    // The +1% BTC policy applies prospectively to open positions. Historical
    // stop-loss rows predate that policy and must never be rewritten by repair.
    if (isBitcoinTrackedSignal(tracked)) continue;
    const persistedPeakPnl = computePnl(tracked, tracked.peakPrice);
    const protection = resolveBuStopProtection({
      sentimentKey: tracked.sentimentKey,
      symbol: tracked.symbol,
      lastMilestone: tracked.lastMilestone,
      persistedPeakPnlPercent: persistedPeakPnl,
    });
    if (!protection.earned) continue;

    const milestone = protection.milestone;
    const protectedProfitPct = protection.protectedProfitPct;
    const protectedExit = getProtectedBuStopExit(
      tracked.entryPrice,
      protectedProfitPct,
    );
    const protectedLabel =
      protectedProfitPct > 0
        ? `PROFIT STOP +${protectedProfitPct}%`
        : "BE STOP";
    const correctionMessage = [
      `⚠️ <b>ИСПРАВЛЕНИЕ РЕЗУЛЬТАТА — ${tracked.symbol.replace("-USDT", "")}</b>`,
      ``,
      `Сохранённый пик позиции: <b>+${persistedPeakPnl.toFixed(2)}%</b>.`,
      `Уровень защиты +${milestone}% был достигнут, поэтому обычный STOP LOSS был ошибочным.`,
      `Предыдущее сообщение STOP LOSS аннулировано.`,
      ``,
      `🛡 Итог исправлен на <b>${protectedLabel}</b>: ${fmtP(tracked.entryPrice)} → ${fmtP(protectedExit.exitPrice ?? tracked.entryPrice)} (${fmtPct(protectedExit.pnlPercent)}).`,
      ``,
      `${tickerTag(tracked.symbol)} ${patternTag(tracked.sentimentKey)} #be_stop #correction`,
    ]
      .filter(Boolean)
      .join("\n");

    const delivery = await broadcastPhotoAfterClaim(
      BU_STOP_IMG,
      correctionMessage,
      `position:${tracked.id}:bu_stop:peak-repair-v1`,
      async (tx) => {
        const claimed = await tx
          .update(trackedSignalsTable)
          .set({
            status: "bu_stop",
            exitPrice: protectedExit.exitPrice ?? tracked.entryPrice,
            pnlPercent: protectedExit.pnlPercent,
            lastMilestone: milestone,
            cancelReason: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(trackedSignalsTable.id, tracked.id),
              eq(trackedSignalsTable.status, "stop_loss"),
              gte(trackedSignalsTable.closedAt, BU_STOP_PEAK_REPAIR_CUTOFF),
            ),
          )
          .returning({ id: trackedSignalsTable.id });
        return claimed.length > 0;
      },
    );

    if (delivery.claimed) {
      logger.warn(
        {
          signalId: tracked.id,
          symbol: tracked.symbol,
          milestone,
          persistedPeakPnl,
          queued: delivery.queued,
        },
        "Misclassified stop loss repaired to BE from durable peak",
      );
    }
  }
}

async function clearTerminalPendingMilestoneState(): Promise<void> {
  const cleared = await dbWriteStrict(
    "trackedSignal/terminal-pending-milestone-cleanup",
    () =>
      db
        .update(trackedSignalsTable)
        .set({
          pendingMilestone: null,
          pendingMilestoneKind: null,
          pendingMilestonePrice: null,
          pendingMilestoneTrailingStop: null,
          pendingMilestoneStatus: null,
          pendingMilestoneLeaseUntil: null,
          updatedAt: new Date(),
        })
        .where(
          sql`${trackedSignalsTable.pendingMilestone} IS NOT NULL
            AND ${trackedSignalsTable.status} NOT IN ('active', 'in_run')`,
        )
        .returning({ id: trackedSignalsTable.id }),
  );
  if (cleared.length > 0) {
    logger.warn(
      { cleared: cleared.length },
      "Terminal pending milestone states cleared before outbox startup",
    );
  }
}

let lcStopBidTimerStarted = false;
export function startWatcher(): void {
  if (!lcStopBidTimerStarted) {
    lcStopBidTimerStarted = true;
    const run = async () => {
      try {
        const { collectLcStopBids } =
          await import("./lc-stop-bid-observations.js");
        await collectLcStopBids();
      } catch (err) {
        logger.warn({ err }, "LC stop bid sampling cycle failed");
      } finally {
        setTimeout(() => void run(), 60_000).unref();
      }
    };
    void run();
  }
  logger.info("AltBullet Watcher started");
  const deferWhileScannerActive = async (job: string): Promise<boolean> => {
    const scannerBlocker = getScannerDbAdmissionBlocker();
    if (scannerBlocker !== null) {
      logger.warn(
        { job, scannerBlocker },
        "Background job deferred by optional DB admission control",
      );
      return true;
    }
    const pool = getDbPoolSnapshot();
    if (pool.underPressure) {
      logger.warn(
        { job, pool },
        "Background job deferred because the application DB pool is under pressure",
      );
      return true;
    }
    const deferral = await getOptionalMarketJobDeferral(isScannerActive());
    if (deferral === "local-scanner") {
      logger.info(
        { job, source: "local" },
        "Background job deferred because the main scanner is active",
      );
      return true;
    }
    if (deferral === "market-cycle-lease") {
      logger.info(
        { job, source: "scheduler-lease" },
        "Background job deferred because another worker owns the market cycle",
      );
      return true;
    }
    if (deferral === "lease-unavailable") {
      // Failing open would start optional work precisely while the DB is under
      // pressure. The next timer run retries after the pool recovers.
      logger.warn(
        { job },
        "Background job deferred because scheduler lease state is unavailable",
      );
      return true;
    }
    return false;
  };
  const runOptionalDbMaintenance = async <T>(
    job: string,
    work: () => Promise<T>,
    options: { priority?: boolean } = {},
  ): Promise<boolean> => {
    if (await deferWhileScannerActive(job)) return false;
    const result = await runOptionalDbJob(
      job,
      getScannerDbAdmissionBlocker() !== null || isScannerActive(),
      work,
      options,
    );
    if (!result.ran) {
      logger.warn(
        { job, reason: result.reason },
        "Background job deferred by optional DB admission control",
      );
      return false;
    }
    return true;
  };
  const scheduleOptionalStartupDbJob = (
    job: string,
    delayMs: number,
    work: () => Promise<unknown>,
    errorMessage: string,
  ): void => {
    const run = async (): Promise<void> => {
      try {
        if (!(await runOptionalDbMaintenance(job, work))) {
          setTimeout(run, 60_000);
        }
      } catch (err) {
        logger.error({ err }, errorMessage);
        setTimeout(run, 60_000);
      }
    };
    setTimeout(() => void run(), delayMs);
  };

  scheduleOptionalStartupDbJob(
    "excluded-signal-symbol-reclassification",
    1_000,
    reclassifyOpenExcludedSignalSymbols,
    "Excluded-symbol startup reconciliation error",
  );
  scheduleOptionalStartupDbJob(
    "terminal-pending-milestone-cleanup",
    2_000,
    clearTerminalPendingMilestoneState,
    "Terminal pending milestone cleanup startup error",
  );

  // Persistent retry queue for cancellation and triggered position photos.
  // A timeout is retried from DB after restart instead of being dropped or
  // converted immediately into a duplicate text notification.
  setTimeout(() => {
    void drainTelegramPhotoOutbox().catch((err) =>
      logger.warn({ err }, "Telegram photo outbox startup drain failed"),
    );
  }, 15_000);
  setInterval(() => {
    void drainTelegramPhotoOutbox().catch((err) =>
      logger.warn({ err }, "Telegram photo outbox drain failed"),
    );
  }, 2 * 60_000);

  const runAltBulletSnapshotRecovery = async () => {
    try {
      let reclaimed = 0;
      await runOptionalDbMaintenance(
        "altbullet-snapshot-recovery",
        async () => {
          reclaimed = await reconcileAltBulletIndicatorSnapshots();
        },
      );
      if (reclaimed > 0) {
        logger.info(
          { reclaimed },
          "AltBullet Neon snapshot recovery scheduled",
        );
      }
    } catch (err) {
      logger.warn({ err }, "AltBullet Neon snapshot recovery failed");
    }
  };
  setTimeout(() => void runAltBulletSnapshotRecovery(), 30_000);
  setInterval(() => void runAltBulletSnapshotRecovery(), 5 * 60_000);

  // Historical analysis is intentionally optional: it never contends with an
  // owner scan, and each run repairs only a small idempotent batch.
  let patternDecisionHistoryTimer: ReturnType<typeof setTimeout> | null = null;
  let patternDecisionHistoryRunning = false;
  const schedulePatternDecisionHistory = (delayMs: number): void => {
    if (patternDecisionHistoryTimer) clearTimeout(patternDecisionHistoryTimer);
    patternDecisionHistoryTimer = setTimeout(
      () => void runPatternDecisionHistory(),
      delayMs,
    );
  };
  // Taker backfill for decisions whose live snapshot missed it. Own timer so
  // it is not starved by the history job; CoinGlass admission paces requests.
  const runDecisionTakerBackfill = async () => {
    try {
      if (!getDbPoolSnapshot().underPressure) {
        const { backfillDecisionTaker } = await import("./taker-backfill.js");
        await backfillDecisionTaker();
      }
    } catch (err) {
      logger.warn({ err }, "Decision taker backfill failed");
    } finally {
      setTimeout(() => void runDecisionTakerBackfill(), 60_000).unref();
    }
  };
  setTimeout(() => void runDecisionTakerBackfill(), 90_000).unref();
  let patternDecisionHistoryLastRunAt = Date.now();
  const PATTERN_HISTORY_STARVATION_MS = 30 * 60_000;
  const runPatternDecisionHistory = async () => {
    if (patternDecisionHistoryRunning) return;
    patternDecisionHistoryRunning = true;
    let ran = false;
    // Owner policy: backfill must not starve behind an always-busy scanner.
    // After 30 minutes without a completed run, one bounded batch runs anyway
    // (still skipped under DB pool pressure).
    const starved =
      Date.now() - patternDecisionHistoryLastRunAt >
      PATTERN_HISTORY_STARVATION_MS;
    const deferUnlessStarved = async (job: string) =>
      starved
        ? getDbPoolSnapshot().underPressure
        : deferWhileScannerActive(job);
    try {
      const historyWork = async () => {
        const classified =
          await classifyUnfillablePatternDecisionTrajectories();
        if (await deferUnlessStarved("pattern-decision-history")) {
          logger.info(
            { classified },
            "Pattern decision history yielded to scanner after classification",
          );
          return;
        }
        const snapshots = await reconcilePatternDecisionSnapshots();
        if (await deferUnlessStarved("pattern-decision-history")) {
          logger.info(
            { snapshots, classified },
            "Pattern decision history yielded to scanner before market backfill",
          );
          return;
        }
        const candles = await backfillPatternDecisionTrajectories();
        logger.info(
          { snapshots, candles, classified },
          "Pattern decision history reconciliation completed",
        );
        patternDecisionHistoryLastRunAt = Date.now();
      };
      if (starved) {
        logger.warn(
          { sinceMs: Date.now() - patternDecisionHistoryLastRunAt },
          "Pattern decision history starved; running one bounded batch",
        );
        if (getDbPoolSnapshot().underPressure) {
          ran = false;
        } else {
          await historyWork();
          ran = true;
        }
      } else {
        ran = await runOptionalDbMaintenance(
          "pattern-decision-history",
          historyWork,
          { priority: true },
        );
      }
    } catch (err) {
      logger.warn({ err }, "Pattern decision history reconciliation failed");
    } finally {
      patternDecisionHistoryRunning = false;
      schedulePatternDecisionHistory(ran ? 60_000 : 20_000);
    }
  };
  schedulePatternDecisionHistory(45_000);

  // Whale Index (BTC, 4h) — фоновый кэш для строки контекста в Telegram-алертах.
  startWhaleIndexUpdater();

  // Shadow-only technical context for Stealth Breakout calibration. It is
  // deliberately independent from the owner dashboard, bounded to 24 symbols
  // and deferred while the main market cycle owns the network budget.
  const runBreakoutShadowCapture = async () => {
    try {
      if (await deferWhileScannerActive("breakout-analysis-shadow")) return;
      const lease = await withMarketCycleLease(
        "breakout-analysis-shadow",
        captureBreakoutAnalysisShadowSnapshot,
        { ttlMs: 10 * 60_000, heartbeatMs: 2 * 60_000 },
      );
      if (!lease.acquired) return;
      logger.info(
        { captured: lease.value },
        "Breakout analysis shadow snapshot captured",
      );
    } catch (err) {
      logger.warn({ err }, "Breakout analysis shadow snapshot failed");
    }
  };
  const scheduleBreakoutShadowCapture = (delayMs: number) => {
    breakoutAnalysisShadowTimer = setTimeout(async () => {
      await runBreakoutShadowCapture();
      scheduleBreakoutShadowCapture(30 * 60_000);
    }, delayMs);
  };
  scheduleBreakoutShadowCapture(30_000);

  // cleanupPowerCollisionArtifacts (см. выше) — одноразовая чистка POWER-USDT
  // сигнала/снимков, испорченных CoinGlass ticker-collision (2026-07-10).
  // Заменена на общую cleanupOiCollisionArtifacts ниже, которая покрывает
  // POWER заодно со всеми остальными символами — оставлена как no-op ссылка.
  // Идемпотентно: после первого прогона status уже не active/in_run и
  // oi_usd уже NULL — повторные рестарты no-op.
  scheduleOptionalStartupDbJob(
    "power-collision-cleanup",
    7_000,
    cleanupPowerCollisionArtifacts,
    "POWER collision cleanup startup error",
  );

  // cleanupOiCollisionArtifacts — теперь узкий whitelist из 5 вручную
  // подтверждённых символов (см. комментарий у функции, 2026-07-10). Первая
  // версия сканировала ВСЕ символы по ratio и ложно обнулила ~300 легитимных
  // тикеров + отменила APE-USDT — см. restoreFalseApeCancellation ниже.
  scheduleOptionalStartupDbJob(
    "oi-collision-cleanup",
    8_000,
    cleanupOiCollisionArtifacts,
    "OI collision cleanup startup error",
  );

  // Разовое исправление ложной отмены APE-USDT сломанной версией
  // cleanupOiCollisionArtifacts (2026-07-10). Идемпотентно — см. функцию.
  scheduleOptionalStartupDbJob(
    "ape-cancellation-restore",
    9_000,
    restoreFalseApeCancellation,
    "APE restore startup error",
  );

  // Разовое восстановление FF-USDT, ошибочно отменённого stale_oi_vol.
  // Идемпотентно — см. restoreFalseStealthBreakoutCancellation выше.
  scheduleOptionalStartupDbJob(
    "stealth-breakout-cancellation-restore",
    9_000,
    restoreFalseStealthBreakoutCancellation,
    "FF-USDT restore startup error",
  );

  scheduleOptionalStartupDbJob(
    "stealth-breakout-neutral-reclassification",
    10_000,
    reclassifyFalseStealthBreakouts,
    "Stealth false-breakout reclassification startup error",
  );

  scheduleOptionalStartupDbJob(
    "1000bonk-stealth-observation-correction",
    10_500,
    moveInvalid1000BonkStealthToObservation,
    "1000BONK Stealth observation correction startup error",
  );

  scheduleOptionalStartupDbJob(
    "bu-stop-peak-repair",
    11_000,
    repairMisclassifiedBuStopsFromPeak,
    "BE peak repair startup error",
  );

  // Одноразовая очистка signals от мёртвых паттернов (oi24h_accumulation и др.,
  // 2026-07-15). Только таблица signals — tracked_signals не трогаем. Идемпотентно.
  scheduleOptionalStartupDbJob(
    "dead-pattern-cleanup",
    12_000,
    async () => {
      await cleanupDeadPatternSignals();
      // cleanupDeadPatternSignals leaves tracked_signals intact; clean matching
      // legacy positions only after their source rows are handled.
      await cancelDeadPatternTrackedSignals();
    },
    "Dead pattern cleanup startup error",
  );

  // Close-trajectory reconciliation — backfills 'close' rows for terminal signals
  // that lost their snapshot due to a crash/restart between status commit and write.
  // Runs at 20s (after cleanup jobs at 7–12s settle) and uses stored exit data.
  const runCloseTrajectoryStartupRecovery = async () => {
    try {
      const ran = await runOptionalDbMaintenance(
        "close-trajectory-reconciliation",
        async () => {
          await reconcileCloseTrajectorySnapshots();
          await reconcileProfitLockShadowCloseEvents();
        },
      );
      if (!ran) {
        setTimeout(runCloseTrajectoryStartupRecovery, 60_000);
      }
    } catch (err) {
      logger.warn(
        { err },
        "Close trajectory / profit-lock reconciliation startup error",
      );
    }
  };
  setTimeout(runCloseTrajectoryStartupRecovery, 20_000);

  // Бэкафилл oi_daily_snapshots за 2026-07-08/07-09 (и 07-10 если отсутствует)
  // для ~376 символов, обнулённых сломанной cleanupOiCollisionArtifacts.
  // Тянет реальную историю из CoinGlass aggregated-history вместо ожидания
  // 3 суток естественного накопления. Идемпотентно — обрабатывает только
  // строки с oi_usd IS NULL. См. oiHistoryBackfill.ts.
  // Запуск отложен на 18 мин — сразу после старта Neon-пул насыщен первым
  // сканом (~14 мин, см. startup-positions-timer.md), ранний старт бэкафилла
  // ловил "timeout exceeded when trying to connect" и падал целиком.
  const runOiHistoryStartupBackfill = async () => {
    try {
      const ran = await runOptionalDbMaintenance(
        "oi-history-backfill",
        backfillOiHistoryAfterCollisionCleanup,
      );
      if (!ran) {
        setTimeout(runOiHistoryStartupBackfill, 60_000);
      }
    } catch (err) {
      logger.error({ err }, "OI history backfill startup error");
    }
  };
  setTimeout(runOiHistoryStartupBackfill, 18 * 60_000);

  // Startup reset — проверяем стоп-лоссы и трейлинги пропущенные за время простоя.
  // Запуск 1: через 10с (BingX API ещё может быть холодным — внутри retry 3×3s).
  // Запуск 2: через 3 мин — страховочный прогон если первый упал на API таймауте.
  setTimeout(async () => {
    try {
      await runStartupReset();
    } catch (err) {
      logger.error({ err }, "Startup reset #1 error");
    }
  }, 10_000);

  setTimeout(async () => {
    try {
      await runStartupReset();
    } catch (err) {
      logger.error({ err }, "Startup reset #2 error");
    }
    logger.info("Startup reset #2 complete (safety net)");
  }, 3 * 60_000);

  // Public BingX `@lastPrice` ticks protect every long in-run position,
  // including activation and peak changes between two-minute snapshots.
  const trailingMonitorGeneration = realtimeTrailingMonitorFence.start();
  realtimeTrailingPriceStream = createBingXLastPriceStream({
    onPrice: (update) => {
      handleMilestoneWakeTick(update);
      return handleRealtimeTrailingPrice(
        update,
        trailingMonitorGeneration,
      ).catch((err) =>
        logger.warn(
          { err, symbol: update.symbol },
          "Realtime trailing price handler failed",
        ),
      );
    },
    onStatus: (status, detail) => {
      const payload = detail ? { detail } : {};
      if (status === "disconnected") {
        logger.warn(payload, "Realtime trailing price stream disconnected");
      } else {
        logger.info(payload, `Realtime trailing price stream ${status}`);
      }
    },
  });
  const refreshRealtimeTrailingCandidates = async () => {
    if (!isRealtimeTrailingMonitorCurrent(trailingMonitorGeneration)) return;
    try {
      const trailingFetch = await dbReadWithRetry(
        "RealtimeTrailingPrice",
        () =>
          db
            .select()
            .from(trackedSignalsTable)
            .where(eq(trackedSignalsTable.status, "in_run")),
        2,
        2_000,
      );
      if (trailingFetch.ok) {
        syncRealtimeTrailingCandidates(
          trailingFetch.value,
          trailingMonitorGeneration,
        );
      }
      await recoverTelegramPhotoRecipientResolution(() =>
        getTargets({ strict: true }),
      );
    } catch (err) {
      logger.warn({ err }, "Realtime trailing candidate refresh failed");
    }
    if (!isRealtimeTrailingMonitorCurrent(trailingMonitorGeneration)) {
      return;
    }
    realtimeTrailingPriceTimer = setTimeout(
      refreshRealtimeTrailingCandidates,
      REALTIME_TRAILING_REFRESH_MS,
    );
  };
  void refreshRealtimeTrailingCandidates();
  logger.info(
    { refreshSeconds: REALTIME_TRAILING_REFRESH_MS / 1000 },
    "Realtime trailing price monitor scheduled",
  );

  // Fast cycle every 2 min — active + in_run (stop-loss, first target, trailing).
  // OI Watch вынесен в отдельный таймер ниже — он не блокирует fast-цикл.
  // Причина: runOiWatchCycle делает sequential getCoinglassOI() на каждый кандидат
  // (await в for-цикле) → при CG-таймаутах 8-10с × N кандидатов добавлял 60-120с
  // к реальному интервалу, из-за чего milestone/стоп проверялись раз в 5-7 мин.
  const runFast = async () => {
    if (!fastTimer) return;
    try {
      await runFastCycleExclusive();
    } catch (err) {
      logger.error({ err }, "FastCycle error");
    }
    _jobTimings.fastCycle.lastRunAt = Date.now();
    fastTimer = setTimeout(runFast, FAST_CYCLE_MS);
  };
  // First fast cycle at 2 min (after startup reset at 5s)
  fastTimer = setTimeout(runFast, FAST_CYCLE_MS);

  // Stealth re-entry after a Range-return cancel (owner 2026-10-21): own timer,
  // so slow aggregated-volume lookups never delay the stop/target fast cycle.
  const runStealthReentry = async () => {
    if (!stealthReentryTimer) return;
    try {
      await runStealthRangeReentries({
        trackSignal: (params) =>
          trackSignal(params as unknown as Parameters<typeof trackSignal>[0]),
        discardUntrackedSignal,
        broadcastSignalAlert,
        getLivePrice: async (symbol) => {
          const t = await getFutureTicker(symbol);
          const p = t ? Number.parseFloat(t.lastPrice) : NaN;
          return Number.isFinite(p) && p > 0 ? p : null;
        },
      });
    } catch (err) {
      logger.error({ err }, "Stealth re-entry cycle error");
    }
    if (stealthReentryTimer) {
      stealthReentryTimer = setTimeout(runStealthReentry, FAST_CYCLE_MS);
    }
  };
  stealthReentryTimer = setTimeout(runStealthReentry, FAST_CYCLE_MS);

  // Stealth fresh-24H-high (🧪 experimental): +1R → B.U., then 1R trailing.
  const runStealthFreshHighProtectionTick = async () => {
    if (!stealthFreshHighProtectionTimer) return;
    try {
      await runStealthFreshHighProtection(async (symbol) => {
        const t = await getFutureTicker(symbol);
        const p = t ? Number.parseFloat(t.lastPrice) : NaN;
        return Number.isFinite(p) && p > 0 ? p : null;
      });
    } catch (err) {
      logger.error({ err }, "Stealth fresh-high protection cycle error");
    }
    if (stealthFreshHighProtectionTimer) {
      stealthFreshHighProtectionTimer = setTimeout(
        runStealthFreshHighProtectionTick,
        STEALTH_FH_PROTECTION_INTERVAL_MS,
      );
    }
  };
  stealthFreshHighProtectionTimer = setTimeout(
    runStealthFreshHighProtectionTick,
    STEALTH_FH_PROTECTION_INTERVAL_MS,
  );
  logger.info(
    { intervalMin: FAST_CYCLE_MS / 60000 },
    "Fast cycle started (active + in_run, 2min) — OI Watch на отдельном таймере",
  );

  // OI Watch cycle — независимый таймер 4 мин, не блокирует fast-цикл.
  // Проверяет кандидатов в oi_watch очереди на volume/price подтверждение.
  const OI_WATCH_CYCLE_MS = 4 * 60 * 1000; // 4 минуты
  const runOiWatch = async () => {
    if (!oiWatchTimer) return;
    if (!(await deferWhileScannerActive("oi-watch"))) {
      try {
        await runOiWatchCycle();
      } catch (err) {
        logger.error({ err }, "OiWatchCycle error");
      }
    }
    oiWatchTimer = setTimeout(runOiWatch, OI_WATCH_CYCLE_MS);
  };
  // OI Watch стартует через 3 мин (после первого fast-цикла)
  oiWatchTimer = setTimeout(runOiWatch, 3 * 60 * 1000);
  logger.info(
    { intervalMin: OI_WATCH_CYCLE_MS / 60000 },
    "OI Watch cycle started (independent timer, 4min)",
  );

  // Hourly retrospective price snapshots for rejected candidates and closed
  // signals. Missed Movers collection was retired to reduce market and DB load.
  // Стартует через 65 мин (clear of first scan pool stress: ~14 мин первый скан).
  const SIGNAL_OUTCOMES_INTERVAL_MS = 60 * 60_000; // 1 час
  const runSignalOutcomesBackfill = async () => {
    if (!signalOutcomesTimer) return;
    try {
      await runOptionalDbMaintenance("signal-outcomes-backfill", async () => {
        await fillMissedCandidatePrices({
          sourceLike: "liq_cascade_watch:%",
          label: "LiqCascade",
        });
        await fillMissedCandidatePrices({
          sourceLike: "bullish_accumulation:p24h_gt_5:%",
          label: "BullishAccumulation",
        });
        await fillMissedCandidatePrices({
          sourceLike: "impulse_buy:shadow:%",
          label: "ImpulseBuy",
        });
        await reconcileProfitLockShadowCloseEvents();
        await fillProfitLockShadowFollowUps();
        await fillCancellationPrice72hAfterExit();
      });
    } catch (err) {
      logger.warn({ err }, "signal outcomes backfill timer error");
    }
    signalOutcomesTimer = setTimeout(
      runSignalOutcomesBackfill,
      SIGNAL_OUTCOMES_INTERVAL_MS,
    );
  };
  signalOutcomesTimer = setTimeout(runSignalOutcomesBackfill, 65 * 60_000);
  logger.info(
    { firstRunMin: 65, intervalMin: SIGNAL_OUTCOMES_INTERVAL_MS / 60000 },
    "Signal outcomes backfill timer started",
  );

  // Post-close 72h hourly trajectory runs on its own timer (not behind the
  // optional-maintenance admission or the 65-min first delay): in production
  // no snapshot was written after 2026-09-30 because that path never ran.
  const POST_CLOSE_FOLLOWUP_INTERVAL_MS = 10 * 60_000;
  const runPostCloseFollowup = async () => {
    if (!postCloseFollowupTimer) return;
    try {
      await fillPostCloseFollowupSnapshots();
    } catch (err) {
      logger.warn({ err }, "post-close follow-up timer error");
    }
    postCloseFollowupTimer = setTimeout(
      runPostCloseFollowup,
      POST_CLOSE_FOLLOWUP_INTERVAL_MS,
    );
  };
  postCloseFollowupTimer = setTimeout(runPostCloseFollowup, 3 * 60_000);

  // Subscription expiry — каждую минуту: деактивирует истёкших подписчиков и
  // блокирует dashboard_users, срок подписки которых прошёл.
  // Отправка и доступ проверяют точную дату независимо от этого job; таймер
  // материализует те же semantics в status/active не позднее чем через минуту.
  const SUBSCRIPTION_EXPIRY_INTERVAL_MS = 60_000;
  const runSubscriptionExpiry = async () => {
    if (!subscriptionExpiryTimer) return;
    try {
      await runSubscriptionExpiryJob();
    } catch (err) {
      logger.error({ err }, "subscriptionExpiryJob error");
    }
    subscriptionExpiryTimer = setTimeout(
      runSubscriptionExpiry,
      SUBSCRIPTION_EXPIRY_INTERVAL_MS,
    );
  };
  subscriptionExpiryTimer = setTimeout(runSubscriptionExpiry, 30_000);
  logger.info(
    { firstRunSeconds: 30, intervalSeconds: 60 },
    "Subscription expiry job scheduled",
  );

  // Subscription warning — каждый час проверяет, чья подписка истекает
  // примерно через 3 часа, и отправляет предупреждение с картинкой.
  const runSubscriptionWarning = async () => {
    try {
      await runSubscriptionWarningJob();
    } catch (err) {
      logger.error({ err }, "subscriptionWarningJob error");
    }
    setTimeout(runSubscriptionWarning, SUBSCRIPTION_EXPIRY_INTERVAL_MS);
  };
  setTimeout(runSubscriptionWarning, 6 * 60_000); // первый запуск через 6 мин
  logger.info("Subscription warning job scheduled (1h, first run at 6min)");

  // Layer 10 Liquidation Cascade Watch — сканирует ВСЕ тикеры каждые 3 мин.
  // Детектирует лонг-ликвидационные спайки → пул liq_cascade_watch.
  // После каждого цикла _runLiqCascadeFireCycle() проверяет пул и выдаёт
  // liquidation_cascade сигнал напрямую (Path B, без инжекта в основной скан).
  // Первый запуск через 5 мин (после первого скана уже есть тикеры).
  const LIQ_CASCADE_INTERVAL_MS = 3 * 60_000; // 3 мин
  let liqCascadeTimer: ReturnType<typeof setTimeout> | null = null;
  const runLiqCascade = async () => {
    if (!liqCascadeTimer) return;
    if (await deferWhileScannerActive("liq-cascade-watcher")) {
      liqCascadeTimer = setTimeout(runLiqCascade, LIQ_CASCADE_INTERVAL_MS);
      return;
    }
    try {
      await runLiqCascadeWatcherJob(
        (sym) => getPrescanEntry(sym)?.cycleCount ?? null,
      );
    } catch (err) {
      logger.error({ err }, "LiqCascadeWatcherJob error");
    }
    if (!(await deferWhileScannerActive("liq-cascade-fire"))) {
      try {
        await _runLiqCascadeFireCycle();
      } catch (err) {
        logger.error({ err }, "LiqCascadeFireCycle error");
      }
    }
    _jobTimings.liqCascade.lastRunAt = Date.now();
    liqCascadeTimer = setTimeout(runLiqCascade, LIQ_CASCADE_INTERVAL_MS);
  };
  liqCascadeTimer = setTimeout(runLiqCascade, 5 * 60_000);
  logger.info("Layer 10 Liq Cascade Watch scheduled (3min, first run at 5min)");

  // Price24h refresh every 20 min — пересчитывает lastPrice24h через 1h klines.
  // BingX ticker priceChangePercent считается от суточной свечи (UTC midnight), а не
  // от реального 24h назад. Первый запуск через 25 мин (после окончания первого скана).
  const PRICE24H_REFRESH_INTERVAL_MS = 20 * 60_000;
  let price24hRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const runPrice24hRefresh = async () => {
    if (!price24hRefreshTimer) return;
    if (!(await deferWhileScannerActive("price24h-refresh"))) {
      try {
        await runPrice24hRefreshCycle();
      } catch (err) {
        logger.error({ err }, "Price24hRefreshCycle error");
      }
    }
    _jobTimings.price24hRefresh.lastRunAt = Date.now();
    price24hRefreshTimer = setTimeout(
      runPrice24hRefresh,
      PRICE24H_REFRESH_INTERVAL_MS,
    );
  };
  price24hRefreshTimer = setTimeout(runPrice24hRefresh, 25 * 60_000);
  logger.info("Price24h refresh scheduled (20min, first run at 25min)");

  // Entry-metrics backfill — заполняет null-метрики входа (WI/OB/OI/Taker/BW/SpBW/CVD/FR)
  // для открытых позиций И недавно закрытых (48ч) — история тоже должна быть полной.
  // Каждые 10 мин: сигнал может закрыться быстрее, чем 30-минутный цикл до него дойдёт.
  const BACKFILL_INTERVAL_MS = 10 * 60_000;
  let backfillTimer: ReturnType<typeof setTimeout> | null = null;
  const runBackfill = async () => {
    if (!backfillTimer) return;
    try {
      await runOptionalDbMaintenance(
        "entry-metrics-backfill",
        refreshNullEntryMetrics,
      );
    } catch (err) {
      logger.error({ err }, "refreshNullEntryMetrics error");
    }
    _jobTimings.backfill.lastRunAt = Date.now();
    backfillTimer = setTimeout(runBackfill, BACKFILL_INTERVAL_MS);
  };
  backfillTimer = setTimeout(runBackfill, 18 * 60_000);
  logger.info("Entry-metrics backfill scheduled (10min, first run at 18min)");

  // Health events price backfill — каждые 15 мин, первый запуск через 22 мин
  // (после стабилизации пула Neon). Заполняет price_4h_pct/8h/24h в signal_health_events.
  const HEALTH_BACKFILL_INTERVAL_MS = 15 * 60_000;
  let healthBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  const runHealthBackfill = async () => {
    if (!healthBackfillTimer) return;
    try {
      await runOptionalDbMaintenance(
        "health-events-backfill",
        runHealthEventBackfill,
      );
    } catch (err) {
      logger.warn({ err }, "runHealthEventBackfill error");
    }
    healthBackfillTimer = setTimeout(
      runHealthBackfill,
      HEALTH_BACKFILL_INTERVAL_MS,
    );
  };
  healthBackfillTimer = setTimeout(runHealthBackfill, 22 * 60_000);
  logger.info("Health events backfill scheduled (15min, first run at 22min)");

  // Re-entry is shadow-only, but its forward outcomes are durable research
  // telemetry. Keep the same bounded-window semantics as health backfill.
  const REENTRY_BACKFILL_INTERVAL_MS = 15 * 60_000;
  let reentryBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  const runReentryBackfill = async () => {
    if (!reentryBackfillTimer) return;
    try {
      await runOptionalDbMaintenance(
        "reentry-shadow-backfill",
        runReentryShadowBackfill,
      );
    } catch (err) {
      logger.warn({ err }, "runReentryShadowBackfill error");
    }
    reentryBackfillTimer = setTimeout(
      runReentryBackfill,
      REENTRY_BACKFILL_INTERVAL_MS,
    );
  };
  reentryBackfillTimer = setTimeout(runReentryBackfill, 22 * 60_000);
  logger.info("Re-entry shadow outcomes backfill scheduled (15min)");

  // Cancel outcomes price backfill — каждые 15 мин, первый запуск через 24 мин
  const CANCEL_BACKFILL_INTERVAL_MS = 15 * 60_000;
  let cancelBackfillTimer: ReturnType<typeof setTimeout> | null = null;
  const runCancelBackfill = async () => {
    if (!cancelBackfillTimer) return;
    try {
      await runOptionalDbMaintenance(
        "cancel-outcomes-backfill",
        runCancelOutcomesBackfill,
      );
    } catch (err) {
      logger.warn({ err }, "runCancelOutcomesBackfill error");
    }
    cancelBackfillTimer = setTimeout(
      runCancelBackfill,
      CANCEL_BACKFILL_INTERVAL_MS,
    );
  };
  cancelBackfillTimer = setTimeout(runCancelBackfill, 24 * 60_000);
  logger.info("Cancel outcomes backfill scheduled (15min, first run at 24min)");

  // Watcher cycle every 10 min — handles ONLY accumulation signals.
  // Starts at 14 min (NOT 7 min) — первый скан 551 токена занимает ~10мин и
  // исчерпывает Neon connection pool. При старте в 7 мин все DB-запросы (watcher,
  // fastcycle, restart notif, positions) падают с "connection timeout". 14 мин —
  // надёжный зазор после окончания первого скана.
  const runCycle = async () => {
    if (!cycleTimer) return;
    if (!(await deferWhileScannerActive("watcher-cycle"))) {
      try {
        const r = await runWatcherCycle();
        logger.info(r, "Watcher cycle complete");
      } catch (err) {
        logger.error({ err }, "Watcher cycle error");
      }
    }
    _jobTimings.watcherCycle.lastRunAt = Date.now();
    cycleTimer = setTimeout(runCycle, 10 * 60 * 1000);
  };
  cycleTimer = setTimeout(runCycle, 14 * 60 * 1000);

  // Уведомление о рестарте — через 2 мин после старта.
  // Канал (_channelIdCache) закэширован при startWatcher → нет DB-запроса на старте.
  // Near-stop warning — через 4 мин (DB уже доступна, пул стабилен после первого прогрева).
  if (process.env.NODE_ENV !== "development") {
    setTimeout(() => {
      sendBotRestartNotification().catch((err) =>
        logger.warn({ err }, "Restart notification failed (non-critical)"),
      );
    }, 2 * 60_000);
    setTimeout(() => {
      sendNearStopWarning().catch((err) =>
        logger.warn({ err }, "Near-stop warning failed (non-critical)"),
      );
    }, 4 * 60_000);
  }

  // Daily at 22:00 Самара = 18:00 UTC
  const scheduleDaily = () => {
    const ms = msUntilUtc(18, 0);
    const nextAt = new Date(Date.now() + ms).toISOString();
    logger.info({ nextAt }, "Daily report scheduled (22:00 Самара)");
    dailyTimer = setTimeout(async () => {
      try {
        await sendDailyReport();
      } catch (err) {
        logger.error({ err }, "Daily report error");
      }
      // TTL: удаляем prescan_snapshots старше 14 дней (накапливается ~65K строк/день)
      try {
        await db
          .delete(prescanSnapshotsTable)
          .where(
            sql`${prescanSnapshotsTable.cycleAt} < NOW() - INTERVAL '14 days'`,
          );
        logger.info("prescan_snapshots TTL cleanup done (>14 days)");
      } catch (err) {
        logger.warn({ err }, "prescan_snapshots TTL cleanup failed");
      }
      scheduleDaily();
    }, ms);
  };
  scheduleDaily();

  // ── Missed-report guard ───────────────────────────────────────────────────────
  // Ловим два случая пропуска:
  // 1. Перезапуск ПОСЛЕ 18:00 UTC сегодня — отчёт за сегодня не отправлен.
  // 2. Перезапуск утром (до 18:00 UTC) — но вчерашний отчёт тоже не отправлен.
  // Задержка 90с: продакшн-DB иногда требует 30–60с на холодный reconnect.
  // При ошибке DB — retry через 60с (до 3 попыток).
  const runDailyGuard = async (attempt = 1): Promise<void> => {
    try {
      const nowUtc = new Date();

      // Порог за сегодня (18:00 UTC = 22:00 Самара)
      const todayReportUtc = new Date(nowUtc);
      todayReportUtc.setUTCHours(18, 0, 0, 0);

      // Порог за вчера (18:00 UTC вчерашнего дня)
      const yesterdayReportUtc = new Date(todayReportUtc);
      yesterdayReportUtc.setUTCDate(yesterdayReportUtc.getUTCDate() - 1);

      const settings = await db.select().from(settingsTable).limit(1);
      const lastSent = settings[0]?.lastDailyReportAt;

      // Буфер 5 мин: setTimeout может сработать на несколько мс раньше цели →
      // timestamp пишется как 18:59:59.xxx → guard считает вчерашний отчёт пропущенным.
      const REPORT_BUFFER_MS = 5 * 60 * 1000;

      // Пропущен сегодняшний отчёт: уже после 18:00 UTC, но не отправляли с 17:55
      const missedToday =
        nowUtc >= todayReportUtc &&
        (!lastSent ||
          lastSent < new Date(todayReportUtc.getTime() - REPORT_BUFFER_MS));

      // Пропущен вчерашний отчёт: последний раз отправляли раньше 18:55 вчера
      const missedYesterday =
        !lastSent ||
        lastSent < new Date(yesterdayReportUtc.getTime() - REPORT_BUFFER_MS);

      if (!missedToday && !missedYesterday) {
        logger.info(
          { lastSent },
          "Daily report guard: всё в порядке, пропуска нет",
        );
        return;
      }

      logger.warn(
        { lastSent, nowUtc, missedToday, missedYesterday },
        "Missed daily report detected — sending now",
      );
      await sendDailyReport();
    } catch (err) {
      logger.error({ err, attempt }, "Missed-report guard error");
      if (attempt < 3) {
        logger.info(
          { nextAttempt: attempt + 1 },
          "Missed-report guard: retry in 60s",
        );
        setTimeout(() => runDailyGuard(attempt + 1), 60_000);
      }
    }
  };
  setTimeout(() => runDailyGuard(), 90_000); // 90с после старта — даём DB восстановить соединение

  // ── Missed-weekly guard ───────────────────────────────────────────────────────
  // Если сервер перезапустился в воскресенье после 10:00 Самара (06:00 UTC) и дайджест
  // ещё не был отправлен на этой неделе — отправляем через 120с после старта.
  const runWeeklyGuard = async (attempt = 1): Promise<void> => {
    try {
      const nowUtc = new Date();
      if (nowUtc.getUTCDay() !== 0) return; // Не воскресенье — пропускаем

      const thisWeekDigestUtc = new Date(nowUtc);
      thisWeekDigestUtc.setUTCHours(6, 0, 0, 0); // 06:00 UTC = 10:00 Самара

      if (nowUtc < thisWeekDigestUtc) return; // Ещё не время — плановый таймер сработает сам

      const settings = await db.select().from(settingsTable).limit(1);
      const lastSent = settings[0]?.lastWeeklyDigestAt;

      const alreadySentThisWeek = lastSent && lastSent >= thisWeekDigestUtc;
      if (alreadySentThisWeek) {
        logger.info(
          { lastSent },
          "Weekly digest already sent this week — skipping missed-digest check",
        );
        return;
      }

      logger.warn(
        { lastSent, nowUtc },
        "Missed weekly digest detected — sending now",
      );
      await sendWeeklyDigest();
    } catch (err) {
      logger.error({ err, attempt }, "Missed-weekly guard error");
      if (attempt < 3) {
        setTimeout(() => runWeeklyGuard(attempt + 1), 60_000);
      }
    }
  };
  setTimeout(() => runWeeklyGuard(), 120_000); // 120с после старта

  // Weekly Sunday at 10:00 Самара = 06:00 UTC
  const scheduleWeekly = () => {
    const ms = msUntilUtc(6, 0, 0); // 0 = Sunday
    const nextAt = new Date(Date.now() + ms).toISOString();
    logger.info({ nextAt }, "Weekly digest scheduled (Вс 10:00 Самара)");
    weeklyTimer = setTimeout(async () => {
      try {
        await sendWeeklyDigest();
      } catch (err) {
        logger.error({ err }, "Weekly digest error");
      }
      scheduleWeekly();
    }, ms);
  };
  scheduleWeekly();

  // ── Missed-monthly guard ──────────────────────────────────────────────────────
  // Если сервер перезапустился 1-го числа после 11:00 Самара (07:00 UTC) и дайджест
  // ещё не был отправлен в этом месяце — отправляем через 90с после старта.
  setTimeout(async () => {
    try {
      const nowUtc = new Date();
      if (nowUtc.getUTCDate() !== 1) return; // Не 1-е число — пропускаем

      const thisMonthDigestUtc = new Date(
        Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), 1, 7, 0, 0, 0),
      );
      if (nowUtc < thisMonthDigestUtc) return; // Ещё не время — плановый таймер сработает сам

      const settings = await db.select().from(settingsTable).limit(1);
      const lastSent = settings[0]?.lastMonthlyDigestAt;

      const alreadySentThisMonth = lastSent && lastSent >= thisMonthDigestUtc;
      if (alreadySentThisMonth) {
        logger.info(
          { lastSent },
          "Monthly digest already sent this month — skipping missed-digest check",
        );
        return;
      }

      logger.warn(
        { lastSent, nowUtc },
        "Missed monthly digest detected — sending now",
      );
      await sendMonthlyDigest();
    } catch (err) {
      logger.error({ err }, "Missed-monthly guard error");
    }
  }, 90_000); // 90с после старта

  // Monthly — 1-е число каждого месяца в 11:00 Самара = 07:00 UTC
  // ВНИМАНИЕ: setTimeout имеет лимит ~24.8 дней (2^31 мс). Для месячного таймера
  // это может переполниться (30 дней = 2.6 млрд мс > 2.15 млрд лимита) и вызвать
  // бесконечный цикл (таймер срабатывает немедленно через 1мс).
  // Решение: если до события > 23 дней — планируем промежуточную проверку.
  const MAX_SAFE_TIMEOUT_MS = 23 * 24 * 60 * 60 * 1000; // 23 дня — безопасный максимум
  const scheduleMonthly = () => {
    const ms = msUntilFirstOfMonth(7, 0);
    if (ms > MAX_SAFE_TIMEOUT_MS) {
      // Слишком далеко для одного setTimeout — планируем промежуточную проверку через 23 дня
      logger.info(
        { nextAt: new Date(Date.now() + ms).toISOString(), retryIn: "23d" },
        "Monthly digest: слишком далеко, промежуточная проверка через 23 дня",
      );
      monthlyTimer = setTimeout(scheduleMonthly, MAX_SAFE_TIMEOUT_MS);
      return;
    }
    const nextAt = new Date(Date.now() + ms).toISOString();
    logger.info(
      { nextAt },
      "Monthly digest scheduled (1-е число, 11:00 Самара)",
    );
    monthlyTimer = setTimeout(async () => {
      try {
        await sendMonthlyDigest();
      } catch (err) {
        logger.error({ err }, "Monthly digest error");
      }
      scheduleMonthly();
    }, ms);
  };
  scheduleMonthly();

  // Calculator archive — exactly at 00:00 Asia/Dubai (20:00 UTC on the
  // previous day). The nominal boundary is captured before setTimeout so a
  // delayed callback still uses the correct historical cutoff.
  const MAX_SAFE_CALCULATOR_TIMEOUT_MS = 23 * 24 * 60 * 60 * 1000;
  const CALCULATOR_ARCHIVE_RETRY_MS = 5 * 60 * 1000;
  const recoverCalculatorArchive = async (
    boundary: Date,
    scheduleNextOnSuccess: boolean,
  ): Promise<void> => {
    try {
      await archiveCalculatorMonthAtBoundary(boundary);
      calculatorArchiveRetryTimer = null;
      if (scheduleNextOnSuccess) scheduleCalculatorArchive();
    } catch (err) {
      logger.error({ err, boundary }, "Calculator archive error; retrying");
      calculatorArchiveRetryTimer = setTimeout(
        () => void recoverCalculatorArchive(boundary, scheduleNextOnSuccess),
        CALCULATOR_ARCHIVE_RETRY_MS,
      );
    }
  };
  const scheduleCalculatorArchive = () => {
    const boundary = getNextDubaiMonthBoundary(new Date());
    const delay = boundary.getTime() - Date.now();
    if (delay > MAX_SAFE_CALCULATOR_TIMEOUT_MS) {
      calculatorArchiveTimer = setTimeout(
        scheduleCalculatorArchive,
        MAX_SAFE_CALCULATOR_TIMEOUT_MS,
      );
      return;
    }
    logger.info(
      { boundary: boundary.toISOString() },
      "Calculator archive scheduled (00:00 Asia/Dubai)",
    );
    calculatorArchiveTimer = setTimeout(
      () => {
        void recoverCalculatorArchive(boundary, true);
      },
      Math.max(0, delay),
    );
  };
  scheduleCalculatorArchive();
  // Reconcile the preceding month after every restart. It closes a rolling
  // row left by downtime, while the conditional upsert makes the no-op case
  // safe when the scheduled task already froze it.
  setTimeout(() => {
    const boundary = getDubaiMonthStartUtc(getDubaiMonthKey(new Date()));
    void recoverCalculatorArchive(boundary, false);
  }, 90_000);
}

// ── Watchdog: следим чтобы сканер не завис ────────────────────────────────────
const WATCHDOG_CHECK_MS = 10 * 60 * 1000; // проверяем каждые 10 мин
const WATCHDOG_WARN_MS = 35 * 60 * 1000; // тревога если сканер IDLE >35 мин
// Во время скана используем WATCHDOG_CRIT_MS как порог (prefetch ~18мин + main loop ~22мин = ~40мин)
const WATCHDOG_CRIT_MS = 70 * 60 * 1000; // критично если 70+ мин (скан завис или 2+ пропущенных цикла)
const WATCHDOG_COOLDOWN = 60 * 60 * 1000; // не спамим чаще раза в час
const WATCHDOG_RESTART_AFTER = 2; // авторестарт после N критических алертов подряд

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogLastAlertAt = 0;
let watchdogAlertCount = 0;
let watchdogGetLastScanAt: (() => Date | null) | null = null;
let watchdogGetScannerActivityState: (() => ScannerWatchdogActivity) | null =
  null;
let watchdogGetDiscoveryScannerLeaseStatus:
  | (() => Promise<{ busy: boolean; expectedExpiryAt: Date | null }>)
  | null = null;
let watchdogGetScannerRecoveryState:
  | (() => Promise<{
      lastSuccessfulScanAt: Date | null;
      failureReason: string | null;
      failureAt: Date | null;
      expectedLeaseExpiryAt: Date | null;
    }>)
  | null = null;
let watchdogRestartWorker: (() => Promise<void>) | null = null;

async function runWatchdog(): Promise<void> {
  try {
    const now = Date.now();
    const recoveryState = await watchdogGetScannerRecoveryState?.();
    const lastScanAtRaw =
      recoveryState?.lastSuccessfulScanAt ?? watchdogGetLastScanAt?.() ?? null;
    const lastScanAt = lastScanAtRaw ? lastScanAtRaw.getTime() : null;
    const staleness = lastScanAt ? now - lastScanAt : null;

    // Scanner ownership is deliberately separate from market-cycle: watcher,
    // heatmap and other background jobs must not make discovery look busy or
    // block its next cycle. The status read itself shares the control-plane,
    // so a failure is reported as scanner recovery rather than aborting this
    // watchdog tick.
    const scannerActivity = watchdogGetScannerActivityState?.() ?? {
      kind: "idle" as const,
    };
    const recoverySummary = recoveryState
      ? {
          failureReason: recoveryState.failureReason,
          expectedLeaseExpiryAt: recoveryState.expectedLeaseExpiryAt,
        }
      : null;
    const leaseStatus = await readWatchdogDiscoveryLeaseStatus(
      scannerActivity,
      recoverySummary,
      watchdogGetDiscoveryScannerLeaseStatus,
    );
    if (leaseStatus.controlPlaneUnavailable) {
      logger.warn(
        "Watchdog could not read discovery lease status; reporting scheduler control-plane recovery",
      );
    }
    const watchdogScanState = resolveWatchdogScanState(
      scannerActivity,
      leaseStatus.lease,
      leaseStatus.controlPlaneUnavailable
        ? {
            failureReason: "lease_control_plane_unavailable",
            expectedLeaseExpiryAt: null,
          }
        : recoverySummary,
      now,
    );
    // Если сканер активно работает — используем CRIT порог (40+ мин скан норма).
    // Если idle — используем WARN порог (35 мин).
    const isScanning = watchdogScanState.isScanning;
    const effectiveThreshold = isScanning ? WATCHDOG_CRIT_MS : WATCHDOG_WARN_MS;

    // Первый скан ещё не прошёл (холодный старт) или всё в норме
    if (staleness === null || staleness < effectiveThreshold) {
      watchdogAlertCount = 0;
      watchdogTimer = setTimeout(runWatchdog, WATCHDOG_CHECK_MS);
      return;
    }

    // Быстрый in-memory пре-чек — не идём в DB если локальный кулдаун явно не истёк
    if (now - watchdogLastAlertAt < WATCHDOG_COOLDOWN - 60_000) {
      watchdogTimer = setTimeout(runWatchdog, WATCHDOG_CHECK_MS);
      return;
    }
    // Определяем уровень
    const isCritical = staleness >= WATCHDOG_CRIT_MS;
    const staleMinutes = Math.round(staleness / 60_000);
    watchdogAlertCount++;
    const controlPlaneRecovery =
      recoveryState?.failureReason === "lease_control_plane_unavailable";

    // A control-plane failure makes the durable Telegram alert path unreliable,
    // so request bounded recovery before any database-dependent notification.
    if (
      watchdogRestartWorker &&
      controlPlaneRecovery &&
      staleness >= WATCHDOG_WARN_MS
    ) {
      const restart = claimScannerRestartBudget(now);
      if (restart.allowed) {
        logger.error(
          {
            staleMinutes,
            scannerFailureReason: recoveryState?.failureReason,
            restartCount: restart.used,
            restartRemaining: restart.remaining,
          },
          "Watchdog: requesting bounded worker restart for scheduler control-plane recovery",
        );
        await watchdogRestartWorker();
        return;
      }
      logger.warn(
        {
          staleMinutes,
          reason: restart.reason,
          restartCount: restart.used,
          retryAt: restart.retryAt,
        },
        "Watchdog: scheduler recovery restart suppressed by bounded budget",
      );
    }

    const emoji = isCritical ? "🔴" : "🟡";
    const level = isCritical ? "КРИТИЧНО" : "ПРЕДУПРЕЖДЕНИЕ";
    const lastStr = lastScanAt
      ? new Date(lastScanAt).toISOString().replace("T", " ").slice(0, 19) +
        " UTC"
      : "неизвестно";

    const lines = [
      `${emoji} <b>Watchdog: ${level}</b>`,
      ``,
      `Сканер не делал скан <b>${staleMinutes} мин</b>`,
      `Последний скан: <code>${lastStr}</code>`,
      `Блокер: <code>${watchdogScanState.blocker}</code>`,
      `Действие: ${watchdogScanState.expectedAction}`,
      recoveryState?.failureReason
        ? `Причина восстановления: <code>${recoveryState.failureReason}</code>${
            recoveryState.expectedLeaseExpiryAt
              ? ` (lease до ${recoveryState.expectedLeaseExpiryAt.toISOString().replace("T", " ").slice(0, 19)} UTC)`
              : ""
          }`
        : null,
      isCritical
        ? `⚠️ Discovery scanner не восстановился в ожидаемый срок.`
        : `Слежу за указанным blocker и recovery-действием.`,
      ``,
      `<i>Предупреждение #${watchdogAlertCount}</i>`,
    ];

    const caption = lines
      .filter((line): line is string => line !== null)
      .join("\n");
    const targets = await getTargets({ strict: true });
    const alertDelivery = await queueSettingsPhotoBroadcast({
      column: "lastWatchdogAlertAt",
      windowMs: WATCHDOG_COOLDOWN,
      eventKey: `watchdog:${Math.floor(now / WATCHDOG_COOLDOWN)}`,
      photoPath: WATCHDOG_IMG,
      text: caption,
      targets,
    });
    if (!alertDelivery.claimed) {
      watchdogLastAlertAt = now;
      watchdogTimer = setTimeout(runWatchdog, WATCHDOG_CHECK_MS);
      return;
    }
    if (alertDelivery.queued === 0) {
      throw new Error(
        "Watchdog claim succeeded without durable recipient delivery rows",
      );
    }

    watchdogLastAlertAt = now;
    logger.warn(
      {
        staleMinutes,
        isCritical,
        watchdogScanState: watchdogScanState.source,
        scannerFailureReason: recoveryState?.failureReason ?? null,
        expectedLeaseExpiryAt: recoveryState?.expectedLeaseExpiryAt ?? null,
        alertCount: watchdogAlertCount,
        queued: alertDelivery.queued,
      },
      "Watchdog alert queued for confirmed delivery",
    );

    // ── Авторестарт: если критично 2+ алертов подряд и лимит не исчерпан ──
    if (
      isCritical &&
      watchdogAlertCount >= WATCHDOG_RESTART_AFTER &&
      watchdogRestartWorker
    ) {
      const restart = claimScannerRestartBudget(now);
      if (restart.allowed) {
        logger.warn(
          {
            restartCount: restart.used,
            restartRemaining: restart.remaining,
          },
          "Watchdog: requesting worker restart for scanner recovery",
        );
        try {
          await watchdogRestartWorker();
          // Сбрасываем счётчик — даём сканеру прогреться
          watchdogAlertCount = 0;
          watchdogLastAlertAt = now;
          const restartCaption = [
            `🔄 <b>Watchdog: перезапуск worker</b>`,
            ``,
            `Discovery scanner не восстановился за <b>${staleMinutes} мин</b> — запрошен безопасный перезапуск worker.`,
            `Рестартов за 24ч: ${restart.used}/12`,
          ].join("\n");
          await queuePhotoBroadcast({
            eventKey: `watchdog-restart:${Math.floor(now / WATCHDOG_COOLDOWN)}`,
            photoPath: RESTART_IMG,
            text: restartCaption,
            targets,
          });
          logger.info("Watchdog: worker restart requested successfully");
        } catch (restartErr) {
          logger.error(
            { err: restartErr },
            "Watchdog: worker restart request failed",
          );
        }
      } else {
        logger.error(
          {
            restartCount: restart.used,
            reason: restart.reason,
            retryAt: restart.retryAt,
          },
          "Watchdog: restart limit reached — manual intervention required",
        );
        const limitCaption = `🚨 <b>Watchdog: автоматическое восстановление приостановлено</b>\n\nРестарт сейчас заблокирован: ${restart.reason === "cooldown" ? "соблюдается интервал 12 минут" : "лимит 12 рестартов за 24ч исчерпан"}.\n⚠️ Требуется ручное вмешательство.`;
        await queuePhotoBroadcast({
          eventKey: `watchdog-restart-limit:${Math.floor(now / WATCHDOG_COOLDOWN)}`,
          photoPath: WATCHDOG_IMG,
          text: limitCaption,
          targets,
        });
      }
    }
  } catch (err) {
    logger.error({ err }, "Watchdog check failed");
  }

  watchdogTimer = setTimeout(runWatchdog, WATCHDOG_CHECK_MS);
}

export function startWatchdog(
  getLastScanAt: () => Date | null,
  restartWorker?: () => Promise<void>,
  getScannerActivityState?: () => ScannerWatchdogActivity,
  getDiscoveryScannerLeaseStatus?: () => Promise<{
    busy: boolean;
    expectedExpiryAt: Date | null;
  }>,
  getScannerRecoveryState?: () => Promise<{
    lastSuccessfulScanAt: Date | null;
    failureReason: string | null;
    failureAt: Date | null;
    expectedLeaseExpiryAt: Date | null;
    retryAt: Date | null;
  }>,
): void {
  if (watchdogTimer) return;
  watchdogGetLastScanAt = getLastScanAt;
  watchdogGetScannerActivityState = getScannerActivityState ?? null;
  watchdogGetDiscoveryScannerLeaseStatus =
    getDiscoveryScannerLeaseStatus ?? null;
  watchdogGetScannerRecoveryState = getScannerRecoveryState ?? null;
  watchdogRestartWorker = restartWorker ?? null;
  // Первая проверка через 20 мин после старта — даём боту прогреться
  watchdogTimer = setTimeout(runWatchdog, 20 * 60 * 1000);
  const autoRestart = !!restartWorker;
  logger.info(
    {
      checkIntervalMin: 10,
      warnIdleMin: 35,
      warnScanningMin: 70,
      critAfterMin: 70,
      autoRestart,
    },
    "Watchdog started",
  );
}

/**
 * Одноразовый аудит открытых сигналов (confirming в oi_watch за последние 7 дней).
 * Прогоняет каждый символ через Taker Flow и отправляет сводный отчёт в канал.
 */
export async function runAuditReport(): Promise<void> {
  logger.info("🔍 Audit report started");

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const entries = await db
    .select({
      symbol: oiWatchTable.symbol,
      priceAtEntry: oiWatchTable.priceAtEntry,
      addedAt: oiWatchTable.addedAt,
      sentimentKey: oiWatchTable.sentimentKey,
      oiChange: oiWatchTable.oiChange,
    })
    .from(oiWatchTable)
    .where(
      and(
        eq(oiWatchTable.status, "confirming"),
        gte(oiWatchTable.addedAt, sevenDaysAgo),
      ),
    )
    .orderBy(sql`${oiWatchTable.addedAt} DESC`);

  const targets = await getTargets();

  if (targets.length === 0) {
    logger.warn("🔍 Audit: нет активных получателей");
    return;
  }

  if (entries.length === 0) {
    const msg = `🔍 <b>Аудит сигналов</b>\n\nОткрытых сигналов за последние 7 дней не найдено.`;
    for (const t of targets) {
      await sendMessageResult(t, msg, {
        requireActiveSubscription: true,
      }).catch(() => {});
    }
    return;
  }

  // Батч цены из BingX (один запрос на все тикеры)
  const priceMap = new Map<string, number>();
  try {
    const tickers = await getFutureTickers();
    for (const t of tickers)
      priceMap.set(t.symbol, parseFloat(t.lastPrice) || 0);
  } catch (err) {
    logger.warn({ err }, "🔍 Audit: BingX tickers failed — prices unavailable");
  }

  type Verdict = "enter" | "wait" | "skip";
  type AuditRow = {
    symbol: string;
    sentimentKey: string | null;
    entryPrice: number;
    currentPrice: number;
    pricePct: number;
    ageH: number;
    tfNetPct: number | null;
    tfDominance: "buy" | "sell" | "neutral" | null;
    verdict: Verdict;
  };

  const rows: AuditRow[] = [];

  for (const entry of entries) {
    const currentPrice = priceMap.get(entry.symbol) ?? 0;
    const entryPrice = entry.priceAtEntry ?? 0;
    const pricePct =
      entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
    const ageH = (Date.now() - new Date(entry.addedAt).getTime()) / 3_600_000;

    // Небольшая задержка чтобы не долбить API
    await new Promise((r) => setTimeout(r, 200));
    const tf = await getSpotTakerFlow(entry.symbol).catch(() => null);
    if (tf?.available)
      updateLiveSpotTaker(
        entry.symbol,
        tf.netBuyPct ?? null,
        tf.dominance ?? null,
      );

    let verdict: Verdict;
    if (
      pricePct < -15 ||
      (tf?.available && tf.dominance === "sell" && (tf.netBuyPct ?? 0) < -5)
    ) {
      verdict = "skip";
    } else if (
      tf?.available &&
      tf.dominance === "buy" &&
      (tf.netBuyPct ?? 0) > 3 &&
      pricePct < 12 &&
      ageH < 72
    ) {
      verdict = "enter";
    } else {
      verdict = "wait";
    }

    rows.push({
      symbol: entry.symbol,
      sentimentKey: entry.sentimentKey,
      entryPrice,
      currentPrice,
      pricePct,
      ageH,
      tfNetPct: tf?.available ? (tf.netBuyPct ?? null) : null,
      tfDominance: tf?.available ? tf.dominance : null,
      verdict,
    });
  }

  // Сортировка: сначала enter, потом wait, потом skip; внутри — по свежести
  const ORDER: Record<Verdict, number> = { enter: 0, wait: 1, skip: 2 };
  rows.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.ageH - b.ageH);

  const enterCount = rows.filter((r) => r.verdict === "enter").length;
  const waitCount = rows.filter((r) => r.verdict === "wait").length;
  const skipCount = rows.filter((r) => r.verdict === "skip").length;

  const lines: string[] = [
    `🔍 <b>Аудит открытых сигналов</b>  (7д, ${rows.length} позиций)`,
    `🟢 Войти: ${enterCount}  🟡 Ждать: ${waitCount}  🔴 Пропустить: ${skipCount}`,
    ``,
  ];

  for (const r of rows) {
    const base = r.symbol.replace("-USDT", "");
    const pctStr =
      r.pricePct >= 0
        ? `+${r.pricePct.toFixed(1)}%`
        : `${r.pricePct.toFixed(1)}%`;
    const ageStr =
      r.ageH < 24 ? `${Math.round(r.ageH)}ч` : `${(r.ageH / 24).toFixed(0)}д`;
    const tfStr =
      r.tfNetPct !== null
        ? `TF ${r.tfNetPct >= 0 ? "+" : ""}${r.tfNetPct.toFixed(0)}%`
        : `TF н/д`;
    const emoji =
      r.verdict === "enter" ? "🟢" : r.verdict === "wait" ? "🟡" : "🔴";
    const action =
      r.verdict === "enter"
        ? "ВХОДИТЬ"
        : r.verdict === "wait"
          ? "ЖДАТЬ"
          : "ПРОПУСТИТЬ";
    const pattern = r.sentimentKey
      ? ` <i>${r.sentimentKey.replace(/_/g, " ")}</i>`
      : "";

    lines.push(
      `${emoji} <b>${base}</b>${pattern}  ${pctStr}  ${ageStr}  ${tfStr} → <b>${action}</b>`,
    );
  }

  lines.push(
    ``,
    `📅 ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} Самара`,
  );

  // Разбиваем на чанки по 4000 символов (лимит Telegram)
  const fullText = lines.join("\n");
  const CHUNK = 4000;
  const chunks: string[] = [];
  if (fullText.length <= CHUNK) {
    chunks.push(fullText);
  } else {
    const lineArr = lines;
    let cur = "";
    for (const ln of lineArr) {
      if ((cur + "\n" + ln).length > CHUNK) {
        if (cur) chunks.push(cur);
        cur = ln;
      } else {
        cur = cur ? cur + "\n" + ln : ln;
      }
    }
    if (cur) chunks.push(cur);
  }

  for (const target of targets) {
    for (const chunk of chunks) {
      await sendMessageResult(target, chunk, {
        requireActiveSubscription: true,
      }).catch((err: unknown) => {
        logger.warn({ err, target }, "🔍 Audit: ошибка отправки");
      });
    }
  }

  logger.info(
    { total: rows.length, enter: enterCount, wait: waitCount, skip: skipCount },
    "🔍 Audit report sent",
  );
}

/**
 * Backfill job: fills NULL entry metrics only from a durable prescan snapshot
 * recorded before the signal fired. It must never label current API values as
 * entry data, so fields absent from the historical snapshot stay NULL.
 */
async function refreshNullEntryMetrics(): Promise<void> {
  let candidates: Array<{
    id: number;
    symbol: string;
    entryWhaleIndex: number | null;
    entryObRatio: number | null;
    entryOi30m: number | null;
    entryOi1h: number | null;
    entryOi4h: number | null;
    entryCvd30m: boolean | null;
    entryCvd1h: boolean | null;
    entryCvd4h: boolean | null;
    entryFundingRate: number | null;
    entryFutVolMult: number | null;
    entryPrice1h: number | null;
    entrySpotVol24h: number | null;
    price24hAtFire: number | null;
    detectedAt: Date | null;
    entryMetricsProvenance: Record<
      string,
      { source: string; observedAt: string }
    > | null;
  }>;
  try {
    candidates = await db
      .select({
        id: trackedSignalsTable.id,
        symbol: trackedSignalsTable.symbol,
        entryWhaleIndex: trackedSignalsTable.entryWhaleIndex,
        entryObRatio: trackedSignalsTable.entryObRatio,
        entryOi30m: trackedSignalsTable.entryOi30m,
        entryOi1h: trackedSignalsTable.entryOi1h,
        entryOi4h: trackedSignalsTable.entryOi4h,
        entryCvd30m: trackedSignalsTable.entryCvd30m,
        entryCvd1h: trackedSignalsTable.entryCvd1h,
        entryCvd4h: trackedSignalsTable.entryCvd4h,
        entryFundingRate: trackedSignalsTable.entryFundingRate,
        entryFutVolMult: trackedSignalsTable.entryFutVolMult,
        entryPrice1h: trackedSignalsTable.entryPrice1h,
        entrySpotVol24h: trackedSignalsTable.entrySpotVol24h,
        price24hAtFire: trackedSignalsTable.price24hAtFire,
        detectedAt: trackedSignalsTable.detectedAt,
        entryMetricsProvenance: trackedSignalsTable.entryMetricsProvenance,
      })
      .from(trackedSignalsTable)
      .where(
        and(
          // Открытые позиции + недавно закрытые (история тоже должна быть полной):
          // сигнал может закрыться раньше, чем бэкфилл до него дойдёт.
          or(
            inArray(trackedSignalsTable.status, ["active", "in_run"]),
            gte(
              trackedSignalsTable.detectedAt,
              new Date(Date.now() - 48 * 60 * 60 * 1000),
            ),
          ),
          or(
            isNull(trackedSignalsTable.entryWhaleIndex),
            isNull(trackedSignalsTable.entryObRatio),
            isNull(trackedSignalsTable.entryOi30m),
            isNull(trackedSignalsTable.entryOi1h),
            isNull(trackedSignalsTable.entryOi4h),
            isNull(trackedSignalsTable.entryCvd30m),
            isNull(trackedSignalsTable.entryCvd1h),
            isNull(trackedSignalsTable.entryCvd4h),
            isNull(trackedSignalsTable.entryFundingRate),
            isNull(trackedSignalsTable.entryFutVolMult),
            isNull(trackedSignalsTable.entryPrice1h),
            isNull(trackedSignalsTable.entrySpotVol24h),
            isNull(trackedSignalsTable.price24hAtFire),
          ),
        ),
      )
      .orderBy(desc(trackedSignalsTable.detectedAt))
      .limit(25);
  } catch (err) {
    logger.warn(
      { err },
      "refreshNullEntryMetrics: DB query failed — пропуск цикла",
    );
    return;
  }

  if (candidates.length === 0) return;

  let totalFilled = 0;
  let totalSignals = 0;

  for (const sig of candidates) {
    try {
      if (!sig.detectedAt) continue;
      const [snapshot] = await db
        .select({
          cycleAt: prescanSnapshotsTable.cycleAt,
          p24h: prescanSnapshotsTable.p24h,
          p1h: prescanSnapshotsTable.p1h,
          oi30m: prescanSnapshotsTable.oi30m,
          oi1h: prescanSnapshotsTable.oi1h,
          oi4h: prescanSnapshotsTable.oi4h,
          volMult: prescanSnapshotsTable.volMult,
          spotVolUsd24h: prescanSnapshotsTable.spotVolUsd24h,
          whaleIndex: prescanSnapshotsTable.whaleIndex,
          fundingRate: prescanSnapshotsTable.fundingRate,
          obRatio: prescanSnapshotsTable.obRatio,
          cvd30m: prescanSnapshotsTable.cvd30m,
          cvd1h: prescanSnapshotsTable.cvd1h,
          cvd4h: prescanSnapshotsTable.cvd4h,
        })
        .from(prescanSnapshotsTable)
        .where(
          and(
            eq(prescanSnapshotsTable.symbol, sig.symbol),
            lte(prescanSnapshotsTable.cycleAt, sig.detectedAt),
            gte(
              prescanSnapshotsTable.cycleAt,
              new Date(
                sig.detectedAt.getTime() - HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS,
              ),
            ),
          ),
        )
        .orderBy(desc(prescanSnapshotsTable.cycleAt))
        .limit(1);

      const { patch, provenance } = buildHistoricalEntryMetricPatch(
        sig,
        snapshot,
        sig.detectedAt,
      );
      const snapshotColumns = {
        price24hAtFire: trackedSignalsTable.price24hAtFire,
        entryPrice1h: trackedSignalsTable.entryPrice1h,
        entryOi30m: trackedSignalsTable.entryOi30m,
        entryOi1h: trackedSignalsTable.entryOi1h,
        entryOi4h: trackedSignalsTable.entryOi4h,
        entryFutVolMult: trackedSignalsTable.entryFutVolMult,
        entrySpotVol24h: trackedSignalsTable.entrySpotVol24h,
        entryWhaleIndex: trackedSignalsTable.entryWhaleIndex,
        entryFundingRate: trackedSignalsTable.entryFundingRate,
        entryObRatio: trackedSignalsTable.entryObRatio,
        entryCvd30m: trackedSignalsTable.entryCvd30m,
        entryCvd1h: trackedSignalsTable.entryCvd1h,
        entryCvd4h: trackedSignalsTable.entryCvd4h,
      } as const;
      const patchEntries = Object.entries(patch) as Array<
        [keyof typeof snapshotColumns, number | boolean]
      >;
      const filled = patchEntries.length;

      if (filled > 0) {
        // Two production workers can run this job at once. COALESCE makes each
        // metric write atomic: a fire-time value saved after our SELECT always
        // wins. Provenance uses the same per-column NULL check, so it never
        // relabels a signal_fire value as a prescan_snapshot value.
        const atomicMetricPatch = Object.fromEntries(
          patchEntries.map(([field, value]) => [
            field,
            sql`COALESCE(${snapshotColumns[field]}, ${value})`,
          ]),
        );
        const atomicProvenancePairs = patchEntries.map(([field]) => {
          const provenanceValue = JSON.stringify(provenance[field]);
          return sql`${field}, CASE
            WHEN ${snapshotColumns[field]} IS NULL THEN ${provenanceValue}::jsonb
            ELSE NULL
          END`;
        });
        const patchTyped = {
          ...atomicMetricPatch,
          entryMetricsProvenance: sql`
            COALESCE(${trackedSignalsTable.entryMetricsProvenance}, '{}'::jsonb)
            || jsonb_strip_nulls(jsonb_build_object(
              ${sql.join(atomicProvenancePairs, sql`, `)}
            ))
          `,
          updatedAt: new Date(),
        } as unknown as (typeof trackedSignalsTable)["$inferInsert"];
        const written = await dbWriteBestEffort(
          "refreshNullEntryMetrics:update",
          async () => {
            await db
              .update(trackedSignalsTable)
              .set(patchTyped)
              .where(
                and(
                  eq(trackedSignalsTable.id, sig.id),
                  or(
                    ...patchEntries.map(([field]) =>
                      isNull(snapshotColumns[field]),
                    ),
                  ),
                ),
              );
          },
          { perAttemptTimeoutMs: 5000 },
        );
        if (written !== null) {
          totalFilled += filled;
          totalSignals++;
        }
      }
    } catch (err) {
      logger.warn(
        { err, symbol: sig.symbol },
        "refreshNullEntryMetrics: ошибка обработки сигнала — пропуск",
      );
    }
  }

  if (totalFilled > 0) {
    logger.info(
      { totalFilled, totalSignals, candidates: candidates.length },
      `backfilled ${totalFilled} fields for ${totalSignals} signals`,
    );
  }
}

async function _runLiqCascadeFireCycle(): Promise<void> {
  const candidates = getLiqCascadeLayer10Candidates();
  const cycleNow = Date.now();
  await db.execute(sql`
    UPDATE lc_ob_wait w
    SET status = 'released',
        released_at = COALESCE(w.released_at, now()),
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = now()
    WHERE w.status IN ('waiting', 'invalidated', 'releasing')
      AND w.release_signal_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM tracked_signals ts
        WHERE ts.signal_id = w.release_signal_id
      )
  `);
  await db
    .update(lcObWaitTable)
    .set({
      status: "expired",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(cycleNow),
    })
    .where(
      and(
        inArray(lcObWaitTable.status, ["waiting", "invalidated", "releasing"]),
        lte(lcObWaitTable.expiresAt, new Date(cycleNow)),
      ),
    );
  await db
    .update(lcObWaitTable)
    .set({
      status: "waiting",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(cycleNow),
    })
    .where(
      and(
        eq(lcObWaitTable.status, "releasing"),
        or(
          isNull(lcObWaitTable.leaseUntil),
          lte(lcObWaitTable.leaseUntil, new Date(cycleNow)),
        ),
        gt(lcObWaitTable.expiresAt, new Date(cycleNow)),
      ),
    );
  const activeWaitRows = await db
    .select()
    .from(lcObWaitTable)
    .where(
      and(
        inArray(lcObWaitTable.status, ["waiting", "invalidated", "releasing"]),
        gt(lcObWaitTable.expiresAt, new Date(cycleNow)),
      ),
    );
  const blockedWatchIds = new Set(activeWaitRows.map((row) => row.watchId));
  const waitRows = activeWaitRows.filter(
    (row) => row.status === "waiting" || row.status === "invalidated",
  );
  const releaseWaitByWatchId = new Map<
    number,
    {
      id: number;
      reason: string;
      zone: LcObZone | null;
      status: string;
      expiresAt: number;
      releaseWindowKey: string | null;
      releaseSignalId: number | null;
    }
  >();
  if (waitRows.length > 0) {
    const waitWatches = await db
      .select()
      .from(liqCascadeWatchTable)
      .where(
        inArray(
          liqCascadeWatchTable.id,
          waitRows.map((row) => row.watchId),
        ),
      );
    const watchesById = new Map(waitWatches.map((row) => [row.id, row]));
    const tickersForWait = await getFutureTickers().catch((err) => {
      logger.warn(
        { err, waitingWatchIds: waitRows.map((row) => row.watchId) },
        "LC OB wait prices unavailable; zones remain pending without touch release",
      );
      return [];
    });
    const waitPriceMap = new Map(
      tickersForWait.map((ticker) => [
        ticker.symbol,
        Number(ticker.lastPrice) || 0,
      ]),
    );
    for (const wait of waitRows) {
      if (wait.releaseReason && wait.releaseWindowKey) {
        releaseWaitByWatchId.set(wait.watchId, {
          id: wait.id,
          reason: wait.releaseReason,
          zone: (wait.releaseZone as LcObZone | null) ?? null,
          status: wait.status,
          expiresAt: wait.expiresAt.getTime(),
          releaseWindowKey: wait.releaseWindowKey,
          releaseSignalId: wait.releaseSignalId,
        });
        continue;
      }
      const currentPrice = waitPriceMap.get(wait.symbol) ?? 0;
      let zones = Array.isArray(wait.zones) ? (wait.zones as LcObZone[]) : [];
      const waitObservation =
        typeof wait.observation === "object" &&
        wait.observation !== null &&
        !Array.isArray(wait.observation)
          ? (wait.observation as Record<string, unknown>)
          : {};
      // Ожидание без зоны (на входе не было OB ниже цены): раз в 15 минут ищем
      // OB заново; когда зона появится, обычная логика ждёт её касания.
      let redetectPatch: Record<string, unknown> = {};
      let redetectedZones: LcObZone[] | null = null;
      if (zones.length === 0 && currentPrice > 0) {
        const lastRedetectAt = Number(waitObservation.lastRedetectAt) || 0;
        if (cycleNow - lastRedetectAt >= 15 * 60_000) {
          const redetect = selectWaitingZones(
            await fetchLcObVenueCandles(
              wait.symbol,
              ["1h", "4h"],
              LC_OB_SPOT_VENUES,
            ),
            currentPrice,
            { requireUntouched: true },
          );
          redetectPatch = {
            lastRedetectAt: cycleNow,
            redetectUsableSeries: redetect.usableSeries,
            redetectUnavailableCount: redetect.unavailable.length,
          };
          if (redetect.zones.length > 0) {
            zones = redetect.zones;
            redetectedZones = redetect.zones;
            redetectPatch.zonesRedetectedAt = cycleNow;
            logger.info(
              {
                watchId: wait.watchId,
                symbol: wait.symbol,
                zoneCount: redetect.zones.length,
              },
              "LC OB wait: lower demand zone found on re-detection; waiting for touch",
            );
          }
        }
      }
      const zoneKey = (zone: LcObZone) =>
        `${zone.venue}:${zone.timeframe}:${zone.detector}:${zone.low}:${zone.high}`;
      const invalidatedBefore = Array.isArray(wait.invalidatedZones)
        ? (wait.invalidatedZones as string[])
        : [];
      const invalidatedBeforeSet = new Set(invalidatedBefore);
      const activeZones = zones.filter(
        (zone) => !invalidatedBeforeSet.has(zoneKey(zone)),
      );
      const venues = [...new Set(activeZones.map((zone) => zone.venue))];
      const invalidated = new Set<string>();
      await Promise.all(
        venues.map(async (venue) => {
          const result = await fetchLcObCandles(
            venue,
            wait.symbol,
            "1h",
            cycleNow,
          );
          if (!result.usable) {
            logger.warn(
              {
                watchId: wait.watchId,
                symbol: wait.symbol,
                venue,
                reason: result.reason,
              },
              "LC OB wait mitigation candles unavailable; zone state remains unknown",
            );
            return;
          }
          for (const zone of activeZones) {
            const mitigated = isLcObZoneMitigated(zone, result.series.candles);
            if (zone.venue === venue && mitigated) {
              invalidated.add(zoneKey(zone));
            }
          }
        }),
      );
      const remainingZones = activeZones.filter(
        (zone) => !invalidated.has(zoneKey(zone)),
      );
      const allInvalidated = zones.length > 0 && remainingZones.length === 0;
      const touchedZone =
        !allInvalidated && currentPrice > 0
          ? remainingZones.find((zone) =>
              shouldReleaseLcObWait(currentPrice, lcObZoneTrigger(zone)),
            )
          : undefined;
      await db
        .update(lcObWaitTable)
        .set({
          status: allInvalidated ? "invalidated" : wait.status,
          ...(redetectedZones ? { zones: redetectedZones as any } : {}),
          invalidatedZones: [
            ...new Set([...invalidatedBefore, ...invalidated]),
          ] as any,
          currentPrice: currentPrice > 0 ? currentPrice : null,
          lastCheckAt: new Date(cycleNow),
          observation: {
            ...waitObservation,
            ...redetectPatch,
            invalidatedZoneCount: new Set([
              ...invalidatedBefore,
              ...invalidated,
            ]).size,
            currentPrice: currentPrice > 0 ? currentPrice : null,
            triggerTolerancePct: LC_OB_WAIT_TRIGGER_TOLERANCE_PCT,
          },
          updatedAt: new Date(cycleNow),
        })
        .where(
          and(
            eq(lcObWaitTable.id, wait.id),
            inArray(lcObWaitTable.status, ["waiting", "invalidated"]),
          ),
        );
      if (allInvalidated) {
        logger.info(
          { watchId: wait.watchId, symbol: wait.symbol },
          "LC OB wait: every frozen zone mitigated; normal fire gates may release the candidate",
        );
        releaseWaitByWatchId.set(wait.watchId, {
          id: wait.id,
          reason: "all_zones_invalidated",
          zone: null,
          status: "invalidated",
          expiresAt: wait.expiresAt.getTime(),
          releaseWindowKey: wait.releaseWindowKey,
          releaseSignalId: wait.releaseSignalId,
        });
      } else if (touchedZone) {
        releaseWaitByWatchId.set(wait.watchId, {
          id: wait.id,
          reason: "zone_touched",
          zone: touchedZone,
          status: wait.status,
          expiresAt: wait.expiresAt.getTime(),
          releaseWindowKey: wait.releaseWindowKey,
          releaseSignalId: wait.releaseSignalId,
        });
      }
      if (!watchesById.has(wait.watchId)) {
        logger.error(
          { waitId: wait.id, watchId: wait.watchId, symbol: wait.symbol },
          "LC OB wait references a missing Layer 10 watch",
        );
        blockedWatchIds.delete(wait.watchId);
      }
    }
  }
  const readyWaitCandidates: LiqCascadeL10Entry[] = [];
  if (releaseWaitByWatchId.size > 0) {
    const releaseWatchIds = [...releaseWaitByWatchId.keys()];
    const releaseWatches = await db
      .select()
      .from(liqCascadeWatchTable)
      .where(inArray(liqCascadeWatchTable.id, releaseWatchIds));
    for (const watch of releaseWatches) {
      readyWaitCandidates.push({
        watchId: watch.id,
        symbol: watch.symbol,
        detectedAt: watch.detectedAt.getTime(),
        liqExhausted: watch.liqExhausted,
        entryReason: watch.entryReason ?? "liq_spike",
        longLiq1hAtDetect: watch.longLiq1hAtDetect,
        longLiq24hAtDetect: watch.longLiq24hAtDetect,
        cycleCountAtDetect: watch.cycleCountAtDetect,
      });
    }
  }
  const fireCandidates = [
    ...candidates.filter((entry) => !blockedWatchIds.has(entry.watchId)),
    ...readyWaitCandidates.filter(
      (entry) =>
        !candidates.some((candidate) => candidate.watchId === entry.watchId),
    ),
  ];
  if (fireCandidates.length === 0) return;

  const tickers = await getFutureTickers().catch(() => null);
  if (!tickers?.length) return;
  await refreshAggregatedVolume24h();

  const priceMap = new Map<string, number>();
  const price24hMap = new Map<string, number>();
  const futVol24hMap = new Map<string, number>();
  for (const t of tickers) {
    const p = parseFloat(t.lastPrice ?? "0");
    if (p > 0) priceMap.set(t.symbol, p);
    price24hMap.set(t.symbol, parseFloat(t.priceChangePercent ?? "0") || 0);
    const v = aggregatedVolume24hUsd(t.symbol);
    if (v > 0) futVol24hMap.set(t.symbol, v);
  }

  let firedCount = 0;

  for (const entry of fireCandidates) {
    let activeWaitLease: {
      id: number;
      owner: string;
      expiresAt: number;
    } | null = null;
    let releaseLeaseOwner: string | null = null;
    const returnWaitLease = async (clearReleaseData = false) => {
      if (!activeWaitLease) return;
      const now = Date.now();
      await db
        .update(lcObWaitTable)
        .set({
          status: lcObWaitLeaseReturnStatus(activeWaitLease.expiresAt, now),
          leaseOwner: null,
          leaseUntil: null,
          ...(clearReleaseData
            ? { releaseWindowKey: null, releaseSignalId: null }
            : {}),
          updatedAt: new Date(now),
        })
        .where(
          and(
            eq(lcObWaitTable.id, activeWaitLease.id),
            eq(lcObWaitTable.status, "releasing"),
            eq(lcObWaitTable.leaseOwner, activeWaitLease.owner),
          ),
        );
      activeWaitLease = null;
    };
    const completeWaitRelease = async (signalId: number) => {
      if (!activeWaitLease) return false;
      const now = new Date();
      const rows = await db
        .update(lcObWaitTable)
        .set({
          status: "released",
          releasedAt: now,
          releaseSignalId: signalId,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(lcObWaitTable.id, activeWaitLease.id),
            eq(lcObWaitTable.status, "releasing"),
            eq(lcObWaitTable.leaseOwner, activeWaitLease.owner),
            gt(lcObWaitTable.leaseUntil, now),
          ),
        )
        .returning({ id: lcObWaitTable.id });
      if (rows.length > 0) activeWaitLease = null;
      return rows.length > 0;
    };
    try {
      const {
        watchId,
        symbol,
        detectedAt,
        liqExhausted,
        entryReason,
        longLiq1hAtDetect,
        longLiq24hAtDetect,
        cycleCountAtDetect,
      } = entry;
      const observeLiqCandidate = (
        stage: "rejected" | "fired",
        reason: string,
        metrics: Record<string, unknown> = {},
        signalId?: number,
      ) => {
        recordLcDecisionReason(symbol, watchId, `${stage}:${reason}`);
        void recordLiqCascadeObservation({
          watchId,
          signalId,
          symbol,
          detectedAt: new Date(detectedAt),
          stage,
          reason,
          price: priceMap.get(symbol) ?? null,
          metrics: {
            ageMin: (Date.now() - detectedAt) / 60_000,
            entryReason,
            liqExhausted,
            longLiq1hAtDetect,
            longLiq24hAtDetect,
            ...metrics,
          },
        }).catch((err) =>
          logger.warn(
            { err, watchId, symbol, stage, reason },
            "LiqCascade fire-stage observation failed",
          ),
        );
      };

      _pdbCheck("liquidation_cascade_bg");

      // cycleCount гейт отключён (2026-07-29): недостаточно данных для надёжного cut-off.
      // cycleCount по-прежнему пишется в prescanCycles при файре — для ретроспективного анализа.

      // Ожидание окончания ликвидаций отключено (2026-10-03, решение владелицы):
      // ни liqExhausted, ни 30-минутная выдержка больше не блокируют вход.
      // Остаётся только проверка, что при обнаружении ликвидации вообще были.
      if (longLiq1hAtDetect === 0) {
        _pdbReject("liquidation_cascade_bg", "no_liquidations_at_detect");
        observeLiqCandidate("rejected", "no_liquidations_at_detect");
        continue;
      }

      const ageMin = (Date.now() - detectedAt) / 60_000;

      const currentPrice = priceMap.get(symbol);
      if (currentPrice === undefined) {
        _pdbReject("liquidation_cascade_bg", "no_price");
        observeLiqCandidate("rejected", "no_price");
        continue;
      }

      const price24hPct = price24hMap.get(symbol) ?? 0;
      if (price24hPct < -50) {
        _pdbReject("liquidation_cascade_bg", "price24h_crash");
        observeLiqCandidate("rejected", "price24h_crash", { price24hPct });
        continue;
      }

      // Volume filter removed (2026-10-10, owner order): it did not help.
      // Volume is loaded for the fire snapshot only; it never blocks.
      const lcVolume = await loadLcDetectionVolume(symbol, detectedAt);

      // Oversized-cascade filter removed (2026-10-15, owner order): it blocked
      // champions (AGRIPPA, AVA, ARC). BTC is the single exception (owner rule
      // 2026-10-10): it keeps the original LC fire rules, so the two newer
      // filters below (detection-candle range, limit entry) never apply.
      const lcIsBtc = symbol === "BTC-USDT" || symbol === "BTCUSDT";
      // Speed filter (owner rule 2026-10-07): the detection 15m candle must be a
      // large reaction candle (range >= 6%, closed candle only; an open candle waits
      // as non-terminal detection_candle_pending). No data blocks.
      const lcCandleGate = lcIsBtc
        ? null
        : evaluateLcDetectionCandleGate(
            Math.floor(detectedAt / (15 * 60_000)) * 15 * 60_000 + 15 * 60_000 >
              Date.now()
              ? null
              : await loadLcDetectionCandle(symbol, detectedAt),
            detectedAt,
            Date.now(),
          );
      if (lcCandleGate && !lcCandleGate.pass) {
        _pdbReject("liquidation_cascade_bg", lcCandleGate.reason);
        observeLiqCandidate("rejected", lcCandleGate.reason, {
          price24hPct,
          detectionCandleRangePct: lcCandleGate.rangePct,
          detectionCandleLowerWickPct: lcCandleGate.lowerWickPct,
          detectionCandleBodyPct: lcCandleGate.bodyPct,
          minRangePct: LC_MIN_DETECTION_CANDLE_RANGE_PCT,
        });
        continue;
      }
      // Owner 2026-10-27: a capitulation detection candle (see
      // lc-detection-candle-gate.ts) is the entry itself: enter right after its
      // close. The later filters (recovery hold, WI+CVD4h, spot taker, OB wait)
      // delayed or dropped these entries and are not applied to them. BTC keeps
      // the original rules. The no-data rule and one-position-per-coin stay.
      const lcCapitulationEntry = lcCandleGate !== null;

      // Limit-style entry removed (owner order 2026-10-17): LC enters at once.

      const liqRatio =
        longLiq1hAtDetect != null &&
        longLiq24hAtDetect != null &&
        longLiq24hAtDetect > 0
          ? longLiq1hAtDetect / longLiq24hAtDetect
          : null;
      let price1hAtFire: number | null = null;
      // No price fetch is needed when the liquidation concentration already
      // passes: this check runs per watch and should not slow every fire cycle.
      const needsRecoveryCheck =
        !lcCapitulationEntry &&
        entryReason === "liq_spike" &&
        liqRatio !== null &&
        Number.isFinite(liqRatio) &&
        liqRatio < 0.75;
      if (needsRecoveryCheck) {
        // Use the same 30m-kline calculation previously stored on the tracker,
        // but freeze it BEFORE creating the signal. Never use a post-fire value
        // as the input to a trading decision.
        const klines = await Promise.race([
          getKlines(symbol, "30m", 4),
          new Promise<BingXKline[]>((_, reject) =>
            setTimeout(() => reject(new Error("LC price1h timeout")), 3_000),
          ),
        ]).catch((err) => {
          logger.warn({ err, symbol }, "LC price1h unavailable at fire");
          return [] as BingXKline[];
        });
        if (klines.length >= 3) {
          const currentClose = Number(klines[klines.length - 1].close);
          const referenceClose = Number(klines[klines.length - 3].close);
          if (
            Number.isFinite(currentClose) &&
            Number.isFinite(referenceClose) &&
            currentClose > 0 &&
            referenceClose > 0
          ) {
            price1hAtFire =
              ((currentClose - referenceClose) / referenceClose) * 100;
          }
        }
        if (
          shouldHoldLiqCascadeForRecovery(entryReason, liqRatio, price1hAtFire)
        ) {
          _pdbReject("liquidation_cascade_bg", "weak_liq_continued_decline");
          observeLiqCandidate("rejected", "weak_liq_continued_decline", {
            price1hPct: price1hAtFire,
            liqRatio,
            price24hPct,
          });
          continue;
        }
      }

      // WI fetch перенесён в этот Promise.all (был в отдельном ниже), чтобы combined gate
      // (LC GATE v2) мог использовать его ДО CVD4h-проверки — иначе combined gate недостижим.
      const [oiData, fsVol, cvdData, futTakerData, spotTakerData, _gateWi] =
        await Promise.all([
          getCoinglassOI(symbol, currentPrice).catch(() => null),
          getFsVolume(symbol).catch(() => null),
          getSpotCvdMtf(symbol).catch(() => null),
          getCoinglassTakerFlow(symbol).catch(() => null),
          // limit=96 → 24ч свечей → takerNetBuy1h/4h/24h все три заполнены за один запрос
          getSpotTakerFlow(symbol, 96).catch(() => null),
          // WI: был отдельным Promise.all ниже — перенесён сюда (параллельно с OI/CVD).
          // 4s timeout унаследован от .catch(() => null) ниже; TOKEN_WI_TIMEOUT_MS = 4s внутри функции.
          getTokenWhaleIndex(symbol).catch(() => null),
        ]);

      // ── WI lag-диагностика: различаем "нет данных" от "timeout/lag" ──────────────
      // getTokenWhaleIndex возвращает null при сетевом таймауте (не кэшируется) ИЛИ
      // когда токен никогда не был в WI-кэше. getCachedTokenWi позволяет различить:
      //   undefined → токен никогда не запрашивался (нет данных совсем)
      //   null/number → кэш есть, live-запрос упал (lag) → fail-open
      if (_gateWi === null) {
        const _staleCachedWi = getCachedTokenWi(symbol);
        if (_staleCachedWi !== undefined) {
          logger.warn(
            { symbol, staleCachedWi: _staleCachedWi },
            "WI gate: null из API (lag/timeout) — stale кэш есть, fail-open; gate не блокирует",
          );
        } else {
          logger.debug(
            { symbol },
            "WI gate: null — нет данных в кэше, токен не в WI-апдейтере, fail-open",
          );
        }
      }

      // Owner rule (all patterns): no aggregated data - no signal.
      {
        const _lcAggMissing: string[] = [];
        if (futTakerData?.available !== true) _lcAggMissing.push("fut_taker");
        if (cvdData?.available !== true) _lcAggMissing.push("spot_cvd");
        if (!(oiData?.oiUsd ?? 0)) _lcAggMissing.push("oi");
        if (spotTakerData?.available !== true) _lcAggMissing.push("spot_taker");
        if (_gateWi === null) _lcAggMissing.push("whale_index");
        if (oiData?.oiChange24h == null) _lcAggMissing.push("oi24h");
        if (cvdData?.cvd4h == null) _lcAggMissing.push("spot_cvd4h");
        if (longLiq1hAtDetect == null) _lcAggMissing.push("liq1h");
        if (_lcAggMissing.length > 0) {
          const _lcAggReason = `liquidation_cascade_${_lcAggMissing.join("+")}_unavailable`;
          _pdbReject("liquidation_cascade_bg", _lcAggReason);
          observeLiqCandidate("rejected", _lcAggReason, { price24hPct });
          continue;
        }
      }

      const oi30m = oiData?.oiChange30m ?? null;
      // OI30m больше не фильтр (владелец, 2026-10-04): значение остаётся только
      // телеметрией в decision snapshot; null/любое значение не блокирует вход.

      // ── LC GATE v2 (2026-08-13): combined WI + CVD4h ─────────────────────────────
      // Заменяет ДВА предыдущих standalone-гейта:
      //   (a) CVD4h standalone (введён ранее): cvd4h=false → блок. Данные: 79% отменённых.
      //   (b) WI hard-block (2026-08-08): WI<0 → блок. Данные: 44% профитов имели WI<0 (ложные блоки).
      // Новое правило: блок ТОЛЬКО если ОБА поля известны и медвежьи одновременно.
      // Fail-open если любое поле null/unavailable.
      //
      // Масштаб ослабления (SQL-аудит 2026-08-13, n=47 сигналов с cvd4h=false):
      //   30/47 (64%) имели WI≥0 → теперь проходят (раньше блокировались standalone CVD4h)
      //   17/47 (36%) имели WI<0  → по-прежнему блокируются combined gate
      //   avg WI у cvd4h=false сигналов = +41.5 (киты скорее покупали, несмотря на CVD4h=false)
      if (
        !lcCapitulationEntry &&
        cvdData?.available === true &&
        cvdData.cvd4h === false &&
        _gateWi !== null &&
        _gateWi < 0
      ) {
        _pdbReject("liquidation_cascade_bg", "wi_neg_and_cvd4h_false");
        observeLiqCandidate("rejected", "wi_neg_and_cvd4h_false", {
          price24hPct,
          oi30m,
          oi1h: oiData?.oiChange1h ?? null,
          oi4h: oiData?.oiChange4h ?? null,
          oi24h: oiData?.oiChange24h ?? null,
          spotTaker: spotTakerData?.available
            ? (spotTakerData.netBuyPct ?? null)
            : null,
          futTaker: futTakerData?.available
            ? (futTakerData.netBuyPct ?? null)
            : null,
          cvd30m: cvdData?.available ? (cvdData.cvd30m ?? null) : null,
          cvd1h: cvdData?.available ? (cvdData.cvd1h ?? null) : null,
          cvd4h: false,
          whaleIndex: _gateWi,
        });
        logger.info(
          { symbol, wi: _gateWi.toFixed(3), cvd4h: false },
          "LC GATE v2: WI < 0 + CVD4h = false (combined gate 2026-08-13)",
        );
        continue;
      }

      // A confirmed negative spot taker flow means aggressive sellers are
      // still in control after the liquidation wave. Missing data stays
      // fail-open so CoinGlass coverage never becomes an accidental blocker.
      if (
        !lcCapitulationEntry &&
        shouldBlockLiqCascadeSpotTaker(spotTakerData)
      ) {
        _pdbReject("liquidation_cascade_bg", "spot_taker_negative");
        observeLiqCandidate("rejected", "spot_taker_negative", {
          price24hPct,
          oi30m,
          oi1h: oiData?.oiChange1h ?? null,
          oi4h: oiData?.oiChange4h ?? null,
          oi24h: oiData?.oiChange24h ?? null,
          spotTaker: spotTakerData!.netBuyPct,
          futTaker: futTakerData?.available
            ? (futTakerData.netBuyPct ?? null)
            : null,
          cvd30m: cvdData?.available ? (cvdData.cvd30m ?? null) : null,
          cvd1h: cvdData?.available ? (cvdData.cvd1h ?? null) : null,
          cvd4h: cvdData?.available ? (cvdData.cvd4h ?? null) : null,
          whaleIndex: _gateWi,
        });
        logger.info(
          { symbol, spotTaker: spotTakerData!.netBuyPct },
          "LiqCascade fire: блок — spot taker остаётся отрицательным",
        );
        continue;
      }

      // CVD30m gate удалён: SQL-аудит 27.07 показал profit pass=50%, cancel pass=47%
      // — нет дискриминации между группами исходов (ratio 1.05x), гейт бесполезен.

      // CVD15m gate ОТКЛЮЧЁН (2026-07-30): сигналы пропускаем без подтверждения 15m-дельты.
      // Данные cvd15m по-прежнему пишутся в entryCvd15m ниже — для анализа через 2 недели.

      // WI/OB/SNF1h gate removed 2026-10-18: it read the BingX order book
      // (owner rule: no BingX data in signal gates).
      // The BingX order-book ratio is no longer read: null = no OB penalty/telemetry.
      const _gateObRatio: number | null = null;
      const _gateSnf1h = getSpotNetflowEntry(symbol)?.netPct1h ?? null;

      // ── OI24h soft penalty: только отрицательный OI24h → штраф −2 ─────────────
      // Production LC-анализ показал, что OI24h в диапазоне 0…10% — не слабость:
      // этот диапазон чаще встречался у сильных profit/high-peak сделок, поэтому
      // прежний порог <10% ошибочно штрафовал лучший reset-профиль.
      // Отрицательный OI24h остаётся слабым признаком; null → fail-open.
      const _lcOi24h = oiData?.oiChange24h ?? null;
      const _lcOi24hWeak = _lcOi24h !== null && _lcOi24h < 0;
      if (_lcOi24hWeak) {
        logger.info(
          { symbol, oi24h: _lcOi24h!.toFixed(1) },
          "LC SCORE: OI24h < 0% — штраф −2 к скору",
        );
      }

      // ── CVD4h soft penalty (2026-08-13): CVD4h=false → штраф −2 к скору (fail-open при null/unavailable) ─
      // CVD4h топ-2 дискриминатор по SQL-аудиту (47 cvd4h=false: win rate 3.3%, 60% cancel).
      // Убирать как хард-блок нельзя (44% профитов были при WI<0 — standalone CVD4h слишком жёсткий),
      // но и совсем игнорировать нельзя — метрика статистически работает.
      // Решение: soft-penalty −2 (аналогично OI24h) + combined hard-block поверх (LC GATE v2 выше).
      // null/unavailable (CoinGlass недоступен) → fail-open (штраф не применяется).
      // SQL-аудит (n=47 cvd4h=false): 30/47 WI≥0 → проходят с penalty; 17/47 WI<0 → hard-block.
      const _lcCvd4hWeak =
        cvdData?.available === true && cvdData.cvd4h === false;
      if (_lcCvd4hWeak) {
        logger.info(
          { symbol },
          "LC SCORE: CVD4h = false — штраф −2 к скору (soft-penalty 2026-08-13)",
        );
      }

      const ageStr = `${Math.round(ageMin)}мин`;
      const exhausted = liqExhausted === true ? "да" : "не ждали";
      const reasonStr =
        entryReason === "liq_order_stream" ? "ордер-стрим" : "liq_spike";

      // liq1h ниже порога (% капитализации): в данных 43% SL-сигналов ниже порога vs 7% profit → штраф −2.
      const _lcLiqSmall =
        longLiq1hAtDetect !== null &&
        belowPctOfMcap(
          longLiq1hAtDetect,
          (await fetchMarketCap(symbol).catch(() => null))?.mcap,
          LC_SMALL_LIQ_1H_PCT_OF_MCAP,
        );

      // ob_ratio > 1.2: аски давят цену → штраф −2. _gateObRatio уже получен выше.
      // fail-open при null (нет данных OB). Soft penalty, не блок.
      const _lcObWeak = _gateObRatio !== null && _gateObRatio > 1.2;

      // Score (2026-10-21): fitted on completed LC decisions, 5-fold held-out
      // AUC 0.62-0.67 (old penalty score: 0.43). See lc-score.ts. Watch-row
      // metrics are read once here; a missing metric adds 0 points.
      const [_lcWatchRow] = await db
        .select({
          spotVolMcapPct: liqCascadeWatchTable.spotVolMcapPct,
          longLiq4hAtDetect: liqCascadeWatchTable.longLiq4hAtDetect,
          price24hAtDetect: liqCascadeWatchTable.price24hAtDetect,
        })
        .from(liqCascadeWatchTable)
        .where(eq(liqCascadeWatchTable.id, watchId))
        .limit(1);
      const alphaScore = calcLcScore({
        liq4h: _lcWatchRow?.longLiq4hAtDetect,
        liqRatio,
        p24h: _lcWatchRow?.price24hAtDetect ?? price24hPct,
        volMcap: _lcWatchRow?.spotVolMcapPct,
        spotTaker: spotTakerData?.available ? spotTakerData.netBuyPct : null,
        whale: _gateWi,
      });
      const alphaResult: AlphaResult = {
        symbol,
        grade: "alpha",
        price: currentPrice,
        priceChange30m: 0,
        currentVolume: futVol24hMap.get(symbol) ?? 0,
        avgVolume: 0,
        volumeMultiplier: 0,
        oiChangePercent: oi30m ?? 0,
        openInterest: oiData?.oiUsd ?? null,
        cmcRank: null,
        cmcSource: null,
        cmcAvailable: false,
        liquidationsUsd: null,
        liquidationsMultiple: null,
        coinglassAvailable: oiData?.available ?? false,
        globalOiChange: oi30m,
        spotVol24h: fsVol?.spotVolUsd24h ?? null,
        oiChange1h: oiData?.oiChange1h ?? null,
        oiChange4h: oiData?.oiChange4h ?? null,
        oiChange24h: oiData?.oiChange24h ?? null,
        sentiment: "Liquidation Cascade",
        sentimentKey: "liquidation_cascade",
        traderAction: lcCapitulationEntry
          ? `LONG (капитуляция после каскада лонг-ликвидаций, обнаружено ${ageStr} назад, источник: ${reasonStr}, стоп -10%, Б/У с +8%, трейлинг с +15% на 10 п.п.)`
          : `LONG (каскад лонг-ликвидаций исчерпан ${ageStr} назад, источник: ${reasonStr}, liqExhausted: ${exhausted}, стоп -10%, Б/У с +8%, трейлинг с +15% на 10 п.п.)`,
        alphaScore,
        isContinuing: false,
        cumulativeOiChange: oi30m ?? 0,
        tradingViewUrl: `https://www.tradingview.com/chart/?symbol=BINGX:${symbol.replace("-", "")}`,
        bingxUrl: `https://bingx.com/en/perpetual/${symbol.replace("-USDT", "")}USDT/`,
        marketCapUsd: getSpotPoolEntry(symbol)?.mcapUsd ?? null,
        scoreBreakdown: [
          `Лонг-ликв исчерпаны ${ageStr} назад`,
          oi30m != null
            ? `OI 30m${oi30m >= 0 ? "+" : ""}${oi30m.toFixed(1)}%`
            : null,
          longLiq1hAtDetect != null
            ? `liq1h $${Math.round(longLiq1hAtDetect / 1000)}k${_lcLiqSmall ? " ⚠️ мало (<$60k, ист. −2 скор)" : ""}`
            : null,
          _lcOi24hWeak
            ? `⚠️ OI24h отрицательный ${_lcOi24h!.toFixed(1)}% (ист. слабый профиль)`
            : null,
          _lcCvd4hWeak ? `⚠️ CVD4h медвежий (ист. 0% win rate)` : null,
          _lcObWeak
            ? `⚠️ ob_ratio=${String(_gateObRatio)} (аски давят, −2 скор)`
            : null,
          `источник: ${reasonStr}`,
        ]
          .filter(Boolean)
          .join(" · "),
      };

      const waitRelease = releaseWaitByWatchId.get(watchId);
      if (waitRelease?.releaseSignalId != null) {
        const recoveredTracker = await db
          .select({ id: trackedSignalsTable.id })
          .from(trackedSignalsTable)
          .where(eq(trackedSignalsTable.signalId, waitRelease.releaseSignalId))
          .limit(1);
        if (recoveredTracker.length > 0) {
          await db
            .update(lcObWaitTable)
            .set({
              status: "released",
              releasedAt: new Date(),
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(lcObWaitTable.id, waitRelease.id),
                or(
                  inArray(lcObWaitTable.status, ["waiting", "invalidated"]),
                  and(
                    eq(lcObWaitTable.status, "releasing"),
                    or(
                      isNull(lcObWaitTable.leaseUntil),
                      lte(lcObWaitTable.leaseUntil, new Date()),
                    ),
                  ),
                ),
              ),
            );
          logger.info(
            {
              watchId,
              waitId: waitRelease.id,
              signalId: waitRelease.releaseSignalId,
            },
            "LC OB wait release recovered after tracker creation",
          );
          continue;
        }
      }
      const openPosition = await db
        .select({ id: trackedSignalsTable.id })
        .from(trackedSignalsTable)
        .where(
          and(
            eq(trackedSignalsTable.symbol, symbol),
            inArray(trackedSignalsTable.status, ["active", "in_run"]),
          ),
        )
        .limit(1);
      if (openPosition.length > 0) {
        _pdbReject("liquidation_cascade_bg", "same_symbol_position_open");
        observeLiqCandidate("rejected", "same_symbol_position_open");
        if (waitRelease) {
          await db
            .update(lcObWaitTable)
            .set({
              status: "waiting",
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(lcObWaitTable.id, waitRelease.id),
                inArray(lcObWaitTable.status, ["waiting", "invalidated"]),
              ),
            );
        }
        continue;
      }
      // BTC — единственное исключение: срабатывает всегда, без ожидания OB.
      if (
        LC_OB_WAIT_ENABLED &&
        !lcCapitulationEntry &&
        !waitRelease &&
        symbol !== "BTC-USDT"
      ) {
        const venueResults = await fetchLcObVenueCandles(
          symbol,
          ["1h", "4h"],
          LC_OB_SPOT_VENUES,
        );
        const frozen = selectWaitingZones(venueResults, currentPrice);
        if (frozen.unavailable.length > 0) {
          logger.warn(
            {
              watchId,
              symbol,
              unavailableVenuesAndTimeframes: frozen.unavailable,
              usableSeries: frozen.usableSeries,
            },
            "LC OB venue candle failures are unknown, not evidence of no demand block",
          );
        }
        if (frozen.usableSeries === 0) {
          logger.warn(
            {
              watchId,
              symbol,
              reason: "no_usable_spot_candles_fail_open",
              unavailable: frozen.unavailable,
            },
            "LC OB wait detector has no usable spot candle series; proceeding through normal signal path",
          );
        } else {
          // Нет OB ниже входа → тоже ожидание: зона ищется заново каждые 15 минут.
          const expiresAt = lcObWaitDeadline(detectedAt);
          if (expiresAt <= Date.now()) {
            logger.warn(
              { watchId, symbol, detectedAt, expiresAt },
              "LC OB wait candidate already exceeded its original 96h deadline; proceeding normally",
            );
          } else {
            const activeSymbolWait = await db
              .select({ id: lcObWaitTable.id })
              .from(lcObWaitTable)
              .where(
                and(
                  eq(lcObWaitTable.symbol, symbol),
                  inArray(lcObWaitTable.status, [
                    "waiting",
                    "invalidated",
                    "releasing",
                  ]),
                ),
              )
              .limit(1);
            if (activeSymbolWait.length > 0) {
              logger.warn(
                { watchId, symbol, waitingId: activeSymbolWait[0]!.id },
                "LC OB wait already exists for this symbol; suppressing duplicate candidate",
              );
              continue;
            }
            const insertedWait = await db
              .insert(lcObWaitTable)
              .values({
                watchId,
                symbol,
                detectedAt: new Date(detectedAt),
                expiresAt: new Date(expiresAt),
                entryPrice: currentPrice,
                zones: frozen.zones as any,
                status: "waiting",
                currentPrice,
                lastCheckAt: new Date(),
                observation: {
                  source:
                    frozen.zones.length > 0
                      ? "ordinary_lc_gates_passed"
                      : "ordinary_lc_gates_passed_no_lower_zone",
                  usableSeries: frozen.usableSeries,
                  unavailable: frozen.unavailable,
                  zoneCount: frozen.zones.length,
                  triggerTolerancePct: LC_OB_WAIT_TRIGGER_TOLERANCE_PCT,
                },
              })
              .onConflictDoNothing()
              .returning({ id: lcObWaitTable.id });
            if (insertedWait.length > 0) {
              logger.info(
                {
                  watchId,
                  waitId: insertedWait[0]!.id,
                  symbol,
                  expiresAt: new Date(expiresAt).toISOString(),
                  entryPrice: currentPrice,
                  zoneCount: frozen.zones.length,
                },
                "LC candidate moved to durable OB waiting mode; no signal/tracker/relay/Telegram created",
              );
              continue;
            }
          }
        }
      }

      {
        const _aggMissing = await missingAggregatedFireData(symbol);
        if (_aggMissing.length > 0) {
          logger.info(
            { symbol: symbol, missing: _aggMissing },
            "LC fire: агрегированные данные недоступны — сигнал не выдан",
          );
          continue;
        }
      }
      const _bwKeyLC = `${symbol}:${Math.floor(Date.now() / (30 * 60 * 1000))}`;
      let waitReleaseSignalId = waitRelease?.releaseSignalId ?? null;
      let existingReleaseSignal: typeof signalsTable.$inferSelect | null = null;
      if (waitReleaseSignalId !== null) {
        existingReleaseSignal =
          (
            await db
              .select()
              .from(signalsTable)
              .where(eq(signalsTable.id, waitReleaseSignalId))
              .limit(1)
          )[0] ?? null;
        if (!existingReleaseSignal) waitReleaseSignalId = null;
      }
      let waitReleaseWindowKey = waitRelease?.releaseWindowKey ?? _bwKeyLC;
      if (waitRelease) {
        if (
          waitRelease.zone &&
          !waitRelease.releaseWindowKey &&
          !shouldReleaseLcObWait(
            currentPrice,
            lcObZoneTrigger(waitRelease.zone),
          )
        ) {
          logger.info(
            { watchId, symbol, price: currentPrice },
            "LC OB wait touch no longer holds at pre-insert price recheck",
          );
          continue;
        }
        const leaseOwner = randomUUID();
        releaseLeaseOwner = leaseOwner;
        const leaseStartedAt = Date.now();
        waitReleaseWindowKey = waitRelease.releaseWindowKey ?? _bwKeyLC;
        const claimed = await claimLcObWaitRelease({
          status: waitRelease.status,
          expiresAt: waitRelease.expiresAt,
          leaseUntil: null,
          now: leaseStartedAt,
          compareAndSet: async () => {
            const claimedWait = await db
              .update(lcObWaitTable)
              .set({
                status: "releasing",
                releaseReason: waitRelease.reason,
                releaseZone: waitRelease.zone as any,
                leaseOwner,
                leaseUntil: new Date(
                  leaseStartedAt + LC_OB_WAIT_RELEASE_LEASE_MS,
                ),
                releaseWindowKey: waitReleaseWindowKey,
                releaseSignalId: waitReleaseSignalId,
                updatedAt: new Date(leaseStartedAt),
              })
              .where(
                and(
                  eq(lcObWaitTable.id, waitRelease.id),
                  inArray(lcObWaitTable.status, ["waiting", "invalidated"]),
                  gt(lcObWaitTable.expiresAt, new Date(leaseStartedAt)),
                ),
              )
              .returning({ id: lcObWaitTable.id });
            if (claimedWait.length > 0) {
              activeWaitLease = {
                id: waitRelease.id,
                owner: leaseOwner,
                expiresAt: waitRelease.expiresAt,
              };
            }
            return claimedWait.length > 0;
          },
        });
        if (!claimed) {
          logger.info(
            { watchId, symbol, waitId: waitRelease.id },
            "LC OB wait release CAS lost or deadline passed; signal insert suppressed",
          );
          continue;
        }
      }
      const signalInsertValues: InsertSignal = {
        symbol,
        type: "alpha",
        value: alphaResult.volumeMultiplier,
        threshold: 0,
        price: currentPrice,
        priceChangePercent: price24hPct,
        volume24h: alphaResult.currentVolume,
        avgVolume: alphaResult.avgVolume,
        openInterest: oiData?.oiUsd ?? null,
        oiChangePercent: oi30m,
        tradingViewUrl: alphaResult.tradingViewUrl,
        sentiment: alphaResult.sentiment,
        sentimentKey: alphaResult.sentimentKey,
        alphaScore,
        isContinuing: false,
        cumulativeOiChange: oi30m,
        broadcastWindowKey: waitRelease ? waitReleaseWindowKey : _bwKeyLC,
        telegramAlertQueued: false,
        altBulletSnapshotRequestedAt: new Date(),
        detectedAt: new Date(),
      };
      const waitLeaseForInsert =
        waitRelease && releaseLeaseOwner
          ? { id: waitRelease.id, owner: releaseLeaseOwner }
          : null;
      const _rowsLC =
        existingReleaseSignal !== null
          ? [existingReleaseSignal]
          : await dbWriteStrict("signals/liqCascade-pathB-insert", () => {
              if (waitRelease && waitLeaseForInsert) {
                return db.transaction(async (tx) => {
                  const rows = await tx
                    .insert(signalsTable)
                    .values(signalInsertValues)
                    .onConflictDoNothing()
                    .returning();
                  if (rows.length === 0) return rows;
                  const linkedWait = await tx
                    .update(lcObWaitTable)
                    .set({ releaseSignalId: rows[0]!.id })
                    .where(
                      and(
                        eq(lcObWaitTable.id, waitLeaseForInsert.id),
                        eq(lcObWaitTable.status, "releasing"),
                        eq(lcObWaitTable.leaseOwner, waitLeaseForInsert.owner),
                        gt(lcObWaitTable.leaseUntil, new Date()),
                      ),
                    )
                    .returning({ id: lcObWaitTable.id });
                  if (linkedWait.length === 0) {
                    throw new Error(
                      "LC OB wait release lease lost before signal id was persisted",
                    );
                  }
                  return rows;
                });
              }
              return db
                .insert(signalsTable)
                .values(signalInsertValues)
                .onConflictDoNothing()
                .returning();
            });
      if (_rowsLC.length === 0) {
        logger.info(
          { symbol, windowKey: waitReleaseWindowKey },
          "LiqCascade Path B: broadcast window conflict — duplicate suppressed (DB-level dedup)",
        );
        await returnWaitLease(true);
        continue;
      }
      const inserted = _rowsLC[0]!;
      // Observation only: real CoinGlass volume of the 15m candles before entry.
      const _lcCandleRealVolume = await observeLiquidationCandleVolume(
        symbol,
        Date.now(),
      );
      const trackResult = await trackSignal({
        symbol,
        signalId: inserted.id,
        signalType: "alpha",
        sentiment: "Liquidation Cascade",
        sentimentKey: "liquidation_cascade",
        alphaScore,
        entrySource: "liq_watcher",
        entryPrice: currentPrice,
        // cycleCountAtDetect = prescan cycles когда была обнаружена liq-волна;
        // fallback на live prescan для токенов присутствующих в prescan_tracker.
        prescanCycles:
          cycleCountAtDetect ?? getPrescanEntry(symbol)?.cycleCount ?? null,
        entryOi: oiData?.oiUsd ?? null,
        entryOi30m: oi30m,
        entryOi1h: oiData?.oiChange1h ?? null,
        entryOi4h: oiData?.oiChange4h ?? null,
        entryOi24h: oiData?.oiChange24h ?? null,
        entryPrice1h: needsRecoveryCheck ? price1hAtFire : undefined,
        entryCvd15m: cvdData?.available ? (cvdData.cvd15m ?? null) : null,
        entryCvd30m: cvdData?.available ? (cvdData.cvd30m ?? null) : null,
        entryCvd1h: cvdData?.available ? (cvdData.cvd1h ?? null) : null,
        entryCvd4h: cvdData?.available ? (cvdData.cvd4h ?? null) : null,
        entryFutTakerNetBuy: futTakerData?.available
          ? (futTakerData.netBuyPct ?? null)
          : null,
        entrySpotTakerNetBuy: spotTakerData?.available
          ? (spotTakerData.netBuyPct ?? null)
          : null,
        // SNF 1h/4h: присутствуют в _gateSnf1h выше, передаём в trackSignal для анализа.
        // Покрывает случай когда prescanE отсутствует (малые BingX-токены не в prescan_tracker).
        entrySpotNetBuy1h: getSpotNetflowEntry(symbol)?.netPct1h ?? null,
        entrySpotNetBuy4h: getSpotNetflowEntry(symbol)?.netPct4h ?? null,
        entrySpotVol24h: fsVol?.spotVolUsd24h ?? null,
        entryLiqLong1h: longLiq1hAtDetect,
        entryLiqLong24h: longLiq24hAtDetect,
        entryLiqRatio: liqRatio,
        entryLiqReason: entryReason,
        decisionMetrics: {
          candleRealVolume: _lcCandleRealVolume,
          lcDetectionVolume: {
            version: "lc_detection_volume:v1",
            source: "fire_time",
            candleOpen: lcVolume.status === "ok" ? lcVolume.candleOpen : null,
            futuresRatio: lcVolume.status === "ok" ? lcVolume.ratio : null,
            spotRatio: lcVolume.status === "ok" ? lcVolume.spotRatio : null,
          },
        },
      });

      let tracked = trackResult !== false && trackResult !== "skip";
      if (!tracked) {
        const recoveredTracker = await db
          .select({ id: trackedSignalsTable.id })
          .from(trackedSignalsTable)
          .where(eq(trackedSignalsTable.signalId, inserted.id))
          .limit(1);
        if (recoveredTracker.length > 0) tracked = true;
      }
      if (!tracked && trackResult === false) {
        observeLiqCandidate("rejected", "tracker_failed", {}, inserted.id);
        logger.error(
          { symbol },
          "LiqCascade Path B: trackSignal упал → broadcast отменён",
        );
        await discardUntrackedSignal(inserted.id, "liq_cascade_tracker_failed");
        await returnWaitLease(true);
        continue;
      }
      if (!tracked && trackResult === "skip") {
        observeLiqCandidate(
          "rejected",
          "active_signal_exists",
          {},
          inserted.id,
        );
        logger.info(
          { symbol },
          "LiqCascade Path B: сигнал уже активен → пропуск",
        );
        await discardUntrackedSignal(inserted.id, "liq_cascade_tracker_skip");
        await returnWaitLease(true);
        continue;
      }

      if (waitRelease && !(await completeWaitRelease(inserted.id))) {
        logger.warn(
          {
            watchId,
            waitId: waitRelease.id,
            signalId: inserted.id,
          },
          "LC signal/tracker succeeded but release lease was lost; recovery will reconcile it",
        );
        await returnWaitLease();
      }
      resetPrescanCycleCount(symbol);
      _pdbPass("liquidation_cascade_bg");
      const _liqBcastQueued = await broadcastBatchAlert(
        [
          {
            ...alphaResult,
            entryOb: consumeObAtFire(symbol),
            signalId: inserted.id,
          },
        ],
        { eventKey: `signal:${inserted.id}` },
      );
      scheduleAltBulletIndicatorSnapshot({
        signalId: inserted.id,
        symbol,
        sentimentKey: "liquidation_cascade",
      });
      await dbWriteStrict("signals/alert-queued", () =>
        db
          .update(signalsTable)
          .set({ telegramAlertQueued: true })
          .where(eq(signalsTable.id, inserted.id)),
      );
      injectLiveMarketData(symbol, {
        oi30m: oiData?.oiChange30m ?? null,
        oi1h: oiData?.oiChange1h ?? null,
        oi4h: oiData?.oiChange4h ?? null,
        oi24h: oiData?.oiChange24h ?? null,
        // CVD данные уже получены в этом цикле — инжектируем чтобы tracker CVD
        // не пустовал для liq_cascade (экзотических BingX-only токенов).
        cvd15m: cvdData?.available ? (cvdData.cvd15m ?? null) : null,
        cvd30m: cvdData?.available ? (cvdData.cvd30m ?? null) : null,
        cvd1h: cvdData?.available ? (cvdData.cvd1h ?? null) : null,
        cvd4h: cvdData?.available ? (cvdData.cvd4h ?? null) : null,
        netBuyPct: futTakerData?.netBuyPct ?? null,
      });
      firedCount++;
      observeLiqCandidate(
        "fired",
        "signal_tracked",
        {
          price24hPct,
          oi30m,
          oi1h: oiData?.oiChange1h ?? null,
          oi4h: oiData?.oiChange4h ?? null,
          oi24h: oiData?.oiChange24h ?? null,
          spotTaker: spotTakerData?.available
            ? (spotTakerData.netBuyPct ?? null)
            : null,
          futTaker: futTakerData?.available
            ? (futTakerData.netBuyPct ?? null)
            : null,
          cvd15m: cvdData?.available ? (cvdData.cvd15m ?? null) : null,
          cvd30m: cvdData?.available ? (cvdData.cvd30m ?? null) : null,
          cvd1h: cvdData?.available ? (cvdData.cvd1h ?? null) : null,
          cvd4h: cvdData?.available ? (cvdData.cvd4h ?? null) : null,
          whaleIndex: _gateWi,
          obRatio: _gateObRatio,
          snf1h: _gateSnf1h,
          alphaScore,
        },
        inserted.id,
      );

      logger.info(
        {
          symbol,
          ageMin: Math.round(ageMin),
          entryReason,
          liqExhausted,
          oi30m,
          alphaScore,
          tgQueued: _liqBcastQueued,
        },
        "💥🔄 LIQUIDATION CASCADE Path B: каскад исчерпан → прямой сигнал выдан",
      );
    } catch (err) {
      if (activeWaitLease) {
        await returnWaitLease().catch((leaseErr) =>
          logger.error(
            { leaseErr, waitId: activeWaitLease?.id },
            "LC OB wait release lease could not be returned after fire failure",
          ),
        );
      }
      logger.error(
        { err, symbol: entry.symbol },
        "LiqCascade Path B: ошибка при выстреле",
      );
    }
  }

  if (firedCount > 0)
    logger.info({ firedCount }, "LiqCascadeFireCycle завершён");
}

export function stopWatcher(): void {
  if (fastTimer) {
    clearTimeout(fastTimer);
    fastTimer = null;
  }
  if (stealthReentryTimer) {
    clearTimeout(stealthReentryTimer);
    stealthReentryTimer = null;
  }
  if (stealthFreshHighProtectionTimer) {
    clearTimeout(stealthFreshHighProtectionTimer);
    stealthFreshHighProtectionTimer = null;
  }
  if (oiWatchTimer) {
    clearTimeout(oiWatchTimer);
    oiWatchTimer = null;
  }
  if (postCloseFollowupTimer) {
    clearTimeout(postCloseFollowupTimer);
    postCloseFollowupTimer = null;
  }
  if (signalOutcomesTimer) {
    clearTimeout(signalOutcomesTimer);
    signalOutcomesTimer = null;
  }
  if (breakoutAnalysisShadowTimer) {
    clearTimeout(breakoutAnalysisShadowTimer);
    breakoutAnalysisShadowTimer = null;
  }
  if (cycleTimer) {
    clearTimeout(cycleTimer);
    cycleTimer = null;
  }
  if (dailyTimer) {
    clearTimeout(dailyTimer);
    dailyTimer = null;
  }
  if (weeklyTimer) {
    clearTimeout(weeklyTimer);
    weeklyTimer = null;
  }
  if (monthlyTimer) {
    clearTimeout(monthlyTimer);
    monthlyTimer = null;
  }
  if (calculatorArchiveTimer) {
    clearTimeout(calculatorArchiveTimer);
    calculatorArchiveTimer = null;
  }
  if (calculatorArchiveRetryTimer) {
    clearTimeout(calculatorArchiveRetryTimer);
    calculatorArchiveRetryTimer = null;
  }
  if (whaleTimer) {
    clearTimeout(whaleTimer);
    whaleTimer = null;
  }
  if (watchdogTimer) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
  // Invalidate callbacks before their atomic close starts. A close that has
  // already passed the in-transaction generation check is deliberately allowed
  // to finish with its outbox row: that is the only way to preserve the
  // existing atomic terminal-status + delivery contract during shutdown.
  realtimeTrailingMonitorFence.stop();
  if (realtimeTrailingPriceTimer) {
    clearTimeout(realtimeTrailingPriceTimer);
    realtimeTrailingPriceTimer = null;
  }
  realtimeTrailingPriceStream?.stop();
  realtimeTrailingPriceStream = null;
  _milestoneWakeTriggers.clear();
  _milestoneWakeLastAt.clear();
  _realtimeTrailingCandidates.clear();
  _realtimeTrailingCloseInFlight.clear();
  _realtimeTrailingTickQueues.clear();
  _realtimeTrailingRememberedState.clear();
  logger.info("AltBullet Watcher stopped");
}

const REALTIME_TRAILING_REFRESH_MS = 30_000;

const _realtimeTrailingCloseInFlight = new Set<number>();
const _realtimeTrailingTickQueues = new Map<number, Promise<void>>();
const _realtimeTrailingRememberedState = new Map<
  number,
  Pick<
    RealtimeTrailingCandidate,
    "trailingStopLevel" | "armedAt" | "lastEventAt"
  >
>();

const _realtimeTrailingCandidates = new Map<
  number,
  RealtimeTrailingCandidate
>();

async function handleRealtimeTrailingPrice(
  update: BingXLastPriceUpdate,
  monitorGeneration: number,
): Promise<void> {
  if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;
  const candidates = [..._realtimeTrailingCandidates.values()].filter(
    (candidate) => candidate.tracked.symbol === update.symbol,
  );
  for (const candidate of candidates) {
    if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;
    const signalId = candidate.tracked.id;
    const preceding =
      _realtimeTrailingTickQueues.get(signalId) ?? Promise.resolve();
    const processing = preceding
      .catch(() => undefined)
      .then(async () => {
        if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;
        const eventAt = update.exchangeAt ?? update.observedAt;
        const initialCandidate = _realtimeTrailingCandidates.get(signalId);
        if (
          !initialCandidate ||
          !isRealtimeTrailingEventNewer({
            observedAt: update.observedAt,
            exchangeAt: update.exchangeAt,
            lastEventAt: initialCandidate.lastEventAt,
          })
        ) {
          return;
        }
        if (_realtimeTrailingCloseInFlight.has(signalId)) return;
        _realtimeTrailingCloseInFlight.add(signalId);
        try {
          const outcome = await retryRealtimeTrailingOperation(async () => {
            const liveCandidate =
              _realtimeTrailingCandidates.get(signalId) ?? initialCandidate;
            const freshRows = await db
              .select()
              .from(trackedSignalsTable)
              .where(
                and(
                  eq(trackedSignalsTable.id, signalId),
                  or(
                    eq(trackedSignalsTable.status, "in_run"),
                    sql`${trackedSignalsTable.status} = 'active'
                      AND ${trackedSignalsTable.symbol} IN ('BTC-USDT', 'BTCUSDT')`,
                  ),
                ),
              )
              .limit(1);
            if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) {
              return null;
            }
            let fresh = freshRows[0];
            if (!fresh || fresh.isShort === true) return null;
            const freshProfile = getExitProfile(
              fresh.sentimentKey,
              fresh.symbol,
            );
            let freshPeak = fresh.peakPrice ?? fresh.entryPrice;
            const activeBitcoin =
              fresh.status === "active" && isBitcoinTrackedSignal(fresh);
            if (
              activeBitcoin &&
              update.price > freshPeak &&
              computePnl(fresh, update.price) >=
                getBuStopMilestone(fresh.sentimentKey, fresh.symbol)
            ) {
              const btcPeakPnl = computePnl(fresh, update.price);
              const btcTrailingStop =
                btcPeakPnl >= freshProfile.trailingActivation
                  ? resolveTrailingStopLevel({
                      entryPrice: fresh.entryPrice,
                      peakPrice: update.price,
                      trailingGapPercent: freshProfile.trailingGap,
                      persistedTrailingStopLevel: fresh.trailingStopLevel,
                    })
                  : null;
              const advanced = await db
                .update(trackedSignalsTable)
                .set({
                  peakPrice: maxPeakPriceSql(update.price),
                  ...(btcTrailingStop !== null
                    ? {
                        trailingStopLevel:
                          maxTrailingStopLevelSql(btcTrailingStop),
                        trailingStopArmedAt: trailingStopArmedAtSql(
                          btcTrailingStop,
                          eventAt,
                        ),
                      }
                    : {}),
                  updatedAt: update.observedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${signalId}
                    AND ${trackedSignalsTable.status} = 'active'
                    AND ${trackedSignalsTable.symbol} IN ('BTC-USDT', 'BTCUSDT')
                    AND COALESCE(${trackedSignalsTable.peakPrice}, ${trackedSignalsTable.entryPrice}) < ${update.price}`,
                )
                .returning({
                  peakPrice: trackedSignalsTable.peakPrice,
                  trailingStopLevel: trackedSignalsTable.trailingStopLevel,
                  trailingStopArmedAt: trackedSignalsTable.trailingStopArmedAt,
                });
              if (advanced.length > 0) {
                fresh = {
                  ...fresh,
                  peakPrice: advanced[0].peakPrice,
                  trailingStopLevel: advanced[0].trailingStopLevel,
                  trailingStopArmedAt: advanced[0].trailingStopArmedAt,
                };
              } else {
                const latestRows = await db
                  .select()
                  .from(trackedSignalsTable)
                  .where(
                    and(
                      eq(trackedSignalsTable.id, signalId),
                      or(
                        eq(trackedSignalsTable.status, "in_run"),
                        sql`${trackedSignalsTable.status} = 'active'
                          AND ${trackedSignalsTable.symbol} IN ('BTC-USDT', 'BTCUSDT')`,
                      ),
                    ),
                  )
                  .limit(1);
                fresh = latestRows[0];
                if (!fresh || fresh.isShort === true) return null;
              }
              freshPeak = fresh.peakPrice ?? fresh.entryPrice;
            }
            if (isImpulseRunnerCoreClosed(fresh)) {
              const runnerPeak = Math.max(
                fresh.originalEntryPrice ?? fresh.entryPrice,
                fresh.runnerPeakPrice ??
                  fresh.originalEntryPrice ??
                  fresh.entryPrice,
                freshPeak,
                update.price,
              );
              const runnerEntryPrice =
                fresh.originalEntryPrice ?? fresh.entryPrice;
              const runnerStop = resolveImpulseRunnerTrailingStopPrice({
                entryPrice: runnerEntryPrice,
                peakPrice: runnerPeak,
                persistedTrailingStopLevel: fresh.runnerTrailingStopLevel,
              });
              const runnerDecision = resolveImpulseRunnerExitDecision({
                entryPrice: runnerEntryPrice,
                currentPrice: update.price,
                peakPrice: runnerPeak,
                persistedStopLossPct: fresh.stopLossPct,
                entryPolicyVersion: fresh.entryPolicyVersion,
                persistedTrailingStopLevel:
                  runnerStop ?? fresh.runnerTrailingStopLevel,
              });
              if (runnerDecision.hit) {
                await closeImpulseRunnerFinalPosition({
                  tracked: fresh,
                  exitPrice: runnerDecision.exitPrice!,
                  peakPrice: runnerPeak,
                  priceSource: "bingx_ws_last_price",
                  exitReason: runnerDecision.reason!,
                  realtimeMonitorGeneration: monitorGeneration,
                });
                return null;
              }
              const runnerArmedAt =
                runnerStop != null
                  ? (fresh.runnerTrailingStopArmedAt ?? eventAt)
                  : fresh.runnerTrailingStopArmedAt;
              const runnerRaised = await db
                .update(trackedSignalsTable)
                .set({
                  runnerPeakPrice: maxPeakPriceSql(runnerPeak),
                  runnerTrailingStopLevel:
                    runnerStop == null
                      ? trackedSignalsTable.runnerTrailingStopLevel
                      : sql<number>`GREATEST(COALESCE(${trackedSignalsTable.runnerTrailingStopLevel}, 0), ${runnerStop})`,
                  runnerTrailingStopArmedAt: runnerArmedAt,
                  peakPrice: maxPeakPriceSql(runnerPeak),
                  updatedAt: update.observedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${signalId} AND ${trackedSignalsTable.status} = 'in_run' AND ${trackedSignalsTable.runnerState} = 'open'`,
                )
                .returning({
                  id: trackedSignalsTable.id,
                  runnerTrailingStopLevel:
                    trackedSignalsTable.runnerTrailingStopLevel,
                });
              const durableRunnerStop =
                runnerRaised[0]?.runnerTrailingStopLevel ?? runnerStop ?? null;
              return {
                armedStop: durableRunnerStop,
                armedAt: runnerArmedAt,
                tracked: {
                  ...fresh,
                  runnerPeakPrice: runnerPeak,
                  runnerTrailingStopLevel: durableRunnerStop,
                  runnerTrailingStopArmedAt: runnerArmedAt,
                  peakPrice: runnerPeak,
                },
              };
            }
            const freshPeakPnl = computePnl(fresh, freshPeak);
            const freshStop = resolveActivatedTrailingStopLevel({
              peakPnlPercent: freshPeakPnl,
              trailingActivationPercent: freshProfile.trailingActivation,
              entryPrice: fresh.entryPrice,
              peakPrice: freshPeak,
              trailingGapPercent: freshProfile.trailingGap,
              persistedTrailingStopLevel: fresh.trailingStopLevel,
            });

            if (
              liveCandidate.trailingStopLevel !== null &&
              liveCandidate.armedAt
            ) {
              const closeDecision = resolveRealtimeTrailingClose({
                currentPrice: update.price,
                candidateTrailingStopLevel: liveCandidate.trailingStopLevel,
                freshTrailingStopLevel: freshStop,
                armedAt: liveCandidate.armedAt,
                observedAt: update.observedAt,
                exchangeAt: update.exchangeAt,
              });
              if (
                closeDecision.shouldClose &&
                closeDecision.trailingStopLevel !== null
              ) {
                await closeTrailingPosition({
                  tracked: fresh,
                  currentPrice: update.price,
                  peakPrice: freshPeak,
                  trailingStop: closeDecision.trailingStopLevel,
                  exitProfile: freshProfile,
                  observedAt: update.observedAt,
                  priceSource: "bingx_ws_last_price",
                  realtimeMonitorGeneration: monitorGeneration,
                });
                return null;
              }
            }

            if (
              freshStop !== null &&
              isFreshDurableTrailingStopHit({
                currentPrice: update.price,
                trailingStopLevel: freshStop,
                armedAt: fresh.trailingStopArmedAt,
                observedAt: update.observedAt,
                exchangeAt: update.exchangeAt,
              })
            ) {
              await closeTrailingPosition({
                tracked: fresh,
                currentPrice: update.price,
                peakPrice: freshPeak,
                trailingStop: freshStop,
                exitProfile: freshProfile,
                observedAt: update.observedAt,
                priceSource: "bingx_ws_last_price",
                realtimeMonitorGeneration: monitorGeneration,
              });
              return null;
            }

            if (
              fresh.status === "active" &&
              isBitcoinTrackedSignal(fresh) &&
              isRealtimeBitcoinBreakevenHit({
                peakPnlPercent: freshPeakPnl,
                currentPrice: update.price,
                entryPrice: fresh.entryPrice,
                breakevenActivationPercent: getBuStopMilestone(
                  fresh.sentimentKey,
                  fresh.symbol,
                ),
                trailingActivationPercent: freshProfile.trailingActivation,
              })
            ) {
              await closeRealtimeBitcoinBreakeven({
                tracked: { ...fresh, peakPrice: freshPeak },
                currentPrice: update.price,
                peakPrice: freshPeak,
                observedAt: update.observedAt,
                monitorGeneration,
              });
              return null;
            }

            let armedStop =
              freshStop !== null &&
              (liveCandidate.trailingStopLevel === null ||
                freshStop > liveCandidate.trailingStopLevel)
                ? freshStop
                : liveCandidate.trailingStopLevel;
            let armedAt =
              armedStop !== liveCandidate.trailingStopLevel
                ? (fresh.trailingStopArmedAt ?? eventAt)
                : liveCandidate.armedAt;
            let tracked = fresh;
            const tickPnl = computePnl(fresh, update.price);
            if (
              update.price > freshPeak &&
              tickPnl >= freshProfile.trailingActivation
            ) {
              const tickStop = resolveTrailingStopLevel({
                entryPrice: fresh.entryPrice,
                peakPrice: update.price,
                trailingGapPercent: freshProfile.trailingGap,
                persistedTrailingStopLevel: fresh.trailingStopLevel,
              });
              const raised = await db
                .update(trackedSignalsTable)
                .set({
                  peakPrice: update.price,
                  trailingStopLevel: maxTrailingStopLevelSql(tickStop),
                  trailingStopArmedAt: trailingStopArmedAtSql(
                    tickStop,
                    eventAt,
                  ),
                  updatedAt: update.observedAt,
                })
                .where(
                  sql`${trackedSignalsTable.id} = ${signalId}
                  AND ${trackedSignalsTable.status} = 'in_run'
                  AND coalesce(${trackedSignalsTable.peakPrice}, ${trackedSignalsTable.entryPrice}) < ${update.price}`,
                )
                .returning({
                  id: trackedSignalsTable.id,
                  trailingStopLevel: trackedSignalsTable.trailingStopLevel,
                  trailingStopArmedAt: trackedSignalsTable.trailingStopArmedAt,
                });
              if (raised.length > 0) {
                armedStop = raised[0].trailingStopLevel ?? tickStop;
                armedAt = raised[0].trailingStopArmedAt ?? eventAt;
                tracked = {
                  ...fresh,
                  peakPrice: update.price,
                  trailingStopLevel: armedStop,
                  trailingStopArmedAt: armedAt,
                };
              }
            }
            return { armedStop, armedAt, tracked };
          });
          if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;

          // Advance the watermark only after all durable work succeeded. State
          // mutations are likewise delayed so a retry cannot evaluate this tick
          // against a boundary created by its failed first attempt.
          const currentCandidate =
            _realtimeTrailingCandidates.get(signalId) ?? initialCandidate;
          if (outcome) {
            currentCandidate.trailingStopLevel = outcome.armedStop;
            currentCandidate.armedAt = outcome.armedAt;
            currentCandidate.tracked = outcome.tracked;
            if (isImpulseRunnerCoreClosed(outcome.tracked)) {
              await processImpulseRunnerMilestone(
                outcome.tracked,
                outcome.tracked.runnerPeakPrice ??
                  outcome.tracked.peakPrice ??
                  outcome.tracked.entryPrice,
                outcome.tracked.runnerTrailingStopLevel,
              );
            }
          }
          currentCandidate.lastEventAt = eventAt;
          _realtimeTrailingRememberedState.set(signalId, {
            trailingStopLevel: currentCandidate.trailingStopLevel,
            armedAt: currentCandidate.armedAt,
            lastEventAt: eventAt,
          });
        } catch (err) {
          logger.warn(
            { err, signalId, symbol: candidate.tracked.symbol },
            "Realtime trailing price could not be evaluated",
          );
        } finally {
          _realtimeTrailingCloseInFlight.delete(signalId);
        }
      });
    _realtimeTrailingTickQueues.set(signalId, processing);
    void processing.finally(() => {
      if (_realtimeTrailingTickQueues.get(signalId) === processing) {
        _realtimeTrailingTickQueues.delete(signalId);
      }
    });
  }
}

// ── Active milestone wake-up ────────────────────────────────────────────────
// Active (non-BTC) longs are polled by the 2-minute fast cycle only. A +5%
// touch that retraces inside one interval produced no milestone message, no
// peak and no BE protection. Live ticks now wake the same fast cycle the
// moment the next milestone price is touched.
const MILESTONE_WAKE_COOLDOWN_MS = 20_000;
const _milestoneWakeTriggers = new Map<string, number>();
const _milestoneWakeLastAt = new Map<string, number>();

// Memory diagnostics: size of every long-lived module-level collection.
registerProcessHealthSource("watcher_collections", () => {
  const sizes: Record<string, number> = {
    obAtFire: _obAtFire.size,
    vbStaleHoldUntil: _vbStaleHoldUntil.size,
    haStaleHoldUntil: _haStaleHoldUntil.size,
    staleOi4hExtCount: _staleOi4hExtCount.size,
    staleTakerSellCycles: _staleTakerSellCycles.size,
    staleTakerFlipped: _staleTakerFlipped.size,
    fastStalePatterns: FAST_STALE_PATTERNS.size,
    trajectoryRecorded: _trajectoryRecorded.size,
    drawdownMinimums: _drawdownMinimums.size,
    lastTrackSignalErrors: lastTrackSignalErrors.size,
    accumScoutCooldowns: accumScoutCooldowns.size,
    profitLockActivationCache: profitLockActivationCache.size,
    profitLockActivationMissUntil: profitLockActivationMissUntil.size,
    profitLockLastObservedPrice: profitLockLastObservedPrice.size,
    realtimeTrailingCloseInFlight: _realtimeTrailingCloseInFlight.size,
    realtimeTrailingTickQueues: _realtimeTrailingTickQueues.size,
    realtimeTrailingRememberedState: _realtimeTrailingRememberedState.size,
    realtimeTrailingCandidates: _realtimeTrailingCandidates.size,
    milestoneWakeTriggers: _milestoneWakeTriggers.size,
    milestoneWakeLastAt: _milestoneWakeLastAt.size,
  };
  return {
    entries: Object.values(sizes).reduce((a, n) => a + n, 0),
    ...sizes,
  };
});
let _fastCycleRunning = false;
let _fastCycleRerun = false;

/** Next not-yet-reached milestone price for an active long, or null. */
function resolveNextMilestoneWakePrice(
  tracked: typeof trackedSignalsTable.$inferSelect,
): number | null {
  if (
    tracked.status !== "active" ||
    tracked.isShort === true ||
    isBitcoinTrackedSignal(tracked)
  ) {
    return null;
  }
  const profile = getExitProfile(tracked.sentimentKey, tracked.symbol);
  const reached = tracked.lastMilestone ?? 0;
  const next = [
    5,
    8,
    getBuStopMilestone(tracked.sentimentKey, tracked.symbol),
    profile.firstTarget,
  ]
    .filter((m) => Number.isFinite(m) && m > reached)
    .sort((a, b) => a - b)[0];
  if (next === undefined) return null;
  return tracked.entryPrice * (1 + next / 100);
}

async function runFastCycleExclusive(generation?: number): Promise<void> {
  if (_fastCycleRunning) {
    _fastCycleRerun = true;
    return;
  }
  _fastCycleRunning = true;
  try {
    await runInRunFastCycle(generation);
  } finally {
    _fastCycleRunning = false;
  }
  if (_fastCycleRerun) {
    _fastCycleRerun = false;
    void runFastCycleExclusive(generation).catch((err) =>
      logger.error({ err }, "FastCycle error (milestone wake rerun)"),
    );
  }
}

function handleMilestoneWakeTick(update: BingXLastPriceUpdate): void {
  const trigger = _milestoneWakeTriggers.get(update.symbol);
  if (trigger === undefined || update.price < trigger) return;
  const now = Date.now();
  if (
    now - (_milestoneWakeLastAt.get(update.symbol) ?? 0) <
    MILESTONE_WAKE_COOLDOWN_MS
  ) {
    return;
  }
  _milestoneWakeLastAt.set(update.symbol, now);
  logger.info(
    { symbol: update.symbol, price: update.price, trigger },
    "Milestone wake: live price reached next milestone — running fast cycle",
  );
  void runFastCycleExclusive().catch((err) =>
    logger.error({ err }, "FastCycle error (milestone wake)"),
  );
}

let realtimeTrailingPriceStream: BingXLastPriceStream | null = null;

let realtimeTrailingPriceTimer: NodeJS.Timeout | null = null;
const realtimeTrailingMonitorFence = new RealtimeTrailingMonitorFence();

function isRealtimeTrailingMonitorCurrent(generation: number): boolean {
  return (
    realtimeTrailingMonitorFence.isCurrent(generation) &&
    realtimeTrailingPriceStream !== null
  );
}

function syncRealtimeTrailingCandidates(
  signals: (typeof trackedSignalsTable.$inferSelect)[],
  monitorGeneration = realtimeTrailingMonitorFence.current(),
): void {
  if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;
  const observedAt = new Date();
  const next = new Map<number, RealtimeTrailingCandidate>();
  for (const tracked of signals) {
    if (!shouldSubscribeRealtimeTrailingPosition(tracked)) continue;
    const exitProfile = getExitProfile(tracked.sentimentKey, tracked.symbol);
    const peakPrice = tracked.peakPrice ?? tracked.entryPrice;
    const peakPnl = computePnl(tracked, peakPrice);
    const calculatedTrailingStop = isImpulseRunnerCoreClosed(tracked)
      ? resolveImpulseRunnerTrailingStopPrice({
          entryPrice: tracked.originalEntryPrice ?? tracked.entryPrice,
          peakPrice: Math.max(
            peakPrice,
            tracked.runnerPeakPrice ??
              tracked.originalEntryPrice ??
              tracked.entryPrice,
          ),
          persistedTrailingStopLevel: tracked.runnerTrailingStopLevel,
        })
      : resolveActivatedTrailingStopLevel({
          peakPnlPercent: peakPnl,
          trailingActivationPercent: exitProfile.trailingActivation,
          entryPrice: tracked.entryPrice,
          peakPrice,
          trailingGapPercent: exitProfile.trailingGap,
          persistedTrailingStopLevel: tracked.trailingStopLevel,
        });
    const existing = _realtimeTrailingCandidates.get(tracked.id);
    const remembered = _realtimeTrailingRememberedState.get(tracked.id);
    const durableBitcoinEventFence =
      tracked.status === "active" && isBitcoinTrackedSignal(tracked)
        ? tracked.updatedAt
        : null;
    // A higher level is a new protection boundary. Any tick that belongs to
    // the preceding level must not be evaluated against it, even if the stream
    // event itself is newer than the original activation.
    const boundary = resolveRealtimeTrailingBoundaryState({
      calculatedTrailingStop,
      existing,
      remembered,
      durable: {
        trailingStopLevel: isImpulseRunnerCoreClosed(tracked)
          ? tracked.runnerTrailingStopLevel
          : tracked.trailingStopLevel,
        armedAt: isImpulseRunnerCoreClosed(tracked)
          ? tracked.runnerTrailingStopArmedAt
          : tracked.trailingStopArmedAt,
      },
      observedAt,
    });
    const candidate: RealtimeTrailingCandidate = {
      tracked,
      trailingStopLevel: boundary.trailingStopLevel,
      armedAt: boundary.armedAt,
      lastEventAt:
        existing?.lastEventAt ??
        remembered?.lastEventAt ??
        durableBitcoinEventFence,
    };
    next.set(tracked.id, candidate);
    _realtimeTrailingRememberedState.set(tracked.id, {
      trailingStopLevel: candidate.trailingStopLevel,
      armedAt: candidate.armedAt,
      lastEventAt: candidate.lastEventAt,
    });
  }
  _realtimeTrailingCandidates.clear();
  for (const [id, candidate] of next) {
    _realtimeTrailingCandidates.set(id, candidate);
  }
  if (!isRealtimeTrailingMonitorCurrent(monitorGeneration)) return;
  _milestoneWakeTriggers.clear();
  for (const tracked of signals) {
    const trigger = resolveNextMilestoneWakePrice(tracked);
    if (trigger === null) continue;
    const existing = _milestoneWakeTriggers.get(tracked.symbol);
    _milestoneWakeTriggers.set(
      tracked.symbol,
      existing === undefined ? trigger : Math.min(existing, trigger),
    );
  }
  realtimeTrailingPriceStream?.setSymbols([
    ...new Set([
      ...[...next.values()].map((candidate) => candidate.tracked.symbol),
      ..._milestoneWakeTriggers.keys(),
    ]),
  ]);
}
