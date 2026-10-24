/**
 * CoinGlass — агрегированный OI по всем биржам (OHLC history).
 *
 * Endpoint: GET /api/futures/open-interest/aggregated-history
 *           ?symbol=BTC&interval=30m&limit=50
 * Header: CG-API-KEY: <API_KEY>
 * Plan: Professional (open-api-v4.coinglass.com)
 *
 * Из 50 × 30m свечей вычисляем:
 *   oiChange30m  — дельта последней свечи
 *   prevOi30m    — дельта предпредпоследней (candle[-2]) — без цикл-сдвига
 *   oiChange1h   — дельта за 2 свечи (1 час)
 *   oiChange4h   — дельта за 8 свечей (4 часа)
 *   oiChange24h  — дельта за 48 свечей (24 часа)
 *   positiveCandles6h   — кол-во 30m свечей с ростом за последние 6ч
 *   oiConsecutiveUp     — подряд идущих 30m свечей роста от конца
 *   oi4hConsecFromOhlc  — подряд 4h-периодов роста OI (из 30m свечей)
 *
 * Кэш: 5 мин на символ.
 */

import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { recordCgSkip } from "./coinglass-arm-trace.js";

const OI_TRACE_ENDPOINT = "futures/open-interest/aggregated-history";
import type { CoinglassPriority } from "./coinglass_governor.js";
import { fetchMarketCap } from "./whale_watch_v2.js";

/** Бросается когда circuit breaker срабатывает — CoinGlass явно недоступен */
export class CoinglassOutageError extends Error {
  constructor(public readonly skipped: number) {
    super(
      `CoinGlass API недоступен — circuit breaker сработал, пропущено ${skipped} токенов`,
    );
    this.name = "CoinglassOutageError";
  }
}

export interface CoinglassOIResult {
  /**
   * Snapshot-mode only: 30m history was requested for this symbol (prescan)
   * but did not arrive, so prevOi30m / oi4hConsecFromOhlc / positiveCandles6h /
   * oiConsecutiveUp are null. Current OI fields still come from the snapshot.
   */
  historyMissing?: boolean;
  /** Агрегированное изменение OI за 30 минут в % (последняя OHLC свеча) */
  oiChange30m: number | null;
  /** OI за ПРЕДЫДУЩИЙ 30m период (candle[-2]) — напрямую из OHLC, без цикл-сдвига */
  prevOi30m: number | null;
  /** Агрегированное изменение OI за 1 час в % */
  oiChange1h: number | null;
  /** Агрегированное изменение OI за 4 часа в % */
  oiChange4h: number | null;
  /** Агрегированное изменение OI за 24 часа в % */
  oiChange24h: number | null;
  /** Абсолютный OI в USD (close последней свечи) */
  oiUsd: number | null;
  /** Всегда null: OHLC endpoint не содержит volume-данных */
  cgVolUsd: number | null;
  /** Всегда null: OHLC агрегат без per-exchange breakdown */
  bingxOiChange30m: number | null;
  /** Кол-во 30m свечей с ростом OI за последние 6ч (из 12 свечей) */
  positiveCandles6h: number | null;
  /** Кол-во последовательных 30m свечей с ростом OI от конца ряда */
  oiConsecutiveUp: number | null;
  /** Кол-во последовательных 4h-периодов роста OI (вычисляется из 30m свечей) */
  oi4hConsecFromOhlc: number | null;
  available: boolean;
  /** true = запрос упал по таймауту */
  timedOut: boolean;
  /** true = available:false из-за подозрения на коллизию тикера в CoinGlass */
  collisionSuspected?: boolean;
  /** Низкокардинальная причина недоступности/пропуска для диагностики покрытия. */
  unavailableReason?: CoinglassOIUnavailableReason;
  source: "coinglass" | "prescan_stale";
}

export type CoinglassOIUnavailableReason =
  | "breaker_skip"
  | "prescan_skip"
  | "unsupported"
  | "not_in_snapshot"
  | "snapshot_unavailable"
  | "empty"
  | "collision"
  | "timeout"
  | "transport"
  | "upstream_error"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "missing_api_key";

