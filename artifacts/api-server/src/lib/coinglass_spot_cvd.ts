/**
 * CoinGlass — Multi-TimeFrame (MTF) Spot CVD + 24h Spot Volume (unified).
 *
 * Endpoint: GET /api/spot/aggregated-cvd/history
 *   ?symbol=BTC&exchange_list=Binance,Bybit,Bitget,OKX&interval=15m&limit=96
 * Header: CG-API-KEY: <key>
 * Plan: Standard+ required.
 *
 * ЕДИНЫЙ вызов на символ с limit=96 (96 × 15m = 24ч):
 *   • CVD использует последние 16 свечей из 96 (= 4ч окно)
 *   • 24h spot volume суммирует все 96 свечей
 *   • Оба результата кэшируются вместе — 1 API-запрос на символ на 3 мин
 *
 * MTF логика (CVD):
 *   30m — последние 2 × 15m свечей:       суммарно buy > sell
 *   1h  — последние 4 свечи (60 мин):     суммарно net buy > sell
 *   4h  — последние 16 свечей (4ч):       cum_vol_delta последней свечи > 0
 *
 * Trend gate (scalp flag): 1h или 4h отрицательные → scalpOnly.
 * Golden: 30m + 1h + 4h положительные → isGolden.
 *
 * Cache: 3 min (единый для CVD и SpotVol). Fallback: available=false —
 * сигналы НЕ блокируются.
 *
 * Backward-compatible exports:
 *   getSpotCvdMtf()          — возвращает SpotCvdResult (тонкая обёртка)
 *   getCoinglassSpotVolume24h() — возвращает number|null (тонкая обёртка)
 *   getSpotCvdAndVolume()    — возвращает { cvd, spotVol24h } за 1 вызов
 */

import { getAllSpotExchanges } from "./coinglass-exchanges.js";
import { memoDisabled, runWithoutMemo } from "./coinglass-memo.js";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import type { CoinglassPriority } from "./coinglass_governor.js";

export interface SpotCvdResult {
  // ── Бинарные флаги (backward-compatible) ─────────────────────────────────
  /** Последняя 1 × 15m свеча: taker_buy > taker_sell (самый свежий сигнал) */
  cvd15m: boolean | null;
  /** Последние 2 × 15m свечей (= 30m): суммарно buy > sell */
  cvd30m: boolean | null;
  /** Последние 4 × 15m (= 1h): суммарно buy > sell */
  cvd1h: boolean | null;
  /** Последние 16 × 15m (= 4h): cum_vol_delta > 0 */
  cvd4h: boolean | null;
  /** 30m и 1h оба отрицательные → блокируем сигнал полностью */
  hardBlocked: boolean;
  /** 1h или 4h отрицательные (30m ок) → сигнал помечается Scalp Only */
  scalpOnly: boolean;
  /** Все 4 TF положительные → сильнейшее подтверждение */
  isGolden: boolean;
  available: boolean;

  // ── Числовые метрики силы ─────────────────────────────────────────────────
  /**
   * Нормализованный перевес за последний час (4 × 15m): (buy-sell)/(buy+sell).
   * Сглаживает noise отдельных свечей. null если нет данных.
   */
  cvdStrength1h: number | null;
  /**
   * Нормализованный running CVD за полное окно (16 × 15m = 4h):
   * cum_vol_delta[last] / total_volume. Показывает накопленное направление.
   * null если нет данных.
   */
  cvdStrength4h: number | null;
  /**
   * Абсолютный running CVD последней свечи (USD). null если нет данных.
   */
  cvdDelta4h: number | null;
}

// ─── Константы ────────────────────────────────────────────────────────────────

const CVD_CANDLES = 16; // последние 16 × 15m = 4ч окно для CVD
const UNIFIED_LIMIT = 96; // 96 × 15m = 24ч — единый размер запроса
const UNIFIED_CACHE_TTL = 3 * 60 * 1000; // 3 мин — CVD нужна свежесть

// ─── Единый кэш ───────────────────────────────────────────────────────────────

interface UnifiedCacheEntry {
  cvd: SpotCvdResult;
  spotVol24h: number | null;
  ts: number;
}
const unifiedCache = new Map<string, UnifiedCacheEntry>();

// ─── Circuit breaker ──────────────────────────────────────────────────────────
/**
 * При массовом сбое CoinGlass (все запросы таймаутят/фейлят) функция вызывается
 * последовательно на 250+ символов в основном цикле скана без concurrency-защиты.
 * Раньше каждый вызов «жёг» до ~16с (8с основной + retry), что растягивало цикл
 * до 40+ минут. Circuit breaker обрывает лавину после 6 подряд неудач.
 */
