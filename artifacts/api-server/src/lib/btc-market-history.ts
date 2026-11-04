import { getKlines, type BingXKline } from "./bingx.js";
import type { BitcoinDominanceSummary } from "./coinglass_btc_dominance.js";
import { logger } from "./logger.js";

export interface BtcMarketHistoryPoint {
  timestamp: string;
  dominance: number | null;
  btcPrice: number | null;
}

export interface BtcMarketHistory {
  history: BtcMarketHistoryPoint[];
  dominanceSource: "coinglass" | "signal_snapshots" | "coingecko_live" | null;
  priceSource: "bingx" | "stored_snapshots" | null;
}

type Sample = { observedAt: string | null; value: number | null };
type PriceSnapshot = { observedAt: string; price: number | null };

const DAY_MS = 24 * 60 * 60 * 1000;
let candleCache: { fetchedAt: number; candles: BingXKline[] } | undefined;
let inFlight: Promise<BingXKline[]> | undefined;

export async function getBtcDailyCandles(): Promise<BingXKline[]> {
  if (candleCache && Date.now() - candleCache.fetchedAt < 30 * 60_000) {
    return candleCache.candles;
  }
  if (inFlight) return inFlight;
  inFlight = getKlines("BTC-USDT", "1d", 32)
    .catch((error) => {
      logger.warn({ error }, "BTC daily price history unavailable");
      return [];
    })
    .then((candles) => {
      candleCache = { fetchedAt: Date.now(), candles };
      return candles;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

export function buildBtcMarketHistory(input: {
  dominance: BitcoinDominanceSummary | null;
  signalDominance: Sample[];
  priceCandles: Pick<BingXKline, "time" | "close">[];
  priceSnapshots: PriceSnapshot[];
  now: Date;
}): BtcMarketHistory {
  const today = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
  );
  const firstDay = today - 29 * DAY_MS;
  const byDay = new Map<string, BtcMarketHistoryPoint>();
  const pointAt = (timestamp: string) => {
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time) || time < firstDay || time > input.now.getTime())
      return null;
    const day = new Date(time).toISOString().slice(0, 10);
    let point = byDay.get(day);
    if (!point) {
      point = {
        timestamp: `${day}T00:00:00.000Z`,
        dominance: null,
        btcPrice: null,
      };
      byDay.set(day, point);
    }
    return point;
  };
  const validDominance = (value: number | null) =>
    value != null && Number.isFinite(value) && value > 0 && value <= 100;
  const validPrice = (value: number | null) =>
    value != null && Number.isFinite(value) && value > 0;

  let dominanceSource: BtcMarketHistory["dominanceSource"] = null;
  if (
    input.dominance?.source === "coinglass" &&
    input.dominance.history.length >= 2
  ) {
    for (const item of input.dominance.history) {
      const point = pointAt(item.timestamp);
      if (point && validDominance(item.dominance))
        point.dominance = item.dominance;
    }
    dominanceSource = "coinglass";
  } else {
    let usedSignalSnapshots = false;
    for (const sample of [...input.signalDominance].sort((a, b) =>
      (a.observedAt ?? "").localeCompare(b.observedAt ?? ""),
    )) {
      if (!sample.observedAt || !validDominance(sample.value)) continue;
      const point = pointAt(sample.observedAt);
      if (point) {
        point.dominance = sample.value;
        usedSignalSnapshots = true;
      }
    }
    if (usedSignalSnapshots) dominanceSource = "signal_snapshots";
    if (input.dominance && validDominance(input.dominance.current)) {
      const point = pointAt(input.dominance.updatedAt);
      if (point) {
        point.dominance = input.dominance.current;
        dominanceSource ??= "coingecko_live";
      }
    }
  }

  for (const snapshot of [...input.priceSnapshots].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  )) {
    if (!validPrice(snapshot.price)) continue;
    const point = pointAt(snapshot.observedAt);
    if (point) point.btcPrice = snapshot.price;
  }
  let priceSource: BtcMarketHistory["priceSource"] = [...byDay.values()].some(
    (point) => point.btcPrice !== null,
  )
    ? "stored_snapshots"
    : null;
  for (const candle of input.priceCandles) {
    const close = Number(candle.close);
    // Use only closed daily candles, never present an unfinished day's close.
    if (
      !Number.isFinite(candle.time) ||
      candle.time + DAY_MS > input.now.getTime() ||
      !validPrice(close)
    )
      continue;
    const point = pointAt(new Date(candle.time).toISOString());
    if (point) {
      point.btcPrice = close;
      priceSource = "bingx";
    }
  }
  return {
    history: [...byDay.values()]
      .filter((point) => point.dominance !== null || point.btcPrice !== null)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    dominanceSource,
    priceSource,
  };
}
