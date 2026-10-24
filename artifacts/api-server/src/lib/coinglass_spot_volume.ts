/**
 * CoinGlass — Spot Volume aggregated via pairs-markets.
 *
 * Endpoint: GET /api/spot/pairs-markets?symbol=BTC (WITHOUT -USDT suffix)
 * Returns per-exchange buy/sell volume for 1h, 4h, 24h windows.
 *
 * Aggregation: sum across all exchanges in the response data[].
 * Cache: 5 minutes (data updates infrequently, dashboard-only).
 *
 * Rate limiting: max 10 concurrent requests (batch not supported by API —
 * ?symbol=BTC,ETH returns 500; no-symbol returns 400 "symbol required").
 */

import { applyCgAlias } from "./cg-symbol-alias.js";
import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import type { CoinglassPriority } from "./coinglass_governor.js";

export interface SpotVolumeResult {
  available: boolean;
  volumeUsd1h: number | null;
  buyVolumeUsd1h: number | null;
  sellVolumeUsd1h: number | null;
  netFlowUsd1h: number | null;
  netBuyPct1h: number | null; // (buy-sell)/(buy+sell)*100
  volumeUsd4h: number | null;
  netBuyPct4h: number | null;
  volumeUsd24h: number | null;
  exchanges: string[];
}

const CACHE_TTL = 15 * 60 * 1000; // 15 min: dashboard enrichment does not need churn
const cache = new Map<string, { result: SpotVolumeResult; ts: number }>();

/**
 * Per-exchange 1h spot volume (USD) keyed by lowercased exchange name.
 * Populated alongside `cache` on every successful pairs-markets fetch.
 * Used by scanner cross-vol confirmation to replicate ≥2-exchange × ≥1.5x semantics
 * without 4 per-symbol direct exchange API calls.
 */
const perExchangeCache = new Map<
  string,
  { data: Record<string, number>; ts: number }
>();

/**
 * Synchronous getter for per-exchange 1h spot volume.
 * Returns a map of lowercased exchange name → totalVolumeUsd1h, or null if not yet cached.
 * Call getSpotVolume() first (or pre-warm it) so the cache is populated.
 */
export function getSpotVolumeExchangeData(
  bingxSymbol: string,
): Record<string, number> | null {
  const entry = perExchangeCache.get(bingxSymbol);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

/** Символы, для которых CoinGlass вернул "не найдено" (code=500).
 *  Кэшируются на 24ч — повторные запросы бессмысленны, токен не появится за цикл. */
const NEGATIVE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
const negativeCache = new Map<string, number>(); // symbol → expiry timestamp

const NO_DATA: SpotVolumeResult = {
  available: false,
  volumeUsd1h: null,
  buyVolumeUsd1h: null,
  sellVolumeUsd1h: null,
  netFlowUsd1h: null,
  netBuyPct1h: null,
  volumeUsd4h: null,
  netBuyPct4h: null,
  volumeUsd24h: null,
  exchanges: [],
};

// ── Concurrency limiter (max 10 parallel requests) ────────────────────────────
// CoinGlass batch endpoint not supported: ?symbol=A,B → 500; no symbol → 400.
const MAX_CONCURRENT = 10;
let activeRequests = 0;
const semaphoreQueue: Array<() => void> = [];

function acquireSemaphore(): Promise<void> {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
    } else {
      semaphoreQueue.push(() => {
        activeRequests++;
        resolve();
      });
    }
  });
}

function releaseSemaphore(): void {
  activeRequests--;
  if (semaphoreQueue.length > 0) {
    const next = semaphoreQueue.shift()!;
    next();
  }
}

interface PairsMarketsRow {
  exchange_name?: string;
  exchange?: string;
  buy_volume_usd_1h?: number | string | null;
  sell_volume_usd_1h?: number | string | null;
  net_flows_usd_1h?: number | string | null;
  buy_volume_usd_4h?: number | string | null;
  sell_volume_usd_4h?: number | string | null;
  net_flows_usd_4h?: number | string | null;
  volume_usd_24h?: number | string | null;
}

function toSpotSymbol(bingxSymbol: string): string {
  // BTC-USDT → BTC; strip suffix
  const base = applyCgAlias(bingxSymbol.replace(/-USDT$/, ""));
  // BingX использует множитель-префиксы для дешёвых токенов (1000PEPE, 1000000MOG, 10000SATS, …),
  // но на споте CoinGlass (и большинстве бирж) эти токены торгуются под "голым" тикером без префикса.
  // Без этой очистки toSpotSymbol("1000000MOG-USDT") → "1000000MOG", CoinGlass symbol=1000000MOG
  // не находит пару → getSpotVolume всегда возвращает NO_DATA для всех multiplier-токенов.
  return base.replace(/^(1000000|100000|10000|1000)(?=[A-Z])/, "");
}

