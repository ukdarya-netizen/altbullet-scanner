import assert from "node:assert/strict";
import test from "node:test";
import { observeAbneonRange } from "../src/lib/abneon-range-observation.js";

const HOUR = 60 * 60_000;
const candles = Array.from({ length: 800 }, (_, index) => {
  const size = index < 730 ? 5 : 1;
  const close = 100 + (index % 2 === 0 ? size : -size);
  return {
    time: 1_700_000_000_000 + index * HOUR,
    open: 100,
    high: close + size * 0.2,
    low: close - size * 0.2,
    close,
  };
});

test("range observation requires closed, continuous history for each timeframe", () => {
  assert.equal(observeAbneonRange(candles.slice(-500), HOUR).state, "unknown");
  const missing = candles.map((c) => ({ ...c }));
  missing[300]!.time += HOUR;
  assert.equal(observeAbneonRange(missing, HOUR).state, "unknown");
});

test("range boundaries freeze before a later breakout and retain a failed break", () => {
  const range = observeAbneonRange(candles, HOUR);
  assert.equal(range.state, "active");
  assert.ok(range.upper != null && range.lower != null);
  const breakout = {
    ...candles.at(-1)!,
    time: candles.at(-1)!.time + HOUR,
    high: 113,
    low: 100,
    close: 112,
  };
  const after = observeAbneonRange([...candles, breakout], HOUR);
  assert.equal(after.state, "break_up");
  assert.equal(after.upper, range.upper);
  const returnInside = {
    ...breakout,
    time: breakout.time + HOUR,
    high: 101,
    low: 99,
    close: 100,
  };
  assert.equal(
    observeAbneonRange([...candles, breakout, returnInside], HOUR).state,
    "reentered",
  );
  assert.equal(observeAbneonRange(candles, HOUR).state, "active");
});
