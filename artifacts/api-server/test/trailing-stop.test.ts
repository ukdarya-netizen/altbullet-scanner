import assert from "node:assert/strict";
import test from "node:test";
import {
  isRealtimeTrailingStopHit,
  isRealtimeTrailingEventNewer,
  isFreshDurableTrailingStopHit,
  isRealtimeBitcoinBreakevenHit,
  isStartupTrailingStopHit,
  isTrailingProtectionActive,
  isTrailingStopHit,
  resolveActivatedTrailingStopLevel,
  resolveRealtimeTrailingBoundaryState,
  resolveRealtimeTrailingClose,
  resolveTrailingStopLevel,
  resolveLongTrailingHighWater,
  retryRealtimeTrailingOperation,
  shouldSubscribeRealtimeTrailingPosition,
} from "../src/lib/trailing-stop.js";
import { getExitProfile } from "../src/lib/watcher-config.js";

test("trailing stop stays at the highest persisted level", () => {
  const staleWorkerLevel = resolveTrailingStopLevel({
    entryPrice: 700,
    peakPrice: 851.6,
    trailingGapPercent: 10,
    persistedTrailingStopLevel: 790,
  });

  assert.equal(staleWorkerLevel, 790);
  assert.equal(isTrailingStopHit(789.86, staleWorkerLevel), true);
});

test("new percentage-point rule raises a stale price-relative boundary", () => {
  const trailingStop = resolveTrailingStopLevel({
    entryPrice: 700,
    peakPrice: 851.6,
    trailingGapPercent: 10,
    persistedTrailingStopLevel: 766.44,
  });

  assert.equal(trailingStop, 781.6);
  assert.equal(isTrailingStopHit(781.61, trailingStop), false);
  assert.equal(isTrailingStopHit(781.6, trailingStop), true);
});

test("persisted pre-activation level cannot arm trailing", () => {
  assert.equal(
    isTrailingProtectionActive({
      peakPnlPercent: 8,
      trailingActivationPercent: 15,
      persistedTrailingStopLevel: 770.35,
    }),
    false,
  );
});

test("trailing protection is inactive without activation evidence", () => {
  assert.equal(
    isTrailingProtectionActive({
      peakPnlPercent: 8,
      trailingActivationPercent: 15,
      persistedTrailingStopLevel: null,
    }),
    false,
  );
});

test("all tokens require a real peak threshold before trailing is armed", () => {
  assert.equal(
    resolveActivatedTrailingStopLevel({
      peakPnlPercent: 10.03,
      trailingActivationPercent: 15,
      entryPrice: 1,
      peakPrice: 1.1003,
      trailingGapPercent: 10,
      persistedTrailingStopLevel: 0.99027,
    }),
    null,
  );

  assert.equal(
    resolveActivatedTrailingStopLevel({
      peakPnlPercent: 13.04,
      trailingActivationPercent: 15,
      entryPrice: 1,
      peakPrice: 1.1304,
      trailingGapPercent: 10,
      persistedTrailingStopLevel: 1.01736,
    }),
    null,
  );

  const activatedLevel = resolveActivatedTrailingStopLevel({
    peakPnlPercent: 15,
    trailingActivationPercent: 15,
    entryPrice: 1,
    peakPrice: 1.15,
    trailingGapPercent: 10,
    persistedTrailingStopLevel: null,
  });
  assert.ok(activatedLevel !== null && Math.abs(activatedLevel - 1.05) < 1e-12);
});

test("trailing subtracts ten percentage points from peak PnL", () => {
  const profile = getExitProfile("stealth_breakout");
  const entryPrice = 0.0223456;
  const peakPrice = 0.027932;
  const trailingStop = resolveTrailingStopLevel({
    entryPrice,
    peakPrice,
    trailingGapPercent: profile.trailingGap,
    persistedTrailingStopLevel: null,
  });

  assert.equal(profile.trailingGap, 10);
  assert.ok(Math.abs(trailingStop - 0.02569744) < 1e-12);
  assert.equal(isTrailingStopHit(0.0258, trailingStop), false);
  assert.equal(isTrailingStopHit(trailingStop, trailingStop), true);
  assert.equal(isTrailingStopHit(0.025, trailingStop), true);
});

