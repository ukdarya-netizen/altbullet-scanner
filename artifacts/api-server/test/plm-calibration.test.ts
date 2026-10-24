import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPlmCalibrationReport,
  type PlmCalibrationRow,
} from "../src/lib/plm-calibration.js";
import {
  classifyAlphaGrade,
  isSpotLedPriceMomentum,
  PLM_MAX_PRICE_24H,
  resolveEntrySpotVolMult,
} from "../src/lib/scanner-patterns.js";
import {
  PLM_ENTRY_PRICE_3H_PROVENANCE,
  PLM_FUT_TAKER_SHADOW,
  PLM_OI30M_FIRE_FETCH_OPTIONS,
  PLM_OI30M_SHADOW,
  capturePlmEntryPrice3hSnapshot,
  capturePlmFutTakerShadow,
  capturePlmFutTakerShadowWithFallback,
  capturePlmOi30mShadow,
  capturePlmOi30mShadowAtFire,
  recoverPlmFutTakerShadow,
  recoverPlmEntryPrice3hSnapshot,
  recoverPlmOi30mShadow,
} from "../src/lib/plm-decision-snapshot.js";

describe("PLM immutable p3h snapshot", () => {
  test("direct fire captures the decision-time p3h with provenance", () => {
    assert.deepEqual(
      capturePlmEntryPrice3hSnapshot("price_led_momentum", 2.75),
      {
        entryPrice3h: 2.75,
        entryPrice3hProvenance: PLM_ENTRY_PRICE_3H_PROVENANCE.scannerDecision,
      },
    );

    assert.deepEqual(
      capturePlmEntryPrice3hSnapshot("price_led_momentum", Number.NaN),
      {
        entryPrice3h: null,
        entryPrice3hProvenance:
          PLM_ENTRY_PRICE_3H_PROVENANCE.missingAtSignalFire,
      },
    );
  });

  test("recovery copies the primary snapshot and never recomputes legacy NULL", () => {
    const primary = capturePlmEntryPrice3hSnapshot("price_led_momentum", 3.125);
    assert.deepEqual(
      recoverPlmEntryPrice3hSnapshot({
        sentimentKey: "price_led_momentum",
        ...primary,
      }),
      primary,
    );

    assert.deepEqual(
      recoverPlmEntryPrice3hSnapshot({
        sentimentKey: "price_led_momentum",
        entryPrice3h: null,
        entryPrice3hProvenance: null,
      }),
      {
        entryPrice3h: null,
        entryPrice3hProvenance:
          PLM_ENTRY_PRICE_3H_PROVENANCE.legacyPrimaryMissing,
      },
    );
  });
});

describe("PLM live p24h boundary", () => {
  const base = {
    price3h: 2,
    snf1h: 1,
    snf4h: null,
    spotVolMult: 1.1,
    cvd15m: true,
    cvd30m: true,
    cvd1h: false,
    cvd4h: false,
  };

  test("admits exactly 15% and rejects the first value above the cap", () => {
    assert.equal(PLM_MAX_PRICE_24H, 15);
    assert.equal(isSpotLedPriceMomentum({ ...base, price24hChange: 15 }), true);
    assert.equal(
      isSpotLedPriceMomentum({ ...base, price24hChange: 15.001 }),
      false,
    );
  });

  test("PLM persistence prefers the frozen decision value over later telemetry", () => {
    assert.equal(
      resolveEntrySpotVolMult("price_led_momentum", 1.25, 2.4),
      1.25,
    );
    assert.equal(
      resolveEntrySpotVolMult("price_led_momentum", null, 2.4),
      null,
    );
    assert.equal(resolveEntrySpotVolMult("balanced_grind", null, 2.4), 2.4);
  });

  test("requires inclusive decision-time spot volume and caps p3h at 4%", () => {
    const eligibleBase = { ...base, price24hChange: 12 };
    assert.equal(
      isSpotLedPriceMomentum({
        ...eligibleBase,
        spotVolMult: 1.1,
        price3h: 4,
      }),
      true,
    );
    assert.equal(
      isSpotLedPriceMomentum({ ...eligibleBase, spotVolMult: 1.099 }),
      false,
    );
    assert.equal(
      isSpotLedPriceMomentum({ ...eligibleBase, spotVolMult: null }),
      false,
    );
    assert.equal(
      isSpotLedPriceMomentum({ ...eligibleBase, spotVolMult: Number.NaN }),
      false,
    );
    assert.equal(
      isSpotLedPriceMomentum({
        ...eligibleBase,
        spotVolMult: 1.1,
        price3h: 4.001,
      }),
      false,
    );
  });
});

