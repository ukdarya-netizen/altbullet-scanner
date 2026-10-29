import {
  pgTable,
  serial,
  text,
  real,
  doublePrecision,
  integer,
  timestamp,
  boolean,
  pgEnum,
  pgSequence,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Immutable detector used by the stealth_breakout pattern. Null is legacy/unknown. */
export const stealthDetectionMethods = [
  "quiet_zone_breakout",
  "abneon_support_bounce",
  "fresh_24h_high_breakout",
  "range_4h_breakout",
] as const;
export type StealthDetectionMethod = (typeof stealthDetectionMethods)[number];

// Runtime allocation and publish-time schema ownership must agree. Without
// this declaration, Publishing treats the live allocator sequence as drift and
// attempts to drop it before the new VM starts.
export const patternDebugCycleNumberSequence = pgSequence(
  "pattern_debug_cycle_number_seq",
);

export const signalTypeEnum = pgEnum("signal_type", [
  "volume_spike",
  "oi_increase",
  "funding_rate",
  "strict_alpha",
  "alpha",
  "super_alpha",
  "short_sniper",
  "bingx_volume",
  "mexc_pump",
  "whale_watch",
]);

export const signalsTable = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    type: signalTypeEnum("type").notNull(),
    value: real("value").notNull(),
    threshold: real("threshold").notNull(),
    price: real("price").notNull(),
    priceChangePercent: real("price_change_percent").notNull(),
    volume24h: real("volume_24h").notNull(),
    avgVolume: real("avg_volume").notNull(),
    openInterest: real("open_interest"),
    oiChangePercent: real("oi_change_percent"),
    fundingRate: real("funding_rate"),
    tradingViewUrl: text("trading_view_url").notNull(),
    // New fields for alpha/super_alpha
    cmcRank: integer("cmc_rank"),
    cmcSource: text("cmc_source"),
    liquidationsUsd: real("liquidations_usd"),
    liquidationsMultiple: real("liquidations_multiple"),
    sentiment: text("sentiment"),
    sentimentKey: text("sentiment_key"),
    stealthDetectionMethod: text("stealth_detection_method"),
    /** Immutable Range venues which independently confirmed this lifecycle. */
    stealthRangeConfirmingVenues: jsonb(
      "stealth_range_confirming_venues",
    ).$type<string[] | null>(),
    /** Venue-independent Range family/window key; null for non-Range signals. */
    stealthRangeLifecycleKey: text("stealth_range_lifecycle_key"),
    alphaScore: integer("alpha_score"),
    isContinuing: boolean("is_continuing").default(false),
    cumulativeOiChange: real("cumulative_oi_change"),
    entryCvd15m: boolean("entry_cvd_15m"),
    entryCvd30m: boolean("entry_cvd_30m"),
    entryCvd1h: boolean("entry_cvd_1h"),
    entryCvd4h: boolean("entry_cvd_4h"),
    entryPrice3h: real("entry_price_3h"),
    entryPrice3hProvenance: text("entry_price_3h_provenance"),
    plmP24hCap18Pass: boolean("plm_p24h_cap_18_pass"),
    plmFutTakerShadow: text("plm_fut_taker_shadow"),
    plmOi30mShadow: text("plm_oi30m_shadow"),
    entryScoreBreakdown: text("entry_score_breakdown"),
    entryGradeReason: text("entry_grade_reason"),
    // Existing rows default to true during the additive migration. New primary
    // alerts explicitly begin false and are reconciled until the outbox accepts
    // their recipient-level delivery records.
    telegramAlertQueued: boolean("telegram_alert_queued")
      .notNull()
      .default(true),
    // Durable observation intent. It is written with the signal itself, then
    // leased and cleared only after the non-blocking AltBullet snapshot commits.
    altBulletSnapshotRequestedAt: timestamp("altbullet_snapshot_requested_at"),
    altBulletSnapshotClaimedAt: timestamp("altbullet_snapshot_claimed_at"),
    altBulletSnapshotClaimToken: text("altbullet_snapshot_claim_token"),
    // A transient market/lease failure must keep the observation intent alive
    // rather than materializing a misleading terminal "unavailable" snapshot.
    altBulletSnapshotAttemptCount: integer("altbullet_snapshot_attempt_count")
      .notNull()
      .default(0),
    altBulletSnapshotRetryAfter: timestamp("altbullet_snapshot_retry_after"),
    altBulletSnapshotLastError: text("altbullet_snapshot_last_error"),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    // Broadcast window dedup key: "symbol:30min_bucket" — unique per symbol per 30-min window.
    // ON CONFLICT DO NOTHING on this column prevents any second signal row for the same symbol
    // within the same 30-minute window, regardless of which code path fires it.
    // This is the "once and for all" dedup layer: two processes, two patterns, two race conditions
    // — only one row makes it to the DB, so only one Telegram delivery is ever enqueued.
    broadcastWindowKey: text("broadcast_window_key"),
  },
  (t) => [
    uniqueIndex("signals_broadcast_window_key_unique").on(t.broadcastWindowKey),
    uniqueIndex("signals_stealth_range_lifecycle_unique")
      .on(t.stealthRangeLifecycleKey)
      .where(sql`${t.stealthRangeLifecycleKey} IS NOT NULL`),
  ],
);

export const insertSignalSchema = createInsertSchema(signalsTable).omit({
  id: true,
});
export type InsertSignal = Omit<
  z.infer<typeof insertSignalSchema>,
  "stealthRangeConfirmingVenues"
> & { stealthRangeConfirmingVenues?: string[] | null };
export type Signal = typeof signalsTable.$inferSelect;

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  volumeMultiplier: real("volume_multiplier").notNull().default(2),
  oiChangePercent: real("oi_change_percent").notNull().default(5),
  fundingRateThreshold: real("funding_rate_threshold")
    .notNull()
    .default(0.0005),
  scanIntervalMs: integer("scan_interval_ms").notNull().default(1800000),
  telegramEnabled: boolean("telegram_enabled").notNull().default(true),
  maxSymbols: integer("max_symbols").notNull().default(50),
  channelId: text("channel_id"),
  watchlist: text("watchlist"), // comma-separated symbols always included in scan, e.g. "IOST-USDT,BIO-USDT"
  watchlistAddedAt: text("watchlist_added_at").default("{}"), // JSON: { "SYMBOL": timestamp }
  whaleWatchStagesJson: text("whale_watch_stages_json"), // persisted whale watch stages across restarts
  lastDailyReportAt: timestamp("last_daily_report_at"), // daily report dedup
  lastWeeklyDigestAt: timestamp("last_weekly_digest_at"), // weekly digest dedup
  lastMonthlyDigestAt: timestamp("last_monthly_digest_at"), // monthly digest dedup
  lastRestartNotifiedAt: timestamp("last_restart_notified_at"), // restart notification dedup across processes
  lastManualCheckSentAt: timestamp("last_manual_check_sent_at"), // manual-check near-stop dedup across processes
  lastPositionsReportAt: timestamp("last_positions_report_at"), // positions update dedup across processes
  scannerLastScanAt: timestamp("scanner_last_scan_at"), // cross-process: last successful scan completion time
  scannerScanStartedAt: timestamp("scanner_scan_started_at"), // cross-process: when current/last scan started (isScanning = startedAt > lastScanAt)
  scannerLastScanDurationMs: integer("scanner_last_scan_duration_ms"), // cross-process: duration of the last successful scan
  scannerLastFailureAt: timestamp("scanner_last_failure_at"), // compatibility status for scanner API consumers
  scannerLastFailureReason: text("scanner_last_failure_reason"), // compatibility status for scanner API consumers
  scannerRetryAt: timestamp("scanner_retry_at"), // compatibility status for scanner API consumers
  scannerFailureAt: timestamp("scanner_failure_at"), // last scanner failure, kept separate from successful completion
  scannerFailureReason: text("scanner_failure_reason"), // durable reason shown by the watchdog during recovery
  // Bounded JSON snapshot captured before a hard timeout / lease loss can
  // restart a worker. It makes transport, pool and phase failures diagnosable
  // after that worker is gone.
  scannerFailureDiagnosticsJson: text("scanner_failure_diagnostics_json"),
  scannerLeaseExpectedExpiryAt: timestamp("scanner_lease_expected_expiry_at"), // stale lease may block retries until this time
  lastCoinalyzeBatchAt: timestamp("last_coinalyze_batch_at"), // cross-process dedup for Coinalyze OI 24h batch
  lastCoinalyze30mAt: timestamp("last_coinalyze_30m_at"), // cross-process dedup for Coinalyze OI 30m batch
  lastCoinglassOutageAt: timestamp("last_coinglass_outage_at"), // cross-process dedup for CoinGlass outage alert
  lastWatchdogAlertAt: timestamp("last_watchdog_alert_at"), // cross-process watchdog dedup (prevents dual-worker double sends)
  retroStartedAt: timestamp("retro_started_at"), // cross-process mutex: retro job runs only on one process
  coinalyzeBatchJson: text("coinalyze_batch_json"), // cross-process Coinalyze 30m snapshot (JSON)
  // ── Smart Cancel thresholds ──────────────────────────────────────────────────
  smartCancelOiPct: real("smart_cancel_oi_pct").default(5.0), // мин. рост OI за 4ч (%) для блокировки отмены
  // ── Moonshot Momentum thresholds ─────────────────────────────────────────────
  moonshotVolMult: real("moonshot_vol_mult").default(5.0), // мин. объём (x) для паттерна Moonshot
  moonshotPriceChange: real("moonshot_price_change").default(15.0), // мин. рост цены (%) за 30m свечу
  moonshotOiChange: real("moonshot_oi_change").default(10.0), // мин. рост OI (%) для Moonshot
  moonshotAskWallUsd: real("moonshot_ask_wall_usd").default(50_000), // мин. стена на продажу ($) которая БЛОКИРУЕТ Moonshot
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({
  id: true,
});
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;

// ── OI baselines: persisted across restarts ───────────────────────────────────
export const oiBaselinesTable = pgTable("oi_baselines", {
  symbol: text("symbol").primaryKey(),
  oi: real("oi").notNull(),
  takenAt: timestamp("taken_at").notNull(),
});

// ── Alpha Watcher: signal outcome tracking ────────────────────────────────────
export const trackedStatusEnum = pgEnum("tracked_status", [
  "active", // Freshly created, being monitored
  "in_run", // Hit first target +10% — now trailing stop active
  "profit", // Closed in profit (trailing stop hit)
  "stop_loss", // Hit stop loss (-5% long / +5% short)
  "bu_stop", // Stopped at breakeven (in_run, price returned to entry) — counts as profit
  "breakeven", // Genuine neutral close, distinct from lifetime expiration
  "expired", // Maximum 4-day signal lifetime reached; close at observed PnL
  "cancelled", // Trade invalidated: OI dropped ≥ 5% or volume dried up
  "reclassified", // Administrative/technical reclassification; excluded from trade outcomes
]);

