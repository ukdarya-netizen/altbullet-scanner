import { test } from "node:test";
import assert from "node:assert/strict";
import { closedTokenChartCandles } from "../src/lib/token-chart-candles.js";

const DAY = 24 * 60 * 60_000;
const dayStart = Date.UTC(2026, 8, 28);
const candle = (time: number) => ({
  time,
  open: "100",
  high: "120",
  low: "90",
  close: "110",
  volume: "1000",
});

test("daily chart retains a closed last candle when the new day is not yet returned", () => {
  const rows = [candle(dayStart - DAY)];
  assert.deepEqual(
    closedTokenChartCandles(rows, DAY, dayStart + 1000).map((row) => row.time),
    [dayStart - DAY],
  );
});

test("daily chart excludes the forming candle until its full interval has ended", () => {
  const rows = [candle(dayStart - DAY), candle(dayStart)];
  assert.deepEqual(
    closedTokenChartCandles(rows, DAY, dayStart + DAY - 1).map(
      (row) => row.time,
    ),
    [dayStart - DAY],
  );
  assert.deepEqual(
    closedTokenChartCandles(rows, DAY, dayStart + DAY).map((row) => row.time),
    [dayStart - DAY, dayStart],
  );
});

test("hourly chart excludes invalid market rows and the forming hour", () => {
  const HOUR = 60 * 60_000;
  const rows = [
    candle(dayStart - HOUR),
    { ...candle(dayStart - HOUR * 2), high: "0" },
    candle(dayStart),
  ];
  assert.deepEqual(
    closedTokenChartCandles(rows, HOUR, dayStart + 1000).map((row) => row.time),
    [dayStart - HOUR],
  );
});
