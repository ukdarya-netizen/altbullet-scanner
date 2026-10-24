/**
 * CoinGlass — кросс-биржевой Taker Buy/Sell Flow.
 *
 * Запрашивает объём агрессивных покупок и продаж за последние 4 свечи по 15m
 * по пяти биржам (Binance + Bybit + OKX + Bitget + BingX) и агрегирует их.
 *
 * Используется как РАННИЙ ПРЕ-ФИЛЬТР (до детекции паттерна):
 * оба цикла должны показывать нетто-покупки (покупки > продажи два периода подряд).
 * Если продавцы доминируют — рост OI скорее всего от шортов, не от покупателей.
 *
 * Endpoint: GET /api/futures/taker-buy-sell-volume/history
 *   ?symbol=<exchange-specific>&exchange=<name>&interval=15m&limit=4
 * Header: CG-API-KEY: <key>
 *
 * Каждая биржа использует свой формат instrument_id в CoinGlass:
 *   Binance / Bybit  → BTCUSDT        (без дефиса)
 *   BingX            → BTC-USDT       (с дефисом — оригинальный BingX формат)
 *   Bitget           → BTCUSDT_UMCBL  (без дефиса + суффикс _UMCBL)
 *   OKX              → BTC-USDT-SWAP  (с дефисом + суффикс -SWAP)
 *
 * План Standard: доступны интервалы 15m, 30m, 1h.
 * Используем 15m — 4 свечи = 1 час истории с детализацией по четвертям.
 * cvdRising2 проверяет что последние 2 свечи (30 мин) показывают устойчивый поток.
 * Кэш: 3 мин (15m свечи обновляются часто, нужна свежесть).
 */

import { applyCgAlias } from "./cg-symbol-alias.js";
import { runWithoutMemo } from "./coinglass-memo.js";
import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

export interface TakerCycle {
  delta: number; // buy - sell (USD)
  netBuyPct: number; // (buy - sell) / (buy + sell) * 100
}

export interface TakerFlowResult {
  buyUsd: number;
  sellUsd: number;
  netBuyPct: number; // (buy - sell) / (buy + sell) * 100 — последний цикл (15m)
  dominance: "buy" | "sell" | "neutral";
  available: boolean;
  exchanges: string[]; // какие биржи ответили
  cycles: TakerCycle[]; // [более старый, более новый] — до 2 элементов
  cvdRising2: boolean; // оба цикла положительные И второй >= 50% первого
  /** Последняя свеча: net buy > 0. null если данные недоступны. */
  cvdShort: boolean | null;
  /**
   * Суммарный netBuyPct за 1 час: (buy1h - sell1h) / (buy1h + sell1h) * 100.
   * Per-symbol: агрегат 4 × 15m свечей. Batch: из netflow-list taker_*_1h напрямую.
   * null если данных нет.
   */
  takerNetBuy1h: number | null;
  /**
   * Суммарный 1h taker объём (buy + sell) по всем кросс-биржевым данным CG.
   * Только batch-mode (netflow-list); per-symbol: null.
   * Используется для кросс-биржевого подтверждения объёма (замена 4 per-exchange API).
   */
  volUsd1h?: number | null;
}

/** Aggregated multi-exchange set; per-exchange fetches are not used anymore. */
/** All supported CoinGlass futures exchanges (28 as of 2026-10-18, auto-refreshed). */
export function getAggFuturesTakerExchanges(): string {
  return getAllFuturesExchanges();
}

import { getAllFuturesExchanges } from "./coinglass-exchanges.js";

const CACHE_TTL = 3 * 60 * 1000; // 3 мин — 15m свечи обновляются часто

const cache = new Map<string, { result: TakerFlowResult; ts: number }>();

interface CgTakerCandle {
  time: number;
  taker_buy_volume_usd: string;
  taker_sell_volume_usd: string;
}

