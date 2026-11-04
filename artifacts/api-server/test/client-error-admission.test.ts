import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientErrorAdmission } from "../src/lib/client-error-admission.js";

test("deduplicates the same client error for five minutes", () => {
  let timestamp = 1_000;
  const admit = createClientErrorAdmission(() => timestamp);
  assert.equal(admit("same"), "accept");
  assert.equal(admit("same"), "duplicate");
  timestamp += 5 * 60_000;
  assert.equal(admit("same"), "accept");
});

test("limits accepted client errors in a one-minute window", () => {
  let timestamp = 1_000;
  const admit = createClientErrorAdmission(() => timestamp);
  for (let index = 0; index < 30; index += 1) {
    assert.equal(admit(`error-${index}`), "accept");
  }
  assert.equal(admit("overflow"), "rate_limited");
  timestamp += 60_000;
  assert.equal(admit("after-window"), "accept");
});
