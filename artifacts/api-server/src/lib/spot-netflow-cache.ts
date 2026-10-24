/**
 * Spot NetFlow Cache — batch fetch /api/spot/netflow-list every 5 min.
 *
 * Fetches 3 pages × 200 symbols = up to 600 top coins from CoinGlass.
 * Returns net flow as % of total taker volume for 1h / 4h / 24h / 7d.
 *
 * Symbol key: CoinGlass base ticker (e.g. "BTC", "ETH", "PEPE").
 * BingX "1000PEPE-USDT" → "PEPE", "BTC-USDT" → "BTC".
 */

import { getAllSpotExchanges } from "./coinglass-exchanges.js";
import { logger } from "./logger.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import {
  isMarketCycleLeaseBusy,
  withMarketCycleLease,
} from "./schedulerLease.js";
import { runWhenMarketCycleIdle } from "./market-job-guard.js";

const CACHE_MS = 5 * 60 * 1000; // 5 min refresh
const PAGES = 3; // 3 × 200 = 600 symbols

// ── Per-symbol supplement ─────────────────────────────────────────────────────
// Для символов не попавших в top-600 batch — тихий per-symbol фетч.
// Ключ — BingX символ (BTC-USDT). TTL совпадает с batch TTL.
const _perSymbolMap = new Map<
  string,
  { entry: SpotNetflowEntry; ts: number }
>();
// Очередь символов для supplement-фетча; пополняется при fire сигналов.
const _supplementQueue = new Set<string>();

/** Регистрирует BingX-символ для supplement-фетча после следующего batch-обновления. */
export function registerSnfSymbol(bingxSymbol: string): void {
  _supplementQueue.add(bingxSymbol);
}

export interface SpotNetflowEntry {
  netPct1h: number | null;
  netPct4h: number | null;
  netPct24h: number | null;
  netPct7d: number | null;
}

interface RawRow {
  symbol: string;
  taker_buy_volume_usd_1h: number;
  taker_sell_volume_usd_1h: number;
  net_flow_usd_1h: number;
  taker_buy_volume_usd_4h: number;
  taker_sell_volume_usd_4h: number;
  net_flow_usd_4h: number;
  taker_buy_volume_usd_24h: number;
  taker_sell_volume_usd_24h: number;
  net_flow_usd_24h: number;
  taker_buy_volume_usd_7d: number;
  taker_sell_volume_usd_7d: number;
  net_flow_usd_7d: number;
}

let _cache: Map<string, SpotNetflowEntry> = new Map();
let _cacheTs = 0;
let _inFlight: Promise<void> | null = null;

function pct(net: number, buy: number, sell: number): number | null {
  const total = buy + sell;
  if (!total) return null;
  return (net / total) * 100;
}

// EXCHANGES для coin/netflow: агрегат по ключевым биржам

interface CoinNetflowData {
  taker_buy_volume_usd_1h: number | string;
  taker_sell_volume_usd_1h: number | string;
  net_flow_usd_1h: number | string;
  taker_buy_volume_usd_4h: number | string;
  taker_sell_volume_usd_4h: number | string;
  net_flow_usd_4h: number | string;
  taker_buy_volume_usd_24h: number | string;
  taker_sell_volume_usd_24h: number | string;
  net_flow_usd_24h: number | string;
  taker_buy_volume_usd_7d: number | string;
  taker_sell_volume_usd_7d: number | string;
  net_flow_usd_7d: number | string;
}

function n(v: number | string | undefined): number {
  return v == null ? 0 : Number(v);
}

function netPctFrom(
  netFlow: number | string,
  buy: number | string,
  sell: number | string,
): number | null {
  const net = n(netFlow);
  const total = n(buy) + n(sell);
  if (!total) return null;
  return (net / total) * 100;
}

/**
 * Фетч per-symbol spot netflow через /api/spot/coin/netflow.
 * Возвращает multi-TF netflow напрямую (без вычисления из свечей).
 * Включает 7d которого не было при candle-подходе.
 */
