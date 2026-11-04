import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  IMPULSE_RUNNER_POLICY_VERSION,
  IMPULSE_RUNNER_MAX_AGE_MS,
  isImpulseRunnerFiveDaysOld,
  impulseRunnerAccountingCorrectionEventKey,
  IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION,
  impulseRunnerFinalStatus,
  isImpulseRunnerCoreClosed,
  findHistoricalRunnerTrailingStopHit,
  BR_MISSED_MILESTONES,
  brMilestoneEventKey,
  brMilestoneReconstructedPrice,
  resolveImpulseRunnerEmergencyStopPrice,
  resolveImpulseRunnerExitDecision,
  resolveImpulseRunnerTrailingStopPrice,
  selectImpulseRunnerPolicy,
  impulseRunnerPnlPercent,
  resolveImpulseRunnerCanonicalAccounting,
} from "../src/lib/impulse-runner-policy.js";

test("runner expires five full days after original opening, not core close", () => {
  const originalOpenedAt = new Date("2026-09-17T14:25:36.725Z");
  assert.equal(
    isImpulseRunnerFiveDaysOld(
      originalOpenedAt,
      new Date(originalOpenedAt.getTime() + IMPULSE_RUNNER_MAX_AGE_MS - 1),
    ),
    false,
  );
  assert.equal(
    isImpulseRunnerFiveDaysOld(
      originalOpenedAt,
      new Date(originalOpenedAt.getTime() + IMPULSE_RUNNER_MAX_AGE_MS),
    ),
    true,
  );
});

test("runner accounting correction event key is stable per repaired position", () => {
  assert.equal(
    impulseRunnerAccountingCorrectionEventKey(1734),
    "position:1734:impulse_runner_v1:runner_close_correction:canonical_accounting_v1",
  );
});

test("freezes the policy only for new long impulse_buy positions", () => {
  assert.equal(
    selectImpulseRunnerPolicy({ sentimentKey: "impulse_buy" }),
    IMPULSE_RUNNER_POLICY_VERSION,
  );
  assert.equal(
    selectImpulseRunnerPolicy({ sentimentKey: "impulse_buy", isShort: true }),
    null,
  );
  assert.equal(selectImpulseRunnerPolicy({ sentimentKey: "alpha" }), null);
});

test("runner uses breakeven emergency protection and 30-point trailing gap", () => {
  assert.equal(resolveImpulseRunnerEmergencyStopPrice(100, null), 100);
  assert.equal(resolveImpulseRunnerEmergencyStopPrice(100, 5), 100);
  assert.equal(
    resolveImpulseRunnerTrailingStopPrice({
      entryPrice: 100,
      peakPrice: 129,
    }),
    null,
  );
  assert.equal(
    resolveImpulseRunnerTrailingStopPrice({
      entryPrice: 100,
      peakPrice: 150,
    }),
    120,
  );
});

test("single-entry and legacy Impulse Buy runners both use breakeven", () => {
  assert.equal(
    resolveImpulseRunnerEmergencyStopPrice(
      100,
      null,
      IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION,
    ),
    100,
  );
  assert.equal(
    resolveImpulseRunnerEmergencyStopPrice(100, null, "legacy_split"),
    100,
  );
  assert.equal(
    resolveImpulseRunnerEmergencyStopPrice(
      100,
      5,
      IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION,
    ),
    100,
  );
});

test("runner result stays anchored to original entry and core transition is idempotent", () => {
  assert.equal(impulseRunnerPnlPercent(100, 150), 50);
  const open = {
    policyVersion: IMPULSE_RUNNER_POLICY_VERSION,
    coreClosedAt: new Date(),
    runnerState: "open",
  };
  assert.equal(isImpulseRunnerCoreClosed(open), true);
  assert.equal(
    isImpulseRunnerCoreClosed({
      ...open,
      runnerState: "closed",
    }),
    false,
  );
  assert.equal(
    isImpulseRunnerCoreClosed({
      policyVersion: null,
      coreClosedAt: new Date(),
      runnerState: "open",
    }),
    false,
  );
});

test("startup/realtime runner decision has deterministic stricter-stop precedence", () => {
  assert.deepEqual(
    resolveImpulseRunnerExitDecision({
      entryPrice: 100,
      currentPrice: 89,
      peakPrice: 150,
      persistedStopLossPct: 5,
      persistedTrailingStopLevel: 120,
    }),
    { hit: true, exitPrice: 120, reason: "trailing_stop" },
  );
  assert.deepEqual(
    resolveImpulseRunnerExitDecision({
      entryPrice: 100,
      currentPrice: 119,
      peakPrice: 150,
      persistedTrailingStopLevel: null,
    }),
    { hit: true, exitPrice: 120, reason: "trailing_stop" },
  );
});

