import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ingestBulletSignal, validateBulletSignal } from "./ingest.mjs";

const impulse = JSON.parse(
  await readFile(
    new URL(
      "../../artifacts/alpha-scanner/public/trading-bot-impulse-buy-sample.json",
      import.meta.url,
    ),
  ),
);
const cascade = JSON.parse(
  await readFile(
    new URL(
      "../../artifacts/alpha-scanner/public/trading-bot-sample.json",
      import.meta.url,
    ),
  ),
);
const neon = JSON.parse(
  await readFile(
    new URL(
      "../bybit-trading-bot/test/fixtures/neon-support-sample.json",
      import.meta.url,
    ),
  ),
);
const fresh = (signal) =>
  structuredClone({ ...signal, signalAt: new Date().toISOString() });

test("real rejected Impulse Buy shape validates, including floating runner fraction", () => {
  assert.equal(validateBulletSignal(fresh(impulse)).status, 200);
});

test("real rejected liquidation cascade shape validates, but cannot be replayed", () => {
  assert.equal(validateBulletSignal(fresh(cascade)).status, 200);
  assert.equal(
    validateBulletSignal(cascade).body.error.code,
    "expired_or_future_signal",
  );
});

test("BTC requires its whole-percent protection contract", () => {
  const btc = fresh(cascade);
  btc.symbol = "BTCUSDT";
  Object.assign(btc.payload.exitRules, {
    firstTargetPct: 1,
    breakevenAtPct: 1,
    protectedProfitAtPct: 0,
    protectedProfitPct: 0,
    trailingActivationPct: 2,
    trailingGapPercentagePoints: 1,
    progressMilestoneIntervalPct: 1,
  });
  assert.equal(validateBulletSignal(btc).status, 200);
  delete btc.payload.exitRules.progressMilestoneIntervalPct;
  assert.equal(
    validateBulletSignal(btc).body.error.code,
    "unsupported_exit_ladder",
  );
});

test("experimental patterns and an invented runner are rejected", () => {
  const bad = fresh(impulse);
  bad.patternId = "whale_watch";
  assert.equal(validateBulletSignal(bad).status, 422);
  const noRunner = fresh(impulse);
  delete noRunner.payload.exitRules.runner;
  assert.equal(
    validateBulletSignal(noRunner).body.error.code,
    "unsupported_runner",
  );
});

test("Neon Support is approved and Balanced Grind is retired", () => {
  assert.equal(validateBulletSignal(fresh(neon)).status, 200);
  const retired = fresh(neon);
  retired.patternId = "balanced_grind";
  assert.equal(validateBulletSignal(retired).status, 422);
  assert.equal(
    validateBulletSignal(retired).body.error.code,
    "pattern_not_approved",
  );
});

test("no false 202 without both implemented rules and durable queue", async () => {
  const request = { token: "test-token", body: fresh(impulse) };
  const base = { expectedToken: "test-token" };
  const neonRequest = { token: "test-token", body: fresh(neon) };
  assert.equal((await ingestBulletSignal(request, base)).status, 503);
  assert.equal(
    (
      await ingestBulletSignal(request, {
        ...base,
        supportsPlan: async () => false,
        enqueue: async () => ({ status: "pending" }),
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await ingestBulletSignal(request, {
        ...base,
        supportsPlan: async () => true,
        enqueue: async () => ({ status: "pending" }),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await ingestBulletSignal(neonRequest, {
        ...base,
        supportsPlan: async () => true,
        enqueue: async () => ({ status: "pending" }),
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await ingestBulletSignal(
        { ...request, token: "wrong" },
        {
          ...base,
          supportsPlan: async () => true,
          enqueue: async () => ({ status: "pending" }),
        },
      )
    ).status,
    401,
  );
});
