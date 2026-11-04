/**
 * Spot Liquidity Pool Cache
 *
 * Фоновый кэш спот-объёма и MCap для всего пула сканируемых токенов.
 * Обновляется каждые 30 минут пакетами — не блокирует основной скан.
 *
 * Используется как первичный фильтр в scanner.ts:
 *   if (!isSpotLiquid(symbol, 0.0005)) continue; // скип перед klines
 *
 * Если символ ещё не в кэше → пропускаем оптимистично (individual gate поймает).
 */

import { getSpotVolume } from "./coinglass_spot_volume.js";
import { fetchMarketCap } from "./whale_watch_v2.js";
import { logger } from "./logger.js";

/**
 * Minimum aggregated (all-exchange) spot 24h volume as a fraction of market cap.
 * Shared by the spot_fail_low pre-gate, Pre-Breakout/Dark Flow and confirmed-fire.
 * 0.0164 = 1% of the former 3-exchange numerator re-expressed on the all-exchange
 * aggregate at the same cut share (42.8% of 446 symbols, 2026-10-18 snapshot).
 */
export const MIN_SPOT_VOL_MCAP_FRACTION = 0.0164;

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 мин
const BATCH_SIZE = 40; // параллельных запросов за раз
const BATCH_DELAY_MS = 600; // пауза между пакетами (мс)

interface SpotEntry {
  spotVol24h: number | null;
  mcapUsd: number | null;
  ts: number;
}

const pool = new Map<string, SpotEntry>();
let lastRefreshAt = 0;
let refreshRunning = false;

/**
 * Проверяет: является ли символ достаточно ликвидным по споту.
 * minPct — минимальный % MCap (0.0005 = 0.05%, 0.003 = 0.3%).
 *
 * Если символ НЕ в кэше → возвращает true (оптимистично — individual gate поймает).
 * Если spotVol24h null → возвращает false (нет данных о споте вообще).
 * Если mcapUsd null (CoinGecko недоступен) → возвращает true (оптимистично, как не в кэше).
 *   Малоликвидные токены стреляют сильнее — не режем их по абс. порогу без MCap.
 *   Остальные гейты (OI, CVD, Taker) поймают мусор.
 */
export function isSpotLiquid(symbol: string, minPct: number): boolean {
  const entry = pool.get(symbol);
  if (!entry) return true;
  if (entry.spotVol24h === null) return false;
  if (entry.mcapUsd === null) return true;
  return entry.spotVol24h >= entry.mcapUsd * minPct;
}

/**
 * Возвращает закэшированные данные по символу (или null).
 */
export function getSpotPoolEntry(symbol: string): SpotEntry | null {
  return pool.get(symbol) ?? null;
}

/**
 * Запускает фоновое обновление кэша для переданного списка символов.
 * Вызов не блокирует — сразу возвращает управление.
 * Пропускает если: обновление уже идёт ИЛИ прошло < 30 мин с последнего.
 */
export function triggerRefresh(symbols: string[]): void {
  const now = Date.now();
  if (refreshRunning) return;
  if (now - lastRefreshAt < REFRESH_INTERVAL_MS) return;

  void runRefresh(symbols);
}

async function runRefresh(symbols: string[]): Promise<void> {
  refreshRunning = true;
  lastRefreshAt = Date.now();

  logger.info(
    { count: symbols.length },
    "SpotPool: запуск обновления кэша спот-ликвидности",
  );

  let updated = 0;
  let blocked = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (symbol) => {
        try {
          // Aggregated spot 24h volume (CoinGlass pairs-markets, ALL exchanges).
          const [freshSpot, mcapRaw] = await Promise.all([
            getSpotVolume(symbol).catch(() => null),
            fetchMarketCap(symbol).catch(() => null),
          ]);
          const freshSpotVol =
            (freshSpot?.volumeUsd24h ?? 0) > 0
              ? freshSpot!.volumeUsd24h!
              : null;
          // Owner rule: no last-known fallback. Missing aggregate = null.
          const spotVol24h = freshSpotVol;
          const mcapUsd = mcapRaw?.mcap ?? null;
          pool.set(symbol, { spotVol24h, mcapUsd, ts: Date.now() });

          if (
            spotVol24h !== null &&
            mcapUsd !== null &&
            spotVol24h < mcapUsd * 0.0015
          ) {
            blocked++;
          }
          updated++;
        } catch {
          // non-critical — оставляем устаревший кэш если есть
        }
      }),
    );

    if (i + BATCH_SIZE < symbols.length) {
      await new Promise<void>((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  refreshRunning = false;
  logger.info(
    { updated, blocked, total: symbols.length },
    "SpotPool: кэш обновлён",
  );
}
