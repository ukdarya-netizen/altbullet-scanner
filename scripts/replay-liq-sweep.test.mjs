import assert from "node:assert/strict";
import test from "node:test";
import { replaySweep } from "./replay-liq-sweep.mjs";

const STEP = 15 * 60_000;

function candles() {
  const bars = Array.from({ length: 210 }, (_, index) => [
    index * STEP,
    100,
    101,
    99,
    100,
  ]);
  bars[160][3] = 95; // Pivot low is knowable only after five later bars.
  bars[190][3] = 94; // Sweep and reclaim the confirmed pivot.
  bars[191] = [191 * STEP, 100, 104, 99, 103]; // Structure break, with body.
  return bars;
}

test("a future bullish confirmation is not counted at signal time", () => {
  const input = { id: 1, entry: 100, closed: 200 * STEP };
  const before = replaySweep({ ...input, ms: 191 * STEP }, "15m", candles());
  assert.equal(before.ok, true);
  assert.equal(before.bullPending, true);
  assert.equal(before.bullReclaimed, true);
  assert.equal(before.bullAge, null);
  assert.equal(before.firstBullAfterMs, STEP);

  const after = replaySweep({ ...input, ms: 192 * STEP }, "15m", candles());
  assert.equal(after.ok, true);
  assert.equal(after.bullPending, false);
  assert.equal(after.bullAge, 0);
});

test("a bearish sweep also needs a later closed structure break", () => {
  const bars = Array.from({ length: 210 }, (_, index) => [
    index * STEP,
    100,
    101,
    99,
    100,
  ]);
  bars[160][2] = 105;
  bars[190][2] = 106;
  bars[191] = [191 * STEP, 100, 101, 96, 97];
  const input = { id: 3, entry: 100, closed: 200 * STEP };
  const before = replaySweep({ ...input, ms: 191 * STEP }, "15m", bars);
  assert.equal(before.ok, true);
  assert.equal(before.bearPending, true);
  assert.equal(before.bearAge, null);
  assert.equal(before.firstBearAfterMs, STEP);
  const after = replaySweep({ ...input, ms: 192 * STEP }, "15m", bars);
  assert.equal(after.bearAge, 0);
});

test("a gap in candles immediately before the signal has no verdict", () => {
  const bars = candles().filter((_, index) => index !== 189);
  const result = replaySweep(
    { id: 2, entry: 100, ms: 191 * STEP, closed: 200 * STEP },
    "15m",
    bars,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "entry_history_gap");
});
