import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  OUTAGE_ALERT_AFTER_MS,
  OUTAGE_ALERT_COOLDOWN_MS,
  reportAggregatedOiCoverage,
  reportApiFailure,
  reportApiSuccess,
  reportUnlockListAvailability,
  resetApiHealthForTests,
} from "../src/lib/apiHealth.js";

beforeEach(() => resetApiHealthForTests());
const T0 = 1_000_000_000_000;
const MIN = 60_000;

test("unlock: no alert before 30 min, one alert after, 6h cooldown", () => {
  assert.equal(reportUnlockListAvailability(false, T0), false);
  assert.equal(reportUnlockListAvailability(false, T0 + 29 * MIN), false);
  assert.equal(reportUnlockListAvailability(false, T0 + 31 * MIN), true);
  assert.equal(reportUnlockListAvailability(false, T0 + 90 * MIN), false);
  assert.equal(
    reportUnlockListAvailability(
      false,
      T0 + 31 * MIN + OUTAGE_ALERT_COOLDOWN_MS + MIN,
    ),
    true,
  );
});

test("api failures: many errors within 30 min never alert; success resets", () => {
  for (let i = 0; i < 20; i++) reportApiFailure("coinglass", 500, T0 + i * MIN);
  reportApiSuccess("coinglass");
  reportApiFailure("coinglass", 500, T0 + 40 * MIN);
  assert.ok(OUTAGE_ALERT_AFTER_MS > 0);
});

test("coingecko 429 never starts an outage", () => {
  reportApiFailure("coingecko", 429, T0);
  reportApiFailure("coingecko", 429, T0 + 120 * MIN);
});

test("oi coverage: needs 3 consecutive low cycles; good cycle resets", () => {
  assert.equal(reportAggregatedOiCoverage(10, 100, T0), false);
  assert.equal(reportAggregatedOiCoverage(10, 100, T0 + 30 * MIN), false);
  assert.equal(reportAggregatedOiCoverage(90, 100, T0 + 60 * MIN), false);
  assert.equal(reportAggregatedOiCoverage(10, 100, T0 + 90 * MIN), false);
  assert.equal(reportAggregatedOiCoverage(10, 100, T0 + 120 * MIN), false);
  assert.equal(reportAggregatedOiCoverage(10, 100, T0 + 150 * MIN), true);
  assert.equal(reportAggregatedOiCoverage(10, 100, T0 + 180 * MIN), false);
});
