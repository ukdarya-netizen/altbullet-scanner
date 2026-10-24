import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createWorker } from "../worker.mjs";

const sample = JSON.parse(
  await readFile(
    new URL("./fixtures/impulse-buy-sample.json", import.meta.url),
    "utf8",
  ),
);
function harness(signal = sample) {
  let now = Date.parse(signal.signalAt) + 30_000;
  let price = Number(signal.referencePrice);
  const rows = new Map();
  const positions = new Map();
  const events = [];
  let freeUsdt = 100;
  let reservedUsdt = 0;
  let totalRealized = 0;
  const store = {
    withLeaderLock: async (cb) => cb(),
    getPending: async () =>
      [...rows.values()].find((row) => ["pending", "opening"].includes(row.status)) ?? null,
    setSignalStatus: async (id, status, reason) => {
      Object.assign(rows.get(id), { status, reason });
    },
    listOpenPositions: async () =>
      [...positions.values()]
        .filter((snapshot) => snapshot.status === "open")
        .map((snapshot) => ({ sourceSignalId: snapshot.sourceSignalId, snapshot })),
    openPaperPosition: async (position) => {
      if (positions.has(position.sourceSignalId)) return { kind: "duplicate" };
      if (freeUsdt < 10) return { kind: "insufficient" };
      freeUsdt -= 10;
      reservedUsdt += 10;
      positions.set(position.sourceSignalId, position);
      return { kind: "opened" };
    },
    settlePaperPosition: async (prior, next) => {
      const current = positions.get(prior.sourceSignalId);
      if (
        current.marginHeldUsd !== prior.marginHeldUsd ||
        current.realizedPnlUsdt !== prior.realizedPnlUsdt
      ) return { kind: "stale" };
      const released = prior.marginHeldUsd - next.marginHeldUsd;
      const pnl = next.realizedPnlUsdt - prior.realizedPnlUsdt;
      freeUsdt += released + pnl;
      reservedUsdt -= released;
      totalRealized += pnl;
      positions.set(next.sourceSignalId, next);
      return { kind: "settled" };
    },
    recordEvent: async (id, kind, detail) => events.push({ id, kind, detail }),
  };
  rows.set(signal.sourceSignalId, {
    sourceSignalId: signal.sourceSignalId,
    body: structuredClone(signal),
    status: "pending",
  });
  const exchange = {
    validateOrder: async () => true,
    ticker: async () => ({ ask1Price: String(price), lastPrice: String(price) }),
  };
  const worker = createWorker({ store, exchange, clock: () => now });
  return {
    worker,
    rows,
    positions,
    events,
    account: () => ({ freeUsdt, reservedUsdt, totalRealized }),
    setPrice: (next) => { price = next; },
    setNow: (next) => { now = next; },
  };
}
test("paper entry persists and retry cannot create another position", async () => {
  const h = harness();
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.size, 1);
  assert.equal(h.events.filter((e) => e.kind === "paper_entry").length, 1);
  await h.worker.tick();
  assert.equal(h.events.filter((e) => e.kind === "paper_entry").length, 1);
  assert.deepEqual(h.account(), {
    freeUsdt: 90, reservedUsdt: 10, totalRealized: 0,
  });
});
test("first target is a milestone; core stop closes only core, then runner", async () => {
  const h = harness();
  await h.worker.tick();
  const entry = Number(sample.referencePrice);
  h.setPrice(entry * 1.16);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
  assert.ok(h.positions.get(sample.sourceSignalId).stopPrice > entry);
  h.setPrice(entry * 1.05);
  await h.worker.tick();
  const after = h.positions.get(sample.sourceSignalId);
  assert.equal(after.status, "open");
  assert.equal(after.coreOpen, false);
  assert.equal(after.runnerOpen, true);
  assert.ok(after.realizedPnlUsdt > 0);
  assert.equal(h.account().reservedUsdt, 2);
  h.setPrice(entry * 0.99);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "closed");
  assert.equal(h.rows.get(sample.sourceSignalId).status, "closed");
  assert.equal(h.events.filter((e) => e.kind === "paper_close_all").length, 1);
  assert.equal(h.account().reservedUsdt, 0);
  const realized = h.account().totalRealized;
  await h.worker.tick();
  assert.equal(h.account().totalRealized, realized);
});
test("stale queued event cannot open a position", async () => {
  const h = harness();
  h.setNow(Date.parse(sample.signalAt) + 11 * 60_000);
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.positions.size, 0);
});
test("PAPER entry refuses an unfunded notional after price drift", async () => {
  const h = harness();
  h.setPrice(Number(sample.referencePrice) * 1.05);
  await h.worker.tick();
  assert.equal(h.rows.get(sample.sourceSignalId).status, "rejected");
  assert.equal(h.positions.size, 0);
  assert.deepEqual(h.account(), {
    freeUsdt: 100, reservedUsdt: 0, totalRealized: 0,
  });
});
test("Impulse core expires on day four while the runner remains until day five", async () => {
  const h = harness();
  const entry = Number(sample.referencePrice);
  await h.worker.tick();
  h.setPrice(entry * 1.02);
  h.setNow(Date.parse(sample.signalAt) + 4 * 24 * 60 * 60_000 + 60_000);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "open");
  assert.equal(h.positions.get(sample.sourceSignalId).runnerOpen, true);
  assert.equal(h.account().reservedUsdt, 2);
  h.setNow(Date.parse(sample.signalAt) + 5 * 24 * 60 * 60_000 + 60_000);
  await h.worker.tick();
  assert.equal(h.positions.get(sample.sourceSignalId).status, "closed");
  assert.equal(h.account().reservedUsdt, 0);
});
test("live mode fails closed even when an adapter exists", () => {
  const _h = harness();
  assert.throws(
    () => createWorker({ store: {}, exchange: {}, mode: "live" }),
    /PAPER_ONLY_SIGNAL/,
  );
});