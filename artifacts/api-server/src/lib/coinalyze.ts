/**
 * Coinalyze — кросс-биржевой агрегатор OI.
 * Используется для верификации: если OI растёт не только на BingX, но и по всему рынку —
 * сигнал значительно сильнее (не манипуляция одной биржей).
 *
 * Требует COINALYZE_API_KEY (бесплатный план: 100 req/day).
 * Ключ: https://coinalyze.net/account/
 *
 * Формат символа: BTCUSDT_PERP.A (Bybit) — агрегат без суффикса не поддерживается на free plan.
 * Endpoint: GET /v1/open-interest-history?symbols=...&interval=30min&from=<unix>&to=<unix>
 * Response: [{symbol, history: [{t, o, h, l, c}]}]  (o=open OI, c=close OI)
 */

import { logger } from "./logger.js";
import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { marketFetch } from "./marketRequestBudget.js";

export interface CoinalyzeOIResult {
  /** Кросс-биржевое изменение OI за 30 минут в % */
  oiChange30m: number | null;
  /** Абсолютное значение OI в USD */
  oiUsd: number | null;
  available: boolean;
  source: "coinalyze";
}

// Кэш для снижения числа запросов (30 мин)
const cache = new Map<string, { result: CoinalyzeOIResult; ts: number }>();
const CACHE_TTL = 30 * 60 * 1000;

// ── Ротация ключей Coinalyze (до 5 аккаунтов × 100 req/day = 500 req/day) ────
const DAILY_LIMIT = 90; // оставляем буфер от 100
const KEY_NAMES = [
  "COINALYZE_API_KEY",
  "COINALYZE_API_KEY_2",
  "COINALYZE_API_KEY_3",
  "COINALYZE_API_KEY_4",
  "COINALYZE_API_KEY_5",
] as const;

function startOfNextDayUtc(): number {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).getTime();
}

interface KeySlot {
  key: string;
  count: number;
  exhaustedUntil: number; // unix ms — 0 если не исчерпан
  resetAt: number;
}

function buildKeySlots(): KeySlot[] {
  const slots: KeySlot[] = [];
  for (const name of KEY_NAMES) {
    const k = process.env[name];
    if (k)
      slots.push({
        key: k,
        count: 0,
        exhaustedUntil: 0,
        resetAt: startOfNextDayUtc(),
      });
  }
  return slots;
}

// Инициализируем при загрузке модуля
const keySlots: KeySlot[] = buildKeySlots();

/** Сбрасывает список ключей из env (полезно если секреты добавили после старта) */
function refreshKeySlots(): void {
  const existing = new Set(keySlots.map((s) => s.key));
  for (const name of KEY_NAMES) {
    const k = process.env[name];
    if (k && !existing.has(k)) {
      keySlots.push({
        key: k,
        count: 0,
        exhaustedUntil: 0,
        resetAt: startOfNextDayUtc(),
      });
    }
  }
}

/**
 * Возвращает активный ключ из пула с ротацией.
 * Если 429 — вызвать markKeyExhausted(key).
 * Возвращает null если все ключи исчерпаны.
 */
function getActiveKey(): string | null {
  refreshKeySlots();
  if (keySlots.length === 0) return null;
  const now = Date.now();
  for (const slot of keySlots) {
    // Сброс счётчика в полночь UTC
    if (now >= slot.resetAt) {
      slot.count = 0;
      slot.exhaustedUntil = 0;
      slot.resetAt = startOfNextDayUtc();
      logger.info(
        { key: slot.key.slice(-4) },
        "Coinalyze key daily counter reset",
      );
    }
    if (slot.exhaustedUntil > now) continue; // исчерпан — пропускаем
    if (slot.count >= DAILY_LIMIT) continue; // лимит — пропускаем
    slot.count++;
    return slot.key;
  }
  logger.warn(
    {
      slots: keySlots.map((s) => ({
        last4: s.key.slice(-4),
        count: s.count,
        exhausted: s.exhaustedUntil > now,
      })),
    },
    "Coinalyze: все ключи исчерпаны на сегодня",
  );
  return null;
}

