import {
  findCandleReaction,
  type CandleReaction,
  type RawCandle,
} from "./range-deviation-context.js";

/**
 * Liquidation Cascade entry filter. Historical audit of 240 closed LC signals
 * (reconstructed as of fire time): without a closed 15m candle in the prior 24h
 * whose lower wick is >= 1%, only 30% reached a >=10% peak (26% stops); with
 * one, 51% did (16% stops). No data means no signal (owner rule): unavailable data blocks.
 */
export const LC_MIN_LOWER_WICK_PCT = 2;
const CACHE_TTL_MS = 3 * 60 * 1000;

export type LcWickGateDecision =
  | {
      pass: true;
      reason: "ok";
      reaction: CandleReaction | null;
    }
  | {
      pass: false;
      reason: "no_lower_wick_reaction" | "wick_data_unavailable";
      reaction: CandleReaction | null;
    };

export function evaluateLcWickGate(
  candles15m: readonly RawCandle[] | null,
  now: number,
  minWickPct: number = LC_MIN_LOWER_WICK_PCT,
  detectedAt: number | null = null,
): LcWickGateDecision {
  if (!candles15m || candles15m.length === 0)
    return { pass: false, reason: "wick_data_unavailable", reaction: null };
  // Detection-candle mode (owner rule): exactly ONE closed 15m candle - the one
  // containing the liquidation detection time. No earlier, no later candles.
  // Missing candle data blocks (no data, no signal).
  let scope: readonly RawCandle[] = candles15m;
  if (detectedAt !== null) {
    const M15 = 15 * 60 * 1000;
    const start = Math.floor(detectedAt / M15) * M15;
    scope = candles15m.filter((c) => c.time === start);
    if (scope.length === 0)
      return { pass: false, reason: "wick_data_unavailable", reaction: null };
  }
  const reaction = findCandleReaction(scope, now, 0);
  if (!reaction)
    return { pass: false, reason: "wick_data_unavailable", reaction: null };
  if (reaction.lowerWickPct >= minWickPct)
    return { pass: true, reason: "ok", reaction };
  return { pass: false, reason: "no_lower_wick_reaction", reaction };
}

const cache = new Map<string, { at: number; candles: RawCandle[] }>();

export async function loadLcWickCandles(
  symbol: string,
  fetchKlines: (
    symbol: string,
    interval: string,
    limit: number,
  ) => Promise<
    {
      time: unknown;
      open: unknown;
      high: unknown;
      low: unknown;
      close: unknown;
      volume: unknown;
    }[]
  >,
  now: number = Date.now(),
  detectedAt: number | null = null,
  fetchRange?: (
    symbol: string,
    interval: "15m",
    startTime: number,
    endTime: number,
  ) => Promise<
    {
      time: unknown;
      open: unknown;
      high: unknown;
      low: unknown;
      close: unknown;
      volume: unknown;
    }[]
  >,
): Promise<RawCandle[] | null> {
  const M15 = 15 * 60 * 1000;
  // The recent window (110 bars ≈ 27h) does not reach older detections; a
  // missing detection candle must not silently pass the gate, so fetch it.
  if (detectedAt !== null && fetchRange && now - detectedAt > 100 * M15) {
    const start = Math.floor(detectedAt / M15) * M15 - M15;
    const rows = await Promise.race([
      fetchRange(symbol, "15m", start, start + 3 * M15),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
    ]).catch(() => null);
    if (!rows) return null;
    return rows.map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      // Candle volume is not used by this gate; BingX volume is never read.
      volume: Number.NaN,
    }));
  }
  const hit = cache.get(symbol);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.candles;
  const rows = await Promise.race([
    fetchKlines(symbol, "15m", 110),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
  ]).catch(() => null);
  if (!rows) return null;
  const candles = rows.map((k) => ({
    time: Number(k.time),
    open: Number(k.open),
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
    // Candle volume is not used by this gate; BingX volume is never read.
    volume: Number.NaN,
  }));
  cache.set(symbol, { at: now, candles });
  return candles;
}
