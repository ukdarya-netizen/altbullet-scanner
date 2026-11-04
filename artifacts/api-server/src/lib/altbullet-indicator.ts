import { getKlines, type BingXKline } from "./bingx.js";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { and, asc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  ABNEON_RANGE_VERSION,
  observeAbneonRange,
} from "./abneon-range-observation.js";

/**
 * Server-side observation port of the user's TradingView script:
 * “AltBullet Neon v6 — VPVR + SR + Structure + Dashboard”.
 *
 * It deliberately calculates only the seven sanity checks used by the script.
 * This module never returns a gate decision and is called after a signal has
 * already been accepted for tracking, after the primary Telegram delivery.
 */
export const ALT_BULLET_INDICATOR_VERSION =
  "altbullet-neon-v11-range-observation";
export const ALT_BULLET_MIN_CLOSED_SNAPSHOTS = 20;
const SWING_LENGTH = 10;
const SR_PIVOT_LENGTH = 15;
const SR_RECENT_RIGHT_CONFIRMATION = 2;
const SR_LOOKBACK = 600;
const ATR_LENGTH = 14;
export const ALT_BULLET_1H_FRESHNESS_MS = 65 * 60_000;
export const ALT_BULLET_4H_FRESHNESS_MS = 245 * 60_000;

type TrendState = "up" | "down" | "none";
export type AltBulletVerdict =
  | "confirmed"
  | "partial_conflict"
  | "strong_conflict";

export type AltBulletAnalysisGroup = {
  verdict: AltBulletVerdict;
  total: number;
  closed: number;
  successful: number;
  successRate: number | null;
  averagePnl: number | null;
};

export type AltBulletAnalysisRecommendation = {
  code:
    | "insufficient_sample"
    | "keep_observational"
    | "calibrate_thresholds"
    | "consider_experiment";
  title: string;
  detail: string;
};

export type AltBulletCheckKey =
  | "structure"
  | "mtf1h"
  | "room"
  | "chase"
  | "volume"
  | "capitulationWick";

export interface AltBulletCheckAudit {
  state: "pass" | "fail" | "unknown";
  /** Kept for v6 consumers; unknown is never true. */
  passed: boolean;
  reason: string;
  actual: number | string | null;
  threshold: number | string | null;
  actualLabel: string;
  thresholdLabel: string;
}

export interface AltBulletAudit {
  dataSource: "BingX";
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
  checks: Record<AltBulletCheckKey, AltBulletCheckAudit>;
}

/**
 * Turns the descriptive comparison into a deliberately conservative next step.
 * This is guidance for review only: it never participates in signal evaluation.
 *
 * A 20-close minimum is required before comparing outcomes. Once reached, a
 * large separation is only actionable when each compared verdict has at least
 * five closes; otherwise the correct next step is to keep collecting evidence.
 */
export function getAltBulletAnalysisRecommendation(input: {
  closedSnapshots: number;
  groups: readonly AltBulletAnalysisGroup[];
}): AltBulletAnalysisRecommendation {
  if (input.closedSnapshots < ALT_BULLET_MIN_CLOSED_SNAPSHOTS) {
    return {
      code: "insufficient_sample",
      title: "Пока рано делать вывод",
      detail: `Нужно минимум ${ALT_BULLET_MIN_CLOSED_SNAPSHOTS} закрытых снимков; сейчас доступно ${input.closedSnapshots}. Индикатор остаётся наблюдательным.`,
    };
  }

  const populated = input.groups.filter(
    (group) => group.closed > 0 && group.successRate != null,
  );
  if (populated.length < 2) {
    return {
      code: "consider_experiment",
      title: "Нужен дополнительный эксперимент",
      detail:
        "После достижения минимума закрытые снимки пока покрывают менее двух verdict-групп. Нельзя честно сравнить качество входов — продолжайте сбор данных без gate.",
    };
  }

  const successRates = populated.map((group) => group.successRate!);
  const pnlValues = populated
    .map((group) => group.averagePnl)
    .filter((value): value is number => value != null);
  const successSpread = Math.max(...successRates) - Math.min(...successRates);
  const pnlSpread =
    pnlValues.length >= 2 ? Math.max(...pnlValues) - Math.min(...pnlValues) : 0;
  const hasMeaningfulSeparation = successSpread >= 20 || pnlSpread >= 3;
  const hasReliableCoverage = populated.every((group) => group.closed >= 5);

  if (hasMeaningfulSeparation && hasReliableCoverage) {
    return {
      code: "calibrate_thresholds",
      title: "Можно рассмотреть калибровку порогов",
      detail: `Между покрытыми verdict-группами есть заметный разрыв: success rate ${successSpread.toFixed(0)} п.п., средний PnL ${pnlSpread.toFixed(1)} п.п. Это основание для отдельной калибровки, но не для автоматического gate.`,
    };
  }

  if (hasMeaningfulSeparation) {
    return {
      code: "consider_experiment",
      title: "Нужен дополнительный эксперимент",
      detail: `Разрыв выглядит интересным (success rate ${successSpread.toFixed(0)} п.п., средний PnL ${pnlSpread.toFixed(1)} п.п.), но хотя бы у одной группы меньше пяти закрытий. Соберите более ровную выборку перед калибровкой.`,
    };
  }

  return {
    code: "keep_observational",
    title: "Оставить наблюдательным",
    detail:
      "При текущей выборке verdict-группы не дают устойчивого различия по success rate или среднему PnL. Не добавляйте score в gate; продолжайте наблюдение.",
  };
}

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