/** Помечает ключ исчерпанным (429) до конца суток UTC */
function markKeyExhausted(key: string): void {
  const slot = keySlots.find((s) => s.key === key);
  if (slot) {
    slot.exhaustedUntil = startOfNextDayUtc();
    slot.count = DAILY_LIMIT;
    logger.warn(
      {
        last4: key.slice(-4),
        nextReset: new Date(slot.exhaustedUntil).toISOString(),
      },
      "Coinalyze key 429 — помечен исчерпанным до полуночи UTC",
    );
  }
}

/** Возвращает текущее число запросов сегодня и лимит (суммарно по всем ключам) */
export function getCoinalyzeDailyStats(): {
  used: number;
  limit: number;
  remaining: number;
} {
  const now = Date.now();
  const active = keySlots.filter((s) => s.exhaustedUntil <= now);
  const used = keySlots.reduce((sum, s) => sum + s.count, 0);
  const limit = keySlots.length * DAILY_LIMIT;
  const remaining = active.reduce(
    (sum, s) => sum + Math.max(0, DAILY_LIMIT - s.count),
    0,
  );
  return { used, limit, remaining };
}

/**
 * Нормализует символ BingX в формат Coinalyze с суффиксом Bybit (.A).
 * BTC-USDT → BTCUSDT_PERP.A
 */
function toBingxCoinalyzeSymbol(bingxSymbol: string): string {
  const base = bingxSymbol.replace("-USDT", "");
  return `${base}USDT_PERP.A`;
}

/** Строка без суффикса биржи для map lookup */
function toBaseSymbol(bingxSymbol: string): string {
  const base = bingxSymbol.replace("-USDT", "");
  return `${base}USDT_PERP`;
}

// Тип одной свечи из history
interface OICandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}
// Тип элемента ответа
type CoinalyzeResponse = { symbol: string; history: OICandle[] }[];

/** Строит URL запроса за последний час 30min-свечей */
function buildOIUrl(symbols: string[], apiKey: string): string {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 3600; // 1 час назад — гарантируем минимум 2 свечи 30min
  const url = new URL("https://api.coinalyze.net/v1/open-interest-history");
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("interval", "30min");
  url.searchParams.set("from", String(from));
  url.searchParams.set("to", String(to));
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}

export async function getCoinalyzeOI(
  symbol: string,
): Promise<CoinalyzeOIResult> {
  const noData: CoinalyzeOIResult = {
    oiChange30m: null,
    oiUsd: null,
    available: false,
    source: "coinalyze",
  };

  const cacheKey = toBaseSymbol(symbol);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const apiKey = getActiveKey();
  if (!apiKey) return noData;

  const cglSymbol = toBingxCoinalyzeSymbol(symbol);

  try {
    const res = await marketFetch(
      buildOIUrl([cglSymbol], apiKey),
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      },
      { label: "coinalyze:oi" },
    );

    if (!res.ok) {
      if (res.status === 429) markKeyExhausted(apiKey);
      logger.warn(
        { symbol, status: res.status },
        "Coinalyze OI request failed",
      );
      reportApiFailure("coinalyze", res.status);
      return noData;
    }

    const data = (await res.json()) as CoinalyzeResponse;

    if (!Array.isArray(data) || data.length === 0) return noData;

    const entry = data[0];
    const history = entry?.history;
    if (!history || history.length < 2) return noData;

    const prev = history[history.length - 2].c;
    const curr = history[history.length - 1].c;
    const oiChange30m = prev > 0 ? ((curr - prev) / prev) * 100 : null;

    const result: CoinalyzeOIResult = {
      oiChange30m,
      oiUsd: curr,
      available: true,
      source: "coinalyze",
    };

    reportApiSuccess("coinalyze");
    cache.set(cacheKey, { result, ts: Date.now() });
    return result;
  } catch (err) {
    logger.warn({ symbol, err }, "Coinalyze OI fetch error");
    reportApiFailure("coinalyze");
    return noData;
  }
}

