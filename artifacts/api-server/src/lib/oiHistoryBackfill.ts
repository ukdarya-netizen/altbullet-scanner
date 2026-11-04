/**
 * Разовый бэкафилл oi_daily_snapshots после инцидента 2026-07-10 (см.
 * cleanupOiCollisionArtifacts в watcher.ts) — сломанная версия чистки
 * обнулила oi_usd/oi_change_24h у ~376 символов за 2026-07-04..07-09.
 *
 * Вместо ожидания 3 суток естественного накопления новых снимков —
 * подтягиваем реальную историю за 2026-07-08/07-09 из CoinGlass
 * aggregated-history (та же "All exchanges" агрегированная величина, что и
 * обычный ежедневный джоб в whaleTracker.ts — НЕ используем ratio к BingX,
 * никакой эвристики коллизий здесь нет, только чтение реальных прошлых
 * данных) + цену закрытия дня с BingX klines (1d).
 *
 * Идемпотентно: обрабатывает только строки с oi_usd IS NULL, повторный
 * запуск на уже заполненных данных — no-op.
 */
import { db, oiDailySnapshotsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { getKlines } from "./bingx.js";
import { logger } from "./logger.js";
import { cgTimedFetch } from "./cg_latency.js";

interface CgOiHistoryPoint {
  time: number;
  close: string | number;
}

async function fetchCgOiHistory(
  baseSymbol: string,
): Promise<CgOiHistoryPoint[] | null> {
  const key = getNextCgKey();
  if (!key) return null;
  const url = `https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history?symbol=${encodeURIComponent(baseSymbol)}&interval=1d&limit=8`;
  try {
    const res = await cgTimedFetch(
      url,
      { headers: { "CG-API-KEY": key, Accept: "application/json" } },
      {
        priority: "low",
        endpoint: "futures/open-interest/aggregated-history",
      },
    );
    if (res.status === 429) {
      logCg429(key, { baseSymbol });
      return null;
    }
    const json = (await res.json()) as {
      code?: string;
      data?: CgOiHistoryPoint[];
    };
    if (json.code !== "0" || !Array.isArray(json.data)) return null;
    return json.data;
  } catch {
    return null;
  }
}

async function fetchBingxDailyCloseMap(
  symbol: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const klines = await getKlines(symbol, "1d", 8);
    for (const k of klines) {
      const date = new Date(k.time).toISOString().slice(0, 10);
      map.set(date, parseFloat(k.close));
    }
  } catch {
    // best-effort — price_usd остаётся null если не удалось
  }
  return map;
}

/**
 * Небольшой retry-враппер для отдельных DB-вызовов внутри бэкафилла.
 * Neon-пул может кратковременно отваливаться ("Connection terminated due to
 * connection timeout") — без ретрая одна такая ошибка на одном символе рвёт
 * Promise.all всей пачки через processInBatches и роняет весь джоб (см.
 * db-read-retry-helper.md). 2 попытки, короткая пауза — не растягиваем job.
 */
async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err }, "OI history backfill: DB call failed, retrying once");
    await new Promise((r) => setTimeout(r, 1500));
    return await fn();
  }
}

