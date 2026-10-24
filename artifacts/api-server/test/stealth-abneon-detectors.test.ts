import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAbneonSupportBounce as evaluateAbneonSupportBounceRaw,
  evaluateOrderBlockSupportBounce as evaluateOrderBlockSupportBounceRaw,
  computeSupportZones,
  type ClosedDetectorCandle,
} from "../src/lib/stealth-abneon-detectors.js";

// Gates use aggregated USD volume; fixtures model it as volume x 100.
const withUsd = (rows: readonly ClosedDetectorCandle[] | undefined) =>
  rows?.map((row) => ({ ...row, volumeUsd: row.volume * 100 }));
const evaluateAbneonSupportBounce = (
  input: Parameters<typeof evaluateAbneonSupportBounceRaw>[0],
) =>
  evaluateAbneonSupportBounceRaw({
    ...input,
    candles1h: withUsd(input.candles1h)!,
  });
const evaluateOrderBlockSupportBounce = (
  input: Parameters<typeof evaluateOrderBlockSupportBounceRaw>[0],
) =>
  evaluateOrderBlockSupportBounceRaw({
    ...input,
    candles1h: withUsd(input.candles1h)!,
  });

const c = (
  time: number,
  close: number,
  volume = 100,
  low = close,
): ClosedDetectorCandle => ({
  time,
  open: close - 1,
  high: close + 2,
  low,
  close,
  volume,
});

test("ABNeon support arms and records a frozen level", () => {
  const h4 = Array.from({ length: 24 }, (_, i) =>
    c((i - 16) * 4 * 3600000, 110, 100, 100),
  );
  const h1 = Array.from({ length: 21 }, (_, i) =>
    c(i * 3600000, 101, i < 20 ? 0 : 500, 100),
  );
  h1[20] = c(20 * 3600000, 102, 250, 100);
  h1[21] = c(21 * 3600000, 104, 250, 101);
  const result = evaluateAbneonSupportBounce({
    candles4h: h4,
    candles1h: h1,
    observedAt: 22 * 3600000,
    frozenLevel: 100,
    armCandleTime: 20 * 3600000,
  });
  // Owner 2026-10-21: a strong bounce closing above the zone still qualifies.
  assert.equal(result.status, "qualified");
  assert.equal(result.volumeEvidence.ratio, 20);
});

test("ABNeon frozen support requires 4x volume and $500k turnover", () => {
  const h4 = Array.from({ length: 24 }, (_, i) =>
    c((i - 16) * 4 * 3600000, 110, 100, 100),
  );
  const h1 = Array.from({ length: 21 }, (_, i) =>
    c(i * 3600000, 101, i < 20 ? 0 : 500, 100),
  );
  const result = evaluateAbneonSupportBounce({
    candles4h: h4,
    candles1h: h1,
    observedAt: 22 * 3600000,
    frozenLevel: 100,
    armCandleTime: 20 * 3600000,
  });
  assert.equal(result.status, "armed");
  assert.equal(result.volumeEvidence.ratio, null);
});

test("ABNeon frozen support requires 4x volume and $500k turnover", () => {
  const h4 = Array.from({ length: 24 }, (_, i) =>
    c((i - 16) * 4 * 3600000, 110, 100, 100),
  );
  const baseline = Array.from({ length: 20 }, (_, i) =>
    c(i * 3600000, 100, 4_000, 100),
  );
  const evaluate = (volume: number) =>
    evaluateAbneonSupportBounce({
      candles4h: h4,
      candles1h: [...baseline, c(20 * 3600000, 101, volume, 100)],
      observedAt: 22 * 3600000,
      frozenLevel: 100,
      armCandleTime: 20 * 3600000,
    });

  assert.equal(evaluate(15_500).status, "armed");
  assert.equal(evaluate(16_000).status, "qualified");
});