// ── 24h OI Change ─────────────────────────────────────────────────────────────
const cache24h = new Map<string, { oiChange24h: number | null; ts: number }>();
const CACHE_24H_TTL = 20 * 60 * 1000; // 20 мин

// Батч-вызов: последний timestamp для rate-limit (не чаще 1 раза в 90 мин на процесс)
let lastBatchFetchAt = 0;
const BATCH_24H_COOLDOWN = 90 * 60 * 1000;

/**
 * Батч-загрузка OI 24h для списка символов — ОДИН запрос к Coinalyze.
 * Результаты сохраняются в cache24h так же, как getCoinalyzeOI24h.
 * Использовать перед per-symbol scan loop чтобы cache уже был тёплым.
 * Считается как 1 daily request независимо от числа символов.
 */
export async function batchGetCoinalyzeOI24h(
  bingxSymbols: string[],
): Promise<void> {
  if (bingxSymbols.length === 0) return;

  const now = Date.now();
  if (now - lastBatchFetchAt < BATCH_24H_COOLDOWN) return;

  const stale = bingxSymbols.filter((sym) => {
    const k = toBaseSymbol(sym);
    const c = cache24h.get(k);
    return !c || now - c.ts >= CACHE_24H_TTL;
  });
  if (stale.length === 0) return;

  lastBatchFetchAt = now;

  const to = Math.floor(now / 1000);
  const from = to - 86400;
  const coinalyzeSymbols = stale.map(toBingxCoinalyzeSymbol);

  // Разбиваем на чанки по 10 символов — бесплатный тариф таймаутится при >10 символов
  const CHUNK = 10;
  const chunks: string[][] = [];
  for (let i = 0; i < coinalyzeSymbols.length; i += CHUNK) {
    chunks.push(coinalyzeSymbols.slice(i, i + CHUNK));
  }

  let filled = 0;

  for (const chunk of chunks) {
    const apiKey = getActiveKey();
    if (!apiKey) {
      logger.warn(
        "Coinalyze batch OI 24h: все ключи исчерпаны — прерываем батч",
      );
      break;
    }

    const url = new URL("https://api.coinalyze.net/v1/open-interest-history");
    url.searchParams.set("symbols", chunk.join(","));
    url.searchParams.set("interval", "1hour");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("api_key", apiKey);

    try {
      const res = await marketFetch(
        url.toString(),
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        },
        { label: "coinalyze:oi-history" },
      );

      if (!res.ok) {
        reportApiFailure("coinalyze", res.status);
        if (res.status === 429) {
          markKeyExhausted(apiKey);
        } else {
          logger.warn(
            { status: res.status, chunk: chunk.length },
            "Coinalyze batch OI 24h: chunk failed",
          );
        }
        continue;
      }

      const data = (await res.json()) as CoinalyzeResponse;
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        const cacheKey = entry.symbol.replace(/\.A$/, "");
        const history = entry.history;
        if (!history || history.length < 2) {
          cache24h.set(cacheKey, { oiChange24h: null, ts: now });
          continue;
        }
        const first = history[0].o;
        const last = history[history.length - 1].c;
        const oiChange24h = first > 0 ? ((last - first) / first) * 100 : null;
        cache24h.set(cacheKey, { oiChange24h, ts: now });
        filled++;
      }

      reportApiSuccess("coinalyze");
    } catch (err) {
      reportApiFailure("coinalyze");
      logger.warn(
        { err, chunk: chunk.length },
        "Coinalyze batch OI 24h: chunk fetch error",
      );
    }
  }

  logger.info(
    { requested: stale.length, filled, chunks: chunks.length },
    "🦑 Coinalyze batch OI 24h loaded",
  );
}

