// ── Scanner pattern detection ─────────────────────────────────────────────────
// Pure functions: sentiment detection, alpha scoring, pattern evaluation.
// No side effects, no DB calls, no in-memory state.

import type { CgAskBidsResult } from "./coinglass_orderbook.js";

/** Missing spot volume blocks a confirmed fire unless Stealth confirmed it. */
export function shouldBlockConfirmedFireForMissingSpotVolume(params: {
  spotVolumeUsd24h: number | null;
  stealthConfirmed: boolean;
  sentimentKey: string | null | undefined;
}): boolean {
  return params.spotVolumeUsd24h === null && !params.stealthConfirmed;
}

// ══════════════════════════════════════════════════════════════════════════════
// PATTERN REFERENCE (все условия выверены против кода scanner.ts / watcher.ts)
//
// Обозначения:
//   anyOiPass  — CoinGlass OI прошёл хотя бы один стандартный порог (см. Layer 3)
//   vol/volMult — BingX 30m volume / 7-day avg
//   vol4h       — BingX 4h volume / 7-day avg
//   FutTaker    — CoinGlass aggregated Futures Taker netBuyPct (Binance+Bybit+OKX+Bitget+BingX)
//   SpotCVD     — CoinGlass Spot CVD multi-TF (cvd30m/cvd1h/cvd4h)
//   cycleCount  — сколько раз подряд токен был в prescan top-N пуле
//   price3h     — % изменение цены за последние 3 часа
//   price4h     — % изменение цены за последние 4 часа
//   price24h    — % изменение цены за 24 часа
//
// ── Паттерны через detectSentiment() — требуют anyOiPass (OI прошёл пороги Layer 3): ─
//
//  1. bullish_accumulation (fallback/standard) — fresh OI30m 3.5–5% ИЛИ
//     slow multi-TF (OI30m ≤2.5% + OI1h ≥2%/OI4h ≥2.5%) |
//     p24h ≤5% | cycleCount ≤12; остальные quality gates — в scanner.ts
//
// ── Specialist patterns — scanner.ts, bypass anyOiPass / detectSentiment(): ──
//
//       prescan: spotVolMult ≥2.5x, ≥3 цикла со спот-данными, prescan cycles ≥10 (19.07)
//       OI: fail-open (только OI4h < -3% блокирует — дистрибуция)
//       SpotCVD: cvd1h = обязателен; cvd4h = fail-open
//       SpotVol24h ≥1.5% MCap; p24h −10%..+40%
//       4h cooldown; блок 12ч после недавнего stop_loss
//       → прямой сигнал, стоп -5%
//
// 10. liquidation_cascade — РЕДИЗАЙН 2026-07-15 (ЭКСПЕРИМЕНТ)
//       Layer 10 pool ≥30 мин + liqExhausted=true (fail-closed) + price1h≥-1% + oi30m≥0
//       SpotTaker не sell (fail-open) + CVD1h не медвежий (fail-open) + толпа <75% long
//       → OI Watch 6ч (+2%), стоп -8%
//
// ── OI Watch — пути срабатывания в watcher.ts (каждые 2 мин): ────────────────
//  PATH A (vol confirmed): vol ≥2x при сканировании → payload сохранён в БД
//       Выстрел: price от entry +1.5–2% (по паттерну) | CVD pos | SpotVol ≥0.15% MCap
//       Окно: 360 мин (6ч); exchange_outflow_accum — 180 мин (3ч)
//  PATH B (unconfirmed): vol <2x при сканировании
//       CG turnover ≥15% ИЛИ BingX vol ≥1.5x | SpotCVD(cvd15m_3of4 ИЛИ cvd1h)
//       OI при entry ≤20% | price -4%..+20% от entry | SpotVol ≥0.15% MCap
//       Окно: 360 мин (6ч)
//  cg_timeout: topN-active + CG timeout + vol ≥1.3x + price -5..25% + cycleCount ≥3 → 12ч
//  cg_building: 2+ TF с OI 2–5% (ниже порога) + vol ≥1.5x → 12ч
//  dark_flow: CG есть, но OI не растёт + cycleCount ≥3 + vol ≥2x + price24h <15% → 6ч
//  tSteady (steady accum): |price| ≤0.5% + OI30m ≥2.0% → 6ч PATH B
//  Все паттерны: единое окно 6ч (360 мин).
// ══════════════════════════════════════════════════════════════════════════════

// ── Sentiment types ───────────────────────────────────────────────────────────

export type SentimentKey =
  | "bullish_accumulation"
  | "balanced_grind"
  | "stealth_breakout"
  | "neon_support_bounce"
  | "liquidation_cascade"
  | "price_led_momentum"
  | "impulse_buy"
  | "whale_watch";

/**
 * volMult thresholds, recalibrated 2026-10-18 by percentile from the old
 * 7-exchange aggregated futures volume to all 28 exchanges (573-symbol
 * universe, 14 days of 30m/1h bars and 30 days of 4h bars, volMult = bar /
 * mean of the previous 20 bars). Old value in the comment.
 */
