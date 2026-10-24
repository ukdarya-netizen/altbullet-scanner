/**
 * CoinGlass — Liquidation data (Professional plan).
 *
 * Три источника:
 *  1) BATCH /api/futures/liquidation/coin-list — 1 запрос = все монеты,
 *     long/short liquidation USD за 1h/4h/12h/24h. Кэш 3 мин + serve-stale
 *     до 30 мин (флаг в getCachedLiqDataEx). Ретрай при ошибке.
 *     Используется в liq-cascade-watcher (каждый цикл) и на fire-сайтах
 *     liquidation_cascade через getCachedLiqData().
 *  2) PER-SYMBOL /api/futures/liquidation/aggregated-history — посвечная
 *     история ликвидаций (30m или 1m, Professional). Ленивый вызов ТОЛЬКО
 *     на fire-evaluation редких кандидатов. Свой circuit breaker + 4s timeout.
 *  3) GLOBAL STREAM /api/futures/liquidation/order (Professional) — поток
 *     реальных ликвидационных ордеров ≥$10K по всем биржам. Опрос раз в 90с
 *     (Layer 10 цикл 3 мин), rolling-окно 15 мин per base_asset.
 *     getLiqOrderStats() — real-time ранний триггер каскада ДО того как
 *     price24h достигнет дамп-порога.
 *
 * Защита от коллизий тикеров (POWER-USDT инцидент): CoinGlass coin-list —
 * кросс-биржевой агрегат; если liq24h > 2× BingX 24h quoteVolume токена —
 * данные подозрительны (короткий тикер сматчился с чужим инструментом) →
 * возвращаем null и НЕ используем как подтверждение "настоящего каскада".
 *
 * Fail-open: любая ошибка / таймаут → null (не блокирует сигнал).
 */

import { getAllFuturesExchanges } from "./coinglass-exchanges.js";
import { logger } from "./logger.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

export interface LiqCoinData {
  longLiq1h: number;
  shortLiq1h: number;
  longLiq4h: number;
  shortLiq4h: number;
  longLiq12h: number;
  shortLiq12h: number;
  longLiq24h: number;
  shortLiq24h: number;
  liq24h: number;
}

export interface LiqExhaustion {
  /** long-ликвидации USD в последней закрытой 30m свече */
  latestLongLiq: number;
  /** пиковая 30m свеча long-ликвидаций в окне (8 свечей = 4ч) */
  peakLongLiq: number;
  /** true = каскад выдохся (latest < 50% пика) */
  exhausted: boolean;
}

/** BingX "BTC-USDT" → базовый символ CoinGlass "BTC". */
function toBase(bingxSymbol: string): string {
  return bingxSymbol.replace(/-USDT$/, "").replace(/USDT$/, "");
}

// ── 1. BATCH coin-list ─────────────────────────────────────────────────────────

const COINLIST_TTL = 3 * 60 * 1000; // 3 мин
let _coinListMap: Map<string, LiqCoinData> | null = null;
let _coinListTs = 0;
let _coinListInflight: Promise<Map<string, LiqCoinData> | null> | null = null;

interface CoinListItem {
  symbol: string;
  long_liquidation_usd_1h?: number;
  short_liquidation_usd_1h?: number;
  long_liquidation_usd_4h?: number;
  short_liquidation_usd_4h?: number;
  long_liquidation_usd_12h?: number;
  short_liquidation_usd_12h?: number;
  long_liquidation_usd_24h?: number;
  short_liquidation_usd_24h?: number;
  liquidation_usd_24h?: number;
}

