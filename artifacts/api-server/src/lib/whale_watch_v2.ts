/**
 * Whale Watch 2.0 — Market Cap cache + weekly report + stale watchlist expiry.
 *
 * Активный сканирующий движок (CVD accumulation → breakout → smart cancel)
 * удалён как мёртвый код (2026-07-10, нет вызовов из scanner.ts/watcher.ts).
 * whale_futures_watchlist — актуальная замена.
 *
 * Market Cap: CoinGecko free API, кэш 24ч.
 * Fallback: если mcap недоступен — используем 24h Vol как прокси (порог от vol).
 */

import { db, marketCapCacheTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { marketFetch } from "./marketRequestBudget.js";
import { isAnalysisBlockedSymbol } from "./excluded-signal-symbols.js";

// ── Параметры ─────────────────────────────────────────────────────────────────
/** Expire watchlist entry after X hours with no accumulation */

// ── Market Cap Cache (per-symbol, 6 hours in-memory / 7 days in DB) ───────────
const mcapCache = new Map<string, { mcap: number; ts: number }>();
const MCAP_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 часов (in-memory TTL — MCap меняется медленно)

// ── CoinGecko batch cache ──────────────────────────────────────────────────────
// Fallback 1: top-1000 coins by MCap (pages 1–4 × 250).
// Free API, no key. TTL 7h — только preloader обновляет, скан читает из памяти.
let cgeckoBatchCache: { data: Map<string, number>; ts: number } | null = null;
const CGECKO_BATCH_TTL = 7 * 60 * 60 * 1000; // 7 часов
// Cooldown после провала: не повторяем запрос 5 мин (safety net для ручных вызовов).
let cgeckoFailureCooldown = 0;
const CGECKO_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

// ── BingX ticker → canonical symbol aliases ────────────────────────────────────
// BingX uses non-standard tickers for some tokens that differ from CoinGecko/CoinPaprika.
// Map: BingX_BASE → lookup_symbol used in external APIs.
const SYMBOL_ALIASES: Record<string, string> = {
  TONCOIN: "TON", // The Open Network
  "1000000MOG": "MOG", // 1 million MOG contract → MOG MCap
  "1000PEPE": "PEPE", // 1000 PEPE contract → PEPE MCap
  "1000SHIB": "SHIB", // 1000 SHIB contract
  "1000FLOKI": "FLOKI", // 1000 FLOKI contract
  "1000BONK": "BONK", // 1000 BONK contract
  "1000XEC": "XEC",
  "1000BTT": "BTT",
  "1000LUNC": "LUNC",
  "1000NEIRO": "NEIRO",
  "100000AIDOGE": "AIDOGE",
  WBTC: "BTC", // Wrapped BTC → BTC MCap proxy
};

export interface MarketCapCoverage {
  universe: number;
  matchedToId: number;
  withMcap: number;
  unmatched: string[];
  noMcap: string[];
  at: number;
}
let mcapCoverage: MarketCapCoverage | null = null;
export function getMarketCapCoverage(): MarketCapCoverage | null {
  return mcapCoverage;
}

/** Scan universe bases (BingX USDT contracts minus analysis-blocked symbols). */
async function loadUniverseBases(): Promise<string[]> {
  const res = await marketFetch(
    "https://open-api.bingx.com/openApi/swap/v2/quote/contracts",
    { signal: AbortSignal.timeout(15000) },
    { label: "bingx:contracts-universe" },
  );
  if (!res.ok) throw new Error(`BingX contracts HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { symbol: string }[] };
  return (body.data ?? [])
    .map((c) => c.symbol)
    .filter((sym) => sym.endsWith("-USDT") && !isAnalysisBlockedSymbol(sym))
    .map((sym) => sym.replace("-USDT", "").toUpperCase());
}

async function cgeckoGet<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await marketFetch(
      url,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20000),
      },
      { label: "coingecko:market-caps" },
    );
    if (res.status === 429) {
      reportApiFailure("coingecko", 429);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    if (!res.ok) {
      reportApiFailure("coingecko", res.status);
      throw new Error(`CoinGecko HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
  throw new Error("CoinGecko rate-limited");
}

/**
 * CoinGecko is the only MCap source. Every universe symbol is mapped to
 * CoinGecko ids via /coins/list (by symbol; ambiguous symbols keep the id with
 * the largest market cap), then /coins/markets is queried by ids in batches of
 * 250. Returns Map<UPPERCASE_SYMBOL → market_cap_usd>.
 */
async function loadCoinGeckoMarketCaps(): Promise<Map<string, number>> {
  if (cgeckoBatchCache && Date.now() - cgeckoBatchCache.ts < CGECKO_BATCH_TTL) {
    return cgeckoBatchCache.data;
  }
  if (Date.now() - cgeckoFailureCooldown < CGECKO_FAILURE_COOLDOWN_MS) {
    return new Map();
  }

  const map = new Map<string, number>();
  try {
    const bases = await loadUniverseBases();
    const lookups = new Map<string, string>(); // base -> lookup symbol
    for (const base of bases) lookups.set(base, resolveSymbol(base));
    const list = await cgeckoGet<{ id: string; symbol: string }[]>(
      "https://api.coingecko.com/api/v3/coins/list",
    );
    const idsBySymbol = new Map<string, string[]>();
    for (const coin of list) {
      const sym = coin.symbol.toUpperCase();
      const arr = idsBySymbol.get(sym);
      if (arr) arr.push(coin.id);
      else idsBySymbol.set(sym, [coin.id]);
    }
    const wanted = new Set<string>();
    const unmatched: string[] = [];
    let matched = 0;
    for (const [base, lookup] of lookups) {
      const ids = idsBySymbol.get(lookup);
      if (!ids) {
        unmatched.push(base);
        continue;
      }
      matched++;
      for (const id of ids) wanted.add(id);
    }
    const idToSymbol = new Map<string, string>();
    for (const lookup of new Set(lookups.values())) {
      for (const id of idsBySymbol.get(lookup) ?? [])
        idToSymbol.set(id, lookup);
    }
    const allIds = [...wanted];
    for (let i = 0; i < allIds.length; i += 250) {
      const chunk = allIds.slice(i, i + 250);
      const data = await cgeckoGet<{ id: string; market_cap: number | null }[]>(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(chunk.join(","))}&per_page=250&page=1`,
      );
      for (const coin of data) {
        const sym = idToSymbol.get(coin.id);
        if (!sym || !coin.market_cap || coin.market_cap <= 0) continue;
        if ((map.get(sym) ?? 0) < coin.market_cap)
          map.set(sym, coin.market_cap);
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    const noMcap = [...lookups.entries()]
      .filter(([base, lookup]) => !unmatched.includes(base) && !map.has(lookup))
      .map(([base]) => base);
    mcapCoverage = {
      universe: lookups.size,
      matchedToId: matched,
      withMcap: [...lookups.values()].filter((l) => map.has(l)).length,
      unmatched,
      noMcap,
      at: Date.now(),
    };
    cgeckoBatchCache = { data: map, ts: Date.now() };
    cgeckoFailureCooldown = 0;
    logger.info(
      {
        ...mcapCoverage,
        unmatched: unmatched.slice(0, 50),
        noMcap: noMcap.slice(0, 50),
      },
      "CoinGecko market caps loaded by id",
    );
    if (map.size > 0) reportApiSuccess("coingecko");
  } catch (err) {
    logger.warn({ err }, "CoinGecko MCap batch fetch failed");
    reportApiFailure("coingecko");
    cgeckoFailureCooldown = Date.now();
  }
  return map;
}

/**
 * Сохраняет успешно загруженные MCap в DB (upsert).
 * Только записи с mcapUsd > 0. Батч по 200 строк.
 */
async function persistMarketCapsToDB(
  source: string,
  map: Map<string, number>,
): Promise<void> {
  if (map.size === 0) return;
  try {
    const now = new Date();
    const rows = Array.from(map.entries())
      .filter(([, mcapUsd]) => mcapUsd > 0)
      .map(([symbol, mcapUsd]) => ({
        symbol,
        mcapUsd,
        source,
        updatedAt: now,
      }));
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db
        .insert(marketCapCacheTable)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: marketCapCacheTable.symbol,
          set: {
            mcapUsd: sql`excluded.mcap_usd`,
            source: sql`excluded.source`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
    logger.info({ source, count: rows.length }, "MarketCap persisted to DB");
  } catch (err) {
    logger.warn({ err, source }, "MarketCap DB persist failed — пропускаем");
  }
}

/**
 * Принудительно перегружает CoinGecko MCap (единственный источник, без фоллбэков).
 * Вызывается preloader-ом при старте и каждые 6 часов.
 */
async function forceReloadAllMarketCaps(): Promise<void> {
  if (cgeckoBatchCache) cgeckoBatchCache.ts = 0;
  cgeckoFailureCooldown = 0;
  const cgecko = await loadCoinGeckoMarketCaps();
  logger.info({ geckoSize: cgecko.size }, "MarketCap preload complete");
  if (cgecko.size > 0) await persistMarketCapsToDB("coingecko", cgecko);
}

/**
 * Запускает фоновый preloader MCap данных.
 * — Загружает все три источника сразу при старте бота.
 * — Обновляет каждые 6 часов по расписанию.
 * — Скан loop никогда не делает HTTP для MCap: только читает из кэша.
 */
export function startMarketCapPreloader(): void {
  const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 часов

  void forceReloadAllMarketCaps().catch((err) =>
    logger.warn({ err }, "MarketCap initial preload failed"),
  );

  setInterval(() => {
    void forceReloadAllMarketCaps().catch((err) =>
      logger.warn({ err }, "MarketCap scheduled refresh failed"),
    );
  }, REFRESH_INTERVAL_MS);
}

/**
 * Resolves a BingX base symbol to the canonical lookup symbol used in external MCap APIs.
 * Handles contracts like 1000PEPE → PEPE, TONCOIN → TON, etc.
 */
function resolveSymbol(base: string): string {
  return SYMBOL_ALIASES[base] ?? base;
}

/**
 * Ищет MCap по символу во всех трёх источниках (CoinGlass → CoinGecko → CoinPaprika).
 * Применяет алиасы (TONCOIN→TON, 1000PEPE→PEPE и т.д.) перед поиском.
 * Возвращает null если токен не найден ни в одном источнике.
 */
export async function fetchMarketCap(
  symbol: string,
): Promise<{ mcap: number; vol24h: number } | null> {
  const base = symbol.replace("-USDT", "").toUpperCase();
  const lookup = resolveSymbol(base);

  // Per-symbol cache keyed on original base (not alias, to avoid cross-contamination)
  const cached = mcapCache.get(base);
  if (cached && Date.now() - cached.ts < MCAP_CACHE_TTL) {
    return cached.mcap > 0 ? { mcap: cached.mcap, vol24h: 0 } : null; // mcap=0 — sentinel "не найдено"
  }

  // CoinGecko is the only MCap source (owner rule 2026-10-18): no fallbacks.
  const cgecko = await loadCoinGeckoMarketCaps();
  const mcap = cgecko.get(lookup) ?? null;

  if (!mcap) {
    // Кэшируем отсутствие MCap на 5 мин — иначе каждый скан этого символа
    // снова триггерит batch-fetch всех трёх источников.
    // Используем mcap=0 как sentinel; при чтении mcap=0 → пропускаем (символ не найден).
    mcapCache.set(base, {
      mcap: 0,
      ts: Date.now() - (MCAP_CACHE_TTL - 5 * 60 * 1000),
    });
    return null;
  }

  mcapCache.set(base, { mcap, ts: Date.now() });
  return { mcap, vol24h: 0 };
}

/**
 * Батч market cap для списка символов.
 * Загружает все три источника параллельно (единый кеш), затем резолвит каждый символ.
 */
export async function batchFetchMarketCap(
  symbols: string[],
): Promise<Map<string, { mcap: number; vol24h: number } | null>> {
  const result = new Map<string, { mcap: number; vol24h: number } | null>();
  if (symbols.length === 0) return result;

  const cgecko = await loadCoinGeckoMarketCaps();

  for (const sym of symbols) {
    const base = sym.replace("-USDT", "").toUpperCase();
    const lookup = resolveSymbol(base);
    const mcap = cgecko.get(lookup) ?? null;
    result.set(sym, mcap ? { mcap, vol24h: 0 } : null);
  }

  return result;
}
