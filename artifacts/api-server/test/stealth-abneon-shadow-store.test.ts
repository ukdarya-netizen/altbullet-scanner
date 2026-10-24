import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  canClaimAbneonSupportBounce,
  classifyAbneonFirePersistenceFailure,
  isLiveEligibleShadowMethod,
  liveEligibilityForShadowUpsert,
  monotonicShadowStatus,
  ownsAbneonSupportBounceClaim,
  routePersistedNeonSupportBounces,
  supportBounceQualificationTime,
} from "../src/lib/stealth-abneon-shadow-pure.js";

const schemaSource = readFileSync(
  resolve(process.cwd(), "src/index.ts"),
  "utf8",
);

test("shadow upsert status is monotonic across terminal and firing rows", () => {
  assert.equal(monotonicShadowStatus("firing", "qualified"), "firing");
  assert.equal(monotonicShadowStatus("fired", "armed"), "fired");
  assert.equal(monotonicShadowStatus("terminal", "armed"), "terminal");
  assert.equal(monotonicShadowStatus("armed", "qualified"), "qualified");
  assert.equal(monotonicShadowStatus("qualified", "armed"), "qualified");
  assert.equal(monotonicShadowStatus("qualified", "terminal"), "qualified");
});

test("live eligibility excludes pre-launch rows but admits live transitions", () => {
  for (const status of ["qualified", "firing", "fired", "terminal"] as const) {
    assert.equal(
      liveEligibilityForShadowUpsert({
        existingStatus: status,
        existingLiveEligible: false,
        incomingStatus: "qualified",
      }),
      false,
      `pre-launch ${status} row must stay out of the live queue`,
    );
  }
  assert.equal(
    liveEligibilityForShadowUpsert({
      existingStatus: null,
      existingLiveEligible: false,
      incomingStatus: "qualified",
    }),
    true,
  );
  assert.equal(
    liveEligibilityForShadowUpsert({
      existingStatus: null,
      existingLiveEligible: false,
      incomingStatus: "armed",
    }),
    true,
  );
  assert.equal(
    liveEligibilityForShadowUpsert({
      existingStatus: "armed",
      existingLiveEligible: false,
      incomingStatus: "qualified",
    }),
    true,
  );
});

test("order block remains shadow-only while ABNeon may enter live delivery", () => {
  assert.equal(isLiveEligibleShadowMethod("abneon_support_bounce"), true);
  assert.equal(isLiveEligibleShadowMethod("order_block_support_bounce"), false);
});

test("only one worker can own a live claim; expired claims are retryable", () => {
  assert.equal(
    canClaimAbneonSupportBounce({
      status: "qualified",
      claimExpiresAtMs: null,
      nowMs: 100,
    }),
    true,
  );
  assert.equal(
    canClaimAbneonSupportBounce({
      status: "firing",
      claimExpiresAtMs: 200,
      nowMs: 100,
    }),
    false,
  );
  assert.equal(
    canClaimAbneonSupportBounce({
      status: "firing",
      claimExpiresAtMs: 100,
      nowMs: 100,
    }),
    true,
  );
  assert.equal(
    ownsAbneonSupportBounceClaim({
      owner: "worker-a",
      token: "token-a",
      expectedOwner: "worker-a",
      expectedToken: "token-a",
    }),
    true,
  );
  assert.equal(
    ownsAbneonSupportBounceClaim({
      owner: "worker-b",
      token: "token-b",
      expectedOwner: "worker-a",
      expectedToken: "token-a",
    }),
    false,
  );
});

test("only known permanent database failures terminalize a claim", () => {
  assert.equal(
    classifyAbneonFirePersistenceFailure({ code: "23505" }),
    "nonretryable",
  );
  assert.equal(
    classifyAbneonFirePersistenceFailure({ code: "40001" }),
    "retryable",
  );
  assert.equal(
    classifyAbneonFirePersistenceFailure(new Error("timeout")),
    "retryable",
  );
});

test("qualification time is the closed 1H candle close, not its open", () => {
  const triggerOpen = 10 * 60 * 60 * 1000;
  assert.equal(
    supportBounceQualificationTime(triggerOpen),
    triggerOpen + 60 * 60 * 1000,
  );
});

test("persisted qualified ABNeon rows enter live routing while Order Block stays shadow-only", () => {
  const routed = routePersistedNeonSupportBounces([
    {
      symbol: "NEON-USDT",
      method: "abneon_support_bounce",
      status: "qualified",
      liveEligible: true,
      frozenLevel: 12.5,
      armCandleTime: 1_000,
      triggerCandleTime: 2_000,
      confluence: "1H+4H",
    },
    {
      symbol: "NO-CONFLUENCE-USDT",
      method: "abneon_support_bounce",
      status: "qualified",
      liveEligible: true,
      frozenLevel: 1,
      armCandleTime: 1_000,
      triggerCandleTime: 2_000,
      confluence: null,
    },
    {
      symbol: "ORDER-BLOCK-USDT",
      method: "order_block_support_bounce",
      status: "qualified",
      liveEligible: true,
      frozenLevel: 8.25,
      armCandleTime: 3_000,
      triggerCandleTime: 4_000,
    },
  ]);

  assert.deepEqual(routed.get("NEON-USDT"), {
    frozenLevel: 12.5,
    armCandleTime: 1_000,
    triggerCandleTime: 2_000,
    confluence: "1H+4H",
  });
  assert.equal(routed.has("NO-CONFLUENCE-USDT"), false);
  assert.equal(routed.has("ORDER-BLOCK-USDT"), false);
  assert.match(schemaSource, /live_eligible boolean NOT NULL DEFAULT false/);
  assert.match(
    schemaSource,
    /ADD COLUMN IF NOT EXISTS live_eligible boolean NOT NULL DEFAULT false/,
  );
});
