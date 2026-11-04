import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildDrawdownRiskAnalysis } from "../src/lib/drawdown-analysis.js";

describe("drawdown risk analysis", () => {
  test("uses observed minima and keeps bu_stop out of ordinary stop rate", () => {
    const result = buildDrawdownRiskAnalysis([
      ...Array.from({ length: 5 }, () => ({
        sentimentKey: "balanced_grind",
        status: "stop_loss",
        minPctFromEntry: -8,
        stopLossPct: 10,
      })),
      ...Array.from({ length: 5 }, () => ({
        sentimentKey: "balanced_grind",
        status: "profit",
        minPctFromEntry: -2,
        stopLossPct: 10,
      })),
      ...Array.from({ length: 5 }, () => ({
        sentimentKey: "balanced_grind",
        status: "breakeven",
        minPctFromEntry: 0,
        stopLossPct: 10,
      })),
      ...Array.from({ length: 5 }, () => ({
        sentimentKey: "balanced_grind",
        status: "bu_stop",
        minPctFromEntry: -9,
        stopLossPct: 10,
      })),
    ]);

    assert.equal(result.sample.eligible, 20);
    assert.equal(result.summary.counts.buStop, 5);
    assert.equal(result.summary.ordinaryOutcomes, 15);
    assert.equal(result.summary.stopLossRate, (5 / 15) * 100);
    assert.equal(result.summary.buStopRate, 25);
    assert.equal(result.byPattern[0]?.riskZone.state, "observed");
    assert.equal(result.byPattern[0]?.riskZone.label, "75–100%");
    assert.equal(result.forward.sufficient, false);
    assert.equal(result.forward.minimumEligible, 100);
    assert.equal(result.forward.decision, "insufficient_forward_sample");
    assert.equal(
      result.byPattern[0]?.forward.decision,
      "insufficient_forward_sample",
    );
  });

  test("does not substitute final outcomes or incomplete telemetry", () => {
    const result = buildDrawdownRiskAnalysis([
      {
        sentimentKey: "bullish_accumulation",
        status: "stop_loss",
        minPctFromEntry: null,
        stopLossPct: 10,
      },
      {
        sentimentKey: "bullish_accumulation",
        status: "profit",
        minPctFromEntry: -3,
        stopLossPct: null,
      },
      {
        sentimentKey: "bullish_accumulation",
        status: "cancelled",
        minPctFromEntry: -10,
        stopLossPct: 10,
      },
    ]);

    assert.equal(result.sample.closedOutcomes, 2);
    assert.equal(result.sample.observedWithExtrema, 1);
    assert.equal(result.sample.withStopLossPct, 1);
    assert.equal(result.sample.eligible, 0);
    assert.equal(result.summary.stopLossRate, null);
    assert.equal(result.summary.riskZone.state, "insufficient_sample");
  });

  test("builds threshold outcomes and an 8% versus 10% forward replay", () => {
    const minAt = new Date("2026-08-24T10:00:00.000Z");
    const afterMin = new Date("2026-08-24T11:00:00.000Z");
    const beforeMin = new Date("2026-08-24T09:00:00.000Z");
    const row = (
      minPctFromEntry: number,
      finalPnlPct: number,
      peakAfterMin: number,
    ) => ({
      sentimentKey: "balanced_grind",
      status: finalPnlPct < 0 ? "stop_loss" : "profit",
      minPctFromEntry,
      stopLossPct: 10,
      minObservedAt: minAt,
      finalPnlPct,
      trajectory: [
        { snapshotAt: beforeMin, peakPct: 50 },
        { snapshotAt: afterMin, peakPct: peakAfterMin },
      ],
    });
    const result = buildDrawdownRiskAnalysis([
      row(-9, -12, -2),
      row(-9, 10, 10),
      row(-11, -15, -3),
      row(-11, 0, 10),
      ...Array.from({ length: 96 }, () => row(-2, 5, 5)),
    ]);

    assert.equal(result.forward.sufficient, true);
    assert.equal(result.forward.decision, "retain_10_review");

    const threshold8 = result.forward.thresholds.find(
      (threshold) => threshold.thresholdPct === 8,
    );
    assert.deepEqual(threshold8, {
      thresholdPct: 8,
      reachedDrawdown: 4,
      trajectoryObserved: 4,
      trajectoryMissing: 0,
      reachedPlus5: 2,
      reachedPlus10: 2,
      recoveredToBreakeven: 2,
      closedNegative: 2,
    });

    const threshold10 = result.forward.thresholds.find(
      (threshold) => threshold.thresholdPct === 10,
    );
    assert.equal(threshold10?.reachedDrawdown, 2);
    assert.equal(threshold10?.reachedPlus10, 1);
    assert.equal(threshold10?.recoveredToBreakeven, 1);
    assert.equal(threshold10?.closedNegative, 1);

    assert.deepEqual(result.forward.replay.stop8, {
      stopPct: 8,
      reachedDrawdown: 4,
      preventedLosses: 2,
      preventedLossPp: 11,
      lostRecoveries: 2,
      lostRecoveryPp: 26,
    });
    assert.deepEqual(result.forward.replay.stop10, {
      stopPct: 10,
      reachedDrawdown: 2,
      preventedLosses: 1,
      preventedLossPp: 5,
      lostRecoveries: 1,
      lostRecoveryPp: 10,
    });
    assert.deepEqual(result.forward.replay.comparison, {
      additionalPreventedLossesAt8: 1,
      additionalPreventedLossPpAt8: 6,
      additionalLostRecoveriesAt8: 1,
      additionalLostRecoveryPpAt8: 16,
      netPpAt8Vs10: -10,
    });
    assert.equal(result.byPattern[0]?.forward.minimumEligible, 20);
    assert.equal(result.byPattern[0]?.forward.sufficient, true);
  });

  test("does not count a target reached before the observed minimum", () => {
    const result = buildDrawdownRiskAnalysis([
      {
        sentimentKey: "bullish_accumulation",
        status: "stop_loss",
        minPctFromEntry: -8,
        stopLossPct: 10,
        minObservedAt: "2026-08-24T10:00:00.000Z",
        finalPnlPct: -10,
        trajectory: [
          {
            snapshotAt: "2026-08-24T09:00:00.000Z",
            peakPct: 10,
          },
          {
            snapshotAt: "2026-08-24T11:00:00.000Z",
            peakPct: -2,
          },
        ],
      },
    ]);

    const threshold8 = result.forward.thresholds.find(
      (threshold) => threshold.thresholdPct === 8,
    );
    assert.equal(threshold8?.trajectoryObserved, 1);
    assert.equal(threshold8?.recoveredToBreakeven, 0);
    assert.equal(threshold8?.reachedPlus5, 0);
    assert.equal(threshold8?.reachedPlus10, 0);
  });
});
