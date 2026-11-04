/**
 * Whale Accumulation Tracker
 *
 * Сохраняет ежедневные снимки OI + объём для всех активных токенов.
 * Анализирует тренды: если OI стабильно растёт несколько недель при плоской цене —
 * это признак китового накопления.
 *
 * Цикл сбора: 1 раз в сутки (в 00:05 UTC).
 * Анализ: запускается при каждом скане (если данных >= 14 дней).
 */

import { db, oiDailySnapshotsTable, oiBaselinesTable } from "@workspace/db";
import { eq, and, gte, sql, inArray } from "drizzle-orm";
import type { CoinglassOIResult } from "./coinglass_oi.js";
import { logger } from "./logger.js";

const TODAY_UTC = () => new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

// ── Snapshot collection ──────────────────────────────────────────────────────

/**
 * Сохраняет дневной снимок OI для всех символов.
 * Pass 1: CoinGlass (preferred — имеет oiChange24h от CG).
 * Pass 2: oi_baselines-fallback для токенов, где CG тайм-аутнул или не вернул данные.
 *   Читает из таблицы oi_baselines (обновляется каждый скан-цикл).
 *   oiChange24h вычисляется из вчерашнего снапшота (если есть).
 * Вызывается один раз в сутки. Дубли (один символ + одна дата) игнорируются.
 * Batch-подход: один SELECT для "уже сохранено сегодня", один SELECT вчера — вместо
 * 500 отдельных SELECT (оригинал делал per-symbol запрос для каждого токена).
 */
export async function saveDailyOiSnapshots(
  batchData: Map<string, CoinglassOIResult>,
  priceMap: Map<string, number>,
  volume24hMap: Map<string, number>,
): Promise<{ saved: number; skipped: number }> {
  const date = TODAY_UTC();

  // Вчерашняя дата для вычисления oiChange24h у BingX-fallback токенов
  const ydDate = new Date();
  ydDate.setUTCDate(ydDate.getUTCDate() - 1);
  const yesterday = ydDate.toISOString().slice(0, 10);

  // Один batch-запрос: все символы уже сохранённые сегодня
  const todayRows = await db
    .select({ symbol: oiDailySnapshotsTable.symbol })
    .from(oiDailySnapshotsTable)
    .where(eq(oiDailySnapshotsTable.date, date));
  const alreadySaved = new Set(todayRows.map((r) => r.symbol));

  // Один batch-запрос: вчерашние OI для вычисления oiChange24h
  const yesterdayRows = await db
    .select({
      symbol: oiDailySnapshotsTable.symbol,
      oiUsd: oiDailySnapshotsTable.oiUsd,
    })
    .from(oiDailySnapshotsTable)
    .where(eq(oiDailySnapshotsTable.date, yesterday));
  const prevOiMap = new Map(yesterdayRows.map((r) => [r.symbol, r.oiUsd]));

  const toInsert: (typeof oiDailySnapshotsTable.$inferInsert)[] = [];

  // ── Pass 1: CoinGlass (preferred) ──────────────────────────────────────────
  for (const [symbol, oi] of batchData.entries()) {
    if (!oi.available || oi.oiUsd == null) continue;
    if (alreadySaved.has(symbol)) continue;
    toInsert.push({
      symbol,
      date,
      oiUsd: oi.oiUsd,
      oiChange24h: oi.oiChange24h ?? null,
      priceUsd: priceMap.get(symbol) ?? null,
      volume24h: volume24hMap.get(symbol) ?? null,
    });
    alreadySaved.add(symbol); // не дублируем в Pass 2
  }

  // ── Pass 2: oi_baselines-fallback для CG-timeout токенов ──────────────────
  // Читаем из БД реальные OI-значения для символов, которые не покрыл CG.
  // oi_baselines обновляется каждый скан-цикл (refreshOiBaselines), поэтому данные
  // актуальны — в отличие от ticker.openInterestSize который возвращает 0 у большинства.
  let baselineFallbackSaved = 0;
  {
    // Символы, которые не спасли ни CG, ни уже-сохранённые
    const cgSymbols = new Set(
      [...batchData.entries()]
        .filter(([, oi]) => oi.available && oi.oiUsd != null)
        .map(([sym]) => sym),
    );
    const needFallback = [...batchData.keys()].filter(
      (sym) => !alreadySaved.has(sym) && !cgSymbols.has(sym),
    );

    if (needFallback.length > 0) {
      const baselineRows = await db
        .select({ symbol: oiBaselinesTable.symbol, oi: oiBaselinesTable.oi })
        .from(oiBaselinesTable)
        .where(inArray(oiBaselinesTable.symbol, needFallback));

      for (const { symbol, oi: oiUsd } of baselineRows) {
        if (alreadySaved.has(symbol)) continue;
        if (!oiUsd || oiUsd <= 0) continue;

        const prevOi = prevOiMap.get(symbol);
        const oiChange24h =
          prevOi != null && prevOi > 0
            ? ((oiUsd - prevOi) / prevOi) * 100
            : null;

        toInsert.push({
          symbol,
          date,
          oiUsd,
          oiChange24h,
          priceUsd: priceMap.get(symbol) ?? null,
          volume24h: volume24hMap.get(symbol) ?? null,
        });
        alreadySaved.add(symbol);
        baselineFallbackSaved++;
      }
    }
  }

  // Bulk insert по 100 строк (избегаем oversized query при 500+ токенах)
  const CHUNK = 100;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    await db.insert(oiDailySnapshotsTable).values(toInsert.slice(i, i + CHUNK));
  }

  const saved = toInsert.length;
  const cgAvailable = [...batchData.values()].filter(
    (o) => o.available && o.oiUsd != null,
  ).length;
  const cgTimedOut = batchData.size - cgAvailable;
  logger.info(
    {
      date,
      saved,
      cgAvailable,
      cgTimedOut,
      baselineFallback: baselineFallbackSaved,
    },
    "🐋 Daily OI snapshots saved",
  );
  return { saved, skipped: batchData.size - saved };
}

