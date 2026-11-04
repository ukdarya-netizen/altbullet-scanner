import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRangeReturn } from "../src/lib/stealth-range-return-cancel.js";

const H = 3_600_000;
const bar = (i: number, close: number) => ({ time: i * H, close });
const now = 20 * H;

test("one closed candle below the level does not cancel", () => {
  assert.equal(
    evaluateRangeReturn([bar(1, 0.9), bar(2, 0.9)], H, 0, 1, now),
    null,
  );
});

test("cancels once closes stay below for 4 hours after the first one", () => {
  const bars = [1, 2, 3, 4, 5].map((i) => bar(i, 0.9));
  assert.deepEqual(evaluateRangeReturn(bars, H, 0, 1, now), {
    barTime: H,
    barClose: 0.9,
  });
});

test("a close back above the level resets the countdown", () => {
  const bars = [
    bar(1, 0.9),
    bar(2, 0.9),
    bar(3, 1.1),
    bar(4, 0.9),
    bar(5, 0.9),
  ];
  assert.equal(evaluateRangeReturn(bars, H, 0, 1, now), null);
});

test("1H hold of 2 hours cancels after three closed candles below", () => {
  const hold = 2 * H;
  const two = [1, 2].map((i) => bar(i, 0.9));
  const three = [1, 2, 3].map((i) => bar(i, 0.9));
  assert.equal(evaluateRangeReturn(two, H, 0, 1, now, hold), null);
  assert.deepEqual(evaluateRangeReturn(three, H, 0, 1, now, hold), {
    barTime: H,
    barClose: 0.9,
  });
});
