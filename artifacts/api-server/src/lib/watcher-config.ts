// ── Watcher constants ─────────────────────────────────────────────────────────

export const PARTIAL_TARGET = 5; // % частичная фиксация и перенос стопа в БУ
export const FIRST_TARGET = 10; // % первая цель: фиксируем часть, переставляем стоп в БУ
export const TRAILING_ACTIVATION_PCT = 15; // % от входа: активируем трейлинг
export const TRAILING_FIXED_PCT = 10; // % отступ трейлинга от пика (фиксированный)
export const STOP_LOSS = 10; // % стоп лосс от входа (только для active до первой цели)
export const SINGLE_ENTRY_POLICY_VERSION = "single_entry_v1" as const;
export const CANCEL_STOP_LOSS_PCT = 5; // % порог: отмена с pnl ≤ -5% засчитывается как стоп лосс
export const ACCUMULATION_H = 24; // часов до статуса ACCUMULATION
export const ACCUMULATION_REENTRY_H = 12; // часов в статусе accumulation до проверки re-entry
export const ACCUM_REMINDER_H = 6; // ч: промежуточное напоминание в статусе accumulation
export const ACCUM_SCOUT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4ч кулдаун между pre-breakout алертами
export const ACCUM_OI_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2ч кулдаун между OI-алертами
// Production cohort since 2026-08-21 showed no actionable forward value:
// FOLLOW was random, HOLD was negatively calibrated, and EXIT was too small
// and wrong-way at 4h/8h. Keep these observations internal, not in Telegram.
export const HEALTH_ADVICE_TELEGRAM_ENABLED = false;
// Re-entry candidates are retained solely for incremental-value measurement.
// They must never create delivery, mutate a tracked position, or increment the
// legacy reEntryCount field.
export const REENTRY_SHADOW_ONLY = true as const;
// Pre-breakout volume/OI scout updates do not change position protection and
// may repeat every 2-4h. Re-entry remains enabled as an actionable state change.
export const ACCUM_SCOUT_TELEGRAM_ENABLED = false;
export const MAX_WATCH_DAYS = 4; // максимум наблюдения
export const RE_ENTRY_VOL_MULT = 3; // объём для RE-ENTRY
export const FAST_CYCLE_MS = 2 * 60 * 1000; // 2 мин — быстрый цикл для in_run

// Milestones для Moonshot уведомлений (%)
// 5 → 8 → 10 → 15 → 20...125 (каждые 5) → 130 → 135 → 140 → 145 → 150
// → 155 → 160 → 165 → 170 → 175 → 180 → 185 → 190 → 195 → 200, 250...
export const MILESTONES = [
  5,
  8,
  10,
  15,
  20,
  25,
  30,
  35,
  40,
  45,
  50,
  55,
  60,
  65,
  70,
  75,
  80,
  85,
  90,
  95,
  100,
  105,
  110,
  115,
  120,
  125,
  130,
  135,
  140,
  145,
  150,
  155,
  160,
  165,
  170,
  175,
  180,
  185,
  190,
  195,
  ...Array.from({ length: 18 }, (_, i) => 200 + i * 50), // 200, 250, 300, ...
];

// ── Per-pattern exit profiles ─────────────────────────────────────────────────
export interface ExitProfile {
  firstTarget: number; // % первая цель (частичная фиксация, стоп в БУ)
  trailingActivation: number; // % от входа: активация трейлинга
  trailingGap: number; // % отступ трейлинга от пика
}

const DEFAULT_EXIT_PROFILE: ExitProfile = {
  firstTarget: FIRST_TARGET,
  trailingActivation: TRAILING_ACTIVATION_PCT,
  trailingGap: TRAILING_FIXED_PCT,
};

// whale_watch: анализ июнь-июль 2026 — входы точные, выходы отдают прибыль.
// Профиль: цель ниже (8), трейлинг раньше (12) и плотнее (7).
const WHALE_WATCH_EXIT_PROFILE: ExitProfile = {
  firstTarget: 8,
  trailingActivation: 12,
  trailingGap: 7,
};

// BTC is managed in one-point steps: +1% earns BE; +2% arms the trailing
// boundary at +1%, and each further point of peak PnL raises it by one point.
const BITCOIN_EXIT_PROFILE: ExitProfile = {
  firstTarget: 1,
  trailingActivation: 2,
  trailingGap: 1,
};

export function getExitProfile(
  sentimentKey: string | null | undefined,
  symbol?: string | null,
): ExitProfile {
  if (symbol === "BTC-USDT" || symbol === "BTCUSDT")
    return BITCOIN_EXIT_PROFILE;
  if (sentimentKey === "whale_watch") return WHALE_WATCH_EXIT_PROFILE;
  return DEFAULT_EXIT_PROFILE;
}

