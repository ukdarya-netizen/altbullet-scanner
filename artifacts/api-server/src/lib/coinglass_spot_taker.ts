/**
 * CoinGlass — Spot Taker Buy/Sell Flow.
 *
 * Запрашивает объём агрессивных покупок/продаж на спот-рынке.
 * Используется ТОЛЬКО для отображения на дашборде (prescan/OI Watch).
 * НЕ используется в логике паттернов.
 *
 * Endpoint: GET /api/spot/taker-buy-sell-volume/history
 *   ?symbol=<symbol>&exchange=<name>&interval=15m&limit=4
 * Header: CG-API-KEY: <key>
 *
 * Стратегия:
 *   1. Binance spot (покрывает все mainstream токены, symbol: BTCUSDT без дефиса)
 *   2. Fallback BingX spot если Binance вернул пустой массив (symbol: BTC-USDT с дефисом)
 *
 * Кэш: 2 мин (dashboard-only, не критичный путь).
 */

import { getAllSpotExchanges } from "./coinglass-exchanges.js";
import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

export interface SpotTakerResult {
  available: boolean;
  netBuyPct: number | null; // (buy-sell)/(buy+sell)*100 последней свечи
  netBuyPctShort: number | null; // то же за последнюю свечу (синоним netBuyPct)
  netBuyPctMed: number | null; // среднее за последние 3 свечи (~30m окно)
  /** Агрегат за последние 4 свечи (4 × 15m = 1h). */
  takerNetBuy1h: number | null;
  /** Агрегат за последние 16 свечей (4h). null если limit < 16. */
  takerNetBuy4h: number | null;
  /** Агрегат за последние 96 свечей (24h). null если limit < 96. */
  takerNetBuy24h: number | null;
  dominance: "buy" | "sell" | "neutral" | null;
  cvdShort: boolean | null; // последняя свеча net buy > 0
  exchange: "aggregated" | null;
}

const CACHE_TTL = 2 * 60 * 1000; // 2 мин

const cache = new Map<string, { result: SpotTakerResult; ts: number }>();

const NO_DATA: SpotTakerResult = {
  available: false,
  netBuyPct: null,
  netBuyPctShort: null,
  netBuyPctMed: null,
  takerNetBuy1h: null,
  takerNetBuy4h: null,
  takerNetBuy24h: null,
  dominance: null,
  cvdShort: null,
  exchange: null,
};

/** Aggregated multi-exchange spot set (same as aggregated spot CVD). */

interface SpotCandle {
  time: number;
  taker_buy_volume_usd: number | string;
  taker_sell_volume_usd: number | string;
}

async function fetchAggSpotTaker(
  bingxSymbol: string,
  apiKey: string,
  limit: number = 4,
): Promise<SpotCandle[] | null> {
  const base = bingxSymbol.replace(/-?USDT$/i, "").toUpperCase();
  const url = new URL(
    "https://open-api-v4.coinglass.com/api/spot/aggregated-taker-buy-sell-volume/history",
  );
  url.searchParams.set("symbol", base);
  url.searchParams.set("exchange_list", getAllSpotExchanges());
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", String(limit));

  try {
    const res = await cgTimedFetch(url.toString(), {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });

    if (res.status === 429) {
      logCg429(apiKey, { symbol: base });
      reportApiFailure("coinglass", 429);
      return null;
    }
    if (!res.ok) return null;

    const data = (await res.json()) as {
      code: string;
      data?: {
        time: number;
        aggregated_buy_volume_usd: number | string;
        aggregated_sell_volume_usd: number | string;
      }[];
    };
    if (data.code !== "0") return null;
    if (!data.data?.length) return null;

    reportApiSuccess("coinglass");
    return data.data.map((r) => ({
      time: r.time,
      taker_buy_volume_usd: r.aggregated_buy_volume_usd,
      taker_sell_volume_usd: r.aggregated_sell_volume_usd,
    }));
  } catch {
    return null;
  }
}

