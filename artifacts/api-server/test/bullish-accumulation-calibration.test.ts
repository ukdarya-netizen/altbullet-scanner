import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BA_REJECT_TELEMETRY_WINDOW_MS,
  buildBullishAccumulationCalibrationReport,
  classifyBullishAccumulationOiPath,
  getBullishAccumulationEntrySource,
  getBullishAccumulationOiWatchMinPriceMove,
  getBullishAccumulationP24hTelemetrySource,
} from "../src/lib/bullish-accumulation-calibration.js";

describe("Bullish Accumulation rejected-candidate telemetry", () => {
  test("deduplicates repeated p24h-gate rejections inside a 12-hour window", () => {
    const start = new Date("2026-08-20T00:00:00.000Z");
    const sameWindow = new Date(start.getTime() + 11 * 60 * 60 * 1000);
    const nextWindow = new Date(
      start.getTime() + BA_REJECT_TELEMETRY_WINDOW_MS,
    );

    assert.equal(
      getBullishAccumulationP24hTelemetrySource("TOKEN-USDT", start),
      getBullishAccumulationP24hTelemetrySource("TOKEN-USDT", sameWindow),
    );
    assert.notEqual(
      getBullishAccumulationP24hTelemetrySource("TOKEN-USDT", start),
      getBullishAccumulationP24hTelemetrySource("TOKEN-USDT", nextWindow),
    );
  });
});

describe("Bullish Accumulation OI routes", () => {
  test("accepts fresh and extended 30m impulses as separate cohorts", () => {
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 3.5,
        oi1h: 0,
        oi4h: 0,
      }),
      { allowed: true, path: "fresh_oi30m", reason: null },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 5,
        oi1h: null,
        oi4h: null,
      }),
      { allowed: true, path: "fresh_oi30m", reason: null },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 10,
        oi1h: null,
        oi4h: null,
      }),
      { allowed: true, path: "extended_oi30m", reason: null },
    );
  });

  test("accepts slow higher-TF accumulation only while 30m stays cool", () => {
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 2.5,
        oi1h: 2,
        oi4h: null,
      }),
      { allowed: true, path: "slow_multitf", reason: null },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: null,
        oi1h: null,
        oi4h: 2.5,
      }),
      { allowed: true, path: "slow_multitf", reason: null },
    );
  });

  test("blocks OI1h above 6% only for the slow route", () => {
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 0.2,
        oi1h: 6,
        oi4h: null,
      }),
      { allowed: true, path: "slow_multitf", reason: null },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 0.2,
        oi1h: 6.01,
        oi4h: null,
      }),
      { allowed: false, path: null, reason: "slow_oi1h_too_hot" },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 3,
        oi1h: 6.01,
        oi4h: null,
      }),
      { allowed: true, path: "transition_oi30m", reason: null },
    );
  });

  test("restores the transition cohort and keeps only >10% OI closed", () => {
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 3,
        oi1h: 4,
        oi4h: 6,
      }),
      { allowed: true, path: "transition_oi30m", reason: null },
    );
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 10.01,
        oi1h: 4,
        oi4h: 6,
      }),
      { allowed: false, path: null, reason: "oi30m_too_hot" },
    );
  });

  test("removes the +2% price wait only from slow OI Watch entries", () => {
    assert.equal(getBullishAccumulationOiWatchMinPriceMove("slow_multitf"), 0);
    assert.equal(
      getBullishAccumulationOiWatchMinPriceMove("transition_oi30m"),
      2,
    );
    assert.equal(
      getBullishAccumulationOiWatchMinPriceMove("extended_oi30m"),
      2,
    );
    assert.equal(getBullishAccumulationOiWatchMinPriceMove("fresh_oi30m"), 2);
  });

  test("rejects weak OI that satisfies neither thesis", () => {
    assert.deepEqual(
      classifyBullishAccumulationOiPath({
        oi30m: 2.5,
        oi1h: 1.99,
        oi4h: 2.49,
      }),
      { allowed: false, path: null, reason: "oi_too_low" },
    );
  });
});

describe("Bullish Accumulation production calibration report", () => {
  test("excludes legacy signals and blocks threshold decisions below the cohort floor", () => {
    const report = buildBullishAccumulationCalibrationReport([
      {
        status: "profit",
        pnlPercent: 12,
        entrySource: "all+1h",
      },
      {
        status: "profit",
        pnlPercent: 8,
        entrySource: getBullishAccumulationEntrySource("scan", "fresh_oi30m"),
      },
      {
        status: "cancelled",
        pnlPercent: -2,
        entrySource: getBullishAccumulationEntrySource(
          "oi_watch/path_b",
          "slow_multitf",
        ),
      },
    ]);

    assert.equal(report.contract.legacySignalsExcluded, 1);
    assert.equal(report.sample.completedSignals, 2);
    assert.equal(report.sample.sufficient, false);
    assert.equal(report.paths.freshOi30m.outcomes.profit, 1);
    assert.equal(report.paths.slowMultitf.outcomes.cancelled, 1);
    assert.equal(report.paths.slowMultitf.pnl.netPercent, -2);
    assert.equal(report.recommendation.code, "insufficient_canonical_cohort");
  });

  test("requires at least five completed signals in every live route", () => {
    const row = (
      path: "fresh_oi30m" | "slow_multitf",
      status: "profit" | "stop_loss",
      pnlPercent: number,
    ) => ({
      status,
      pnlPercent,
      entrySource: getBullishAccumulationEntrySource("scan", path),
    });
    const report = buildBullishAccumulationCalibrationReport([
      ...Array.from({ length: 16 }, () => row("fresh_oi30m", "profit", 4)),
      ...Array.from({ length: 4 }, () => row("slow_multitf", "stop_loss", -10)),
    ]);

    assert.equal(report.sample.completedSignals, 20);
    assert.equal(report.sample.allPathsRepresentative, false);
    assert.equal(report.sample.sufficient, false);
  });
});
