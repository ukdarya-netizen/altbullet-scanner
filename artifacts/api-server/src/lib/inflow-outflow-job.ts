/**
 * Layer 14: Exchange Inflow/Outflow Monitor.
 *
 * Запускается каждые 30 мин в prod-блоке index.ts.
 *
 * Источники CoinGlass:
 * 1. /api/exchange/chain/tx/list — on-chain переводы (ERC-20 и другие)
 *    transfer_type: 1=inflow на биржу, 2=outflow с биржи, 3=internal
 * 2. /api/exchange_assets_transparency/list — агрегированный баланс бирж (кэш 2ч)
 *
 * Логика:
 * • Outflow (type=2) ≥$2M = вывод токенов с биржи = возможное накопление умных денег
 * • Cross-reference: только токены торгуемые на BingX (фьюч)
 * • Добавить в inflow_outflow_l14_pool (24ч TTL)
 * • Параллельно записывать в candidate_growth_tracking (единый кросс-слойный индекс)
 *
 * Fail-open на все внешние запросы.
 */

import { logger } from "./logger.js";
import { cgTimedFetch } from "./cg_latency.js";
import { db, inflowOutflowL14PoolTable } from "@workspace/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import {
  INFLOW_OUTFLOW_MIN_PCT_OF_MCAP,
  meetsTurnover,
} from "./turnover-threshold.js";
import { getFutureTickers } from "./bingx.js";
import { mapHlSymbolToBingx } from "./hyperliquid_whale.js";

// ── Параметры ─────────────────────────────────────────────────────────────────

const POOL_WINDOW_MS = 24 * 60 * 60 * 1000; // пул 24ч
const TX_CACHE_TTL_MS = 25 * 60 * 1000; // кэш chain/tx 25 мин
const TRANSP_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // кэш transparency 2ч
const DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // дедуп добавления в пул 4ч

// ── Типы ──────────────────────────────────────────────────────────────────────

interface ChainTxRaw {
  symbol?: string;
  usd?: number | string;
  transfer_type?: number | string; // 1=inflow 2=outflow 3=internal
  exchange?: string;
  time?: number | string;
}

interface ExchangeTransparencyRaw {
  exchange_name?: string;
  exchange?: string;
  inflow_usd_24h?: number | string;
  inflow_usd_7d?: number | string;
  balance_usd?: number | string;
}

interface ChainTx {
  coinSymbol: string;
  usdAmount: number;
  type: 1 | 2 | 3; // 1=inflow 2=outflow 3=internal
  exchange: string;
  timestamp: number; // ms
}

export interface ExchangeTransparency {
  exchangeName: string;
  inflow24h: number;
  inflow7d: number;
  balanceUsd: number;
  netOutflow24h: boolean; // inflow24h < 0
}

// ── In-memory пул ─────────────────────────────────────────────────────────────

export interface InflowOutflowEntry {
  id: number;
  symbol: string;
  coinSymbol: string;
  status: string;
  detectedAt: number; // ms
  expiresAt: number; // ms
  entryPrice: number | null;
  currentPrice: number | null; // текущая цена BingX (из последнего job-цикла, ≤30 мин)
  txCount: number;
  totalOutflowUsd: number;
  exchangeName: string;
  transferType: string;
}

/** symbol → entry (только watching) */
const _pool = new Map<string, InflowOutflowEntry>();
let _poolLoaded = false;

/** Транспарентность бирж (обновляется каждые 2ч) */
let _transparency: ExchangeTransparency[] | null = null;
let _transparencyTs = 0;

// ── Кэш chain/tx ──────────────────────────────────────────────────────────────

let _txCache: { data: ChainTx[]; ts: number } | null = null;

// ── BingX symbol set (с TTL) ──────────────────────────────────────────────────

let _bingxSymbols: {
  set: Set<string>;
  priceMap: Map<string, number>;
  ts: number;
} | null = null;
const BINGX_SYMBOLS_TTL = 30 * 60 * 1000;