/**
 * Cache-only чтение OI 24h из Coinalyze — без HTTP вызова.
 * Возвращает null если данных нет или кэш устарел.
 * Используется как fallback в per-symbol scan loop без расхода API квоты.
 */
export function getCoinalyzeOI24hCached(bingxSymbol: string): number | null {
  const cacheKey = toBaseSymbol(bingxSymbol);
  const cached = cache24h.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_24H_TTL)
    return cached.oiChange24h;
  return null;
}

// ── 30m OI Batch ──────────────────────────────────────────────────────────────
// Для паттерна oi1h_breakout: Coinalyze агрегат OI за 2 последовательные 30min-свечи.
// Кэш 30 мин — обновляется вместе с 24h батчем (в том же DB guard, cooldown 90 мин).
interface Coinalyze30mData {
  prevOiChange30m: number | null; // изменение OI в предпредпоследней 30m свече
  oiChange30m: number | null; // изменение OI в последней завершённой 30m свече
  oiChange1h: number | null; // скользящее 1h изменение (2 свечи суммарно)
  ts: number;
}
const cache30m = new Map<string, Coinalyze30mData>();
const CACHE_30M_TTL = 30 * 60 * 1000; // 30 мин

/**
 * Snapshot всех записей из cache30m — для отображения в UI (вкладка Coinalyze batch).
 * Возвращает только свежие записи (не старше CACHE_30M_TTL).
 * Сортировка: по abs(oiChange1h) descending.
 */
export function getCoinalyzeCache30mSnapshot(): Array<{
  symbol: string;
  oiChange30m: number | null;
  prevOiChange30m: number | null;
  oiChange1h: number | null;
  ageMs: number;
}> {
  const now = Date.now();
  return [...cache30m.entries()]
    .filter(([, d]) => now - d.ts < CACHE_30M_TTL)
    .map(([sym, d]) => ({
      symbol: sym,
      oiChange30m: d.oiChange30m,
      prevOiChange30m: d.prevOiChange30m,
      oiChange1h: d.oiChange1h,
      ageMs: now - d.ts,
    }))
    .sort((a, b) => Math.abs(b.oiChange1h ?? 0) - Math.abs(a.oiChange1h ?? 0));
}

/**
 * Загружает cache30m из снимка (например из DB при старте).
 * ts выставляется в (now - CACHE_30M_TTL) чтобы записи сразу считались стейл —
 * иначе первый батч после старта видит "все свежие" и пропускает API-запрос,
 * что приводит к вечно замёрзшим данным между деплоями.
 */
export function loadCache30mFromSnapshot(
  snapshot: Array<{
    symbol: string;
    oiChange30m: number | null;
    prevOiChange30m: number | null;
    oiChange1h: number | null;
  }>,
): void {
  const ts = Date.now() - CACHE_30M_TTL; // intentionally stale: force re-fetch on next batch
  for (const item of snapshot) {
    cache30m.set(item.symbol, {
      prevOiChange30m: item.prevOiChange30m,
      oiChange30m: item.oiChange30m,
      oiChange1h: item.oiChange1h,
      ts,
    });
  }
  logger.info(
    { loaded: snapshot.length },
    "🦑 Coinalyze cache30m: восстановлен из DB (помечен стейл — батч перезагрузит при первом цикле)",
  );
}

/**
 * Cache-only чтение OI 30m из Coinalyze — без HTTP вызова.
 * Возвращает null если данных нет или кэш устарел.
 */
export function getCoinalyzeOI30mCached(bingxSymbol: string): {
  prevOiChange30m: number | null;
  oiChange30m: number | null;
  oiChange1h: number | null;
} | null {
  const cacheKey = toBaseSymbol(bingxSymbol);
  const cached = cache30m.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_30M_TTL) {
    return {
      prevOiChange30m: cached.prevOiChange30m,
      oiChange30m: cached.oiChange30m,
      oiChange1h: cached.oiChange1h,
    };
  }
  return null;
}

