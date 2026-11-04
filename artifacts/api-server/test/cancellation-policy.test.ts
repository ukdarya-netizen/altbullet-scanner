import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  calculatePrice72hAfterExitPct,
  canStartStaleEvaluation,
  cancelReasonFor,
  getCancellationPolicy,
  getStaleEvaluationPlan,
  hasEntryCvdForSmartCancellation,
  hasCompleteCancellationConfirmation,
  isAutomaticCancellationEnabled,
  shouldRequireCompleteCancellationConfirmation,
} from "../src/lib/cancellation-policy.js";
import {
  evaluateImpulseBuy,
  isSpotLedPriceMomentum,
} from "../src/lib/scanner-patterns.js";

const completeConfirmation = {
  entryCvd1h: true,
  entryCvd4h: true,
  currentCvd30m: false,
  currentCvd1h: false,
  oi30m: -0.5,
  oi4h: -1,
  oiAvailable: true,
} as const;

describe("Dedicated cancellation policies", () => {
  test("disables all automatic cancellation for BA and normal stale for BG", () => {
    const ba = getCancellationPolicy("bullish_accumulation");
    const bg = getCancellationPolicy("balanced_grind");

    assert.equal(isAutomaticCancellationEnabled(ba), false);
    assert.equal(ba.smartCancelEnabled, false);
    assert.deepEqual(getStaleEvaluationPlan(ba, 500), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
    assert.equal(canStartStaleEvaluation(bg, 500), false);
    assert.equal(bg.smartCancelEnabled, true);
    assert.deepEqual(getStaleEvaluationPlan(bg, 96), {
      runNormalStale: false,
      evaluateMaxAge: true,
    });
  });

  test("disables normal stale cancellation for every policy", () => {
    for (const key of [
      "bullish_accumulation",
      "balanced_grind",
      "liquidation_cascade",
      "price_led_momentum",
      "stealth_breakout",
      "neon_support_bounce",
      "impulse_buy",
    ]) {
      assert.equal(
        canStartStaleEvaluation(getCancellationPolicy(key), 500),
        false,
      );
    }
  });

  test("pauses LC smart cancellation without disabling max-age", () => {
    const lc = getCancellationPolicy("liquidation_cascade");
    assert.equal(isAutomaticCancellationEnabled(lc), true);
    assert.equal(canStartStaleEvaluation(lc, 500), false);
    assert.equal(lc.smartCancelEnabled, false);
    assert.equal(lc.smartGraceHours, 24);
    assert.equal(lc.maxAgeHours, 120);
    assert.deepEqual(getStaleEvaluationPlan(lc, 24), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
    assert.deepEqual(getStaleEvaluationPlan(lc, 120), {
      runNormalStale: false,
      evaluateMaxAge: true,
    });
  });

  test("gives Impulse Buy a smart-only dedicated cancellation policy", () => {
    const impulse = getCancellationPolicy("impulse_buy");

    assert.equal(impulse.pattern, "impulse_buy");
    assert.equal(isAutomaticCancellationEnabled(impulse), true);
    assert.equal(impulse.smartCancelEnabled, true);
    assert.equal(impulse.smartGraceHours, 6);
    assert.equal(impulse.maxAgeHours, 72);
    assert.equal(impulse.requiresCompleteConfirmation, true);
    assert.deepEqual(getStaleEvaluationPlan(impulse, 24), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
    assert.deepEqual(getStaleEvaluationPlan(impulse, 72), {
      runNormalStale: false,
      evaluateMaxAge: true,
    });
    assert.equal(cancelReasonFor("smart", impulse), "impulse_smart_cancel_cvd");
    assert.equal(cancelReasonFor("max_age", impulse), "impulse_max_age_72h");
    assert.equal(
      shouldRequireCompleteCancellationConfirmation(impulse, 6),
      true,
    );
    assert.equal(
      shouldRequireCompleteCancellationConfirmation(impulse, 71.9),
      true,
    );
    assert.equal(
      shouldRequireCompleteCancellationConfirmation(impulse, 72),
      false,
    );
  });

  test("disables every automatic cancellation path for Stealth Breakout", () => {
    const sb = getCancellationPolicy("stealth_breakout");

    assert.equal(isAutomaticCancellationEnabled(sb), false);
    assert.equal(sb.smartCancelEnabled, false);
    assert.equal(canStartStaleEvaluation(sb, 500), false);
    assert.deepEqual(getStaleEvaluationPlan(sb, 500), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
  });

  test("keeps Neon Support Bounce on the normal position lifecycle", () => {
    const neon = getCancellationPolicy("neon_support_bounce");

    assert.equal(isAutomaticCancellationEnabled(neon), false);
    assert.equal(neon.smartCancelEnabled, false);
    assert.equal(canStartStaleEvaluation(neon, 500), false);
    assert.deepEqual(getStaleEvaluationPlan(neon, 500), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
  });

  test("disables derivatives-based automatic cancellation for Price Led Momentum", () => {
    const plm = getCancellationPolicy("price_led_momentum");

    assert.equal(isAutomaticCancellationEnabled(plm), false);
    assert.equal(plm.smartCancelEnabled, false);
    assert.equal(canStartStaleEvaluation(plm, 500), false);
    assert.deepEqual(getStaleEvaluationPlan(plm, 500), {
      runNormalStale: false,
      evaluateMaxAge: false,
    });
  });

  test("accepts PLM from price and spot flow alone", () => {
    assert.equal(
      isSpotLedPriceMomentum({
        price24hChange: 12,
        price3h: 2,
        snf1h: 1.5,
        snf4h: 4.2,
        spotVolMult: 1.1,
        cvd15m: true,
        cvd30m: false,
        cvd1h: true,
        cvd4h: false,
      }),
      true,
    );
    assert.equal(
      isSpotLedPriceMomentum({
        price24hChange: 5,
        price3h: 2,
        snf1h: 1.5,
        snf4h: 4.2,
        spotVolMult: 1.1,
        cvd15m: true,
        cvd30m: false,
        cvd1h: true,
        cvd4h: false,
      }),
      true,
    );
  });

  test("rejects PLM at and beyond the tightened 3h overextension boundary", () => {
    const input = {
      price24hChange: 12,
      price3h: 5,
      snf1h: 1.5,
      snf4h: 4.2,
      spotVolMult: 1.1,
      cvd15m: true,
      cvd30m: false,
      cvd1h: true,
      cvd4h: false,
    };

    assert.equal(isSpotLedPriceMomentum(input), false);
    assert.equal(
      isSpotLedPriceMomentum({
        ...input,
        price3h: 5.01,
      }),
      false,
    );
  });

  test("rejects PLM without positive spot flow or full CVD confirmation", () => {
    const baseInput = {
      price24hChange: 12,
      price3h: 2,
      snf1h: 1.5,
      snf4h: 4.2,
      spotVolMult: 1.1,
      cvd15m: true,
      cvd30m: false,
      cvd1h: true,
      cvd4h: false,
    };

    assert.equal(
      isSpotLedPriceMomentum({
        ...baseInput,
        snf1h: 0,
        snf4h: -0.1,
      }),
      false,
    );
    assert.equal(
      isSpotLedPriceMomentum({
        ...baseInput,
        cvd15m: null,
        cvd30m: false,
        cvd1h: true,
        cvd4h: null,
      }),
      false,
    );
  });

  test("accepts the Impulse Buy baseline at decision time", () => {
    const decision = evaluateImpulseBuy({
      candleOpen: 100,
      candleHigh: 102.2,
      candleLow: 99.8,
      candleClose: 102,
      candleVolumeUsd: 180_000,
      baselineVolumeUsd: 100_000,
      price24h: 0,
      price3h: 0,
      oi30m: 0.5,
      futVolumeMultiplier: 1.4,
      spotVolumeMultiplier: 2.5,
    });

    assert.equal(decision.passes, true);
    assert.equal(decision.score, 3);
    assert.deepEqual(decision.rejectReasons, []);
  });

  test("rejects late, extreme, or unconfirmed Impulse Buy candidates", () => {
    const decision = evaluateImpulseBuy({
      candleOpen: 100,
      candleHigh: 101,
      candleLow: 99,
      candleClose: 100.5,
      candleVolumeUsd: 120_000,
      baselineVolumeUsd: 100_000,
    });

    assert.equal(decision.passes, false);
    assert.ok(!decision.rejectReasons.includes("candle_body_lt_2pct"));
    assert.ok(decision.rejectReasons.includes("volume_lt_1_5x"));
  });

  test("requires known spot participation and fully bullish complete CVD for Impulse Buy", () => {
    const baseline = {
      candleOpen: 100,
      candleHigh: 102.2,
      candleLow: 99.8,
      candleClose: 102,
      candleVolumeUsd: 180_000,
      baselineVolumeUsd: 100_000,
      price24h: 0,
      price3h: 0,
      oi30m: 0.5,
      futVolumeMultiplier: 1.4,
      spotVolumeMultiplier: 2.5,
    };

    const weakSpot = evaluateImpulseBuy({
      ...baseline,
      spotVolumeMultiplier: 0.99,
    });
    assert.ok(weakSpot.rejectReasons.includes("spot_volume_below_2x"));

    const mixedCompleteCvd = evaluateImpulseBuy({
      ...baseline,
      cvd15m: true,
      cvd30m: true,
      cvd1h: true,
      cvd4h: false,
    });
    assert.ok(
      !mixedCompleteCvd.rejectReasons.includes("cvd_complete_not_all_bullish"),
    );

    assert.equal(
      evaluateImpulseBuy({
        ...baseline,
        spotVolumeMultiplier: null,
        cvd15m: true,
        cvd30m: true,
        cvd1h: null,
        cvd4h: false,
      }).passes,
      false,
    );
  });

  test("fails closed when a dedicated signal lacks full confirmation", () => {
    const policy = getCancellationPolicy("balanced_grind");
    assert.equal(
      hasCompleteCancellationConfirmation(policy, completeConfirmation),
      true,
    );
    assert.equal(
      hasCompleteCancellationConfirmation(policy, {
        ...completeConfirmation,
        entryCvd4h: null,
      }),
      false,
    );
    assert.equal(
      hasCompleteCancellationConfirmation(policy, {
        ...completeConfirmation,
        oiAvailable: false,
      }),
      false,
    );
  });

  test("fails closed for Impulse Buy when cancellation confirmation is incomplete", () => {
    const impulse = getCancellationPolicy("impulse_buy");
    assert.equal(
      hasCompleteCancellationConfirmation(impulse, completeConfirmation),
      true,
    );
    assert.equal(hasEntryCvdForSmartCancellation(impulse, true, null), false);
    assert.equal(
      hasCompleteCancellationConfirmation(impulse, {
        ...completeConfirmation,
        oi30m: null,
      }),
      false,
    );
    assert.equal(
      hasCompleteCancellationConfirmation(impulse, {
        ...completeConfirmation,
        currentCvd1h: null,
      }),
      false,
    );
    assert.equal(
      hasCompleteCancellationConfirmation(impulse, {
        ...completeConfirmation,
        oi4h: null,
      }),
      false,
    );
    assert.equal(
      hasCompleteCancellationConfirmation(impulse, {
        ...completeConfirmation,
        oiAvailable: false,
      }),
      false,
    );
  });

  test("keeps generic partial entry CVD compatible with the old smart-cancel rule", () => {
    const generic = getCancellationPolicy("some_other_pattern");
    const dedicated = getCancellationPolicy("balanced_grind");

    assert.equal(hasEntryCvdForSmartCancellation(generic, true, null), true);
    assert.equal(hasEntryCvdForSmartCancellation(generic, null, null), false);
    assert.equal(hasEntryCvdForSmartCancellation(dedicated, true, null), false);
  });

  test("keeps stale, smart, and max-age causes distinct", () => {
    const bg = getCancellationPolicy("balanced_grind");
    assert.equal(cancelReasonFor("stale", bg), "stale_oi_vol");
    assert.equal(cancelReasonFor("smart", bg), "smart_cancel_cvd");
    assert.equal(cancelReasonFor("max_age", bg), "max_age_96h");
  });

  test("calculates direction-aware 72h exit movement", () => {
    assert.equal(calculatePrice72hAfterExitPct(100, 112, false), 12);
    assert.equal(calculatePrice72hAfterExitPct(100, 88, true), 12);
    assert.equal(calculatePrice72hAfterExitPct(0, 88, true), null);
  });
});