// ── Whale analysis ────────────────────────────────────────────────────────────

export interface WhaleAccumResult {
  symbol: string;
  daysTracked: number;
  oiGrowthPct: number; // OI % change from first to last snapshot
  priceChangePct: number; // Price % change over same period
  oiGrowthPerDay: number; // Average daily OI growth %
  positiveDays: number; // How many days had positive OI change24h
  totalDays: number;
  consistencyPct: number; // positiveDays / totalDays * 100
  avgVolRatio: number; // avg volume vs first-week avg (volume building signal)
  isWhaleAccum: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

/**
 * Анализирует исторические снимки для одного символа.
 * Возвращает null если данных недостаточно (< 14 дней).
 */
export async function analyzeWhaleAccumulation(
  symbol: string,
): Promise<WhaleAccumResult | null> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90); // берём до 90 дней

  const snapshots = await db
    .select()
    .from(oiDailySnapshotsTable)
    .where(
      and(
        eq(oiDailySnapshotsTable.symbol, symbol),
        gte(oiDailySnapshotsTable.takenAt, cutoff),
      ),
    )
    .orderBy(oiDailySnapshotsTable.date);

  if (snapshots.length < 14) return null; // нужно минимум 2 недели

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const daysTracked = snapshots.length;

  if (!first.oiUsd || !last.oiUsd || first.oiUsd === 0) return null;

  // OI рост от начала к концу периода
  const oiGrowthPct = ((last.oiUsd - first.oiUsd) / first.oiUsd) * 100;

  // Изменение цены за период
  const priceChangePct =
    first.priceUsd && last.priceUsd && first.priceUsd > 0
      ? ((last.priceUsd - first.priceUsd) / first.priceUsd) * 100
      : 0;

  // Средний дневной рост OI
  const oiGrowthPerDay = oiGrowthPct / daysTracked;

  // Сколько дней был положительный oiChange24h (накопление, не распределение)
  const positiveDays = snapshots.filter((s) => (s.oiChange24h ?? 0) > 0).length;
  const consistencyPct = (positiveDays / daysTracked) * 100;

  // Сравниваем средний объём первой недели vs последней недели
  const firstWeek = snapshots.slice(0, 7).filter((s) => s.volume24h != null);
  const lastWeek = snapshots.slice(-7).filter((s) => s.volume24h != null);
  const firstVolAvg =
    firstWeek.length > 0
      ? firstWeek.reduce((s, r) => s + (r.volume24h ?? 0), 0) / firstWeek.length
      : 0;
  const lastVolAvg =
    lastWeek.length > 0
      ? lastWeek.reduce((s, r) => s + (r.volume24h ?? 0), 0) / lastWeek.length
      : 0;
  const avgVolRatio = firstVolAvg > 0 ? lastVolAvg / firstVolAvg : 1;

  // ── Критерии китового накопления ─────────────────────────────────────────
  // 1. OI вырос минимум на 15% за период
  // 2. Цена не выросла сильно (< 15%) — значит накопление ещё не реализовалось
  // 3. Накопление устойчивое: > 55% дней с позитивным OI
  const oiGrowing = oiGrowthPct >= 15;
  const priceSuppressed = priceChangePct < 15;
  const consistent = consistencyPct >= 55;
  const volumeBuilding = avgVolRatio >= 1.2; // объём в последнюю неделю на 20% выше первой

  const isWhaleAccum = oiGrowing && priceSuppressed && consistent;

  // Уверенность
  let confidence: "high" | "medium" | "low" = "low";
  let reason = "";

  if (isWhaleAccum) {
    if (oiGrowthPct >= 40 && consistencyPct >= 65 && volumeBuilding) {
      confidence = "high";
      reason = `OI +${oiGrowthPct.toFixed(0)}% за ${daysTracked}д при цене ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(0)}%, объём растёт (${avgVolRatio.toFixed(1)}x)`;
    } else if (oiGrowthPct >= 25 && consistencyPct >= 60) {
      confidence = "medium";
      reason = `OI +${oiGrowthPct.toFixed(0)}% за ${daysTracked}д при цене ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(0)}%`;
    } else {
      confidence = "low";
      reason = `Слабые признаки: OI +${oiGrowthPct.toFixed(0)}% за ${daysTracked}д`;
    }
  }

  return {
    symbol,
    daysTracked,
    oiGrowthPct,
    priceChangePct,
    oiGrowthPerDay,
    positiveDays,
    totalDays: daysTracked,
    consistencyPct,
    avgVolRatio,
    isWhaleAccum,
    confidence,
    reason,
  };
}

