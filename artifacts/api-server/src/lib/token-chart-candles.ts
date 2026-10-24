import type {
  BreakoutCandle,
  BreakoutCandleSource,
} from "./breakout-analysis.js";

/** Observation-only chart data: keep every genuinely closed candle, including the newest one. */
export function closedTokenChartCandles(
  rows: readonly BreakoutCandleSource[],
  intervalMs: number,
  now = Date.now(),
): BreakoutCandle[] {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.time) &&
        Number.isFinite(row.open) &&
        Number.isFinite(row.high) &&
        Number.isFinite(row.low) &&
        Number.isFinite(row.close) &&
        Number.isFinite(row.volume) &&
        row.high >= row.low &&
        row.time + intervalMs <= now,
    );
}