// ── Per-pattern max watch days ────────────────────────────────────────────────
// Owner 2026-10-12: PLM срок возвращён к общему (4 дня); 11.10 было 1 день.
export const PLM_MAX_WATCH_DAYS = 4;

export function getMaxWatchDays(
  sentimentKey: string | null | undefined,
): number {
  return sentimentKey === "price_led_momentum"
    ? PLM_MAX_WATCH_DAYS
    : MAX_WATCH_DAYS;
}

// ── Smart cancel minimum signal age ──────────────────────────────────────────
// Бэктест 90д: smart_cancel_oi_taker даёт 37.8% ошибочных отмен.
// Не проверяем smart cancel пока сигнал моложе 4ч — CVD может временно уходить
// в минус на обычной волатильности после входа.
export const SMART_CANCEL_MIN_AGE_MS = 4 * 60 * 60 * 1000; // 4 часа

// ── No-touch period for stop-loss — удалён; стоп активен с первой секунды ────
export const NO_TOUCH_STOP_MS = 0;

/** Минимальный возраст сигнала (мс) перед срабатыванием стопа. Всегда 0 —
 *  no-touch удалён (см. коммент выше); функция сохранена для call sites. */
export function getNoTouchStopMs(
  _sentimentKey: string | null | undefined,
): number {
  return 0;
}

// ── Legacy split-entry compatibility ────────────────────────────────────────
// Kept only to reconcile pre-single-entry open rows. New rows must leave all
// split fields NULL and use SINGLE_ENTRY_POLICY_VERSION.
export const SPLIT_LIMIT_PCT = 5; // % ниже первого входа

// ── Per-pattern max stop depth ────────────────────────────────────────────────
// Документированные стопы паттернов (справочник replit.md / scanner-patterns.ts).
// Введено 2026-07-15: анализ прода показал avgLoss −15.45% при avgProfit +10.29% —
// liq-heatmap стоп сохранялся БЕЗ ограничения глубины (кластер мог лежать на
// −13…−15%+), а паттерн-стопы −5…−8% существовали только в документации.
// Использование: (а) liq-стоп клампится сверху этим значением;
// (б) если liq heatmap недоступен — паттерн-стоп персистится напрямую.
// Паттерны, отсутствующие в карте, работают по глобальному STOP_LOSS (10%).
// НЕ ужесточать сверх документированного без данных.
export const PATTERN_MAX_STOP: Record<string, number> = {
  // Owner decision 2026-10-07: Stealth Breakout stop is exactly 8% (was global 10%).
  stealth_breakout: 8,
  // Новая калибровка: PLM/BG оставлены на 10%, IB использует 8%.
  price_led_momentum: 10,
  impulse_buy: 8,
  // Owner decision 2026-10-22: Neon Support stop is exactly 8% (was global 10%).
  neon_support_bounce: 8,
  balanced_grind: 10,
  // Owner decision 2026-10-10: Liquidation Cascade stop is back to exactly 10%
  // (was 8% from 2026-10-01; AIN was stopped at -8% and rebounded).
  liquidation_cascade: 10,
};

/** Максимальная глубина стопа для паттерна (положительное число, % от входа). */
export function getPatternMaxStop(
  sentimentKey: string | null | undefined,
): number {
  if (sentimentKey && PATTERN_MAX_STOP[sentimentKey] != null)
    return PATTERN_MAX_STOP[sentimentKey];
  return STOP_LOSS;
}

// ── Per-pattern min stop depth ────────────────────────────────────────────────
// Минимальная глубина стопа: кластер слишком близко к входу = стоп на шуме.
// Если liq-кластер мельче этого порога — стоп подтягивается до минимума.
export const PATTERN_MIN_STOP: Record<string, number> = {};

/** Минимальная глубина стопа для паттерна (0 = без минимума). */
export function getPatternMinStop(
  sentimentKey: string | null | undefined,
): number {
  if (sentimentKey && PATTERN_MIN_STOP[sentimentKey] != null)
    return PATTERN_MIN_STOP[sentimentKey];
  return 0;
}

