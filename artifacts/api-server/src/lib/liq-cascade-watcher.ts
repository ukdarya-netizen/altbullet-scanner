/**
 * Layer 10 — Liquidation Cascade Watch
 *
 * Запускается каждые 3 мин независимо от основного scan-цикла.
 * Детектирует ликвидационные спайки (liq_spike path) и реал-тайм
 * liq order stream. Ценовой дамп-фильтр (price24h ≤ -7%) удалён —
 * ликвидационные данные сами по себе являются первичным сигналом.
 *
 * Источники попадания в пул:
 *   liq_spike:        longLiq1h/longLiq24h ≥ 25% + longLiq1h > $50K (batch CG)
 *   liq_order_stream: ≥3 long-liq ордеров ≥$10K за 15 мин (realtime stream)
 *
 * Найденные кандидаты:
 *   1) Сохраняются в liq_cascade_watch с snapshot данными.
 *   2) После каждого цикла _runLiqCascadeFireCycle() (в watcher.ts) проверяет
 *      пул и выдаёт liquidation_cascade сигнал напрямую (Path B) — без ожидания
 *      основного сканера. getLiqCascadeLayer10Candidates() экспортирует активные записи.
 *
 * Статусы записи:
 *   watching → ожидаем сигнала (12ч окно)
 *   fired    → liquidation_cascade сигнал выдан (tracked_signals матч, auto-cleanup)
 *   expired  → истёк без сигнала → пишем в missed_signals_log
 *
 * Данные вкладки "Layer 10 Liquidation Cascade":
 *   OI 30m/1h/4h (snapshot at detect + live из Path B fire cycle)
 *   Spot Vol 24h + mult
 *   CVD 30m/1h/4h
 *   Цена на момент попадания + текущая цена + % от входа
 *   Spot Vol / MCap
 *   Строка статуса
 */

import {
  aggregatedVolume24hUsd,
  refreshAggregatedVolume24h,
} from "./coinglass_vol24h.js";
import { logger } from "./logger.js";
import { fetchMarketCap } from "./whale_watch_v2.js";
import {
  belowPctOfMcap,
  LC_LIQ_SPIKE_MIN_PCT_OF_MCAP,
  LC_MIN_QUOTE_VOL_PCT_OF_MCAP,
  LC_ORDER_STREAM_MIN_PCT_OF_MCAP,
} from "./turnover-threshold.js";

async function lcMcap(symbol: string): Promise<number | null> {
  return (await fetchMarketCap(symbol).catch(() => null))?.mcap ?? null;
}
import {
  db,
  liqCascadeWatchTable,
  lcObWaitTable,
  trackedSignalsTable,
  marketCapCacheTable,
  prescanTrackerTable,
} from "@workspace/db";
import {
  eq,
  and,
  lt,
  gte,
  inArray,
  sql,
  gt,
  lte,
  asc,
  ne,
  or,
} from "drizzle-orm";
import { getFutureTickers, getKlines } from "./bingx.js";
import type { BingXTicker } from "./bingx.js";
import {
  fetchLiqCoinList,
  getCachedLiqData,
  getCachedLiqDataEx,
  fetchLiqOrders,
  getLiqOrderStats,
  getLiqOrderLongLeaders,
} from "./coinglass_liquidation.js";
import { getGlobalAccountRatio } from "./coinglass_global_ratio.js";
import { getCoinglassOI } from "./coinglass_oi.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import {
  liqCascadeRejectedDecisionEventKey,
  recordPatternDecisionEventsBatch,
  type PatternDecisionEventInput,
} from "./pattern-decision-history.js";
import { withMarketCycleLease } from "./schedulerLease.js";
import {
  recordLiqCascadeObservation,
  recordLiqCascadeWatchStart,
} from "./liq-cascade-observation.js";

// ── Константы ──────────────────────────────────────────────────────────────────
const WATCH_WINDOW_MS = 12 * 60 * 60 * 1000; // 12ч окно наблюдения
const DEDUP_MS = 12 * 60 * 60 * 1000; // не добавлять символ повторно в течение 12ч

/** Минимальный 24ч объём (USD) — фильтр ликвидности */
const _liqRejectedDecisionBuffer = new Map<string, PatternDecisionEventInput>();

// ── Liq-spike триггер (PRIMARY) ────────────────────────────────────────────────
/** Минимальный longLiq1h (USD) — абс. порог, отсекает нули */
/** Соотношение longLiq1h / longLiq24h для детекции спайка.
 *  Анализ 90д: bucket 25-35% = худший avg pnl (−6.0%); ≥35% значительно лучше → 0.35 */
const LIQ_SPIKE_RATIO = 0.35;
/** Не ловим памп-токены (long-сквиз при росте — не каскад) */
const LIQ_SPIKE_P24H_MAX = 5.0;

// ── Ранний триггер по liq order stream ────────────────────────────────────────
/** Минимум long-liq ордеров ≥$10K за 15-мин окно.
 *  Анализ 90д: 78% cancel rate при 3 → повышаем до 5. */
const ORDER_STREAM_MIN_COUNT = 5;
/** Минимальная сумма long-liq за 15-мин окно (USD).
 *  Анализ 90д: 78% cancel rate при $30K → повышаем до $100K. */
/** Требуем реальное падение ≥1% за 1ч — реальный каскад, не шум.
 *  1h цена вычисляется через getKlines(2×1h) перед отбором кандидатов (fail-open). */
const ORDER_STREAM_PRICE_DUMP_1H_MIN = -1.0;
/** Резервный фильтр (klines недоступны): p24h ≤ -2%. */
const ORDER_STREAM_PRICE_DUMP_MIN = -2.0;

// ── In-memory Layer 10 кандидаты ──────────────────────────────────────────────
// Источник для getLiqCascadeLayer10Candidates().
type WatchEntry = {
  watchId: number;
  detectedAt: number;
  liqExhausted: boolean | null;
  entryReason: string;
  longLiq1hAtDetect: number | null;
  longLiq24hAtDetect: number | null;
  cycleCountAtDetect: number | null;
};
const _watchMap = new Map<string, WatchEntry>();