export const IMPULSE_BUY_MIN_VOLUME_MULT = 1.48; // was 1.5 (p88.9)
export const IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_30M = 2.43; // was 2.5 (p96.6)
export const IMPULSE_EXHAUSTED_PUMP_MAX_VOLMULT_4H = 1.3; // was 1.3 (p84.7 → 1.30)
export const DARK_FLOW_MIN_VOLMULT = 1.96; // was 2.0 (p94.3)
export const PREBREAKOUT_DARK_FLOW_MIN_VOLMULT = 1.96; // was 2.0 (p94.3)
export const PREBREAKOUT_MIN_VOLMULT = 1.48; // was 1.5 (p88.9)
export const BA_MIN_FUT_VOLMULT = 0.52; // was 0.5 (p9.7)
export const QUIET_ACCUM_VOLMULT_MIN = 0.8; // was 0.8 (p36.5 → 0.80)
export const QUIET_ACCUM_VOLMULT_MAX = 1.77; // was 1.8 (p92.8)
/** Spot taker netBuyPct magnitudes recalibrated 5 → 10 spot exchanges. */
export const QUIET_ACCUM_SPOT_TAKER_MIN = 2.92; // was 3 (p55.1)
export const SPOT_TAKER_SELL_DOMINANCE = -10.22; // was -10 (p40.7)
export const SPOT_TAKER_HEAVY_SELL = -30.1; // was -30 (p24.3)

export const BALANCED_GRIND_P24H_MIN = -2;
export const BALANCED_GRIND_P24H_RISK_MIN = 5;
export const BALANCED_GRIND_P24H_RISK_MAX = 10;
export const BALANCED_GRIND_P24H_MAX = 20;
export const BALANCED_GRIND_REJECT_TELEMETRY_WINDOW_MS = 12 * 60 * 60 * 1000;

export const BALANCED_GRIND_P24H_REVIEW_MIN_COMPLETED = 20;
export type BalancedGrindP24hRejectReason =
  | "p24h_too_low"
  | "p24h_risk_band"
  | "p24h_too_high";

/**
 * Shared p24h contract for Balanced Grind's live gate and reject telemetry.
 * The +5..+10% band and values above 20% remain intentionally blocked.
 */
export function getBalancedGrindP24hRejectReason(
  price24hChange: number,
): BalancedGrindP24hRejectReason | null {
  if (price24hChange < BALANCED_GRIND_P24H_MIN) return "p24h_too_low";
  if (
    price24hChange >= BALANCED_GRIND_P24H_RISK_MIN &&
    price24hChange <= BALANCED_GRIND_P24H_RISK_MAX
  ) {
    return "p24h_risk_band";
  }
  if (price24hChange > BALANCED_GRIND_P24H_MAX) return "p24h_too_high";
  return null;
}

export function getBalancedGrindP24hTelemetrySource(
  symbol: string,
  observedAt: Date,
): string {
  const windowStart =
    Math.floor(
      observedAt.getTime() / BALANCED_GRIND_REJECT_TELEMETRY_WINDOW_MS,
    ) * BALANCED_GRIND_REJECT_TELEMETRY_WINDOW_MS;
  return `balanced_grind:p24h_gt_20:${symbol}:${new Date(windowStart).toISOString()}`;
}

export function buildBalancedGrindP24hReviewReadyMessage(
  completedCount: number,
): string {
  return [
    "📊 <b>Balanced Grind: пора пересмотреть потолок p24h</b>",
    `Завершено shadow-наблюдений: <b>${completedCount}</b> (минимум ${BALANCED_GRIND_P24H_REVIEW_MIN_COMPLETED}).`,
    "В зачёт вошли только дедуплицированные кандидаты balanced_grind:p24h_gt_20 с результатами через 6ч и 24ч.",
    "Перед изменением live-гейта нужно отдельно сравнить диапазоны <b>20–30%</b> и <b>&gt;30%</b>.",
  ].join("\n");
}
export interface SentimentResult {
  key: SentimentKey;
  label: string;
  traderAction: string;
  /** Does this pattern require OI to be FALLING instead of rising? */
  oiFalling: boolean;
}

// ── Alpha signal result ───────────────────────────────────────────────────────