const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 2 * 60 * 1000; // 2 мин
let consecutiveFailures = 0;
let circuitBrokenUntil = 0;

function isCircuitBroken(): boolean {
  return circuitBrokenUntil > Date.now();
}

function recordFailure(cgSymbol: string): void {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && !isCircuitBroken()) {
    circuitBrokenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn(
      { consecutiveFailures, cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS },
      "CoinGlass SpotCVD circuit breaker сработал — API не отвечает, пропускаем остаток",
    );
    consecutiveFailures = 0; // сброс счётчика — следующий цикл начнёт с нуля
  }
  void cgSymbol;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitBrokenUntil = 0;
}

// ─── Типы и helpers ───────────────────────────────────────────────────────────

interface AggCvdCandle {
  time: number;
  agg_taker_buy_vol: number;
  agg_taker_sell_vol: number;
  cum_vol_delta: number;
}

/** BingX-символ → базовый тикер CoinGlass: BTC-USDT → BTC */
function toCgSymbol(bingxSymbol: string): string {
  return applyCgAlias(bingxSymbol.replace("-USDT", ""));
}

const NO_CVD: SpotCvdResult = {
  cvd15m: null,
  cvd30m: null,
  cvd1h: null,
  cvd4h: null,
  hardBlocked: false,
  scalpOnly: false,
  isGolden: false,
  available: false,
  cvdStrength1h: null,
  cvdStrength4h: null,
  cvdDelta4h: null,
};

// ─── Низкоуровневый HTTP-fetch ────────────────────────────────────────────────

async function fetchAggCvd(
  cgSymbol: string,
  apiKey: string,
  limit: number = UNIFIED_LIMIT,
  priority?: CoinglassPriority,
  exchanges: string = getAllSpotExchanges(),
): Promise<AggCvdCandle[] | null> {
  const url = new URL(
    "https://open-api-v4.coinglass.com/api/spot/aggregated-cvd/history",
  );
  url.searchParams.set("symbol", cgSymbol);
  url.searchParams.set("exchange_list", exchanges);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", String(limit));

  let retryReason: string | null = null;

  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
      { priority, endpoint: "spot/aggregated-cvd/history" },
    );
    if (res.status === 429) {
      logCg429(apiKey, { symbol: cgSymbol });
      reportApiFailure("coinglass", 429);
      return null;
    }
    if (!res.ok) {
      retryReason = `HTTP ${res.status}`;
    } else {
      const data = (await res.json()) as {
        code: string;
        data?: AggCvdCandle[];
      };
      if (data.code !== "0") return null;
      if (!data.data?.length) {
        retryReason = "пустой массив";
      } else {
        reportApiSuccess("coinglass");
        return data.data;
      }
    }
  } catch {
    return null;
  }

  // Единый retry-блок для !res.ok и пустого массива.
  // "пустой массив" = токен не покрыт CoinGlass (BingX-exclusive) — это НЕ ошибка API,
  // поэтому при подтверждении возвращаем [] (sentinel "нет данных"), а не null.
  // null зарезервирован для настоящих ошибок (таймаут, HTTP-сбой) и считается
  // в circuit breaker. [] — нет данных, circuit breaker НЕ трогает.
  const isNoData = retryReason === "пустой массив";
  logger.warn(
    { symbol: cgSymbol, reason: retryReason, key: apiKey.slice(-4) },
    "CoinGlass SpotCVD: ошибка ответа — retry с другим ключом через 300ms",
  );
  await new Promise<void>((r) => setTimeout(r, 300));
  const retryKey = getNextCgKey();
  if (!retryKey) return isNoData ? ([] as AggCvdCandle[]) : null;
  try {
    const retryRes = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": retryKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
      { priority, endpoint: "spot/aggregated-cvd/history" },
    );
    if (!retryRes.ok) return null;
    const retryData = (await retryRes.json()) as {
      code: string;
      data?: AggCvdCandle[];
    };
    if (retryData.code !== "0") return null;
    if (retryData.data?.length) {
      logger.info(
        { symbol: cgSymbol },
        "CoinGlass SpotCVD: retry успешен — данные получены",
      );
      reportApiSuccess("coinglass");
      return retryData.data;
    }
    // retry тоже вернул пустой массив — токен не покрыт CoinGlass (BingX-exclusive)
    return [] as AggCvdCandle[];
  } catch {
    // retry failed — настоящая ошибка
  }
  return null;
}

