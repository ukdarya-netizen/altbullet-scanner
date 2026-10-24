import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_RANGE_PINE_1H_INTERVAL_MS,
  AUTO_RANGE_PINE_INTERVAL_MS,
  detectAutoRangePine,
  detectAutoRangePine1h,
  type AutoRangeCandle,
} from "../src/lib/auto-range-pine.js";

function consolidationHistory(
  length = 820,
  intervalMs = AUTO_RANGE_PINE_INTERVAL_MS,
  markClosed = false,
): AutoRangeCandle[] {
  const firstTime = 1_700_000_000_000;
  return Array.from({ length }, (_, index) => {
    const amplitude = index < 680 ? 5 : 1;
    const close = 100 + (index % 2 === 0 ? amplitude : -amplitude);
    const open =
      index === 0 ? 100 : 100 + (index % 2 === 1 ? amplitude : -amplitude);
    return {
      time: firstTime + index * intervalMs,
      open,
      high: Math.max(open, close) + amplitude * 0.1,
      low: Math.min(open, close) - amplitude * 0.1,
      close,
      ...(markClosed ? { closed: true } : {}),
    };
  });
}

test("requires continuous, complete, ATR-seeded closed 4H history", () => {
  assert.equal(
    detectAutoRangePine(consolidationHistory(199)).status,
    "unknown",
  );

  const zeroRangeFirstBar = consolidationHistory();
  zeroRangeFirstBar[0] = {
    ...zeroRangeFirstBar[0]!,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  };
  assert.equal(detectAutoRangePine(zeroRangeFirstBar).status, "ready");

  const gap = consolidationHistory();
  gap[400]!.time += AUTO_RANGE_PINE_INTERVAL_MS;
  assert.equal(detectAutoRangePine(gap).status, "unknown");

  const incomplete = consolidationHistory();
  incomplete.at(-1)!.closed = false;
  assert.equal(detectAutoRangePine(incomplete).status, "unknown");
});

test("1H replay fails closed for gaps and candles not explicitly marked closed", () => {
  const candles = consolidationHistory(
    820,
    AUTO_RANGE_PINE_1H_INTERVAL_MS,
    true,
  );
  assert.equal(detectAutoRangePine1h(candles).status, "ready");

  const gap = candles.map((candle) => ({ ...candle }));
  gap[400]!.time += AUTO_RANGE_PINE_1H_INTERVAL_MS;
  assert.equal(detectAutoRangePine1h(gap).status, "unknown");
  assert.match(detectAutoRangePine1h(gap).reason, /gap or is not ascending/);

  const partial = candles.map((candle) => ({ ...candle }));
  partial.at(-1)!.closed = false;
  assert.equal(detectAutoRangePine1h(partial).status, "unknown");

  const unmarked = candles.map(({ closed: _closed, ...candle }) => candle);
  assert.equal(detectAutoRangePine1h(unmarked).status, "unknown");
});

test("1H replay produces a deterministic breakout at the 1H candle close", () => {
  const candles = consolidationHistory(
    820,
    AUTO_RANGE_PINE_1H_INTERVAL_MS,
    true,
  );
  const before = detectAutoRangePine1h(candles);
  assert.ok(before.activeConfirmedRange);
  const upper = before.activeConfirmedRange.upper;
  const lower = before.activeConfirmedRange.lower;
  const prior = candles.at(-1)!;
  const breakout: AutoRangeCandle = {
    time: prior.time + AUTO_RANGE_PINE_1H_INTERVAL_MS,
    open: upper,
    high: upper + 12,
    low: upper,
    close: upper + 12,
    closed: true,
  };
  const once = detectAutoRangePine1h([...candles, breakout]);
  const twice = detectAutoRangePine1h([...candles, breakout]);

  assert.deepEqual(once, twice);
  assert.equal(once.activeConfirmedRange, null);
  assert.deepEqual(once.latestUpsideBreakout, {
    upper,
    lower,
    openedAt: before.activeConfirmedRange.openedAt,
    anchorAt: before.activeConfirmedRange.anchorAt,
    breakoutCloseTime: breakout.time + AUTO_RANGE_PINE_1H_INTERVAL_MS,
  });
});