// Last Layer 10 fire-stage decision per symbol, so every scan cycle can log
// the real LC reason instead of silence.
const _lcLastDecision = new Map<
  string,
  { watchId: number; reason: string; at: number }
>();

const LC_BTC_LIQ_SPIKE_MIN_USD = 50_000;

export function recordLcDecisionReason(
  symbol: string,
  watchId: number,
  reason: string,
): void {
  _lcLastDecision.set(symbol, { watchId, reason, at: Date.now() });
}

/** Exact LC state for a symbol, for scan_reject_log (never empty). */
export function describeLcStateForScan(symbol: string): string {
  const watch = _watchMap.get(symbol);
  if (!watch || watch.detectedAt < Date.now() - WATCH_WINDOW_MS) {
    return "lc_no_active_watch_no_cascade_detected";
  }
  const last = _lcLastDecision.get(symbol);
  const ageMin = Math.round((Date.now() - watch.detectedAt) / 60_000);
  const tail =
    last && last.watchId === watch.watchId
      ? `last_reject=${last.reason}`
      : "no_fire_decision_yet";
  return `lc_watch_active_${ageMin}m:${tail}`;
}

// ── Флаги ─────────────────────────────────────────────────────────────────────
let _initialized = false;
let _running = false;

// ── Public API ─────────────────────────────────────────────────────────────────

export type LiqCascadeL10Entry = {
  watchId: number;
  symbol: string;
  detectedAt: number;
  liqExhausted: boolean | null;
  entryReason: string;
  longLiq1hAtDetect: number | null;
  longLiq24hAtDetect: number | null;
  /** Кол-во prescan-циклов токена в момент обнаружения liq-каскада.
   *  null = токен был вне prescan_tracker (крупный кэп) или данные недоступны. */
  cycleCountAtDetect: number | null;
};

/**
 * Возвращает активных Layer 10 кандидатов для инжекции в основной scan-цикл.
 * Вызывается из scanner.ts в начале каждого prescan-цикла.
 * Включает liqExhausted и entryReason для per-symbol паттерн-гейта.
 */
export function getLiqCascadeLayer10Candidates(): LiqCascadeL10Entry[] {
  const now = Date.now();
  const cutoff = now - WATCH_WINDOW_MS;
  const result: LiqCascadeL10Entry[] = [];
  for (const [symbol, entry] of _watchMap.entries()) {
    if (entry.detectedAt >= cutoff) {
      result.push({
        watchId: entry.watchId,
        symbol,
        detectedAt: entry.detectedAt,
        liqExhausted: entry.liqExhausted,
        entryReason: entry.entryReason,
        longLiq1hAtDetect: entry.longLiq1hAtDetect,
        longLiq24hAtDetect: entry.longLiq24hAtDetect,
        cycleCountAtDetect: entry.cycleCountAtDetect,
      });
    } else {
      _watchMap.delete(symbol);
    }
  }
  return result;
}

// ── Main job ──────────────────────────────────────────────────────────────────

function recordLiqDetectorRejection(input: {
  symbol: string;
  reason: string;
  observedAt: Date;
  entryPrice: number | null;
  metrics: Record<string, number | null>;
}): void {
  const bucket = Math.floor(input.observedAt.getTime() / DEDUP_MS);
  const eventKey = liqCascadeRejectedDecisionEventKey(
    input.symbol,
    bucket,
    input.reason,
  );
  _liqRejectedDecisionBuffer.set(eventKey, {
    eventKey,
    symbol: input.symbol,
    patternKey: "liquidation_cascade",
    decisionKind: "rejected",
    reason: input.reason,
    decisionAt: input.observedAt,
    entryPrice: input.entryPrice,
    metrics: input.metrics,
    provenance: {
      record: "liq_cascade_detector",
      capture: "pre_watch_filter",
      window: "12h_business_opportunity",
      timestamp_semantics: "decision_at_is_first_live_rejection_observation",
      entry_price: "bingx_ticker_at_rejection",
    },
    completeness: {
      missing_semantics: "null_or_absent_means_not_recorded_not_reconstructed",
    },
    source: "liq_cascade_detector",
  });
  if (_liqRejectedDecisionBuffer.size > 5_000) {
    const oldest = _liqRejectedDecisionBuffer.keys().next().value;
    if (oldest) _liqRejectedDecisionBuffer.delete(oldest);
  }
}

