import assert from "node:assert/strict";
import test from "node:test";
import { selectReentryCandles } from "../src/lib/stealth-range-reentry.js";

const H = 3_600_000;
const bar = (i: number, close: number) => ({
  time: i * H,
  open: close,
  high: close,
  low: close,
  close,
});

test("only candles that close above the level after the cancel qualify", () => {
  const bars = [bar(10, 1.1), bar(11, 0.9), bar(12, 1.2), bar(13, 1.0)];
  // cancel at 12:00 → candle 11 (closes 12:00) is not after it; 12 qualifies
  const got = selectReentryCandles(bars, 12 * H, 1, 14 * H);
  assert.deepEqual(
    got.map((k) => k.time),
    [12 * H],
  );
});

test("candles beyond 48h or older than the fresh window are ignored", () => {
  const bars = [bar(13, 1.2), bar(61, 1.2), bar(62, 1.2)];
  const cancel = 12 * H;
  // now = 61h+: candle 13 closed 47h ago (stale), 61 closes at 62h (> 12+48=60h)
  assert.deepEqual(selectReentryCandles(bars, cancel, 1, 62 * H), []);
  // wide fresh window keeps in-window candle 13 only
  assert.deepEqual(
    selectReentryCandles(bars, cancel, 1, 62 * H, 100 * H).map((k) => k.time),
    [13 * H],
  );
});

test("an open (not yet closed) candle is never used", () => {
  assert.deepEqual(
    selectReentryCandles([bar(20, 1.2)], 10 * H, 1, 20.5 * H),
    [],
  );
});
