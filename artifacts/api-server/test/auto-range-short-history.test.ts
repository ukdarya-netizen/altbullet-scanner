import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_RANGE_PINE_1H_INTERVAL_MS,
  detectAutoRangePine1h,
  type AutoRangeCandle,
} from "../src/lib/auto-range-pine.js";

function history(length: number): AutoRangeCandle[] {
  const first = 1_700_000_000_000;
  return Array.from({ length }, (_, index) => {
    const amplitude = index < length - 70 ? 5 : 1;
    const close = 100 + (index % 2 === 0 ? amplitude : -amplitude);
    const open =
      index === 0 ? 100 : 100 + (index % 2 === 1 ? amplitude : -amplitude);
    return {
      time: first + index * AUTO_RANGE_PINE_1H_INTERVAL_MS,
      open,
      high: Math.max(open, close) + amplitude * 0.1,
      low: Math.min(open, close) - amplitude * 0.1,
      close,
      closed: true,
    };
  });
}

test("1H replay confirms a range on a short new-listing history", () => {
  const result = detectAutoRangePine1h(history(150));
  assert.equal(result.status, "ready");
  assert.ok(result.activeConfirmedRange, "range confirmed on 150 bars");
});

test("1H replay below 100 bars stays unknown", () => {
  assert.equal(detectAutoRangePine1h(history(99)).status, "unknown");
});
