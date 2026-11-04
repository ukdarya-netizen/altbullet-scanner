/**
 * Aggregated CURRENT funding rate (CoinGlass /api/futures/funding-rate/exchange-list).
 * Median across Binance, Bybit, OKX and BingX, each normalised to an 8h
 * interval, in percent. Owner 2026-10-23: replaces the removed 7d cumulative
 * funding; only the value at signal time is used. No BingX-only fallback.
 */
import { applyCgAlias } from "./cg-symbol-alias.js";
import { reportApiSuccess } from "./apiHealth.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

interface CgFundingExchangeEntry {
  exchange: string;
  funding_rate?: number;
  funding_rate_interval?: number;
}
interface CgFundingSymbolEntry {
  symbol: string;
  stablecoin_margin_list?: CgFundingExchangeEntry[];
  token_margin_list?: CgFundingExchangeEntry[];
}

const CACHE_MS = 5 * 60 * 1000;
const EXCHANGES = ["binance", "bybit", "okx", "bingx"];
const cache = new Map<string, { value: number; ts: number }>();

export function medianFunding8h(
  entries: readonly CgFundingExchangeEntry[],
): number | null {
  const rates = entries
    .filter((e) =>
      EXCHANGES.some((ex) => e.exchange.toLowerCase().includes(ex)),
    )
    .map((e) => {
      if (typeof e.funding_rate !== "number" || !isFinite(e.funding_rate))
        return null;
      const interval =
        typeof e.funding_rate_interval === "number" &&
        e.funding_rate_interval > 0
          ? e.funding_rate_interval
          : 8;
      return (e.funding_rate * 8) / interval;
    })
    .filter((r): r is number => r !== null)
    .sort((a, b) => a - b);
  if (rates.length === 0) return null;
  const mid = rates.length / 2;
  return rates.length % 2 === 0
    ? (rates[mid - 1]! + rates[mid]!) / 2
    : rates[Math.floor(mid)]!;
}

export async function getCoinglassCurrentFunding(
  bingxSymbol: string,
): Promise<number | null> {
  const cgSymbol = applyCgAlias(bingxSymbol.replace("-USDT", ""));
  const cached = cache.get(cgSymbol);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.value;
  const apiKey = getNextCgKey();
  if (!apiKey) return null;
  try {
    const res = await cgTimedFetch(
      `https://open-api-v4.coinglass.com/api/futures/funding-rate/exchange-list?symbol=${cgSymbol}`,
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code: string;
      data?: CgFundingSymbolEntry[];
    };
    if (data.code !== "0" || !Array.isArray(data.data) || !data.data[0])
      return null;
    const sym = data.data[0];
    const value = medianFunding8h([
      ...(sym.stablecoin_margin_list ?? []),
      ...(sym.token_margin_list ?? []),
    ]);
    if (value !== null) {
      cache.set(cgSymbol, { value, ts: Date.now() });
      reportApiSuccess("coinglass");
    }
    return value;
  } catch {
    return null;
  }
}