async function getBingxSymbolData(): Promise<{
  set: Set<string>;
  priceMap: Map<string, number>;
} | null> {
  if (_bingxSymbols && Date.now() - _bingxSymbols.ts < BINGX_SYMBOLS_TTL) {
    return _bingxSymbols;
  }
  try {
    const tickers = await getFutureTickers();
    if (!tickers.length) return _bingxSymbols ?? null;
    const set = new Set<string>(
      tickers.filter((t) => t.symbol.endsWith("-USDT")).map((t) => t.symbol),
    );
    const priceMap = new Map<string, number>();
    for (const t of tickers) {
      if (t.symbol.endsWith("-USDT") && t.lastPrice) {
        priceMap.set(t.symbol, Number(t.lastPrice));
      }
    }
    _bingxSymbols = { set, priceMap, ts: Date.now() };
    return _bingxSymbols;
  } catch {
    return _bingxSymbols ?? null;
  }
}

// ── Fetch exchange/chain/tx/list ──────────────────────────────────────────────

async function fetchChainTxList(): Promise<ChainTx[] | null> {
  if (_txCache && Date.now() - _txCache.ts < TX_CACHE_TTL_MS) {
    return _txCache.data;
  }

  const apiKey = getNextCgKey();
  if (!apiKey) return null;

  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/exchange/chain/tx/list",
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
      { priority: "low", endpoint: "exchange/chain/tx/list" },
    );

    if (res.status === 429) {
      logCg429(apiKey, { endpoint: "exchange/chain/tx/list" });
      return _txCache?.data ?? null;
    }
    if (!res.ok) {
      logger.debug(
        { status: res.status },
        "InflowOutflow: chain/tx/list HTTP error — fail-open",
      );
      return _txCache?.data ?? null;
    }

    const json = (await res.json()) as { code: string; data?: ChainTxRaw[] };
    if (json.code !== "0" || !Array.isArray(json.data)) {
      logger.debug(
        { code: json.code },
        "InflowOutflow: chain/tx/list нет данных — fail-open",
      );
      return _txCache?.data ?? null;
    }

    const now = Date.now();
    const parsed: ChainTx[] = [];
    for (const row of json.data) {
      const typeNum = Number(row.transfer_type ?? 0);
      if (typeNum !== 1 && typeNum !== 2 && typeNum !== 3) continue;
      const usd = Number(row.usd ?? 0);
      if (!usd || usd <= 0) continue;
      const symbol = String(row.symbol ?? "")
        .trim()
        .toUpperCase();
      if (!symbol) continue;
      parsed.push({
        coinSymbol: symbol,
        usdAmount: usd,
        type: typeNum as 1 | 2 | 3,
        exchange: String(row.exchange ?? "unknown"),
        timestamp: row.time ? Number(row.time) * 1000 : now,
      });
    }

    _txCache = { data: parsed, ts: Date.now() };
    return parsed;
  } catch (err) {
    logger.debug(
      { err },
      "InflowOutflow: chain/tx/list fetch exception — fail-open",
    );
    return _txCache?.data ?? null;
  }
}

// ── Fetch exchange_assets_transparency/list ───────────────────────────────────

export async function fetchExchangeTransparency(): Promise<
  ExchangeTransparency[] | null
> {
  if (_transparency && Date.now() - _transparencyTs < TRANSP_CACHE_TTL_MS) {
    return _transparency;
  }

  const apiKey = getNextCgKey();
  if (!apiKey) return _transparency;

  try {
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/exchange_assets_transparency/list",
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      },
      { priority: "low", endpoint: "exchange_assets_transparency/list" },
    );

    if (res.status === 429) {
      logCg429(apiKey, { endpoint: "exchange_assets_transparency/list" });
      return _transparency;
    }
    if (!res.ok) {
      logger.debug(
        { status: res.status },
        "InflowOutflow: transparency HTTP error — fail-open",
      );
      return _transparency;
    }

    const json = (await res.json()) as {
      code: string;
      data?: ExchangeTransparencyRaw[];
    };
    if (json.code !== "0" || !Array.isArray(json.data)) {
      return _transparency;
    }

    const parsed: ExchangeTransparency[] = json.data.map((row) => {
      const inflow24h = Number(row.inflow_usd_24h ?? 0);
      return {
        exchangeName: String(row.exchange_name ?? row.exchange ?? "unknown"),
        inflow24h,
        inflow7d: Number(row.inflow_usd_7d ?? 0),
        balanceUsd: Number(row.balance_usd ?? 0),
        netOutflow24h: inflow24h < 0,
      };
    });

    _transparency = parsed;
    _transparencyTs = Date.now();
    return parsed;
  } catch (err) {
    logger.debug(
      { err },
      "InflowOutflow: transparency fetch exception — fail-open",
    );
    return _transparency;
  }
}