/** Одна попытка загрузки coin-list. null = неудача (кэш не трогаем). */
async function _fetchCoinListOnce(
  attempt: number,
): Promise<Map<string, LiqCoinData> | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return null;

  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/futures/liquidation/coin-list",
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000), // 10s — batch не должен стопорить 3-мин цикл watcher
      },
    );

    if (res.status === 429) {
      logCg429(apiKey, { endpoint: "liquidation/coin-list" });
      return null;
    }
    if (!res.ok) {
      logger.warn(
        { status: res.status, attempt },
        "fetchLiqCoinList: HTTP error — fail-open",
      );
      return null;
    }

    const json = (await res.json()) as { code: string; data?: CoinListItem[] };
    if (
      json.code !== "0" ||
      !Array.isArray(json.data) ||
      json.data.length === 0
    ) {
      logger.warn(
        { code: json.code, rows: json.data?.length ?? 0, attempt },
        "fetchLiqCoinList: пустой/ошибочный ответ — fail-open",
      );
      return null;
    }

    const map = new Map<string, LiqCoinData>();
    for (const item of json.data) {
      if (!item.symbol) continue;
      map.set(item.symbol.toUpperCase(), {
        longLiq1h: Number(item.long_liquidation_usd_1h) || 0,
        shortLiq1h: Number(item.short_liquidation_usd_1h) || 0,
        longLiq4h: Number(item.long_liquidation_usd_4h) || 0,
        shortLiq4h: Number(item.short_liquidation_usd_4h) || 0,
        longLiq12h: Number(item.long_liquidation_usd_12h) || 0,
        shortLiq12h: Number(item.short_liquidation_usd_12h) || 0,
        longLiq24h: Number(item.long_liquidation_usd_24h) || 0,
        shortLiq24h: Number(item.short_liquidation_usd_24h) || 0,
        liq24h: Number(item.liquidation_usd_24h) || 0,
      });
    }
    return map;
  } catch (err) {
    // Раньше был debug — invisible в prod, из-за чего NULL at-detect баг жил незамеченным
    logger.warn(
      { err: String(err), attempt },
      "fetchLiqCoinList: fetch error — fail-open",
    );
    return null;
  }
}

/**
 * Загружает batch liquidation coin-list (все монеты, 1 запрос).
 * Кэш 3 мин; параллельные вызовы дедуплицируются; 1 ретрай при неудаче
 * (фикс NULL at-detect бага: одиночный 10s-таймаут в момент insert оставлял
 * кэш пустым на весь цикл watcher'а).
 * Fail-open: null при ошибке (старый кэш сохраняется если был).
 */
export async function fetchLiqCoinList(): Promise<Map<
  string,
  LiqCoinData
> | null> {
  const now = Date.now();
  if (_coinListMap && now - _coinListTs < COINLIST_TTL) return _coinListMap;
  if (_coinListInflight) return _coinListInflight;

  _coinListInflight = (async () => {
    try {
      let map = await _fetchCoinListOnce(1);
      if (!map) map = await _fetchCoinListOnce(2); // 1 ретрай
      if (map) {
        _coinListMap = map;
        _coinListTs = Date.now();
        logger.debug({ coins: map.size }, "fetchLiqCoinList: batch обновлён");
      }
      return _coinListMap;
    } finally {
      _coinListInflight = null;
    }
  })();

  return _coinListInflight;
}

export interface LiqCoinDataEx extends LiqCoinData {
  /** true = кэш старше 2×TTL (6 мин) — данные устаревшие, но пригодные */
  stale: boolean;
  /** возраст кэша в мс */
  cacheAgeMs: number;
}

/**
 * Читает liquidation-данные символа из кэшированного batch (БЕЗ fetch).
 * bingxVol24hUsd — для защиты от коллизий: liq24h > 2× объёма BingX → null.
 * Возвращает null если: кэш пуст/старше 30 мин, монеты нет в списке, или collision.
 * Serve-stale: кэш 6–30 мин отдаётся с stale=true (фикс NULL at-detect бага —
 * жёсткий 9-мин cutoff при частых таймаутах batch-запроса оставлял insert без данных).
 */
