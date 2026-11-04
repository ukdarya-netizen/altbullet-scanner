import assert from "node:assert/strict";
import test from "node:test";
import { formatPositionAge } from "../src/lib/position-age.ts";

const now = Date.parse("2026-09-27T12:00:00Z");
const age = (minutes) =>
  formatPositionAge(new Date(now - minutes * 60_000), now);

test("position age uses 24 hours per day instead of decimal days", () => {
  assert.equal(age(59), "59 мин");
  assert.equal(age(60), "1 ч");
  assert.equal(age(23 * 60 + 59), "23 ч");
  assert.equal(age(24 * 60), "1 д 0 ч");
  assert.equal(age(24 * 60 + 10 * 60), "1 д 10 ч");
  assert.equal(age(24 * 60 + 23 * 60 + 59), "1 д 23 ч");
  assert.equal(age(48 * 60), "2 д 0 ч");
  assert.equal(age(60 * 60), "2 д 12 ч");
});
