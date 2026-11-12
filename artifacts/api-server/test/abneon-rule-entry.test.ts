import test from "node:test";
import assert from "node:assert/strict";
import { abneonTake, entryReadings, resistancesAbove, ruleEntryOnArm } from "../src/lib/abneon-rule-entry.js";

const H1 = 3_600_000, H4 = 4 * H1;
const T0 = Date.UTC(2026, 10, 10, 0); // arm 4H candle open
const zone = { bottom: 95, top: 100 };
const bar = (i: number, o: number, h: number, l: number, c: number) => ({ time: T0 + i * H1, open: o, high: h, low: l, close: c });
const ok = async () => ({ ok: true as const, colours: ["A"], firstTouchTime: T0 });

test("R8: the first green 1H close back in the zone within 8 h of the test low is the entry, however far above the zone", async () => {
  const c1 = [bar(0, 104, 105, 103, 103.5), bar(1, 103.5, 104, 99, 99.5), bar(2, 99.5, 100, 96, 96.5), bar(3, 96.5, 97, 96, 96.2), bar(4, 96.2, 104, 96.1, 103.8)];
  const r = await ruleEntryOnArm({ candles1h: c1, candles4h: [], zone, armTime: T0, nowMs: T0 + 5 * H1, lucy: ok });
  assert.equal(r.status, "entry");
  if (r.status === "entry") { assert.equal(r.candleTime, T0 + 4 * H1); assert.equal(r.entry, 103.8); assert.equal(r.testTime, T0 + H1); }
});

test("R8: a reaction more than 8 h after the test low is not taken; a 4H close under the zone voids", async () => {
  const c1 = [bar(0, 100, 100, 96, 96.5), ...Array.from({ length: 9 }, (_, k) => bar(k + 1, 97, 97.5, 96.6, 96.9)), bar(10, 96.9, 99, 96.8, 98.5)];
  const late = await ruleEntryOnArm({ candles1h: c1, candles4h: [], zone, armTime: T0, nowMs: T0 + 11 * H1, lucy: ok });
  // Green closes at k=... are all red (96.9 < 97 open) except the last, 10 h after the low of bar 0 — but bar 0's low is
  // the lowest, so the last green is 11 - 1 = 10 h after it: no entry yet, waiting.
  assert.equal(late.status, "waiting");
  const c4 = [{ time: T0, open: 100, high: 100, low: 90, close: 94 }];
  const voided = await ruleEntryOnArm({ candles1h: c1, candles4h: c4, zone, armTime: T0, nowMs: T0 + 11 * H1, lucy: ok });
  assert.deepEqual(voided, { status: "void", reason: "closed_4h_under_zone" });
});

test("R8: a grey touch voids; an open touch 4H candle waits", async () => {
  const c1 = [bar(0, 100, 100, 96, 96.5), bar(1, 96.5, 99, 96.4, 98.8)];
  const grey = await ruleEntryOnArm({ candles1h: c1, candles4h: [], zone, armTime: T0, nowMs: T0 + 2 * H1, lucy: async () => ({ ok: false, reason: "touch_volume_grey", colours: ["N", "N"] }) });
  assert.deepEqual(grey, { status: "void", reason: "touch_volume_grey_NN", colours: ["N", "N"] });
  const open = await ruleEntryOnArm({ candles1h: c1, candles4h: [], zone, armTime: T0, nowMs: T0 + 2 * H1, lucy: async () => ({ ok: false, reason: "touch_bar_not_closed", colours: [] }) });
  assert.deepEqual(open, { status: "waiting", reason: "awaiting_touch_4h_close" });
});

test("R8: 48 h after the arm without an entry the setup is void", async () => {
  const r = await ruleEntryOnArm({ candles1h: [bar(0, 110, 111, 109, 110)], candles4h: [], zone, armTime: T0, nowMs: T0 + 49 * H1, lucy: ok });
  assert.deepEqual(r, { status: "void", reason: "arm_window_over" });
});

test("exit B: the take is the nearest zone bottom above the entry; none above → null", () => {
  const res = resistancesAbove([{ bottom: 120, top: 125 }, { bottom: 108, top: 110 }, { bottom: 80, top: 85 }], 100);
  assert.deepEqual(res, [108, 120]);
  assert.deepEqual(abneonTake(105, res), { price: 108, pct: 2.86 });
  assert.deepEqual(abneonTake(110, res), { price: 120, pct: 9.09 });
  assert.equal(abneonTake(121, res), null);
});

test("readings: taker delta windows and OI changes", () => {
  const tk = [{ time: T0 - H1, buy: 3, sell: 1 }, { time: T0, buy: 1, sell: 1 }, { time: T0 + H1, buy: 1, sell: 3 }];
  const oi = [{ time: T0 - 72 * H1, close: 100 }, { time: T0 - 24 * H1, close: 110 }, { time: T0 - 4 * H1, close: 120 }, { time: T0 + H1, close: 132 }];
  const r = entryReadings({ firstTouchTime: T0, triggerCandleTime: T0 + H1, entryAt: T0 + 2 * H1, futTakers: tk, spotTakers: null, oi });
  assert.equal(r.fut_tk_pre12_delta, 0.5);
  assert.equal(r.fut_tk_trig_delta, -0.5);
  assert.equal(r.spot_tk_win_delta, null);
  assert.equal(r.oi_chg72h, 32);
  assert.equal(r.oi_chg4h, 10);
});