export interface AltBulletIndicatorReading {
  status: "ready" | "unavailable";
  score: number | null;
  verdict: AltBulletVerdict | null;
  checks: Record<string, "pass" | "fail" | "unknown"> | null;
  context: Record<string, number | string | boolean | null>;
  audit: AltBulletAudit | null;
  error: string | null;
}

export interface AltBulletSnapshotInput {
  signalId: number;
  symbol: string;
  sentimentKey: string | null | undefined;
}

const ALT_BULLET_SNAPSHOT_CLAIM_TTL_MS = 2 * 60_000;
export const ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS = 4;
export const ALT_BULLET_SNAPSHOT_MAX_AGE_MS = 20 * 60_000;
const ALT_BULLET_SNAPSHOT_RETRY_DELAYS_MS = [
  2 * 60_000,
  4 * 60_000,
  8 * 60_000,
] as const;

export type AltBulletSnapshotRetryDecision =
  | { kind: "retry"; retryAfter: Date }
  | {
      kind: "unavailable";
      reason: "retry_budget_exhausted" | "retry_window_expired";
    };

export type AltBulletSnapshotFetchEligibility =
  | { kind: "fetch" }
  | {
      kind: "unavailable";
      reason: "retry_budget_exhausted" | "retry_window_expired";
    };

/**
 * Applies the retry policy before every market request, including work
 * reclaimed after a restart. The final permitted attempt is number four; a
 * fifth lease is terminal and must never fetch a delayed market state.
 */
export function getAltBulletSnapshotFetchEligibility(input: {
  attemptCount: number;
  requestedAt: Date;
  now?: Date;
}): AltBulletSnapshotFetchEligibility {
  const now = input.now ?? new Date();
  const ageMs = Math.max(0, now.getTime() - input.requestedAt.getTime());
  if (ageMs >= ALT_BULLET_SNAPSHOT_MAX_AGE_MS) {
    return { kind: "unavailable", reason: "retry_window_expired" };
  }
  if (input.attemptCount > ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS) {
    return { kind: "unavailable", reason: "retry_budget_exhausted" };
  }
  return { kind: "fetch" };
}

/**
 * A delayed market snapshot is useful only close to the signal event. Bounded
 * retry keeps transient scanner/transport failures out of the final cohort
 * without presenting a much later market state as the original entry.
 */
export function getAltBulletSnapshotRetryDecision(input: {
  attemptCount: number;
  requestedAt: Date;
  now?: Date;
}): AltBulletSnapshotRetryDecision {
  const now = input.now ?? new Date();
  const ageMs = Math.max(0, now.getTime() - input.requestedAt.getTime());
  if (ageMs >= ALT_BULLET_SNAPSHOT_MAX_AGE_MS) {
    return { kind: "unavailable", reason: "retry_window_expired" };
  }
  if (input.attemptCount >= ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS) {
    return { kind: "unavailable", reason: "retry_budget_exhausted" };
  }

  const delayIndex = Math.min(
    Math.max(0, input.attemptCount - 1),
    ALT_BULLET_SNAPSHOT_RETRY_DELAYS_MS.length - 1,
  );
  return {
    kind: "retry",
    retryAfter: new Date(
      now.getTime() + ALT_BULLET_SNAPSHOT_RETRY_DELAYS_MS[delayIndex]!,
    ),
  };
}

export function toClosedCandles(
  rows: BingXKline[],
  timeframeMs: number,
  requestedAt?: Date,
): Candle[] {
  // This adapter is only for raw BingX API responses. The analysis function
  // itself accepts already-closed candles so callers such as Stealth Breakout
  // do not accidentally discard the newest closed candle a second time.
  return (
    rows
      .map((row) => ({
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        time: Number(row.time),
      }))
      .filter(
        (candle) =>
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close) &&
          Number.isFinite(candle.time),
      )
      // BingX time is candle OPEN time. Retain the final response row when its
      // close was already known at requestedAt; never use a still-forming row.
      .filter(
        (candle) =>
          !requestedAt || candle.time + timeframeMs <= requestedAt.getTime(),
      )
      .sort((left, right) => left.time - right.time)
  );
}

function atr(candles: Candle[], length = ATR_LENGTH): number | null {
  if (candles.length < length) return null;
  const trueRanges = candles.map((candle, index) => {
    const previousClose = candles[index - 1]?.close;
    return previousClose == null
      ? candle.high - candle.low
      : Math.max(
          candle.high - candle.low,
          Math.abs(candle.high - previousClose),
          Math.abs(candle.low - previousClose),
        );
  });
  let value =
    trueRanges.slice(0, length).reduce((sum, range) => sum + range, 0) / length;
  for (let index = length; index < trueRanges.length; index += 1) {
    value = (value * (length - 1) + trueRanges[index]!) / length;
  }
  return Number.isFinite(value) ? value : null;
}

