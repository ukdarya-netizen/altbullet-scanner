import { getKlines, type BingXKline } from "./bingx.js";

/**
 * Owner 2026-10-13: how long a token has been listed on BingX must not decide
 * whether it can signal. When the BingX perpetual history is shorter than the
 * Auto Range requirement, the missing older candles are taken from Binance spot
 * (the venue of the owner's Pine chart) and prepended; BingX candles stay
 * authoritative for every bar BingX has. Unavailable Binance data never blocks
 * and never replaces the BingX result.
 */
const BINANCE_HOSTS = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];
const INTERVAL_MS: Record<string, number> = {
  "1h": 3_600_000,
  "4h": 14_400_000,
};

export function mergeOlderHistory(
  bingx: readonly BingXKline[],
  older: readonly BingXKline[],
): BingXKline[] {
  if (bingx.length === 0) return [...older];
  const first = Math.min(...bingx.map((k) => k.time));
  const prefix = older.filter((k) => k.time < first);
  return [...prefix, ...bingx].sort((a, b) => a.time - b.time);
}

async function fetchBinanceSpotBefore(
  symbol: string,
  interval: string,
  endTimeExclusive: number,
  limit: number,
): Promise<BingXKline[]> {
  const id = symbol.replace(/-/g, "").toUpperCase();
  for (const host of BINANCE_HOSTS) {
    try {
      const res = await fetch(
        `${host}/api/v3/klines?symbol=${encodeURIComponent(id)}&interval=${interval}&limit=${limit}&endTime=${endTimeExclusive - 1}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const raw = (await res.json()) as unknown;
      if (!Array.isArray(raw)) continue;
      return raw
        .map((k: unknown[]) => ({
          time: Number(k[0]),
          open: String(k[1]),
          high: String(k[2]),
          low: String(k[3]),
          close: String(k[4]),
          volume: String(k[5]),
        }))
        .filter((k) => Number.isFinite(k.time));
    } catch {
      // try the next host
    }
  }
  return [];
}

export async function getKlinesWithDeepHistory(
  symbol: string,
  interval: "1h" | "4h",
  limit: number,
  requiredClosed: number,
  countClosed: (candles: readonly BingXKline[]) => number,
  options: { strictPayload?: boolean } = {},
): Promise<BingXKline[]> {
  let bingx = await getKlines(
    symbol,
    interval,
    Math.min(limit, 1000),
    undefined,
    undefined,
    options,
  );
  // BingX returns at most ~1000-1440 candles per request: page backwards.
  for (
    let page = 0;
    page < 3 && bingx.length > 0 && bingx.length < limit;
    page++
  ) {
    const oldest = Math.min(...bingx.map((k) => k.time));
    const older = await getKlines(
      symbol,
      interval,
      Math.min(1000, limit - bingx.length),
      undefined,
      oldest - 1,
      options,
    );
    const fresh = older.filter((k) => k.time < oldest);
    if (fresh.length === 0) break;
    bingx = [...fresh, ...bingx].sort((a, b) => a.time - b.time);
  }
  if (bingx.length === 0 || countClosed(bingx) >= requiredClosed) return bingx;
  const first = Math.min(...bingx.map((k) => k.time));
  const missing = Math.min(1000, limit - bingx.length + 1);
  if (missing <= 0 || !INTERVAL_MS[interval]) return bingx;
  const older = await fetchBinanceSpotBefore(symbol, interval, first, missing);
  return older.length === 0 ? bingx : mergeOlderHistory(bingx, older);
}
