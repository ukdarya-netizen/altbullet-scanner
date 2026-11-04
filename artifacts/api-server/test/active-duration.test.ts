import test from "node:test";
import assert from "node:assert/strict";
import { formatActiveDuration } from "../src/lib/watcher-formatters.js";

test("formatActiveDuration", () => {
  assert.equal(formatActiveDuration(43 * 60_000), "43м");
  assert.equal(formatActiveDuration(0), "0м");
  assert.equal(formatActiveDuration((2 * 60 + 15) * 60_000), "2ч 15м");
  assert.equal(formatActiveDuration((27 * 60 + 5) * 60_000), "1д 3ч 5м");
  assert.equal(formatActiveDuration(27 * 3_600_000), "1д 3ч");
});