/**
 * Быстрая проверка: есть ли по символу достаточно данных для whale-анализа?
 */
export async function hasEnoughWhaleData(symbol: string): Promise<boolean> {
  const result = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(oiDailySnapshotsTable)
    .where(eq(oiDailySnapshotsTable.symbol, symbol));
  return Number(result[0]?.cnt ?? 0) >= 14;
}

/**
 * Возвращает все символы с активным whale accumulation (HIGH или MEDIUM confidence).
 * Используется для ежедневного отчёта.
 */
export async function getAllWhaleAccumCandidates(): Promise<
  WhaleAccumResult[]
> {
  // Получаем список символов с >= 14 снимками
  const symbolsWithData = await db
    .selectDistinct({ symbol: oiDailySnapshotsTable.symbol })
    .from(oiDailySnapshotsTable)
    .groupBy(oiDailySnapshotsTable.symbol)
    .having(sql`count(*) >= 14`);

  const results: WhaleAccumResult[] = [];
  for (const { symbol } of symbolsWithData) {
    const analysis = await analyzeWhaleAccumulation(symbol);
    if (analysis?.isWhaleAccum && analysis.confidence !== "low") {
      results.push(analysis);
    }
  }

  // Сортируем по силе: сначала высокая уверенность + больший рост OI
  return results.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === "high" ? -1 : 1;
    }
    return b.oiGrowthPct - a.oiGrowthPct;
  });
}

export interface EarlyWhaleCandidate {
  symbol: string;
  days: number;
  oiGrowthPct: number;
  priceChangePct: number;
  oiNowUsd: number;
}

/**
 * Ранний отчёт по накоплению OI — когда данных ещё < 14 дней.
 * Берём топ символов у которых OI вырос >= 15% при цене < 15%.
 * Минимум 3 снапшота чтобы отфильтровать однодневный шум.
 */
export async function getEarlyWhaleCandidates(): Promise<
  EarlyWhaleCandidate[]