async function processSymbol(
  symbol: string,
): Promise<{ symbol: string; updated: number }> {
  try {
    const baseSymbol = symbol.replace(/-USDT$/, "");
    const [cgHistory, priceMap] = await Promise.all([
      fetchCgOiHistory(baseSymbol),
      fetchBingxDailyCloseMap(symbol),
    ]);
    if (!cgHistory || cgHistory.length === 0) return { symbol, updated: 0 };

    const byDate = new Map<string, number>();
    for (const point of cgHistory) {
      const date = new Date(point.time).toISOString().slice(0, 10);
      const closeVal =
        typeof point.close === "string" ? parseFloat(point.close) : point.close;
      if (Number.isFinite(closeVal) && closeVal > 0) byDate.set(date, closeVal);
    }
    if (byDate.size === 0) return { symbol, updated: 0 };

    const sortedDates = [...byDate.keys()].sort();
    let updated = 0;

    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const oiUsd = byDate.get(date)!;
      const prevDate = sortedDates[i - 1];
      const prevOi = prevDate ? byDate.get(prevDate) : undefined;
      const oiChange24h =
        prevOi != null && prevOi > 0 ? ((oiUsd - prevOi) / prevOi) * 100 : null;
      const priceUsd = priceMap.get(date) ?? null;

      try {
        const existing = await withDbRetry(() =>
          db
            .select({
              id: oiDailySnapshotsTable.id,
              oiUsd: oiDailySnapshotsTable.oiUsd,
            })
            .from(oiDailySnapshotsTable)
            .where(
              and(
                eq(oiDailySnapshotsTable.symbol, symbol),
                eq(oiDailySnapshotsTable.date, date),
              ),
            )
            .limit(1),
        );

        if (existing.length > 0) {
          if (existing[0].oiUsd == null) {
            await withDbRetry(() =>
              db
                .update(oiDailySnapshotsTable)
                .set({ oiUsd, oiChange24h, priceUsd })
                .where(eq(oiDailySnapshotsTable.id, existing[0].id)),
            );
            updated++;
          }
        } else {
          await withDbRetry(() =>
            db
              .insert(oiDailySnapshotsTable)
              .values({ symbol, date, oiUsd, oiChange24h, priceUsd }),
          );
          updated++;
        }
      } catch (err) {
        logger.warn(
          { err, symbol, date },
          "OI history backfill: пропуск даты после повторной ошибки DB",
        );
      }
    }

    return { symbol, updated };
  } catch (err) {
    logger.warn(
      { err, symbol },
      "OI history backfill: пропуск символа после ошибки",
    );
    return { symbol, updated: 0 };
  }
}

/** Обрабатывает символы небольшими пачками, чтобы не упереться в rate-limit CoinGlass. */
async function processInBatches(
  symbols: string[],
  batchSize: number,
): Promise<{ symbol: string; updated: number }[]> {
  const results: { symbol: string; updated: number }[] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(processSymbol));
    for (let j = 0; j < batchResults.length; j++) {
      const r = batchResults[j];
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        logger.warn(
          { err: r.reason, symbol: batch[j] },
          "OI history backfill: символ упал целиком — пропуск",
        );
        results.push({ symbol: batch[j], updated: 0 });
      }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return results;
}

export async function backfillOiHistoryAfterCollisionCleanup(): Promise<void> {
  try {
    let symbols: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const nullRows = await db
          .selectDistinct({ symbol: oiDailySnapshotsTable.symbol })
          .from(oiDailySnapshotsTable)
          .where(isNull(oiDailySnapshotsTable.oiUsd));
        symbols = nullRows.map((r) => r.symbol);
        break;
      } catch (err) {
        logger.warn(
          { err, attempt },
          "OI history backfill: начальный SELECT упал, повтор",
        );
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
        else throw err;
      }
    }

    if (symbols.length === 0) {
      logger.info(
        "OI history backfill: нет символов с NULL oi_usd — нечего заполнять",
      );
      return;
    }

    logger.info({ count: symbols.length }, "OI history backfill: старт");
    const results = await processInBatches(symbols, 8);
    const totalUpdated = results.reduce((s, r) => s + r.updated, 0);
    const failedSymbols = results
      .filter((r) => r.updated === 0)
      .map((r) => r.symbol);

    logger.info(
      {
        symbolsProcessed: symbols.length,
        rowsUpdated: totalUpdated,
        failedCount: failedSymbols.length,
        failedSymbols: failedSymbols.slice(0, 30),
      },
      "OI history backfill: завершён",
    );
  } catch (err) {
    logger.error({ err }, "OI history backfill error");
  }
}