test("BTC trailing activates only at +2% and locks peak PnL minus one point", () => {
  const profile = getExitProfile("price_led_momentum", "BTC-USDT");
  const entryPrice = 100_000;
  assert.deepEqual(profile, {
    firstTarget: 1,
    trailingActivation: 2,
    trailingGap: 1,
  });
  assert.equal(
    resolveActivatedTrailingStopLevel({
      peakPnlPercent: 1.99,
      trailingActivationPercent: profile.trailingActivation,
      entryPrice,
      peakPrice: entryPrice * 1.0199,
      trailingGapPercent: profile.trailingGap,
      persistedTrailingStopLevel: null,
    }),
    null,
  );
  assert.equal(
    resolveActivatedTrailingStopLevel({
      peakPnlPercent: 2,
      trailingActivationPercent: profile.trailingActivation,
      entryPrice,
      peakPrice: entryPrice * 1.02,
      trailingGapPercent: profile.trailingGap,
      persistedTrailingStopLevel: null,
    }),
    entryPrice * 1.01,
  );
  assert.equal(
    resolveActivatedTrailingStopLevel({
      peakPnlPercent: 3,
      trailingActivationPercent: profile.trailingActivation,
      entryPrice,
      peakPrice: entryPrice * 1.03,
      trailingGapPercent: profile.trailingGap,
      persistedTrailingStopLevel: null,
    }),
    entryPrice * 1.02,
  );
});

test("a valid old boundary crossing cannot be lost when a newer peak raised the durable stop", () => {
  const armedAt = new Date("2026-08-28T12:00:00.000Z");
  const observedAt = new Date("2026-08-28T12:00:01.000Z");
  const decision = resolveRealtimeTrailingClose({
    currentPrice: 89,
    candidateTrailingStopLevel: 90,
    freshTrailingStopLevel: 99,
    armedAt,
    observedAt,
    exchangeAt: observedAt,
  });

  assert.deepEqual(decision, {
    shouldClose: true,
    trailingStopLevel: 99,
  });
});

test("realtime trailing never accepts a buffered tick from before the boundary was armed", () => {
  const armedAt = new Date("2026-08-28T12:00:00.000Z");
  const oldTickAt = new Date("2026-08-28T11:59:59.999Z");
  const decision = resolveRealtimeTrailingClose({
    currentPrice: 89,
    candidateTrailingStopLevel: 90,
    freshTrailingStopLevel: 99,
    armedAt,
    observedAt: new Date("2026-08-28T12:00:02.000Z"),
    exchangeAt: oldTickAt,
  });

  assert.deepEqual(decision, {
    shouldClose: false,
    trailingStopLevel: 99,
  });
  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 90,
      trailingStopLevel: 90,
      armedAt,
      observedAt: armedAt,
      exchangeAt: armedAt,
    }),
    true,
  );
});

test("realtime subscribes a long before trailing activation", () => {
  assert.equal(
    shouldSubscribeRealtimeTrailingPosition({
      status: "in_run",
      isShort: false,
    }),
    true,
  );
  assert.equal(
    shouldSubscribeRealtimeTrailingPosition({
      status: "in_run",
      isShort: true,
    }),
    false,
  );
  assert.equal(
    shouldSubscribeRealtimeTrailingPosition({
      status: "active",
      symbol: "BTC-USDT",
      isShort: false,
    }),
    true,
  );
  assert.equal(
    shouldSubscribeRealtimeTrailingPosition({
      status: "active",
      symbol: "ETH-USDT",
      isShort: false,
    }),
    false,
  );
  assert.equal(
    shouldSubscribeRealtimeTrailingPosition({
      status: "active",
      symbol: "BTCUSDT",
      isShort: true,
    }),
    false,
  );
});

test("BTC realtime BE applies after a +1% peak and gives priority to +2% trailing", () => {
  const input = {
    currentPrice: 100,
    entryPrice: 100,
    breakevenActivationPercent: 1,
    trailingActivationPercent: 2,
  };
  assert.equal(
    isRealtimeBitcoinBreakevenHit({ ...input, peakPnlPercent: 0.99 }),
    false,
  );
  assert.equal(
    isRealtimeBitcoinBreakevenHit({ ...input, peakPnlPercent: 1 }),
    true,
  );
  assert.equal(
    isRealtimeBitcoinBreakevenHit({ ...input, peakPnlPercent: 1.99 }),
    true,
  );
  assert.equal(
    isRealtimeBitcoinBreakevenHit({ ...input, peakPnlPercent: 2 }),
    false,
  );
});

test("realtime rejects duplicate and out-of-order exchange event times", () => {
  const lastEventAt = new Date("2026-08-28T12:00:02.000Z");
  assert.equal(
    isRealtimeTrailingEventNewer({
      observedAt: new Date("2026-08-28T12:00:05.000Z"),
      exchangeAt: new Date("2026-08-28T12:00:01.000Z"),
      lastEventAt,
    }),
    false,
  );
  assert.equal(
    isRealtimeTrailingEventNewer({
      observedAt: new Date("2026-08-28T12:00:05.000Z"),
      exchangeAt: lastEventAt,
      lastEventAt,
    }),
    false,
  );
  assert.equal(
    isRealtimeTrailingEventNewer({
      observedAt: new Date("2026-08-28T12:00:03.000Z"),
      exchangeAt: new Date("2026-08-28T12:00:03.000Z"),
      lastEventAt,
    }),
    true,
  );
});

