/**
 * CoinGlass exchange-listing whitelist — Binance spot.
 *
 * Endpoint: GET /api/spot/supported-exchange-pairs
 * Returns all spot pairs per exchange. We extract data.Binance[].base_asset
 * into a Set<string> for fast O(1) lookup.
 *
 * Purpose: единственный источник истины о том, листингован ли BingX-токен
 * на Binance spot. Заменяет:
 *   - эвристику cgNoDataCount >= 3 в классификации BingX-exclusive
 *
 * Refresh: при старте + каждые 6ч.
 * Fail-open:
 *   isBinanceSpotListed() → true  если список ещё не загружен (не блокируем SpBW)
 *   isBingxExclusive()    → false если данные не загружены (не блокируем логику)
 */

import { logger } from "./logger.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getCgSupportedCoinsSet, CG_SYMBOL_ALIAS } from "./coinglass_oi.js";

let _binanceSpotSet: Set<string> | null = null;
let _binanceSpotTs = 0;
const SPOT_LISTINGS_TTL_MS = 6 * 60 * 60 * 1000; // 6ч

interface SpotPairEntry {
  base_asset: string;
  instrument_id?: string;
  quote_asset?: string;
}

/**
 * Загружает список всех токенов Binance spot из CoinGlass.
 * Fail-open: при ошибке оставляет старый список (или null если первый запуск).
 */
export async function refreshBinanceSpotListings(): Promise<void> {
  const key = getNextCgKey();
  if (!key) return;
  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/spot/supported-exchange-pairs",
      {
        headers: { "CG-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "CG spot-listings: HTTP error");
      return;
    }
    const json = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: Record<string, SpotPairEntry[]>;
    };
    if (
      json.code !== "0" ||
      !json.data ||
      !Array.isArray(json.data["Binance"])
    ) {
      logger.warn(
        {
          code: json.code,
          msg: json.msg,
          keys: Object.keys(json.data ?? {}).slice(0, 8),
        },
        "CG spot-listings: unexpected response format",
      );
      return;
    }
    const set = new Set<string>(
      json.data["Binance"].map((p) => p.base_asset.toUpperCase()),
    );
    _binanceSpotSet = set;
    _binanceSpotTs = Date.now();
    logger.info(
      { count: set.size },
      "CoinGlass: Binance spot listings обновлены",
    );
  } catch (err) {
    logger.warn({ err }, "CG spot-listings: fetch error (non-critical)");
  }
}

function extractBase(bingxSymbol: string): string {
  return bingxSymbol.replace(/-USDT$/, "").toUpperCase();
}

/**
 * Токен листингован на Binance spot?
 * Fail-open → true если список ещё не загружен (не блокируем SpBW при старте).
 */
export function isBinanceSpotListed(bingxSymbol: string): boolean {
  if (!_binanceSpotSet) return true; // ещё не загружено — пропускаем
  return _binanceSpotSet.has(extractBase(bingxSymbol));
}

/**
 * Токен торгуется ТОЛЬКО на BingX?
 * = NOT в CG futures coverage (getCgSupportedCoinsSet)
 *   AND NOT на Binance spot (_binanceSpotSet).
 *
 * Fail-open → false если данные не загружены (не блокируем логику при старте).
 *
 * Почему оба условия нужны:
 *   - getCgSupportedCoinsSet = /api/futures/supported-coins — покрывает Binance,
 *     OKX, Bybit и другие биржи. Токен там → точно не BingX-exclusive.
 *   - _binanceSpotSet — дополнительно ловит токены без futures, которые есть
 *     на Binance spot (CGSupportedCoins = futures only, не учитывает spot).
 */
export function isBingxExclusive(bingxSymbol: string): boolean {
  const cgFutures = getCgSupportedCoinsSet();
  if (!cgFutures || !_binanceSpotSet) return false; // fail-open
  const base = extractBase(bingxSymbol);
  const cgBase = (CG_SYMBOL_ALIAS as Record<string, string>)[base] ?? base;
  return !cgFutures.has(cgBase) && !_binanceSpotSet.has(base);
}

/**
 * Список загружен и актуален?
 */
export function areBinanceListingsLoaded(): boolean {
  return (
    _binanceSpotSet !== null &&
    Date.now() - _binanceSpotTs < SPOT_LISTINGS_TTL_MS
  );
}