// ── Загрузка пула из БД ───────────────────────────────────────────────────────

export async function loadInflowOutflowPoolFromDb(): Promise<void> {
  try {
    const rows = await db
      .select()
      .from(inflowOutflowL14PoolTable)
      .where(eq(inflowOutflowL14PoolTable.status, "watching"));

    const now = Date.now();
    _pool.clear();
    for (const r of rows) {
      const exp = r.expiresAt.getTime();
      if (exp <= now) continue;
      _pool.set(r.symbol, {
        id: r.id,
        symbol: r.symbol,
        coinSymbol: r.coinSymbol,
        status: r.status,
        detectedAt: r.detectedAt.getTime(),
        expiresAt: exp,
        entryPrice: r.entryPrice ?? null,
        currentPrice: null, // заполняется в getInflowOutflowSnapshot()
        txCount: r.txCount ?? 0,
        totalOutflowUsd: r.totalOutflowUsd ?? 0,
        exchangeName: r.exchangeName ?? "unknown",
        transferType: r.transferType ?? "outflow",
      });
    }
    _poolLoaded = true;
    logger.info({ count: _pool.size }, "InflowOutflow L14: пул загружен из БД");
  } catch (err) {
    logger.warn({ err }, "InflowOutflow L14: загрузка пула из БД не удалась");
  }
}

/**
 * Активные L14 кандидаты для инжекции в скан.
 */
export function getInflowOutflowLayer14Candidates(): {
  symbol: string;
  detectedAt: number;
}[] {
  const now = Date.now();
  return Array.from(_pool.values())
    .filter((e) => e.expiresAt > now)
    .map((e) => ({ symbol: e.symbol, detectedAt: e.detectedAt }));
}

/** Для API-эндпоинта /api/scanner/inflow-outflow */
export function getInflowOutflowSnapshot(): InflowOutflowEntry[] {
  const now = Date.now();
  const priceMap = _bingxSymbols?.priceMap;
  return Array.from(_pool.values())
    .filter((e) => e.expiresAt > now)
    .map((e) => ({
      ...e,
      currentPrice: priceMap?.get(e.symbol) ?? null,
    }))
    .sort((a, b) => b.totalOutflowUsd - a.totalOutflowUsd);
}

/** Снапшот transparency для UI */
export function getTransparencySnapshot(): ExchangeTransparency[] {
  return _transparency ?? [];
}

// ── Основной цикл ─────────────────────────────────────────────────────────────