const cache = new Map<string, { result: CoinglassOIResult; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Ticker-collision guard (US-USDT case: CoinGlass returned OI ~100x above the
 * real instrument). The check uses only the CoinGlass aggregate OI against the
 * CoinGecko market cap. It no longer compares with single-exchange BingX OI or
 * partial-exchange Coinalyze OI: both are smaller than the all-exchange total
 * and rejected valid data (ATOM 2026-10-19: CG $147M vs BingX $4.2M = 34.7x and
 * Coinalyze $12.5M = 11.7x, so the legitimate OI was dropped as "collision").
 * 10x market cap is far above any real OI/mcap and below the 80-100x collisions.
 */
export const OI_MCAP_COLLISION_RATIO = 10;

/** True when aggregate OI is implausibly large for the asset's market cap. */
export function oiExceedsMarketCapCollisionLimit(
  oiUsd: number,
  mcapUsd: number | null,
): boolean {
  if (mcapUsd == null || !(mcapUsd > 0) || !(oiUsd > 0)) return false;
  return oiUsd / mcapUsd > OI_MCAP_COLLISION_RATIO;
}

/**
 * Collision verdict over every known market-cap source (CoinGecko and the
 * CoinGlass coins-markets row). Flagged only when ALL known sources exceed the
 * limit: a CoinGecko ticker mismatch (CT, STAR, RATS, BB on 2026-10-19: CoinGecko
 * mcap 14k-550k vs CoinGlass 6M-64M) must not discard valid OI.
 */
export function oiCollisionByMarketCaps(
  oiUsd: number,
  mcaps: ReadonlyArray<number | null | undefined>,
): boolean {
  const known = mcaps.filter((m): m is number => m != null && m > 0);
  if (known.length === 0) return false;
  return known.every((m) => oiExceedsMarketCapCollisionLimit(oiUsd, m));
}

/** BingX-символ → базовый тикер для CoinGlass */
export { CG_SYMBOL_ALIAS } from "./cg-symbol-alias.js";
import { CG_SYMBOL_ALIAS } from "./cg-symbol-alias.js";
import { memoDisabled, runWithoutMemo } from "./coinglass-memo.js";
import {
  coinsMarketsRowFrom,
  getCoinsMarketsOiRow,
  refreshCoinsMarketsOi,
  type CoinsMarketsSnapshot,
} from "./coinglass_vol24h.js";

function toBaseSymbol(bingxSymbol: string): string {
  const base = bingxSymbol.replace("-USDT", "");
  return CG_SYMBOL_ALIAS[base] ?? base;
}

/** Возвращает только формы символа, подтверждённые whitelist-ом. */
function cgSymbolCandidates(base: string): string[] {
  const supportedCoins = getCgSupportedCoinsSet();
  if (supportedCoins !== null) {
    if (supportedCoins.has(base)) return [base];
    const suffixed = `${base}USDT`;
    return supportedCoins.has(suffixed) ? [suffixed] : [];
  }
  // При недоступном whitelist запрашиваем только каноническую форму. Сам
  // scanner дополнительно ограничивает размер degraded discovery batch.
  return [base];
}

interface OiHistoryCandle {
  time: number;
  close: string | number;
}

const CG_FETCH_TIMEOUT_MS = 5000;
const CG_RETRY_DELAY_MS = 250;

interface FetchOiHistoryResult {
  candles: OiHistoryCandle[] | null;
  timedOut: boolean;
  /** Только 429 можно разумно повторить с другим API-ключом. */
  retryable: boolean;
  reason?: CoinglassOIUnavailableReason;
}

/**
 * Один HTTP-запрос к CoinGlass aggregated-history (v4 Professional).
 * Retry при HTTP-ошибках (не при пустом массиве — символ просто не в CG).
 */
async function fetchOiOhlcHistory(
  cgSymbol: string,
  apiKey: string,
  signal?: AbortSignal,
  priority?: CoinglassPriority,
  interval: "30m" | "15m" = "30m",
  limit = 50,
): Promise<FetchOiHistoryResult> {
  const url =
    `https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history` +
    `?symbol=${encodeURIComponent(cgSymbol)}&interval=${interval}&limit=${limit}`;

  async function doFetch(key: string): Promise<FetchOiHistoryResult> {
    try {
      const res = await cgTimedFetch(
        url,
        {
          headers: { "CG-API-KEY": key, Accept: "application/json" },
          signal: signal
            ? AbortSignal.any([
                signal,
                AbortSignal.timeout(CG_FETCH_TIMEOUT_MS),
              ])
            : AbortSignal.timeout(CG_FETCH_TIMEOUT_MS),
        },
        { priority, endpoint: "futures/open-interest/aggregated-history" },
      );
      if (res.status === 429) {
        logCg429(key, { symbol: cgSymbol });
        return {
          candles: null,
          timedOut: false,
          retryable: true,
          reason: "http_429",
        };
      }
      // 4xx (включая unsupported symbol) и upstream errors не исправляются
      // ротацией ключа: второй запрос только раздувает batch.
      if (!res.ok) {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason:
            res.status >= 500
              ? "http_5xx"
              : res.status >= 400
                ? "http_4xx"
                : "empty",
        };
      }
      let json: {
        code?: string;
        msg?: string;
        data?: OiHistoryCandle[];
      };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason: "upstream_error",
        };
      }
      const responseCode =
        json.code === undefined ? undefined : String(json.code);
      if (responseCode === "429") {
        logCg429(key, { symbol: cgSymbol });
        return {
          candles: null,
          timedOut: false,
          retryable: true,
          reason: "http_429",
        };
      }
      if (
        responseCode !== undefined &&
        /^\d+$/.test(responseCode) &&
        Number(responseCode) >= 500 &&
        Number(responseCode) <= 599
      ) {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason: "http_5xx",
        };
      }
      if (
        responseCode === "400" &&
        /invalid api key/i.test(json.msg ?? "") &&
        Date.now() - _cgInvalidKeyWarnedAt > 5 * 60_000
      ) {
        _cgInvalidKeyWarnedAt = Date.now();
        logger.error(
          { code: responseCode, msg: json.msg },
          "CoinGlass authentication failed — CoinGlassAPI key is invalid",
        );
      }
      if (responseCode !== "0") {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason:
            responseCode === "400" && /symbol|coin/i.test(json.msg ?? "")
              ? "unsupported"
              : responseCode === undefined
                ? "upstream_error"
                : "http_4xx",
        };
      }
      if (!Array.isArray(json.data)) {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason: "upstream_error",
        };
      }
      if (json.data.length === 0) {
        return {
          candles: null,
          timedOut: false,
          retryable: false,
          reason: "empty",
        };
      }
      return { candles: json.data, timedOut: false, retryable: false };
    } catch (err) {
      const timedOut =
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError");
      return {
        candles: null,
        timedOut,
        retryable: false,
        reason: timedOut ? "timeout" : "transport",
      };
    }
  }

  const first = await doFetch(apiKey);
  if (first.candles || first.timedOut || !first.retryable) return first;

  // HTTP-ошибка (не пустой массив) → retry с другим ключом
  await new Promise<void>((r) => setTimeout(r, CG_RETRY_DELAY_MS));
  const retryKey = getNextCgKey();
  if (!retryKey || retryKey === apiKey) return first;
  logger.warn(
    { symbol: cgSymbol, key: apiKey.slice(-4) },
    "CoinGlass OI OHLC: HTTP ошибка — retry с другим ключом",
  );
  return doFetch(retryKey);
}