export const trackedSignalsTable = pgTable("tracked_signals", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  signalId: integer("signal_id").references(() => signalsTable.id),
  signalType: text("signal_type").notNull(), // "alpha" | "super_alpha" | "short_sniper"
  sentiment: text("sentiment"),
  sentimentKey: text("sentiment_key"),
  stealthDetectionMethod: text("stealth_detection_method"),
  alphaScore: integer("alpha_score"),
  isShort: boolean("is_short").notNull().default(false), // true for short_sniper
  entryPrice: real("entry_price").notNull(),
  entryOi: real("entry_oi"), // OI (base asset) at the moment of signal detection
  exitPrice: real("exit_price"),
  pnlPercent: real("pnl_percent"),
  // Immutable snapshot written by a database trigger on the first protected close.
  // Historical rows stay NULL: later peaks must not be passed off as close-time facts.
  protectedCloseEvidence: jsonb("protected_close_evidence").$type<
    Record<string, unknown>
  >(),
  protectedCloseAlertedAt: timestamp("protected_close_alerted_at"),
  peakPrice: real("peak_price"), // Best price seen (highest for long, lowest for short)
  trailingStopLevel: real("trailing_stop_level"), // entry price adjusted to peak PnL minus the configured percentage-point gap
  trailingStopArmedAt: timestamp("trailing_stop_armed_at"),
  lastMilestone: integer("last_milestone"), // Last milestone % announced (25, 50, 100, 200…)
  // Delivery is independent from the trading state: a Telegram timeout must not
  // erase a milestone that already activated breakeven/trailing protection.
  pendingMilestone: integer("pending_milestone"),
  pendingMilestoneKind: text("pending_milestone_kind"),
  pendingMilestonePrice: real("pending_milestone_price"),
  pendingMilestoneTrailingStop: real("pending_milestone_trailing_stop"),
  pendingMilestoneStatus: text("pending_milestone_status"),
  pendingMilestoneLeaseUntil: timestamp("pending_milestone_lease_until"),
  lastHourlyAt: timestamp("last_hourly_at"), // hourly update dedup
  lastPeriodicUpdateAt: timestamp("last_periodic_update_at"), // 4h periodic update dedup
  lastUpdateState: text("last_update_state"), // hold|exit|follow|neutral — POSITION UPDATE шлётся только при смене состояния
  healthPendingState: text("health_pending_state"), // candidate state awaiting a second consecutive evaluation
  healthPendingCount: integer("health_pending_count").notNull().default(0),
  healthSentTypes: text("health_sent_types").array().notNull().default([]),
  healthOrdinarySentCount: integer("health_ordinary_sent_count")
    .notNull()
    .default(0),
  healthLastOrdinaryAt: timestamp("health_last_ordinary_at"),
  lastVolBuildAt: timestamp("last_vol_build_at"), // accum vol-building alert dedup
  lastOiBuildAt: timestamp("last_oi_build_at"), // accum OI-building alert dedup
  lastSmartCancelCheckAt: timestamp("last_smart_cancel_check_at"), // smart cancel pause: первое срабатывание
  originalEntryPrice: real("original_entry_price"), // DCA/сплит: первоначальный вход до усреднений
  splitLimitPrice: real("split_limit_price"), // сплит-вход 50/50: уровень лимитки (−5% от первого входа)
  splitFilledAt: timestamp("split_filled_at"), // момент касания лимитки — entryPrice переписан на среднюю
  entryPolicyVersion: text("entry_policy_version"), // single_entry_v1 для новых позиций; NULL = legacy split
  dipBuyCount: integer("dip_buy_count").notNull().default(0), // DCA: число выполненных докупов (макс 3)
  price24hAtFire: real("price_24h_at_fire"), // price24h% в момент детекта (из prescanTracker)
  entryPrice3h: real("entry_price_3h"), // immutable price Δ3h% evaluated at signal fire
  entryPrice3hProvenance: text("entry_price_3h_provenance"), // source, or explicit reason why a PLM snapshot is absent
  plmP24hCap18Pass: boolean("plm_p24h_cap_18_pass"), // PLM shadow only: p24h <= 18%, never a live gate
  plmFutTakerShadow: text("plm_fut_taker_shadow"), // PLM shadow only: below_20 | at_or_above_20 | unavailable
  plmOi30mShadow: text("plm_oi30m_shadow"), // PLM shadow only: below_2 | at_or_above_2 | unavailable
  entryScoreBreakdown: text("entry_score_breakdown"), // immutable score components used at fire
  entryGradeReason: text("entry_grade_reason"), // alpha | score_8_plus_oi_2tf | oi30m_abs_15
  prescanCycles: integer("prescan_cycles"), // cycleCount из prescanTracker в момент детекта
  oiWatchEntryPrice: real("oi_watch_entry_price"), // цена входа в OI Watch (если сигнал пришёл из очереди)
  cancelReason: text("cancel_reason"), // причина отмены (stale/oi_drop/no_price/…)
  entryCvd15m: boolean("entry_cvd_15m"), // Spot CVD 15m (последняя 1 × 15m свеча) при создании сигнала
  entryCvd30m: boolean("entry_cvd_30m"), // Spot CVD 30m при создании сигнала
  entryCvd1h: boolean("entry_cvd_1h"), // Spot CVD 1h  при создании сигнала
  entryCvd4h: boolean("entry_cvd_4h"), // Spot CVD 4h  при создании сигнала
  marketCapUsd: real("market_cap_usd"), // Market cap USD при детекте (CoinGecko/SpotPool)
  // ── Entry metrics: OI/vol snapshot at the moment signal fires ─────────────
  entryOi15m: real("entry_oi_15m"), // CoinGlass aggregated OI Δ15m % при детекте (последняя 15m свеча)
  entryOi30m: real("entry_oi_30m"), // CoinGlass OI Δ30m % при детекте
  entryOi1h: real("entry_oi_1h"), // CoinGlass OI Δ1h % при детекте
  entryOi4h: real("entry_oi_4h"), // CoinGlass OI Δ4h % при детекте
  entryOi24h: real("entry_oi_24h"), // CoinGlass OI Δ24h % при детекте
  entryPrice1h: real("entry_price_1h"), // price % change за 1h в момент детекта (из prescanTracker)
  entryFutTakerNetBuy: real("entry_fut_taker_net_buy"), // Futures taker net buy % (CoinGlass) при детекте
  entrySpotVolMult: real("entry_spot_vol_mult"), // Спот vol mult (lastSpotVol1h/avg) при детекте
  entryFutVolMult: real("entry_fut_vol_mult"), // Фьюч vol mult (BingX 30m curVol/avgVol) при детекте
  // ── Диагностика spot/mcap гейтов (CONFIRMED FIRE, whale_watch, Pre-Breakout/Dark Flow) ──
  // Раньше считалось на лету в гейте и терялось (только logger.info). Копим 2-4 недели
  // для пересмотра порогов на реальных данных вместо догадок.
  entrySpotVol24h: real("entry_spot_vol_24h"), // Спот-объём 24h (USD) в момент срабатывания гейта
  entrySpotMcapPct: real("entry_spot_mcap_pct"), // spotVol24h / marketCapUsd * 100, вычислено в момент срабатывания
  // ── Spot taker / net-buy метрики (2026-07-15) — пишутся для ВСЕХ паттернов ──
  // Для тюнинга паттернов: кто из покупателей «давил» в момент сигнала.
  entrySpotTakerNetBuy: real("entry_spot_taker_net_buy"), // Spot taker net buy % (CoinGlass, последний ~30m цикл) — >0 давят покупки
  entrySpotNetBuy1h: real("entry_spot_net_buy_1h"), // Spot net buy 1h % (CoinGlass) — агрегат за час
  entrySpotNetBuy4h: real("entry_spot_net_buy_4h"), // Spot net buy 4h % (CoinGlass)
  entrySpotNetBuy24h: real("entry_spot_net_buy_24h"), // Spot net buy 24h % (CoinGlass)
  // entrySource хранит w.triggerTf в момент выстрела — реальный источник записи, отдельно от лейбла.
  entrySource: text("entry_source"),
  // Per-field origin: preserves whether an entry metric was captured while the
  // signal fired or recovered from a timestamped prescan snapshot later.
  entryMetricsProvenance: jsonb("entry_metrics_provenance").$type<
    Record<string, { source: string; observedAt: string }>
  >(),
  // Pattern-specific immutable decision payload captured atomically with the tracker row.
  impulseDecisionMetrics: jsonb("impulse_decision_metrics").$type<
    Record<string, unknown>
  >(),
  // Generic immutable decision-time payload. impulseDecisionMetrics remains
  // populated for compatibility with existing impulse-buy consumers.
  decisionMetrics: jsonb("decision_metrics").$type<Record<string, unknown>>(),
  // ── Универсальные метрики входа (2026-07-15) — пишутся для ВСЕХ паттернов ──
  // Общий знаменатель для анализа победителей vs проигравших. Fail-open: null при недоступности.
  entryRsi1h: real("entry_rsi_1h"), // CoinGlass RSI 1h в момент входа
  entryFundingRate: real("entry_funding_rate"), // BingX funding rate (raw decimal, 0.0001 = 0.01%) в момент входа
  entryLiqLong1h: real("entry_liq_long1h"), // longLiq1h (USD) при детекте liqCascade; null для других паттернов
  entryLiqLong24h: real("entry_liq_long24h"), // longLiq24h (USD) при детекте liqCascade
  entryLiqRatio: real("entry_liq_ratio"), // longLiq1h/longLiq24h при детекте (триггерное соотношение)
  entryLiqReason: text("entry_liq_reason"), // "liq_spike" | "liq_order_stream" — тип триггера
  entryBtc24h: real("entry_btc_24h"), // BTC price24h% в момент входа (рыночный режим)
  entryBtcPrice: real("entry_btc_price"), // цена BTC-USDT в момент входа; null если тикер недоступен
  closeBtcPrice: real("close_btc_price"), // цена BTC-USDT при финальном закрытии
  closeBtc24h: real("close_btc_24h"), // BTC price24h% при финальном закрытии; null для старой истории/ошибки источника
  // BTC.D is an observational snapshot, never a signal gate. Source and
  // observed time make unavailable historical values distinguishable from a
  // later live reading.
  entryBtcDominance: real("entry_btc_dominance"),
  entryBtcDominanceSource: text("entry_btc_dominance_source"),
  entryBtcDominanceObservedAt: timestamp("entry_btc_dominance_observed_at"),
  closeBtcDominance: real("close_btc_dominance"),
  closeBtcDominanceSource: text("close_btc_dominance_source"),
  closeBtcDominanceObservedAt: timestamp("close_btc_dominance_observed_at"),
  // Frozen exit policy is assigned only when a new position is created.
  // NULL preserves legacy/open behavior forever.
  policyVersion: text("policy_version"),
  runnerState: text("runner_state"), // open | closed; only for frozen runner policies
  coreClosedAt: timestamp("core_closed_at"),
  coreExitPrice: real("core_exit_price"),
  corePnlPercent: real("core_pnl_percent"),
  coreCloseEventKey: text("core_close_event_key"),
  runnerPeakPrice: real("runner_peak_price"),
  runnerTrailingStopLevel: real("runner_trailing_stop_level"),
  runnerTrailingStopArmedAt: timestamp("runner_trailing_stop_armed_at"),
  runnerExitPrice: real("runner_exit_price"),
  runnerPnlPercent: real("runner_pnl_percent"),
  runnerClosedAt: timestamp("runner_closed_at"),
  runnerCloseEventKey: text("runner_close_event_key"),
  entryWhaleIndex: real("entry_whale_index"), // CoinGlass Whale Index по токену (Binance, 4h) в момент входа; null = нет данных (BingX-эксклюзив и т.п.)
  entryGlobalLongPct: real("entry_global_long_pct"), // % всех аккаунтов в лонге, ТОЛЬКО Binance (CoinGlass global-long-short-account-ratio, 1h) в момент входа; null = токена нет на Binance/нет данных
  entryObBids: real("entry_ob_bids"), // BingX orderbook: суммарный объём бидов USD в момент входа (топ-20 уровней)
  entryObAsks: real("entry_ob_asks"), // BingX orderbook: суммарный объём асков USD в момент входа
  entryObRatio: real("entry_ob_ratio"), // bid/ask ratio (entryObBids / entryObAsks): >1 = покупатели давят, <1 = продавцы
  // ── Exit metrics: полный рыночный снапшот в момент закрытия сигнала (2026-07-30) ──
  // Источник: in-memory prescanTracker (данные последнего scan-цикла, ~14 мин давности макс).
  // Пишутся best-effort при КАЖДОМ переходе в финальный статус (profit/stop_loss/cancelled/breakeven/expired/bu_stop).
  // Null = токен вне prescan в момент закрытия (выпал из топ-N) или cold start.
  exitOi30m: real("exit_oi_30m"), // CoinGlass OI Δ30m % при закрытии
  exitOi1h: real("exit_oi_1h"), // OI Δ1h %
  exitOi4h: real("exit_oi_4h"), // OI Δ4h %
  exitOi24h: real("exit_oi_24h"), // OI Δ24h %
  exitCvd15m: boolean("exit_cvd_15m"), // Spot CVD 15m verdict при закрытии
  exitCvd30m: boolean("exit_cvd_30m"), // Spot CVD 30m
  exitCvd1h: boolean("exit_cvd_1h"), // Spot CVD 1h
  exitCvd4h: boolean("exit_cvd_4h"), // Spot CVD 4h
  exitWhaleIndex: real("exit_whale_index"), // Whale Index при закрытии
  exitSpotTakerNetBuy: real("exit_spot_taker_net_buy"), // Spot taker net buy % при закрытии
  exitFutTakerNetBuy: real("exit_fut_taker_net_buy"), // Futures taker net buy % при закрытии
  exitSpotNetBuy1h: real("exit_spot_net_buy_1h"), // Spot net buy 1h % при закрытии
  exitSpotVol1h: real("exit_spot_vol_1h"), // Спот объём 1h USD при закрытии
  exitSpotVolMult: real("exit_spot_vol_mult"), // Спот vol mult (lastSpotVol1h/avg) при закрытии
  exitFutVolMult: real("exit_fut_vol_mult"), // Фьюч vol mult (BingX 30m curVol/avgVol) при закрытии
  exitFundingRate: real("exit_funding_rate"), // Funding rate (raw decimal) при закрытии
  exitPrice1h: real("exit_price_1h"), // price % change за 1h при закрытии
  exitPrice24h: real("exit_price_24h"), // price24h% при закрытии
  exitFutSpotRatio: real("exit_fut_spot_ratio"), // futVol/spotVol 24h ratio при закрытии
  // ── Bid Wall (CoinGlass futures large limit orders) ──────────────────────────────────────────
  // Крупные resting limit-биды в стакане Binance в пределах -6% от цены; обновляется каждый FastCycle.
  largeBidUsd: real("large_bid_usd"), // суммарный USD крупных бидов в пределах -6% (CoinGlass futures /large-limit-order)
  largeBidNearestPct: real("large_bid_nearest_pct"), // ближайший крупный бид, дистанция от цены (%, отрицательное)
  largeBidOrderCount: integer("large_bid_order_count"), // кол-во крупных бид-ордеров в диапазоне
  // ── Spot Bid Wall (CoinGlass spot large limit orders) ────────────────────────────────────────
  // Спотовый стакан Binance — крупные биды в пределах -6% от цены; обновляется каждый FastCycle.
  spotBidUsd: real("spot_bid_usd"), // суммарный USD крупных спот-бидов (CoinGlass spot /large-limit-order)
  spotBidNearestPct: real("spot_bid_nearest_pct"), // ближайший крупный спот-бид, дистанция (%, отрицательное)
  spotBidOrderCount: integer("spot_bid_order_count"), // кол-во крупных спот-бид-ордеров в диапазоне
  // ── Sell Wall (CoinGlass futures large ask orders) ───────────────────────────
  // Крупные resting limit-аски в стакане Binance в пределах +6% от цены; обновляется каждый FastCycle.
  largeAskUsd: real("large_ask_usd"), // суммарный USD крупных асков (сопротивление)
  largeAskNearestPct: real("large_ask_nearest_pct"), // ближайший крупный аск, дистанция (%, положительное)
  largeAskOrderCount: integer("large_ask_order_count"), // кол-во крупных аск-ордеров в диапазоне
  // ── Spot Sell Wall (CoinGlass spot large ask orders) ─────────────────────────
  // Спотовый стакан Binance — крупные аски выше цены в пределах +6%; обновляется каждый FastCycle.
  // Только для Binance-listed токенов (isBinanceSpotListed). BingX-exclusive → null by design.
  spotAskUsd: real("spot_ask_usd"), // суммарный USD крупных спот-асков (сопротивление)
  spotAskNearestPct: real("spot_ask_nearest_pct"), // ближайший крупный спот-аск, дистанция (%, положительное)
  spotAskOrderCount: integer("spot_ask_order_count"), // кол-во крупных спот-аск-ордеров в диапазоне
  // ── Индивидуальные стоп/тейки по Liquidation Heatmap (CoinGlass Professional) ──
  // null = стандартный стоп -10% (старые сигналы и токены без heatmap-данных)
  stopLossPrice: real("stop_loss_price"), // абсолютный уровень стопа (кластер ликвидаций − 2%)
  stopLossPct: real("stop_loss_pct"), // глубина стопа в % от входа (положительное число)
  stopSource: text("stop_source"), // "liq_heatmap" | "standard" (null = standard)
  takeTargets: jsonb("take_targets"), // [{price, pctFromEntry, liqUsd}] — цели по кластерам шорт-ликвидаций
  status: trackedStatusEnum("status").notNull().default("active"),
  reEntryCount: integer("re_entry_count").notNull().default(0),
  detectedAt: timestamp("detected_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  // Цена, наблюдённая не раньше чем через 72ч после закрытия (cancel/stop_loss).
  // Это не обязательно цена ровно на отметке 72ч; observedAt хранит фактическое
  // время тикера, чтобы ретро-аудит не выдавал задержанный снапшот за точный.
  price72hAfterExitPct: real("price_72h_after_exit_pct"),
  price72hAfterExitObservedAt: timestamp("price_72h_after_exit_observed_at"),
});