export async function runInflowOutflowJob(): Promise<void> {
  const jobStart = Date.now();
  logger.info("InflowOutflow L14: запуск цикла");

  try {
    // Загрузить пул если ещё нет
    if (!_poolLoaded) await loadInflowOutflowPoolFromDb();

    // 1. Получить on-chain транзакции
    const txList = await fetchChainTxList();
    if (!txList || txList.length === 0) {
      logger.debug("InflowOutflow L14: нет данных chain/tx — пропускаем цикл");
      return;
    }

    // 2. Параллельно: BingX символы + transparency (для контекста UI)
    const [bingxData] = await Promise.all([
      getBingxSymbolData(),
      fetchExchangeTransparency(),
    ]);

    if (!bingxData) {
      logger.debug("InflowOutflow L14: нет BingX символов — пропускаем");
      return;
    }
    const { set: bingxSet, priceMap } = bingxData;

    // 3. Фильтруем outflow (type=2) ≥ % капитализации
    const { fetchMarketCap } = await import("./whale_watch_v2.js");
    const mcapByCoin = new Map<string, number | null>();
    const outflows: typeof txList = [];
    for (const tx of txList) {
      if (tx.type !== 2) continue;
      if (!mcapByCoin.has(tx.coinSymbol)) {
        mcapByCoin.set(
          tx.coinSymbol,
          (await fetchMarketCap(`${tx.coinSymbol}-USDT`).catch(() => null))
            ?.mcap ?? null,
        );
      }
      const mcap = mcapByCoin.get(tx.coinSymbol) ?? null;
      // Unknown market cap cannot be judged relatively: skip, never flood.
      if (
        mcap != null &&
        meetsTurnover(tx.usdAmount, mcap, INFLOW_OUTFLOW_MIN_PCT_OF_MCAP)
      ) {
        outflows.push(tx);
      }
    }
    if (outflows.length === 0) {
      logger.debug("InflowOutflow L14: нет значимых outflow транзакций в кэше");
      return;
    }

    // 4. Группируем по coinSymbol → суммарный USD, кол-во tx, топ-биржа
    const agg = new Map<
      string,
      { totalUsd: number; txCount: number; exchange: string; ts: number }
    >();
    for (const tx of outflows) {
      const existing = agg.get(tx.coinSymbol);
      if (!existing || tx.usdAmount > (agg.get(tx.coinSymbol)?.totalUsd ?? 0)) {
        if (!existing) {
          agg.set(tx.coinSymbol, {
            totalUsd: tx.usdAmount,
            txCount: 1,
            exchange: tx.exchange,
            ts: tx.timestamp,
          });
        } else {
          agg.set(tx.coinSymbol, {
            totalUsd: existing.totalUsd + tx.usdAmount,
            txCount: existing.txCount + 1,
            exchange: tx.exchange,
            ts: Math.max(existing.ts, tx.timestamp),
          });
        }
      }
    }

    // 5. Cross-reference с BingX
    const now = Date.now();
    let added = 0;
    let skipped = 0;

    for (const [coinSymbol, info] of agg.entries()) {
      // Маппинг coinSymbol → BingX pair
      const bingxSymbol = (() => {
        const direct = `${coinSymbol}-USDT`;
        if (bingxSet.has(direct)) return direct;
        // 1000x prefix (напр. "1000PEPE" → "1000PEPE-USDT")
        if (bingxSet.has(`1000${coinSymbol}-USDT`))
          return `1000${coinSymbol}-USDT`;
        // Через mapHlSymbolToBingx
        const mapped = mapHlSymbolToBingx(coinSymbol, bingxSet);
        return mapped;
      })();

      if (!bingxSymbol) {
        skipped++;
        continue;
      }

      // Дедуп: если уже в пуле, обновляем счётчики
      const existing = _pool.get(bingxSymbol);
      if (existing && existing.expiresAt > now) {
        // Обновляем totalOutflowUsd и txCount в памяти
        existing.totalOutflowUsd += info.totalUsd;
        existing.txCount = (existing.txCount ?? 0) + info.txCount;
        // Обновляем в БД (best-effort)
        db.update(inflowOutflowL14PoolTable)
          .set({
            totalOutflowUsd: existing.totalOutflowUsd,
            txCount: existing.txCount,
          })
          .where(eq(inflowOutflowL14PoolTable.id, existing.id))
          .catch((err) =>
            logger.debug({ err }, "InflowOutflow: обновление пула не удалось"),
          );
        continue;
      }

      // Дедуп: проверяем DEDUP_WINDOW_MS (избегаем флуда при коротком cache TTL)
      const recentDedup =
        existing && now - existing.detectedAt < DEDUP_WINDOW_MS;
      if (recentDedup) {
        skipped++;
        continue;
      }

      // Новый кандидат: добавляем в БД + память
      const entryPrice = priceMap.get(bingxSymbol) ?? null;
      const detectedAt = new Date(now);
      const expiresAt = new Date(now + POOL_WINDOW_MS);

      try {
        const inserted = await db
          .insert(inflowOutflowL14PoolTable)
          .values({
            symbol: bingxSymbol,
            coinSymbol,
            status: "watching",
            detectedAt,
            expiresAt,
            entryPrice,
            txCount: info.txCount,
            totalOutflowUsd: info.totalUsd,
            exchangeName: info.exchange,
            transferType: "outflow",
          })
          .returning({ id: inflowOutflowL14PoolTable.id });

        const newId = inserted[0]?.id ?? 0;
        _pool.set(bingxSymbol, {
          id: newId,
          symbol: bingxSymbol,
          coinSymbol,
          status: "watching",
          detectedAt: now,
          expiresAt: now + POOL_WINDOW_MS,
          entryPrice,
          currentPrice: null,
          txCount: info.txCount,
          totalOutflowUsd: info.totalUsd,
          exchangeName: info.exchange,
          transferType: "outflow",
        });
        added++;

        // Записываем в candidate_growth_tracking (best-effort, ON CONFLICT DO NOTHING)
        db.execute(
          sql`
          INSERT INTO candidate_growth_tracking
            (symbol, detection_source, entry_price, entry_timestamp, status, source_table_id, updated_at)
          VALUES
            (${bingxSymbol}, 'L14', ${entryPrice}, ${detectedAt}, 'watching', ${newId}, NOW())
          ON CONFLICT (symbol, detection_source) WHERE status = 'watching' DO NOTHING
        `,
        ).catch((err) =>
          logger.debug({ err }, "InflowOutflow: CGT insert не удался"),
        );
      } catch (err) {
        logger.debug(
          { err, bingxSymbol },
          "InflowOutflow: insert в пул не удался — fail-open",
        );
      }
    }

    // 6. Экспирация устаревших записей в БД
    try {
      await db
        .update(inflowOutflowL14PoolTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(inflowOutflowL14PoolTable.status, "watching"),
            lt(inflowOutflowL14PoolTable.expiresAt, new Date(now)),
          ),
        );
      // Синхронизируем память
      for (const [sym, entry] of _pool.entries()) {
        if (entry.expiresAt <= now) _pool.delete(sym);
      }
    } catch (err) {
      logger.debug({ err }, "InflowOutflow: очистка expired не удалась");
    }

    // 7. Reconciliation: вносим активные L10/L11 в candidate_growth_tracking
    await reconcileCandidateGrowthTracking();

    logger.info(
      {
        added,
        skipped,
        poolSize: _pool.size,
        durationMs: Date.now() - jobStart,
      },
      "InflowOutflow L14: цикл завершён",
    );
  } catch (err) {
    logger.warn({ err }, "InflowOutflow L14: необработанная ошибка цикла");
  }
}

