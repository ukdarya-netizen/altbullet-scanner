import test from "node:test";
import assert from "node:assert/strict";
import {
  clearBingxBarsStoreForTests,
  drainBingxBarsStoreStats,
  readBingxKlines,
  rememberBingxKlines,
} from "../src/lib/bingx-bars-store.js";

const H = 3_600_000;
const bar = (time: number) =>
  ({
    time,
    open: "1",
    high: "2",
    low: "0.5",
    close: "1.5",
    volume: "9",
  }) as never;

test("scanner candles are reused for the gate without a request", () => {
  clearBingxBarsStoreForTests();
  const trigger = 100 * H;
  rememberBingxKlines(
    "ATOM-USDT",
    "1h",
    Array.from({ length: 40 }, (_, i) => bar(trigger - 30 * H + i * H)),
  );
  const rows = readBingxKlines(
    "ATOM-USDT",
    "1h",
    trigger - 30 * H,
    trigger + H,
    trigger,
    21,
  );
  assert.ok(rows && rows.length >= 21);
  assert.equal(drainBingxBarsStoreStats().hits, 1);
});
test("missing trigger bar or short window is a miss", () => {
  clearBingxBarsStoreForTests();
  rememberBingxKlines("X-USDT", "1h", [bar(1 * H), bar(2 * H)]);
  assert.equal(readBingxKlines("X-USDT", "1h", 0, 10 * H, 2 * H, 21), null);
  assert.equal(readBingxKlines("Y-USDT", "1h", 0, 10 * H, 2 * H, 1), null);
  assert.equal(drainBingxBarsStoreStats().misses, 2);
});