export interface AlphaResult {
  symbol: string;
  grade: "alpha" | "super_alpha";
  price: number;
  priceChange30m: number;
  currentVolume: number;
  avgVolume: number;
  volumeMultiplier: number;
  oiChangePercent: number;
  openInterest: number;
  cmcRank: number | null;
  cmcSource: string | null;
  cmcAvailable: boolean;
  liquidationsUsd: number | null;
  liquidationsMultiple: number | null;
  coinglassAvailable: boolean;
  /** Кросс-биржевое OI изменение от Coinalyze (30m) */
  globalOiChange: number | null;
  /** Coinalyze подтвердил OI-рост кросс-биржево */
  globalOiConfirmed: boolean;
  /** Новый листинг (< 24ч на фьючерсах BingX) */
  isNewListing: boolean;
  /** Сигнал с высоким OI — выдавливание могло уже завершиться */
  isExhaustedSqueeze: boolean;
  /** % рост цены от первого открытия фьючерса */
  pumpFromOpen: number | null;
  /** Количество 30м свечей (< 48 = новый) */
  candleCount: number;
  sentiment: string;
  sentimentKey: SentimentKey;
  stealthDetectionMethod?:
    | "quiet_zone_breakout"
    | "abneon_support_bounce"
    | null;
  stealthRangeConfirmingVenues?: string[] | null;
  stealthBingxOnly?: boolean;
  stealthRangeLifecycleKey?: string | null;
  traderAction: string;
  alphaScore: number;
  isContinuing: boolean;
  cumulativeOiChange: number;
  tradingViewUrl: string;
  bingxUrl: string;
  /** Какой ТФ OI сработал: "30m", "1h" или комбинация */
  oiTriggerTf: string;
  /** Значение 1h OI изменения (для отображения в сигнале) */
  oiChange1h: number | null;
  /** Значение 4h OI изменения (для отображения в сигнале) */
  oiChange4h: number | null;
  /** Значение 24h OI изменения (для отображения в сигнале) */
  oiChange24h: number | null;
  /** Immutable 3h price change evaluated at decision time. */
  decisionPrice3h?: number | null;
  /** Immutable 1h price change evaluated at decision time. */
  price1hChange?: number | null;
  /** Impulse Buy decision payload retained until the canonical tracker snapshot is written. */
  impulseDecision?: ImpulseBuyDecision;
  impulseFundingRate?: number | null;
  impulseSpotVolumeMultiplier?: number | null;
  plmSpotVolMult?: number | null;
  impulseOi30m?: number | null;
  impulseCandleClosedAt?: Date | null;
  /** Immutable decision-time payload for specialist pattern telemetry. */
  decisionMetrics?: Record<string, unknown>;
  /** Exact rule that assigned alpha/super_alpha at decision time. */
  gradeReason?: "alpha" | "score_8_plus_oi_2tf" | "oi30m_positive_15";
  /** Проскальзывание цены с момента kline до fresh price (%) */
  klineSlippage?: number;
  /** Символ уже был в отслеживаемых сигналах за последние 24ч */
  isRepeatSignal?: boolean;
  /** Durable frozen Stealth setup consumed by this signal. */
  stealthArmId?: number;
  /** Qualified Stealth losers terminalized only after this arm fires durably. */
  stealthDedupArmIds?: number[];
  /** Provenance of the frozen Stealth Breakout level used by this signal. */
  stealthLevelSource?:
    | "auto_range_4h"
    | "auto_range_1h"
    | "stealth_legacy"
    | "continuation_shelf"
    | null;
  /** How a Stealth Range signal qualified: 30m hold or the >=10x volume fast path. */
  stealthEntryPath?: string | null;
  stealthVolumeUnconfirmed?: boolean;
  /** Immutable qualified ABNeon support-bounce event used for the fire claim. */
  neonSupportBounceEvent?: {
    frozenLevel: number;
    armCandleTime: number;
    triggerCandleTime: number;
    /** Coinciding SRv2 timeframes, e.g. "1H+4H". */
    confluence?: string | null;
  };
  /** Фандинг рейт в процентах (напр. -0.04 = -0.04% за 8ч; источник: CoinGlass aggregate) */
  fundingRate?: number | null;
  /** Frozen futures taker net-buy used by decision-time specialist gates. */
  futTakerNetBuyPct?: number | null;
  /** Mark price BingX перп */
  markPrice?: number | null;
  /** Index price (спотовый агрегат) */
  indexPrice?: number | null;
  /** Анализ стакана (CoinGlass/Binance): bidAskRatio, bias, scoreBonus */
  obImbalance?: CgAskBidsResult | null;
  /** Bear Trap CVD дивергенция: цена падает, но покупатели перевешивают → подтверждённая ловушка */
  cvdDivergence?: boolean;
  /** MTF Spot CVD: старшие ТФ (1h/4h) не подтверждают — только скальп */
  isScalpOnly?: boolean;
  /** BingX spot market 24h volume (USDT) — ориентир для сравнения с futures */
  spotVol24h?: number | null;
  /** Market cap токена (CoinGecko, USD) — для расчёта % оборачиваемости */
  marketCapUsd?: number | null;
  /** Предстоящий разлок токена (CoinGlass): daysUntil 4-7 (≤3 заблокированы на входе, watchlist exempt) */
  upcomingUnlock?: { daysUntil: number; pctSupply: number } | null;
  /** Свежий мувер: <3 циклов в прескане + цена уже ≥5% за 24ч на момент обнаружения.
   *  Статистика 30д: 43% отмен в этом сегменте (growth-leader анализ 2026-07-15). */
  freshMoverRisk?: { cycles: number; price24h: number } | null;
  /** Через какой OI Watch путь прошёл сигнал перед отправкой (A = price gate, B = vol/CVD gate).
   *  Undefined = прямой сигнал (без OI Watch). Используется для мониторинга в Telegram #path_a/#path_b. */
  _oiWatchPath?: "A" | "B";
  /** Краткая расшифровка Bullet Score для Telegram: OI/Vol/CVD/Taker/FR/ctx компоненты */
  scoreBreakdown?: string;
  /** Источник стопа: heatmap кластер / паттерн-стоп / стандартный */
  liqStopSource?: "liq_heatmap" | "pattern" | "standard";
  /** Internal DB signal ID for tracking and duplicate diagnostics. */
  signalId?: number | null;
  /** Canonical 24h price move evaluated by the scanner for BA overheat gating. */
  price24hChange?: number | null;
  /** Versioned Bullish Accumulation OI thesis selected at decision time. */
  baOiPath?:
    | "fresh_oi30m"
    | "extended_oi30m"
    | "transition_oi30m"
    | "slow_multitf";
}

export type AlphaGradeReason =
  | "alpha"
  | "score_8_plus_oi_2tf"
  | "oi30m_positive_15";