/** Aggregated futures taker candles (oldest → newest); null when unavailable. */
async function fetchAggFuturesTakerCandles(
  bingxSymbol: string,
  apiKey: string,
  limit: number,
  timeoutMs = 6000,
  priority?: "high",
  interval = "15m",
): Promise<CgTakerCandle[] | null> {
  const base = applyCgAlias(bingxSymbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/aggregated-taker-buy-sell-volume/history",
  );
  url.searchParams.set("exchange_list", getAggFuturesTakerExchanges());
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      },
      {
        priority,
        endpoint: "futures/aggregated-taker-buy-sell-volume/history",
      },
    );
    if (res.status === 429) {
      logCg429(apiKey, { symbol: base });
      reportApiFailure("coinglass", 429);
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as {
      code?: string;
      data?: {
        time: number;
        aggregated_buy_volume_usd: unknown;
        aggregated_sell_volume_usd: unknown;
      }[];
    };
    if (body.code !== "0" || !body.data?.length) return null;
    reportApiSuccess("coinglass");
    return body.data.map((r) => ({
      time: r.time,
      taker_buy_volume_usd: String(r.aggregated_buy_volume_usd),
      taker_sell_volume_usd: String(r.aggregated_sell_volume_usd),
    }));
  } catch {
    return null;
  }
}

/**
 * Возвращает агрегированный Taker Buy/Sell Flow за последние 2 часа
 * по Binance + Bybit (2 свечи по 1h). Кэшируется 5 мин.
 *
 * cvdRising2 = true если оба часовых периода показывают нетто-покупки
 * И второй (более свежий) не слабее 50% от первого — устойчивый поток, не разовый всплеск.
 */
export async function getCoinglassTakerFlow(
  symbol: string,
): Promise<TakerFlowResult> {
  const apiKey = getNextCgKey();

  const noData: TakerFlowResult = {
    buyUsd: 0,
    sellUsd: 0,
    netBuyPct: 0,
    dominance: "neutral",
    available: false,
    exchanges: [],
    cycles: [],
    cvdRising2: false,
    cvdShort: null,
    takerNetBuy1h: null,
  };

  if (!apiKey) return noData;

  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  // Aggregated 15m candles (4 = 1h) across all exchanges in one request
  const aggCandles = await fetchAggFuturesTakerCandles(symbol, apiKey, 4);
  const candleCount = 4;
  const aggregated: Array<{ buy: number; sell: number }> = Array.from(
    { length: candleCount },
    () => ({ buy: 0, sell: 0 }),
  );
  const responded: string[] = [];
  if (aggCandles && aggCandles.length > 0) {
    responded.push(...getAggFuturesTakerExchanges().split(","));
    const start = Math.max(0, aggCandles.length - candleCount);
    for (let ci = start; ci < aggCandles.length; ci++) {
      const slot = ci - start;
      const c = aggCandles[ci]!;
      aggregated[slot]!.buy += parseFloat(c.taker_buy_volume_usd) || 0;
      aggregated[slot]!.sell += parseFloat(c.taker_sell_volume_usd) || 0;
    }
  }

  if (responded.length === 0) {
    cache.set(symbol, { result: noData, ts: Date.now() });
    return noData;
  }

  // Строим cycles (только те слоты где есть данные)
  const cycles: TakerCycle[] = aggregated
    .filter((a) => a.buy + a.sell > 0)
    .map((a) => {
      const total = a.buy + a.sell;
      const netPct = total > 0 ? ((a.buy - a.sell) / total) * 100 : 0;
      return { delta: a.buy - a.sell, netBuyPct: netPct };
    });

  // Итоговые цифры берём из последней (самой свежей) 15m свечи
  const last = aggregated[aggregated.length - 1]!;
  const total = last.buy + last.sell;
  const netBuyPct = total > 0 ? ((last.buy - last.sell) / total) * 100 : 0;

  const dominance: TakerFlowResult["dominance"] =
    netBuyPct > 2 ? "buy" : netBuyPct < -2 ? "sell" : "neutral";

  // CVD 2-цикла: оба положительные И новый >= 50% от старого (поток устойчив, не ослаб)
  let cvdRising2 = false;
  if (cycles.length >= 2) {
    const older = cycles[cycles.length - 2]!;
    const newer = cycles[cycles.length - 1]!;
    cvdRising2 =
      older.delta > 0 && newer.delta > 0 && newer.delta >= older.delta * 0.5;
  } else if (cycles.length === 1) {
    cvdRising2 = cycles[0]!.delta > 0;
  }

  // cvdShort: последняя 15m свеча — net buy > 0
  const cvdShort: boolean | null =
    last.buy + last.sell > 0 ? last.buy > last.sell : null;

  // 1h aggregate: сумма всех 4 × 15m слотов
  let buy1h = 0,
    sell1h = 0;
  for (const slot of aggregated) {
    buy1h += slot.buy;
    sell1h += slot.sell;
  }
  const total1h = buy1h + sell1h;
  const takerNetBuy1h: number | null =
    total1h > 0 ? ((buy1h - sell1h) / total1h) * 100 : null;

  const result: TakerFlowResult = {
    buyUsd: last.buy,
    sellUsd: last.sell,
    netBuyPct,
    dominance,
    available: true,
    exchanges: responded,
    cycles,
    cvdRising2,
    cvdShort,
    takerNetBuy1h,
  };

  logger.debug(
    {
      symbol,
      netBuyPct: netBuyPct.toFixed(1) + "%",
      dominance,
      cvdRising2,
      cvdShort,
      cycles: cycles.map((c) => `${c.netBuyPct.toFixed(1)}%`).join(" → "),
      exchanges: responded,
    },
    "CoinGlass taker flow (15m × 4 + 5m × 1 candles)",
  );

  cache.set(symbol, { result, ts: Date.now() });
  return result;
}

