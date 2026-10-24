import type { BingXKline } from "./bingx.js";
import type { AutoRangeCandleCodec } from "./auto-range-history.js";

/**
 * Compact Auto Range candle storage: six float64 per candle (time, open, high,
 * low, close, volume) in one Float64Array instead of one object with five
 * strings per candle (~290 B measured vs 48 B).
 */
export const PACKED_STRIDE = 6;

export const bingxKlineCodec: AutoRangeCandleCodec<BingXKline> = {
  stride: PACKED_STRIDE,
  write(c, out, o) {
    out[o] = Number(c.time);
    out[o + 1] = Number(c.open);
    out[o + 2] = Number(c.high);
    out[o + 3] = Number(c.low);
    out[o + 4] = Number(c.close);
    out[o + 5] = Number(c.volume);
  },
  read(d, o) {
    return {
      time: d[o]!,
      open: String(d[o + 1]),
      high: String(d[o + 2]),
      low: String(d[o + 3]),
      close: String(d[o + 4]),
      volume: String(d[o + 5]),
    } as BingXKline;
  },
  countClosed(d) {
    return Math.max(0, validRows(d) - 1);
  },
};

function isValidRow(d: Float64Array, o: number): boolean {
  return (
    Number.isFinite(d[o]!) &&
    Number.isFinite(d[o + 1]!) &&
    Number.isFinite(d[o + 2]!) &&
    Number.isFinite(d[o + 3]!) &&
    Number.isFinite(d[o + 4]!) &&
    Number.isFinite(d[o + 5]!) &&
    d[o + 2]! >= d[o + 3]!
  );
}

function validRows(d: Float64Array): number {
  let n = 0;
  for (let o = 0; o < d.length; o += PACKED_STRIDE) if (isValidRow(d, o)) n++;
  return n;
}

export type PackedClosedCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Same result as normalizeClosedBreakoutCandles(rows) (breakout-analysis.ts:
 * 394-419): valid rows only, forming (last) candle dropped.
 */
export function packedToClosedCandles(d: Float64Array): PackedClosedCandle[] {
  const out: PackedClosedCandle[] = [];
  for (let o = 0; o < d.length; o += PACKED_STRIDE) {
    if (!isValidRow(d, o)) continue;
    out.push({
      time: d[o]!,
      open: d[o + 1]!,
      high: d[o + 2]!,
      low: d[o + 3]!,
      close: d[o + 4]!,
      volume: d[o + 5]!,
    });
  }
  out.pop();
  return out;
}
