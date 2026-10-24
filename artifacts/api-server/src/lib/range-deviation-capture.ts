import { getKlines } from "./bingx.js";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import {
  buildRange15mContext,
  buildRangeDeviationContext,
  type RangeDeviationContext,
  type RawCandle,
} from "./range-deviation-context.js";

const FETCH_TIMEOUT_MS = 6_000;

/**
 * Fetches closed-candle history and builds the Range/deviation observation.
 * `asOf` (ms) reproduces the context as it stood at that moment (backfill);
 * omit it for live fire-time capture. Fail-open: a failed timeframe fetch
 * yields a "no range" entry for that timeframe, never an exception.
 */
export async function captureRangeDeviation(
  symbol: string,
  entryPrice: number,
  asOf?: number,
): Promise<RangeDeviationContext> {
  const now = asOf ?? Date.now();
  const load = (interval: string, limit: number): Promise<RawCandle[] | null> =>
    Promise.race([
      getKlines(symbol, interval, limit, undefined, asOf)
        .then((rows) => withAggregatedKlineVolume(symbol, interval, rows))
        .then((rows) =>
          rows.map((k) => ({
            time: Number(k.time),
            open: Number(k.open),
            high: Number(k.high),
            low: Number(k.low),
            close: Number(k.close),
            volume: Number(k.volume),
          })),
        ),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
      ),
    ]).catch(() => null);
  const [candles1d, candles4h, candles1h, candles15m] = await Promise.all([
    load("1d", 1000),
    load("4h", 901),
    load("1h", 901),
    load("15m", 901),
  ]);
  return buildRangeDeviationContext({
    candles1d,
    candles4h,
    candles1h,
    candles15m,
    entryPrice,
    now,
    source: asOf === undefined ? "fire_time" : "backfilled_as_of_fire_time",
  });
}

/** As-of-detection 15m Range only (fail-open: null when candles are missing). */
export async function captureRange15m(
  symbol: string,
  entryPrice: number,
  asOf: number,
) {
  const rows = await Promise.race([
    getKlines(symbol, "15m", 901, undefined, asOf).then((r) =>
      withAggregatedKlineVolume(symbol, "15m", r),
    ),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
    ),
  ]).catch(() => null);
  if (!rows || rows.length === 0) return null;
  return buildRange15mContext(
    rows.map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    })),
    entryPrice,
    asOf,
  );
}
