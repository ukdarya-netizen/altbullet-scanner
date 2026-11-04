import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  nextBitcoinMilestone,
  nextMilestone,
} from "../src/lib/watcher-formatters.js";

describe("Moonshot milestone configuration", () => {
  test("uses +175% and +185% between the surrounding milestones", () => {
    assert.equal(nextMilestone(170, 174.99), null);
    assert.equal(nextMilestone(170, 175), 175);
    assert.equal(nextMilestone(170, 179.99), 175);
    assert.equal(nextMilestone(175, 184.99), 180);
    assert.equal(nextMilestone(180, 185), 185);
    assert.equal(nextMilestone(185, 190), 190);
    assert.equal(nextMilestone(190, 195), 195);
  });
});

test("BTC milestones advance in 1% steps", () => {
  assert.equal(nextBitcoinMilestone(null, 0.99), null);
  assert.equal(nextBitcoinMilestone(null, 1), 1);
  assert.equal(nextBitcoinMilestone(1, 1.99), null);
  assert.equal(nextBitcoinMilestone(1, 2), 2);
  assert.equal(nextBitcoinMilestone(2, 4.8), 3);
  assert.equal(nextBitcoinMilestone(8, 12.4, 9), 9);
});