test("realtime retries one transient durable failure before accepting a tick", async () => {
  let attempts = 0;
  let acceptedWatermark: Date | null = null;
  const eventAt = new Date("2026-08-28T12:00:03.000Z");
  const result = await retryRealtimeTrailingOperation(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient database timeout");
      return "durable-close";
    },
    {
      retryDelayMs: 0,
      wait: async () => undefined,
    },
  );
  acceptedWatermark = eventAt;

  assert.equal(result, "durable-close");
  assert.equal(attempts, 2);
  assert.equal(acceptedWatermark, eventAt);
});

test("realtime leaves a failed tick unaccepted after retry exhaustion", async () => {
  const acceptedWatermark: Date | null = null;
  await assert.rejects(
    retryRealtimeTrailingOperation(
      async () => {
        throw new Error("database unavailable");
      },
      {
        attempts: 2,
        retryDelayMs: 0,
        wait: async () => undefined,
      },
    ),
    /database unavailable/,
  );
  assert.equal(acceptedWatermark, null);
});

test("candidate refresh preserves historical armed time after map replacement", () => {
  const historicalArmedAt = new Date("2026-08-28T12:00:00.000Z");
  const refreshAt = new Date("2026-08-28T12:05:00.000Z");
  assert.deepEqual(
    resolveRealtimeTrailingBoundaryState({
      calculatedTrailingStop: 90,
      existing: null,
      remembered: {
        trailingStopLevel: 90,
        armedAt: historicalArmedAt,
      },
      observedAt: refreshAt,
    }),
    {
      trailingStopLevel: 90,
      armedAt: historicalArmedAt,
    },
  );
});

test("stale candidate closes on a fresh higher durable stop armed before tick", () => {
  assert.equal(
    isFreshDurableTrailingStopHit({
      currentPrice: 98,
      trailingStopLevel: 99,
      armedAt: new Date("2026-08-28T12:00:00.000Z"),
      observedAt: new Date("2026-08-28T12:00:02.000Z"),
      exchangeAt: new Date("2026-08-28T12:00:01.000Z"),
    }),
    true,
  );
});

test("fresh durable stop armed after tick cannot close on that tick", () => {
  assert.equal(
    isFreshDurableTrailingStopHit({
      currentPrice: 98,
      trailingStopLevel: 99,
      armedAt: new Date("2026-08-28T12:00:02.000Z"),
      observedAt: new Date("2026-08-28T12:00:03.000Z"),
      exchangeAt: new Date("2026-08-28T12:00:01.000Z"),
    }),
    false,
  );
});

test("startup high-water subtracts the gap from peak PnL", () => {
  const startupHigh = new Date("2026-08-28T12:00:00.000Z");
  const state = resolveLongTrailingHighWater({
    entryPrice: 100,
    durablePeakPrice: 112,
    currentPrice: 120,
    trailingActivationPercent: 15,
    trailingGapPercent: 10,
  });

  assert.deepEqual(state, {
    peakPrice: 120,
    trailingStopLevel: 110.00000000000001,
  });
  assert.equal(
    isFreshDurableTrailingStopHit({
      currentPrice: 120,
      trailingStopLevel: state.trailingStopLevel,
      armedAt: startupHigh,
      observedAt: startupHigh,
    }),
    false,
  );
  assert.equal(
    isFreshDurableTrailingStopHit({
      currentPrice: 107,
      trailingStopLevel: state.trailingStopLevel,
      armedAt: startupHigh,
      observedAt: new Date("2026-08-28T12:01:00.000Z"),
    }),
    true,
  );
});

test("startup immediately closes a corrected legacy boundary already crossed", () => {
  const observedAt = new Date("2026-09-05T12:00:00.000Z");
  assert.equal(
    isStartupTrailingStopHit({
      currentPrice: 113,
      trailingStopLevel: 114.1,
      trailingActive: true,
      trailingStopArmedAt: observedAt,
      observedAt,
      boundaryArmedByStartupObservation: true,
      startupPeakIncreased: false,
    }),
    true,
  );
});

test("startup does not close a boundary raised by the same new peak observation", () => {
  const observedAt = new Date("2026-09-05T12:00:00.000Z");
  assert.equal(
    isStartupTrailingStopHit({
      currentPrice: 124.1,
      trailingStopLevel: 114.1,
      trailingActive: true,
      trailingStopArmedAt: observedAt,
      observedAt,
      boundaryArmedByStartupObservation: true,
      startupPeakIncreased: true,
    }),
    false,
  );
});