async function fetchPerSymbol(bingxSymbol: string): Promise<void> {
  const cached = _perSymbolMap.get(bingxSymbol);
  if (cached && Date.now() - cached.ts < CACHE_MS) return; // свежий

  const apiKey = getNextCgKey();
  if (!apiKey) return;

  const cgBase = bingxToCg(bingxSymbol); // "BTC-USDT" → "BTC"

  try {
    const url =
      `https://open-api-v4.coinglass.com/api/spot/coin/netflow` +
      `?symbol=${encodeURIComponent(cgBase)}&exchange_list=${encodeURIComponent(getAllSpotExchanges())}`;
    const res = await cgTimedFetch(url, {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json()) as {
      code: string;
      data?: CoinNetflowData;
    };
    if (d.code !== "0" || !d.data) throw new Error(`code=${d.code}`);

    const r = d.data;
    _perSymbolMap.set(bingxSymbol, {
      entry: {
        netPct1h: netPctFrom(
          r.net_flow_usd_1h,
          r.taker_buy_volume_usd_1h,
          r.taker_sell_volume_usd_1h,
        ),
        netPct4h: netPctFrom(
          r.net_flow_usd_4h,
          r.taker_buy_volume_usd_4h,
          r.taker_sell_volume_usd_4h,
        ),
        netPct24h: netPctFrom(
          r.net_flow_usd_24h,
          r.taker_buy_volume_usd_24h,
          r.taker_sell_volume_usd_24h,
        ),
        netPct7d: netPctFrom(
          r.net_flow_usd_7d,
          r.taker_buy_volume_usd_7d,
          r.taker_sell_volume_usd_7d,
        ),
      },
      ts: Date.now(),
    });
    return;
  } catch {
    // Записываем пустой с коротким TTL (30s), чтобы не спамить
    _perSymbolMap.set(bingxSymbol, {
      entry: {
        netPct1h: null,
        netPct4h: null,
        netPct24h: null,
        netPct7d: null,
      },
      ts: Date.now() - CACHE_MS + 30_000,
    });
  }
}

async function fetchAndRefresh(): Promise<void> {
  const map = new Map<string, SpotNetflowEntry>();

  outer: for (let page = 1; page <= PAGES; page++) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const apiKey = getNextCgKey();
      if (!apiKey) break outer;

      try {
        const url = `https://open-api-v4.coinglass.com/api/spot/netflow-list?per_page=200&page=${page}`;
        const res = await cgTimedFetch(url, {
          headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          // HTTP errors (4xx/5xx) не лечатся ретраем — выходим сразу
          logger.warn(
            { status: res.status, page },
            "SpotNetflowCache: HTTP error",
          );
          break outer;
        }

        const d = (await res.json()) as { code: string; data?: RawRow[] };
        if (d.code !== "0" || !d.data?.length) break outer;

        for (const row of d.data) {
          map.set(row.symbol.toUpperCase(), {
            netPct1h: pct(
              row.net_flow_usd_1h,
              row.taker_buy_volume_usd_1h,
              row.taker_sell_volume_usd_1h,
            ),
            netPct4h: pct(
              row.net_flow_usd_4h,
              row.taker_buy_volume_usd_4h,
              row.taker_sell_volume_usd_4h,
            ),
            netPct24h: pct(
              row.net_flow_usd_24h,
              row.taker_buy_volume_usd_24h,
              row.taker_sell_volume_usd_24h,
            ),
            netPct7d: pct(
              row.net_flow_usd_7d,
              row.taker_buy_volume_usd_7d,
              row.taker_sell_volume_usd_7d,
            ),
          });
        }

        if (d.data.length < 200) break outer; // последняя страница
        break; // страница загружена — переходим к следующей
      } catch (err) {
        if (attempt < 2) {
          logger.warn(
            { page, attempt },
            "SpotNetflowCache: fetch error — retrying with next key",
          );
          await new Promise((r) => setTimeout(r, 400));
        } else {
          logger.warn(
            { page, err },
            "SpotNetflowCache: fetch error after retry — aborting",
          );
          break outer;
        }
      }
    }
  }

  if (map.size > 0) {
    _cache = map;
    _cacheTs = Date.now();
    logger.info({ count: map.size }, "SpotNetflowCache: refreshed");
  }

  // ── Supplement: per-symbol fetch для символов не попавших в batch ────────────
  if (_supplementQueue.size > 0) {
    const cgBase = (s: string) => {
      const b = s.replace("-USDT", "");
      return /^1000[A-Z]/.test(b) ? b.slice(4) : b;
    };
    const missing: string[] = [];
    for (const sym of _supplementQueue) {
      if (!map.has(cgBase(sym).toUpperCase())) missing.push(sym);
    }
    if (missing.length > 0) {
      logger.debug(
        { count: missing.length },
        "SpotNetflowCache: supplement per-symbol fetch",
      );
      // Батчами по 5 с небольшой задержкой — не перегружаем CG API
      for (let i = 0; i < missing.length; i += 5) {
        await Promise.all(missing.slice(i, i + 5).map(fetchPerSymbol));
        if (i + 5 < missing.length)
          await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

/** BingX "BTC-USDT" → "BTC", "1000PEPE-USDT" → "PEPE" */
export function bingxToCg(bingxSymbol: string): string {
  const base = bingxSymbol.replace("-USDT", "");
  return /^1000[A-Z]/.test(base) ? base.slice(4) : base;
}

export function getSpotNetflowEntry(
  bingxSymbol: string,
): SpotNetflowEntry | null {
  return getSpotNetflowSnapshot(bingxSymbol)?.entry ?? null;
}

/** A fresh, time-stamped cache value suitable for forward-only observations. */
export function getSpotNetflowSnapshot(bingxSymbol: string): {
  entry: SpotNetflowEntry;
  fetchedAt: Date;
  source: "coinglass_spot_netflow_list" | "coinglass_spot_coin_netflow";
} | null {
  const now = Date.now();
  const batch =
    now - _cacheTs < CACHE_MS
      ? _cache.get(bingxToCg(bingxSymbol).toUpperCase())
      : undefined;
  if (batch)
    return {
      entry: batch,
      fetchedAt: new Date(_cacheTs),
      source: "coinglass_spot_netflow_list",
    };

  const supplement = _perSymbolMap.get(bingxSymbol);
  return supplement && now - supplement.ts < CACHE_MS
    ? {
        entry: supplement.entry,
        fetchedAt: new Date(supplement.ts),
        source: "coinglass_spot_coin_netflow",
      }
    : null;
}

export function getAllSpotNetflow(): Record<string, SpotNetflowEntry> {
  // Merge: per-symbol под ключом CG-base (для UI snfMap)
  const out: Record<string, SpotNetflowEntry> = Object.fromEntries(_cache);
  for (const [bingxSym, { entry }] of _perSymbolMap) {
    const cgKey = bingxToCg(bingxSym).toUpperCase();
    if (!out[cgKey]) out[cgKey] = entry; // batch имеет приоритет
  }
  return out;
}

export function getCacheUpdatedAt(): number {
  return _cacheTs;
}

export async function ensureSpotNetflowFresh(): Promise<void> {
  if (Date.now() - _cacheTs < CACHE_MS) return;
  if (!_inFlight) {
    _inFlight = fetchAndRefresh().finally(() => {
      _inFlight = null;
    });
  }
  await _inFlight;
}

/**
 * Makes SNF available for a bounded position list without forcing a new
 * top-600 batch request when that batch is still fresh. Symbols missing from
 * the batch use the existing per-symbol supplement cache.
 */
export async function ensureSpotNetflowForSymbols(
  bingxSymbols: string[],
): Promise<void> {
  await ensureSpotNetflowFresh();
  const missing = [...new Set(bingxSymbols)].filter((symbol) => {
    const batchKey = bingxToCg(symbol).toUpperCase();
    const batchIsFresh =
      _cache.has(batchKey) && Date.now() - _cacheTs < CACHE_MS;
    const supplement = _perSymbolMap.get(symbol);
    const supplementIsFresh =
      supplement != null && Date.now() - supplement.ts < CACHE_MS;
    return !batchIsFresh && !supplementIsFresh;
  });
  for (let i = 0; i < missing.length; i += 3) {
    await Promise.all(missing.slice(i, i + 3).map(fetchPerSymbol));
  }
}

export function startSpotNetflowRefresh(): void {
  const runScheduledRefresh = async (): Promise<void> => {
    const outcome = await runWhenMarketCycleIdle(
      isMarketCycleLeaseBusy,
      async () => {
        const result = await withMarketCycleLease(
          "spot-netflow-refresh",
          async (lease) => {
            lease.throwIfLost("spot netflow refresh start");
            await fetchAndRefresh();
            lease.throwIfLost("spot netflow refresh completion");
          },
        );
        if (!result.acquired) {
          logger.debug(
            "SpotNetflowCache: deferred — another market-cycle lease is active",
          );
        }
      },
    );
    if (outcome === "deferred") {
      logger.debug(
        "SpotNetflowCache: deferred — another market-cycle lease is active",
      );
    }
  };

  void runScheduledRefresh().catch((err) =>
    logger.warn({ err }, "SpotNetflowCache: scheduled refresh failed"),
  );
  setInterval(() => {
    if (!_inFlight) {
      void runScheduledRefresh().catch((err) =>
        logger.warn({ err }, "SpotNetflowCache: scheduled refresh failed"),
      );
    }
  }, CACHE_MS);
}