// ── Netflow-list batch cache ──────────────────────────────────────────────────
// GET /api/futures/netflow-list — один запрос на все ~100 символов.
// Используется как замена per-symbol getCoinglassTakerFlow для токенов из топ-100.
// Сохраняет 10 HTTP-вызовов на символ (5 бирж × 15m + 5m).

interface NetflowItem {
  symbol: string;
  taker_buy_volume_usd_5m: number;
  taker_sell_volume_usd_5m: number;
  taker_buy_volume_usd_15m: number;
  taker_sell_volume_usd_15m: number;
  taker_buy_volume_usd_30m: number;
  taker_sell_volume_usd_30m: number;
  taker_buy_volume_usd_1h: number;
  taker_sell_volume_usd_1h: number;
  net_flow_usd_5m: number;
  net_flow_usd_15m: number;
  net_flow_usd_30m: number;
}

const netflowBatch = new Map<string, TakerFlowResult>();
let netflowBatchTs = 0;
const NETFLOW_BATCH_TTL = 5 * 60 * 1000; // совпадает с TTL per-symbol кэша CG OI

export function isNetflowBatchFresh(
  updatedAt: number,
  now = Date.now(),
): boolean {
  return updatedAt > 0 && now - updatedAt < NETFLOW_BATCH_TTL;
}

function expireNetflowBatchIfStale(now = Date.now()): void {
  if (netflowBatch.size > 0 && !isNetflowBatchFresh(netflowBatchTs, now)) {
    netflowBatch.clear();
    netflowBatchTs = 0;
  }
}

// Телеметрия за текущий скан (сбрасывается resetNetflowTelemetry)
let _batchHits = 0;
let _batchMisses = 0;

export function resetNetflowTelemetry(): void {
  _batchHits = 0;
  _batchMisses = 0;
}

export function getNetflowTelemetry(): {
  hits: number;
  misses: number;
  batchSize: number;
} {
  return {
    hits: _batchHits,
    misses: _batchMisses,
    batchSize: netflowBatch.size,
  };
}

/**
 * Синхронное чтение из netflow batch кэша (без fallback на per-symbol HTTP).
 * Используется в scanner.ts после prefetchNetflowBatch() — batch уже заполнен.
 * bingxSymbol — формат "BTC-USDT".
 */
export function getNetflowBatchEntry(
  bingxSymbol: string,
): TakerFlowResult | undefined {
  expireNetflowBatchIfStale();
  const base = applyCgAlias(bingxSymbol.replace(/-USDT$/i, ""));
  return netflowBatch.get(base);
}

/**
 * Один HTTP-запрос за весь скан — заполняет батч-кэш для ~100 топ-символов.
 * Вызывать в начале performScan() рядом с batchGetCoinglassOI().
 */
