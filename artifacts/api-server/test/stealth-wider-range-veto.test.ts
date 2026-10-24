import test from "node:test";
import assert from "node:assert/strict";
import { checkWiderActiveRange } from "../src/lib/stealth-wider-range-veto.js";

test("short history is fail-open", () => {
  const r = checkWiderActiveRange([], 1);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, "insufficient_history");
});
test("missing price is fail-open", () => {
  assert.equal(checkWiderActiveRange([], null).blocked, false);
});