describe("PLM immutable futures taker shadow", () => {
  test("classifies finite values around 20% and preserves zero", () => {
    assert.equal(
      capturePlmFutTakerShadow("price_led_momentum", 19.999),
      PLM_FUT_TAKER_SHADOW.below20,
    );
    assert.equal(
      capturePlmFutTakerShadow("price_led_momentum", 20),
      PLM_FUT_TAKER_SHADOW.atOrAbove20,
    );
    assert.equal(
      capturePlmFutTakerShadow("price_led_momentum", 0),
      PLM_FUT_TAKER_SHADOW.below20,
    );
  });

  test("stores unavailable explicitly and never invents a legacy class", () => {
    assert.equal(
      capturePlmFutTakerShadow("price_led_momentum", null),
      PLM_FUT_TAKER_SHADOW.unavailable,
    );
    assert.equal(capturePlmFutTakerShadow("balanced_grind", 25), null);
    assert.equal(
      recoverPlmFutTakerShadow({
        sentimentKey: "price_led_momentum",
        plmFutTakerShadow: null,
      }),
      PLM_FUT_TAKER_SHADOW.unavailable,
    );
  });

  test("uses a bounded caller-provided fallback when the batch misses", async () => {
    const snapshot = await capturePlmFutTakerShadowWithFallback({
      sentimentKey: "price_led_momentum",
      batchValue: null,
      loadFallback: async () => 27.5,
    });

    assert.deepEqual(snapshot, {
      shadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
      value: 27.5,
      source: "per_symbol_fallback",
    });
  });

  test("keeps fallback failures observational and skips them for non-PLM", async () => {
    const unavailable = await capturePlmFutTakerShadowWithFallback({
      sentimentKey: "price_led_momentum",
      batchValue: null,
      loadFallback: async () => {
        throw new Error("timeout");
      },
    });
    assert.deepEqual(unavailable, {
      shadow: PLM_FUT_TAKER_SHADOW.unavailable,
      value: null,
      source: "unavailable",
    });

    let called = false;
    const nonPlm = await capturePlmFutTakerShadowWithFallback({
      sentimentKey: "balanced_grind",
      batchValue: null,
      loadFallback: async () => {
        called = true;
        return 30;
      },
    });
    assert.equal(called, false);
    assert.deepEqual(nonPlm, {
      shadow: null,
      value: null,
      source: "not_plm",
    });
  });
});