function isPivotHigh(
  candles: Candle[],
  center: number,
  length: number,
): boolean {
  const value = candles[center]?.high;
  if (
    value == null ||
    center - length < 0 ||
    center + length >= candles.length
  ) {
    return false;
  }
  for (let index = center - length; index <= center + length; index += 1) {
    if (index !== center && (candles[index]?.high ?? -Infinity) >= value)
      return false;
  }
  return true;
}

function isPivotLow(
  candles: Candle[],
  center: number,
  length: number,
): boolean {
  const value = candles[center]?.low;
  if (
    value == null ||
    center - length < 0 ||
    center + length >= candles.length
  ) {
    return false;
  }
  for (let index = center - length; index <= center + length; index += 1) {
    if (index !== center && (candles[index]?.low ?? Infinity) <= value)
      return false;
  }
  return true;
}

/**
 * Mirrors f_mtfTrend() / the default Market Structure block in Pine:
 * confirmed swing → close crossing that swing → persistent direction.
 */
export function calculateAltBulletTrend(
  candles: Candle[],
  swingLength = SWING_LENGTH,
): TrendState {
  let state: TrendState = "none";
  let swingHigh: number | null = null;
  let swingLow: number | null = null;

  for (let index = 0; index < candles.length; index += 1) {
    const pivotCenter = index - swingLength;
    if (
      pivotCenter >= swingLength &&
      isPivotHigh(candles, pivotCenter, swingLength)
    ) {
      swingHigh = candles[pivotCenter]!.high;
    }
    if (
      pivotCenter >= swingLength &&
      isPivotLow(candles, pivotCenter, swingLength)
    ) {
      swingLow = candles[pivotCenter]!.low;
    }

    const close = candles[index]!.close;
    const previousClose = candles[index - 1]?.close;
    if (
      swingHigh != null &&
      previousClose != null &&
      previousClose <= swingHigh &&
      close > swingHigh
    ) {
      state = "up";
    }
    if (
      swingLow != null &&
      previousClose != null &&
      previousClose >= swingLow &&
      close < swingLow
    ) {
      state = "down";
    }
  }
  return state;
}

function nearestSrLevel(
  candles: Candle[],
  currentAtr: number,
  side: "resistance" | "support",
): number | null {
  const current = candles.at(-1);
  if (!current || currentAtr <= 0) return null;

  const firstIndex = Math.max(
    SR_PIVOT_LENGTH,
    candles.length - 1 - SR_LOOKBACK,
  );
  const pivotPrices: number[] = [];
  for (
    let index = firstIndex;
    index + SR_PIVOT_LENGTH < candles.length;
    index += 1
  ) {
    if (isPivotHigh(candles, index, SR_PIVOT_LENGTH)) {
      pivotPrices.push(candles[index]!.high);
    }
    if (isPivotLow(candles, index, SR_PIVOT_LENGTH)) {
      pivotPrices.push(candles[index]!.low);
    }
  }
  // Recent highs/lows require two fully closed right-hand 4H candles.
  // The resistance path retains its original highs-only behavior.
  const firstRecentIndex = Math.max(
    SR_PIVOT_LENGTH,
    candles.length - SR_PIVOT_LENGTH,
  );
  for (
    let index = firstRecentIndex;
    index + SR_RECENT_RIGHT_CONFIRMATION < candles.length;
    index += 1
  ) {
    const value =
      side === "resistance" ? candles[index]?.high : candles[index]?.low;
    if (value == null) continue;
    let isRecentPivot = true;
    for (
      let compared = index - SR_PIVOT_LENGTH;
      compared <= index + SR_RECENT_RIGHT_CONFIRMATION;
      compared += 1
    ) {
      if (
        compared !== index &&
        (side === "resistance"
          ? (candles[compared]?.high ?? Number.NEGATIVE_INFINITY) >= value
          : (candles[compared]?.low ?? Number.POSITIVE_INFINITY) <= value)
      ) {
        isRecentPivot = false;
        break;
      }
    }
    if (isRecentPivot) pivotPrices.push(value);
  }
  if (pivotPrices.length === 0) return null;

  const low = Math.min(...pivotPrices);
  const high = Math.max(...pivotPrices);
  const binWidth = Math.max(currentAtr * 0.35, current.close * 1e-8);
  const bins = Math.min(
    400,
    Math.max(1, Math.ceil((high - low) / binWidth) + 1),
  );
  const counts = Array.from({ length: bins }, () => 0);
  const sums = Array.from({ length: bins }, () => 0);

  for (const price of pivotPrices) {
    const index = Math.min(
      bins - 1,
      Math.max(0, Math.floor((price - low) / binWidth)),
    );
    counts[index]! += 1;
    sums[index]! += price;
  }

  const working = [...counts];
  const minGapBins = Math.max(1, Math.ceil((currentAtr * 1.2) / binWidth));
  const centers: number[] = [];
  for (let picked = 0; picked < 6; picked += 1) {
    const maxCount = Math.max(...working);
    if (maxCount <= 0) break;
    const bestIndex = working.indexOf(maxCount);
    centers.push(sums[bestIndex]! / counts[bestIndex]!);
    for (
      let index = Math.max(0, bestIndex - minGapBins);
      index <= Math.min(bins - 1, bestIndex + minGapBins);
      index += 1
    ) {
      working[index] = -1;
    }
  }

  return side === "resistance"
    ? (centers
        .filter((center) => center > current.close)
        .sort((left, right) => left - right)[0] ?? null)
    : (centers
        .filter((center) => center < current.close)
        .sort((left, right) => right - left)[0] ?? null);
}

