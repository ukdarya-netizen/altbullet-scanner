/**
 * CoinGlass — Whale Index (BTC, 4h) как рыночный контекст.
 *
 * Endpoint: GET /api/futures/whale-index/history
 *   ?exchange=Binance&symbol=BTCUSDT&interval=4h&limit=2
 * Ответ: [{ time, whale_index_value }] — наблюдаемый диапазон ≈ −15…+17.
 * Положительное значение = киты накапливают, отрицательное = распродают.
 *
 * Модульный кэш обновляется фоновым таймером (startWhaleIndexUpdater из
 * watcher.ts), синхронный геттер getWhaleIndexLine() используется в
 * telegram.ts formatAlphaSignal (функция синхронная — HTTP там невозможен).
 *
 * Fail-open: строка просто не показывается если данных нет/стейл (>3ч).
 *
 * ⚠️ Проверка пользы (2026-07-14, 135 сигналов за 3 недели): предиктивной
 * ценности НЕТ. Сырая корреляция WI↔peak% = -0.26 полностью объясняется
 * временным трендом (WI↔time r=0.82); частичная корреляция с контролем
 * времени = -0.07, по неделям ≈ 0. Индекс НЕ использовать в alphaScore —
 * оставлен как информационная строка. Наблюдаемый диапазон на деле
 * -181…+17 (не -15…+17), т.е. пороги ±3 почти всегда дают "киты продают".
 */

import { logger } from "./logger.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import type { CoinglassPriority } from "./coinglass_governor.js";

const REFRESH_MS = 30 * 60 * 1000; // обновление раз в 30 мин
const STALE_MS = 3 * 60 * 60 * 1000; // >3ч без обновления → не показываем
const FIRST_RUN_MS = 20 * 1000; // первый фетч через 20с после старта

let _cache: { value: number; time: number; fetchedAt: number } | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

async function fetchWhaleIndex(): Promise<void> {
  const apiKey = getNextCgKey();
  if (!apiKey) return;

  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/whale-index/history",
  );
  url.searchParams.set("exchange", "Binance");
  url.searchParams.set("symbol", "BTCUSDT");
  url.searchParams.set("interval", "4h");
  url.searchParams.set("limit", "2");

  try {
    const res = await cgTimedFetch(url.toString(), {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 429) {
      logCg429(apiKey, { endpoint: "whale-index/history" });
      return;
    }
    if (!res.ok) {
      logger.debug(
        { status: res.status },
        "fetchWhaleIndex: HTTP error — fail-open",
      );
      return;
    }
    const json = (await res.json()) as {
      code: string;
      data?: { time: number; whale_index_value: number }[];
    };
    if (
      json.code !== "0" ||
      !Array.isArray(json.data) ||
      json.data.length === 0
    )
      return;

    // Последняя свеча = самая свежая (сортируем на всякий случай)
    const latest = [...json.data].sort((a, b) => b.time - a.time)[0]!;
    const value = Number(latest.whale_index_value);
    if (!Number.isFinite(value)) return;

    _cache = { value, time: latest.time, fetchedAt: Date.now() };
    logger.debug(
      { value, candleTime: latest.time },
      "WhaleIndex: cache updated",
    );
  } catch (err) {
    logger.debug(
      { err: String(err) },
      "fetchWhaleIndex: fetch error — fail-open",
    );
  }
}

/** Запускает фоновое обновление кэша Whale Index. Вызывается один раз из startWatcher(). */
export function startWhaleIndexUpdater(): void {
  if (_timer) return; // уже запущен
  const run = async () => {
    await fetchWhaleIndex();
    _timer = setTimeout(run, REFRESH_MS);
  };
  _timer = setTimeout(run, FIRST_RUN_MS);
  logger.info("WhaleIndex updater scheduled (30min, first run at 20s)");
}

/** Сырое значение из кэша (null = нет данных / стейл). */
export function getCachedWhaleIndex(): number | null {
  if (!_cache) return null;
  if (Date.now() - _cache.fetchedAt > STALE_MS) return null;
  return _cache.value;
}

/** Numeric market context plus provenance for observational persistence only. */
export function getCachedWhaleIndexSnapshot(): {
  value: number;
  candleAt: Date;
  fetchedAt: Date;
} | null {
  if (!_cache || Date.now() - _cache.fetchedAt > STALE_MS) return null;
  return {
    value: _cache.value,
    candleAt: new Date(_cache.time),
    fetchedAt: new Date(_cache.fetchedAt),
  };
}

/**
 * Готовая info-строка для Telegram-алертов (sync).
 * null = данных нет — строка просто не добавляется.
 */
