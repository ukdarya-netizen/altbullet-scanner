import assert from "node:assert/strict";
import test from "node:test";
import { compareFrozenRangeWithReplay } from "../src/lib/stealth-range-recheck.js";

test("SAND phantom range (0.0643-0.0822) vs real replay (0.0649-0.0673) is rejected", () => {
  const r = compareFrozenRangeWithReplay(
    { upper: 0.08221, lower: 0.064305 },
    { upper: 0.067345, lower: 0.064925 },
  );
  assert.equal(r.ok, false);
});

test("small venue differences (<=3%) are accepted", () => {
  const r = compareFrozenRangeWithReplay(
    { upper: 0.00921, lower: 0.00865 },
    { upper: 0.00895, lower: 0.00848 },
  );
  assert.equal(r.ok, true);
});

test("missing replay breakout is rejected", () => {
  assert.equal(
    compareFrozenRangeWithReplay({ upper: 2, lower: 1 }, null).ok,
    false,
  );
});