function latestSmaVolume(candles: Candle[], length = 20): number | null {
  if (candles.length < length) return null;
  const mean =
    candles.slice(-length).reduce((sum, candle) => sum + candle.volume, 0) /
    length;
  return Number.isFinite(mean) ? mean : null;
}

function auditNumber(value: number | null, suffix = ""): string {
  if (value == null || !Number.isFinite(value)) return "н/д";
  return `${value.toFixed(2)}${suffix}`;
}

export function analyzeAltBulletIndicator(input: {
  /** Both arrays must contain closed candles only, oldest → newest. */
  candles4h: Candle[];
  candles1h: Candle[];
  btcCandles?: Candle[];
  requestedAt?: Date;
}): AltBulletIndicatorReading {
  const { candles4h, candles1h } = input;
  const requestedAt = input.requestedAt;
  if (!candles4h.length && !candles1h.length)
    return {
      status: "unavailable",
      score: null,
      verdict: null,
      checks: null,
      context: { candles4h: 0, candles1h: 0 },
      audit: null,
      error: "Нет закрытых 1H/4H свечей на момент снимка",
    };

  const last = candles4h.at(-1);
  const last1h = candles1h.at(-1);
  if (!last || !last1h)
    return {
      status: "unavailable",
      score: null,
      verdict: null,
      checks: null,
      context: { candles4h: candles4h.length, candles1h: candles1h.length },
      audit: null,
      error: "Не хватает закрытых свечей одного из таймфреймов",
    };
  const close4hAt = last.time + 4 * 60 * 60_000;
  const close1hAt = last1h.time + 60 * 60_000;
  const freshness4hMs = requestedAt ? requestedAt.getTime() - close4hAt : null;
  const freshness1hMs = requestedAt ? requestedAt.getTime() - close1hAt : null;
  const fresh4h =
    freshness4hMs == null || freshness4hMs <= ALT_BULLET_4H_FRESHNESS_MS;
  const fresh1h =
    freshness1hMs == null || freshness1hMs <= ALT_BULLET_1H_FRESHNESS_MS;
  const currentAtr = atr(candles4h);
  const trend4h = calculateAltBulletTrend(candles4h);
  const trend1h = calculateAltBulletTrend(candles1h);
  const resistance =
    currentAtr == null
      ? null
      : nearestSrLevel(candles4h, currentAtr, "resistance");
  const support =
    currentAtr == null
      ? null
      : nearestSrLevel(candles4h, currentAtr, "support");
  const range1h = observeAbneonRange(candles1h, 60 * 60_000);
  const range4h = observeAbneonRange(candles4h, 4 * 60 * 60_000);
  const supportDistancePct =
    support != null && last.close > 0
      ? ((last.close - support) / last.close) * 100
      : null;
  const supportDistanceAtr =
    support != null && currentAtr != null && currentAtr > 0
      ? (last.close - support) / currentAtr
      : null;
  const price24h = candles4h.at(-7)?.close ?? null;
  const roc24h =
    price24h != null && price24h > 0
      ? ((last.close - price24h) / price24h) * 100
      : null;
  const averageVolume = latestSmaVolume(candles4h);
  const maxCapWickRatio = candles4h.slice(-5).reduce((maximum, candle) => {
    const range = candle.high - candle.low;
    const wickRatio =
      range > 0
        ? (Math.min(candle.open, candle.close) - candle.low) / range
        : 0;
    return Math.max(maximum, wickRatio);
  }, 0);
  const hasCapWick = maxCapWickRatio >= 0.5;
  const btc = input.btcCandles ?? [];
  const btcLast = btc.at(-1);
  const btcBase = btc.at(-25);
  const btcRoc24h =
    btcLast && btcBase && btcBase.close > 0
      ? ((btcLast.close - btcBase.close) / btcBase.close) * 100
      : null;
  const btcFreshnessMs =
    requestedAt && btcLast
      ? requestedAt.getTime() - (btcLast.time + 60 * 60_000)
      : null;
  const btcFresh =
    btcFreshnessMs == null || btcFreshnessMs <= ALT_BULLET_1H_FRESHNESS_MS;
  const btcRegime: "bull" | "neutral" | "bear" | "unknown" =
    !btcFresh || btcRoc24h == null
      ? "unknown"
      : btcRoc24h >= 1
        ? "bull"
        : btcRoc24h <= -1
          ? "bear"
          : "neutral";
  const btcReason = !btcFresh
    ? "BTC 1H данные устарели (>65м)"
    : btcRoc24h == null
      ? "Недостаточно закрытых BTC-USDT 1H свечей для 24H ROC"
      : "BTC regime derived from closed 24H ROC";

  const state = (
    value: boolean | null,
    reason: string,
  ): Pick<AltBulletCheckAudit, "state" | "passed" | "reason"> => ({
    state: value == null ? "unknown" : value ? "pass" : "fail",
    passed: value === true,
    reason,
  });
  const checksAudit = {
    structure: {
      ...state(
        !fresh4h ? null : candles4h.length >= 21 ? trend4h === "up" : null,
        !fresh4h
          ? "4H данные устарели (>245м)"
          : candles4h.length >= 21
            ? "4H confirmed structure"
            : "Недостаточно 4H свечей для подтверждённой структуры",
      ),
      actual: trend4h,
      threshold: "up",
      actualLabel: `trend4h = ${trend4h}`,
      thresholdLabel: "up",
    },
    mtf1h: {
      ...state(
        !fresh1h ? null : candles1h.length >= 21 ? trend1h === "up" : null,
        !fresh1h
          ? "1H данные устарели (>65м)"
          : candles1h.length >= 21
            ? "1H confirmed structure"
            : "Недостаточно 1H свечей для подтверждённой структуры",
      ),
      actual: trend1h,
      threshold: "up",
      actualLabel: `trend1h = ${trend1h}`,
      thresholdLabel: "up",
    },
    room: {
      ...state(
        !fresh4h
          ? null
          : currentAtr == null
            ? null
            : resistance == null || resistance - last.close >= currentAtr * 0.7,
        !fresh4h
          ? "4H данные устарели (>245м)"
          : resistance == null
            ? "Нет подтверждённого сопротивления"
            : currentAtr == null
              ? "ATR недоступен"
              : "Расстояние до сопротивления измерено",
      ),
      actual: null,
      threshold: 0.7,
      actualLabel: "см. room ATR",
      thresholdLabel: "≥ 0.70 ATR или нет уровня",
    },
    chase: {
      ...state(
        !fresh4h ? null : roc24h == null ? null : roc24h <= 15,
        !fresh4h
          ? "4H данные устарели (>245м)"
          : roc24h == null
            ? "Не хватает 24H истории"
            : "24H ROC измерен",
      ),
      actual: roc24h,
      threshold: 15,
      actualLabel: auditNumber(roc24h, "%"),
      thresholdLabel: "≤ 15.00%",
    },
    volume: {
      ...state(
        !fresh4h
          ? null
          : averageVolume == null || !Number.isFinite(last.volume)
            ? null
            : last.volume >= averageVolume,
        !fresh4h
          ? "4H данные устарели (>245м)"
          : averageVolume == null
            ? "Не хватает 20 4H свечей объёма"
            : "Сравнение с SMA20",
      ),
      actual: last.volume,
      threshold: averageVolume,
      actualLabel: auditNumber(last.volume),
      thresholdLabel: `≥ SMA20 (${auditNumber(averageVolume)})`,
    },
    capitulationWick: {
      ...state(
        !fresh4h ? null : candles4h.length >= 5 ? hasCapWick : null,
        !fresh4h
          ? "4H данные устарели (>245м)"
          : candles4h.length >= 5
            ? "Проверка пяти закрытых 4H свечей"
            : "Не хватает пяти 4H свечей",
      ),
      actual: maxCapWickRatio,
      threshold: 0.5,
      actualLabel: auditNumber(maxCapWickRatio),
      thresholdLabel: "≥ 0.50",
    },
  };
  const checks = Object.fromEntries(
    Object.entries(checksAudit).map(([key, value]) => [key, value.state]),
  ) as Record<AltBulletCheckKey, "pass" | "fail" | "unknown">;
  const passCount = Object.values(checks).filter(
    (value) => value === "pass",
  ).length;
  const failCount = Object.values(checks).filter(
    (value) => value === "fail",
  ).length;
  const unknownCount = 6 - passCount - failCount;
  const roomAtr =
    resistance != null && currentAtr != null && currentAtr > 0
      ? (resistance - last.close) / currentAtr
      : null;
  const audit: AltBulletAudit = {
    dataSource: "BingX",
    lastClosed4hAt: new Date(close4hAt).toISOString(),
    lastClosed1hAt: new Date(close1hAt).toISOString(),
    isClosed: true,
    requestedAt: requestedAt?.toISOString(),
    freshness1hMs,
    freshness4hMs,
    btc: {
      regime: btcRegime,
      roc24h: btcRoc24h,
      lastClosedAt: btcLast
        ? new Date(btcLast.time + 60 * 60_000).toISOString()
        : null,
      freshnessMs: btcFreshnessMs,
      reason: btcReason,
    },
    checks: checksAudit,
  };

  return {
    status: "ready",
    // Keep the legacy fields nullable for historical compatibility, but do not
    // generate scores or verdicts for newly captured snapshots.
    score: null,
    verdict: null,
    checks,
    context: {
      trend4h,
      trend1h,
      atr14: currentAtr,
      nearestResistance: resistance,
      // Descriptive 4H pivot-cluster support relative to the last closed 4H
      // price, not an entry gate. A null level with ready status means none
      // was found; unavailable readings must not be classified as absent.
      supportReferencePrice: last.close,
      nearestSupport: support,
      rangeObservationVersion: ABNEON_RANGE_VERSION,
      range1hState: fresh1h ? range1h.state : "unknown",
      range1hUpper: fresh1h ? range1h.upper : null,
      range1hLower: fresh1h ? range1h.lower : null,
      range1hEventAt: fresh1h ? range1h.eventAt : null,
      range1hReason: fresh1h ? range1h.reason : "1H свечи устарели",
      range4hState: fresh4h ? range4h.state : "unknown",
      range4hUpper: fresh4h ? range4h.upper : null,
      range4hLower: fresh4h ? range4h.lower : null,
      range4hEventAt: fresh4h ? range4h.eventAt : null,
      range4hReason: fresh4h ? range4h.reason : "4H свечи устарели",
      supportPresent: currentAtr === null ? null : support !== null,
      supportDistancePct,
      supportDistanceAtr,
      supportWithin1Atr:
        currentAtr === null
          ? null
          : supportDistanceAtr !== null && supportDistanceAtr <= 1,
      roomAtr,
      availableChecks: 6 - unknownCount,
      passCount,
      failCount,
      unknownCount,
      verdictRationale: unknownCount
        ? `${passCount} pass, ${failCount} fail, ${unknownCount} unknown; unknown не засчитывается`
        : `${passCount} pass, ${failCount} fail`,
      roc24h,
      volume4h: last.volume,
      avgVolume20: averageVolume,
      candle4hAt: new Date(close4hAt).toISOString(),
      candle1hAt: new Date(close1hAt).toISOString(),
      dataSource: "BingX",
      candles4h: candles4h.length,
      candles1h: candles1h.length,
      requestedAt: requestedAt?.toISOString() ?? null,
      btcRegime,
      btcRoc24h,
      btcReason,
    },
    audit,
    error: null,
  };
}