/**
 * Вычисляет % изменение: (current - ref) / |ref| * 100.
 * Возвращает null если reference == 0 или null.
 */
function pct(current: number, ref: number | null | undefined): number | null {
  if (ref == null || ref === 0) return null;
  return ((current - ref) / Math.abs(ref)) * 100;
}

/**
 * Вычисляет все OI-метрики из массива OHLC свечей (отсортированных по времени, oldest first).
 * limit=50 × 30m = 25 часов сырых данных → 48 дельт для 24h.
 */
function computeOiMetrics(
  candles: OiHistoryCandle[],
): Omit<
  CoinglassOIResult,
  | "cgVolUsd"
  | "bingxOiChange30m"
  | "available"
  | "timedOut"
  | "source"
  | "collisionSuspected"
> {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const closes = sorted.map((c) =>
    typeof c.close === "string" ? parseFloat(c.close) : c.close,
  );
  const n = closes.length;

  const nullResult = {
    oiChange30m: null,
    prevOi30m: null,
    oiChange1h: null,
    oiChange4h: null,
    oiChange24h: null,
    oiUsd: null,
    positiveCandles6h: null,
    oiConsecutiveUp: null,
    oi4hConsecFromOhlc: null,
  };

  if (n < 3) return nullResult;

  const latest = closes[n - 1];

  const oiChange30m = pct(latest, closes[n - 2]);
  const prevOi30m = pct(closes[n - 2] ?? 0, closes[n - 3]); // prev 30m period
  const oiChange1h = pct(latest, closes[n - 3]); // 2 × 30m
  const oiChange4h = n >= 9 ? pct(latest, closes[n - 9]) : null; // 8 × 30m
  const oiChange24h = n >= 49 ? pct(latest, closes[n - 49]) : null; // 48 × 30m

  // Кол-во 30m свечей роста в последних 6ч (12 свечей)
  let positiveCandles6h = 0;
  const from6h = Math.max(1, n - 12);
  for (let i = from6h; i < n; i++) {
    if (closes[i] > closes[i - 1]) positiveCandles6h++;
  }

  // Подряд идущих 30m свечей роста от конца
  let oiConsecutiveUp = 0;
  for (let i = n - 1; i >= 1; i--) {
    if (closes[i] > closes[i - 1]) oiConsecutiveUp++;
    else break;
  }

  // Подряд 4h-периодов роста OI (каждый период = 8 × 30m свечей)
  // Сравниваем close[n-1] vs close[n-9] (период 0), close[n-9] vs close[n-17] (период 1), ...
  let oi4hConsecFromOhlc = 0;
  const fourH = 8;
  for (let p = 0; p < 6; p++) {
    const hi = n - 1 - p * fourH;
    const lo = hi - fourH;
    if (lo < 0) break;
    if (closes[hi] > closes[lo]) oi4hConsecFromOhlc++;
    else break;
  }

  return {
    oiChange30m,
    prevOi30m,
    oiChange1h,
    oiChange4h,
    oiChange24h,
    oiUsd: latest,
    positiveCandles6h,
    oiConsecutiveUp,
    oi4hConsecFromOhlc,
  };
}

/**
 * Aggregated OI change of the latest 15m bar (same definition as oiChange30m:
 * latest bar close vs the previous bar close). Fire-time telemetry only: one
 * small request per fired signal, never part of the scan loop.
 */