test("runner decision applies breakeven to new and legacy rows", () => {
  assert.deepEqual(
    resolveImpulseRunnerExitDecision({
      entryPrice: 100,
      currentPrice: 99,
      peakPrice: 110,
      persistedStopLossPct: null,
      entryPolicyVersion: IMPULSE_RUNNER_NEW_ENTRY_POLICY_VERSION,
    }),
    { hit: true, exitPrice: 100, reason: "emergency_stop" },
  );
  assert.deepEqual(
    resolveImpulseRunnerExitDecision({
      entryPrice: 100,
      currentPrice: 99,
      peakPrice: 110,
      persistedStopLossPct: null,
      entryPolicyVersion: null,
    }),
    { hit: true, exitPrice: 100, reason: "emergency_stop" },
  );
  assert.deepEqual(
    resolveImpulseRunnerExitDecision({
      entryPrice: 100,
      currentPrice: 100.01,
      peakPrice: 110,
      persistedStopLossPct: null,
      entryPolicyVersion: null,
    }),
    { hit: false, exitPrice: null, reason: null },
  );
});

test("terminal status follows pure runner result from original entry", () => {
  assert.equal(impulseRunnerFinalStatus(50, -10), "stop_loss");
  assert.equal(impulseRunnerFinalStatus(-5, 10), "profit");
});

test("canonical repair floors a stale runner exit to its earned trailing level", () => {
  assert.deepEqual(
    resolveImpulseRunnerCanonicalAccounting({
      originalEntryPrice: 100,
      runnerExitPrice: 111,
      peakPrice: 164,
      runnerPeakPrice: 164,
    }),
    {
      runnerExitPrice: 134,
      trailingStopLevel: 134,
      pnlPercent: 34,
      status: "profit",
      peakPrice: 164,
    },
  );
  assert.deepEqual(
    resolveImpulseRunnerCanonicalAccounting({
      originalEntryPrice: 100,
      runnerExitPrice: 90,
      peakPrice: 120,
      runnerPeakPrice: 110,
    }),
    {
      runnerExitPrice: 90,
      trailingStopLevel: null,
      pnlPercent: -10,
      status: "stop_loss",
      peakPrice: 120,
    },
  );
});

test("canonical repair fails closed for ambiguous prices and is idempotent", () => {
  assert.equal(
    resolveImpulseRunnerCanonicalAccounting({
      originalEntryPrice: 0,
      runnerExitPrice: 110,
      peakPrice: 164,
      runnerPeakPrice: 164,
    }),
    null,
  );
  const input = {
    originalEntryPrice: 100,
    runnerExitPrice: 110,
    peakPrice: 164,
    runnerPeakPrice: 150,
  };
  assert.deepEqual(
    resolveImpulseRunnerCanonicalAccounting(input),
    resolveImpulseRunnerCanonicalAccounting(input),
  );
});

test("historical runner crossing ignores candles before arming and the open candle", () => {
  const armedAt = new Date("2026-09-17T01:00:30.000Z");
  const now = Date.parse("2026-09-17T02:00:30.000Z");
  assert.equal(
    findHistoricalRunnerTrailingStopHit(
      [
        { time: Date.parse("2026-09-17T00:59:00Z"), low: 0.1 },
        { time: Date.parse("2026-09-17T01:55:00Z"), low: 0.61469 },
        { time: Date.parse("2026-09-17T02:00:00Z"), low: 0.1 },
      ],
      armedAt,
      now,
      0.61805,
    )?.time,
    Date.parse("2026-09-17T01:55:00Z"),
  );
});

test("BR peak +174.10% resolves to the persisted +144.10% runner stop", () => {
  const stop = resolveImpulseRunnerTrailingStopPrice({
    entryPrice: 0.2532,
    peakPrice: 0.6940212,
  });

  assert.ok(stop !== null);
  assert.ok(Math.abs(stop - 0.6180612) < 0.000001);
});

test("BR recovery sequence contains only the 31 missing milestone events", () => {
  assert.equal(BR_MISSED_MILESTONES.length, 31);
  assert.equal(BR_MISSED_MILESTONES[0], 15);
  assert.equal(BR_MISSED_MILESTONES.at(-1), 165);
  assert.ok(!(BR_MISSED_MILESTONES as readonly number[]).includes(10));
  assert.ok(!(BR_MISSED_MILESTONES as readonly number[]).includes(170));
  assert.deepEqual(BR_MISSED_MILESTONES.map(brMilestoneEventKey).slice(0, 2), [
    "milestone:v3:1688:milestone:15",
    "milestone:v3:1688:milestone:20",
  ]);
  assert.ok(Math.abs(brMilestoneReconstructedPrice(15) - 0.29118) < 0.000001);
  assert.ok(Math.abs(brMilestoneReconstructedPrice(165) - 0.67098) < 0.000001);
});

test("every recovered BR milestone has a readable photo asset", () => {
  for (const milestone of BR_MISSED_MILESTONES) {
    assert.equal(
      existsSync(
        new URL(`../src/assets/milestone${milestone}.png`, import.meta.url),
      ),
      true,
      `missing milestone${milestone}.png`,
    );
  }
});
