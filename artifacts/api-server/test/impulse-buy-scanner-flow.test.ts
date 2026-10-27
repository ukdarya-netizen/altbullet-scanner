import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  classifyImpulseBuyLiqShadow,
  evaluateImpulseBuy,
  IMPULSE_BUY_COMMON_GATE_KEYS,
  normalizeImpulseTakerNetBuyPct,
  resolveImpulseBuyScannerFlow,
  shouldEmitImpulseBuyLive,
} from "../src/lib/scanner-patterns.js";
import { isNetflowBatchFresh } from "../src/lib/coinglass_taker.js";

const passingInput = {
  candleOpen: 100,
  candleHigh: 102.2,
  candleLow: 99.8,
  candleClose: 102,
  candleVolumeUsd: 180_000,
  baselineVolumeUsd: 100_000,
  price24h: 0,
  price3h: 0,
  oi30m: 0.5,
  longLiq24hUsd: 60_000,
  futVolumeMultiplier: 1.4,
  spotVolumeMultiplier: 2.5,
  fundingRate: 0,
  oi1h: 1,
} as const;

test("Impulse Buy reaches direct confirmed fire past every common gate", () => {
  const decision = evaluateImpulseBuy(passingInput);
  const flow = resolveImpulseBuyScannerFlow(decision, [
    ...IMPULSE_BUY_COMMON_GATE_KEYS,
  ]);

  assert.equal(flow.sentimentKey, "impulse_buy");
  assert.equal(flow.isConfirmedFire, true);
  assert.equal(flow.decision.score, 3);
});

test("a failed Impulse Buy baseline never receives a common-gate bypass", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    candleClose: 100.5,
    candleVolumeUsd: 120_000,
  });
  const flow = resolveImpulseBuyScannerFlow(decision, [
    ...IMPULSE_BUY_COMMON_GATE_KEYS,
  ]);

  assert.equal(flow.sentimentKey, null);
  assert.equal(flow.isConfirmedFire, false);
  assert.ok(!decision.rejectReasons.includes("candle_body_lt_2pct"));
  assert.ok(decision.rejectReasons.includes("volume_lt_1_5x"));
});

test("missing inputs are not classified as market failures", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    candleOpen: 0,
    baselineVolumeUsd: 0,
  });

  assert.equal(decision.evaluable, false);
  assert.equal(decision.components.bullish_impulse, null);
  assert.ok(decision.missingReasons.includes("closed_30m_candle_missing"));
  assert.ok(decision.missingReasons.includes("volume_baseline_missing"));
});

test("an unrequested volume aggregate is not reported as missing", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    baselineVolumeUsd: 0,
    volumeMeasured: false,
  });
  assert.equal(decision.passes, false);
  assert.ok(!decision.missingReasons.includes("volume_baseline_missing"));
  assert.ok(decision.rejectReasons.includes("volume_not_measured"));
});

test("unrequested taker, CVD and spot volume use *_not_measured codes", () => {
  const d = evaluateImpulseBuy({
    ...passingInput,
    futTakerNetBuyPct: null,
    cvd1h: null,
    spotVolumeMultiplier: null,
    takerCvdMeasured: false,
    spotVolumeMeasured: false,
  });
  for (const c of [
    "fut_taker_not_measured",
    "cvd_not_measured",
    "spot_volume_not_measured",
  ])
    assert.ok(d.rejectReasons.includes(c), c);
  const r = evaluateImpulseBuy({
    ...passingInput,
    futTakerNetBuyPct: null,
    cvd1h: null,
  });
  assert.ok(r.rejectReasons.includes("fut_taker_unavailable"));
  assert.ok(r.rejectReasons.includes("cvd_unavailable"));
});

test("a qualified Impulse Buy candidate is eligible for live fire", () => {
  const decision = evaluateImpulseBuy(passingInput);
  assert.equal(decision.passes, true);
  assert.equal(shouldEmitImpulseBuyLive(decision, false), false);
  assert.equal(shouldEmitImpulseBuyLive(decision, true), true);

  const liveFlow = resolveImpulseBuyScannerFlow(decision);
  assert.equal(liveFlow.sentimentKey, "impulse_buy");
  assert.equal(liveFlow.isConfirmedFire, true);
});

test("stale taker batches cannot satisfy a new decision", () => {
  const updatedAt = 1_000_000;
  assert.equal(isNetflowBatchFresh(updatedAt, updatedAt + 299_999), true);
  assert.equal(isNetflowBatchFresh(updatedAt, updatedAt + 300_000), false);
  assert.equal(isNetflowBatchFresh(0, updatedAt), false);
});

test("an unavailable taker remains telemetry-only", () => {
  const takerNetBuyPct = normalizeImpulseTakerNetBuyPct({
    available: false,
    netBuyPct: 0,
  });
  const decision = evaluateImpulseBuy(passingInput);

  assert.equal(takerNetBuyPct, null);
  assert.equal(decision.evaluable, true);
  assert.equal(decision.passes, true);
});