export function getWhaleIndexLine(): string | null {
  const v = getCachedWhaleIndex();
  if (v == null) return null;
  const sign = v >= 0 ? "+" : "";
  const mood =
    v >= 3 ? "киты покупают 🟢" : v <= -3 ? "киты продают 🔴" : "нейтрально ⚪";
  return `🐳 <b>Whale Index</b> (BTC, 4ч): ${sign}${v.toFixed(1)} — ${mood}`;
}

// ── Пер-токенный Whale Index (2026-07-15) ───────────────────────────────────
// Тот же эндпоинт, но по конкретной паре Binance-фьючерсов. Тянется ТОЛЬКО в
// момент выстрела сигнала (единицы запросов в час): строка в алерте +
// entryWhaleIndex в tracked_signals для проверки предиктивности (2-3 недели).
// Покрытие неполное: BingX-эксклюзивы и часть мелких токенов (напр. PEPE →
// HTTP 500) данных не имеют — fail-open, null кэшируется чтобы не долбить API.
// ⚠️ Наблюдаемый диапазон по альтам шире BTC (видели −98…+21) — пороги
// настроения ±10 условные, до статистики индекс информационный.

const TOKEN_WI_TTL_MS = 10 * 60 * 1000; // повторный запрос по тому же токену не чаще 10 мин
const TOKEN_WI_NULL_TTL_MS = 60 * 60 * 1000; // нет данных (500/пусто) — не переспрашиваем час
const TOKEN_WI_TIMEOUT_MS = 4000;
const _tokenCache = new Map<
  string,
  { value: number | null; fetchedAt: number }
>();

/** Whale Index по конкретному токену (BingX-символ, напр. "SOL-USDT"). null = нет данных. */
export async function getTokenWhaleIndex(
  bingxSymbol: string,
  options: { priority?: CoinglassPriority } = {},
): Promise<number | null> {
  const base = bingxSymbol.replace("-USDT", "");
  const cached = _tokenCache.get(base);
  if (cached) {
    const ttl = cached.value == null ? TOKEN_WI_NULL_TTL_MS : TOKEN_WI_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) return cached.value;
  }

  const apiKey = getNextCgKey();
  if (!apiKey) return null;

  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/whale-index/history",
  );
  url.searchParams.set("exchange", "Binance");
  url.searchParams.set("symbol", `${base}USDT`);
  url.searchParams.set("interval", "4h");
  url.searchParams.set("limit", "2");

  let value: number | null = null;
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(TOKEN_WI_TIMEOUT_MS),
      },
      { priority: options.priority, endpoint: "futures/whale-index/history" },
    );
    if (res.status === 429) {
      logCg429(apiKey, { endpoint: "whale-index/history", symbol: base });
      return null; // не кэшируем — временная проблема ключа
    }
    if (res.ok) {
      const json = (await res.json()) as {
        code: string;
        data?: { time: number; whale_index_value: number }[];
      };
      if (
        json.code === "0" &&
        Array.isArray(json.data) &&
        json.data.length > 0
      ) {
        const latest = [...json.data].sort((a, b) => b.time - a.time)[0]!;
        const v = Number(latest.whale_index_value);
        if (Number.isFinite(v)) value = v;
      }
    }
  } catch (err) {
    logger.debug(
      { symbol: base, err: String(err) },
      "getTokenWhaleIndex: fetch error — fail-open",
    );
    return null; // сетевые ошибки/таймауты не кэшируем
  }

  _tokenCache.set(base, { value, fetchedAt: Date.now() });
  return value;
}

/**
 * Диагностический геттер: возвращает значение из _tokenCache БЕЗ проверки TTL.
 * Используется для различения двух случаев null у getTokenWhaleIndex():
 *   - undefined → токен никогда не проходил через WI-апдейтер (нет данных совсем)
 *   - null      → был запрос, CoinGlass не вернул данные (но кэш есть)
 *   - number    → есть stale значение (кэш есть, TTL истёк, live-запрос упал с timeout)
 * Не использовать для gate-проверок — только для логирования lag vs no-data.
 */
export function getCachedTokenWi(
  bingxSymbol: string,
): number | null | undefined {
  const base = bingxSymbol.replace("-USDT", "");
  const entry = _tokenCache.get(base);
  if (!entry) return undefined; // никогда не запрашивали
  return entry.value; // null или число, независимо от TTL
}

/** Info-строка пер-токенного Whale Index для алерта. null = данных нет — строка пропускается. */
export function formatTokenWhaleIndexLine(
  bingxSymbol: string,
  v: number | null | undefined,
): string | null {
  if (v == null) return null;
  const base = bingxSymbol.replace("-USDT", "");
  const sign = v >= 0 ? "+" : "";
  const mood =
    v >= 10
      ? "киты накапливают 🟢"
      : v <= -10
        ? "киты распродают 🔴"
        : "нейтрально ⚪";
  return `🐳 <b>Whale Index</b> (${base}, 4ч): ${sign}${v.toFixed(1)} — ${mood}`;
}
