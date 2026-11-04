import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createServer } from "../server.mjs";
import { validateSignal } from "../contract.mjs";

const sample = JSON.parse(
  await readFile(
    new URL("./fixtures/impulse-buy-sample.json", import.meta.url),
    "utf8",
  ),
);
const neonSample = JSON.parse(
  await readFile(
    new URL("./fixtures/neon-support-sample.json", import.meta.url),
    "utf8",
  ),
);
const now = Date.parse(sample.signalAt) + 30_000;
const seen = new Map();
const store = {
  enqueue: async (body) => {
    const prior = seen.get(body.sourceSignalId);
    if (prior) {
      return {
        kind: JSON.stringify(prior) === JSON.stringify(body) ? "duplicate" : "conflict",
      };
    }
    seen.set(body.sourceSignalId, body);
    return { kind: "new", status: "pending" };
  },
  listRecent: async () => [],
  listOpenPositions: async () => [],
  listRecentPositions: async () => [],
  getPaperAccount: async () => ({
    initialUsdt: 100,
    freeUsdt: 100,
    reservedUsdt: 0,
    realizedPnlUsdt: 0,
  }),
};
const server = createServer({ store, token: "test-token", clock: () => now });
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});
const url = (path) => `http://127.0.0.1:${server.address().port}${path}`;
const post = (body, token = "test-token") =>
  fetch(url("/api/trading/signals"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trading-token": token,
    },
    body: JSON.stringify(body),
  });

test("historical impulse wire shape is accepted for offline schema check", async () => {
  const response = await post(sample);
  assert.equal(response.status, 202);
  assert.deepEqual((await response.json()).signal, {
    status: "pending",
    sourceSignalId: sample.sourceSignalId,
    duplicate: false,
  });
  const again = await post(sample);
  assert.equal(again.status, 202);
  assert.equal((await again.json()).signal.duplicate, true);
  assert.equal(seen.size, 1);
});

test("Neon Support is approved while new Balanced Grind signals are rejected", () => {
  assert.deepEqual(validateSignal(neonSample, now), { status: 200 });
  const retiredSignal = {
    ...neonSample,
    patternId: "balanced_grind",
  };
  assert.deepEqual(validateSignal(retiredSignal, now), {
    status: 422,
    error: { code: "pattern_not_approved", field: "patternId" },
  });
});

test("same ID with different body conflicts", async () => {
  assert.equal((await post({ ...sample, quantity: "1" })).status, 409);
  assert.equal(seen.size, 1);
});
test("duplicate receipt reflects the stored result instead of claiming pending", async () => {
  const prior = seen.get(sample.sourceSignalId);
  const oldEnqueue = store.enqueue;
  store.enqueue = async (body) =>
    body.sourceSignalId === sample.sourceSignalId
      ? { kind: "duplicate", status: "closed" }
      : oldEnqueue(body);
  try {
    const response = await post(prior);
    assert.equal(response.status, 202);
    assert.equal((await response.json()).signal.status, "closed");
  } finally {
    store.enqueue = oldEnqueue;
  }
});

test("wrong token cannot enqueue or view status", async () => {
  assert.equal((await post(sample, "bad")).status, 401);
  assert.equal((await fetch(url("/api/trading/status"))).status, 401);
});

test("unsupported runner fields, experimental pattern and expired event reject", async () => {
  const oldRunner = structuredClone(sample);
  oldRunner.sourceSignalId = "cab-signal-888";
  oldRunner.payload.exitRules.runner.corePct = 80;
  delete oldRunner.payload.exitRules.runner.coreFraction;
  assert.equal((await post(oldRunner)).status, 422);
  assert.equal(
    (await post({ ...sample, patternId: "whale_watch" })).status,
    422,
  );
  assert.equal(
    (await post({ ...sample, signalAt: new Date(now - 11 * 60_000).toISOString() })).status,
    422,
  );
});

test("health explicitly identifies PAPER mode", async () => {
  const response = await fetch(url("/healthz"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: "paper" });
  assert.throws(
    () => createServer({ store, token: "test-token", mode: "live" }),
    /PAPER_ONLY_SIGNAL/,
  );
});