function orderBlockFixture(reactionVolume = 6_000) {
  const h4 = Array.from({ length: 14 }, (_, i) => ({
    ...c(i * 4 * 3600000, 100, 100, 99),
    open: 99,
    high: 101,
    low: 99,
    close: 100,
  }));
  h4.push({
    time: 14 * 4 * 3600000,
    open: 100,
    high: 101,
    low: 97,
    close: 98,
    volume: 100,
  });
  h4.push({
    time: 15 * 4 * 3600000,
    open: 99,
    high: 105,
    low: 98,
    close: 104,
    volume: 200,
  });
  const h1 = Array.from({ length: 20 }, (_, i) => ({
    ...c(i * 3600000, 100, 1_000, 99),
    open: 99,
    high: 101,
    low: 99,
    close: 100,
  }));
  h1.push({
    time: 16 * 4 * 3600000 + 3600000,
    open: 99,
    high: 102,
    low: 99,
    close: 101,
    volume: reactionVolume,
  });
  return { h4, h1 };
}

test("order-block shadow qualifies an ARB-like bearish base, displacement and volume retest", () => {
  const { h4, h1 } = orderBlockFixture();
  const result = evaluateOrderBlockSupportBounce({
    candles4h: h4,
    candles1h: h1,
    observedAt: 17 * 4 * 3600000,
  });
  assert.equal(result.method, "order_block_support_bounce");
  assert.equal(result.status, "qualified");
  assert.equal(result.reason, "later_closed_1h_order_block_reaction");
  assert.equal(result.evidence?.version, "ob-support-v1");
});

test("order-block arm remains frozen when a newer block appears", () => {
  const initial = orderBlockFixture();
  const preReaction = [
    ...initial.h1.slice(0, 20),
    { ...initial.h1[19]!, time: 61 * 3600000, volume: 1_000 },
  ];
  const armed = evaluateOrderBlockSupportBounce({
    candles4h: initial.h4,
    candles1h: preReaction,
    observedAt: 66 * 3600000,
  });
  assert.equal(armed.status, "armed");
  const identity = armed.evidence?.orderBlock as { candleTime: number };
  const newerBase = {
    time: 16 * 4 * 3600000,
    open: 106,
    high: 107,
    low: 102,
    close: 104,
    volume: 100,
  };
  const newerImpulse = {
    time: 17 * 4 * 3600000,
    open: 104,
    high: 112,
    low: 103,
    close: 111,
    volume: 200,
  };
  const later = evaluateOrderBlockSupportBounce({
    candles4h: [...initial.h4, newerBase, newerImpulse],
    candles1h: initial.h1,
    observedAt: 18 * 4 * 3600000,
    frozen: {
      level: armed.frozenLevel!,
      armedAt: armed.armCandleTime!,
      evidence: armed.evidence,
    },
  });
  assert.equal(
    (later.evidence?.orderBlock as { candleTime: number }).candleTime,
    identity.candleTime,
  );
  assert.equal(later.frozenLevel, armed.frozenLevel);
});

test("order-block shadow rejects missing displacement and keeps weak volume armed", () => {
  const fixture = orderBlockFixture(4_000);
  assert.equal(
    evaluateOrderBlockSupportBounce({
      candles4h: fixture.h4.map((candle, index) =>
        index === 15 ? { ...candle, close: 100, high: 101 } : candle,
      ),
      candles1h: fixture.h1,
      observedAt: 17 * 4 * 3600000,
    }).reason,
    "no_displacement",
  );
  assert.equal(
    evaluateOrderBlockSupportBounce({
      candles4h: fixture.h4,
      candles1h: fixture.h1,
      marketCapUsd: 500_000_000,
      observedAt: 17 * 4 * 3600000,
    }).status,
    "armed",
  );
});