test("detects a confirmed default range and gives stable results on repeat", () => {
  const candles = consolidationHistory();
  const first = detectAutoRangePine(candles);
  const repeat = detectAutoRangePine(candles);

  assert.deepEqual(first, repeat);
  assert.equal(first.status, "ready");
  assert.ok(first.activeConfirmedRange);
  assert.ok(
    first.activeConfirmedRange.upper > first.activeConfirmedRange.lower,
  );
  assert.ok(
    first.activeConfirmedRange.anchorAt <= first.activeConfirmedRange.openedAt,
  );
  assert.equal(first.latestUpsideBreakout, null);
});

test("does not publish a breakout from a provisional range", () => {
  const candles = consolidationHistory();
  const active = detectAutoRangePine(candles).activeConfirmedRange;
  assert.ok(active);
  const openingIndex = candles.findIndex(
    (candle) => candle.time === active.openedAt,
  );
  assert.ok(openingIndex >= 0);
  const baselineAtOpening = detectAutoRangePine(
    candles.slice(0, openingIndex + 1),
  );
  assert.equal(
    baselineAtOpening.activeConfirmedRange?.openedAt,
    candles[openingIndex]!.time,
  );

  // Keep the qualifying compression window, but make its detection candle
  // itself close beyond the boundary. Pine deletes this unconfirmed box.
  const provisionalBreak = candles
    .slice(0, openingIndex + 1)
    .map((candle) => ({ ...candle }));
  const candle = provisionalBreak[openingIndex]!;
  candle.close = 104;
  candle.high = 104;
  candle.low = Math.min(candle.low, candle.open);
  const result = detectAutoRangePine(provisionalBreak);

  assert.equal(result.latestUpsideBreakout, null);
  assert.equal(result.activeConfirmedRange, null);
});

test("reports confirmed upside breaks with frozen bounds and close time; merges reentry", () => {
  const candles = consolidationHistory();
  const before = detectAutoRangePine(candles);
  assert.ok(before.activeConfirmedRange);
  const upper = before.activeConfirmedRange.upper;
  const lower = before.activeConfirmedRange.lower;
  const prior = candles.at(-1)!;
  const marginal: AutoRangeCandle = {
    time: prior.time + AUTO_RANGE_PINE_INTERVAL_MS,
    open: upper,
    high: upper + 0.01,
    low: lower,
    close: upper + 0.01,
  };
  const afterMarginal = detectAutoRangePine([...candles, marginal]);
  assert.equal(afterMarginal.latestUpsideBreakout, null);
  assert.deepEqual(
    afterMarginal.activeConfirmedRange,
    before.activeConfirmedRange,
  );

  const breakout: AutoRangeCandle = {
    time: marginal.time + AUTO_RANGE_PINE_INTERVAL_MS,
    open: upper,
    high: upper + 12,
    low: upper,
    close: upper + 12,
  };
  const afterBreak = detectAutoRangePine([...candles, marginal, breakout]);

  assert.equal(afterBreak.activeConfirmedRange, null);
  assert.deepEqual(afterBreak.latestUpsideBreakout, {
    upper,
    lower,
    openedAt: before.activeConfirmedRange.openedAt,
    anchorAt: before.activeConfirmedRange.anchorAt,
    breakoutCloseTime: breakout.time + AUTO_RANGE_PINE_INTERVAL_MS,
  });
  assert.deepEqual(
    afterBreak,
    detectAutoRangePine([...candles, marginal, breakout]),
  );

  const reentry: AutoRangeCandle = {
    time: breakout.time + AUTO_RANGE_PINE_INTERVAL_MS,
    open: upper,
    high: upper,
    low: lower,
    close: (upper + lower) / 2,
  };
  const merged = detectAutoRangePine([...candles, marginal, breakout, reentry]);
  assert.equal(merged.latestUpsideBreakout, null);
  assert.deepEqual(merged.activeConfirmedRange, before.activeConfirmedRange);
});

import { anchoredAutoRangeWindow } from "../src/lib/auto-range-pine.js";
test("anchored window start is stable across consecutive candles", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-09-01T00:00:00Z");
  const candles = Array.from({ length: 1000 }, (_, i) => ({
    time: t0 + i * H,
  }));
  const a = anchoredAutoRangeWindow(candles.slice(0, 900), H, 600);
  const b = anchoredAutoRangeWindow(candles.slice(0, 901), H, 600);
  assert.equal(a[0]!.time, b[0]!.time);
  assert.ok(a.length >= 600 && a.length <= 600 + 168);
});