export const insertTrackedSignalSchema = createInsertSchema(
  trackedSignalsTable,
).omit({ id: true });
export type InsertTrackedSignal = z.infer<typeof insertTrackedSignalSchema>;
export type TrackedSignal = typeof trackedSignalsTable.$inferSelect;

// ── AltBullet Neon indicator snapshots ───────────────────────────────────────
// The custom 4H price-action indicator is observational only: every alert gets
// one immutable reading after primary delivery, regardless of its verdict.
export const altBulletIndicatorSnapshotsTable = pgTable(
  "altbullet_indicator_snapshots",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id")
      .notNull()
      .references(() => signalsTable.id),
    symbol: text("symbol").notNull(),
    sentimentKey: text("sentiment_key"),
    indicatorVersion: text("indicator_version").notNull(),
    timeframe: text("timeframe").notNull().default("4h"),
    status: text("status").notNull().default("ready"),
    score: integer("score"),
    verdict: text("verdict"),
    checks:
      jsonb("checks").$type<
        Record<string, boolean | "pass" | "fail" | "unknown">
      >(),
    context:
      jsonb("context").$type<
        Record<string, number | string | boolean | null>
      >(),
    audit: jsonb("audit").$type<{
      dataSource: string;
      lastClosed4hAt: string | null;
      lastClosed1hAt: string | null;
      isClosed: boolean;
      requestedAt?: string;
      freshness1hMs?: number | null;
      freshness4hMs?: number | null;
      btc?: {
        regime: "bull" | "neutral" | "bear" | "unknown";
        roc24h: number | null;
        lastClosedAt: string | null;
        freshnessMs: number | null;
        reason: string;
      };
      checks: Record<
        string,
        {
          passed: boolean;
          state?: "pass" | "fail" | "unknown";
          reason?: string;
          actual: number | string | null;
          threshold: number | string | null;
          actualLabel: string;
          thresholdLabel: string;
        }
      >;
    }>(),
    error: text("error"),
    capturedAt: timestamp("captured_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("altbullet_indicator_snapshot_signal_unique").on(
      table.signalId,
    ),
    index("altbullet_indicator_snapshot_verdict_idx").on(table.verdict),
  ],
);

export const milestoneNotificationDeliveriesTable = pgTable(
  "milestone_notification_deliveries",
  {
    id: serial("id").primaryKey(),
    trackedSignalId: integer("tracked_signal_id").notNull(),
    milestone: integer("milestone").notNull(),
    milestoneKind: text("milestone_kind").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull().default("ready"),
    leaseUntil: timestamp("lease_until"),
    claimToken: text("claim_token"),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("milestone_notification_delivery_unique").on(
      table.trackedSignalId,
      table.milestoneKind,
      table.milestone,
      table.target,
    ),
    index("milestone_notification_delivery_state_idx").on(
      table.status,
      table.leaseUntil,
    ),
  ],
);

/**
 * Durable, recipient-level delivery state for critical Telegram events.
 * `sendAttemptedAt` is a pre-send fence: if the process loses the final DB
 * acknowledgement after calling Telegram, recovery quarantines the row instead
 * of sending a duplicate that Telegram may have already accepted.
 */
