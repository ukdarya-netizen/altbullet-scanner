import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBalancedGrindP24hReviewReadyMessage,
  getBalancedGrindP24hRejectReason,
  getBalancedGrindP24hTelemetrySource,
  BALANCED_GRIND_P24H_MAX,
  BALANCED_GRIND_P24H_MIN,
  BALANCED_GRIND_P24H_REVIEW_MIN_COMPLETED,
  BALANCED_GRIND_P24H_RISK_MAX,
  BALANCED_GRIND_P24H_RISK_MIN,
} from "../src/lib/scanner-patterns.js";

test("Balanced Grind accepts the calibrated lower and upper p24h bounds", () => {
  assert.equal(getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_MIN), null);
  assert.equal(getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_MAX), null);
});

test("Balanced Grind rejects only p24h below -2% on the downside", () => {
  assert.equal(getBalancedGrindP24hRejectReason(-2.01), "p24h_too_low");
  assert.equal(getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_MIN), null);
});

test("Balanced Grind keeps the +5..+10% p24h risk band blocked", () => {
  assert.equal(
    getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_RISK_MIN),
    "p24h_risk_band",
  );
  assert.equal(
    getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_RISK_MAX),
    "p24h_risk_band",
  );
  assert.equal(getBalancedGrindP24hRejectReason(10.01), null);
});

test("Balanced Grind reports p24h above 20% separately from price_or_vol", () => {
  assert.equal(
    getBalancedGrindP24hRejectReason(BALANCED_GRIND_P24H_MAX + 0.01),
    "p24h_too_high",
  );
  assert.equal(getBalancedGrindP24hRejectReason(30), "p24h_too_high");
});

test("Balanced Grind deduplicates p24h shadow candidates inside 12-hour windows", () => {
  const symbol = "TEST-USDT";
  assert.equal(
    getBalancedGrindP24hTelemetrySource(
      symbol,
      new Date("2026-08-28T01:00:00.000Z"),
    ),
    getBalancedGrindP24hTelemetrySource(
      symbol,
      new Date("2026-08-28T11:59:59.999Z"),
    ),
  );
  assert.notEqual(
    getBalancedGrindP24hTelemetrySource(
      symbol,
      new Date("2026-08-28T11:59:59.999Z"),
    ),
    getBalancedGrindP24hTelemetrySource(
      symbol,
      new Date("2026-08-28T12:00:00.000Z"),
    ),
  );
});

test("Balanced Grind review alert requires the calibrated cohort size", () => {
  assert.equal(BALANCED_GRIND_P24H_REVIEW_MIN_COMPLETED, 20);
  const message = buildBalancedGrindP24hReviewReadyMessage(20);
  assert.match(message, /20/);
  assert.match(message, /20–30%/);
  assert.match(message, /&gt;30%/);
  assert.match(message, /6ч и 24ч/);
});
