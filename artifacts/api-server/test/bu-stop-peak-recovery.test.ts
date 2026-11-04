import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hasEarnedBuStopProtection,
  resolveLongSplitFillAdjustment,
  resolveBuStopProtection,
} from "../src/lib/watcher-config.js";

describe("BE protection recovery from durable peak", () => {
  test("recovers standard +5% protection when milestone write was missed", () => {
    assert.equal(
      hasEarnedBuStopProtection({
        sentimentKey: "balanced_grind",
        lastMilestone: null,
        persistedPeakPnlPercent: 6.1,
      }),
      true,
    );
    assert.equal(
      hasEarnedBuStopProtection({
        sentimentKey: "price_led_momentum",
        lastMilestone: null,
        persistedPeakPnlPercent: 5.44,
      }),
      true,
    );
  });

  test("does not arm standard protection below +5%", () => {
    assert.equal(
      hasEarnedBuStopProtection({
        sentimentKey: "balanced_grind",
        lastMilestone: null,
        persistedPeakPnlPercent: 4.99,
      }),
      false,
    );
  });

  test("keeps bullish accumulation threshold at +10%", () => {
    assert.equal(
      hasEarnedBuStopProtection({
        sentimentKey: "bullish_accumulation",
        lastMilestone: null,
        persistedPeakPnlPercent: 6.1,
      }),
      false,
    );
    assert.equal(
      hasEarnedBuStopProtection({
        sentimentKey: "bullish_accumulation",
        lastMilestone: 10,
        persistedPeakPnlPercent: null,
      }),
      true,
    );
  });

  test("recovers Impulse Buy BE from a durable +5% peak", () => {
    assert.deepEqual(
      resolveBuStopProtection({
        sentimentKey: "impulse_buy",
        lastMilestone: null,
        persistedPeakPnlPercent: 7.27,
      }),
      {
        earned: true,
        milestone: 5,
        protectedProfitPct: 0,
      },
    );
  });

  test("promotes Impulse Buy to PROFIT STOP +5% from a durable +10% peak", () => {
    assert.deepEqual(
      resolveBuStopProtection({
        sentimentKey: "impulse_buy",
        lastMilestone: 5,
        persistedPeakPnlPercent: 10.01,
      }),
      {
        earned: true,
        milestone: 10,
        protectedProfitPct: 5,
      },
    );
  });

  test("Stealth, Neon Support and LC never promote to a profit stop", () => {
    for (const sentimentKey of [
      "stealth_breakout",
      "neon_support_bounce",
      "liquidation_cascade",
    ]) {
      assert.equal(
        resolveBuStopProtection({
          sentimentKey,
          lastMilestone: 10,
          persistedPeakPnlPercent: null,
        }).protectedProfitPct,
        0,
      );
    }
  });

  test("promotes every active pattern to PROFIT STOP +5% after +10%", () => {
    for (const sentimentKey of [
      "bullish_accumulation",
      "balanced_grind",
      "price_led_momentum",
      "impulse_buy",
    ]) {
      assert.deepEqual(
        resolveBuStopProtection({
          sentimentKey,
          lastMilestone: 10,
          persistedPeakPnlPercent: null,
        }),
        {
          earned: true,
          milestone: 10,
          protectedProfitPct: 5,
        },
      );
    }
  });

  test("does not revalue a pre-fill peak as earned BE after split averaging", () => {
    const originalEntryPrice = 0.005;
    const preFillPeakPrice = 0.005131;
    const splitFill = resolveLongSplitFillAdjustment({
      entryPrice: originalEntryPrice,
      splitLimitPrice: 0.00475,
      stopLossPct: 10,
    });

    const incorrectlyRevaluedPeakPct =
      ((preFillPeakPrice - splitFill.entryPrice) / splitFill.entryPrice) * 100;
    const rebasedPeakPct =
      ((splitFill.peakPrice - splitFill.entryPrice) / splitFill.entryPrice) *
      100;

    assert.ok(incorrectlyRevaluedPeakPct >= 5);
    assert.ok(rebasedPeakPct < 5);
    assert.equal(splitFill.entryPrice, 0.004875);
    assert.equal(splitFill.stopLossPrice, 0.0043875);
    assert.equal(
      resolveBuStopProtection({
        sentimentKey: "balanced_grind",
        lastMilestone: null,
        persistedPeakPnlPercent: rebasedPeakPct,
      }).earned,
      false,
    );
  });
});