test("order-block shadow excludes forming candles and invalidates a closed break below the zone", () => {
  const fixture = orderBlockFixture();
  const forming = {
    ...fixture.h4[15]!,
    time: 16 * 4 * 3600000,
    close: 110,
  };
  const formingResult = evaluateOrderBlockSupportBounce({
    candles4h: [...fixture.h4.slice(0, 15), forming],
    candles1h: fixture.h1,
    observedAt: forming.time + 4 * 3600000 - 1,
  });
  assert.equal(formingResult.reason, "insufficient_closed_candles");
  const formingReaction = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: fixture.h1,
    observedAt: fixture.h1.at(-1)!.time + 3600000 - 1,
  });
  assert.notEqual(formingReaction.status, "qualified");
  const invalidated = evaluateOrderBlockSupportBounce({
    candles4h: [
      ...fixture.h4,
      {
        ...fixture.h4[15]!,
        time: 61 * 3600000,
        open: 100,
        high: 101,
        low: 90,
        close: 95,
      },
    ],
    candles1h: fixture.h1,
    observedAt: 17 * 4 * 3600000,
  });
  assert.equal(invalidated.reason, "order_block_invalidated_below_zone");
});

test("frozen order-block evaluation fails explicitly when persisted evidence is missing", () => {
  const fixture = orderBlockFixture();
  const result = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: fixture.h1,
    observedAt: 17 * 4 * 3600000,
    frozen: { level: 99, armedAt: 64 * 3600000, evidence: null },
  });
  assert.equal(result.status, "terminal");
  assert.equal(result.reason, "missing_frozen_order_block_evidence");
});

test("order-block replay chooses the earliest closed event, not the latest candle", () => {
  const fixture = orderBlockFixture();
  const arm = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: [
      ...fixture.h1.slice(0, 20),
      { ...fixture.h1[19]!, time: 61 * 3600000, volume: 1_000 },
    ],
    observedAt: 66 * 3600000,
  });
  assert.equal(arm.status, "armed");
  const frozen = {
    level: arm.frozenLevel!,
    armedAt: arm.armCandleTime!,
    evidence: arm.evidence,
  };
  const goodBeforeBreak = evaluateOrderBlockSupportBounce({
    candles4h: [
      ...fixture.h4,
      { ...fixture.h4[15]!, time: 17 * 4 * 3600000, close: 95, low: 90 },
    ],
    candles1h: fixture.h1,
    observedAt: 72 * 3600000,
    frozen,
  });
  assert.equal(goodBeforeBreak.status, "qualified");

  const invalidFirst = evaluateOrderBlockSupportBounce({
    candles4h: [
      ...fixture.h4,
      { ...fixture.h4[15]!, time: 16 * 4 * 3600000, close: 95, low: 90 },
    ],
    candles1h: [
      ...fixture.h1.slice(0, 20),
      { ...fixture.h1[19]!, time: 69 * 3600000, volume: 6_000 },
    ],
    observedAt: 70 * 3600000,
    frozen,
  });
  assert.equal(invalidFirst.reason, "order_block_invalidated_below_zone");

  const exactTtl = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: [
      ...fixture.h1.slice(0, 20),
      { ...fixture.h1[19]!, time: 65 * 3600000, volume: 1_000 },
    ],
    observedAt: arm.armCandleTime! + 24 * 3600000,
    frozen,
  });
  assert.equal(exactTtl.reason, "reaction_window_expired");
});

test("order-block invalidation wins when 4H and 1H events close simultaneously", () => {
  const fixture = orderBlockFixture();
  const arm = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: [
      ...fixture.h1.slice(0, 20),
      { ...fixture.h1[19]!, time: 61 * 3600000, volume: 1_000 },
    ],
    observedAt: 66 * 3600000,
  });
  const result = evaluateOrderBlockSupportBounce({
    candles4h: [
      ...fixture.h4,
      { ...fixture.h4[15]!, time: 62 * 3600000, close: 95, low: 90 },
    ],
    candles1h: fixture.h1,
    observedAt: 66 * 3600000,
    frozen: {
      level: arm.frozenLevel!,
      armedAt: arm.armCandleTime!,
      evidence: arm.evidence,
    },
  });
  assert.equal(result.reason, "order_block_invalidated_below_zone");
});