// ─── Единый внутренний вычислитель ───────────────────────────────────────────

/**
 * 1 HTTP-вызов с limit=96; вычисляет CVD (последние 16 свечей) и
 * 24h spot volume (все 96 свечей); результат кладётся в unifiedCache.
 */
async function fetchAndComputeUnified(
  cgSymbol: string,
  apiKey: string,
  priority?: CoinglassPriority,
  exchanges: string = getAllSpotExchanges(),
): Promise<UnifiedCacheEntry> {
  const cacheKey = cgSymbol;
  const failEntry: UnifiedCacheEntry = {
    cvd: { ...NO_CVD },
    spotVol24h: null,
    ts: Date.now(),
  };

  const candles = await fetchAggCvd(
    cgSymbol,
    apiKey,
    UNIFIED_LIMIT,
    priority,
    exchanges,
  );

  if (!candles) {
    // Настоящая ошибка API (таймаут, HTTP-сбой, исключение) — считаем для circuit breaker
    recordFailure(cgSymbol);
    unifiedCache.set(cacheKey, failEntry);
    return failEntry;
  }
  if (candles.length === 0) {
    // Нет данных (BingX-exclusive токен, не покрыт CoinGlass) — НЕ ошибка
    // circuit breaker не трогаем; доступность уже available=false через NO_CVD
    unifiedCache.set(cacheKey, failEntry);
    return failEntry;
  }

  recordSuccess();

  // ── SpotVol 24h: сумма по всем 96 свечам ─────────────────────────────────
  let totalVol = 0;
  for (const c of candles) {
    totalVol += c.agg_taker_buy_vol + c.agg_taker_sell_vol;
  }
  const spotVol24h = totalVol > 0 ? totalVol : null;

  // ── CVD: последние CVD_CANDLES (16) из полученного массива ───────────────
  const agg: Array<{ buy: number; sell: number; cumDelta: number }> =
    Array.from({ length: CVD_CANDLES }, () => ({
      buy: 0,
      sell: 0,
      cumDelta: 0,
    }));
  const start = Math.max(0, candles.length - CVD_CANDLES);
  const offset = CVD_CANDLES - (candles.length - start);
  for (let ci = start; ci < candles.length; ci++) {
    const slot = offset + (ci - start);
    const c = candles[ci]!;
    agg[slot]!.buy = c.agg_taker_buy_vol;
    agg[slot]!.sell = c.agg_taker_sell_vol;
    agg[slot]!.cumDelta = c.cum_vol_delta;
  }

  const validCount = agg.filter((s) => s.buy + s.sell > 0).length;

  let cvd15m: boolean | null = null;
  let cvd30m: boolean | null = null;
  let cvd1h: boolean | null = null;
  let cvdStrength1h: number | null = null;
  let cvd4h: boolean | null = null;
  let cvdStrength4h: number | null = null;
  let cvdDelta4h: number | null = null;

  // CVD 15m: предпоследняя 15-минутная свеча (вторая с конца).
  // agg[CVD_CANDLES - 1] = текущая незакрытая свеча — CoinGlass часто возвращает её с buy+sell=0.
  // agg[CVD_CANDLES - 2] = последняя ЗАКРЫТАЯ свеча — стабильные данные.
  if (validCount >= 2) {
    const prev = agg[CVD_CANDLES - 2]!;
    if (prev.buy + prev.sell > 0) cvd15m = prev.buy > prev.sell;
  }

  if (validCount >= 2) {
    let buy30 = 0,
      sell30 = 0;
    for (let i = CVD_CANDLES - 2; i < CVD_CANDLES; i++) {
      buy30 += agg[i]!.buy;
      sell30 += agg[i]!.sell;
    }
    if (buy30 + sell30 > 0) cvd30m = buy30 > sell30;
  }

  if (validCount >= 4) {
    let buy1h = 0,
      sell1h = 0;
    for (let i = CVD_CANDLES - 4; i < CVD_CANDLES; i++) {
      buy1h += agg[i]!.buy;
      sell1h += agg[i]!.sell;
    }
    if (buy1h + sell1h > 0) {
      cvd1h = buy1h > sell1h;
      cvdStrength1h = (buy1h - sell1h) / (buy1h + sell1h);
    }
  }

  if (validCount >= 8) {
    const lastCumDelta = agg[CVD_CANDLES - 1]!.cumDelta;
    const totalVolCvd = agg.reduce((s, c) => s + c.buy + c.sell, 0);
    cvd4h = lastCumDelta > 0;
    cvdDelta4h = lastCumDelta;
    cvdStrength4h = totalVolCvd > 0 ? lastCumDelta / totalVolCvd : null;
  }

  const hardBlocked = false;
  const scalpOnly = cvd1h === false || cvd4h === false;
  const isGolden = cvd30m === true && cvd1h === true && cvd4h === true;

  const cvd: SpotCvdResult = {
    cvd15m,
    cvd30m,
    cvd1h,
    cvd4h,
    hardBlocked,
    scalpOnly,
    isGolden,
    available: validCount > 0,
    cvdStrength1h,
    cvdStrength4h,
    cvdDelta4h,
  };

  const entry: UnifiedCacheEntry = { cvd, spotVol24h, ts: Date.now() };
  unifiedCache.set(cacheKey, entry);
  return entry;
}