// ── Per-pattern bu_stop milestone ────────────────────────────────────────────
// bullish_accumulation: milestone повышен до 10% — анализ 9 исторических bu_stop
// показал 5/9 ошибочных отмен (BANK +216%, EPIC +30%, DEXE +8.9%, ALLO +8.5%,
// 0G +6.7% за 72ч после выхода). 45% BA-сигналов реально достигают ≥8%,
// 35% — ≥10% (17 из 49 закрытых). Направление требует проверки на новых данных.
// bullish_accumulation: обычный БУ включается только после +10%.
// После +10% любой паттерн повышает защиту до PROFIT STOP +5%.
// У остальных паттернов обычный БУ до этого включается после +5%.
export function getBuStopMilestone(
  sentimentKey: string | null | undefined,
  symbol?: string | null | undefined,
): number {
  if (symbol === "BTC-USDT" || symbol === "BTCUSDT") {
    return 1;
  }
  if (sentimentKey === "bullish_accumulation") {
    return 10;
  }
  // Owner decision 2026-10-13: Stealth Breakout moves to B.U. only after +8%
  // (28-trade 15m replay: B.U. at +8 beat +5; not decision-grade, revisit).
  // Owner decision 2026-10-25: Neon Support also moves to B.U. only after +8%
  // (46-row no-wait replay: B.U. +8 -15.9 vs +5 -33.2; small sample, revisit).
  if (
    sentimentKey === "stealth_breakout" ||
    sentimentKey === "neon_support_bounce"
  ) {
    return 8;
  }
  return PARTIAL_TARGET;
}

/**
 * Patterns that trade on the ordinary path (BE, then trailing) with no
 * +10% → +5% profit-stop promotion. Stealth: owner 2026-10-08; Neon Support:
 * owner 2026-10-13.
 */
export function hasNoProfitStopPromotion(
  sentimentKey: string | null | undefined,
): boolean {
  return (
    sentimentKey === "stealth_breakout" ||
    sentimentKey === "neon_support_bounce"
  );
}

/**
 * Owner 2026-10-25: Stealth Breakout and Neon Support do not send the
 * "+5% pre-target" message; their first notice is the B.U. move at +8%.
 */
export function suppressesPreTargetFivePctNotice(
  sentimentKey: string | null | undefined,
): boolean {
  return (
    sentimentKey === "stealth_breakout" ||
    sentimentKey === "neon_support_bounce"
  );
}

/** Фактическая прибыль, которую защищает стоп после достижения BE milestone. */
export function getBuStopProtectedProfitPct(
  _sentimentKey: string | null | undefined,
): number {
  return 5;
}

export type BuStopProtection = {
  earned: boolean;
  milestone: number;
  protectedProfitPct: number;
};

export type LongSplitFillAdjustment = {
  entryPrice: number;
  stopLossPrice: number;
  peakPrice: number;
};

/**
 * Once the second 50% entry fills, the full position begins at the averaged
 * entry. A peak observed before that fill belongs only to the first half and
 * must not be revalued against the lower averaged entry.
 */
export function resolveLongSplitFillAdjustment(params: {
  entryPrice: number;
  splitLimitPrice: number;
  stopLossPct: number;
}): LongSplitFillAdjustment {
  const entryPrice = (params.entryPrice + params.splitLimitPrice) / 2;
  return {
    entryPrice,
    stopLossPrice: entryPrice * (1 - params.stopLossPct / 100),
    peakPrice: params.splitLimitPrice,
  };
}

export function resolveBuStopProtection(params: {
  sentimentKey: string | null | undefined;
  symbol?: string | null | undefined;
  lastMilestone: number | null | undefined;
  persistedPeakPnlPercent: number | null | undefined;
}): BuStopProtection {
  const milestone = getBuStopMilestone(params.sentimentKey, params.symbol);
  const observedMilestone = Math.max(
    params.lastMilestone ?? Number.NEGATIVE_INFINITY,
    params.persistedPeakPnlPercent ?? Number.NEGATIVE_INFINITY,
  );

  // Production shadow since 2026-08-25: across active patterns, +10% → +5%
  // improved 56 completed virtual hits, hurt 3, and added +189.96pp total.
  // Owner decision 2026-10-08: Stealth Breakout uses the ordinary path — BE at
  // +5%, trailing from +15% — and no longer promotes the stop to +5% at +10%.
  if (
    observedMilestone >= 10 &&
    !hasNoProfitStopPromotion(params.sentimentKey)
  ) {
    return {
      earned: true,
      milestone: 10,
      protectedProfitPct: getBuStopProtectedProfitPct(params.sentimentKey),
    };
  }

  if (observedMilestone >= milestone) {
    return {
      earned: true,
      milestone,
      protectedProfitPct: 0,
    };
  }

  return {
    earned: false,
    milestone,
    protectedProfitPct: 0,
  };
}

/**
 * Durable peak history is economic evidence that BE protection was earned,
 * even when a crash happened between the peak write and milestone write.
 */
export function hasEarnedBuStopProtection(params: {
  sentimentKey: string | null | undefined;
  symbol?: string | null | undefined;
  lastMilestone: number | null | undefined;
  persistedPeakPnlPercent: number | null | undefined;
  detectedAt?: Date | null | undefined;
}): boolean {
  return resolveBuStopProtection(params).earned;
}