/**
 * Батч-загрузка OI 30m для списка символов — ОДИН HTTP запрос к Coinalyze.
 * Запрашивает последние 1.5ч 30min-свечей → получаем 2–3 закрытые свечи.
 * Счётчик daily limit: 1 запрос независимо от числа символов.
 * Вызывается из scanner.ts в том же DB guard что и batchGetCoinalyzeOI24h.
 */
export async function batchGetCoinalyzeOI30m(
  bingxSymbols: string[],
): Promise<void> {
  if (bingxSymbols.length === 0) {
    logger.warn("Coinalyze batch OI 30m: пустой список символов");
    return;
  }

  const now = Date.now();
  const fresh = bingxSymbols.filter((sym) => {
    const c = cache30m.get(toBaseSymbol(sym));
    return !!c && now - c.ts < CACHE_30M_TTL;
  });
  const stale = bingxSymbols.filter((sym) => {
    const c = cache30m.get(toBaseSymbol(sym));
    return !c || now - c.ts >= CACHE_30M_TTL;
  });
  logger.info(
    { total: bingxSymbols.length, stale: stale.length, fresh: fresh.length },
    "🦑 Coinalyze batch OI 30m: stale/fresh breakdown",
  );
  if (stale.length === 0) {
    logger.info("Coinalyze batch OI 30m: все символы свежие, пропуск");
    return;
  }

  const to = Math.floor(now / 1000);
  const from = to - 5400; // 1.5 часа → гарантируем минимум 3 свечи 30min
  const coinalyzeSymbols = stale.map(toBingxCoinalyzeSymbol);

  // Чанки по 10 символов — free tier таймаутится при большем батче
  const CHUNK = 10;
  const chunks: string[][] = [];
  for (let i = 0; i < coinalyzeSymbols.length; i += CHUNK) {
    chunks.push(coinalyzeSymbols.slice(i, i + CHUNK));
  }

  let filled = 0;
  let chunkIdx = 0;

  for (const chunk of chunks) {
    chunkIdx++;
    const apiKey = getActiveKey();
    if (!apiKey) {
      logger.warn(
        { chunkIdx, total: chunks.length },
        "Coinalyze batch OI 30m: все ключи исчерпаны — прерываем батч",
      );
      break;
    }

    const url = new URL("https://api.coinalyze.net/v1/open-interest-history");
    url.searchParams.set("symbols", chunk.join(","));
    url.searchParams.set("interval", "30min");
    url.searchParams.set("from", String(from));
    url.searchParams.set("to", String(to));
    url.searchParams.set("api_key", apiKey);

    try {
      const res = await marketFetch(
        url.toString(),
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(12000),
        },
        { label: "coinalyze:oi-history" },
      );

      if (!res.ok) {
        reportApiFailure("coinalyze", res.status);
        if (res.status === 429) {
          markKeyExhausted(apiKey);
          logger.warn(
            { chunkIdx, status: 429 },
            "Coinalyze batch OI 30m: 429 — ключ исчерпан",
          );
        } else {
          logger.warn(
            { chunkIdx, status: res.status, symbols: chunk },
            "Coinalyze batch OI 30m: chunk failed",
          );
        }
        continue;
      }

      const data = (await res.json()) as CoinalyzeResponse;
      if (!Array.isArray(data)) {
        reportApiFailure("coinalyze", 200);
        logger.warn(
          { chunkIdx, dataType: typeof data },
          "Coinalyze batch OI 30m: неожиданный формат ответа",
        );
        continue;
      }

      let chunkFilled = 0;
      for (const entry of data) {
        const cacheKey = entry.symbol.replace(/\.A$/, "");
        const history = entry.history;
        if (!history || history.length < 2) {
          cache30m.set(cacheKey, {
            prevOiChange30m: null,
            oiChange30m: null,
            oiChange1h: null,
            ts: now,
          });
          continue;
        }
        const len = history.length;
        const curr = history[len - 1].c;
        const prev = history[len - 2].c;
        const prev2 = len >= 3 ? history[len - 3].c : null;

        const oiChange30m = prev > 0 ? ((curr - prev) / prev) * 100 : null;
        const prevOiChange30m =
          prev2 !== null && prev2 > 0 ? ((prev - prev2) / prev2) * 100 : null;
        const oiChange1h =
          prev2 !== null && prev2 > 0 ? ((curr - prev2) / prev2) * 100 : null;

        cache30m.set(cacheKey, {
          prevOiChange30m,
          oiChange30m,
          oiChange1h,
          ts: now,
        });
        filled++;
        chunkFilled++;
      }

      logger.info(
        {
          chunkIdx,
          requested: chunk.length,
          filled: chunkFilled,
          historyEntries: data.length,
        },
        "🦑 Coinalyze batch OI 30m: chunk OK",
      );
      reportApiSuccess("coinalyze");
    } catch (err) {
      reportApiFailure("coinalyze");
      logger.warn(
        { err, chunkIdx, symbols: chunk },
        "Coinalyze batch OI 30m: chunk fetch error",
      );
    }
  }

  logger.info(
    { requested: stale.length, filled, chunks: chunks.length },
    "🦑 Coinalyze batch OI 30m loaded",
  );
}