// ─── Публичные API ────────────────────────────────────────────────────────────

/**
 * Возвращает CVD-вердикт + 24h spot volume за ОДИН API-вызов (limit=96).
 * Оба результата разделяют единый 3-мин кэш.
 * Используй вместо раздельных вызовов getSpotCvdMtf + getCoinglassSpotVolume24h,
 * если нужны оба значения для одного символа.
 */
export async function getSpotCvdAndVolume(
  symbol: string,
  options: {
    bypassCache?: boolean;
    priority?: CoinglassPriority;
    exchanges?: string;
  } = {},
): Promise<{ cvd: SpotCvdResult; spotVol24h: number | null }> {
  // Live callers need the current forming bar: skip the response memo.
  if (options.bypassCache && !memoDisabled()) {
    return runWithoutMemo(() => getSpotCvdAndVolume(symbol, options));
  }
  const apiKey = getNextCgKey();
  if (!apiKey) return { cvd: { ...NO_CVD }, spotVol24h: null };

  const cgSymbol = toCgSymbol(symbol);
  const exchanges = options.exchanges ?? getAllSpotExchanges();
  const cacheKey = cgSymbol;
  const cached = unifiedCache.get(cacheKey);
  if (
    !options.bypassCache &&
    cached &&
    Date.now() - cached.ts < UNIFIED_CACHE_TTL
  ) {
    return { cvd: cached.cvd, spotVol24h: cached.spotVol24h };
  }

  if (isCircuitBroken()) return { cvd: { ...NO_CVD }, spotVol24h: null };

  const entry = await fetchAndComputeUnified(
    cgSymbol,
    apiKey,
    options.priority,
    exchanges,
  );
  return { cvd: entry.cvd, spotVol24h: entry.spotVol24h };
}

/**
 * Backward-compatible: возвращает только SpotCvdResult.
 * Внутри использует единый кэш — тот же HTTP-запрос обслуживает и getCoinglassSpotVolume24h.
 */
export async function getSpotCvdMtf(
  symbol: string,
  options: {
    bypassCache?: boolean;
    priority?: CoinglassPriority;
    exchanges?: string;
  } = {},
): Promise<SpotCvdResult> {
  const { cvd } = await getSpotCvdAndVolume(symbol, options);

  logger.debug(
    {
      symbol,
      cvd30m: cvd.cvd30m,
      cvd1h: cvd.cvd1h,
      cvd4h: cvd.cvd4h,
      hardBlocked: cvd.hardBlocked,
      scalpOnly: cvd.scalpOnly,
      isGolden: cvd.isGolden,
      str1h:
        cvd.cvdStrength1h != null
          ? (cvd.cvdStrength1h * 100).toFixed(1) + "%"
          : "n/a",
      str4h:
        cvd.cvdStrength4h != null
          ? (cvd.cvdStrength4h * 100).toFixed(1) + "%"
          : "n/a",
      delta4h: cvd.cvdDelta4h != null ? cvd.cvdDelta4h.toFixed(0) : "n/a",
    },
    "Spot CVD MTF",
  );

  return cvd;
}

/**
 * Backward-compatible: возвращает только 24h spot volume (USD).
 * Внутри использует единый 3-мин кэш — тот же HTTP-запрос обслуживает и getSpotCvdMtf.
 * Прежний TTL 30 мин заменён на 3 мин (управляется свежестью CVD-данных).
 */
export async function getCoinglassSpotVolume24h(
  bingxSymbol: string,
): Promise<number | null> {
  const { spotVol24h } = await getSpotCvdAndVolume(bingxSymbol);
  if (spotVol24h != null) {
    logger.debug(
      { symbol: bingxSymbol, spotVol24h: spotVol24h.toFixed(0) },
      "CoinGlass Spot Vol 24h",
    );
  }
  return spotVol24h;
}