export async function getCoinglassOi15mChange(
  symbol: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  const base = toBaseSymbol(symbol);
  for (const cgSym of cgSymbolCandidates(base)) {
    const attempt = await runWithoutMemo(() =>
      fetchOiOhlcHistory(cgSym, apiKey, signal, "critical", "15m", 3),
    ).catch(
      (): FetchOiHistoryResult => ({
        candles: null,
        timedOut: false,
        retryable: false,
        reason: "transport",
      }),
    );
    if (!attempt.candles) continue;
    const closes = [...attempt.candles]
      .sort((a, b) => a.time - b.time)
      .map((c) => (typeof c.close === "string" ? parseFloat(c.close) : c.close))
      .filter((v) => Number.isFinite(v));
    if (closes.length < 2) return null;
    return pct(closes[closes.length - 1], closes[closes.length - 2]);
  }
  return null;
}

export async function getCoinglassOI(
  symbol: string,
  priceUsd?: number | null,
  signal?: AbortSignal,
  options: { bypassCache?: boolean; priority?: CoinglassPriority } = {},
): Promise<CoinglassOIResult> {
  // Live callers need the current forming bar: skip the response memo.
  if (options.bypassCache && !memoDisabled()) {
    return runWithoutMemo(() =>
      getCoinglassOI(symbol, priceUsd, signal, options),
    );
  }
  const apiKey = getNextCgKey();

  const noData: CoinglassOIResult = {
    oiChange30m: null,
    prevOi30m: null,
    oiChange1h: null,
    oiChange4h: null,
    oiChange24h: null,
    oiUsd: null,
    cgVolUsd: null,
    bingxOiChange30m: null,
    positiveCandles6h: null,
    oiConsecutiveUp: null,
    oi4hConsecFromOhlc: null,
    available: false,
    timedOut: false,
    source: "coinglass",
  };

  if (!apiKey) return { ...noData, unavailableReason: "missing_api_key" };

  const base = toBaseSymbol(symbol);
  const cached = cache.get(base);
  if (!options.bypassCache && cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.result;
  }

  try {
    const candidates = cgSymbolCandidates(base);
    let candles: OiHistoryCandle[] | null = null;
    let usedCgSymbol = base;
    let anyTimedOut = false;
    let unavailableReason: CoinglassOIUnavailableReason = "unsupported";

    for (const cgSym of candidates) {
      const attempt = await fetchOiOhlcHistory(
        cgSym,
        apiKey,
        signal,
        options.priority,
      ).catch(
        (): FetchOiHistoryResult => ({
          candles: null,
          timedOut: false,
          retryable: false,
          reason: "transport",
        }),
      );
      if (attempt.timedOut) anyTimedOut = true;
      if (attempt.reason) unavailableReason = attempt.reason;
      if (attempt.candles) {
        candles = attempt.candles;
        usedCgSymbol = cgSym;
        break;
      }
    }

    if (!candles) {
      logger.debug(
        { reason: unavailableReason, timedOut: anyTimedOut },
        "CoinGlass OI OHLC: нет данных ни по одному кандидату символа",
      );
      reportApiFailure("coinglass", 0);
      return {
        ...noData,
        timedOut: anyTimedOut,
        unavailableReason:
          candidates.length === 0 ? "unsupported" : unavailableReason,
      };
    }
    if (usedCgSymbol !== base) {
      logger.info(
        { symbol, base, usedCgSymbol },
        "CoinGlass OI OHLC: данные найдены по fallback-символу — добавь в CG_SYMBOL_ALIAS",
      );
    }

    const metrics = computeOiMetrics(candles);

    if (metrics.oiUsd == null) {
      logger.debug(
        { symbol, candleCount: candles.length },
        "CoinGlass OI OHLC: < 3 свечей — нет данных",
      );
      reportApiFailure("coinglass", 0);
      return { ...noData, timedOut: anyTimedOut, unavailableReason: "empty" };
    }

    const result: CoinglassOIResult = {
      ...metrics,
      cgVolUsd: null,
      bingxOiChange30m: null,
      available: true,
      timedOut: false,
      source: "coinglass",
    };

    // Collision guard against CoinGecko market cap (CoinGlass-only OI, no BingX).
    if (result.oiUsd != null && result.oiUsd > 0) {
      const mc = await fetchMarketCap(symbol).catch(() => null);
      if (
        oiCollisionByMarketCaps(result.oiUsd, [
          mc?.mcap,
          getCoinsMarketsOiRow(symbol)?.mcapUsd,
        ])
      ) {
        logger.debug(
          {
            symbol,
            base,
            usedCgSymbol,
            cgOiUsd: result.oiUsd.toFixed(0),
            mcapUsd: mc?.mcap.toFixed(0),
          },
          "CoinGlass OI OHLC: OI выше 10x капитализации — подозрение на коллизию тикера",
        );
        reportApiFailure("coinglass", 0);
        const mismatch: CoinglassOIResult = {
          ...noData,
          source: "coinglass",
          collisionSuspected: true,
          unavailableReason: "collision",
        };
        cache.set(usedCgSymbol, { result: mismatch, ts: Date.now() });
        return mismatch;
      }
    }

    reportApiSuccess("coinglass");
    cache.set(usedCgSymbol, { result, ts: Date.now() });
    logger.debug(
      {
        symbol,
        oi30m: result.oiChange30m?.toFixed(2) + "%",
        prev30m: result.prevOi30m?.toFixed(2) + "%",
        oi1h: result.oiChange1h?.toFixed(2) + "%",
        oi4h:
          result.oiChange4h != null
            ? result.oiChange4h.toFixed(2) + "%"
            : "n/a",
        oi24h:
          result.oiChange24h != null
            ? result.oiChange24h.toFixed(2) + "%"
            : "n/a",
        pos6h: result.positiveCandles6h,
        consec: result.oiConsecutiveUp,
        consec4h: result.oi4hConsecFromOhlc,
        oiUsd: result.oiUsd?.toFixed(0),
      },
      "CoinGlass OI OHLC fetched",
    );
    return result;
  } catch (err) {
    logger.warn({ symbol, err }, "CoinGlass OI OHLC fetch error");
    reportApiFailure("coinglass");
    const isTimeout =
      err instanceof Error &&
      (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      ...noData,
      timedOut: isTimeout,
      unavailableReason: isTimeout ? "timeout" : "transport",
    };
  }
}