export function classifyAlphaGrade(
  score: number,
  oiTfCount: number,
  oiChangePercent: number,
): { grade: "alpha" | "super_alpha"; reason: AlphaGradeReason } {
  if (oiChangePercent >= 15) {
    return { grade: "super_alpha", reason: "oi30m_positive_15" };
  }
  if (score >= 8 && oiTfCount >= 2) {
    return { grade: "super_alpha", reason: "score_8_plus_oi_2tf" };
  }
  return { grade: "alpha", reason: "alpha" };
}

/**
 * A detected signal can spend several minutes in enrichment before it is
 * persisted and delivered. Once the final price is sampled, it becomes the
 * immutable entry price for every representation of that signal.
 */
export function buildCanonicalSignalFirePrice<
  TSignal extends { price?: number | null },
  TTelegramSignal extends { price: number },
>(params: {
  entryPrice: number;
  signalToPersist: TSignal;
  telegramSignal: TTelegramSignal;
}): {
  entryPrice: number;
  signalToPersist: TSignal & { price: number };
  telegramSignal: TTelegramSignal;
} {
  if (!Number.isFinite(params.entryPrice) || params.entryPrice <= 0) {
    throw new Error("A signal fire price must be a positive finite number");
  }

  return {
    entryPrice: params.entryPrice,
    signalToPersist: {
      ...params.signalToPersist,
      price: params.entryPrice,
    },
    telegramSignal: {
      ...params.telegramSignal,
      price: params.entryPrice,
    },
  };
}

// ── Internal detection result ─────────────────────────────────────────────────

export interface DetectionResult {
  passes: boolean;
  oiChangePercent: number;
  openInterest: number;
  sentiment: SentimentResult;
}

export interface SpotLedPriceMomentumInput {
  price24hChange: number;
  price3h: number;
  snf1h: number | null;
  snf4h: number | null;
  spotVolMult: number | null;
  cvd15m: boolean | null;
  cvd30m: boolean | null;
  cvd1h: boolean | null;
  cvd4h: boolean | null;
}

export const PLM_MAX_PRICE_24H = 15;
export const PLM_MAX_PRICE_3H = 4;
export const PLM_MIN_SPOT_VOL_MULT = 1.1;

export function resolveEntrySpotVolMult(
  sentimentKey: string | null | undefined,
  frozenDecisionValue: number | null | undefined,
  laterFallbackValue: number | null | undefined,
): number | null {
  if (sentimentKey === "price_led_momentum") {
    return frozenDecisionValue ?? null;
  }
  return laterFallbackValue ?? null;
}

/**
 * PLM is deliberately driven only by price and spot-flow confirmation.
 * Derivatives metrics are recorded with the signal for later analysis but do
 * not participate in this decision.
 */
export function isSpotLedPriceMomentum(
  input: SpotLedPriceMomentumInput,
): boolean {
  const positiveCvdCount = [
    input.cvd15m === true,
    input.cvd30m === true,
    input.cvd1h === true,
    input.cvd4h === true,
  ].filter(Boolean).length;
  const hasPositiveSpotNetflow =
    (input.snf1h !== null && input.snf1h > 0) ||
    (input.snf4h !== null && input.snf4h > 0);

  return (
    // Lower p24h bound restored (owner 2026-10-20): the 2026-10-17 removal let
    // negative-p24h entries through.
    input.price24hChange >= 5 &&
    input.price24hChange <= PLM_MAX_PRICE_24H &&
    input.price3h >= 1.5 &&
    input.price3h <= PLM_MAX_PRICE_3H &&
    input.spotVolMult != null &&
    Number.isFinite(input.spotVolMult) &&
    input.spotVolMult >= PLM_MIN_SPOT_VOL_MULT &&
    hasPositiveSpotNetflow &&
    positiveCvdCount >= 2
  );
}

export interface ImpulseBuyInput {
  candleOpen: number;
  candleHigh: number;
  candleLow: number;
  candleClose: number;
  candleVolumeUsd: number;
  baselineVolumeUsd: number;
  /**
   * false = the aggregated volume was deliberately not requested for this
   * candle (cheap pre-gate skipped it). Default true.
   */
  volumeMeasured?: boolean;
  /**
   * false = futures taker / spot CVD were not requested per symbol yet (only
   * candidates passing every other gate are measured). Default true.
   */
  takerCvdMeasured?: boolean;
  /**
   * false = spot volume was not requested for this symbol (only candles with
   * a >=2% body are measured per symbol). Default true.
   */
  spotVolumeMeasured?: boolean;
  price24h?: number | null;
  /** Price change over the last 3h at decision time; null = unavailable. */
  price3h?: number | null;
  /** Core decision-time telemetry; unavailable (null/undefined) blocks the signal. */
  oi30m?: number | null;
  futVolumeMultiplier?: number | null;
  fundingRate?: number | null;
  oi1h?: number | null;
  oi4h?: number | null;
  spotVolumeMultiplier?: number | null;
  cvd15m?: boolean | null;
  cvd30m?: boolean | null;
  cvd1h?: boolean | null;
  cvd4h?: boolean | null;
  /** Futures taker net-buy %; an explicit null (unavailable) blocks the signal. */
  futTakerNetBuyPct?: number | null;
  /**
   * Aggregated long liquidations over 24h (USD) at decision time; an explicit
   * null (unavailable) blocks the signal, undefined (not supplied) is ignored.
   */
  longLiq24hUsd?: number | null;
}

export interface ImpulseBuyDecision {
  passes: boolean;
  evaluable: boolean;
  score: number;
  maxScore: 3;
  candleBodyPct: number | null;
  volumeMultiplier: number | null;
  closeStrength: number | null;
  components: Record<
    "bullish_impulse" | "confirmed_volume" | "strong_close",
    boolean | null
  >;
  missingReasons: string[];
  rejectReasons: string[];
}

