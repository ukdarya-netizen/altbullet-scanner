import type { BingXKline } from "./bingx.js";

/**
 * Latest BingX candles the scanner already loaded, per symbol and interval.
 * Lets consumers (Stealth volume gate: open/close/low of the traded contract)
 * reuse them with zero extra requests.
 *
 * Bounds (consumers read at most trigger-30 .. trigger+1 bars, ~32 bars):
 * - only the intervals the gate can ask for are stored;
 * - at most MAX_BARS_PER_ENTRY newest bars per entry; an older trigger misses
 *   and falls back to the one BingX range request the gate always had;
 * - total estimated bytes are capped, oldest-inserted entries go first.
 */
const MAX_ENTRIES = 4000;
export const MAX_BARS_PER_ENTRY = 120;
export const MAX_STORE_BYTES = 48 * 1024 * 1024;
/** Measured heap cost of one BingXKline object (node, 2026-10). */
export const KLINE_EST_BYTES = 290;
const STORED_INTERVALS = new Set(["15m", "30m", "1h", "4h"]);
const store = new Map<string, { at: number; klines: BingXKline[] }>();
let storedKlines = 0;
let hits = 0;
let misses = 0;

function dropOldest(): boolean {
  const oldest = store.keys().next().value;
  if (oldest === undefined) return false;
  storedKlines -= store.get(oldest)?.klines.length ?? 0;
  store.delete(oldest);
  return true;
}

export function rememberBingxKlines(
  symbol: string,
  interval: string,
  klines: BingXKline[],
): void {
  if (klines.length === 0 || !STORED_INTERVALS.has(interval)) return;
  const key = `${symbol}|${interval}`;
  const kept =
    klines.length > MAX_BARS_PER_ENTRY
      ? klines.slice(-MAX_BARS_PER_ENTRY)
      : klines;
  const previous = store.get(key);
  if (previous) {
    storedKlines -= previous.klines.length;
    store.delete(key);
  }
  store.set(key, { at: Date.now(), klines: kept });
  storedKlines += kept.length;
  while (
    (store.size > MAX_ENTRIES ||
      storedKlines * KLINE_EST_BYTES > MAX_STORE_BYTES) &&
    store.size > 1 &&
    dropOldest()
  ) {
    // evicting oldest-inserted entries
  }
}

/** Current store footprint: entries, candles, estimated heap bytes. */
export function bingxBarsStoreSize(): {
  entries: number;
  klines: number;
  estBytes: number;
} {
  return {
    entries: store.size,
    klines: storedKlines,
    estBytes: storedKlines * KLINE_EST_BYTES,
  };
}

/**
 * Candles from `fromTime` to `toTime` inclusive, or null when the stored window
 * does not contain the bar at `mustHaveTime` plus `minBars` bars up to it.
 */
export function readBingxKlines(
  symbol: string,
  interval: string,
  fromTime: number,
  toTime: number,
  mustHaveTime: number,
  minBars: number,
): BingXKline[] | null {
  const entry = store.get(`${symbol}|${interval}`);
  const rows = entry?.klines.filter(
    (k) => k.time >= fromTime && k.time <= toTime,
  );
  if (
    !rows ||
    rows.length < minBars ||
    !rows.some((k) => k.time === mustHaveTime)
  ) {
    misses++;
    return null;
  }
  hits++;
  return rows;
}

export function drainBingxBarsStoreStats(): { hits: number; misses: number } {
  const out = { hits, misses };
  hits = 0;
  misses = 0;
  return out;
}

export function clearBingxBarsStoreForTests(): void {
  store.clear();
  storedKlines = 0;
  hits = 0;
  misses = 0;
}