// ── Pool Ranking Cache ────────────────────────────────────────────────────────
interface OIRankEntry {
  symbol: string;
  oiUsd: number;
}
let poolRankingCache: OIRankEntry[] = [];
let poolRankingCachedAt = 0;
const POOL_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 часа

/**
 * Получить ранжирование символов по абсолютному глобальному OI (USD).
 * Используется для формирования пула 500 монет вместо сортировки по объёму BingX.
 * Кэшируется на 2 часа, чтобы не превышать лимиты API.
 */
export async function getGlobalOIRanking(
  bingxSymbols: string[],
): Promise<OIRankEntry[]> {
  if (bingxSymbols.length === 0) return [];

  if (
    poolRankingCache.length > 0 &&
    Date.now() - poolRankingCachedAt < POOL_CACHE_TTL
  ) {
    return poolRankingCache;
  }

  const coinalyzeSymbols = bingxSymbols.map(toBingxCoinalyzeSymbol);
  const batches: string[][] = [];
  for (let i = 0; i < coinalyzeSymbols.length; i += 20) {
    batches.push(coinalyzeSymbols.slice(i, i + 20));
  }

  const results: OIRankEntry[] = [];
  let requestCount = 0;

  for (const batch of batches) {
    const apiKey = getActiveKey();
    if (!apiKey) break; // все ключи исчерпаны
    try {
      const res = await marketFetch(
        buildOIUrl(batch, apiKey),
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        },
        { label: "coinalyze:oi-batch" },
      );

      requestCount++;
      if (!res.ok) {
        logger.warn(
          { status: res.status, batch: batch.length },
          "Coinalyze pool ranking batch failed",
        );
        continue;
      }

      const data = (await res.json()) as CoinalyzeResponse;
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        const history = entry.history;
        if (!history || history.length === 0) continue;
        const oiUsd = history[history.length - 1].c ?? 0;
        // Убираем суффикс .A и возвращаем в BingX формат
        const bingxSym = entry.symbol
          .replace(".A", "")
          .replace("USDT_PERP", "-USDT");
        results.push({ symbol: bingxSym, oiUsd });
      }

      await new Promise((r) => setTimeout(r, 150));
    } catch (err) {
      logger.warn({ err }, "Coinalyze pool ranking error");
    }
  }

  results.sort((a, b) => b.oiUsd - a.oiUsd);

  if (results.length > 0) {
    poolRankingCache = results;
    poolRankingCachedAt = Date.now();
    logger.info(
      { count: results.length, requests: requestCount },
      "Coinalyze global OI pool ranking updated",
    );
  } else {
    logger.warn(
      { requestCount },
      "Coinalyze pool ranking returned no data — keeping fallback",
    );
  }

  return results;
}