export const telegramDeliveryEventsTable = pgTable(
  "telegram_delivery_events",
  {
    id: serial("id").primaryKey(),
    eventKey: text("event_key").notNull(),
    expectedRecipientCount: integer("expected_recipient_count").notNull(),
    status: text("status").notNull().default("queued"),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at"),
    attentionAt: timestamp("attention_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_delivery_event_key_unique").on(table.eventKey),
    index("telegram_delivery_event_status_idx").on(
      table.status,
      table.updatedAt,
    ),
  ],
);

export const telegramDeliveryAttemptAuditTable = pgTable(
  "telegram_delivery_attempt_audit",
  {
    id: serial("id").primaryKey(),
    auditKey: text("audit_key").notNull(),
    deliveryId: integer("delivery_id").notNull(),
    dedupKey: text("dedup_key").notNull(),
    target: text("target").notNull(),
    phase: text("phase").notNull(),
    partIndex: integer("part_index").notNull(),
    outcome: text("outcome").notNull(),
    httpStatus: integer("http_status"),
    classification: text("classification").notNull().default("unknown"),
    retryAfterSeconds: integer("retry_after_seconds"),
    reason: text("reason").notNull(),
    attempt: integer("attempt").notNull().default(0),
    sendAttemptedAt: timestamp("send_attempted_at"),
    observedAt: timestamp("observed_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_delivery_attempt_audit_key_unique").on(
      table.auditKey,
    ),
    index("telegram_delivery_attempt_audit_observed_idx").on(table.observedAt),
    index("telegram_delivery_attempt_audit_delivery_idx").on(table.deliveryId),
  ],
);

/**
 * Telegram file IDs are reusable for the same bot. This table turns a local
 * pattern PNG into one shared media reference across outbox recipients,
 * worker processes, and restarts. The lease elects exactly one fresh uploader
 * when an asset has not been seen by Telegram yet.
 */
export const telegramPatternMediaCacheTable = pgTable(
  "telegram_pattern_media_cache",
  {
    mediaKey: text("media_key").primaryKey(),
    fileId: text("file_id"),
    leaseUntil: timestamp("lease_until"),
    claimToken: text("claim_token"),
    uploadAttemptedAt: timestamp("upload_attempted_at"),
    uploadEventKey: text("upload_event_key"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("telegram_pattern_media_cache_lease_idx").on(table.leaseUntil),
  ],
);

export const telegramPhotoDeliveriesTable = pgTable(
  "telegram_photo_deliveries",
  {
    id: serial("id").primaryKey(),
    dedupKey: text("dedup_key").notNull(),
    target: text("target").notNull(),
    photoPath: text("photo_path").notNull(),
    caption: text("caption").notNull(),
    fallbackText: text("fallback_text").notNull(),
    continuationTexts: jsonb("continuation_texts")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status").notNull().default("ready"),
    phase: text("phase").notNull().default("photo"),
    nextPartIndex: integer("next_part_index").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    leaseUntil: timestamp("lease_until"),
    claimToken: text("claim_token"),
    sendAttemptedAt: timestamp("send_attempted_at"),
    acceptedAt: timestamp("accepted_at"),
    deliveredAt: timestamp("delivered_at"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    photoAttempts: integer("photo_attempts").notNull().default(0),
    plainText: boolean("plain_text").notNull().default(false),
    ambiguousRetryCount: integer("ambiguous_retry_count").notNull().default(0),
    repeatNotice: boolean("repeat_notice").notNull().default(false),
    // 1 = legacy row created before the at-most-once policy; 2 = current
    // state machine. Startup quarantines legacy retry rows before any drain.
    deliveryPolicyVersion: integer("delivery_policy_version")
      .notNull()
      .default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("telegram_photo_delivery_dedup_target_unique").on(
      table.dedupKey,
      table.target,
    ),
    index("telegram_photo_delivery_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
  ],
);

export const telegramDeliveryRateLimitsTable = pgTable(
  "telegram_delivery_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    nextAllowedAt: timestamp("next_allowed_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("telegram_delivery_rate_limits_due_idx").on(table.nextAllowedAt),
  ],
);
export const oiWatchStatusEnum = pgEnum("oi_watch_status", [
  "watching", // active, being monitored every 2 min
  "fired", // signal fired from watch list (volume confirmed)
  "expired", // 2h elapsed without confirmation
  "confirming", // detected condition, waiting 7 min to confirm move is sustained (not flash pump)
]);

export const oiWatchTable = pgTable(
  "oi_watch",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    triggerTf: text("trigger_tf").notNull(), // "5m"|"30m"|"1h"|"4h"|"24h" — what TF triggered OI
    oiChange: real("oi_change").notNull(), // OI change % at detection
    priceAtEntry: real("price_at_entry").notNull(), // price when added to watch
    volumeMultiplier: real("volume_multiplier").notNull(), // vol at detection
    sentimentKey: text("sentiment_key"), // predicted pattern
    oi30mChange: real("oi_30m"), // CoinGlass 30m OI % at detection
    oi1hChange: real("oi_1h"), // CoinGlass 1h OI % at detection
    oi24hChange: real("oi_24h"), // CoinGlass 24h OI % at detection
    price1hChange: real("price_1h_change"), // price % change 1h at entry
    price24hChange: real("price_24h_change"), // price % change 24h at entry
    currentVolMult: real("current_vol_mult"), // live vol multiplier updated each watcher cycle
    volStatusReason: text("vol_status_reason"), // why volConfirmed is true/false: no_turnover|cvd_unavail|cvd_negative|confirmed
    entryVolMult: real("entry_vol_mult"), // volMult в момент добавления в watch (для межцикловой дельты)
    entryCgTurnover: real("entry_cg_turnover"), // CoinGlass turnover (vol/OI) при добавлении
    lastOiCheck: real("last_oi_check"), // OI 30m при последней проверке PATH B (для отслеживания динамики)
    prevOiCheck: real("prev_oi_check"), // OI 30m при предпоследней проверке PATH B
    prevOiCheck2: real("prev_oi_check2"), // OI 30m двумя циклами ранее (для 3-цикловой проверки падения)
    status: oiWatchStatusEnum("status").notNull().default("watching"),
    addedAt: timestamp("added_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    firedAt: timestamp("fired_at"),
    avgVolume: real("avg_volume"), // stored to avoid re-fetching klines
    // ── Two-stage confirmation fields ──────────────────────────────────────────
    isVolConfirmed: boolean("is_vol_confirmed").notNull().default(false), // vol was already ≥ 2x at scanner time
    signalPayload: jsonb("signal_payload"), // full AlphaResult + InsertSignal — used to fire from watcher
  },
  (table) => ({
    symbolStatusIdx: index("oi_watch_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    statusIdx: index("oi_watch_status_idx").on(table.status),
  }),
);

export type OiWatch = typeof oiWatchTable.$inferSelect;
export type InsertOiWatch = typeof oiWatchTable.$inferInsert;

// ── Daily OI Snapshots: long-term whale accumulation tracking ─────────────────
// One row per symbol per day. Used to detect sustained whale accumulation over weeks/months.
export const oiDailySnapshotsTable = pgTable("oi_daily_snapshots", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  date: text("date").notNull(), // "YYYY-MM-DD" — one entry per symbol per day
  oiUsd: real("oi_usd"), // Open Interest in USD from CoinGlass
  oiChange24h: real("oi_change_24h"), // 24h OI change %
  priceUsd: real("price_usd"), // price at snapshot time
  volume24h: real("volume_24h"), // 24h volume USD
  takenAt: timestamp("taken_at").notNull().defaultNow(),
});

export type OiDailySnapshot = typeof oiDailySnapshotsTable.$inferSelect;
export type InsertOiDailySnapshot = typeof oiDailySnapshotsTable.$inferInsert;

// ── Whale Watch 2.0: Spot CVD Accumulation Watchlist ─────────────────────────
// Each row = one symbol being monitored for whale accumulation via Spot CVD.
// avgBuyPrice tracks weighted-average price of accumulation periods for Smart Cancel.
export const whaleWatchlistTable = pgTable("whale_watchlist", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  /** Накопленный спот CVD (сумма нетто-покупок в USD) за период наблюдения */
  accumulatedCvdUsd: real("accumulated_cvd_usd").notNull().default(0),
  /** Количество накопительных 5m периодов подряд (или с момента добавления) */
  accumPeriods: integer("accum_periods").notNull().default(0),
  /** Средневзвешенная цена накопления (для Smart Cancel) */
  avgBuyPrice: real("avg_buy_price"),
  /** Market Cap токена USD (CoinGecko, кэш 24ч) */
  marketCapUsd: real("market_cap_usd"),
  /** 24h объём споте USD на момент добавления */
  vol24hUsd: real("vol24h_usd"),
  /** Цена при первом обнаружении */
  priceAtEntry: real("price_at_entry"),
  /** Последняя известная цена */
  lastPrice: real("last_price"),
  /** Алерт о входе в накопление уже отправлен */
  alertedAt: timestamp("alerted_at"),
  /** Сигнал пробоя уже отправлен (breakout fired) */
  breakoutFiredAt: timestamp("breakout_fired_at"),
  /** Статус: watching | accumulating | breakout | expired */
  status: text("status").notNull().default("watching"),
});

export type WhaleWatchlistRow = typeof whaleWatchlistTable.$inferSelect;
export type InsertWhaleWatchlist = typeof whaleWatchlistTable.$inferInsert;

// ── Prescan Tracker: persist cycle counts across restarts ─────────────────────
// Key fields saved after every scan cycle so cycleCount / firstSeenAt survive
// server rebuilds. Volatile per-cycle fields (lastOi*, lastScore, etc.) are
// recomputed on the next scan and are NOT stored here.

export const prescanTrackerTable = pgTable("prescan_tracker", {
  symbol: text("symbol").primaryKey(),
  cycleCount: integer("cycle_count").notNull().default(1),
  firstSeenAt: real("first_seen_at").notNull(), // unix ms (stored as float)
  bestRank: integer("best_rank").notNull().default(1),
  firstPrice: real("first_price").notNull(),
  firstPrice24h: real("first_price_24h").notNull(),
  firstScore: real("first_score").notNull(),
  lastFiredAt: real("last_fired_at").notNull().default(0), // unix ms; 0 = never
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // Live fields: persisted every cycle so DB-fallback path also shows current data
  lastPrice: real("last_price"), // текущая цена (обновляется каждый цикл)
  lastOi30m: real("last_oi_30m"), // OI Δ30m %
  lastOi1h: real("last_oi_1h"), // OI Δ1h %
  lastOi4h: real("last_oi_4h"), // OI Δ4h %
  lastOi24h: real("last_oi_24h"), // OI Δ24h %
  prevOi30m: real("prev_oi_30m"), // OI Δ30m % прошлого цикла (для расчёта ускорения)
  prevOi4h: real("prev_oi_4h"), // OI Δ4h % прошлого цикла
  lastPrice1h: real("last_price_1h"), // Изменение цены за 1ч (%)
  // null = ещё не проверяли; true = CG таймаут; false = CG спросили, данных нет (не покрывает токен)
  lastCgTimedOut: boolean("last_cg_timed_out"),
  // ── Progression fields: счётчики прогрессии между циклами ───────────────────
  // Эти поля раньше жили только в памяти и сбрасывались при каждом рестарте.
  // Теперь персистируются чтобы история накопления переживала деплои.
  cvdPositiveCycles: integer("cvd_positive_cycles"), // циклов подряд spot CVD 5m > 0 (сбрасывается при первом минусе)
  takerPositiveCycles: integer("taker_positive_cycles"), // циклов подряд futures taker netBuyPct > 0 (из CoinGlass)
  oiAccel30m: real("oi_accel_30m"), // ускорение OI 30m: lastOi30m / prevOi30m (>1 = растёт)
  oi4hConsecGrowth: integer("oi_4h_consec_growth"), // сколько подряд циклов OI4h растёт (для spot_oi4h_build)
  // ── Спот объём 1h (CoinGlass pairs-markets) ──────────────────────────────────
  lastSpotVol1h: real("last_spot_vol_1h"), // спот объём 1h USD (последний цикл)
  prevSpotVol1h: real("prev_spot_vol_1h"), // спот объём 1h USD (прошлый цикл)
  lastSpotVol4h: real("last_spot_vol_4h"), // спот объём 4h USD
  lastSpotNetBuy1h: real("last_spot_net_buy_1h"), // (buy-sell)/(buy+sell)*100 за 1h
  spotVolAvg1h: real("spot_vol_avg_1h"), // скользящее среднее за 5 циклов
  spotVolCycles: integer("spot_vol_cycles").notNull().default(0), // количество накопленных циклов
  layers: text("layers").array().notNull().default([]), // prescan layers последнего цикла: WL/L1/L2/L3/L4/L5/L7/L8
  // ── Futures vs Spot Volume (CoinGlass futures_spot_volume_ratio, Binance+OKX+Bybit) ─
  futVolUsd24h: real("fut_vol_usd_24h"), // фьючерсный объём 24h USD
  spotVolUsd24h: real("spot_vol_usd_24h"), // спотовый объём 24h USD
  futSpotRatio: real("fut_spot_ratio"), // futVolUsd24h / spotVolUsd24h
  futVolPctMcap: real("fut_vol_pct_mcap"), // futVolUsd24h / mcapUsd * 100
  spotVolPctMcap: real("spot_vol_pct_mcap"), // spotVolUsd24h / mcapUsd * 100
  // ── Первичный снимок OI при входе в prescan ──────────────────────────────────
  // Устанавливаются при первом INSERT (COALESCE — никогда не перезаписываются).
  // Ключевые для калибровки: что было видно ДО начала роста токена.
  firstOi30m: real("first_oi_30m"), // OI Δ30m % при первом появлении
  firstOi1h: real("first_oi_1h"), // OI Δ1h % при первом появлении
  firstOi4h: real("first_oi_4h"), // OI Δ4h % при первом появлении
  // ── Snapshot при входе в prescan: OB ratio + funding rate ────────────────────
  firstObRatio: real("first_ob_ratio"), // bid/ask ratio при первом попадании в prescan
  firstFundingRate: real("first_funding_rate"), // funding rate при первом попадании (raw decimal)
  firstWhaleIndex: real("first_whale_index"), // Whale Index при первом попадании в prescan (lazy: первое ненулевое значение из batchUpdateWhaleIndex)
  firstSnf1h: real("first_snf_1h"), // Spot NetFlow 1h % при первом попадании (lazy: первое ненулевое значение из SNF кэша)
  lastWhaleIndex: real("last_whale_index"), // Whale Index по токену (CoinGlass, Binance futures) — обновляется раз в цикл для OI Watch + топ prescan
  lastPrice24h: real("last_price_24h"), // последнее ненулевое priceChangePercent% (обновляется каждый цикл; персистируется для корректной загрузки после рестарта)
  // ── Taker / CVD verdicts: персистируются чтобы после рестарта UI/гейты не показывали "—" до следующего скана ─
  lastNetBuyPct: real("last_net_buy_pct"), // последний netBuyPct (%) из getCoinglassTakerFlow (futures taker)
  lastSpotTakerNetBuy: real("last_spot_taker_net_buy"), // netBuyPct% последней 30m спот свечи
  lastSpotTakerDominance: text("last_spot_taker_dominance"), // "buy" | "sell" | "neutral"
  lastCvd15m: boolean("last_cvd_15m"), // spot CVD 15m verdict (последняя 1 × 15m свеча; null = не проверяли)
  lastCvd30m: boolean("last_cvd_30m"), // spot CVD 30m verdict (null = не проверяли)
  lastCvd1h: boolean("last_cvd_1h"), // spot CVD 1h verdict
  lastCvd4h: boolean("last_cvd_4h"), // spot CVD 4h verdict
  lastVolMult: real("last_vol_mult"), // BingX futures vol mult (curVol30m/avgVol30m) — обновляется каждый цикл, персистируется для log-time обогащения
  hasFiredBefore: boolean("has_fired_before").default(false), // true после первого выстрела сигнала — подавляет повторную пометку freshMoverRisk
});

export type PrescanTrackerRow = typeof prescanTrackerTable.$inferSelect;

// ── Prescan History: per-cycle OI/CVD snapshot for top-30 tokens ──────────────
// Пишем снимок каждый скан-цикл для топ-30 пресканера.
// TTL 7 дней — старые строки удаляются в savePrescanHistory() перед каждой записью.
// Используется для ретроспективного анализа: когда OI 4h стал отрицательным,
// как менялся CVD между циклами, почему токен не получил сигнал.
export const prescanHistoryTable = pgTable(
  "prescan_history",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    ts: timestamp("ts").notNull().defaultNow(),
    cycleCount: integer("cycle_count"),
    rank: integer("rank"),
    score: real("score"),
    price24h: real("price_24h"),
    price1h: real("price_1h"),
    oi30m: real("oi_30m"),
    oi1h: real("oi_1h"),
    oi4h: real("oi_4h"),
    oi24h: real("oi_24h"),
    volMult: real("vol_mult"),
    cvd30m: boolean("cvd_30m"),
    cvd1h: boolean("cvd_1h"),
    netBuyPct: real("net_buy_pct"), // futures taker net buy %
    spotTakerNetBuy: real("spot_taker_net_buy"), // spot taker net buy %
    oiAccel30m: real("oi_accel_30m"), // OI 30m acceleration ratio (lastOi30m / prevOi30m)
    futSpotRatio: real("fut_spot_ratio"), // futures / spot volume ratio
    whaleIndex: real("whale_index"), // Whale Index (CoinGlass, Binance futures) — для ретро-бэкфилла
    snf1h: real("snf_1h"), // Spot NetFlow 1h % (из SNF кэша) — для ретро-бэкфилла
    obRatio: real("ob_ratio"), // OB bid/ask ratio (из prescanTracker.firstObRatio) — для ретро-бэкфилла
  },
  (table) => ({
    symbolTsUnique: uniqueIndex("prescan_history_symbol_ts_unique").on(
      table.symbol,
      table.ts,
    ),
    tsIdx: index("prescan_history_ts_idx").on(table.ts),
  }),
);