export const IMPULSE_BUY_LIQ_RATIO_SHADOW_THRESHOLD = 0.15;

export interface ImpulseBuyLiqShadowClassification {
  liquidationRatio: number | null;
  aboveShadowThreshold: boolean;
}

/**
 * Telemetry-only liquidation concentration classification. Missing or invalid
 * cache values remain unavailable and never change the live Impulse Buy result.
 */
export function classifyImpulseBuyLiqShadow(
  longLiquidations1h: number | null | undefined,
  longLiquidations24h: number | null | undefined,
): ImpulseBuyLiqShadowClassification {
  const valid1h =
    longLiquidations1h !== null &&
    longLiquidations1h !== undefined &&
    Number.isFinite(longLiquidations1h) &&
    longLiquidations1h >= 0;
  const valid24h =
    longLiquidations24h !== null &&
    longLiquidations24h !== undefined &&
    Number.isFinite(longLiquidations24h) &&
    longLiquidations24h > 0;
  const liquidationRatio =
    valid1h && valid24h ? longLiquidations1h / longLiquidations24h : null;

  return {
    liquidationRatio,
    aboveShadowThreshold:
      liquidationRatio !== null &&
      liquidationRatio > IMPULSE_BUY_LIQ_RATIO_SHADOW_THRESHOLD,
  };
}

export const IMPULSE_BUY_COMMON_GATE_KEYS = [
  "p24_universe_prefilter",
  "p24_exhausted_pump",
  "p24_deep_negative",
  "p24_ghost_pump",
  "oi_intercycle",
  "cvd_hard_block",
  "oi24h_contra",
  "short_tf_conflict",
  "oi_watch_fallback",
  "volume_filter",
  "liquidity_turnover",
  "exit_pump",
  "price_growth",
  "deep_negative_oi",
] as const;

export type ImpulseBuyCommonGate =
  (typeof IMPULSE_BUY_COMMON_GATE_KEYS)[number];

/**
 * Impulse Buy owns these common scanner gates after its decision-time
 * baseline passes. Keeping this contract in a pure helper makes accidental
 * removal of one of the bypasses testable without importing scanner.ts.
 */
export function shouldBypassImpulseBuyCommonGate(
  decision: ImpulseBuyDecision,
  gate: ImpulseBuyCommonGate,
): boolean {
  return decision.passes && IMPULSE_BUY_COMMON_GATE_KEYS.includes(gate);
}

export interface ImpulseBuyScannerFlow {
  sentimentKey: "impulse_buy" | null;
  isConfirmedFire: boolean;
  decision: ImpulseBuyDecision;
}

/**
 * The isolated specialist portion of the scanner flow:
 * baseline pass + any common gate must still produce a direct confirmed fire;
 * a failed baseline never receives the bypass.
 */
export function resolveImpulseBuyScannerFlow(
  decision: ImpulseBuyDecision,
  blockedByCommonGates: readonly ImpulseBuyCommonGate[] = [],
): ImpulseBuyScannerFlow {
  const isConfirmedFire =
    decision.passes &&
    blockedByCommonGates.every((gate) =>
      shouldBypassImpulseBuyCommonGate(decision, gate),
    );
  return {
    sentimentKey: isConfirmedFire ? "impulse_buy" : null,
    isConfirmedFire,
    decision,
  };
}

/** 2026-10-27 (owner): Impulse Buy entry quality gate thresholds. */
export const IMPULSE_BUY_MIN_OI30M_PCT = 0.26;
export const IMPULSE_BUY_MIN_LONG_LIQ24H_USD = 47_000;

/**
 * Impulse Buy baseline. Every input is captured at decision time:
 * no post-entry enrichment is allowed to influence whether the pattern fires.
 * Funding/OI1h must be known (no fail-open since 2026-10-18).
 */