> {
  const rows = await db.execute<{
    symbol: string;
    days: string;
    oi_growth: string;
    price_chg: string;
    oi_now: string;
  }>(sql`
    WITH ranked AS (
      SELECT symbol, date, oi_usd, price_usd,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date ASC)  AS rn_first,
        ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn_last,
        COUNT(*)     OVER (PARTITION BY symbol)                    AS total_days
      FROM oi_daily_snapshots
      WHERE oi_usd IS NOT NULL AND oi_usd > 0
    )
    SELECT
      f.symbol,
      f.total_days::int                                                         AS days,
      ROUND(((l.oi_usd - f.oi_usd) / NULLIF(f.oi_usd, 0) * 100)::numeric, 1)  AS oi_growth,
      ROUND(((l.price_usd - f.price_usd) / NULLIF(f.price_usd, 0) * 100)::numeric, 1) AS price_chg,
      ROUND((l.oi_usd / 1e6)::numeric, 1)                                       AS oi_now
    FROM ranked f
    JOIN ranked l ON f.symbol = l.symbol AND l.rn_last = 1
    WHERE f.rn_first = 1
      AND f.total_days >= 3
      AND f.total_days <= 13
      AND ((l.oi_usd - f.oi_usd) / NULLIF(f.oi_usd, 0) * 100) >= 15
      AND ((l.price_usd - f.price_usd) / NULLIF(f.price_usd, 0) * 100) > -15
      AND ((l.price_usd - f.price_usd) / NULLIF(f.price_usd, 0) * 100) < 15
      AND l.oi_usd >= 10e6
      AND l.oi_usd <= 10e9
    ORDER BY ((l.oi_usd - f.oi_usd) / NULLIF(f.oi_usd, 0)) DESC
    LIMIT 15
  `);

  return rows.rows.map((r) => ({
    symbol: r.symbol,
    days: Number(r.days),
    oiGrowthPct: Number(r.oi_growth),
    priceChangePct: Number(r.price_chg),
    oiNowUsd: Number(r.oi_now),
  }));
}

// ── Daily alert dedup ─────────────────────────────────────────────────────────
// Хранит символы которым уже отправили whale-алерт сегодня (сбрасывается на следующий день).
const dailyAlertedSymbols = new Map<string, string>(); // symbol → YYYY-MM-DD

/**
 * Проверяет новых whale кандидатов и возвращает только тех, кому ещё не отправляли алерт
 * в течение последних 6 дней. Используется для ежедневных уведомлений.
 */
export async function getNewWhaleCandidatesForAlert(): Promise<
  WhaleAccumResult[]
> {
  const candidates = await getAllWhaleAccumCandidates();
  const today = TODAY_UTC();
  const sixDaysAgo = new Date(Date.now() - 6 * 86400_000)
    .toISOString()
    .slice(0, 10);

  const fresh: WhaleAccumResult[] = [];
  for (const c of candidates) {
    const lastAlerted = dailyAlertedSymbols.get(c.symbol);
    // Пропускаем если уже алертили в течение 6 дней
    if (lastAlerted && lastAlerted >= sixDaysAgo) continue;
    dailyAlertedSymbols.set(c.symbol, today);
    fresh.push(c);
  }
  return fresh;
}

/**
 * Сколько символов уже имеет достаточно данных для whale-анализа?
 */
export async function getWhaleDataCoverage(): Promise<{
  total: number;
  ready: number;
  oldestDate: string | null;
}> {
  // Drizzle не пробрасывает алиас window-функции в внешний запрос автоматически,
  // поэтому пишем весь запрос через sql`` чтобы избежать "column cnt does not exist".
  const rows = await db.execute<{
    total: string;
    ready: string;
    oldest: string | null;
  }>(sql`
    select
      count(distinct symbol)::int                                           as total,
      count(distinct symbol) filter (where cnt >= 14)::int                 as ready,
      min(date)                                                             as oldest
    from (
      select symbol, date, count(*) over (partition by symbol) as cnt
      from oi_daily_snapshots
    ) sub
  `);
  const stats = rows.rows;

  return {
    total: Number(stats[0]?.total ?? 0),
    ready: Number(stats[0]?.ready ?? 0),
    oldestDate: stats[0]?.oldest ?? null,
  };
}