export type PrescanHistoryRow = typeof prescanHistoryTable.$inferSelect;

export const prescanTelemetryOutboxTable = pgTable(
  "prescan_telemetry_outbox",
  {
    id: serial("id").primaryKey(),
    dedupKey: text("dedup_key").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("ready"),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    leaseUntil: timestamp("lease_until"),
    claimToken: text("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("prescan_telemetry_outbox_dedup_unique").on(table.dedupKey),
    index("prescan_telemetry_outbox_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
  ],
);
export const missedMoversTable = pgTable(
  "missed_movers",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    exitedAt: timestamp("exited_at").notNull().defaultNow(),
    firstSeenAt: real("first_seen_at"), // unix ms (из prescan_tracker.first_seen_at)
    cyclesInPool: integer("cycles_in_pool"),
    // 'overheated' | 'oi_too_hot' | 'vol_drop' | 'timeout' | 'extreme_pump' | 'extreme_dump'
    exitReason: text("exit_reason"),
    // Цена
    p24hAtExit: real("p24h_at_exit"), // last_price_24h % при выходе
    p1hAtExit: real("p1h_at_exit"), // last_price_1h % при выходе
    priceAtExit: real("price_at_exit"), // абсолютная цена при выходе
    // OI
    oi30mAtExit: real("oi30m_at_exit"),
    oi1hAtExit: real("oi1h_at_exit"),
    oi4hAtExit: real("oi4h_at_exit"),
    // Объём
    volMultAtExit: real("vol_mult_at_exit"), // BingX futures vol mult
    spotVolUsd24h: real("spot_vol_usd_24h"),
    futSpotRatio: real("fut_spot_ratio"),
    // Микроструктура
    whaleIndex: real("whale_index"),
    snf1h: real("snf_1h"),
    fundingRate: real("funding_rate"),
    obRatioAtExit: real("ob_ratio_at_exit"),
    cvd30m: boolean("cvd_30m"),
    cvd1h: boolean("cvd_1h"),
    cvd4h: boolean("cvd_4h"),
    // Причины отказа PDB из scan_reject_log (последний цикл перед выходом)
    // Формат: { balanced_grind: 'oi30m_range', stealth_breakout: 'no_breakout', ... }
    rejectReasons: jsonb("reject_reasons").$type<Record<string, string>>(),
    // Бэкфил (заполняются hourly-джобом fillMissedMoversPrices)
    price24hAfter: real("price_24h_after"), // BingX цена ≥24ч после выхода
    price72hAfter: real("price_72h_after"), // BingX цена ≥72ч после выхода
    peakPctAfter24h: real("peak_pct_after_24h"), // % от priceAtExit на момент заполнения 24h
  },
  (t) => [
    index("missed_movers_exited_at_idx").on(t.exitedAt),
    index("missed_movers_symbol_idx").on(t.symbol),
    uniqueIndex("missed_movers_sym_exited_uniq").on(t.symbol, t.exitedAt),
  ],
);
export type MissedMoverRow = typeof missedMoversTable.$inferSelect;
export type InsertMissedMover = typeof missedMoversTable.$inferInsert;

// ── Missed Movers Price Samples: hourly intraday ticks during the 24h window ──
// One row per (missed_mover_id, sampled_at truncated to hour).
// peakPctAfter24h on missed_movers is computed as MAX(price) / priceAtExit over these rows.
export const missedMoversPricesTable = pgTable(
  "missed_movers_prices",
  {
    id: serial("id").primaryKey(),
    missedMoverId: integer("missed_mover_id")
      .notNull()
      .references(() => missedMoversTable.id, { onDelete: "cascade" }),
    sampledAt: timestamp("sampled_at").notNull(),
    price: real("price").notNull(),
  },
  (t) => [
    index("mmp_mover_id_idx").on(t.missedMoverId),
    uniqueIndex("missed_movers_prices_missed_mover_id_sampled_at_key").on(
      t.missedMoverId,
      t.sampledAt,
    ),
  ],
);
export type MissedMoversPricesRow = typeof missedMoversPricesTable.$inferSelect;
export type InsertMissedMoversPrice =
  typeof missedMoversPricesTable.$inferInsert;

// ── Missed Mover Prescan Trajectory ──────────────────────────────────────────
// Durable copy of the per-cycle snapshots that preceded a missed mover's exit.
// sourceSnapshotId is provenance only, intentionally without an FK: the rolling
// prescan_snapshots TTL must never delete this child record before its parent.
export const missedMoverPrescanSnapshotsTable = pgTable(
  "missed_mover_prescan_snapshots",
  {
    id: serial("id").primaryKey(),
    missedMoverId: integer("missed_mover_id")
      .notNull()
      .references(() => missedMoversTable.id, { onDelete: "cascade" }),
    sourceSnapshotId: integer("source_snapshot_id").notNull(),
    isExitSnapshot: boolean("is_exit_snapshot").notNull().default(false),
    cycleAt: timestamp("cycle_at").notNull(),
    p24h: real("p24h"),
    p1h: real("p1h"),
    price: real("price"),
    oi30m: real("oi30m"),
    oi1h: real("oi1h"),
    oi4h: real("oi4h"),
    volMult: real("vol_mult"),
    spotVolUsd24h: real("spot_vol_usd_24h"),
    futSpotRatio: real("fut_spot_ratio"),
    whaleIndex: real("whale_index"),
    snf1h: real("snf_1h"),
    fundingRate: real("funding_rate"),
    obRatio: real("ob_ratio"),
    cvd30m: boolean("cvd_30m"),
    cvd1h: boolean("cvd_1h"),
    cvd4h: boolean("cvd_4h"),
    cyclesInPool: integer("cycles_in_pool"),
  },
  (t) => [
    index("mmps_mover_cycle_idx").on(t.missedMoverId, t.cycleAt),
    uniqueIndex("mmps_mover_source_snapshot_uniq").on(
      t.missedMoverId,
      t.sourceSnapshotId,
    ),
  ],
);
export type MissedMoverPrescanSnapshotRow =
  typeof missedMoverPrescanSnapshotsTable.$inferSelect;
export type InsertMissedMoverPrescanSnapshot =
  typeof missedMoverPrescanSnapshotsTable.$inferInsert;

// ── Growth Leader Log: периодические снимки топ-гейнеров ─────────────────────
// Каждый скан-цикл (~10 мин) записываем топ-50 по price24h% с полным OI/CVD/vol
// контекстом на этот момент. TTL 30 дней.
// Цель: калибровка паттернов — что видел сканер у будущих лидеров роста ДО пампа.
export const growthLeaderLogTable = pgTable(
  "growth_leader_log",
  {
    id: serial("id").primaryKey(),
    loggedAt: timestamp("logged_at").notNull().defaultNow(),
    symbol: text("symbol").notNull(),
    rank: integer("rank"), // ранг по price24h (1 = самый большой рост)
    price: real("price"), // текущая цена
    price24h: real("price_24h"), // % рост за 24ч — главный критерий
    price1h: real("price_1h"), // % рост за 1ч
    growthFromEntry: real("growth_from_entry"), // % от first_price при входе в prescan
    cycleCount: integer("cycle_count"), // циклов в prescan (возраст токена)
    firstSeenAt: real("first_seen_at"), // когда впервые попал в prescan (unix ms)
    layers: text("layers").array(), // prescan layers этого цикла
    oi30m: real("oi_30m"),
    oi1h: real("oi_1h"),
    oi4h: real("oi_4h"),
    cvd1h: boolean("cvd_1h"),
    cvd30m: boolean("cvd_30m"),
    spotVolMult: real("spot_vol_mult"), // lastSpotVol1h / spotVolAvg1h
    volMult: real("vol_mult"), // BingX 30m vol mult
    source: text("source").notNull().default("scan"), // 'scan' | 'retroactive'
    // ── Метрики НА МОМЕНТ ВХОДА в prescan ────────────────────────────────────────
    // Из prescan_tracker.first_oi_* (COALESCE — никогда не перезаписываются в источнике).
    // Позволяют сравнить «что было видно ДО роста» с текущим состоянием.
    entryPrice: real("entry_price"), // цена при первом попадании в prescan
    entryPrice24h: real("entry_price_24h"), // p24h% при первом попадании в prescan
    entryOi30m: real("entry_oi_30m"), // OI Δ30m % при первом попадании
    entryOi1h: real("entry_oi_1h"), // OI Δ1h % при первом попадании
    entryOi4h: real("entry_oi_4h"), // OI Δ4h % при первом попадании
    netBuyPct: real("net_buy_pct"), // Спот taker net buy % (последний цикл, из prescanTracker)
    spotTakerBuyUsd: real("spot_taker_buy_usd"), // CG спот taker buy USD (Binance, 2 × 1h свечи)
    spotTakerSellUsd: real("spot_taker_sell_usd"), // CG спот taker sell USD (Binance, 2 × 1h свечи)
    // ── Дополнительные поля (ретро + forward коллекция) ──────────────────────────
    price3h: real("price_3h"), // % рост за 3ч
    price4h: real("price_4h"), // % рост за 4ч
    fundingRate: real("funding_rate"), // funding rate в момент снапшота (decimal, not %)
    oiUsdAbs: real("oi_usd_abs"), // OI в USD абсолютный (CoinGlass, "All exchanges")
    futVolUsd24h: real("fut_vol_usd_24h"), // Фьючерсный объём за 24ч USD (BingX quoteVolume)
    retro: boolean("retro").default(false), // true = ретроспективная запись (не real-time)
    // ── Ретро v2: расширенные метрики (собираются ретро-джобом v2) ───────────────
    prevOi30m: real("prev_oi_30m"), // OI 30m Δ предыдущего цикла
    prevOi1h: real("prev_oi_1h"), // OI 1h Δ предыдущего цикла
    prevOi4h: real("prev_oi_4h"), // OI 4h Δ предыдущего цикла
    oi24hD1: real("oi_24h_d1"), // OI Δ за 1 день до пампа (daily ТФ)
    oi24hD2: real("oi_24h_d2"), // OI Δ за 2 дня до пампа (daily ТФ)
    spotCvd4h: boolean("spot_cvd_4h"), // SpotCVD 4h бычий (CG aggregated-cvd/history)
    cvdStrength1h: real("cvd_strength_1h"), // (spotBuy1h-spotSell1h)/(buy+sell) [-1..1]
    cvdDelta4h: real("cvd_delta_4h"), // Δ cum_vol_delta за 4h в USD (CG SpotCVD)
    spotTakerNetBuyPct: real("spot_taker_net_buy_pct"), // Спот taker net buy % за 1h
    prevSpotVolMult: real("prev_spot_vol_mult"), // BingX 30m: предыдущая свеча vol vs среднее
    prevPrice30m: real("prev_price_30m"), // Δ цены предыдущей 30m свечи %
    cgOiAvailable: boolean("cg_oi_available"), // было ли CG OI покрытие для символа
    matchedPattern: text("matched_pattern"), // паттерн, по которому выстрелил сигнал (заполняется при fire)
    // ── Spot NetFlow + Whale Index (2026-07-29) ─────────────────────────────
    snf1h: real("snf_1h"), // Spot NetFlow 1h % от тейкер-объёма (CoinGlass)
    snf4h: real("snf_4h"), // Spot NetFlow 4h %
    snf24h: real("snf_24h"), // Spot NetFlow 24h %
    whaleIndex: real("whale_index"), // Whale Index в момент лога
    obRatio: real("ob_ratio"), // BingX orderbook bid/ask ratio (бэкфилл, ~15 мин задержка)
    // ── Полный набор метрик (2026-07-30) ────────────────────────────────────
    cvd15m: boolean("cvd_15m"), // Spot CVD 15m verdict в момент лога
    oi24h: real("oi_24h"), // OI Δ24h % в момент лога
    futTakerNetBuy: real("fut_taker_net_buy"), // Futures taker net buy % (CoinGlass) в момент лога
    // ── Entry snapshot при входе в prescan (2026-07-31) ─────────────────────
    entryObRatio: real("entry_ob_ratio"), // bid/ask ratio при входе в prescan (из firstObRatio)
    entryWhaleIndex: real("entry_whale_index"), // Whale Index при входе в prescan (из firstWhaleIndex)
    entrySnf1h: real("entry_snf_1h"), // Spot NetFlow 1h % при входе в prescan (из firstSnf1h)
  },
  (table) => ({
    loggedAtIdx: index("growth_leader_log_logged_at_idx").on(table.loggedAt),
    symbolIdx: index("growth_leader_log_symbol_idx").on(table.symbol),
  }),
);

export type GrowthLeaderLogRow = typeof growthLeaderLogTable.$inferSelect;

// ── Pattern Debug Log: persistent history of per-cycle check/pass/reject counts ──
// Was in-memory only (lastPatternDebug in scanner.ts), reset every performScan()
// cycle (~10 min) — no way to see week-long gate rejection trends per pattern.
// One row per (pattern, cycle): checked/passed counters + rejectedAt as JSON text
// (gate → rejection count).
// TTL: no auto-cleanup — rows accumulate for analysis; prune manually if needed.
export const patternDebugLogTable = pgTable(
  "pattern_debug_log",
  {
    id: serial("id").primaryKey(),
    pattern: text("pattern").notNull(),
    cycleNumber: integer("cycle_number"),
    checked: integer("checked").notNull(),
    passed: integer("passed").notNull(),
    rejectedAt: text("rejected_at"), // JSON string: {"gate": count, ...}
    // symbol/cvdDiag: populated only for per-candidate diagnostic rows (e.g. OI-gate
    // rejects with a parallel "would CVD have passed?" check) — null on the regular
    // aggregate per-cycle snapshot rows above. Lets us later correlate CVD-gate
    // outcome vs price action for candidates the OI gate killed before CVD ran.
    symbol: text("symbol"),
    cvdDiag: text("cvd_diag"), // e.g. "would_pass" | "no_data" | "negative" | "no_confirm" | "mtf_fail"
    loggedAt: timestamp("logged_at").notNull().defaultNow(),
  },
  (table) => ({
    patternIdx: index("pattern_debug_pattern_idx").on(table.pattern),
    loggedAtIdx: index("pattern_debug_logged_at_idx").on(table.loggedAt),
    symbolIdx: index("pattern_debug_symbol_idx").on(table.symbol),
  }),
);

export type PatternDebugLog = typeof patternDebugLogTable.$inferSelect;
export type PatternDebugLogInsert = typeof patternDebugLogTable.$inferInsert;

// ── Layer 10: Liquidation Cascade Watch ────────────────────────────────────────
// Кандидаты обнаруженные independent job (price24h ≤ -7%, объём ≥ $300K).
// Инжектируются в основной скан (Layer 10) для проверки liquidation_cascade паттерна.
// Окно наблюдения: 2ч. По истечении без сигнала → missed_signals_log.
export const liqCascadeWatchTable = pgTable(
  "liq_cascade_watch",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    status: text("status").notNull().default("watching"), // watching | fired | expired
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),

    // Snapshot at detection time (из BingX ticker)
    priceAtDetect: real("price_at_detect"),
    price24hAtDetect: real("price24h_at_detect"), // % за 24ч в момент детекта
    price1hAtDetect: real("price1h_at_detect"), // % за 1ч (из prescanTracker если есть)

    // OI snapshot (из prescanTracker если токен уже в пуле)
    oi30mAtDetect: real("oi30m_at_detect"),
    oi1hAtDetect: real("oi1h_at_detect"),
    oi4hAtDetect: real("oi4h_at_detect"),

    // Spot volume snapshot
    spotVol24hAtDetect: real("spot_vol24h_at_detect"), // BingX quoteVolume 24h (USD)
    spotVolMultAtDetect: real("spot_vol_mult_at_detect"), // mult vs avg (если есть)
    spotVolMcapPct: real("spot_vol_mcap_pct"), // quoteVol24h / mcap * 100

    // CVD snapshot (из prescanTracker если токен уже в пуле)
    cvd30mAtDetect: boolean("cvd30m_at_detect"),
    cvd1hAtDetect: boolean("cvd1h_at_detect"),
    cvd4hAtDetect: boolean("cvd4h_at_detect"),

    // Live tracking (обновляется каждые 3 мин)
    currentPrice: real("current_price"),
    currentPctChange: real("current_pct_change"), // % от priceAtDetect
    lastCheckAt: timestamp("last_check_at"),

    // Outcome
    signalId: integer("signal_id"),
    missReason: text("miss_reason"),

    // CoinGlass liquidation coin-list snapshot (USD)
    longLiq1hAtDetect: real("long_liq1h_at_detect"),
    longLiq4hAtDetect: real("long_liq4h_at_detect"),
    longLiq24hAtDetect: real("long_liq24h_at_detect"),
    currentLongLiq1h: real("current_long_liq1h"), // обновляется каждые 3 мин
    liqExhausted: boolean("liq_exhausted"), // текущий longLiq1h < 30% от at-detect

    // CoinGlass retail positioning + bid walls (обновляется каждые 3 мин)
    globalLongPct: real("global_long_pct"), // % аккаунтов в лонге (Binance)
    largeBidUsd: real("large_bid_usd"), // крупные биды в пределах -6% от цены (USD)

    // Путь попадания в watch (Task #3): dump_filter (p24h ≤ -7%) | liq_order_stream (ранний real-time триггер)
    entryReason: text("entry_reason").default("dump_filter"),
    // Real-time liq order stream snapshot при детекте (rolling 15 мин, все биржи)
    liqOrdersCountAtDetect: integer("liq_orders_count_at_detect"), // кол-во long-liq ордеров ≥$10K
    liqOrdersUsdAtDetect: real("liq_orders_usd_at_detect"), // сумма USD long-liq ордеров

    // prescan cycle count при детекте — для ретроспективного SQL-аудита gate ≤5
    cycleCountAtDetect: integer("cycle_count_at_detect"),
  },
  (table) => ({
    symbolStatusIdx: index("liq_cascade_watch_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    detectedAtIdx: index("liq_cascade_watch_detected_at_idx").on(
      table.detectedAt,
    ),
  }),
);