export function evaluateImpulseBuy(input: ImpulseBuyInput): ImpulseBuyDecision {
  const validPrices =
    input.candleOpen > 0 &&
    input.candleHigh > 0 &&
    input.candleLow > 0 &&
    input.candleClose > 0 &&
    input.candleHigh >= Math.max(input.candleOpen, input.candleClose) &&
    input.candleLow <= Math.min(input.candleOpen, input.candleClose);
  const validVolume = input.candleVolumeUsd > 0 && input.baselineVolumeUsd > 0;
  const candleBodyPct = validPrices
    ? ((input.candleClose - input.candleOpen) / input.candleOpen) * 100
    : null;
  const candleRange = validPrices ? input.candleHigh - input.candleLow : 0;
  const closeStrength =
    validPrices && candleRange > 0
      ? (input.candleClose - input.candleLow) / candleRange
      : null;
  const volumeMultiplier = validVolume
    ? input.candleVolumeUsd / input.baselineVolumeUsd
    : null;
  const components = {
    bullish_impulse: candleBodyPct === null ? null : candleBodyPct >= 2,
    confirmed_volume:
      volumeMultiplier === null
        ? null
        : volumeMultiplier >= IMPULSE_BUY_MIN_VOLUME_MULT,
    strong_close: closeStrength === null ? null : closeStrength >= 0.65,
  };
  const score = Object.values(components).filter(
    (value) => value === true,
  ).length;
  const missingReasons: string[] = [];
  const rejectReasons: string[] = [];

  if (!validPrices) missingReasons.push("closed_30m_candle_missing");
  // Volume is fetched (aggregated) only for candles with a >=2% body, so a
  // missing baseline is reported only when the volume could have mattered.
  // "missing" is reserved for a requested aggregate that came back absent. A
  // candle never requested (cheap gates already reject it) is a different code.
  if (!validVolume) {
    if (input.volumeMeasured === false)
      rejectReasons.push("volume_not_measured");
    else missingReasons.push("volume_baseline_missing");
  }
  // 2026-10-15 (owner): body >= 2% and close strength >= 65% are telemetry
  // only (components/score). Rejected cohort since Sep 4: blocked candles hit
  // +10% before -10% 42/14 vs 4/5 for passing ones.
  if (components.confirmed_volume === false)
    rejectReasons.push("volume_lt_1_5x");
  // Approved weak band: include +5%, exclude +10%; unavailable price24h is rejected below.
  if (
    input.price24h !== null &&
    input.price24h !== undefined &&
    Number.isFinite(input.price24h) &&
    input.price24h >= 5 &&
    input.price24h < 10
  ) {
    rejectReasons.push("p24h_5_to_10pct");
  }
  // 2026-10-11: the p24h >= 20% cap was removed on the owner's instruction.
  // Rejected-decision outcomes (Sep 1+, +10% before -10% within 72h) showed
  // p24h >= 20% reaches +10% in 53% of cases vs 25-29% below 5%. p24h stays
  // decision telemetry; unavailable data is still rejected by
  // price24h_unavailable.
  // Insufficient decision-time data blocks the signal (fired cohort: 42% stops
  // with a missing core metric vs 22% with complete data).
  const isKnown = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(value);
  if (!isKnown(input.price24h)) rejectReasons.push("price24h_unavailable");
  if (!isKnown(input.price3h)) rejectReasons.push("price3h_unavailable");
  if (!isKnown(input.oi30m)) rejectReasons.push("oi30m_unavailable");
  if (!isKnown(input.oi1h)) rejectReasons.push("oi1h_unavailable");
  if (!isKnown(input.fundingRate)) rejectReasons.push("funding_unavailable");
  if (!isKnown(input.futVolumeMultiplier)) {
    rejectReasons.push("fut_volume_unavailable");
  } else if (
    input.futVolumeMultiplier === 1 &&
    input.spotVolumeMultiplier === 1
  ) {
    // Exactly 1.0 on both volumes is the default placeholder, not a measurement.
    rejectReasons.push("volume_placeholder_1x");
  }
  // Late entry: +20% or more in the last 3h (fired cohort: 42% stops, negative
  // avg PnL; strong winners started below 18%). Unavailable data is rejected.
  if (
    input.price3h !== null &&
    input.price3h !== undefined &&
    Number.isFinite(input.price3h) &&
    input.price3h >= 20
  ) {
    rejectReasons.push("price3h_ge_20pct");
  }
  if (
    input.fundingRate !== null &&
    input.fundingRate !== undefined &&
    Number.isFinite(input.fundingRate) &&
    input.fundingRate < -0.001
  ) {
    rejectReasons.push("funding_below_minus_0_1pct");
  }
  if (
    input.oi1h !== null &&
    input.oi1h !== undefined &&
    Number.isFinite(input.oi1h) &&
    input.oi1h > 20
  ) {
    rejectReasons.push("oi1h_above_20pct");
  }
  // 2026-10-27 (owner): entry quality gate. 204 Impulse Buy signals since
  // Sep 1, candle-labelled (+10% before stop, 72h): all 37%, OI30m >= 0.26%
  // 56%, OI30m >= 0.26% AND long liquidations 24h >= $47k 68% (38 trades,
  // positive in all three chronological thirds). Unavailable data is rejected.
  if (
    isKnown(input.oi30m) &&
    input.oi30m < IMPULSE_BUY_MIN_OI30M_PCT
  ) {
    rejectReasons.push("oi30m_below_0_26pct");
  }
  if (input.longLiq24hUsd === null) {
    rejectReasons.push("long_liq24h_unavailable");
  } else if (
    input.longLiq24hUsd !== undefined &&
    (!Number.isFinite(input.longLiq24hUsd) ||
      input.longLiq24hUsd < IMPULSE_BUY_MIN_LONG_LIQ24H_USD)
  ) {
    rejectReasons.push("long_liq24h_below_47k");
  }
  // 2026-10-11 (owner): Spot Volume must be known and >= 2x; no upper cap.
  // Rejected-decision outcomes: 2-4x reached +10% first in 42% of cases vs
  // 34-35% below 2x and 28% when missing.
  if (!isKnown(input.spotVolumeMultiplier)) {
    rejectReasons.push(
      input.spotVolumeMeasured === false
        ? "spot_volume_not_measured"
        : "spot_volume_unavailable",
    );
  } else if (input.spotVolumeMultiplier < 2) {
    rejectReasons.push("spot_volume_below_2x");
  }
  // 2026-10-17 (owner): no data, no signal. Explicit null = unavailable for
  // the futures taker and the 1h/4h CVD; undefined (not supplied) is ignored.
  // "*_unavailable" = requested and CoinGlass returned nothing;
  // "*_not_measured" = not requested (another gate already rejects).
  const takerCvdRequested = input.takerCvdMeasured !== false;
  if (input.futTakerNetBuyPct === null)
    rejectReasons.push(
      takerCvdRequested ? "fut_taker_unavailable" : "fut_taker_not_measured",
    );
  if (input.cvd1h === null || input.cvd4h === null)
    rejectReasons.push(
      takerCvdRequested ? "cvd_unavailable" : "cvd_not_measured",
    );
  // 2026-10-10 recalibration: the OI4h cap and the complete-CVD gate were
  // removed (no separation on 33 days of counterfactual outcomes); CVD, OI4h
  // stay as decision telemetry only.
  return {
    passes: missingReasons.length === 0 && rejectReasons.length === 0,
    evaluable: missingReasons.length === 0,
    score,
    maxScore: 3,
    candleBodyPct,
    volumeMultiplier,
    closeStrength,
    components,
    missingReasons,
    rejectReasons,
  };
}

