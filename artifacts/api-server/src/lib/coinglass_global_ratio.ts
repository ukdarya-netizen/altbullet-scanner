/**
 * CoinGlass — Global Long/Short Account Ratio (ритейл-позиционирование).
 *
 * В отличие от top-long-short-position-ratio (топ-трейдеры, уже используется),
 * этот эндпоинт показывает % ВСЕХ аккаунтов в лонге/шорте — толпу.
 *
 * Применение (log-only фаза): при дампе высокий % лонгов у толпы =
 * ещё не все ликвидированы → каскад может продолжиться (топливо вниз).
 * Толпа в шортах = топливо для сквиза вверх.
 *
 * Endpoint: GET /api/futures/global-long-short-account-ratio/history
 *   ?exchange=Binance&symbol=BTCUSDT&interval=1h&limit=1
 *
 * Fail-open: любая ошибка / таймаут / нет пары на Binance → null.
 * Кэш: 10 мин.
 */

import { logger } from "./logger.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

export interface GlobalRatioResult {
  /** % аккаунтов в лонге (0–100) — последняя 1h свеча */
  longPct: number;
  /** % аккаунтов в шорте (0–100) */
  shortPct: number;
  /** long/short ratio */
  ratio: number;
  /**
   * Динамика толпы за ~4ч: longPct(сейчас) − longPct(4 свечи назад).
   * >0 = толпа наращивает лонги (топливо для каскада вниз при дампе),
   * <0 = толпа капитулирует/шортит (топливо для сквиза вверх).
   * null = истории не хватило (свежелистанный токен).
   */
  deltaLongPct4h: number | null;
}

const CACHE_TTL = 10 * 60 * 1000;
// Негативный кэш: пары нет на Binance (HTTP 4xx / пустые данные) — не дёргаем CG повторно
const NEG_CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<
  string,
  { result: GlobalRatioResult | null; ts: number }
>();

function toCgSymbol(bingxSymbol: string): string {
  return bingxSymbol.replace("-", "");
}

interface GlobalRatioItem {
  time: number;
  global_account_long_percent: number | string;
  global_account_short_percent: number | string;
  global_account_long_short_ratio: number | string;
}

/**
 * Возвращает ритейл long/short позиционирование для символа.
 * Fail-open: null при любой ошибке — не блокирует сигнал.
 */
export async function getGlobalAccountRatio(
  bingxSymbol: string,
  exchange = "Binance",
): Promise<GlobalRatioResult | null> {
  const cgSymbol = toCgSymbol(bingxSymbol);
  const cacheKey = `${exchange}:${cgSymbol}`;
  const cached = cache.get(cacheKey);
  if (
    cached &&
    Date.now() - cached.ts <
      (cached.result === null ? NEG_CACHE_TTL : CACHE_TTL)
  ) {
    return cached.result;
  }

  const apiKey = getNextCgKey();
  if (!apiKey) return null;

  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/global-long-short-account-ratio/history",
  );
  url.searchParams.set("exchange", exchange);
  url.searchParams.set("symbol", cgSymbol);
  url.searchParams.set("interval", "1h");
  url.searchParams.set("limit", "4"); // 4 × 1h = тренд толпы за 4ч (Professional)

  try {
    const res = await cgTimedFetch(url.toString(), {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });

    if (res.status === 429) {
      logCg429(apiKey, {
        symbol: cgSymbol,
        endpoint: "global-long-short-account-ratio",
      });
      return null;
    }
    if (!res.ok) {
      logger.debug(
        { status: res.status, symbol: cgSymbol },
        "getGlobalAccountRatio: HTTP error — fail-open",
      );
      cache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    const json = (await res.json()) as {
      code: string;
      data?: GlobalRatioItem[];
    };
    if (json.code !== "0" || !json.data?.length) {
      cache.set(cacheKey, { result: null, ts: Date.now() });
      return null;
    }

    // История отсортирована по времени по возрастанию — последняя = текущая свеча
    const items = [...json.data].sort((a, b) => a.time - b.time);
    const item = items[items.length - 1];
    const longPct = Number(item.global_account_long_percent);
    const shortPct = Number(item.global_account_short_percent);
    const ratio = Number(item.global_account_long_short_ratio);
    if (!Number.isFinite(longPct) || longPct <= 0) return null;

    // Дельта за ~4ч: текущая vs самая старая свеча в окне (нужно ≥2 свечей)
    let deltaLongPct4h: number | null = null;
    if (items.length >= 2) {
      const oldest = Number(items[0].global_account_long_percent);
      if (Number.isFinite(oldest) && oldest > 0) {
        deltaLongPct4h = Math.round((longPct - oldest) * 100) / 100;
      }
    }

    const result: GlobalRatioResult = {
      longPct,
      shortPct: Number.isFinite(shortPct) ? shortPct : 100 - longPct,
      ratio: Number.isFinite(ratio)
        ? ratio
        : longPct / Math.max(100 - longPct, 1),
      deltaLongPct4h,
    };
    cache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (err) {
    logger.debug(
      { err: String(err), symbol: cgSymbol },
      "getGlobalAccountRatio: fetch error — fail-open",
    );
    return null;
  }
}
