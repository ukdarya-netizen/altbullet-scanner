import test from "node:test";
import assert from "node:assert/strict";
import { AutoRangeHistoryQueue } from "../src/lib/auto-range-history.js";
import {
  bingxKlineCodec,
  packedToClosedCandles,
} from "../src/lib/auto-range-packed.js";
import { normalizeClosedBreakoutCandles } from "../src/lib/breakout-analysis.js";
import {
  batchGetCoinglassOI,
  drainCgOiSourceCounts,
} from "../src/lib/coinglass_oi.js";

const H = 3_600_000;
const k = (i: number, over: Record<string, string> = {}) =>
  ({
    time: i * H,
    open: String(1 + i * 0.001),
    high: String(2 + i * 0.001),
    low: String(0.5 + i * 0.001),
    close: String(1.5 + i * 0.001),
    volume: String(100 + i),
    ...over,
  }) as never;

const make = (withCodec: boolean) =>
  new AutoRangeHistoryQueue<never>({
    countClosedCandles: (c) =>
      normalizeClosedBreakoutCandles(c as never).length,
    codec: withCodec ? (bingxKlineCodec as never) : undefined,
    requiredClosedCandles: 5,
    candleLimit: 50,
  });

test("packed storage gives the same closed candles and readiness as objects", () => {
  const rows = [
    ...Array.from({ length: 80 }, (_, i) => k(i)),
    k(200, { high: "0.1", low: "9" }), // invalid: high < low
    k(300, { close: "NaN" }), // invalid: not finite
    k(301),
  ];
  const a = make(false);
  const b = make(true);
  for (const q of [a, b]) {
    q.merge("1h:X", rows);
    q.merge("1h:X", rows.slice(40)); // overlapping re-merge
    q.hydrate("1h:X", rows, 123);
  }
  assert.equal(b.cacheStats().candles, a.cacheStats().candles);
  assert.equal(b.cacheStats().candles, 50);
  assert.equal(b.isHistoryReady("1h:X"), a.isHistoryReady("1h:X"));
  const expected = normalizeClosedBreakoutCandles(
    a.getCandles("1h:X") as never,
  );
  const got = packedToClosedCandles(b.getPackedRows("1h:X")!);
  assert.deepEqual(got, expected);
  assert.deepEqual(
    (b.getCandles("1h:X") as unknown as Array<{ time: number }>).map(
      (c) => c.time,
    ),
    (a.getCandles("1h:X") as unknown as Array<{ time: number }>).map(
      (c) => c.time,
    ),
  );
});

test("packed storage is far smaller than one object per candle", () => {
  const q = make(true);
  const big = new AutoRangeHistoryQueue<never>({
    countClosedCandles: () => 0,
    codec: bingxKlineCodec as never,
    candleLimit: 3000,
  });
  big.merge(
    "1h:Y",
    Array.from({ length: 2100 }, (_, i) => k(i)),
  );
  assert.equal(big.cacheStats().packedBytes, 2100 * 6 * 8);
  assert.ok(q);
});

const row = (oiUsd: number) => ({
  oiUsd,
  mcapUsd: null,
  oiChange30m: 1,
  oiChange1h: 2,
  oiChange4h: 3,
  oiChange24h: 4,
});

test("snapshot mode: every symbol's OI is the snapshot's; history never substitutes", async () => {
  const rows = new Map([
    ["AAA", row(1e6)],
    ["BBB", row(2e6)],
    ["ARM", row(3e6)],
    ["PRE", row(4e6)],
  ]);
  const aborted = new AbortController();
  aborted.abort(); // every history fetch is cancelled
  const res = await batchGetCoinglassOI(
    ["AAA-USDT", "BBB-USDT", "ARM-USDT", "PRE-USDT", "ZZZ-USDT"],
    undefined,
    undefined,
    aborted.signal,
    { arms: new Set(["ARM-USDT"]), prescan: new Set(["PRE-USDT"]) },
    { snapshot: { rows, loadedAt: 1 }, label: "test" },
  );
  assert.equal(res.get("AAA-USDT")?.oiUsd, 1e6);
  assert.equal(res.get("BBB-USDT")?.oiUsd, 2e6);
  // Arms are not a history consumer: snapshot OI, no history, no flag.
  assert.equal(res.get("ARM-USDT")?.oiUsd, 3e6);
  assert.equal(res.get("ARM-USDT")?.historyMissing, undefined);
  // Prescan symbol: history failed -> snapshot OI stays, history fields null.
  const pre = res.get("PRE-USDT")!;
  assert.equal(pre.available, true);
  assert.equal(pre.oiUsd, 4e6);
  assert.equal(pre.prevOi30m, null);
  assert.equal(pre.oi4hConsecFromOhlc, null);
  assert.equal(pre.historyMissing, true);
  // Absent from the snapshot: no OI and no per-symbol request.
  assert.equal(res.get("ZZZ-USDT")?.available, false);
  assert.equal(res.get("ZZZ-USDT")?.unavailableReason, "not_in_snapshot");
  const d = drainCgOiSourceCounts();
  assert.equal(d.calls.length, 1);
  assert.equal(d.fromCoinsMarketsSnapshot, 4);
  assert.equal(d.historyRequests, 1);
  assert.equal(d.historyMerged, 0);
  assert.equal(d.historyMissing, 1);
  assert.deepEqual(d.historyPathSymbols, ["ZZZ-USDT"]);
});
