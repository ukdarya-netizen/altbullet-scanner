import { reportApiSuccess, reportApiFailure } from "./apiHealth.js";
import { marketFetch } from "./marketRequestBudget.js";

export interface TrendingResult {
  rank: number | null;
  source: "CMC" | "CoinGecko" | null;
  available: boolean;
}

// Normalize symbol for comparison: "BTC-USDT" → "BTC", "BTCUSDT" → "BTC"
function normalizeSymbol(symbol: string): string {
  return symbol
    .replace(/-USDT$/, "")
    .replace(/USDT$/, "")
    .toUpperCase();
}

// CoinGecko trending — free, no API key needed, returns top 7 trending
let cgCacheTime = 0;
let cgCache: { id: string; symbol: string; rank: number }[] = [];
const CG_CACHE_TTL = 15 * 60 * 1000; // 15 min

async function getCoinGeckoTrending(): Promise<
  { id: string; symbol: string; rank: number }[]
> {
  if (Date.now() - cgCacheTime < CG_CACHE_TTL && cgCache.length > 0)
    return cgCache;

  try {
    const res = await marketFetch(
      "https://api.coingecko.com/api/v3/search/trending",
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
      { label: "coingecko:trending" },
    );
    if (!res.ok) {
      reportApiFailure("coingecko", res.status);
      return cgCache;
    }

    const data = (await res.json()) as {
      coins: {
        item: { id: string; symbol: string; market_cap_rank: number };
      }[];
    };

    cgCache = data.coins.map((c, i) => ({
      id: c.item.id,
      symbol: c.item.symbol.toUpperCase(),
      rank: i + 1,
    }));
    cgCacheTime = Date.now();
    reportApiSuccess("coingecko");
    return cgCache;
  } catch {
    reportApiFailure("coingecko");
    return cgCache;
  }
}

// CMC Trending — requires CMC_API_KEY (free Basic plan)
let cmcCacheTime = 0;
let cmcCache: { symbol: string; rank: number }[] = [];

async function getCMCTrending(): Promise<{ symbol: string; rank: number }[]> {
  const apiKey = process.env.CMC_API_KEY;
  if (!apiKey) return [];

  if (Date.now() - cmcCacheTime < CG_CACHE_TTL && cmcCache.length > 0)
    return cmcCache;

  try {
    const res = await marketFetch(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/trending/latest?limit=50",
      {
        headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
      { label: "coinmarketcap:trending" },
    );
    if (!res.ok) return cmcCache;

    const data = (await res.json()) as {
      data: { symbol: string; cmc_rank: number }[];
    };

    cmcCache = data.data.map((c, i) => ({
      symbol: c.symbol.toUpperCase(),
      rank: i + 1,
    }));
    cmcCacheTime = Date.now();
    return cmcCache;
  } catch {
    return cmcCache;
  }
}

export async function getTrendingRank(symbol: string): Promise<TrendingResult> {
  const base = normalizeSymbol(symbol);

  // Try CMC first if key available
  const cmcData = await getCMCTrending();
  if (cmcData.length > 0) {
    const match = cmcData.find((c) => c.symbol === base);
    return {
      rank: match?.rank ?? null,
      source: "CMC",
      available: true,
    };
  }

  // Fallback to CoinGecko (free, top 7)
  const cgData = await getCoinGeckoTrending();
  if (cgData.length > 0) {
    const match = cgData.find((c) => c.symbol === base);
    return {
      rank: match?.rank ?? null,
      source: "CoinGecko",
      available: true,
    };
  }

  return { rank: null, source: null, available: false };
}
