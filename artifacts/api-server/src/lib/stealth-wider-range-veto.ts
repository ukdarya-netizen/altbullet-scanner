import {
  detectAutoRangePine1h,
  type AutoRangeCandle,
} from "./auto-range-pine.js";

/**
 * Auto Range state depends on the replay start bar: the live 600-bar window can
 * report a narrow "breakout" while the converged replay (>=900 bars, identical
 * to the full history) still has a wider active range around the price
 * (LPT 2026-10-03). A 1H Range entry is vetoed when the converged replay has an
 * active range that contains the current price. Too little history = fail-open.
 */
export const STEALTH_WIDER_RANGE_REPLAY_BARS = 900;
export const STEALTH_WIDER_RANGE_MIN_BARS = 800;

export interface WiderRangeVeto {
  blocked: boolean;
  reason: "inside_wider_active_range" | "clear" | "insufficient_history";
  lower: number | null;
  upper: number | null;
}

export function checkWiderActiveRange(
  closedOneHourCandles: readonly AutoRangeCandle[],
  price: number | null,
): WiderRangeVeto {
  const none = { lower: null, upper: null };
  if (
    price === null ||
    !Number.isFinite(price) ||
    closedOneHourCandles.length < STEALTH_WIDER_RANGE_MIN_BARS
  ) {
    return { blocked: false, reason: "insufficient_history", ...none };
  }
  const result = detectAutoRangePine1h(
    closedOneHourCandles
      .slice(-STEALTH_WIDER_RANGE_REPLAY_BARS)
      .map((candle) => ({ ...candle, closed: true })),
  );
  const active = result.activeConfirmedRange;
  if (active && price >= active.lower && price <= active.upper) {
    return {
      blocked: true,
      reason: "inside_wider_active_range",
      lower: active.lower,
      upper: active.upper,
    };
  }
  return { blocked: false, reason: "clear", ...none };
}

/**
 * The owner's Pine chart (and the Pine parity reference) runs on Binance spot
 * 1H candles. BingX perpetual candles can show no active wider range where the
 * Binance replay shows one (INIT 2026-10-10: Binance 0.11037–0.1194 active at
 * entry, BingX replay none). Fail-open when Binance has no usable history.
 */
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];
const binanceCache = new Map<string, { at: number; veto: WiderRangeVeto }>();
const BINANCE_CACHE_MS = 5 * 60_000;

export async function checkWiderActiveRangeBinance(
  symbol: string,
  price: number | null,
  nowMs = Date.now(),
): Promise<WiderRangeVeto> {
  const none = { lower: null, upper: null };
  const clear = { blocked: false, reason: "insufficient_history", ...none };
  if (price === null || !Number.isFinite(price)) return clear as WiderRangeVeto;
  const id = symbol.replace(/-/g, "").toUpperCase();
  const hit = binanceCache.get(id);
  if (hit && nowMs - hit.at < BINANCE_CACHE_MS) return hit.veto;
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(
        `${host}/api/v3/klines?symbol=${encodeURIComponent(id)}&interval=1h&limit=1000`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) continue;
      const candles = raw
        .map((k: unknown[]) => ({
          time: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }))
        .filter(
          (c) =>
            [c.time, c.open, c.high, c.low, c.close, c.volume].every(
              Number.isFinite,
            ) && c.time + 3_600_000 <= nowMs,
        );
      const veto = checkWiderActiveRange(candles, price);
      binanceCache.set(id, { at: nowMs, veto });
      return veto;
    } catch {
      // try next host; unavailable data never blocks
    }
  }
  return clear as WiderRangeVeto;
}