/** Агрегирует net-buy % по срезу свечей. Возвращает null если срез пустой. */
function aggregate(slice: SpotCandle[]): number | null {
  if (!slice.length) return null;
  let buy = 0,
    sell = 0;
  for (const c of slice) {
    buy += Number(c.taker_buy_volume_usd);
    sell += Number(c.taker_sell_volume_usd);
  }
  const total = buy + sell;
  return total > 0 ? ((buy - sell) / total) * 100 : null;
}

function buildResult(
  candles: SpotCandle[],
  exchange: "aggregated",
): SpotTakerResult {
  if (!candles.length) return NO_DATA;

  // Берём последние 3 свечи для med-window агрегата, последнюю — для short
  const last = candles[candles.length - 1];
  const window3 = candles.slice(-3);

  const buyLast = Number(last.taker_buy_volume_usd);
  const sellLast = Number(last.taker_sell_volume_usd);
  const totalLast = buyLast + sellLast;

  const netBuyPctShort =
    totalLast > 0 ? ((buyLast - sellLast) / totalLast) * 100 : null;

  const netBuyPctMed = aggregate(window3);

  // Срезы по TF — независимо от реального limit запроса.
  // Если свечей меньше 16 / 96 — возвращаем null (нечестно усреднять неполный период).
  const takerNetBuy1h = aggregate(candles.slice(-4));
  const takerNetBuy4h =
    candles.length >= 16 ? aggregate(candles.slice(-16)) : null;
  const takerNetBuy24h =
    candles.length >= 96 ? aggregate(candles.slice(-96)) : null;

  const netBuyPct = netBuyPctShort;
  const cvdShort = netBuyPctShort != null ? netBuyPctShort > 0 : null;

  const dominance: SpotTakerResult["dominance"] =
    netBuyPct == null
      ? null
      : netBuyPct > 2
        ? "buy"
        : netBuyPct < -2
          ? "sell"
          : "neutral";

  return {
    available: true,
    netBuyPct,
    netBuyPctShort,
    netBuyPctMed,
    takerNetBuy1h,
    takerNetBuy4h,
    takerNetBuy24h,
    dominance,
    cvdShort,
    exchange,
  };
}

/**
 * Возвращает спот-тейкер Buy/Sell flow для токена.
 * Только агрегат по нескольким биржам; без запасных источников.
 * Кэш 2 минуты (отдельный по limit, чтобы dashboard и fire-path не конфликтовали).
 *
 * @param limit  Количество 15m-свечей. 4=1h (дашборд), 96=24h (fire path — даёт 1h/4h/24h).
 */
export async function getSpotTakerFlow(
  bingxSymbol: string,
  limit: number = 4,
): Promise<SpotTakerResult> {
  const cacheKey = `${bingxSymbol}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const apiKey = getNextCgKey();
  if (!apiKey) return NO_DATA;

  const candles = await fetchAggSpotTaker(bingxSymbol, apiKey, limit);
  if (candles && candles.length > 0) {
    const result = buildResult(candles, "aggregated");
    cache.set(cacheKey, { result, ts: Date.now() });
    return result;
  }

  // Не нашли данных — кэшируем NO_DATA на короткое время (30с)
  cache.set(cacheKey, {
    result: NO_DATA,
    ts: Date.now() - CACHE_TTL + 30_000,
  });
  logger.debug(
    { symbol: bingxSymbol },
    "SpotTaker: агрегированные данные недоступны",
  );
  return NO_DATA;
}

/** Aggregated spot taker 15m history (oldest → newest) for backfills. */
export async function getAggSpotTakerHistory(
  bingxSymbol: string,
  limit: number,
): Promise<{ time: number; buy: number; sell: number }[] | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  const rows = await fetchAggSpotTaker(bingxSymbol, apiKey, limit);
  return (
    rows?.map((r) => ({
      time: r.time,
      buy: Number(r.taker_buy_volume_usd) || 0,
      sell: Number(r.taker_sell_volume_usd) || 0,
    })) ?? null
  );
}