// ── Reconciliation: синхронизация пулов в candidate_growth_tracking ──────────

async function reconcileCandidateGrowthTracking(): Promise<void> {
  try {
    // L10: liq_cascade_watch (watching)
    await db.execute(sql`
      INSERT INTO candidate_growth_tracking
        (symbol, detection_source, entry_price, entry_timestamp, status, source_table_id, updated_at)
      SELECT
        symbol, 'L10', price_at_detect, detected_at, status, id, NOW()
      FROM liq_cascade_watch
      WHERE status = 'watching'
        AND detected_at > NOW() - INTERVAL '48 hours'
      ON CONFLICT (symbol, detection_source) WHERE status = 'watching' DO NOTHING
    `);

    // Экспирация в CGT: если исходный пул истёк → обновить статус
    await db.execute(sql`
      UPDATE candidate_growth_tracking cgt
      SET status = 'expired', updated_at = NOW()
      WHERE cgt.status = 'watching'
        AND cgt.detection_source = 'L14'
        AND NOT EXISTS (
          SELECT 1 FROM inflow_outflow_l14_pool p
          WHERE p.id = cgt.source_table_id AND p.status = 'watching'
        )
    `);
  } catch (err) {
    logger.debug(
      { err },
      "InflowOutflow: reconciliation CGT не удался — fail-open",
    );
  }
}