test("known extreme funding and 1h/4h OI reject Impulse Buy", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    fundingRate: -0.0011,
    oi1h: 20.1,
    oi4h: 20.1,
  });

  assert.equal(decision.evaluable, true);
  assert.equal(decision.passes, false);
  assert.ok(decision.rejectReasons.includes("funding_below_minus_0_1pct"));
  assert.ok(decision.rejectReasons.includes("oi1h_above_20pct"));
  assert.ok(!decision.rejectReasons.includes("oi4h_above_20pct"));
});

test("Impulse Buy requires a known spot volume of at least 2x with no upper cap", () => {
  for (const spotVolumeMultiplier of [2, 4.01, 25]) {
    const decision = evaluateImpulseBuy({
      ...passingInput,
      spotVolumeMultiplier,
    });
    assert.equal(decision.passes, true, `spot=${spotVolumeMultiplier}`);
  }
  const below = evaluateImpulseBuy({
    ...passingInput,
    spotVolumeMultiplier: 1.99,
  });
  assert.equal(below.passes, false);
  assert.ok(below.rejectReasons.includes("spot_volume_below_2x"));
  const missing = evaluateImpulseBuy({
    ...passingInput,
    spotVolumeMultiplier: null,
  });
  assert.equal(missing.passes, false);
  assert.ok(missing.rejectReasons.includes("spot_volume_unavailable"));
});

test("Impulse Buy no longer rejects p24h >= 20%", () => {
  for (const price24h of [20, 31.3, 60]) {
    const decision = evaluateImpulseBuy({ ...passingInput, price24h });
    assert.equal(decision.passes, true, `p24h=${price24h}`);
    assert.ok(!decision.rejectReasons.includes("p24h_ge_20pct"));
  }
});

test("Impulse Buy rejects only the approved p24h band [5, 10)", () => {
  for (const price24h of [5, 5.01, 7.5, 9.999999]) {
    const decision = evaluateImpulseBuy({ ...passingInput, price24h });
    assert.equal(decision.evaluable, true);
    assert.equal(decision.passes, false, `p24h=${price24h}`);
    assert.ok(decision.rejectReasons.includes("p24h_5_to_10pct"));
    assert.equal(shouldEmitImpulseBuyLive(decision, true), false);
    assert.equal(resolveImpulseBuyScannerFlow(decision).isConfirmedFire, false);
    assert.equal(
      resolveImpulseBuyScannerFlow(decision, [...IMPULSE_BUY_COMMON_GATE_KEYS])
        .sentimentKey,
      null,
    );
  }
  for (const price24h of [-20, 0, 4.999999, 10, 10.01, 15, 19.99]) {
    assert.equal(
      evaluateImpulseBuy({ ...passingInput, price24h }).passes,
      true,
      `p24h=${price24h}`,
    );
  }
});

test("unavailable or nonfinite p24h blocks the signal", () => {
  for (const price24h of [null, undefined, NaN, Infinity, -Infinity]) {
    const decision = evaluateImpulseBuy({ ...passingInput, price24h });
    assert.equal(decision.passes, false);
    assert.deepEqual(decision.rejectReasons, ["price24h_unavailable"]);
  }
});

test("scanner evaluates p24h from the current decision-time price context", () => {
  const scanner = readFileSync(
    resolve(process.cwd(), "src/lib/scanner.ts"),
    "utf8",
  );
  assert.match(
    scanner,
    /_buildImpulseInput = \([^)]*\) => \(\{[\s\S]*?price24h: price24hChange,[\s\S]*?\}\)/,
  );
  assert.match(scanner, /evaluateImpulseBuy\(_buildImpulseInput\(\)\)/);
  const decisionHistory = readFileSync(
    resolve(process.cwd(), "src/lib/pattern-decision-history.ts"),
    "utf8",
  );
  assert.match(decisionHistory, /impulse_buy:\s*\[\s*"p24h_5_to_10pct"/);
});

test("missing funding and OI1h are rejected (no fail-open)", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    fundingRate: null,
    oi1h: null,
    oi4h: null,
  });

  assert.equal(decision.passes, false);
  assert.ok(decision.rejectReasons.includes("funding_unavailable"));
  assert.ok(decision.rejectReasons.includes("oi1h_unavailable"));
});

test("liquidation-ratio shadow classification is fail-open at its boundary", () => {
  assert.deepEqual(classifyImpulseBuyLiqShadow(null, 1_000_000), {
    liquidationRatio: null,
    aboveShadowThreshold: false,
  });
  assert.deepEqual(classifyImpulseBuyLiqShadow(150_000, 1_000_000), {
    liquidationRatio: 0.15,
    aboveShadowThreshold: false,
  });
  assert.deepEqual(classifyImpulseBuyLiqShadow(150_001, 1_000_000), {
    liquidationRatio: 0.150001,
    aboveShadowThreshold: true,
  });
  assert.deepEqual(classifyImpulseBuyLiqShadow(0, 1_000_000), {
    liquidationRatio: 0,
    aboveShadowThreshold: false,
  });
});