export async function prefetchNetflowBatch(): Promise<{ fetched: number }> {
  expireNetflowBatchIfStale();
  const apiKey = getNextCgKey();
  if (!apiKey) return { fetched: 0 };
  if (isNetflowBatchFresh(netflowBatchTs) && netflowBatch.size > 0) {
    return { fetched: netflowBatch.size };
  }

  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/futures/netflow-list",
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        "CoinGlass netflow-list: request failed",
      );
      return { fetched: 0 };
    }
    const data = (await res.json()) as { code: string; data?: NetflowItem[] };
    if (data.code !== "0" || !data.data?.length) {
      logger.warn(
        { code: data.code },
        "CoinGlass netflow-list: unexpected response",
      );
      return { fetched: 0 };
    }

    netflowBatch.clear();
    for (const item of data.data) {
      const buy15 = item.taker_buy_volume_usd_15m;
      const sell15 = item.taker_sell_volume_usd_15m;
      const buy30 = item.taker_buy_volume_usd_30m;
      const sell30 = item.taker_sell_volume_usd_30m;
      const buy5 = item.taker_buy_volume_usd_5m;
      const sell5 = item.taker_sell_volume_usd_5m;
      const buy1h = item.taker_buy_volume_usd_1h;
      const sell1h = item.taker_sell_volume_usd_1h;

      const total15 = buy15 + sell15;
      const netBuyPct = total15 > 0 ? ((buy15 - sell15) / total15) * 100 : 0;

      // Старший 15m-слой = окно 30m минус последние 15m
      const olderBuy = buy30 - buy15;
      const olderSell = sell30 - sell15;
      const olderTotal = olderBuy + olderSell;
      const olderDelta = olderBuy - olderSell;
      const newerDelta = buy15 - sell15;
      const olderNetPct = olderTotal > 0 ? (olderDelta / olderTotal) * 100 : 0;
      const newerNetPct = netBuyPct;

      // cvdRising2: оба 15m-окна в плюсе, новый >= 50% старого — устойчивый поток
      const cvdRising2 =
        olderDelta > 0 && newerDelta > 0 && newerDelta >= olderDelta * 0.5;
      const total5 = buy5 + sell5;
      const cvdShort: boolean | null = total5 > 0 ? buy5 - sell5 > 0 : null;

      const dominance: TakerFlowResult["dominance"] =
        netBuyPct > 2 ? "buy" : netBuyPct < -2 ? "sell" : "neutral";

      const total1h = buy1h + sell1h;
      const takerNetBuy1h: number | null =
        total1h > 0 ? ((buy1h - sell1h) / total1h) * 100 : null;

      netflowBatch.set(item.symbol, {
        buyUsd: buy15,
        sellUsd: sell15,
        netBuyPct,
        dominance,
        available: true,
        exchanges: ["netflow-batch"],
        cycles: [
          { delta: olderDelta, netBuyPct: olderNetPct },
          { delta: newerDelta, netBuyPct: newerNetPct },
        ],
        cvdRising2,
        cvdShort,
        takerNetBuy1h,
        volUsd1h: total1h > 0 ? total1h : null,
      });
    }
    netflowBatchTs = Date.now();
    reportApiSuccess("coinglass");
    logger.info(
      { count: netflowBatch.size },
      "CoinGlass netflow-list: batch fetched",
    );
    return { fetched: netflowBatch.size };
  } catch (err) {
    logger.warn(
      { err },
      "CoinGlass netflow-list: fetch failed, will use per-symbol fallback",
    );
    return { fetched: 0 };
  }
}

/**
 * Замена getCoinglassTakerFlow() с батч-кэшем.
 * Для топ-100 символов (из netflow-list) — 0 HTTP-вызовов.
 * Для остальных — fallback на 10-вызовный per-symbol запрос.
 * bingxSymbol — формат "BTC-USDT".
 */
export async function getTakerFlowCached(
  bingxSymbol: string,
): Promise<TakerFlowResult> {
  expireNetflowBatchIfStale();
  const base = applyCgAlias(
    bingxSymbol.replace("-USDT", "").replace("-USDT", ""),
  );
  const batchHit = netflowBatch.get(base);
  if (batchHit) {
    _batchHits++;
    return batchHit;
  }
  _batchMisses++;
  return getCoinglassTakerFlow(bingxSymbol);
}

/**
 * Aggregated (multi-exchange) futures taker net-buy % of the latest 15m
 * candle: (buy - sell) / (buy + sell) * 100. Same exchange set as the
 * aggregated volume gate. Returns an explicit unavailable result on failure.
 */