export function getCachedLiqDataEx(
  bingxSymbol: string,
  bingxVol24hUsd?: number,
): LiqCoinDataEx | null {
  if (!_coinListMap) return null;
  const age = Date.now() - _coinListTs;
  // Owner rule 2026-10-18: no stale cache — only data inside the former non-stale window (6 min).
  if (age > COINLIST_TTL * 2) return null; // previously "non-stale" window; nothing older is served
  const data = _coinListMap.get(toBase(bingxSymbol).toUpperCase());
  if (!data) return null;

  // Collision sanity check (POWER-USDT паттерн): агрегированные ликвидации
  // физически не могут сильно превышать суточный оборот токена на BingX.
  if (
    bingxVol24hUsd !== undefined &&
    bingxVol24hUsd > 0 &&
    data.liq24h > bingxVol24hUsd * 2
  ) {
    logger.warn(
      { symbol: bingxSymbol, liq24h: data.liq24h, bingxVol24h: bingxVol24hUsd },
      "getCachedLiqData: liq24h > 2× BingX vol — collision suspected, данные отброшены",
    );
    return null;
  }
  return { ...data, stale: false, cacheAgeMs: age };
}

/**
 * Backward-compatible обёртка: как getCachedLiqDataEx, но без stale-метаданных.
 */
export function getCachedLiqData(
  bingxSymbol: string,
  bingxVol24hUsd?: number,
): LiqCoinData | null {
  return getCachedLiqDataEx(bingxSymbol, bingxVol24hUsd);
}

// ── 2. PER-SYMBOL liquidation history (exhaustion check) ───────────────────────

const HIST_CACHE_TTL = 5 * 60 * 1000;
const _histCache = new Map<string, { result: LiqExhaustion; ts: number }>();

// Circuit breaker: 3 подряд неудачи → пауза 10 мин
let _histConsecFails = 0;
let _histBreakerUntil = 0;

interface LiqHistItem {
  time: number;
  aggregated_long_liquidation_usd: number | string;
  aggregated_short_liquidation_usd: number | string;
}

/**
 * Проверка "каскад выдохся": последняя свеча long-ликвидаций < 50% пика окна.
 * interval "30m" (дефолт): 8 × 30m = 4ч окно, кэш 5 мин.
 * interval "1m" (Professional, real-time): 30 × 1m = 30-мин окно, кэш 1 мин —
 * для fire-сайтов где нужна свежая картина "каскад ещё идёт прямо сейчас".
 * Ленивый вызов только на fire-evaluation. Fail-open: null.
 */
export async function getLiqExhaustion(
  bingxSymbol: string,
  interval: "30m" | "1m" = "30m",
  /** Порог: latest < peak * threshold → exhausted. По умолчанию 0.5 (50%). */
  exhaustionThreshold: number = 0.5,
  /** Кол-во свечей (переопределяет дефолт: 8×30m=4ч / 30×1m=30мин). */
  limitOverride?: number,
): Promise<LiqExhaustion | null> {
  const base = toBase(bingxSymbol).toUpperCase();
  const defaultLimit = interval === "1m" ? 30 : 8; // 30×1m=30мин | 8×30m=4ч
  const limit = limitOverride ?? defaultLimit;
  const cacheKey = `${base}:${interval}:${limit}:${exhaustionThreshold}`;
  const ttl = interval === "1m" ? 60 * 1000 : HIST_CACHE_TTL;
  const cached = _histCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ttl) return cached.result;

  if (Date.now() < _histBreakerUntil) return null; // circuit breaker открыт

  const apiKey = getNextCgKey();
  if (!apiKey) return null;

  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history",
  );
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("exchange_list", getAllFuturesExchanges());

  try {
    const res = await cgTimedFetch(url.toString(), {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });

    if (res.status === 429) {
      logCg429(apiKey, {
        symbol: base,
        endpoint: "liquidation/aggregated-history",
      });
      _histFail(); // 429 тоже считаем в circuit breaker (консистентно с fetchLiqOrders)
      return null;
    }
    if (!res.ok) {
      _histFail();
      return null;
    }

    const json = (await res.json()) as { code: string; data?: LiqHistItem[] };
    if (
      json.code !== "0" ||
      !Array.isArray(json.data) ||
      json.data.length === 0
    ) {
      _histFail();
      return null;
    }

    _histConsecFails = 0;
    const candles = json.data;
    const longs = candles.map(
      (c) => Number(c.aggregated_long_liquidation_usd) || 0,
    );
    const latestLongLiq = longs[longs.length - 1] ?? 0;
    const peakLongLiq = Math.max(...longs, 0);
    const exhausted =
      peakLongLiq <= 0
        ? true
        : latestLongLiq < peakLongLiq * exhaustionThreshold;

    const result: LiqExhaustion = { latestLongLiq, peakLongLiq, exhausted };
    _histCache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (err) {
    _histFail();
    logger.debug(
      { err: String(err), symbol: base },
      "getLiqExhaustion: error — fail-open",
    );
    return null;
  }
}