test("frozen order-block rejects tampered derived ATR/body and predicate evidence", () => {
  const fixture = orderBlockFixture();
  const armed = evaluateOrderBlockSupportBounce({
    candles4h: fixture.h4,
    candles1h: fixture.h1,
    observedAt: 66 * 3600000,
  });
  const baseFrozen = {
    level: armed.frozenLevel!,
    armedAt: armed.armCandleTime!,
    evidence: armed.evidence as Record<string, any>,
  };
  for (const mutate of [
    (e: Record<string, any>) => {
      e.orderBlock.atr += 1;
    },
    (e: Record<string, any>) => {
      e.displacement.body += 1;
    },
    (e: Record<string, any>) => {
      e.displacement.requiredBody += 1;
    },
    (e: Record<string, any>) => {
      e.orderBlock.close = e.orderBlock.open + 1;
    },
  ]) {
    const evidence = structuredClone(baseFrozen.evidence);
    mutate(evidence);
    const result = evaluateOrderBlockSupportBounce({
      candles4h: fixture.h4,
      candles1h: fixture.h1,
      observedAt: 66 * 3600000,
      frozen: { ...baseFrozen, evidence },
    });
    assert.equal(result.reason, "missing_frozen_order_block_evidence");
  }
});

// Same price shape on 4H spacing: its SRv2 zones coincide with the 1H zones.
test("neon confluence label lists coinciding timeframes in order", async () => {
  const { neonConfluenceLabel } =
    await import("../src/lib/stealth-abneon-shadow-pure.js");
  assert.equal(
    neonConfluenceLabel({ timeframe: "1h", confluenceTimeframes: ["4h"] }),
    "1H+4H",
  );
  assert.equal(
    neonConfluenceLabel({ timeframe: "1d", confluenceTimeframes: ["1h"] }),
    "1H+1D",
  );
  assert.equal(neonConfluenceLabel({ timeframe: "1h" }), null);
});

test("ABNeon support zone: touch within 1% and close back qualifies directly", () => {
  const H = 3600000;
  // 4H triangle wave: pivot lows at 100 every 14 bars, pivot highs at 120.
  const h4 = Array.from({ length: 70 }, (_, i) => {
    const phase = i % 14;
    const mid =
      phase <= 7 ? 100 + (phase * 20) / 7 : 120 - ((phase - 7) * 20) / 7;
    return { ...c(i * 4 * H, mid + 1, 100, mid), high: mid + 2 };
  });
  const zones = computeSupportZones(h4);
  const zone = zones.find((z) => z.center > 98 && z.center < 103);
  assert.ok(zone, "zone around the 100 lows exists");
  const h1 = Array.from({ length: 48 }, (_, i) => c(i * H, 108, 100, 107));
  // reaction: wick into the zone (within 1%), closes back inside, 5x volume.
  h1[47] = {
    ...c(47 * H, zone.top, 600, zone.bottom * 1.002),
    open: zone.bottom,
  };
  const base = {
    candles4h: h4,
    candles1h: withUsd(h1)!,
    observedAt: 48 * H + 70 * 4 * H,
  };
  const shift = 70 * 4 * H;
  const h1s = h1.map((row) => ({ ...row, time: row.time + shift }));
  const r = evaluateAbneonSupportBounceRaw({
    ...base,
    candles1h: withUsd(h1s)!,
  });
  assert.equal(r.status, "qualified");
  assert.equal(r.frozenLevel, zone.top);
  // A reaction closing beyond +1% above the zone has already left it.
  h1s[47] = { ...h1s[47]!, close: zone.top * 1.03, high: zone.top * 1.04 };
  const late = evaluateAbneonSupportBounceRaw({
    ...base,
    candles1h: withUsd(h1s)!,
  });
  assert.notEqual(late.status, "qualified");
});