// ── Module-level circuit breaker ──────────────────────────────────────────────
// Старая схема: circuitBroken был ЛОКАЛЬНОЙ переменной внутри batchGetCoinglassOI.
// Проблемы:
//   1. Два prod-воркера имели независимые счётчики — Worker A трипал, Worker B нет.
//   2. Только val.timedOut считался failure — HTTP 429/500 сбрасывали счётчик,
//      CB никогда не срабатывал при волне HTTP-ошибок.
//   3. После trip circuitBroken умирал вместе с вызовом — следующий batchGetCoinglassOI
//      стартовал с нулевым счётчиком даже если API ещё не восстановился.
// Новая схема: module-level + cooldown 3 мин + genuine upstream failures.
let _cgOiBatchConsecFailures = 0;
let _cgOiBatchCircuitBrokenUntil = 0;
let _cgOiBreakerTrips = 0;
/** Breaker trips since the last call (one scanner cycle). */
export function drainCgOiBreakerTrips(): number {
  const n = _cgOiBreakerTrips;
  _cgOiBreakerTrips = 0;
  return n;
}
// Which path produced each symbol's OI since the last drain (one scanner cycle).
// One entry per batchGetCoinglassOI call, so a second call inside the same
// cycle is visible instead of silently doubling the totals.
export interface CgOiBatchCallStat {
  label: string;
  /** True when the OI of every symbol comes from the pinned snapshot. */
  snapshotMode: boolean;
  snapshotLoadedAt: number | null;
  requested: number;
  fromSnapshot: number;
  collisionFromSnapshot: number;
  /** Snapshot mode: symbols with no snapshot row (no OI, no per-symbol call). */
  notInSnapshot: number;
  snapshotUnavailable: number;
  /** 30m history requests (supplement only, symbols with a consumer). */
  history: { requested: number; merged: number; missing: number };
  notInSnapshotSymbols: string[];
}
let _oiCalls: CgOiBatchCallStat[] = [];
export function drainCgOiSourceCounts() {
  const calls = _oiCalls;
  _oiCalls = [];
  const sum = (f: (c: CgOiBatchCallStat) => number) =>
    calls.reduce((n, c) => n + f(c), 0);
  return {
    calls,
    fromCoinsMarketsSnapshot: sum((c) => c.fromSnapshot),
    collisionFromSnapshot: sum((c) => c.collisionFromSnapshot),
    notInSnapshot: sum((c) => c.notInSnapshot),
    historyRequests: sum((c) => c.history.requested),
    historyMerged: sum((c) => c.history.merged),
    historyMissing: sum((c) => c.history.missing),
    historyPathSymbols: calls.flatMap((c) => c.notInSnapshotSymbols),
  };
}
const CG_OI_CB_THRESHOLD = 6;
const CG_OI_CB_COOLDOWN_MS = 3 * 60 * 1000;
function _cgOiIsBreakerFailure(reason?: CoinglassOIUnavailableReason): boolean {
  return (
    reason === "timeout" ||
    reason === "transport" ||
    reason === "upstream_error" ||
    reason === "http_429" ||
    reason === "http_5xx"
  );
}

function _cgOiCircuitBroken(): boolean {
  const now = Date.now();
  if (_cgOiBatchCircuitBrokenUntil > 0 && _cgOiBatchCircuitBrokenUntil <= now) {
    // Старый счётчик не должен трипнуть новый batch первой же ошибкой после
    // cooldown.
    _cgOiBatchCircuitBrokenUntil = 0;
    _cgOiBatchConsecFailures = 0;
  }
  return _cgOiBatchCircuitBrokenUntil > now;
}

/**
 * Батч-получение CoinGlass OI для списка BingX-символов.
 * Возвращает Map<symbol, CoinglassOIResult> для всех запрошенных символов.
 *
 * Plan STANDARD: 300 req/min per key (owner, 2026-10-19); the governor caps all CoinGlass starts at 240/min (80%).
 * Стратегия: semaphore CONCURRENCY=5 + MIN_SLOT_DELAY_MS=400ms.
 * Rate math: ≤5 параллельных, старт не чаще 1 раз/400ms → ~2.5 req/s на процесс.
 *
 * Circuit breaker (module-level): 6 последовательных upstream failures
 * (timeout/transport/HTTP 429/5xx); unsupported/no-data/collision не считаются.
 * → помечаем остаток как unavailable + 3 мин cooldown. Оба воркера видят один статус.
 */