function _histFail(): void {
  _histConsecFails++;
  if (_histConsecFails >= 3) {
    _histBreakerUntil = Date.now() + 10 * 60 * 1000;
    _histConsecFails = 0;
    logger.warn(
      "getLiqExhaustion: 3 подряд неудачи — circuit breaker на 10 мин",
    );
  }
}

// ── 3. GLOBAL liquidation order stream (Professional, real-time) ───────────────
//
// /api/futures/liquidation/order — поток реальных ликвидационных ордеров ≥$10K
// по всем биржам одним запросом. Poll раз в 90с, буфер дедуплицируется по
// (exchange, symbol, time, usd), rolling-окно 15 мин per base_asset.
//
// side: 1 = ликвидация ЛОНГА (принудительная продажа), 2 = ликвидация ШОРТА.

/** Порог отсечки мелких ордеров на стороне CoinGlass (USD). */
const ORDER_MIN_USD = 10_000;
/** Кэш-интервал опроса стрима (не чаще). */
const ORDER_POLL_TTL = 90 * 1000;
/** Rolling-окно агрегации per base_asset. */
const ORDER_WINDOW_MS = 15 * 60 * 1000;

interface LiqOrderItem {
  exchange_name: string;
  symbol: string;
  base_asset: string;
  price: number | string;
  usd_value: number | string;
  side: number; // 1 = long liq, 2 = short liq
  time: number; // ms
}

interface BufferedOrder {
  baseAsset: string;
  usd: number;
  side: number;
  time: number;
}

export interface LiqOrderStats {
  /** количество ликвидаций лонгов за окно */
  longCount: number;
  /** сумма USD ликвидаций лонгов за окно */
  longUsd: number;
  /** количество ликвидаций шортов за окно */
  shortCount: number;
  /** сумма USD ликвидаций шортов за окно */
  shortUsd: number;
  /** длина окна в минутах */
  windowMin: number;
}

// Буфер ордеров: dedup-ключ → ордер. Чистится от записей старше окна.
const _orderBuffer = new Map<string, BufferedOrder>();
let _orderLastPollTs = 0;
let _orderInflight: Promise<void> | null = null;

// Circuit breaker: 3 подряд неудачи → пауза 10 мин
let _orderConsecFails = 0;
let _orderBreakerUntil = 0;

function _orderFail(): void {
  _orderConsecFails++;
  if (_orderConsecFails >= 3) {
    _orderBreakerUntil = Date.now() + 10 * 60 * 1000;
    _orderConsecFails = 0;
    logger.warn("fetchLiqOrders: 3 подряд неудачи — circuit breaker на 10 мин");
  }
}

function _pruneOrderBuffer(now: number): void {
  const cutoff = now - ORDER_WINDOW_MS;
  for (const [key, o] of _orderBuffer.entries()) {
    if (o.time < cutoff) _orderBuffer.delete(key);
  }
}

/**
 * Опрашивает глобальный поток ликвидационных ордеров (все биржи, 1 запрос).
 * Не чаще раза в 90с; параллельные вызовы дедуплицируются.
 * Fail-open: ошибка не выбрасывается, буфер сохраняет прошлые ордера.
 */
