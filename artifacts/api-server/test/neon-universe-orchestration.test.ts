import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNeonUniverse,
  mergeQualifiedNeonEventsOldestFirst,
  runNeonUniverseOrchestration,
} from "../src/lib/neon-universe-orchestration.js";

test("Neon orchestration evaluates the union once and keeps supplemental symbols out of generic work", async () => {
  const normalSnapshot = ["GENERIC-A", "GENERIC-B"];
  // This models the scanner's already-expanded usdtTickers array.
  const expandedUsdtTickers = [...normalSnapshot, "PRESCAN-A", "OI-A"];
  const generic = normalSnapshot;
  const prescan = ["GENERIC-B", "PRESCAN-A"];
  const oiWatch = ["OI-A", "PRESCAN-A"];
  const queued = ["QUEUED-A"];
  const plan = buildNeonUniverse(generic, prescan, oiWatch, queued);
  assert.deepEqual(plan.genericSymbols, normalSnapshot);
  assert.equal(plan.genericSymbols.includes(expandedUsdtTickers[2]!), false);
  const calls: string[] = [];
  const genericCalls: string[] = [];
  const outcome = await runNeonUniverseOrchestration({
    genericSymbols: plan.genericSymbols,
    neonSymbols: plan.neonSymbols,
    qualifiedDeliverySymbols: plan.deliverySymbols,
    evaluateNeon: async (symbol) => {
      calls.push(`neon:${symbol}`);
      return symbol === "PRESCAN-A" ? symbol : null;
    },
    runGeneric: async (symbol) => {
      genericCalls.push(symbol);
    },
  });
  assert.deepEqual(
    new Set(calls),
    new Set([
      "neon:GENERIC-A",
      "neon:GENERIC-B",
      "neon:PRESCAN-A",
      "neon:OI-A",
      "neon:QUEUED-A",
    ]),
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(genericCalls, ["GENERIC-A", "GENERIC-B", "QUEUED-A"]);
  assert.equal(genericCalls.includes("PRESCAN-A"), false);
  assert.equal(genericCalls.includes("OI-A"), false);
  assert.deepEqual(outcome.qualifiedDeliverySymbols, ["PRESCAN-A"]);
});

test("Neon orchestration bounds concurrency, honors abort/deadline, and settles started work", async () => {
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const settled: string[] = [];
  const result = await runNeonUniverseOrchestration({
    genericSymbols: [],
    neonSymbols: ["A", "B", "C", "D", "E", "F"],
    concurrency: 2,
    signal: controller.signal,
    evaluateNeon: async (symbol) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      settled.push(symbol);
      if (symbol === "A") controller.abort();
      return null;
    },
    runGeneric: async () => {},
  });
  assert.equal(peak <= 2, true);
  assert.equal(active, 0);
  assert.equal(result.qualifiedDeliverySymbols.length, 0);
  assert.equal(settled.length >= 1, true);

  let started = 0;
  const deadline = Date.now() - 1;
  await runNeonUniverseOrchestration({
    genericSymbols: [],
    neonSymbols: ["LATE-A", "LATE-B", "LATE-C"],
    concurrency: 2,
    deadlineAt: deadline,
    evaluateNeon: async () => {
      started += 1;
      return null;
    },
    runGeneric: async () => {},
  });
  assert.equal(started, 0);
});

test("same-cycle Neon results never replace the oldest queued identity", () => {
  const queued = new Map([
    ["ARB-USDT", { frozenLevel: 100, armCandleTime: 1, triggerCandleTime: 2 }],
  ]);
  const sameCycle = new Map([
    ["ARB-USDT", { frozenLevel: 101, armCandleTime: 3, triggerCandleTime: 4 }],
    ["RUNE-USDT", { frozenLevel: 50, armCandleTime: 5, triggerCandleTime: 6 }],
  ]);

  mergeQualifiedNeonEventsOldestFirst(queued, sameCycle);

  assert.deepEqual(queued.get("ARB-USDT"), {
    frozenLevel: 100,
    armCandleTime: 1,
    triggerCandleTime: 2,
  });
  assert.deepEqual(queued.get("RUNE-USDT"), {
    frozenLevel: 50,
    armCandleTime: 5,
    triggerCandleTime: 6,
  });
});