export function normalizeImpulseTakerNetBuyPct(
  result:
    | {
        available: boolean;
        netBuyPct: number;
      }
    | undefined,
): number | null {
  return result?.available === true && Number.isFinite(result.netBuyPct)
    ? result.netBuyPct
    : null;
}

export function shouldEmitImpulseBuyLive(
  decision: ImpulseBuyDecision,
  liveEnabled: boolean,
): boolean {
  return liveEnabled && decision.passes;
}

// ── OI caps by timeframe ──────────────────────────────────────────────────────

/**
 * OI кепы зависят от таймфрейма который сработал.
 * 30m OI = 14% это поздно (памп уже идёт). 4h OI = 14% это тихое накопление за часы.
 *
 * triggerTf примеры: "30m", "1h", "4h", "24h", "steady"
 */
export function getOiCaps(triggerTf: string): {
  hiddenMax: number;
  bullishMax: number;
} {
  if (/\b24h\b/.test(triggerTf)) return { hiddenMax: 30, bullishMax: 50 };
  if (/\b4h\b/.test(triggerTf)) return { hiddenMax: 25, bullishMax: 35 };
  if (/\b1h\b/.test(triggerTf)) return { hiddenMax: 15, bullishMax: 20 };
  // 30m, steady, confirm — жёсткий кеп
  return { hiddenMax: 10, bullishMax: 15 };
}

// ── Sentiment detection ───────────────────────────────────────────────────────

/**
 * Determine sentiment pattern based on price, OI change direction/magnitude and volume.
 * Used for standard scanner signals (impulse/OI-based). Specialist patterns
 * (balanced_grind, stealth_breakout, price_led_momentum, impulse_buy)
 * are evaluated directly in scanner.ts / watcher.ts and bypass this function.
 *
 * Pattern priority (first match wins):
 * 1. dip_accumulation   — OI ≥4%, price -0.5–-3%, volMult ≥2x
 * 4. bullish_accumulation (OI ≤ bullishMax cap) — standard rising OI
 * 5. bullish_accumulation fallback
 */
export function detectSentiment(
  priceChange: number,
  oiChange: number,
  volumeMultiplier: number,
  liquidationsMultiple: number | null,
  triggerTf: string = "30m",
  _prevOi30m: number | null = null,
  _price24hChange: number = 999,
  _cycleCount: number = 0,
): SentimentResult {
  const { bullishMax } = getOiCaps(triggerTf);

  // Bullish Accumulation — кеп зависит от ТФ (bullishMax)
  if (oiChange > 3 && oiChange <= bullishMax) {
    return {
      key: "bullish_accumulation",
      label: "Бычье накопление",
      traderAction: "LONG",
      oiFalling: false,
    };
  }

  return {
    key: "bullish_accumulation",
    label: "Бычье накопление",
    traderAction: "LONG",
    oiFalling: false,
  };
}

// ── Alpha score v2 ────────────────────────────────────────────────────────────

/**
 * Bullet Score v2 — base=1 (паттерн сработал) + независимые подтверждения.
 *
 * Каждый сигнал оценивается отдельно; архетипный бонус добавляется снаружи
 * (scanner.ts). Все поля fail-open: null → 0 баллов.
 *
 * Диапазон: 1–10 (cap 10, floor 1).
 *
 * Компоненты v3 (max без архетипа ≈ 9.0):
 *   Base            1.0         паттерн прошёл все гейты
 *   OI conviction   0..2.0      30m ≥5/10% + 1h ≥2% + 4h ≥2% + OI acceleration
 *   Spot Volume     0..1.5      по spotVolMult
 *   CVD 1h+4h       0..1.0      SpotCVD булеаны
 *   Taker flow      -0.5..1.0   netBuyPct покупатели/продавцы
 *   SNF 1h/4h       -0.5..0.75  spot netflow %
 *   Funding 7d      -0.5..1.0   шорты/лонги перегреты
 *   Market context  -0.25..0.75 p24h sweet spot + cycleCount + growthCycles
 */