export async function fetchLiqOrders(): Promise<void> {
  const now = Date.now();
  if (now - _orderLastPollTs < ORDER_POLL_TTL) return;
  if (now < _orderBreakerUntil) return;
  if (_orderInflight) return _orderInflight;

  _orderInflight = (async () => {
    const apiKey = getNextCgKey();
    if (!apiKey) return;

    const url = new URL(
      "https://open-api-v4.coinglass.com/api/futures/liquidation/order",
    );
    url.searchParams.set("min_liquidation_amount", String(ORDER_MIN_USD));

    try {
      const res = await cgTimedFetch(url.toString(), {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });

      if (res.status === 429) {
        logCg429(apiKey, { endpoint: "liquidation/order" });
        _orderFail();
        return;
      }
      if (!res.ok) {
        logger.warn(
          { status: res.status },
          "fetchLiqOrders: HTTP error — fail-open",
        );
        _orderFail();
        return;
      }

      const json = (await res.json()) as {
        code: string;
        data?: LiqOrderItem[];
      };
      if (json.code !== "0" || !Array.isArray(json.data)) {
        logger.warn(
          { code: json.code },
          "fetchLiqOrders: ошибочный ответ — fail-open",
        );
        _orderFail();
        return;
      }

      _orderConsecFails = 0;
      _orderLastPollTs = Date.now();

      let added = 0;
      for (const item of json.data) {
        const base = (item.base_asset || "").toUpperCase();
        const usd = Number(item.usd_value) || 0;
        const time = Number(item.time) || 0;
        if (!base || usd <= 0 || time <= 0) continue;
        const key = `${item.exchange_name}:${item.symbol}:${time}:${usd}`;
        if (_orderBuffer.has(key)) continue;
        _orderBuffer.set(key, {
          baseAsset: base,
          usd,
          side: Number(item.side) || 0,
          time,
        });
        added++;
      }
      _pruneOrderBuffer(Date.now());

      logger.debug(
        { received: json.data.length, added, buffered: _orderBuffer.size },
        "fetchLiqOrders: поток обновлён",
      );
    } catch (err) {
      logger.warn(
        { err: String(err) },
        "fetchLiqOrders: fetch error — fail-open",
      );
      _orderFail();
    } finally {
      _orderInflight = null;
    }
  })();

  return _orderInflight;
}

/**
 * Rolling-статистика ликвидационных ордеров символа за последние 15 мин (БЕЗ fetch).
 * null = стрим ещё не опрашивался (буфер пуст И ни одного успешного poll).
 * Пустая статистика при живом стриме = нули (это валидные данные: ликвидаций нет).
 */
export function getLiqOrderStats(bingxSymbol: string): LiqOrderStats | null {
  if (_orderLastPollTs === 0) return null; // ни одного успешного опроса
  const base = toBase(bingxSymbol).toUpperCase();
  const cutoff = Date.now() - ORDER_WINDOW_MS;

  const stats: LiqOrderStats = {
    longCount: 0,
    longUsd: 0,
    shortCount: 0,
    shortUsd: 0,
    windowMin: 15,
  };
  for (const o of _orderBuffer.values()) {
    if (o.baseAsset !== base || o.time < cutoff) continue;
    if (o.side === 1) {
      stats.longCount++;
      stats.longUsd += o.usd;
    } else if (o.side === 2) {
      stats.shortCount++;
      stats.shortUsd += o.usd;
    }
  }
  return stats;
}

/**
 * Все base_asset с ликвидациями лонгов за окно, отсортированы по сумме USD.
 * Для Layer 10 раннего триггера: кандидаты каскада ДО достижения дамп-порога p24h.
 */
export function getLiqOrderLongLeaders(): {
  baseAsset: string;
  longCount: number;
  longUsd: number;
}[] {
  if (_orderLastPollTs === 0) return [];
  const cutoff = Date.now() - ORDER_WINDOW_MS;
  const agg = new Map<
    string,
    { baseAsset: string; longCount: number; longUsd: number }
  >();
  for (const o of _orderBuffer.values()) {
    if (o.side !== 1 || o.time < cutoff) continue;
    let entry = agg.get(o.baseAsset);
    if (!entry) {
      entry = { baseAsset: o.baseAsset, longCount: 0, longUsd: 0 };
      agg.set(o.baseAsset, entry);
    }
    entry.longCount++;
    entry.longUsd += o.usd;
  }
  return [...agg.values()].sort((a, b) => b.longUsd - a.longUsd);
}