export type LiqCascadeWatch = typeof liqCascadeWatchTable.$inferSelect;
export type InsertLiqCascadeWatch = typeof liqCascadeWatchTable.$inferInsert;

/** Durable OB wait state; independent of the 12h Layer 10 watch lifecycle. */
export const lcObWaitTable = pgTable(
  "lc_ob_wait",
  {
    id: serial("id").primaryKey(),
    watchId: integer("watch_id").notNull(),
    symbol: text("symbol").notNull(),
    detectedAt: timestamp("detected_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    entryPrice: real("entry_price").notNull(),
    zones: jsonb("zones").notNull().default([]),
    invalidatedZones: jsonb("invalidated_zones").notNull().default([]),
    status: text("status").notNull().default("waiting"),
    releasedAt: timestamp("released_at"),
    releaseReason: text("release_reason"),
    releaseZone: jsonb("release_zone"),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    releaseWindowKey: text("release_window_key"),
    releaseSignalId: integer("release_signal_id"),
    currentPrice: real("current_price"),
    lastCheckAt: timestamp("last_check_at"),
    observation: jsonb("observation"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    activeSymbolUniq: uniqueIndex("lc_ob_wait_active_symbol_uniq")
      .on(table.symbol)
      .where(sql`${table.status} IN ('waiting', 'invalidated', 'releasing')`),
    activeSymbolIdx: index("lc_ob_wait_active_symbol_idx")
      .on(table.symbol, table.status)
      .where(sql`${table.status} IN ('waiting', 'invalidated', 'releasing')`),
    expiresAtIdx: index("lc_ob_wait_expires_at_idx").on(table.expiresAt),
  }),
);

export type LcObWait = typeof lcObWaitTable.$inferSelect;
export type InsertLcObWait = typeof lcObWaitTable.$inferInsert;

// ── Market Cap persistent cache ────────────────────────────────────────────────
// Хранит MCap данные между рестартами сервера.
// TTL 7 дней: устаревшие записи игнорируются при загрузке.
// doublePrecision (float8) вместо real (float4) — MCap BTC ~$1.3T, нужна точность.
export const marketCapCacheTable = pgTable("market_cap_cache", {
  symbol: text("symbol").primaryKey(), // base symbol без -USDT (напр. "BTC")
  mcapUsd: doublePrecision("mcap_usd").notNull(), // market cap в USD
  source: text("source").notNull(), // "coinglass" | "coingecko" | "coinpaprika"
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── Scan Reject Log — per-symbol per-pattern reject reasons ───────────────────
// Зачем: аудит "почему сканер не поймал токен X перед его памповым ростом".
// Три уровня: (a) gate — ранние фильтры; (b) inline-pattern pre-check;
// (c) no_match — прошёл все гейты но ни один паттерн не сработал.
// TTL: 7 дней (cleanup в runStartupMigration).
export const scanRejectLogTable = pgTable(
  "scan_reject_log",
  {
    id: serial("id").primaryKey(),
    cycleAt: timestamp("cycle_at", { withTimezone: true }).notNull(),
    symbol: text("symbol").notNull(),
    pattern: text("pattern").notNull(),
    reason: text("reason").notNull(),
    oi30m: real("oi30m"),
    volMult: real("vol_mult"),
    price24h: real("price24h"),
    prescanCycles: integer("prescan_cycles"),
    /** Support zone evaluated by neon_support_bounce (owner 2026-10-20). */
    zoneBottom: real("zone_bottom"),
    zoneTop: real("zone_top"),
  },
  (t) => [
    index("scan_reject_log_sym_idx").on(t.symbol, t.cycleAt),
    index("scan_reject_log_pattern_cycle_idx").on(t.pattern, t.cycleAt.desc()),
    index("scan_reject_log_cycle_desc_idx").on(t.cycleAt.desc()),
  ],
);
export type ScanRejectLogRow = typeof scanRejectLogTable.$inferSelect;

// ── Layer 14: Inflow/Outflow Pool ─────────────────────────────────────────────
// CoinGlass exchange/chain/tx transfers (тип 2 = вывод с биржи = накопление).
// Крупные on-chain переводы ≥$2M: токены с чистым оттоком с бирж → пул 24ч.
// Цель: токены которые умные деньги выводят с бирж (накопление в холодных кошельках).
export const inflowOutflowL14PoolTable = pgTable(
  "inflow_outflow_l14_pool",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(), // BingX pair, напр. "ETH-USDT"
    coinSymbol: text("coin_symbol").notNull(), // raw монета, напр. "ETH"
    status: text("status").notNull().default("watching"), // watching | expired
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    entryPrice: real("entry_price"), // BingX цена при обнаружении
    txCount: integer("tx_count").default(0), // кол-во outflow транзакций
    totalOutflowUsd: doublePrecision("total_outflow_usd"), // суммарный USD оттока
    exchangeName: text("exchange_name"), // биржа (Binance/OKX/Coinbase...)
    transferType: text("transfer_type").default("outflow"), // "outflow" | "inflow"
    balanceChange7dPct: real("balance_change_7d_pct"), // % изменение баланса биржи за 7д
    matchedPattern: text("matched_pattern"),
  },
  (table) => ({
    symbolStatusIdx: index("inflow_outflow_l14_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    detectedAtIdx: index("inflow_outflow_l14_detected_at_idx").on(
      table.detectedAt,
    ),
  }),
);

export type InflowOutflowL14Pool =
  typeof inflowOutflowL14PoolTable.$inferSelect;
export type InsertInflowOutflowL14Pool =
  typeof inflowOutflowL14PoolTable.$inferInsert;

// ── Candidate Growth Tracking — единый кросс-слойный индекс кандидатов ────────
// Заполняется всеми слоями обнаружения: L10/L11/L14/OI Watch/Prescan.
// Позволяет: SELECT count(*) FROM candidate_growth_tracking GROUP BY detection_source
// и отслеживать рост от момента входа (growthFromEntryPct обновляется job'ом).
export const candidateGrowthTrackingTable = pgTable(
  "candidate_growth_tracking",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    detectionSource: text("detection_source").notNull(), // L10|L11|L14|oi_watch|prescan
    entryPrice: real("entry_price"),
    entryTimestamp: timestamp("entry_timestamp").notNull().defaultNow(),
    growthFromEntryPct: real("growth_from_entry_pct"), // обновляется периодически
    matchedPattern: text("matched_pattern"), // null до выстрела сигнала
    status: text("status").notNull().default("watching"), // watching|fired|expired|cancelled
    sourceTableId: integer("source_table_id"), // id в исходной таблице-пуле
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    symbolSourceIdx: index("candidate_growth_tracking_symbol_source_idx").on(
      table.symbol,
      table.detectionSource,
    ),
    statusIdx: index("candidate_growth_tracking_status_idx").on(table.status),
    entryTsIdx: index("candidate_growth_tracking_entry_ts_idx").on(
      table.entryTimestamp,
    ),
    symbolSourceUq: uniqueIndex("candidate_growth_tracking_symbol_source_uq")
      .on(table.symbol, table.detectionSource)
      .where(sql`status = 'watching'`),
  }),
);