describe("PLM immutable OI30m shadow", () => {
  test("classifies the 2% boundary and preserves unavailable explicitly", () => {
    assert.equal(
      capturePlmOi30mShadow("price_led_momentum", 1.999),
      PLM_OI30M_SHADOW.below2,
    );
    assert.equal(
      capturePlmOi30mShadow("price_led_momentum", 2),
      PLM_OI30M_SHADOW.atOrAbove2,
    );
    assert.equal(
      capturePlmOi30mShadow("price_led_momentum", null),
      PLM_OI30M_SHADOW.unavailable,
    );
    assert.equal(capturePlmOi30mShadow("balanced_grind", 3), null);
  });

  test("recovery copies a valid primary class and never reconstructs legacy NULL", () => {
    assert.equal(
      recoverPlmOi30mShadow({
        sentimentKey: "price_led_momentum",
        plmOi30mShadow: PLM_OI30M_SHADOW.atOrAbove2,
      }),
      PLM_OI30M_SHADOW.atOrAbove2,
    );
    assert.equal(
      recoverPlmOi30mShadow({
        sentimentKey: "price_led_momentum",
        plmOi30mShadow: null,
      }),
      PLM_OI30M_SHADOW.unavailable,
    );
  });

  test("OI Watch fire-time values override queued candidate-time values", () => {
    const queuedCandidateClass = capturePlmOi30mShadow(
      "price_led_momentum",
      1.5,
    );
    const pathAFireClass = capturePlmOi30mShadow("price_led_momentum", 2.75);
    const pathBFireClass = capturePlmOi30mShadow("price_led_momentum", 3.25);
    const unavailableAtFire = capturePlmOi30mShadow("price_led_momentum", null);

    assert.equal(queuedCandidateClass, PLM_OI30M_SHADOW.below2);
    assert.equal(pathAFireClass, PLM_OI30M_SHADOW.atOrAbove2);
    assert.equal(pathBFireClass, PLM_OI30M_SHADOW.atOrAbove2);
    assert.equal(unavailableAtFire, PLM_OI30M_SHADOW.unavailable);
    assert.notEqual(pathAFireClass, queuedCandidateClass);
    assert.notEqual(pathBFireClass, queuedCandidateClass);
  });

  test("direct confirmed fire bypasses stale scanner OI and fails to unavailable", async () => {
    const stalePhaseOneValue = 1.5;
    const refreshed = await capturePlmOi30mShadowAtFire({
      sentimentKey: "price_led_momentum",
      loadFresh: async () => 2.75,
    });
    const failedRefresh = await capturePlmOi30mShadowAtFire({
      sentimentKey: "price_led_momentum",
      loadFresh: async () => {
        throw new Error("timeout");
      },
    });

    assert.equal(
      capturePlmOi30mShadow("price_led_momentum", stalePhaseOneValue),
      PLM_OI30M_SHADOW.below2,
    );
    assert.deepEqual(refreshed, {
      shadow: PLM_OI30M_SHADOW.atOrAbove2,
      value: 2.75,
    });
    assert.deepEqual(failedRefresh, {
      shadow: PLM_OI30M_SHADOW.unavailable,
      value: null,
    });
  });

  test("all fire paths share an immutable cache-bypass fetch policy", () => {
    assert.deepEqual(PLM_OI30M_FIRE_FETCH_OPTIONS, { bypassCache: true });
    assert.equal(Object.isFrozen(PLM_OI30M_FIRE_FETCH_OPTIONS), true);
  });
});