type AltBulletSnapshotClaim = {
  token: string;
  attemptCount: number;
  requestedAt: Date;
};

export type AltBulletSnapshotCaptureOptions = {
  getKlines?: typeof getKlines;
  now?: () => Date;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function exhaustedRetryReading(input: {
  error: string;
  attemptCount: number;
  requestedAt: Date;
  reason: Extract<
    AltBulletSnapshotRetryDecision,
    { kind: "unavailable" }
  >["reason"];
}): AltBulletIndicatorReading {
  return {
    status: "unavailable",
    score: null,
    verdict: null,
    checks: null,
    context: {
      retryReason: input.reason,
      retryAttempts: input.attemptCount,
      snapshotRequestedAt: input.requestedAt.toISOString(),
    },
    audit: null,
    error: `Не удалось получить market context в окне наблюдения: ${input.error}`,
  };
}

async function deferAltBulletSnapshotRetry(input: {
  signalId: number;
  symbol: string;
  claim: AltBulletSnapshotClaim;
  retryAfter: Date;
  error: string;
}): Promise<void> {
  const { db, signalsTable } = await import("@workspace/db");
  const deferred = await db
    .update(signalsTable)
    .set({
      altBulletSnapshotClaimedAt: null,
      altBulletSnapshotClaimToken: null,
      altBulletSnapshotRetryAfter: input.retryAfter,
      altBulletSnapshotLastError: input.error,
    })
    .where(
      and(
        eq(signalsTable.id, input.signalId),
        eq(signalsTable.altBulletSnapshotClaimToken, input.claim.token),
        isNotNull(signalsTable.altBulletSnapshotRequestedAt),
      ),
    )
    .returning({ id: signalsTable.id });

  if (deferred.length === 0) {
    logger.info(
      { signalId: input.signalId, symbol: input.symbol },
      "AltBullet Neon retry was superseded by another worker",
    );
    return;
  }
  logger.warn(
    {
      signalId: input.signalId,
      symbol: input.symbol,
      attemptCount: input.claim.attemptCount,
      retryAfter: input.retryAfter,
      error: input.error,
    },
    "AltBullet Neon snapshot deferred for retry",
  );
}

async function finalizeAltBulletSnapshot(input: {
  snapshot: AltBulletSnapshotInput;
  claim: AltBulletSnapshotClaim;
  reading: AltBulletIndicatorReading;
}): Promise<boolean> {
  const { altBulletIndicatorSnapshotsTable, db, signalsTable } =
    await import("@workspace/db");
  return db.transaction(async (tx) => {
    // Clear the intent before materializing the row, in the same transaction.
    // A stale worker cannot write a snapshot once another worker owns or has
    // completed the claim; a failed insert rolls the clear back with it.
    const settled = await tx
      .update(signalsTable)
      .set({
        altBulletSnapshotRequestedAt: null,
        altBulletSnapshotClaimedAt: null,
        altBulletSnapshotClaimToken: null,
        altBulletSnapshotRetryAfter: null,
        altBulletSnapshotLastError: null,
      })
      .where(
        and(
          eq(signalsTable.id, input.snapshot.signalId),
          eq(signalsTable.altBulletSnapshotClaimToken, input.claim.token),
        ),
      )
      .returning({ id: signalsTable.id });
    if (settled.length === 0) return false;

    await tx
      .insert(altBulletIndicatorSnapshotsTable)
      .values({
        signalId: input.snapshot.signalId,
        symbol: input.snapshot.symbol,
        sentimentKey: input.snapshot.sentimentKey ?? null,
        indicatorVersion: ALT_BULLET_INDICATOR_VERSION,
        timeframe: "4h",
        status: input.reading.status,
        // These nullable columns remain in the schema for immutable historical
        // rows. New snapshots are raw observations and never write ABNeon score.
        score: null,
        verdict: null,
        // Snapshot JSON intentionally supports both immutable v6 and v7 shapes.
        checks: input.reading.checks as any,
        context: input.reading.context as any,
        audit: input.reading.audit as any,
        error: input.reading.error,
      })
      .onConflictDoNothing();
    return true;
  });
}

/**
 * Writes one immutable observation keyed by the actual signal row. A market
 * transport failure keeps the durable intent available for bounded retry;
 * only a completed reading or exhausted retry window materializes a terminal
 * snapshot. Persistence errors leave the claim to expire for reconciliation.
 */
export async function captureAltBulletIndicatorSnapshot(
  input: AltBulletSnapshotInput,
  claim: AltBulletSnapshotClaim,
  options: AltBulletSnapshotCaptureOptions = {},
): Promise<void> {
  let reading: AltBulletIndicatorReading;
  const eligibility = getAltBulletSnapshotFetchEligibility({
    attemptCount: claim.attemptCount,
    requestedAt: claim.requestedAt,
    now: options.now?.(),
  });
  if (eligibility.kind === "unavailable") {
    reading = exhaustedRetryReading({
      error:
        "Snapshot retry was reclaimed after its allowed observation window",
      attemptCount: claim.attemptCount,
      requestedAt: claim.requestedAt,
      reason: eligibility.reason,
    });
  } else {
    try {
      const loadKlines = options.getKlines ?? getKlines;
      const [raw4h, raw1h, rawBtc] = await Promise.all([
        loadKlines(input.symbol, "4h", 900).then((rows) =>
          withAggregatedKlineVolume(input.symbol, "4h", rows),
        ),
        loadKlines(input.symbol, "1h", 900).then((rows) =>
          withAggregatedKlineVolume(input.symbol, "1h", rows),
        ),
        loadKlines("BTC-USDT", "1h", 650).then((rows) =>
          withAggregatedKlineVolume("BTC-USDT", "1h", rows),
        ),
      ]);
      reading = analyzeAltBulletIndicator({
        candles4h: toClosedCandles(raw4h, 4 * 60 * 60_000, claim.requestedAt),
        candles1h: toClosedCandles(raw1h, 60 * 60_000, claim.requestedAt),
        btcCandles: toClosedCandles(rawBtc, 60 * 60_000, claim.requestedAt),
        requestedAt: claim.requestedAt,
      });
    } catch (error) {
      const message = errorText(error);
      const retry = getAltBulletSnapshotRetryDecision({
        attemptCount: claim.attemptCount,
        requestedAt: claim.requestedAt,
        now: options.now?.(),
      });
      if (retry.kind === "retry") {
        try {
          await deferAltBulletSnapshotRetry({
            signalId: input.signalId,
            symbol: input.symbol,
            claim,
            retryAfter: retry.retryAfter,
            error: message,
          });
        } catch (deferError) {
          logger.warn(
            {
              error: deferError,
              signalId: input.signalId,
              symbol: input.symbol,
              attemptCount: claim.attemptCount,
            },
            "AltBullet Neon retry update failed; claim expiry will recover it",
          );
        }
        return;
      }
      reading = exhaustedRetryReading({
        error: message,
        attemptCount: claim.attemptCount,
        requestedAt: claim.requestedAt,
        reason: retry.reason,
      });
    }
  }

  if (reading.status === "ready") {
    const finalEligibility = getAltBulletSnapshotFetchEligibility({
      attemptCount: claim.attemptCount,
      requestedAt: claim.requestedAt,
      now: options.now?.(),
    });
    if (finalEligibility.kind === "unavailable") {
      reading = exhaustedRetryReading({
        error:
          "Market data arrived after the allowed snapshot observation window",
        attemptCount: claim.attemptCount,
        requestedAt: claim.requestedAt,
        reason: finalEligibility.reason,
      });
    }
  }

  try {
    const finalized = await finalizeAltBulletSnapshot({
      snapshot: input,
      claim,
      reading,
    });
    if (!finalized) {
      logger.info(
        { signalId: input.signalId, symbol: input.symbol },
        "AltBullet Neon final snapshot was superseded by another worker",
      );
      return;
    }
    logger.info(
      {
        signalId: input.signalId,
        symbol: input.symbol,
        status: reading.status,
      },
      "AltBullet Neon 4H snapshot captured (observation only)",
    );
  } catch (error) {
    logger.error(
      { error, signalId: input.signalId, symbol: input.symbol },
      "AltBullet Neon snapshot persistence failed; alert will still be delivered",
    );
  }
}

async function drainAltBulletIndicatorSnapshot(
  input: AltBulletSnapshotInput,
): Promise<void> {
  try {
    const { db, signalsTable } = await import("@workspace/db");
    const now = new Date();
    const claimToken = `altbullet:${process.pid}:${input.signalId}:${now.getTime()}`;
    const claimExpiry = new Date(
      now.getTime() - ALT_BULLET_SNAPSHOT_CLAIM_TTL_MS,
    );
    const claimed = await db
      .update(signalsTable)
      .set({
        altBulletSnapshotClaimedAt: now,
        altBulletSnapshotClaimToken: claimToken,
        altBulletSnapshotAttemptCount: sql`${signalsTable.altBulletSnapshotAttemptCount} + 1`,
      })
      .where(
        and(
          eq(signalsTable.id, input.signalId),
          isNotNull(signalsTable.altBulletSnapshotRequestedAt),
          or(
            isNull(signalsTable.altBulletSnapshotRetryAfter),
            lte(signalsTable.altBulletSnapshotRetryAfter, now),
          ),
          or(
            isNull(signalsTable.altBulletSnapshotClaimedAt),
            lt(signalsTable.altBulletSnapshotClaimedAt, claimExpiry),
          ),
        ),
      )
      .returning({
        id: signalsTable.id,
        attemptCount: signalsTable.altBulletSnapshotAttemptCount,
        requestedAt: signalsTable.altBulletSnapshotRequestedAt,
      });

    if (claimed.length === 0) return;
    const claim = claimed[0]!;
    if (!claim.requestedAt) {
      logger.warn(
        { signalId: input.signalId, symbol: input.symbol },
        "AltBullet Neon claim lost its requested timestamp",
      );
      return;
    }
    await captureAltBulletIndicatorSnapshot(input, {
      token: claimToken,
      attemptCount: claim.attemptCount,
      requestedAt: claim.requestedAt,
    });
  } catch (error) {
    logger.warn(
      { error, signalId: input.signalId, symbol: input.symbol },
      "AltBullet Neon snapshot drain deferred for retry",
    );
  }
}

/**
 * Reclaims snapshot intents left by a process restart or interrupted deploy.
 * Each row is leased before its market-data call, so concurrent workers cannot
 * materialize the same immutable observation twice.
 */
export async function reconcileAltBulletIndicatorSnapshots(
  limit = 8,
): Promise<number> {
  const { db, signalsTable } = await import("@workspace/db");
  const claimExpiry = new Date(Date.now() - ALT_BULLET_SNAPSHOT_CLAIM_TTL_MS);
  const pending = await db
    .select({
      signalId: signalsTable.id,
      symbol: signalsTable.symbol,
      sentimentKey: signalsTable.sentimentKey,
    })
    .from(signalsTable)
    .where(
      and(
        isNotNull(signalsTable.altBulletSnapshotRequestedAt),
        or(
          isNull(signalsTable.altBulletSnapshotRetryAfter),
          lte(signalsTable.altBulletSnapshotRetryAfter, new Date()),
        ),
        or(
          isNull(signalsTable.altBulletSnapshotClaimedAt),
          lt(signalsTable.altBulletSnapshotClaimedAt, claimExpiry),
        ),
      ),
    )
    .orderBy(asc(signalsTable.altBulletSnapshotRequestedAt))
    .limit(limit);

  for (const snapshot of pending) {
    await drainAltBulletIndicatorSnapshot(snapshot);
  }
  return pending.length;
}

/**
 * Defers the observation until after a primary alert has been queued. The
 * durable intent has already been written with its signal, so a restart can
 * recover any work not completed by this process.
 */
export function scheduleAltBulletIndicatorSnapshot(
  input: AltBulletSnapshotInput,
  options: {
    capture?: (input: AltBulletSnapshotInput) => Promise<void>;
    defer?: (callback: () => void) => void;
  } = {},
): void {
  const capture = options.capture ?? drainAltBulletIndicatorSnapshot;
  const defer = options.defer ?? ((callback) => setTimeout(callback, 0));
  defer(() => {
    void capture(input).catch((error) =>
      logger.error(
        { error, signalId: input.signalId, symbol: input.symbol },
        "AltBullet Neon background snapshot failed",
      ),
    );
  });
}