export function calcBulletScore(params: {
  sentimentKey: SentimentKey;
  // OI multi-TF
  oi30m: number;
  oi1h: number | null;
  oi4h: number | null;
  prevOi30m: number | null; // OI 30m прошлого цикла — для расчёта ускорения
  // Volume
  spotVolMult: number;
  // CVD directional
  spotCvd1h: boolean | null;
  spotCvd4h: boolean | null;
  // Taker
  takerNetBuyPct: number | null;
  takerAvailable: boolean;
  // Spot netflow %
  snfNetPct1h: number | null;
  snfNetPct4h: number | null;
  // Funding rate 7d (%)
  fundingRate: number | null;
  // Market context
  p24h: number | null; // price 24h % — не перегрет, не холодный старт
  cycleCount: number | null; // зрелость в прескане (≥10 циклов → зрелый сигнал)
  growthCycles: number | null; // L8 steady climber: циклов роста подряд
}): number {
  let score = 1; // base: паттерн прошёл все гейты

  // ── OI multi-TF conviction (max +2.0) ────────────────────────────────────
  // Ступенчатый бонус за силу OI30m; выше — сильнее сигнал
  if (params.oi30m >= 10) score += 0.5;
  else if (params.oi30m >= 5) score += 0.25;
  if (params.oi1h != null && params.oi1h >= 2.0) score += 0.5;
  if (params.oi4h != null && params.oi4h >= 2.0) score += 0.5;
  // OI acceleration: текущий цикл значимо сильнее предыдущего → импульс нарастает
  if (
    params.prevOi30m != null &&
    params.prevOi30m > 0 &&
    params.oi30m > params.prevOi30m * 1.5
  ) {
    score += 0.5;
  }

  // ── Spot Volume (max +1.5) ────────────────────────────────────────────────
  score +=
    params.spotVolMult >= 5
      ? 1.5
      : params.spotVolMult >= 3
        ? 1.0
        : params.spotVolMult >= 1.5
          ? 0.5
          : 0;

  // ── CVD directional (max +1.0) ────────────────────────────────────────────
  if (params.spotCvd1h === true) score += 0.5;
  if (params.spotCvd4h === true) score += 0.5;

  // ── Spot Taker flow (-0.5..+1.0) ─────────────────────────────────────────
  if (params.takerAvailable && params.takerNetBuyPct != null) {
    if (params.takerNetBuyPct >= 60) score += 1.0;
    else if (params.takerNetBuyPct >= 55) score += 0.5;
    else if (params.takerNetBuyPct < 45) score -= 0.5;
  }

  // ── SNF 1h (-0.5..+0.5) + 4h secondary (+0.25) ───────────────────────────
  if (params.snfNetPct1h != null) {
    if (params.snfNetPct1h >= 5) score += 0.5;
    else if (params.snfNetPct1h <= -5) score -= 0.5;
  }
  if (params.snfNetPct4h != null && params.snfNetPct4h >= 3) score += 0.25;

  // ── Funding rate (-0.5..+1.0) ─────────────────────────────────────────────
  // Отрицательный фандинг = шорты платят лонгам → squeeze-потенциал
  if (params.fundingRate != null) {
    const fr = params.fundingRate;
    if (fr <= -0.03) score += 1.0;
    else if (fr <= -0.01) score += 0.5;
    else if (fr >= 0.05) score -= 0.5;
  }

  // ── Market context (max +0.75, min -0.25) ────────────────────────────────
  // p24h sweet spot: уже идёт движение, но не перегрет
  if (params.p24h != null) {
    if (params.p24h >= 3 && params.p24h <= 15) score += 0.25;
    else if (params.p24h > 25) score -= 0.25;
  }
  // Зрелость в прескане: ≥10 циклов = зрелый паттерн (лучше исходов)
  if (params.cycleCount != null && params.cycleCount >= 10) score += 0.25;
  // L8 steady climber: 3+ циклов роста подряд = устойчивый тренд без откатов
  if (params.growthCycles != null && params.growthCycles >= 3) score += 0.25;

  return Math.min(10, Math.max(1, Math.round(score)));
}

// ── Pattern evaluation (pipeline gate) ───────────────────────────────────────

export function evaluatePattern(
  oiChange: number,
  priceChange: number,
  volumeMultiplier: number,
  liquidationsMultiple: number | null,
  settings: { volumeMultiplier: number; oiChangePercent: number },
  triggerTf: string = "30m",
  prevOi30m: number | null = null,
  price24hChange: number = 999,
  _cycleCount: number = 0,
): DetectionResult | null {
  // NOTE: At this point CoinGlass global OI ≥ 5% and Volume ≥ 2x are already
  // confirmed upstream (Steps 1 & 3 of v3.0 pipeline). Pattern evaluation
  // here only assigns the pattern type and applies pattern-specific thresholds.
  const { bullishMax: _bullishMax } = getOiCaps(triggerTf);
  const sent = detectSentiment(
    priceChange,
    oiChange,
    volumeMultiplier,
    liquidationsMultiple,
    triggerTf,
    prevOi30m,
    price24hChange,
  );

  // Path A: Rising OI patterns (LONG сигналы)
  if (!sent.oiFalling) {
    // B1 (2026-07-19): bullish_accumulation добавлен в bypass-список.
    // Ранее использовал settings.oiChangePercent(5%) + settings.volumeMultiplier(3x) —
    // глобальные настройки, которые блокировали лучший ретро-бакет vol 1.0-2.0x
    // (avg_p3h=6.53%, hit_10%=17 из 70 событий).
    // Реальная фильтрация вынесена в scanner.ts: oi_too_low / vol_low / prev_oi_not_building
    // / cycle_too_late / oi1h_negative / oi4h_unwinding / price24h_too_high / fut_vol_low.
    if (sent.key === "bullish_accumulation") {
      return {
        passes: true,
        oiChangePercent: oiChange,
        openInterest: 0,
        sentiment: sent,
      };
    }
  }

  return null;
}

export const BALANCED_GRIND_P24H_REVIEW_NOTIFICATION_EVENT =
  "balanced-grind:p24h-review-ready:v1";