test("high liquidation ratio remains telemetry-only for live Impulse Buy", () => {
  const decision = evaluateImpulseBuy(passingInput);
  const shadow = classifyImpulseBuyLiqShadow(200_000, 1_000_000);

  assert.equal(shadow.aboveShadowThreshold, true);
  assert.equal(decision.passes, true);
  assert.equal(shouldEmitImpulseBuyLive(decision, true), true);
  assert.equal(resolveImpulseBuyScannerFlow(decision).isConfirmedFire, true);
});

test("removed indicators are not fetched or used as live rejection gates", () => {
  const scanner = readFileSync(
    resolve(process.cwd(), "src/lib/scanner.ts"),
    "utf8",
  );
  assert.doesNotMatch(scanner, /fetchIndicatorTelemetry|indicatorTelemetry30m/);
  assert.doesNotMatch(scanner, /evaluateImpulseBuyAdxSlopeGate/);
  assert.doesNotMatch(scanner, /impulse_adx_slope_30m_high/);
});

test("Impulse Buy rejects a 3h price rise of 20% or more", () => {
  for (const price3h of [20, 21.5, 55]) {
    const decision = evaluateImpulseBuy({ ...passingInput, price3h });
    assert.equal(decision.passes, false, `p3h=${price3h}`);
    assert.ok(decision.rejectReasons.includes("price3h_ge_20pct"));
  }
  for (const price3h of [-5, 0, 10.4, 17.5, 19.999]) {
    const decision = evaluateImpulseBuy({ ...passingInput, price3h });
    assert.equal(decision.passes, true, `p3h=${price3h}`);
  }
});

test("Impulse Buy blocks missing core telemetry and the 1.0/1.0 volume placeholder", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ price3h: null }, "price3h_unavailable"],
    [{ oi30m: null }, "oi30m_unavailable"],
    [{ oi30m: undefined }, "oi30m_unavailable"],
    [{ futVolumeMultiplier: null }, "fut_volume_unavailable"],
    [
      { futVolumeMultiplier: 1, spotVolumeMultiplier: 1 },
      "volume_placeholder_1x",
    ],
  ];
  for (const [override, reason] of cases) {
    const decision = evaluateImpulseBuy({ ...passingInput, ...override });
    assert.equal(decision.passes, false, reason);
    assert.ok(decision.rejectReasons.includes(reason), reason);
  }
  // Real measurements near 1.0 on futures still pass when spot volume >= 2x.
  for (const override of [
    { futVolumeMultiplier: 1, spotVolumeMultiplier: 2.2 },
    { futVolumeMultiplier: 1.01, spotVolumeMultiplier: 2 },
  ]) {
    assert.equal(
      evaluateImpulseBuy({ ...passingInput, ...override }).passes,
      true,
    );
  }
});

test("small body and weak close are telemetry, not rejection reasons", () => {
  const decision = evaluateImpulseBuy({
    ...passingInput,
    candleClose: 100.5,
    candleHigh: 103,
    candleVolumeUsd: 200_000,
    baselineVolumeUsd: 100_000,
  });

  assert.equal(decision.components.bullish_impulse, false);
  assert.equal(decision.components.strong_close, false);
  assert.ok(!decision.rejectReasons.includes("candle_body_lt_2pct"));
  assert.ok(!decision.rejectReasons.includes("close_strength_lt_65pct"));
});

test("2026-10-27 quality gate: OI30m >= 0.26% and long liquidations 24h >= $47k", () => {
  assert.equal(evaluateImpulseBuy({ ...passingInput, oi30m: 0.26, longLiq24hUsd: 47_000 }).passes, true);
  const lowOi = evaluateImpulseBuy({ ...passingInput, oi30m: 0.25 });
  assert.equal(lowOi.passes, false);
  assert.ok(lowOi.rejectReasons.includes("oi30m_below_0_26pct"));
  const lowLiq = evaluateImpulseBuy({ ...passingInput, longLiq24hUsd: 46_999 });
  assert.equal(lowLiq.passes, false);
  assert.ok(lowLiq.rejectReasons.includes("long_liq24h_below_47k"));
  const noLiq = evaluateImpulseBuy({ ...passingInput, longLiq24hUsd: null });
  assert.equal(noLiq.passes, false);
  assert.ok(noLiq.rejectReasons.includes("long_liq24h_unavailable"));
});

test("scanner passes decision-time long liquidations 24h into Impulse Buy", () => {
  const source = readFileSync(resolve(process.cwd(), "src/lib/scanner.ts"), "utf8");
  assert.match(source, /longLiq24hUsd: _impulseLongLiq24h/);
});