export async function runLiqCascadeWatcherJob(
  getCycleCount?: (symbol: string) => number | null,
): Promise<void> {
  if (_running) {
    logger.warn("LiqCascadeWatcher: предыдущий цикл ещё не завершён — пропуск");
    return;
  }
  _running = true;
  const t0 = Date.now();
  logger.info("LiqCascadeWatcher: цикл начат");

  try {
    // ── 0. Инициализация _watchMap из DB при первом запуске после рестарта ────
    if (!_initialized) {
      _initialized = true;
      try {
        const activeRows = await db
          .select({
            id: liqCascadeWatchTable.id,
            symbol: liqCascadeWatchTable.symbol,
            detectedAt: liqCascadeWatchTable.detectedAt,
            entryReason: liqCascadeWatchTable.entryReason,
            longLiq1hAtDetect: liqCascadeWatchTable.longLiq1hAtDetect,
            longLiq24hAtDetect: liqCascadeWatchTable.longLiq24hAtDetect,
            cycleCountAtDetect: liqCascadeWatchTable.cycleCountAtDetect,
          })
          .from(liqCascadeWatchTable)
          .where(eq(liqCascadeWatchTable.status, "watching"));
        for (const row of activeRows) {
          _watchMap.set(row.symbol, {
            watchId: row.id,
            detectedAt: row.detectedAt.getTime(),
            liqExhausted: null,
            entryReason: row.entryReason ?? "liq_spike",
            longLiq1hAtDetect: row.longLiq1hAtDetect ?? null,
            longLiq24hAtDetect: row.longLiq24hAtDetect ?? null,
            cycleCountAtDetect: row.cycleCountAtDetect ?? null,
          });
        }
        logger.info(
          { count: activeRows.length },
          "LiqCascadeWatcher: инициализация _watchMap из DB",
        );
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: init from DB failed (non-critical)",
        );
      }
    }

    // ── 1. Получаем все BingX тикеры ──────────────────────────────────────────
    let tickers: BingXTicker[] = [];
    try {
      tickers = (await getFutureTickers()) as BingXTicker[];
    } catch (err) {
      logger.error(
        { err },
        "LiqCascadeWatcher: getFutureTickers failed — пропуск цикла",
      );
      return;
    }

    const now = Date.now();
    const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));

    // ── 1b. CoinGlass liquidation coin-list (batch) + real-time order stream ──
    // Только один воркер из двух делает реальный CG-запрос (liq-bulk-refresh lease,
    // TTL 4 мин). Второй воркер пропускает рефреш и читает из уже тёплого кэша модуля.
    // Fail-open: при ошибке или отсутствии лиза — продолжаем со старым кэшем.
    await withMarketCycleLease(
      "liq-bulk-refresh",
      async () => {
        await Promise.all([
          fetchLiqCoinList().catch(() => null),
          fetchLiqOrders().catch(() => null),
        ]);
      },
      { ttlMs: 4 * 60_000 },
    );

    // ── 2. Liq-spike детектор (PRIMARY): longLiq1h/longLiq24h ≥ 25% + longLiq1h > $50K ──
    // Заменяет старый дамп-фильтр (price24h ≤ -7%). Coin-list batch обновлён выше.
    // Fail-open: если getCachedLiqData() вернул null — токен пропускается (CG недоступен).
    // Фильтруем памп-токены (p24h > 5%): если лонги ликвидируются при росте — это сквиз,
    // не каскад; нам нужны LONG-ликвидации в результате падения/боковика.
    const entryReasons = new Map<string, string>();
    const liqSpikeCandidates: BingXTicker[] = [];
    const detectorObservedAt = new Date();

    await refreshAggregatedVolume24h();
    for (const ticker of tickers) {
      if (!ticker.symbol.endsWith("-USDT")) continue;
      const detectorPrice = parseFloat(ticker.lastPrice ?? "0") || 0;
      const vol = aggregatedVolume24hUsd(ticker.symbol);
      if (
        belowPctOfMcap(
          vol,
          await lcMcap(ticker.symbol),
          LC_MIN_QUOTE_VOL_PCT_OF_MCAP,
        )
      ) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason:
            vol > 0
              ? "quote_volume_below_min"
              : "aggregated_volume_unavailable",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: null,
            longLiq1h: null,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      }
      const p24 = parseFloat(ticker.priceChangePercent ?? "0") || 0;
      if (p24 > LIQ_SPIKE_P24H_MAX) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason: "price24h_above_cascade_max",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: null,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      } // памп-токен — не каскад
      const liq = getCachedLiqData(ticker.symbol, vol);
      if (!liq) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason: "liq_data_unavailable",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: null,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      } // CG недоступен — пропуск
      // BTC keeps the original $50K floor (owner 2026-10-24): 0.01% of BTC's
      // market cap is ~$160M per hour, which BTC long liquidations never reach;
      // BTC produced no cascade watch since the %-of-mcap switch on 2026-10-13.
      const spikeTooSmall =
        ticker.symbol === "BTC-USDT"
          ? liq.longLiq1h < LC_BTC_LIQ_SPIKE_MIN_USD
          : belowPctOfMcap(
              liq.longLiq1h,
              await lcMcap(ticker.symbol),
              LC_LIQ_SPIKE_MIN_PCT_OF_MCAP,
            );
      if (spikeTooSmall) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason: "long_liq_1h_below_min",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: liq.longLiq1h,
            longLiq24h: liq.longLiq24h,
            liqRatio: null,
          },
        });
        continue;
      } // абс. порог $50K
      if (liq.longLiq24h <= 0) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason: "long_liq_24h_missing_or_zero",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: liq.longLiq1h,
            longLiq24h: liq.longLiq24h,
            liqRatio: null,
          },
        });
        continue;
      } // нет 24h данных
      const ratio = liq.longLiq1h / liq.longLiq24h;
      if (ratio < LIQ_SPIKE_RATIO) {
        recordLiqDetectorRejection({
          symbol: ticker.symbol,
          reason: "long_liq_ratio_below_min",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: liq.longLiq1h,
            longLiq24h: liq.longLiq24h,
            liqRatio: ratio,
          },
        });
        continue;
      } // 1h < 25% от 24h = не спайк
      entryReasons.set(ticker.symbol, "liq_spike");
      liqSpikeCandidates.push(ticker);
      logger.info(
        {
          symbol: ticker.symbol,
          p24h: p24.toFixed(1) + "%",
          longLiq1h: "$" + Math.round(liq.longLiq1h / 1000) + "K",
          longLiq24h: "$" + Math.round(liq.longLiq24h / 1000) + "K",
          ratio: (ratio * 100).toFixed(0) + "%",
        },
        "💥 LiqCascade L10: liq_spike детектирован (longLiq1h/24h ≥ 25%)",
      );
    }

    // ── 2b. Ранний триггер: real-time long-liq ордера ──────────────────────────
    // Реал-тайм стрим ловит каскад ≥$100K за 15 мин.
    // Фильтры: памп-токены (p24h > 5%) и плоский рынок исключаются.
    // Реальное падение за 1ч (через klines) — первичный фильтр; p24h — резервный.

    // Pre-fetch 1h klines для потенциальных кандидатов (fail-open — ошибки → резервный p24h)
    const _liqOrderP1hMap = new Map<string, number>();
    {
      const _leaders: ReturnType<typeof getLiqOrderLongLeaders> = [];
      for (const l of getLiqOrderLongLeaders()) {
        if (
          l.longCount >= ORDER_STREAM_MIN_COUNT &&
          !belowPctOfMcap(
            l.longUsd,
            await lcMcap(`${l.baseAsset}-USDT`),
            LC_ORDER_STREAM_MIN_PCT_OF_MCAP,
          )
        )
          _leaders.push(l);
      }
      if (_leaders.length > 0) {
        await Promise.allSettled(
          _leaders.map(async (leader) => {
            const sym = `${leader.baseAsset}-USDT`;
            try {
              const klines = await getKlines(sym, "1h", 2);
              if (klines.length >= 1) {
                const cur = klines[klines.length - 1];
                const refClose =
                  klines.length >= 2
                    ? parseFloat(klines[klines.length - 2].close)
                    : parseFloat(cur.open);
                if (refClose > 0) {
                  const chg =
                    ((parseFloat(cur.close) - refClose) / refClose) * 100;
                  _liqOrderP1hMap.set(sym, chg);
                }
              }
            } catch {
              /* fail-open → используем p24h */
            }
          }),
        );
      }
    }

    const streamCandidates: BingXTicker[] = [];
    for (const leader of getLiqOrderLongLeaders()) {
      if (
        leader.longCount < ORDER_STREAM_MIN_COUNT ||
        belowPctOfMcap(
          leader.longUsd,
          await lcMcap(`${leader.baseAsset}-USDT`),
          LC_ORDER_STREAM_MIN_PCT_OF_MCAP,
        )
      )
        continue;
      const sym = `${leader.baseAsset}-USDT`;
      if (entryReasons.has(sym)) continue; // уже пойман liq_spike
      const t = tickerMap.get(sym);
      if (!t) {
        recordLiqDetectorRejection({
          symbol: sym,
          reason: "ticker_unavailable",
          observedAt: detectorObservedAt,
          entryPrice: null,
          metrics: {
            quoteVolume: null,
            price24h: null,
            longLiq1h: leader.longUsd,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      } // не торгуется на BingX
      const vol = aggregatedVolume24hUsd(t.symbol);
      const detectorPrice = parseFloat(t.lastPrice ?? "0") || 0;
      if (
        belowPctOfMcap(vol, await lcMcap(sym), LC_MIN_QUOTE_VOL_PCT_OF_MCAP)
      ) {
        recordLiqDetectorRejection({
          symbol: sym,
          reason: "quote_volume_below_min",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: null,
            longLiq1h: leader.longUsd,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      }
      const p24 = parseFloat(t.priceChangePercent ?? "0") || 0;
      if (p24 > LIQ_SPIKE_P24H_MAX) {
        recordLiqDetectorRejection({
          symbol: sym,
          reason: "price24h_above_cascade_max",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            longLiq1h: leader.longUsd,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      } // памп-токен — пропуск
      const p1h = _liqOrderP1hMap.get(sym) ?? null;
      // Реальное 1h падение (если доступно) или резервный 24h
      if (
        p1h !== null
          ? p1h > ORDER_STREAM_PRICE_DUMP_1H_MIN
          : p24 > ORDER_STREAM_PRICE_DUMP_MIN
      ) {
        recordLiqDetectorRejection({
          symbol: sym,
          reason: "price_not_dumping",
          observedAt: detectorObservedAt,
          entryPrice: detectorPrice > 0 ? detectorPrice : null,
          metrics: {
            quoteVolume: vol,
            price24h: p24,
            price1h: p1h,
            longLiq1h: leader.longUsd,
            longLiq24h: null,
            liqRatio: null,
          },
        });
        continue;
      }
      entryReasons.set(sym, "liq_order_stream");
      streamCandidates.push(t);
      logger.info(
        {
          symbol: sym,
          longOrders15m: leader.longCount,
          longUsd15m: "$" + Math.round(leader.longUsd / 1000) + "K",
          p24h: p24.toFixed(1) + "%",
          p1h: p1h != null ? p1h.toFixed(1) + "%" : null,
        },
        "⚡🌊 LiqCascade L10: ранний триггер по liq order stream",
      );
    }

    const allCandidates = [...liqSpikeCandidates, ...streamCandidates];

    logger.debug(
      {
        total: tickers.length,
        liqSpikeCandidates: liqSpikeCandidates.length,
        streamCandidates: streamCandidates.length,
      },
      "LiqCascadeWatcher: кандидаты найдены",
    );

    // ── 3. Dedup: убираем символы уже в наблюдении ────────────────────────────
    let existingSymbols = new Set<string>();
    if (allCandidates.length > 0) {
      try {
        const rows = await db
          .select({ symbol: liqCascadeWatchTable.symbol })
          .from(liqCascadeWatchTable)
          .where(
            gte(liqCascadeWatchTable.detectedAt, new Date(now - DEDUP_MS)),
          );
        existingSymbols = new Set(rows.map((r) => r.symbol));
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: dedup query failed (non-critical)",
        );
      }
    }

    const newCandidates = allCandidates.filter(
      (t) => !existingSymbols.has(t.symbol),
    );

    // ── 4. MCap для spotVolMcapPct ─────────────────────────────────────────────
    const mcapMap = new Map<string, number>();
    if (newCandidates.length > 0) {
      try {
        const baseSymbols = newCandidates.map((t) =>
          t.symbol.replace(/-USDT$/, ""),
        );
        const mcapRows = await db
          .select({
            symbol: marketCapCacheTable.symbol,
            mcapUsd: marketCapCacheTable.mcapUsd,
          })
          .from(marketCapCacheTable)
          .where(
            and(
              inArray(marketCapCacheTable.symbol, baseSymbols),
              eq(marketCapCacheTable.source, "coingecko"),
            ),
          );
        for (const r of mcapRows) mcapMap.set(r.symbol, r.mcapUsd);
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: mcap query failed (non-critical)",
        );
      }
    }

    // ── spotVolAvg1h из prescan_tracker → для вычисления spotVolMultAtDetect ──
    const _spotAvgMap = new Map<string, number>();
    if (newCandidates.length > 0) {
      try {
        const ptRows = await db
          .select({
            symbol: prescanTrackerTable.symbol,
            spotVolAvg1h: prescanTrackerTable.spotVolAvg1h,
          })
          .from(prescanTrackerTable)
          .where(
            inArray(
              prescanTrackerTable.symbol,
              newCandidates.map((t) => t.symbol),
            ),
          );
        for (const r of ptRows) {
          if (r.spotVolAvg1h && r.spotVolAvg1h > 0)
            _spotAvgMap.set(r.symbol, r.spotVolAvg1h);
        }
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: spotAvg query failed (non-critical)",
        );
      }
    }

    // ── 5. Вставляем новых кандидатов ─────────────────────────────────────────
    const expiresAt = new Date(now + WATCH_WINDOW_MS);
    let inserted = 0;

    await refreshAggregatedVolume24h();
    for (const ticker of newCandidates) {
      const price24h = parseFloat(ticker.priceChangePercent ?? "0") || 0;
      const priceAtDetect = parseFloat(ticker.lastPrice ?? "0") || 0;
      const quoteVol24h = aggregatedVolume24hUsd(ticker.symbol);
      const baseSymbol = ticker.symbol.replace(/-USDT$/, "");
      const mcapUsd = mcapMap.get(baseSymbol) ?? null;
      const spotVolMcapPct =
        mcapUsd && mcapUsd > 0 && quoteVol24h > 0
          ? Math.round((quoteVol24h / mcapUsd) * 10_000) / 100
          : null;

      // CoinGlass liquidation snapshot (из batch кэша, с collision-защитой).
      // Serve-stale до 30 мин: устаревший snapshot лучше чем NULL (фикс NULL at-detect).
      const liqData = getCachedLiqDataEx(ticker.symbol, quoteVol24h);
      // Real-time liq order stream snapshot (rolling 15 мин, все биржи)
      const orderStats = getLiqOrderStats(ticker.symbol);
      const entryReason = entryReasons.get(ticker.symbol) ?? "dump_filter";

      // Ритейл-позиционирование + OI + CVD — только для новых кандидатов (мало, fail-open)
      const [globalRatio, cgOiSnap, cvdSnap] = await Promise.all([
        getGlobalAccountRatio(ticker.symbol).catch(() => null),
        getCoinglassOI(ticker.symbol, priceAtDetect).catch(() => null),
        getSpotCvdMtf(ticker.symbol).catch(() => null),
      ]);
      try {
        const insertedWatches = await db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${"liq-cascade-watch:" + ticker.symbol}))`,
          );
          const [recentWatch] = await tx
            .select({ id: liqCascadeWatchTable.id })
            .from(liqCascadeWatchTable)
            .where(
              and(
                eq(liqCascadeWatchTable.symbol, ticker.symbol),
                gte(liqCascadeWatchTable.detectedAt, new Date(now - DEDUP_MS)),
              ),
            )
            .limit(1);
          if (recentWatch) return [];
          return tx
            .insert(liqCascadeWatchTable)
            .values({
              symbol: ticker.symbol,
              status: "watching",
              detectedAt: new Date(now),
              expiresAt,
              priceAtDetect,
              price24hAtDetect: price24h,
              price1hAtDetect: null, // populated if token enters prescan
              oi30mAtDetect: cgOiSnap?.available
                ? (cgOiSnap.oiChange30m ?? null)
                : null,
              oi1hAtDetect: cgOiSnap?.available
                ? (cgOiSnap.oiChange1h ?? null)
                : null,
              oi4hAtDetect: cgOiSnap?.available
                ? (cgOiSnap.oiChange4h ?? null)
                : null,
              // Spot volume is not collected here (BingX volume removed).
              spotVol24hAtDetect: null,
              spotVolMultAtDetect: null,
              spotVolMcapPct: null,
              cvd30mAtDetect: cvdSnap?.available
                ? (cvdSnap.cvd30m ?? null)
                : null,
              cvd1hAtDetect: cvdSnap?.available
                ? (cvdSnap.cvd1h ?? null)
                : null,
              cvd4hAtDetect: cvdSnap?.available
                ? (cvdSnap.cvd4h ?? null)
                : null,
              currentPrice: priceAtDetect,
              currentPctChange: 0,
              lastCheckAt: new Date(),
              longLiq1hAtDetect: liqData?.longLiq1h ?? null,
              longLiq4hAtDetect: liqData?.longLiq4h ?? null,
              longLiq24hAtDetect: liqData?.longLiq24h ?? null,
              currentLongLiq1h: liqData?.longLiq1h ?? null,
              liqExhausted: null,
              globalLongPct: globalRatio?.longPct ?? null,
              entryReason,
              liqOrdersCountAtDetect: orderStats?.longCount ?? null,
              liqOrdersUsdAtDetect: orderStats?.longUsd ?? null,
              cycleCountAtDetect: getCycleCount
                ? (getCycleCount(ticker.symbol) ?? null)
                : null,
            })
            .returning({
              id: liqCascadeWatchTable.id,
              detectedAt: liqCascadeWatchTable.detectedAt,
            });
        });
        const insertedWatch = insertedWatches[0];
        if (!insertedWatch) {
          continue;
        }

        const cycleAtDetect = getCycleCount
          ? (getCycleCount(ticker.symbol) ?? null)
          : null;
        _watchMap.set(ticker.symbol, {
          watchId: insertedWatch.id,
          detectedAt: now,
          liqExhausted: null,
          entryReason,
          longLiq1hAtDetect: liqData?.longLiq1h ?? null,
          longLiq24hAtDetect: liqData?.longLiq24h ?? null,
          cycleCountAtDetect: cycleAtDetect,
        });
        inserted++;
        void recordLiqCascadeWatchStart({
          watchId: insertedWatch.id,
          symbol: ticker.symbol,
          detectedAt: insertedWatch.detectedAt,
          entryPrice: priceAtDetect || null,
          reason: entryReason,
          metrics: {
            price24h,
            quoteVol24h,
            longLiq1h: liqData?.longLiq1h ?? null,
            longLiq24h: liqData?.longLiq24h ?? null,
            liqOrdersCount15m: orderStats?.longCount ?? null,
            liqOrdersUsd15m: orderStats?.longUsd ?? null,
            oi30m: cgOiSnap?.available ? (cgOiSnap.oiChange30m ?? null) : null,
            oi1h: cgOiSnap?.available ? (cgOiSnap.oiChange1h ?? null) : null,
            oi4h: cgOiSnap?.available ? (cgOiSnap.oiChange4h ?? null) : null,
            cvd30m: cvdSnap?.available ? (cvdSnap.cvd30m ?? null) : null,
            cvd1h: cvdSnap?.available ? (cvdSnap.cvd1h ?? null) : null,
            cvd4h: cvdSnap?.available ? (cvdSnap.cvd4h ?? null) : null,
            spotVolMcapPct,
          },
        }).catch((err) =>
          logger.warn(
            { err, watchId: insertedWatch.id, symbol: ticker.symbol },
            "LiqCascade candidate-start observation failed",
          ),
        );

        logger.info(
          {
            symbol: ticker.symbol,
            entry: entryReason,
            price24h: price24h.toFixed(1) + "%",
            vol24hM: (quoteVol24h / 1_000_000).toFixed(1) + "M",
            mcapM: mcapUsd ? Math.round(mcapUsd / 1_000_000) + "M" : "?",
            longLiq24h: liqData
              ? "$" + Math.round(liqData.longLiq24h / 1000) + "K"
              : "нет данных",
            liqCacheStale: liqData?.stale ?? null,
            liqOrders15m: orderStats
              ? `${orderStats.longCount}×$${Math.round(orderStats.longUsd / 1000)}K`
              : "—",
            oi30m: cgOiSnap?.available
              ? cgOiSnap.oiChange30m?.toFixed(2) + "%"
              : "—",
            oi1h: cgOiSnap?.available
              ? cgOiSnap.oiChange1h?.toFixed(2) + "%"
              : "—",
            cvd1h: cvdSnap?.available ? cvdSnap.cvd1h : null,
            realCascade: liqData
              ? liqData.longLiq24h > 0
                ? "да"
                : "НЕТ (дамп без ликвидаций)"
              : "?",
            retailLongPct: globalRatio
              ? globalRatio.longPct.toFixed(0) + "%"
              : "—",
          },
          "⚡ LiqCascade L10: новый кандидат добавлен",
        );
      } catch (err) {
        logger.error(
          { err, symbol: ticker.symbol },
          "LiqCascadeWatcher: insert failed",
        );
      }
    }

    // ── 6. Обновляем currentPrice для watching-записей ────────────────────────
    const activeWaitSymbols = await db
      .select({ symbol: lcObWaitTable.symbol })
      .from(lcObWaitTable)
      .where(
        and(
          inArray(lcObWaitTable.status, ["waiting", "invalidated", "released"]),
          gte(lcObWaitTable.expiresAt, new Date(now - 96 * 60 * 60 * 1000)),
        ),
      )
      .catch((err) => {
        logger.warn(
          { err },
          "LiqCascade wait symbols unavailable for signal reconciliation",
        );
        return [];
      });
    const watchingSymbols = [
      ...new Set([
        ..._watchMap.keys(),
        ...activeWaitSymbols.map((row) => row.symbol),
      ]),
    ];
    if (watchingSymbols.length > 0) {
      try {
        const watchingRows = await db
          .select({
            id: liqCascadeWatchTable.id,
            symbol: liqCascadeWatchTable.symbol,
            detectedAt: liqCascadeWatchTable.detectedAt,
            priceAtDetect: liqCascadeWatchTable.priceAtDetect,
            longLiq1hAtDetect: liqCascadeWatchTable.longLiq1hAtDetect,
            longLiq24hAtDetect: liqCascadeWatchTable.longLiq24hAtDetect,
          })
          .from(liqCascadeWatchTable)
          .where(
            and(
              or(
                eq(liqCascadeWatchTable.status, "watching"),
                sql`EXISTS (
                  SELECT 1
                  FROM lc_ob_wait w
                  WHERE w.watch_id = ${liqCascadeWatchTable.id}
                    AND w.status = 'released'
                    AND w.expires_at >= now()
                )`,
              ),
              inArray(liqCascadeWatchTable.symbol, watchingSymbols),
            ),
          );

        for (const row of watchingRows) {
          await refreshAggregatedVolume24h();
          const liveTicker = tickerMap.get(row.symbol);
          if (!liveTicker || !row.priceAtDetect) continue;
          const curPrice = parseFloat(liveTicker.lastPrice ?? "0") || 0;
          const pctChange =
            ((curPrice - row.priceAtDetect) / row.priceAtDetect) * 100;

          // Обновление liquidation-данных из batch кэша (бесплатно, без API-запросов)
          const curVol24h = aggregatedVolume24hUsd(row.symbol);
          const liqNow = getCachedLiqData(row.symbol, curVol24h);
          // liqExhausted семантика:
          //   true  — CG данные есть + текущий 1h liq < 30% пика → каскад выдохся ✓
          //   false — CG данные есть + каскад ещё идёт (≥30% пика) ИЛИ longLiq1hAtDetect==0
          //           (дамп без ликвидаций — не настоящий каскад) → блокируем
          //   null  — CG liq данные недоступны (timeout/холодный кэш) → сканер fail-open
          // Разделение null и false важно: false = подтверждённо не каскад; null = данных нет.
          const liqExhausted =
            row.longLiq1hAtDetect != null && row.longLiq1hAtDetect === 0
              ? false // дамп без ликвидаций — не каскад (не делаем fail-open)
              : liqNow !== null &&
                  row.longLiq1hAtDetect != null &&
                  row.longLiq1hAtDetect > 0
                ? liqNow.longLiq1h < row.longLiq1hAtDetect * 0.2 // ужесточено: <30%→<20% пика
                : null; // CG недоступен → скан решает сам (fail-open)

          // Backfill *_at_detect (фикс NULL-бага): если insert прошёл при холодном/
          // упавшем CG кэше, snapshot остался NULL. Пока запись свежая (<15 мин) и
          // кэш прогрелся — дозаполняем: 15-мин окно ещё репрезентативно для "at detect".
          let backfillAtDetect: Record<string, number> = {};
          if (
            row.longLiq1hAtDetect == null &&
            row.longLiq24hAtDetect == null &&
            liqNow !== null &&
            now - row.detectedAt.getTime() < 15 * 60 * 1000
          ) {
            backfillAtDetect = {
              longLiq1hAtDetect: liqNow.longLiq1h,
              longLiq4hAtDetect: liqNow.longLiq4h,
              longLiq24hAtDetect: liqNow.longLiq24h,
            };
            logger.info(
              {
                symbol: row.symbol,
                ageMin: Math.round((now - row.detectedAt.getTime()) / 60_000),
                longLiq24h: Math.round(liqNow.longLiq24h),
              },
              "LiqCascade L10: backfill *_at_detect (кэш был холодный при insert)",
            );
          }

          // Ритейл-позиционирование
          const gRatio = await getGlobalAccountRatio(row.symbol).catch(
            () => null,
          );
          await db
            .update(liqCascadeWatchTable)
            .set({
              currentPrice: curPrice,
              currentPctChange: Math.round(pctChange * 100) / 100,
              lastCheckAt: new Date(),
              ...(liqNow !== null
                ? { currentLongLiq1h: liqNow.longLiq1h }
                : {}),
              ...(liqExhausted !== null ? { liqExhausted } : {}),
              ...(gRatio !== null ? { globalLongPct: gRatio.longPct } : {}),
              ...backfillAtDetect,
            })
            .where(eq(liqCascadeWatchTable.id, row.id));
          void recordLiqCascadeObservation({
            watchId: row.id,
            symbol: row.symbol,
            detectedAt: row.detectedAt,
            stage: "watching",
            reason:
              liqExhausted === true
                ? "liq_exhausted"
                : liqExhausted === false
                  ? "liq_not_exhausted"
                  : "liq_data_unavailable",
            price: curPrice,
            metrics: {
              pctFromDetect: Math.round(pctChange * 100) / 100,
              liqExhausted,
              currentLongLiq1h: liqNow?.longLiq1h ?? null,
              longLiq1hAtDetect: row.longLiq1hAtDetect,
              longLiq24hAtDetect: row.longLiq24hAtDetect,
              globalLongPct: gRatio?.longPct ?? null,
            },
          }).catch((err) =>
            logger.warn(
              { err, watchId: row.id },
              "LiqCascade 15m watch observation failed",
            ),
          );

          // Синхронизируем in-memory _watchMap с новым liqExhausted для сканера.
          // Важно: обновляем только если данные CG доступны (liqExhausted !== null).
          // null оставляем как есть — сканер интерпретирует null как fail-open.
          const _me = _watchMap.get(row.symbol);
          if (_me !== undefined && liqExhausted !== null) {
            _me.liqExhausted = liqExhausted;
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: currentPrice update failed (non-critical)",
        );
      }
    }

    // ── 7. Проверяем сработавшие сигналы (sentimentKey = liquidation_cascade) ──
    if (watchingSymbols.length > 0) {
      try {
        const firedSignals = await db
          .select({
            watchId: liqCascadeWatchTable.id,
            symbol: trackedSignalsTable.symbol,
            id: trackedSignalsTable.id,
            watchDetectedAt: liqCascadeWatchTable.detectedAt,
            signalDetectedAt: trackedSignalsTable.detectedAt,
          })
          .from(liqCascadeWatchTable)
          .innerJoin(
            trackedSignalsTable,
            and(
              eq(liqCascadeWatchTable.symbol, trackedSignalsTable.symbol),
              eq(trackedSignalsTable.sentimentKey, "liquidation_cascade"),
              // A previously delivered trade moved back to observation is not
              // a new fire, even though its original detectedAt is in-window.
              ne(trackedSignalsTable.status, "reclassified"),
              gt(
                trackedSignalsTable.detectedAt,
                liqCascadeWatchTable.detectedAt,
              ),
              or(
                lte(
                  trackedSignalsTable.detectedAt,
                  liqCascadeWatchTable.expiresAt,
                ),
                sql`EXISTS (
                  SELECT 1
                  FROM lc_ob_wait w
                  WHERE w.watch_id = ${liqCascadeWatchTable.id}
                    AND w.status = 'released'
                    AND w.expires_at >= ${trackedSignalsTable.detectedAt}
                )`,
              ),
            ),
          )
          .where(
            and(
              eq(liqCascadeWatchTable.status, "watching"),
              inArray(liqCascadeWatchTable.symbol, watchingSymbols),
            ),
          )
          .orderBy(
            asc(liqCascadeWatchTable.id),
            asc(trackedSignalsTable.detectedAt),
            asc(trackedSignalsTable.id),
          );

        for (const sig of firedSignals) {
          const updated = await db
            .update(liqCascadeWatchTable)
            .set({ status: "fired", signalId: sig.id })
            .where(
              and(
                eq(liqCascadeWatchTable.id, sig.watchId),
                or(
                  eq(liqCascadeWatchTable.status, "watching"),
                  and(
                    eq(liqCascadeWatchTable.status, "expired"),
                    sql`EXISTS (
                      SELECT 1
                      FROM lc_ob_wait w
                      WHERE w.watch_id = ${liqCascadeWatchTable.id}
                        AND w.status = 'released'
                        AND w.expires_at >= ${sig.signalDetectedAt}
                    )`,
                  ),
                ),
              ),
            )
            .returning();

          if (updated.length > 0) {
            void recordLiqCascadeObservation({
              watchId: sig.watchId,
              signalId: sig.id,
              symbol: sig.symbol,
              detectedAt: sig.watchDetectedAt,
              stage: "fired",
              reason: "tracked_signal_linked",
            }).catch((err) =>
              logger.warn(
                { err, watchId: sig.watchId },
                "LiqCascade fired observation failed",
              ),
            );
            const inMemoryEntry = _watchMap.get(sig.symbol);
            if (
              inMemoryEntry === undefined ||
              inMemoryEntry.detectedAt === sig.watchDetectedAt.getTime()
            ) {
              _watchMap.delete(sig.symbol);
            }
            logger.info(
              { symbol: sig.symbol, signalId: sig.id, watchId: sig.watchId },
              "✅ LiqCascade L10: сигнал сработал → статус fired",
            );
          }
        }
      } catch (err) {
        logger.warn(
          { err },
          "LiqCascadeWatcher: fired-check failed (non-critical)",
        );
      }
    }

    // ── 8. Истекаем старые watching-записи → missed_signals_log ───────────────
    try {
      const expired = await db
        .update(liqCascadeWatchTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(liqCascadeWatchTable.status, "watching"),
            lt(liqCascadeWatchTable.expiresAt, new Date()),
          ),
        )
        .returning();

      for (const row of expired) {
        _watchMap.delete(row.symbol);
        void recordLiqCascadeObservation({
          watchId: row.id,
          symbol: row.symbol,
          detectedAt: row.detectedAt,
          observedAt: row.expiresAt,
          stage: "expired",
          reason: "no_signal_12h",
          price:
            row.currentPrice != null && row.currentPrice > 0
              ? row.currentPrice
              : row.priceAtDetect,
          metrics: {
            currentPctChange: row.currentPctChange,
            liqExhausted: row.liqExhausted,
            oi30mAtDetect: row.oi30mAtDetect,
            oi1hAtDetect: row.oi1hAtDetect,
            oi4hAtDetect: row.oi4hAtDetect,
          },
        }).catch((err) =>
          logger.warn(
            { err, watchId: row.id },
            "LiqCascade expired observation failed",
          ),
        );

        const _reasonParts = [
          `p24h=${row.price24hAtDetect?.toFixed(1) ?? "—"}%`,
          `oi1h=${row.oi1hAtDetect?.toFixed(1) ?? "—"}%`,
          `cvd1h=${row.cvd1hAtDetect ?? "—"}`,
          `curChg=${row.currentPctChange?.toFixed(1) ?? "—"}%`,
          "no_signal_12h",
        ];
        const source = `liq_cascade_watch:${row.id}`;
        const reason = _reasonParts.join(" ");
        const priceAtLog =
          row.currentPrice != null && row.currentPrice > 0
            ? row.currentPrice
            : row.priceAtDetect;

        // The source includes the durable watch-row id. An advisory lock plus
        // INSERT … WHERE NOT EXISTS makes this safe across the two production
        // workers and safe to retry after an ambiguous DB timeout.
        const logged = await dbWriteBestEffort(
          "liqCascade/expired-missed-signal",
          () =>
            db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtext(${source}))`,
              );
              await tx.execute(sql`
                INSERT INTO missed_signals_log (
                  symbol, source, reason, pattern, price_at_log,
                  price_24h_pct, oi_30m_pct, oi_1h_pct, oi_4h_pct,
                  spot_vol_mult, cvd_1h, cvd_4h, prescan_cycles, logged_at
                )
                SELECT
                  ${row.symbol}, ${source}, ${reason}, 'liquidation_cascade',
                  ${priceAtLog},
                  ${row.price24hAtDetect}, ${row.oi30mAtDetect},
                  ${row.oi1hAtDetect}, ${row.oi4hAtDetect},
                  ${row.spotVolMultAtDetect}, ${row.cvd1hAtDetect},
                  ${row.cvd4hAtDetect}, ${row.cycleCountAtDetect},
                  ${row.expiresAt}
                WHERE NOT EXISTS (
                  SELECT 1
                  FROM missed_signals_log
                  WHERE source = ${source}
                )
              `);
            }),
          { perAttemptTimeoutMs: 5000, attempts: 2, retryDelayMs: 1000 },
        );

        logger.info(
          {
            symbol: row.symbol,
            price24h: row.price24hAtDetect,
            curChg: row.currentPctChange,
            missedSignalLogged: logged !== null,
          },
          "LiqCascade L10: expired без сигнала",
        );
      }
    } catch (err) {
      logger.warn(
        { err },
        "LiqCascadeWatcher: expire check failed (non-critical)",
      );
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    logger.info(
      {
        liqSpikeCandidates: liqSpikeCandidates.length,
        streamCandidates: streamCandidates.length,
        inserted,
        watching: _watchMap.size,
        elapsed: `${elapsed}s`,
      },
      "LiqCascadeWatcher: цикл завершён",
    );
  } finally {
    let pendingDecisionEvents = [..._liqRejectedDecisionBuffer.values()];
    // Owner policy: every rejection stores the full flow snapshot (OI, CVD,
    // taker, spot volume, ...) from the prescan tracker at the same cycle.
    if (pendingDecisionEvents.length > 0) {
      try {
        const symbols = [
          ...new Set(pendingDecisionEvents.map((e) => e.symbol)),
        ];
        const rows = await db
          .select()
          .from(prescanTrackerTable)
          .where(inArray(prescanTrackerTable.symbol, symbols));
        const bySymbol = new Map(rows.map((r) => [r.symbol, r]));
        const capturedAt = Date.now();
        pendingDecisionEvents = pendingDecisionEvents.map((event) => {
          const row = bySymbol.get(event.symbol);
          return {
            ...event,
            metrics: {
              ...(event.metrics as Record<string, unknown>),
              flowSnapshot: row
                ? { ...row, capturedAt }
                : { capturedAt, available: false },
            },
          };
        });
      } catch (err) {
        logger.warn({ err }, "LiqCascadeWatcher: flow snapshot query failed");
      }
    }
    if (
      pendingDecisionEvents.length > 0 &&
      (await recordPatternDecisionEventsBatch(pendingDecisionEvents))
    ) {
      for (const event of pendingDecisionEvents) {
        _liqRejectedDecisionBuffer.delete(event.eventKey);
      }
    }
    _running = false;
  }
}
