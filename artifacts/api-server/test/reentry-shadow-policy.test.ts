import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyReentryHorizon,
  reentryShadowAggregate,
} from "../src/lib/reentry-shadow-policy.js";
import {
  HEALTH_ADVICE_TELEGRAM_ENABLED,
  REENTRY_SHADOW_ONLY,
} from "../src/lib/watcher-config.js";

const h = 3_600_000;
test("strict horizon windows classify before, valid and missed", () => {
  const t = 1_000_000;
  assert.equal(classifyReentryHorizon(t, t + 3 * h, "4h"), "before");
  assert.equal(classifyReentryHorizon(t, t + 4 * h, "4h"), "valid");
  assert.equal(classifyReentryHorizon(t, t + 8 * h - 1, "4h"), "valid");
  assert.equal(classifyReentryHorizon(t, t + 8 * h, "4h"), "missed");
  assert.equal(classifyReentryHorizon(t, t + 8 * h, "8h"), "valid");
  assert.equal(classifyReentryHorizon(t, t + 24 * h, "8h"), "missed");
  assert.equal(classifyReentryHorizon(t, t + 24 * h, "24h"), "valid");
  assert.equal(classifyReentryHorizon(t, t + 48 * h, "24h"), "missed");
});

test("aggregate counts and averages exclude unavailable outcomes", () => {
  assert.deepEqual(
    reentryShadowAggregate([
      { outcome4hPct: 2, outcome8hPct: null, outcome24hPct: 6 },
      { outcome4hPct: null, outcome8hPct: 4, outcome24hPct: null },
    ]),
    {
      eventCount: 2,
      observed4h: 1,
      observed8h: 1,
      observed24h: 1,
      avg4h: 2,
      avg8h: 4,
      avg24h: 6,
    },
  );
});

test("approved lifecycle flags keep health disabled and re-entry shadow-only", () => {
  assert.equal(HEALTH_ADVICE_TELEGRAM_ENABLED, false);
  assert.equal(REENTRY_SHADOW_ONLY, true);
});
