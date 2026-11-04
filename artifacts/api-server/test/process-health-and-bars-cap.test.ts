import test from "node:test";
import assert from "node:assert/strict";
import {
  KLINE_EST_BYTES,
  MAX_BARS_PER_ENTRY,
  bingxBarsStoreSize,
  clearBingxBarsStoreForTests,
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

test("stored bars per entry are capped to the newest ones", () => {
  clearBingxBarsStoreForTests();
  rememberBingxKlines(
    "A-USDT",
    "1h",
    Array.from({ length: 500 }, (_, i) => bar(i * H)),
  );
  const size = bingxBarsStoreSize();
  assert.equal(size.klines, MAX_BARS_PER_ENTRY);
  assert.equal(size.estBytes, MAX_BARS_PER_ENTRY * KLINE_EST_BYTES);
  // newest bar kept, oldest dropped
  assert.ok(readBingxKlines("A-USDT", "1h", 499 * H, 499 * H, 499 * H, 1));
  assert.equal(readBingxKlines("A-USDT", "1h", 0, 0, 0, 1), null);
});

test("intervals the gate never reads are not stored", () => {
  clearBingxBarsStoreForTests();
  rememberBingxKlines("A-USDT", "1m", [bar(0)]);
  assert.equal(bingxBarsStoreSize().entries, 0);
});

test("total byte cap evicts oldest entries and keeps counters exact", () => {
  clearBingxBarsStoreForTests();
  const bars = Array.from({ length: MAX_BARS_PER_ENTRY }, (_, i) => bar(i * H));
  for (let i = 0; i < 3000; i++) rememberBingxKlines(`S${i}-USDT`, "1h", bars);
  const size = bingxBarsStoreSize();
  assert.ok(size.estBytes <= 48 * 1024 * 1024);
  assert.equal(size.klines, size.entries * MAX_BARS_PER_ENTRY);
  assert.equal(readBingxKlines("S0-USDT", "1h", 0, 0, 0, 1), null);
  assert.ok(readBingxKlines("S2999-USDT", "1h", 0, 0, 0, 1));
  // replacing an entry does not double count
  rememberBingxKlines("S2999-USDT", "1h", bars);
  assert.equal(bingxBarsStoreSize().klines, size.klines);
});
