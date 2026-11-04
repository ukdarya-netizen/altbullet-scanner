/**
 * Liquidation multiple для detectSentiment / calcBulletScore.
 *
 * Раньше — мёртвый CoinGlass v2 API (open-api.coinglass.com/public/v2, ключ
 * в заголовке coinglassSecret): эндпоинт давно не отвечает на v4-ключах,
 * multiple всегда был null / available=false. Переписано на v4 coin-list
 * batch-кэш (coinglass_liquidation.ts) — 0 дополнительных API-вызовов
 * на символ (кэш 3 мин, serve-stale до 30 мин).
 *
 * Семантика сохранена: liquidationsUsd = ликвидации за последний 1ч
 * (long+short); rolling-история до 8 чтений (шаг ≥20 мин, ~4ч окно) →
 * multiple = current / avg(предыдущих). Fail-open: нет данных → available=false.
 */
import {
  fetchLiqCoinList,
  getCachedLiqDataEx,
} from "./coinglass_liquidation.js";

export interface LiquidationResult {
  liquidationsUsd: number | null;
  avgLiquidationsUsd: number | null;
  multiple: number | null;
  available: boolean;
}

const UNAVAILABLE: LiquidationResult = {
  liquidationsUsd: null,
  avgLiquidationsUsd: null,
  multiple: null,
  available: false,
};

// In-memory история чтений per symbol для rolling average.
// Шаг ≥20 мин: 1h-окна соседних сканов перекрываются, чаще писать бессмысленно.
const liqHistory = new Map<string, { values: number[]; lastTs: number }>();
const MAX_HISTORY = 8;
const MIN_SAMPLE_GAP_MS = 20 * 60 * 1000;

export async function getLiquidations(
  symbol: string,
  bingxVol24hUsd?: number,
): Promise<LiquidationResult> {
  // Дешёво: батч кэшируется 3 мин, параллельные вызовы дедуплицируются
  await fetchLiqCoinList().catch(() => null);
  const liq = getCachedLiqDataEx(symbol, bingxVol24hUsd);
  if (!liq) return UNAVAILABLE;

  const currentLiqUsd = liq.longLiq1h + liq.shortLiq1h;

  const now = Date.now();
  let entry = liqHistory.get(symbol);
  if (!entry) {
    entry = { values: [], lastTs: 0 };
    liqHistory.set(symbol, entry);
  }
  if (now - entry.lastTs >= MIN_SAMPLE_GAP_MS) {
    if (entry.values.length >= MAX_HISTORY) entry.values.shift();
    entry.values.push(currentLiqUsd);
    entry.lastTs = now;
  }

  const prev = entry.values.length > 1 ? entry.values.slice(0, -1) : null;
  const avgLiq = prev
    ? prev.reduce((a, b) => a + b, 0) / prev.length
    : currentLiqUsd;
  const multiple = avgLiq > 0 ? currentLiqUsd / avgLiq : null;

  return {
    liquidationsUsd: currentLiqUsd,
    avgLiquidationsUsd: avgLiq,
    multiple,
    available: true,
  };
}