export type CandidateGrowthTracking =
  typeof candidateGrowthTrackingTable.$inferSelect;
export type InsertCandidateGrowthTracking =
  typeof candidateGrowthTrackingTable.$inferInsert;

// ── Overheat Log: токены выкинутые из прескана фильтром перегрева (price24h > 40%) ──
// Пишется при каждом цикле скана, когда tracked-токен (в prescan_tracker) пересекает
// порог +40% и выкидывается из всех слоёв. Дедупликация: 4ч окно на символ (in-memory).
// TTL: 30 дней (DELETE в runStartupMigration). Цель — анализ поведения и калибровка.
export const overheatLogTable = pgTable(
  "overheat_log",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    kickedAt: timestamp("kicked_at").notNull().defaultNow(),
    // Состояние в момент кика (из BingX тикера)
    price24h: real("price_24h").notNull(), // p24h% в момент кика (>40)
    price: real("price"), // текущая цена в момент кика
    // Entry-метрики (из prescanTracker.first_*) — что было видно КОГДА токен вошёл в prescan
    entryPrice: real("entry_price"), // цена при первом попадании в prescan
    entryPrice24h: real("entry_price_24h"), // p24h% при первом попадании
    entryOi30m: real("entry_oi_30m"),
    entryOi1h: real("entry_oi_1h"),
    entryOi4h: real("entry_oi_4h"),
    // Prescan-контекст в момент кика
    cycleCount: integer("cycle_count"),
    layers: text("layers").array(),
    matchedPattern: text("matched_pattern"), // сигнал если был за время нахождения в prescan
    // Аналитические поля для ретроанализа
    entryVol24h: real("entry_vol_24h"), // quoteVolume BingX в момент кика (USDT)
    firstSeenAt: timestamp("first_seen_at"), // когда токен первый раз вошёл в prescan
    // Периодические снапшоты цены — обновляются каждый скан-цикл для всех overheat-токенов
    snapshotPrice: real("snapshot_price"), // последняя известная цена (из BingX тикера)
    snapshotAt: timestamp("snapshot_at"), // когда был последний снапшот
    /** true = строка создана startup-бэкфилом (данные при входе в prescan, а не в момент перегрева) */
    retro: boolean("retro").notNull().default(false),
    // ── Аналитические метрики в момент перегрева (2026-07-29) ───────────────
    cvd1h: boolean("cvd_1h"), // SpotCVD 1h бычий (из prescanTracker)
    cvd4h: boolean("cvd_4h"), // SpotCVD 4h бычий
    snf1h: real("snf_1h"), // Spot NetFlow 1h %
    snf4h: real("snf_4h"), // Spot NetFlow 4h %
    snf24h: real("snf_24h"), // Spot NetFlow 24h %
    whaleIndex: real("whale_index"), // Whale Index
    spotVolMult: real("spot_vol_mult"), // Spot vol mult (lastSpotVol1h / avg)
    futVolMult: real("fut_vol_mult"), // Futures vol mult (BingX 30m)
    futVolUsd24h: real("fut_vol_usd_24h"), // Futures vol USD 24h
    spotVolUsd24h: real("spot_vol_usd_24h"), // Spot vol USD 24h
    oi1h: real("oi_1h"), // OI Δ1h % в момент перегрева
    oi4h: real("oi_4h"), // OI Δ4h % в момент перегрева
    price1h: real("price_1h"), // Δ цены за 1ч в момент перегрева
    spotTakerNetBuyPct: real("spot_taker_net_buy_pct"), // Spot taker net buy % 1h
    // ── OB + Funding Rate при перегреве (2026-07-30) ────────────────────────
    obRatio: real("ob_ratio"), // bid/ask ratio (BingX depth snapshot) в момент перегрева
    fundingRate: real("funding_rate"), // funding rate в момент перегрева (raw decimal, 0.0001 = 0.01%)
    // ── OB + Funding Rate при ВХОДЕ в prescan (2026-07-30) ──────────────────
    entryObRatio: real("entry_ob_ratio"), // bid/ask ratio в момент first_seen_at
    entryFundingRate: real("entry_funding_rate"), // funding rate в момент first_seen_at (raw decimal)
    entryWhaleIndex: real("entry_whale_index"), // Whale Index при входе в prescan (из firstWhaleIndex)
    entrySnf1h: real("entry_snf_1h"), // Spot NetFlow 1h % при входе в prescan (из firstSnf1h)
    // ── Полный набор метрик (2026-07-30) ────────────────────────────────────
    cvd15m: boolean("cvd_15m"), // Spot CVD 15m verdict в момент перегрева
    cvd30m: boolean("cvd_30m"), // Spot CVD 30m verdict
    oi30m: real("oi_30m"), // OI Δ30m % в момент перегрева
    oi24h: real("oi_24h"), // OI Δ24h % в момент перегрева
    futTakerNetBuy: real("fut_taker_net_buy"), // Futures taker net buy % в момент перегрева
    // ── Исход: цена через 72ч после кика (заполняется бэкфиллом) ─────────────
    price72hPct: real("price_72h_pct"), // ((close_at_kick+72h / price_at_kick) - 1) * 100
  },
  (table) => ({
    kickedAtIdx: index("overheat_log_kicked_at_idx").on(table.kickedAt),
    symbolIdx: index("overheat_log_symbol_idx").on(table.symbol),
  }),
);