const NET_BUY_15M_TTL_MS = 90_000;
const netBuy15mCache = new Map<
  string,
  { ts: number; value: { available: boolean; netBuyPct: number } }
>();

export async function getAggregatedFuturesTakerNetBuyPct15m(
  bingxSymbol: string,
  timeoutMs = 6000,
): Promise<{ available: boolean; netBuyPct: number }> {
  const hit = netBuy15mCache.get(bingxSymbol);
  if (hit && Date.now() - hit.ts < NET_BUY_15M_TTL_MS) return hit.value;
  // The latest (forming) 15m bar is the point of this call: no response memo.
  const value = await runWithoutMemo(() =>
    fetchNetBuyPct15m(bingxSymbol, timeoutMs),
  );
  // Only successful answers are reused; a failure is retried by the next caller.
  if (value.available) {
    if (netBuy15mCache.size > 2000) netBuy15mCache.clear();
    netBuy15mCache.set(bingxSymbol, { ts: Date.now(), value });
  }
  return value;
}

async function fetchNetBuyPct15m(
  bingxSymbol: string,
  timeoutMs: number,
): Promise<{ available: boolean; netBuyPct: number }> {
  const none = { available: false, netBuyPct: 0 };
  const apiKey = getNextCgKey();
  if (!apiKey) return none;
  const candles = await fetchAggFuturesTakerCandles(
    bingxSymbol,
    apiKey,
    2,
    timeoutMs,
    "high",
  );
  const row = candles?.[candles.length - 1];
  if (!row) return none;
  const buy = Number(row.taker_buy_volume_usd);
  const sell = Number(row.taker_sell_volume_usd);
  const total = buy + sell;
  if (!Number.isFinite(total) || total <= 0) return none;
  return { available: true, netBuyPct: ((buy - sell) / total) * 100 };
}

/** Aggregated futures taker 15m history (oldest → newest) for backfills. */
export async function getAggFuturesTakerHistory(
  bingxSymbol: string,
  limit: number,
): Promise<{ time: number; buy: number; sell: number }[] | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  const rows = await fetchAggFuturesTakerCandles(
    bingxSymbol,
    apiKey,
    limit,
    15_000,
  );
  return (
    rows?.map((r) => ({
      time: r.time,
      buy: Number(r.taker_buy_volume_usd) || 0,
      sell: Number(r.taker_sell_volume_usd) || 0,
    })) ?? null
  );
}

const AGG_VOL_SERIES_TTL = 4 * 60_000;
const aggVolSeriesCache = new Map<
  string,
  { ts: number; series: Map<number, number> | null }
>();

/**
 * Aggregated (7-exchange) futures volume in USD per 30m candle, keyed by the
 * 30m candle start (ms), built from 15m taker buy+sell. A candle is included
 * only when both 15m buckets exist; the still-open newest candle may have one.
 * Null when CoinGlass returns nothing. Cached 4 minutes per symbol.
 */
export async function getAggregatedFuturesVolumeSeries30m(
  bingxSymbol: string,
): Promise<Map<number, number> | null> {
  const hit = aggVolSeriesCache.get(bingxSymbol);
  if (hit && Date.now() - hit.ts < AGG_VOL_SERIES_TTL) return hit.series;
  const rows = await getAggFuturesTakerHistory(bingxSymbol, 120);
  let series: Map<number, number> | null = null;
  if (rows && rows.length > 0) {
    const step = 15 * 60_000;
    const half = 30 * 60_000;
    const byTime = new Map(rows.map((r) => [r.time, r.buy + r.sell]));
    series = new Map();
    for (const t of byTime.keys()) {
      const start = Math.floor(t / half) * half;
      if (series.has(start)) continue;
      const first = byTime.get(start);
      const second = byTime.get(start + step);
      const openCandle = start + half > Date.now();
      if (first !== undefined && second !== undefined) {
        series.set(start, first + second);
      } else if (openCandle && (first !== undefined || second !== undefined)) {
        series.set(start, (first ?? 0) + (second ?? 0));
      }
    }
  }
  aggVolSeriesCache.set(bingxSymbol, { ts: Date.now(), series });
  return series;
}