describe("PLM calibration report", () => {
  test("derives baseline and retained load with cutoff, open rows, ties, and invalid dates", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 10,
      entryPrice3h: 2,
      entryOi30m: null,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD",
      entryGradeReason: "alpha",
      pnlPercent: 1,
      detectedAt: new Date("2026-09-01T00:00:00Z"),
      closedAt: new Date("2026-09-01T01:00:00Z"),
    };
    const retained = Array.from({ length: 4 }, () => ({
      ...base,
      status: "profit",
      entrySpotVolMult: 1.2,
    }));
    const retainedOpen = {
      ...base,
      status: "active",
      entrySpotVolMult: 1.2,
      closedAt: null,
    };
    const excluded = Array.from({ length: 8 }, () => ({
      ...base,
      status: "stop_loss",
      entrySpotVolMult: 1,
      pnlPercent: -1,
    }));
    const tiedCutoff = {
      ...base,
      status: "expired",
      entrySpotVolMult: 1,
      detectedAt: new Date("2026-09-01T02:00:00Z"),
      closedAt: new Date("2026-09-01T02:00:00Z"),
    };
    const malformed = {
      ...base,
      status: "profit",
      entrySpotVolMult: 1.2,
      detectedAt: "not-a-date",
    };
    const report = buildPlmCalibrationReport([
      ...retained,
      retainedOpen,
      ...excluded,
      tiedCutoff,
      malformed,
    ]);
    const evaluation = report.liveEvaluation;

    assert.equal(evaluation.analysisCutoff, "2026-09-01T02:00:00.000Z");
    assert.equal(evaluation.comparableBaseline.measuredSignals, 14);
    assert.equal(evaluation.comparableBaseline.openAtCutoff, 1);
    assert.equal(evaluation.comparableBaseline.maxConcurrent, 13);
    assert.equal(evaluation.retainedLoad.measuredSignals, 5);
    assert.equal(evaluation.retainedLoad.openAtCutoff, 1);
    assert.equal(evaluation.retainedLoad.maxConcurrent, 5);
    assert.match(evaluation.methodology, /half-open/);
  });

  test("reports the active combined immutable live policy without hardcoded outcomes", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 10,
      entryPrice3h: 2,
      entrySpotVolMult: 1.2,
      entryOi30m: null,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h",
      entryGradeReason: "alpha",
      detectedAt: new Date("2026-09-01T00:00:00Z"),
      closedAt: new Date("2026-09-01T02:00:00Z"),
    };
    const report = buildPlmCalibrationReport([
      { ...base, status: "profit", pnlPercent: 8 },
      {
        ...base,
        status: "stop_loss",
        pnlPercent: -8,
        entrySpotVolMult: 1.0,
        detectedAt: new Date("2026-09-01T03:00:00Z"),
        closedAt: new Date("2026-09-01T04:00:00Z"),
      },
    ]);

    assert.deepEqual(report.livePolicy, {
      active: true,
      thresholds: {
        p24hMin: 5,
        p24hMax: 15,
        p3hMin: 1.5,
        p3hMax: 4,
        spotVolMin: 1.1,
        missingSpotVol: "reject",
      },
    });
    assert.equal(report.liveEvaluation.evaluatedTotal, 2);
    assert.equal(report.liveEvaluation.retained.total, 1);
    assert.equal(report.liveEvaluation.retained.outcomes.profit, 1);
    assert.equal(report.liveEvaluation.excluded.outcomes.stop_loss, 1);
    assert.equal(report.shadow.futTakerShadow.liveGateChanged, false);
  });

  test("never promotes negative OI30m to super_alpha", () => {
    assert.deepEqual(classifyAlphaGrade(7, 1, -15), {
      grade: "alpha",
      reason: "alpha",
    });
    assert.deepEqual(classifyAlphaGrade(7, 1, 15), {
      grade: "super_alpha",
      reason: "oi30m_positive_15",
    });
  });

  test("negative OI30m does not block an independent score promotion", () => {
    assert.deepEqual(classifyAlphaGrade(8, 2, -2), {
      grade: "super_alpha",
      reason: "score_8_plus_oi_2tf",
    });
    assert.deepEqual(classifyAlphaGrade(8, 2, 0), {
      grade: "super_alpha",
      reason: "score_8_plus_oi_2tf",
    });
  });

  test("reports the real stop/profit cost of the 18% shadow cap", () => {
    const report = buildPlmCalibrationReport([
      {
        signalType: "super_alpha",
        alphaScore: 9,
        status: "stop_loss",
        price24hAtFire: 22,
        entryPrice3h: 3.2,
        entryOi30m: -2,
        plmP24hCap18Pass: false,
        entryScoreBreakdown: "OI 30m-2.0% · CVD 1h+4h ✅",
        entryGradeReason: "score_8_plus_oi_2tf",
      },
      {
        signalType: "alpha",
        alphaScore: 6,
        status: "profit",
        price24hAtFire: 19,
        entryPrice3h: 2.1,
        entryOi30m: 0.5,
        plmP24hCap18Pass: false,
        entryScoreBreakdown: "CVD 1h ✅",
        entryGradeReason: "alpha",
      },
      {
        signalType: "alpha",
        alphaScore: 6,
        status: "profit",
        price24hAtFire: 12,
        entryPrice3h: 2.4,
        entryOi30m: -0.2,
        plmP24hCap18Pass: true,
        entryScoreBreakdown: "CVD 1h ✅",
        entryGradeReason: "alpha",
      },
    ]);

    assert.equal(report.shadow.capCost.excludedCompleted, 2);
    assert.equal(report.shadow.capCost.stopsRemoved, 1);
    assert.equal(report.shadow.capCost.profitsLost, 1);
    assert.equal(report.livePolicy.active, true);
    assert.equal(report.livePolicy.thresholds.p3hMax, 4);
    assert.equal(report.livePolicy.thresholds.spotVolMin, 1.1);
    assert.equal(report.shadow.negativeOi30mRisk.isGate, false);
    assert.equal(report.sample.p3hCoverageRate, 100);
  });

  test("separates grades and identifies the super_alpha promotion rule", () => {
    const report = buildPlmCalibrationReport([
      {
        signalType: "super_alpha",
        alphaScore: 8,
        status: "stop_loss",
        price24hAtFire: 20,
        entryPrice3h: 2,
        entryOi30m: -1,
        plmP24hCap18Pass: false,
        entryScoreBreakdown: "OI 30m-1.0% · Vol ×2.0",
        entryGradeReason: "score_8_plus_oi_2tf",
      },
      {
        signalType: "super_alpha",
        alphaScore: 7,
        status: "profit",
        price24hAtFire: 16,
        entryPrice3h: 2,
        entryOi30m: 16,
        plmP24hCap18Pass: true,
        entryScoreBreakdown: "OI 30m+16.0%",
        entryGradeReason: "oi30m_positive_15",
      },
    ]);

    assert.deepEqual(report.shadow.grades.superAlphaReasons, [
      { key: "oi30m_positive_15", count: 1 },
      { key: "score_8_plus_oi_2tf", count: 1 },
    ]);
    assert.equal(report.shadow.grades.superAlpha.completed, 2);
    assert.equal(report.shadow.grades.alpha.completed, 0);
  });

  test("does not declare a legacy cohort sufficient without decision snapshots", () => {
    const legacyRows = Array.from({ length: 25 }, () => ({
      signalType: "alpha",
      alphaScore: 6,
      status: "profit",
      price24hAtFire: 12,
      entryPrice3h: null,
      entryOi30m: null,
      plmP24hCap18Pass: null,
      entryScoreBreakdown: null,
      entryGradeReason: null,
    }));
    const qualifiedRow = {
      signalType: "alpha",
      alphaScore: 6,
      status: "profit",
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: null,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
    };

    const report = buildPlmCalibrationReport([...legacyRows, qualifiedRow]);

    assert.equal(report.sample.allHistoryCompletedOutcomes, 26);
    assert.equal(report.sample.completedOutcomes, 1);
    assert.equal(report.sample.sufficient, false);
    assert.equal(report.shadow.capCost.excludedCompleted, 0);
    assert.equal(report.shadow.grades.alpha.completed, 1);
  });

  test("reports three taker cohorts with outcome counts and raw PnL", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: -1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
    };
    const report = buildPlmCalibrationReport([
      {
        ...base,
        status: "profit",
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.below20,
        pnlPercent: 10,
      },
      {
        ...base,
        status: "stop_loss",
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
        pnlPercent: -8,
      },
      {
        ...base,
        status: "cancelled",
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.unavailable,
        pnlPercent: null,
      },
    ]);

    assert.deepEqual(
      report.shadow.futTakerShadow.cohorts.map((cohort) => ({
        key: cohort.key,
        completed: cohort.completed,
      })),
      [
        { key: "below_20", completed: 1 },
        { key: "at_or_above_20", completed: 1 },
        { key: "unavailable", completed: 1 },
      ],
    );
    assert.equal(report.shadow.futTakerShadow.cohorts[0]?.averageRawPnl, 10);
    assert.equal(report.shadow.futTakerShadow.cohorts[0]?.netRawPnl, 10);
    assert.equal(report.shadow.futTakerShadow.cohorts[0]?.rawPnlCount, 1);
    assert.equal(report.shadow.futTakerShadow.liveGateChanged, false);
    assert.equal(
      report.shadow.futTakerShadow.recommendation.action,
      "observation_only",
    );
  });

  test("compares immutable OI30m cohorts only after 20 high-OI completions", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 3,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
    };
    const lowOi = Array.from({ length: 20 }, () => ({
      ...base,
      status: "profit",
      pnlPercent: 10,
      plmOi30mShadow: PLM_OI30M_SHADOW.below2,
    }));
    const highOi = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      status: index < 10 ? "stop_loss" : "bu_stop",
      pnlPercent: index < 10 ? -8 : 0,
      plmOi30mShadow: PLM_OI30M_SHADOW.atOrAbove2,
    }));

    const insufficient = buildPlmCalibrationReport([
      ...lowOi,
      ...highOi.slice(0, 19),
    ]);
    assert.equal(insufficient.shadow.oi30mShadow.comparison.sufficient, false);
    assert.equal(
      insufficient.shadow.oi30mShadow.comparison.action,
      "observation_only_insufficient_comparison",
    );

    const report = buildPlmCalibrationReport([...lowOi, ...highOi]);
    const high = report.shadow.oi30mShadow.cohorts.find(
      (cohort) => cohort.key === "at_or_above_2",
    )!;
    assert.deepEqual(high.outcomes, {
      profit: 0,
      stopLoss: 10,
      buStop: 10,
      breakeven: 0,
      expired: 0,
      cancelled: 0,
    });
    assert.equal(high.averageRawPnl, -4);
    assert.equal(report.shadow.oi30mShadow.comparison.sufficient, true);
    assert.equal(
      report.shadow.oi30mShadow.comparison.action,
      "risk_confirmed_requires_separate_live_change",
    );
    assert.equal(report.shadow.oi30mShadow.comparison.liveGateChanged, false);
  });

  test("keeps OI30m comparison insufficient without a cool cohort or complete raw PnL", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      status: "stop_loss",
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 3,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      plmOi30mShadow: PLM_OI30M_SHADOW.atOrAbove2,
      pnlPercent: -8,
    };
    const noComparator = buildPlmCalibrationReport(
      Array.from({ length: 20 }, () => ({ ...base })),
    );
    assert.equal(noComparator.shadow.oi30mShadow.comparison.sufficient, false);
    assert.equal(
      noComparator.shadow.oi30mShadow.comparison.action,
      "observation_only_insufficient_comparison",
    );
    assert.equal(
      noComparator.shadow.oi30mShadow.comparison.comparatorAvailable,
      false,
    );

    const missingPnl = buildPlmCalibrationReport([
      ...Array.from({ length: 20 }, () => ({ ...base })),
      {
        ...base,
        status: "profit",
        plmOi30mShadow: PLM_OI30M_SHADOW.below2,
        pnlPercent: null,
      },
    ]);
    assert.equal(missingPnl.shadow.oi30mShadow.comparison.sufficient, false);
    assert.equal(
      missingPnl.shadow.oi30mShadow.comparison.completeRawPnlCoverage,
      false,
    );
  });

  test("splits numeric overheated snapshots without reclassifying legacy NULL", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      status: "profit",
      pnlPercent: 10,
    };
    const report = buildPlmCalibrationReport([
      {
        ...base,
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
        entryFutTakerNetBuy: 25,
      },
      {
        ...base,
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
        entryFutTakerNetBuy: 31,
      },
      {
        ...base,
        plmFutTakerShadow: null,
        entryFutTakerNetBuy: 24,
      },
    ]);

    assert.deepEqual(
      report.shadow.futTakerShadow.ranges.cohorts.map((cohort) => ({
        key: cohort.key,
        completed: cohort.completed,
      })),
      [
        { key: "from_20_to_30", completed: 1 },
        { key: "above_30", completed: 1 },
      ],
    );
    assert.equal(report.shadow.futTakerShadow.ranges.numericCaptured, 2);
  });

  test("reports stop removal, strong-deal loss, peak hits, and raw PnL for every candidate", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      entryPrice: 100,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      entryOi1h: 1,
      entryOi4h: 1,
      entryPrice1h: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.below20,
      entryFutTakerNetBuy: 5,
    };
    const rows = [
      {
        ...base,
        status: "stop_loss",
        peakPrice: 104,
        pnlPercent: -8,
        price24hAtFire: 22,
        plmP24hCap18Pass: false,
        entryOi30m: -1,
        entryOi1h: -1,
        entryOi4h: -1,
        entryPrice1h: -1,
        plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
        entryFutTakerNetBuy: 25,
      },
      {
        ...base,
        status: "profit",
        peakPrice: 122,
        pnlPercent: 12,
        price24hAtFire: 23,
        plmP24hCap18Pass: false,
      },
    ];

    const report = buildPlmCalibrationReport(rows);
    assert.equal(report.shadow.candidateFilters.length, 6);
    const cap = report.shadow.candidateFilters.find(
      (candidate) => candidate.key === "p24h_above_18",
    )!;
    assert.deepEqual(
      {
        stopsRemoved: cap.stopsRemoved,
        profitsLost: cap.profitsLost,
        hit10Lost: cap.hit10Lost,
        hit20Lost: cap.hit20Lost,
        excludedRawPnl: cap.rawPnl.excluded.net,
      },
      {
        stopsRemoved: 1,
        profitsLost: 1,
        hit10Lost: 1,
        hit20Lost: 1,
        excludedRawPnl: 4,
      },
    );
    const oi1h = report.shadow.candidateFilters.find(
      (candidate) => candidate.key === "oi1h_below_0",
    )!;
    assert.equal(oi1h.stopsRemoved, 1);
    assert.equal(oi1h.profitsLost, 0);
    assert.equal(oi1h.rawPnl.retained.average, 12);
    assert.equal(oi1h.criteria.qualifiesForLiveChange, false);
    assert.equal(report.shadow.decision.action, "observation_only");
  });

  test("does not qualify a candidate with fewer than 20 evaluated rows or incomplete peak/PnL coverage", () => {
    const base: PlmCalibrationRow = {
      signalType: "alpha",
      alphaScore: 6,
      entryPrice: 100,
      peakPrice: 103,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      entryOi1h: null,
      entryOi4h: 1,
      entryPrice1h: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.below20,
      entryFutTakerNetBuy: 5,
      status: "profit",
      pnlPercent: 10,
    };
    const mostlyUnavailable = Array.from({ length: 20 }, () => ({ ...base }));
    mostlyUnavailable[0] = {
      ...base,
      status: "stop_loss",
      entryOi1h: -1,
      pnlPercent: -8,
    };
    const smallReport = buildPlmCalibrationReport(mostlyUnavailable);
    const smallOi1h = smallReport.shadow.candidateFilters.find(
      (candidate) => candidate.key === "oi1h_below_0",
    )!;
    assert.equal(smallOi1h.evaluatedCompleted, 1);
    assert.equal(smallOi1h.criteria.sufficient, false);
    assert.equal(smallOi1h.criteria.qualifiesForLiveChange, false);

    const incompleteCoverage = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      status: index === 0 ? "stop_loss" : "profit",
      entryOi1h: index === 0 ? -1 : 1,
      peakPrice: index === 0 ? null : 112,
      pnlPercent: index === 1 ? null : index === 0 ? -8 : 10,
    }));
    const coverageReport = buildPlmCalibrationReport(incompleteCoverage);
    const coverageOi1h = coverageReport.shadow.candidateFilters.find(
      (candidate) => candidate.key === "oi1h_below_0",
    )!;
    assert.equal(coverageOi1h.criteria.sufficient, true);
    assert.equal(coverageOi1h.criteria.completePeakCoverage, false);
    assert.equal(coverageOi1h.criteria.completeRawPnlCoverage, false);
    assert.equal(coverageOi1h.criteria.qualifiesForLiveChange, false);
  });

  test("qualifies a candidate only after 20 immutable completions and no strong deals lost", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      entryPrice: 100,
      peakPrice: 112,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      entryOi1h: 1,
      entryOi4h: 1,
      entryPrice1h: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.below20,
      entryFutTakerNetBuy: 5,
    };
    const retained = Array.from({ length: 19 }, () => ({
      ...base,
      status: "profit",
      pnlPercent: 10,
    }));
    const removedStop = {
      ...base,
      status: "stop_loss",
      peakPrice: 103,
      pnlPercent: -8,
      entryOi1h: -1,
    };

    const report = buildPlmCalibrationReport([...retained, removedStop]);
    const oi1h = report.shadow.candidateFilters.find(
      (candidate) => candidate.key === "oi1h_below_0",
    )!;
    assert.equal(oi1h.criteria.sufficient, true);
    assert.equal(oi1h.criteria.noStrongDealsLost, true);
    assert.equal(oi1h.criteria.improvesAverageRawPnl, true);
    assert.equal(oi1h.criteria.qualifiesForLiveChange, true);
    assert.equal(
      report.shadow.decision.action,
      "candidate_requires_separate_live_change",
    );
    assert.equal(report.shadow.decision.liveGateChanged, false);
  });

  test("gives the 20-30 and above-30 taker ranges their own evidence-gated comparison", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      entryPrice: 100,
      peakPrice: 103,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      entryOi1h: 1,
      entryOi4h: 1,
      entryPrice1h: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
    };
    const from20To30 = Array.from({ length: 20 }, () => ({
      ...base,
      status: "profit",
      pnlPercent: 10,
      entryFutTakerNetBuy: 25,
    }));
    const above30 = Array.from({ length: 20 }, () => ({
      ...base,
      status: "stop_loss",
      pnlPercent: -8,
      entryFutTakerNetBuy: 35,
    }));

    const report = buildPlmCalibrationReport([...from20To30, ...above30]);
    assert.equal(
      report.shadow.futTakerShadow.ranges.comparison.action,
      "above_30_worse",
    );
    assert.equal(
      report.shadow.futTakerShadow.ranges.comparison.sufficient,
      true,
    );
    assert.equal(
      report.shadow.futTakerShadow.ranges.comparison.averageRawPnlDelta,
      -18,
    );
    assert.equal(
      report.shadow.futTakerShadow.ranges.comparison.stopRateDelta,
      100,
    );
    assert.equal(
      report.shadow.futTakerShadow.ranges.comparison.liveGateChanged,
      false,
    );
  });

  test("recommends only a limited experiment when risk worsens but strong deals exist", () => {
    const base = {
      signalType: "alpha",
      alphaScore: 6,
      price24hAtFire: 12,
      entryPrice3h: 2,
      entryOi30m: 1,
      plmP24hCap18Pass: true,
      entryScoreBreakdown: "CVD 1h+4h ✅",
      entryGradeReason: "alpha",
    };
    const cool = Array.from({ length: 10 }, () => ({
      ...base,
      status: "profit",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.below20,
      pnlPercent: 10,
    }));
    const hotStops = Array.from({ length: 9 }, () => ({
      ...base,
      status: "stop_loss",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
      pnlPercent: -8,
    }));
    const hotProfit = {
      ...base,
      status: "profit",
      plmFutTakerShadow: PLM_FUT_TAKER_SHADOW.atOrAbove20,
      pnlPercent: 10,
    };

    const report = buildPlmCalibrationReport([...cool, ...hotStops, hotProfit]);

    assert.equal(report.shadow.futTakerShadow.recommendation.sufficient, true);
    assert.equal(
      report.shadow.futTakerShadow.recommendation.action,
      "limited_experiment",
    );
  });
});
