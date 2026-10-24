import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT,
  isIncludedInCurrentPatternStats,
  isLegacyImpulseBuyStopLoss,
} from "../src/lib/impulse-buy-stats-cohort.js";

test("starts the current Impulse Buy statistics cohort at filter activation", () => {
  assert.equal(
    IMPULSE_BUY_CURRENT_STATS_COHORT_STARTED_AT.toISOString(),
    "2026-09-11T14:50:31.000Z",
  );
  assert.equal(
    isLegacyImpulseBuyStopLoss({
      sentimentKey: "impulse_buy",
      status: "stop_loss",
      detectedAt: "2026-09-11T14:50:30.999Z",
    }),
    true,
  );
  assert.equal(
    isIncludedInCurrentPatternStats({
      sentimentKey: "impulse_buy",
      status: "stop_loss",
      detectedAt: "2026-09-11T14:50:31.000Z",
    }),
    true,
  );
});

test("keeps every other historical outcome in statistics", () => {
  assert.equal(
    isIncludedInCurrentPatternStats({
      sentimentKey: "impulse_buy",
      status: "profit",
      detectedAt: "2026-09-01T00:00:00.000Z",
    }),
    true,
  );
  assert.equal(
    isIncludedInCurrentPatternStats({
      sentimentKey: "balanced_grind",
      status: "stop_loss",
      detectedAt: "2026-09-01T00:00:00.000Z",
    }),
    true,
  );
});

test("treats missing legacy Impulse Buy stop-loss timestamps as old cohort", () => {
  assert.equal(
    isLegacyImpulseBuyStopLoss({
      sentimentKey: "impulse_buy",
      status: "stop_loss",
      detectedAt: null,
    }),
    true,
  );
});