/** Closed 30m candle volume and mean of the 20 preceding 30m candles. */
export async function getAggregatedFuturesVolume30m(
  bingxSymbol: string,
  candleStartMs: number,
): Promise<{ candleVolumeUsd: number; baselineVolumeUsd: number } | null> {
  const series = await getAggregatedFuturesVolumeSeries30m(bingxSymbol);
  if (!series) return null;
  const half = 30 * 60_000;
  const candleVolumeUsd = series.get(candleStartMs);
  if (candleVolumeUsd === undefined) return null;
  let total = 0;
  for (let i = 1; i <= 20; i += 1) {
    const v = series.get(candleStartMs - i * half);
    if (v === undefined) return null;
    total += v;
  }
  return { candleVolumeUsd, baselineVolumeUsd: total / 20 };
}

const INTERVAL_MS = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
} as const;
// Closed bars never change, so a stored series that already holds the latest
// closed bar answers any later request of the same or smaller limit. Bounded by
// total bars to cap memory (4500-bar 1H series are large).
const MAX_CACHED_BARS = 600_000;
const closedVolumeCache = new Map<
  string,
  { limit: number; volumes: Map<number, number> }
>();
let closedVolumeCacheBars = 0;
let closedVolumeCacheHits = 0;

/** Requests answered from the closed-bar cache since the last call. */
export function drainClosedVolumeCacheHits(): number {
  const n = closedVolumeCacheHits;
  closedVolumeCacheHits = 0;
  return n;
}

/** Measured heap cost of one Map<number, number> entry (node, 2026-10). */
const CLOSED_BAR_EST_BYTES = 82;

/** Closed-bar cache footprint: series count, bars, estimated heap bytes. */
export function closedVolumeCacheStats(): {
  entries: number;
  bars: number;
  estBytes: number;
} {
  return {
    entries: closedVolumeCache.size,
    bars: closedVolumeCacheBars,
    estBytes: closedVolumeCacheBars * CLOSED_BAR_EST_BYTES,
  };
}

export function resetClosedVolumeCacheForTests(): void {
  closedVolumeCache.clear();
  closedVolumeCacheBars = 0;
  closedVolumeCacheHits = 0;
}

function storeClosedVolumes(
  key: string,
  limit: number,
  volumes: Map<number, number>,
): void {
  const old = closedVolumeCache.get(key);
  if (old) {
    closedVolumeCacheBars -= old.volumes.size;
    closedVolumeCache.delete(key);
  }
  closedVolumeCache.set(key, { limit, volumes });
  closedVolumeCacheBars += volumes.size;
  for (const [k, v] of closedVolumeCache) {
    if (closedVolumeCacheBars <= MAX_CACHED_BARS) break;
    if (k === key) continue;
    closedVolumeCache.delete(k);
    closedVolumeCacheBars -= v.volumes.size;
  }
}

/**
 * Aggregated futures volume (buy+sell USD) per candle start for `interval`.
 * Closed bars are served from the cache; only the open bar is not guaranteed
 * fresh, and callers look volumes up by closed candle time.
 */
export async function getAggFuturesVolumeByInterval(
  bingxSymbol: string,
  interval: "15m" | "1h" | "4h",
  limit: number,
  nowMs: number = Date.now(),
): Promise<Map<number, number> | null> {
  const cacheKey = `${applyCgAlias(bingxSymbol.replace(/-?USDT$/i, "")).toUpperCase()}|${interval}`;
  const barMs = INTERVAL_MS[interval];
  const latestClosed = Math.floor(nowMs / barMs) * barMs - barMs;
  const hit = closedVolumeCache.get(cacheKey);
  if (hit && hit.limit >= limit && hit.volumes.has(latestClosed)) {
    closedVolumeCacheHits++;
    return hit.volumes;
  }
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  const rows = await fetchAggFuturesTakerCandles(
    bingxSymbol,
    apiKey,
    limit,
    15_000,
    "high",
    interval,
  );
  if (!rows) return null;
  const volumes = new Map(
    rows.map((r) => [
      r.time,
      (Number(r.taker_buy_volume_usd) || 0) +
        (Number(r.taker_sell_volume_usd) || 0),
    ]),
  );
  if (volumes.has(latestClosed)) storeClosedVolumes(cacheKey, limit, volumes);
  return volumes;
}
