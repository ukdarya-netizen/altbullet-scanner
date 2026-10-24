import { cgTimedFetch } from "./cg_latency.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { logger } from "./logger.js";
import { saveBtcDominanceObservations } from "./btc-dominance-observations.js";

export interface BitcoinDominancePoint {
  timestamp: string;
  dominance: number;
  btcPrice: number | null;
  btcMarketCap: number | null;
}

export interface BitcoinDominanceSummary {
  current: number;
  change24h: number | null;
  change7d: number | null;
  updatedAt: string;
  source: "coinglass" | "coingecko";
  history: BitcoinDominancePoint[];
}

// Revisit the provider at least once an hour so independently collected
// readings can cover each Dubai calendar day without dashboard traffic.
const CACHE_TTL_MS = 55 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FRESH_MS = DAY_MS;
let cache:
  | { fetchedAt: number; value: BitcoinDominanceSummary | null }
  | undefined;
let inFlight: Promise<BitcoinDominanceSummary | null> | undefined;

async function remember(
  value: BitcoinDominanceSummary,
): Promise<BitcoinDominanceSummary> {
  try {
    await saveBtcDominanceObservations(value);
    cache = { fetchedAt: Date.now(), value };
  } catch (error) {
    // Do not cache an observation that hasn't been saved: the next request
    // must be able to retry the durable write.
    logger.warn({ error }, "BTC dominance observation could not be saved");
  }
  return value;
}

// CoinGlass observations can be sub-daily. Keep the extra UTC boundary day
// too: the 30-day Dubai chart begins at 20:00 UTC on the preceding UTC date.
export function recentDominanceHistory(
  points: readonly BitcoinDominancePoint[],
  now = new Date(),
): BitcoinDominancePoint[] {
  const firstDay =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
    30 * DAY_MS;
  return points.filter((point) => {
    const timestamp = Date.parse(point.timestamp);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= firstDay &&
      timestamp <= now.getTime()
    );
  });
}

export function getBitcoinDominanceSummary(): Promise<BitcoinDominanceSummary | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return Promise.resolve(cache.value);
  }
  if (inFlight) return inFlight;
  inFlight = fetchBitcoinDominanceSummary().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function fetchBitcoinDominanceSummary(): Promise<BitcoinDominanceSummary | null> {
  const apiKey = getNextCgKey();
  if (!apiKey) return getCoinGeckoBitcoinDominance();

  try {
    const response = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/index/bitcoin-dominance",
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (response.status === 429) {
      logCg429(apiKey, { endpoint: "bitcoin-dominance" });
      return getCoinGeckoBitcoinDominance();
    }
    if (!response.ok) {
      logger.warn(
        { status: response.status },
        "Bitcoin dominance request failed",
      );
      return getCoinGeckoBitcoinDominance();
    }

    const body = (await response.json()) as {
      code?: string | number;
      data?: Array<{
        timestamp?: number | string;
        time?: number | string;
        bitcoin_dominance?: number | string;
        price?: number | string;
        market_cap?: number | string;
      }>;
    };
    if (String(body.code) !== "0" || !Array.isArray(body.data)) {
      return getCoinGeckoBitcoinDominance();
    }

    const points = body.data
      .map((item): BitcoinDominancePoint | null => {
        const rawTimestamp = Number(item.timestamp ?? item.time);
        const timestamp =
          rawTimestamp < 10_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
        const dominance = Number(item.bitcoin_dominance);
        const btcPrice = Number(item.price);
        const btcMarketCap = Number(item.market_cap);
        if (
          !Number.isFinite(timestamp) ||
          !Number.isFinite(dominance) ||
          dominance <= 0 ||
          dominance > 100 ||
          timestamp > Date.now() ||
          timestamp < Date.now() - 32 * DAY_MS
        ) {
          return null;
        }
        return {
          timestamp: new Date(timestamp).toISOString(),
          dominance,
          btcPrice: Number.isFinite(btcPrice) && btcPrice > 0 ? btcPrice : null,
          btcMarketCap: Number.isFinite(btcMarketCap) ? btcMarketCap : null,
        };
      })
      .filter((point): point is BitcoinDominancePoint => point !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const latest = points.at(-1);
    if (!latest) {
      return getCoinGeckoBitcoinDominance();
    }
    const previous = points.at(-2);
    const weekAgo = points.at(-8);
    const value: BitcoinDominanceSummary = {
      current: latest.dominance,
      change24h: previous
        ? Number((latest.dominance - previous.dominance).toFixed(3))
        : null,
      change7d: weekAgo
        ? Number((latest.dominance - weekAgo.dominance).toFixed(3))
        : null,
      updatedAt: latest.timestamp,
      source: "coinglass",
      history: recentDominanceHistory(points),
    };
    await remember(value);
    // CoinGlass may return a dated history whose last reading is already old.
    // Preserve those real observations but do not label them "current".
    if (Date.now() - Date.parse(latest.timestamp) > FRESH_MS) {
      cache = undefined;
      return getCoinGeckoBitcoinDominance();
    }
    return value;
  } catch (error) {
    logger.warn({ error }, "Bitcoin dominance request failed");
    return getCoinGeckoBitcoinDominance();
  }
}

export async function getCoinGeckoBitcoinDominance(): Promise<BitcoinDominanceSummary | null> {
  try {
    const response = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: {
        market_cap_percentage?: { btc?: number };
        updated_at?: number;
      };
    };
    const current = Number(body.data?.market_cap_percentage?.btc);
    const observedSeconds = body.data?.updated_at;
    if (
      !Number.isFinite(current) ||
      current <= 0 ||
      current > 100 ||
      !Number.isFinite(observedSeconds) ||
      !observedSeconds
    )
      return null;
    const observedMs = observedSeconds * 1000;
    if (observedMs > Date.now() || observedMs < Date.now() - 32 * DAY_MS)
      return null;
    const updatedAt = new Date(observedMs).toISOString();
    const value: BitcoinDominanceSummary = {
      current,
      change24h: null,
      change7d: null,
      updatedAt,
      source: "coingecko",
      history: [
        {
          timestamp: updatedAt,
          dominance: current,
          btcPrice: null,
          btcMarketCap: null,
        },
      ],
    };
    return remember(value);
  } catch (error) {
    logger.warn({ error }, "CoinGecko Bitcoin dominance fallback failed");
    return null;
  }
}