/**
 * Fetch and aggregate spot volume for a BingX-format symbol (e.g. "BTC-USDT").
 * Result is cached 5 minutes per symbol.
 * Max 10 concurrent requests enforced via semaphore.
 */
export async function getSpotVolume(
  bingxSymbol: string,
  options: { priority?: CoinglassPriority } = {},
): Promise<SpotVolumeResult> {
  const negExpiry = negativeCache.get(bingxSymbol);
  if (negExpiry && Date.now() < negExpiry) return NO_DATA;

  const cached = cache.get(bingxSymbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const apiKey = getNextCgKey();
  if (!apiKey) return NO_DATA;

  const symbol = toSpotSymbol(bingxSymbol);
  const url = new URL(
    "https://open-api-v4.coinglass.com/api/spot/pairs-markets",
  );
  url.searchParams.set("symbol", symbol);

  await acquireSemaphore();
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
      { priority: options.priority, endpoint: "spot/pairs-markets" },
    );

    if (res.status === 429) {
      logCg429(apiKey, { symbol, endpoint: "pairs-markets" });
      reportApiFailure("coinglass", 429);
      return NO_DATA;
    }
    if (res.status === 404 || !res.ok) {
      logger.warn(
        { symbol, status: res.status, endpoint: "pairs-markets" },
        "CoinGlass SpotVol: non-OK response",
      );
      return NO_DATA;
    }

    const body = (await res.json()) as {
      code: string;
      msg?: string;
      data?: PairsMarketsRow[];
    };
    if (body.code !== "0") {
      if (body.code === "500") {
        negativeCache.set(bingxSymbol, Date.now() + NEGATIVE_CACHE_TTL);
        logger.debug(
          { symbol, endpoint: "pairs-markets" },
          "CoinGlass SpotVol: символ не найден (code=500) — кэшируем на 24ч",
        );
      } else {
        logger.warn(
          { symbol, code: body.code, msg: body.msg, endpoint: "pairs-markets" },
          "CoinGlass SpotVol: API error",
        );
      }
      return NO_DATA;
    }
    if (!body.data?.length) return NO_DATA;

    reportApiSuccess("coinglass");

    // Aggregate across all exchanges + build per-exchange map for cross-vol confirmation
    let buy1h = 0,
      sell1h = 0,
      net1h = 0;
    let buy4h = 0,
      sell4h = 0;
    let vol24h = 0;
    const exchanges: string[] = [];
    const perExchangeData: Record<string, number> = {};

    for (const row of body.data) {
      const name = row.exchange_name ?? row.exchange ?? "";
      if (name) exchanges.push(name);

      const rowBuy1h = Number(row.buy_volume_usd_1h ?? 0);
      const rowSell1h = Number(row.sell_volume_usd_1h ?? 0);
      buy1h += rowBuy1h;
      sell1h += rowSell1h;
      net1h += Number(row.net_flows_usd_1h ?? 0);
      buy4h += Number(row.buy_volume_usd_4h ?? 0);
      sell4h += Number(row.sell_volume_usd_4h ?? 0);
      vol24h += Number(row.volume_usd_24h ?? 0);

      // Per-exchange: normalize name to lowercase for lookup by scanner
      if (name) {
        const key = name.toLowerCase();
        perExchangeData[key] =
          (perExchangeData[key] ?? 0) + rowBuy1h + rowSell1h;
      }
    }

    const total1h = buy1h + sell1h;
    const total4h = buy4h + sell4h;

    const result: SpotVolumeResult = {
      available: true,
      volumeUsd1h: total1h > 0 ? total1h : null,
      buyVolumeUsd1h: buy1h > 0 ? buy1h : null,
      sellVolumeUsd1h: sell1h > 0 ? sell1h : null,
      netFlowUsd1h: net1h,
      netBuyPct1h: total1h > 0 ? ((buy1h - sell1h) / total1h) * 100 : null,
      volumeUsd4h: total4h > 0 ? total4h : null,
      netBuyPct4h: total4h > 0 ? ((buy4h - sell4h) / total4h) * 100 : null,
      volumeUsd24h: vol24h > 0 ? vol24h : null,
      exchanges,
    };

    cache.set(bingxSymbol, { result, ts: Date.now() });
    perExchangeCache.set(bingxSymbol, {
      data: perExchangeData,
      ts: Date.now(),
    });
    return result;
  } catch {
    logger.debug({ symbol }, "SpotVolume: fetch error");
    return NO_DATA;
  } finally {
    releaseSemaphore();
  }
}