export type OverheatLogRow = typeof overheatLogTable.$inferSelect;

// ── RSI Watch: токены с RSI 1h < 30 — зона перепроданности ──────────────────
// Обновляется каждые ~15 мин отдельным job-ом в watcher.ts.
// TTL: 7 дней (DELETE в runStartupMigration).
// Статус: watching → expired (RSI поднялся выше 45 или истекло 7 дней).
export const rsiWatchTable = pgTable(
  "rsi_watch",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(), // BingX pair, напр. "BTC-USDT"
    status: text("status").notNull().default("watching"), // watching | expired
    addedAt: timestamp("added_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    // Снапшот при добавлении
    priceAtAdd: real("price_at_add"),
    price24hAtAdd: real("price_24h_at_add"),
    rsiAtAdd: real("rsi_at_add"), // RSI 1h при добавлении (<30)
    emaAtAdd: real("ema_at_add"), // EMA 1h при добавлении
    macdAtAdd: real("macd_at_add"), // MACD histogram 1h при добавлении
    // Текущие метрики (обновляются каждый цикл)
    currentPrice: real("current_price"),
    pctChange: real("pct_change"), // % от priceAtAdd
    currentRsi: real("current_rsi"),
    currentEma: real("current_ema"),
    currentMacd: real("current_macd"),
    lastUpdatedAt: timestamp("last_updated_at"),
  },
  (table) => ({
    symbolStatusIdx: index("rsi_watch_symbol_status_idx").on(
      table.symbol,
      table.status,
    ),
    addedAtIdx: index("rsi_watch_added_at_idx").on(table.addedAt),
  }),
);

export type RsiWatchRow = typeof rsiWatchTable.$inferSelect;
export type InsertRsiWatch = typeof rsiWatchTable.$inferInsert;

// ── Prescan Snapshots — per-cycle metric snapshot for all prescan tokens ───────
// One row per token per scan cycle. 14-day rolling TTL.
// Purpose: trajectory analysis — how OI/WI/volMult evolved while the token
// sat in the prescan pool BEFORE it fired a signal or a big move.
export const prescanSnapshotsTable = pgTable(
  "prescan_snapshots",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    cycleAt: timestamp("cycle_at").notNull(),
    p24h: real("p24h"),
    p1h: real("p1h"),
    price: real("price"),
    oi30m: real("oi30m"),
    oi1h: real("oi1h"),
    oi4h: real("oi4h"),
    volMult: real("vol_mult"),
    spotVolUsd24h: real("spot_vol_usd_24h"),
    futSpotRatio: real("fut_spot_ratio"),
    whaleIndex: real("whale_index"),
    snf1h: real("snf_1h"),
    fundingRate: real("funding_rate"),
    obRatio: real("ob_ratio"),
    cvd30m: boolean("cvd_30m"),
    cvd1h: boolean("cvd_1h"),
    cvd4h: boolean("cvd_4h"),
    cyclesInPool: integer("cycles_in_pool"),
  },
  (t) => [
    uniqueIndex("pss_symbol_cycle_unique").on(t.symbol, t.cycleAt),
    index("pss_cycle_at_idx").on(t.cycleAt),
  ],
);
export type PrescanSnapshotRow = typeof prescanSnapshotsTable.$inferSelect;
export type InsertPrescanSnapshot = typeof prescanSnapshotsTable.$inferInsert;

// ── Dashboard Users — аутентификация дашборда ─────────────────────────────────
// Пользователи с доступом к дашборду. status: pending | approved | expired | blocked.
// Создаётся в runStartupMigration Part 9.
export const dashboardUsersTable = pgTable(
  "dashboard_users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(), // Имя и отчество
    chatId: text("chat_id"), // Telegram Chat ID (связь с оплатой)
    telegramUsername: text("telegram_username"), // @ник в Telegram
    subscribedUntil: timestamp("subscribed_until"), // дата окончания подписки (задаётся вручную)
    status: text("status").notNull().default("pending"), // pending | approved | blocked
    createdAt: timestamp("created_at").notNull().defaultNow(),
    approvedAt: timestamp("approved_at"),
    lastLoginAt: timestamp("last_login_at"),
    lastActivityAt: timestamp("last_activity_at"),
  },
  (t) => [
    uniqueIndex("dashboard_users_chat_id_unique")
      .on(t.chatId)
      .where(sql`${t.chatId} IS NOT NULL`),
  ],
);
export type DashboardUser = typeof dashboardUsersTable.$inferSelect;
export type InsertDashboardUser = typeof dashboardUsersTable.$inferInsert;

// ── TA Scanner cache — мульти-TF TA данные (MA/EMA/MACD/TD/ATR) ──────────────
// Одна строка (id=1). Обновляется каждые 5 мин runTaScannerCycle().
// Цель: вкладка Layer TA не пустеет после деплоя — данные подгружаются
// из БД немедленно при старте, до первого 19-минутного цикла.
export const taScannerCacheTable = pgTable("ta_scanner_cache", {
  id: integer("id").primaryKey().default(1),
  entries: jsonb("entries").$type<Record<string, unknown>[]>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const stealthBreakoutObservationsTable = pgTable(
  "stealth_breakout_observations",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    observationKey: text("observation_key").notNull(),
    levelKey: text("level_key").notNull(),
    breakoutSource: text("breakout_source").notNull(),
    breakoutLevel: real("breakout_level").notNull(),
    touches: integer("touches").notNull(),
    quietZone: boolean("quiet_zone").notNull(),
    firstCrossAt: timestamp("first_cross_at").notNull(),
    firstDetectedAt: timestamp("first_detected_at").notNull(),
    confirmationAt: timestamp("confirmation_at"),
    confirmationSignalId: integer("confirmation_signal_id"),
    earlyAlertQueued: boolean("early_alert_queued").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stealth_breakout_observation_key_unique").on(
      table.observationKey,
    ),
    index("stealth_breakout_observation_symbol_time_idx").on(
      table.symbol,
      table.firstCrossAt,
    ),
  ],
);
