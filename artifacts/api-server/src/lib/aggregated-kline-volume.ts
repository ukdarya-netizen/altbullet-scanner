import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getAggFuturesTakerExchanges } from "./coinglass_taker.js";

const INTERVAL_MS: Record<string, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

type VolumeKline = { time: number; close: string; volume: string };

/**
 * Replaces candle volume with aggregated (CoinGlass, multi-exchange futures
 * taker buy+sell) volume, expressed in base-asset units (USD / close) so that
 * volume x close equals the aggregated USD turnover and ratios are unchanged.
 * Candles without an aggregated value (or when CoinGlass is unavailable) get
 * volume "NaN": unavailable, never a BingX value.
 */
export async function withAggregatedKlineVolume<T extends VolumeKline>(
  bingxSymbol: string,
  interval: string,
  klines: readonly T[],
): Promise<T[]> {
  const unavailable = () => klines.map((k) => ({ ...k, volume: "NaN" }));
  const stepMs = INTERVAL_MS[interval];
  if (!stepMs || klines.length === 0) return unavailable();
  const apiKey = getNextCgKey();
  if (!apiKey) return unavailable();
  const first = Math.min(...klines.map((k) => k.time));
  const last = Math.max(...klines.map((k) => k.time));
  const base = bingxSymbol.replace(/-?USDT$/i, "").toUpperCase();
  const url = new URL(
    "https://open-api-v4.coinglass.com/api/futures/aggregated-taker-buy-sell-volume/history",
  );
  url.searchParams.set("exchange_list", getAggFuturesTakerExchanges());
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", interval);
  url.searchParams.set("start_time", String(first));
  url.searchParams.set("end_time", String(last + stepMs));
  url.searchParams.set(
    "limit",
    String(Math.min(4500, Math.ceil((last - first) / stepMs) + 4)),
  );
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
      {
        priority: "high",
        endpoint: "futures/aggregated-taker-buy-sell-volume/history",
      },
    );
    if (res.status === 429) {
      logCg429(apiKey, { symbol: base });
      return unavailable();
    }
    if (!res.ok) return unavailable();
    const body = (await res.json()) as {
      code?: string;
      data?: {
        time: number;
        aggregated_buy_volume_usd: unknown;
        aggregated_sell_volume_usd: unknown;
      }[];
    };
    if (body.code !== "0" || !body.data?.length) return unavailable();
    const usd = new Map(
      body.data.map((r) => [
        r.time,
        (Number(r.aggregated_buy_volume_usd) || 0) +
          (Number(r.aggregated_sell_volume_usd) || 0),
      ]),
    );
    return klines.map((k) => {
      const v = usd.get(k.time);
      const close = Number(k.close);
      return {
        ...k,
        volume:
          v !== undefined && v > 0 && close > 0 ? String(v / close) : "NaN",
      };
    });
  } catch {
    return unavailable();
  }
}