/**
 * Получить список топ-N монет по изменению OI с Coinalyze.
 * Используется как первичный фильтр перед проверкой на BingX.
 * Возвращает символы в формате BingX (BTC-USDT) с их OI изменением.
 */
export async function getTopOIMovers(
  bingxSymbols: string[],
  minOiChange = 5,
  limit = 20,
): Promise<{ symbol: string; oiChange: number }[]> {
  if (bingxSymbols.length === 0) return [];

  const coinalyzeSymbols = bingxSymbols.map(toBingxCoinalyzeSymbol);
  const batches: string[][] = [];
  for (let i = 0; i < coinalyzeSymbols.length; i += 20) {
    batches.push(coinalyzeSymbols.slice(i, i + 20));
  }

  const results: { symbol: string; oiChange: number }[] = [];

  for (const batch of batches) {
    const apiKey = getActiveKey();
    if (!apiKey) break; // все ключи исчерпаны
    try {
      const res = await marketFetch(
        buildOIUrl(batch, apiKey),
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        },
        { label: "coinalyze:oi-batch" },
      );

      if (!res.ok) continue;

      const data = (await res.json()) as CoinalyzeResponse;
      if (!Array.isArray(data)) continue;

      for (const entry of data) {
        const history = entry.history;
        if (!history || history.length < 2) continue;
        const prev = history[history.length - 2].c;
        const curr = history[history.length - 1].c;
        if (!prev || prev === 0) continue;

        const oiChange = ((curr - prev) / prev) * 100;
        if (Math.abs(oiChange) >= minOiChange) {
          const bingxSym = entry.symbol
            .replace(".A", "")
            .replace("USDT_PERP", "-USDT");
          results.push({ symbol: bingxSym, oiChange });
        }
      }

      await new Promise((r) => setTimeout(r, 200));
    } catch (err) {
      logger.warn({ err }, "Coinalyze batch OI error");
    }
  }

  return results
    .sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange))
    .slice(0, limit);
}

export interface CoinalyzeCandle {
  time: number; // ms
  open: number;
  close: number;
  low: number;
  /** Aggregated cross-exchange perp volume, quote USD (base volume * close). */
  volumeUsd: number;
}

const OHLCV_INTERVALS: Record<string, string> = {
  "15m": "15min",
  "30m": "30min",
  "1h": "1hour",
  "4h": "4hour",
};

/** Aggregated (all exchanges) perp OHLCV from Coinalyze; null when unavailable. */
export async function getCoinalyzeCandles(
  symbol: string,
  interval: "15m" | "30m" | "1h" | "4h",
  fromMs: number,
  toMs: number,
): Promise<CoinalyzeCandle[] | null> {
  const apiKey = getActiveKey();
  if (!apiKey) return null;
  const url = new URL("https://api.coinalyze.net/v1/ohlcv-history");
  url.searchParams.set("symbols", toBingxCoinalyzeSymbol(symbol));
  url.searchParams.set("interval", OHLCV_INTERVALS[interval]!);
  url.searchParams.set("from", String(Math.floor(fromMs / 1000)));
  url.searchParams.set("to", String(Math.floor(toMs / 1000)));
  url.searchParams.set("api_key", apiKey);
  try {
    const res = await marketFetch(
      url.toString(),
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      },
      { label: "coinalyze:ohlcv" },
    );
    if (!res.ok) {
      if (res.status === 429) markKeyExhausted(apiKey);
      return null;
    }
    const data = (await res.json()) as {
      history?: { t: number; o: number; l: number; c: number; v: number }[];
    }[];
    const history = Array.isArray(data) ? data[0]?.history : undefined;
    if (!history?.length) return null;
    return history.map((h) => ({
      time: h.t * 1000,
      open: h.o,
      close: h.c,
      low: h.l,
      volumeUsd: h.v * h.c,
    }));
  } catch {
    return null;
  }
}