export async function batchGetCoinglassOI(
  bingxSymbols: string[],
  priceMap?: Map<string, number>,
  skipSymbols?: Set<string>,
  signal?: AbortSignal,
  /**
   * Request order: first the symbols with live Stealth arms ("arms"), then
   * prescan symbols ("prescan"); everything else follows. Arm symbols never
   * get breaker_skip: they wait for the cooldown to end instead.
   */
  schedule?: { arms?: ReadonlySet<string>; prescan?: ReadonlySet<string> },
  /**
   * snapshot: coins-markets snapshot pinned by the caller for the whole cycle
   * (no refresh inside the batch). Without it the batch refreshes the shared
   * snapshot when older than 120 s.
   */
  options: { snapshot?: CoinsMarketsSnapshot | null; label?: string } = {},
): Promise<Map<string, CoinglassOIResult>> {
  const results = new Map<string, CoinglassOIResult>();

  const emptyResult: CoinglassOIResult = {
    available: false,
    timedOut: false,
    oiChange30m: null,
    prevOi30m: null,
    oiChange1h: null,
    oiChange4h: null,
    oiChange24h: null,
    oiUsd: null,
    cgVolUsd: null,
    bingxOiChange30m: null,
    positiveCandles6h: null,
    oiConsecutiveUp: null,
    oi4hConsecFromOhlc: null,
    source: "coinglass" as const,
  };

  const snapshotResult = (row: {
    oiUsd: number;
    oiChange30m: number | null;
    oiChange1h: number | null;
    oiChange4h: number | null;
    oiChange24h: number | null;
  }): CoinglassOIResult => ({
    ...emptyResult,
    available: true,
    oiChange30m: row.oiChange30m,
    oiChange1h: row.oiChange1h,
    oiChange4h: row.oiChange4h,
    oiChange24h: row.oiChange24h,
    oiUsd: row.oiUsd,
  });

  const pinned = options.snapshot ?? null;
  // Phase 1: return cached results immediately (never in snapshot mode: the
  // current OI of every symbol must come from the pinned snapshot).
  const toFetch: string[] = [];
  for (const symbol of bingxSymbols) {
    const base = toBaseSymbol(symbol);
    const supportedCoins = getCgSupportedCoinsSet();
    const supported =
      supportedCoins === null ||
      supportedCoins.has(base) ||
      supportedCoins.has(`${base}USDT`);
    if (skipSymbols?.has(symbol)) {
      results.set(symbol, {
        ...emptyResult,
        unavailableReason: "prescan_skip",
      });
      continue;
    }
    if (!supported) {
      results.set(symbol, {
        ...emptyResult,
        unavailableReason: "unsupported",
      });
      continue;
    }
    const cached = cache.get(base);
    if (!pinned && cached && Date.now() - cached.ts < CACHE_TTL) {
      results.set(symbol, cached.result);
    } else {
      toFetch.push(symbol);
    }
  }

  if (toFetch.length === 0) return results;

  // Snapshot mode (scanner): the current OI of EVERY symbol (arms and prescan
  // included) comes only from the pinned coins-markets snapshot. A symbol with
  // no snapshot row has no OI. The 30m history is a supplement fetched only for
  // prescan symbols, the only consumers of prevOi30m / oiAccel30m /
  // oi4hConsecGrowth; a history failure never substitutes anything: the fields
  // stay null and the result is flagged historyMissing.
  // Legacy mode (no pinned snapshot): refresh the shared snapshot and use the
  // per-symbol path for arms / prescan / symbols without a row.
  if (!pinned) await refreshCoinsMarketsOi(120_000);
  const lookupRow = (sym: string) =>
    pinned ? coinsMarketsRowFrom(pinned.rows, sym) : getCoinsMarketsOiRow(sym);
  const snapshotAvailable = pinned
    ? pinned.rows.size > 0
    : getCoinsMarketsOiRow("BTC") != null;
  const callStat: CgOiBatchCallStat = {
    label: options.label ?? (schedule ? "scanner" : "other"),
    snapshotMode: pinned != null,
    snapshotLoadedAt: pinned?.loadedAt ?? null,
    requested: bingxSymbols.length,
    fromSnapshot: 0,
    collisionFromSnapshot: 0,
    notInSnapshot: 0,
    snapshotUnavailable: 0,
    history: { requested: 0, merged: 0, missing: 0 },
    notInSnapshotSymbols: [],
  };
  _oiCalls.push(callStat);
  const historyQueue: string[] = [];
  const snapshotBase = new Map<string, CoinglassOIResult>();
  for (const sym of toFetch) {
    const row = lookupRow(sym);
    if (pinned && !row) {
      callStat.notInSnapshot += snapshotAvailable ? 1 : 0;
      callStat.snapshotUnavailable += snapshotAvailable ? 0 : 1;
      if (snapshotAvailable) callStat.notInSnapshotSymbols.push(sym);
      results.set(sym, {
        ...emptyResult,
        unavailableReason: snapshotAvailable
          ? "not_in_snapshot"
          : "snapshot_unavailable",
      });
      continue;
    }
    const wantsHistory = pinned
      ? !!schedule?.prescan?.has(sym)
      : !!(schedule?.arms?.has(sym) || schedule?.prescan?.has(sym)) || !row;
    if (!pinned && wantsHistory) {
      historyQueue.push(sym);
      continue;
    }
    if (oiCollisionByMarketCaps(row!.oiUsd, [row!.mcapUsd])) {
      callStat.collisionFromSnapshot++;
      results.set(sym, {
        ...emptyResult,
        collisionSuspected: true,
        unavailableReason: "collision",
      });
      continue;
    }
    callStat.fromSnapshot++;
    const base = snapshotResult(row!);
    results.set(sym, base);
    if (wantsHistory) {
      snapshotBase.set(sym, base);
      historyQueue.push(sym);
    }
  }
  callStat.history.requested = historyQueue.length;
  toFetch.length = 0;
  toFetch.push(...historyQueue);
  if (toFetch.length === 0) return results;

  const scheduleRank = (sym: string): number =>
    schedule?.arms?.has(sym) ? 0 : schedule?.prescan?.has(sym) ? 1 : 2;
  toFetch.sort((a, b) => scheduleRank(a) - scheduleRank(b));
  const waitForBreakerEnd = async (): Promise<void> => {
    while (_cgOiCircuitBroken() && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };

  const CONCURRENCY = 5;
  const MIN_SLOT_DELAY_MS = 400;

  // Jitter: два воркера не стартуют синхронно
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 2000)));

  let activeSlots = 0;
  let lastStartAt = 0;
  const waiting: Array<() => void> = [];

  function acquireSlot(): Promise<void> {
    return new Promise((resolve) => {
      if (activeSlots < CONCURRENCY) {
        activeSlots++;
        resolve();
      } else waiting.push(resolve);
    });
  }

  function releaseSlot(): void {
    activeSlots--;
    const next = waiting.shift();
    if (next) {
      activeSlots++;
      next();
    }
  }

  async function fetchOne(sym: string): Promise<void> {
    if (signal?.aborted) {
      results.set(sym, emptyResult);
      return;
    }
    if (_cgOiCircuitBroken()) {
      if (scheduleRank(sym) === 0) await waitForBreakerEnd();
      else {
        recordCgSkip(sym, OI_TRACE_ENDPOINT, "breaker_skip");
        results.set(sym, { ...emptyResult, unavailableReason: "breaker_skip" });
        return;
      }
    }
    await acquireSlot();
    if (signal?.aborted) {
      results.set(sym, emptyResult);
      releaseSlot();
      return;
    }
    if (_cgOiCircuitBroken()) {
      if (scheduleRank(sym) === 0) await waitForBreakerEnd();
      else {
        recordCgSkip(sym, OI_TRACE_ENDPOINT, "breaker_skip");
        results.set(sym, { ...emptyResult, unavailableReason: "breaker_skip" });
        releaseSlot();
        return;
      }
    }

    const gap = lastStartAt + MIN_SLOT_DELAY_MS - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    if (signal?.aborted) {
      results.set(sym, emptyResult);
      releaseSlot();
      return;
    }
    lastStartAt = Date.now();

    try {
      const val = await getCoinglassOI(sym, priceMap?.get(sym), signal);
      results.set(sym, val);
      // A scanner deadline/lease cancellation is local control flow, not
      // evidence that CoinGlass is unavailable. Never let it poison the
      // process-wide breaker for the next owned scan.
      if (signal?.aborted) return;
      // Only actual upstream failures advance the breaker. Unsupported symbols,
      // valid empty responses, and ticker collisions are coverage outcomes.
      if (!val.available && _cgOiIsBreakerFailure(val.unavailableReason)) {
        _cgOiBatchConsecFailures++;
        if (
          _cgOiBatchConsecFailures >= CG_OI_CB_THRESHOLD &&
          !_cgOiCircuitBroken()
        ) {
          _cgOiBatchCircuitBrokenUntil = Date.now() + CG_OI_CB_COOLDOWN_MS;
          _cgOiBreakerTrips++;
          logger.warn(
            {
              consecutiveFailures: _cgOiBatchConsecFailures,
              pending: waiting.length,
              cooldownSec: CG_OI_CB_COOLDOWN_MS / 1000,
            },
            "CoinGlass OI batch CB сработал — timeout/HTTP/429, пропускаем остаток (3 мин cooldown)",
          );
        }
      } else {
        _cgOiBatchConsecFailures = 0;
      }
    } catch {
      results.set(sym, emptyResult);
      if (signal?.aborted) return;
      // getCoinglassOI classifies transport failures itself. An unexpected
      // local exception is not sufficient evidence to open the global breaker.
    } finally {
      releaseSlot();
    }
  }

  await Promise.all(toFetch.map((sym) => fetchOne(sym)));
  // Snapshot mode: history only supplements the snapshot result. Whatever
  // happened to the history fetch, the current OI stays the snapshot's.
  if (pinned) {
    for (const [sym, base] of snapshotBase) {
      const h = results.get(sym);
      if (h?.available && h.prevOi30m != null) {
        callStat.history.merged++;
        results.set(sym, {
          ...base,
          prevOi30m: h.prevOi30m,
          positiveCandles6h: h.positiveCandles6h,
          oiConsecutiveUp: h.oiConsecutiveUp,
          oi4hConsecFromOhlc: h.oi4hConsecFromOhlc,
        });
      } else {
        callStat.history.missing++;
        results.set(sym, { ...base, historyMissing: true });
      }
    }
  }
  // Trace the final OI outcome of symbols with qualified/firing arms (records
  // only traced symbols): why a null reached the gates.
  for (const sym of bingxSymbols) {
    const r = results.get(sym);
    if (!r) recordCgSkip(sym, OI_TRACE_ENDPOINT, "not_requested");
    else if (!r.available) {
      const why = r.unavailableReason;
      recordCgSkip(
        sym,
        OI_TRACE_ENDPOINT,
        why === "unsupported"
          ? "mapping_unsupported"
          : why === "collision"
            ? "collision"
            : !why && signal?.aborted
              ? "deadline_or_abort"
              : why === "breaker_skip"
                ? "breaker_skip_final"
                : `oi_${why ?? "unavailable"}`,
      );
    }
  }
  const reasonCounts: Partial<Record<CoinglassOIUnavailableReason, number>> =
    {};
  for (const result of results.values()) {
    if (!result.available && result.unavailableReason) {
      const reason = result.unavailableReason;
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  if (Object.keys(reasonCounts).length > 0) {
    logger.info(
      {
        requested: bingxSymbols.length,
        unavailableReasons: reasonCounts,
        consecutiveUpstreamFailures: _cgOiBatchConsecFailures,
        breakerOpen: _cgOiCircuitBroken(),
      },
      "CoinGlass OI batch coverage summary",
    );
  }
  return results;
}

/** Сброс кэша для тестов */
export function clearCoinglassOICache(): void {
  cache.clear();
}

/** Test-only reset for deterministic coverage of the batch circuit breaker. */
export function resetCoinglassOiStateForTests(): void {
  cache.clear();
  _cgOiBatchConsecFailures = 0;
  _cgOiBatchCircuitBrokenUntil = 0;
  _cgSupportedCoins = null;
  _cgSupportedCoinsTs = 0;
}

/** Test-only whitelist injection; production always uses refreshCgSupportedCoins. */
export function setCgSupportedCoinsForTests(coins: readonly string[]): void {
  _cgSupportedCoins = new Set(coins);
  _cgSupportedCoinsTs = Date.now();
}

// ── CG Supported Futures Coins whitelist ──────────────────────────────────────
// GET /api/futures/supported-coins → ["BTC","ETH","SOL",...]
// Используется как ЕДИНСТВЕННЫЙ источник истины для определения наличия токена в CG.
// Заменяет эвристику cgNoDataCount >= 3 как механизм классификации.
let _cgSupportedCoins: Set<string> | null = null;
let _cgSupportedCoinsTs = 0;
let _cgInvalidKeyWarnedAt = 0;
// Refreshed every 12h; a 24h TTL leaves room for one failed refresh.
const CG_SUPPORTED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Загружает список всех фьючерсных монет, покрытых CoinGlass.
 * Вызывается при старте и раз в 12 часов.
 * Fail-open: при ошибке оставляет старый список (или null если первый запуск).
 */
export async function refreshCgSupportedCoins(): Promise<void> {
  const key = getNextCgKey();
  if (!key) return;
  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/futures/supported-coins",
      {
        headers: { "CG-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
      { priority: "critical", endpoint: "futures/supported-coins" },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "CG supported-coins: HTTP error");
      return;
    }
    const json = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: string[];
    };
    if (
      json.code !== "0" ||
      !Array.isArray(json.data) ||
      json.data.length === 0
    ) {
      logger.warn(
        { code: json.code, msg: json.msg, len: json.data?.length ?? 0 },
        "CG supported-coins: unexpected response",
      );
      return;
    }
    _cgSupportedCoins = new Set(json.data);
    _cgSupportedCoinsTs = Date.now();
    logger.info(
      { count: _cgSupportedCoins.size },
      "CoinGlass: supported-coins whitelist обновлён",
    );
  } catch (err) {
    logger.warn(
      { err },
      "CoinGlass: не удалось обновить supported-coins whitelist (non-critical)",
    );
  }
}

/**
 * Возвращает Set базовых символов, которые CoinGlass точно покрывает.
 * null = список ещё не загружен (используй cgNoDataCount как fallback).
 * Стале через 12ч → возвращает null (фоновый refresh должен обновить).
 */
export function getCgSupportedCoinsSet(): Set<string> | null {
  if (!_cgSupportedCoins) return null;
  if (Date.now() - _cgSupportedCoinsTs > CG_SUPPORTED_CACHE_TTL_MS) return null;
  return _cgSupportedCoins;
}
