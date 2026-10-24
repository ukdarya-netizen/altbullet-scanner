import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateBreakoutQuality,
  evaluateCutoffOutcome,
} from "../src/lib/stealth-verdict-journal.js";

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => ({
  time: i * H,
  open: o,
  high: h,
  low: l,
  close: c,
});
const flat = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));

test("breakout quality passes with dist>=1% and body>=1 ATR", () => {
  const rows = [...flat, bar(20, 100, 106, 100, 105)];
  const q = evaluateBreakoutQuality(rows, 20 * H, 103);
  assert.equal(q.pass, true);
});

test("breakout quality rejects small distance", () => {
  const rows = [...flat, bar(20, 100, 106, 100, 105)];
  const q = evaluateBreakoutQuality(rows, 20 * H, 104.5);
  assert.equal(q.pass, false);
  assert.equal(q.reason, "filter_dist_body");
});

test("breakout quality is unknown when the trigger candle is missing", () => {
  assert.equal(evaluateBreakoutQuality(flat, 99 * H, 100).pass, null);
});

test("cutoff outcome needs a full 24h window", () => {
  const rows = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 99, 100)];
  assert.equal(evaluateCutoffOutcome(rows, 0, 2 * H, 99), null);
  const full = [
    bar(0, 100, 100, 100, 100),
    ...Array.from({ length: 24 }, (_, i) => bar(i + 1, 100, 106, 99, 104)),
  ];
  const o = evaluateCutoffOutcome(full, 0, 1 * H, 99)!;
  assert.equal(o.hit5BeforeLevelLoss, true);
  assert.ok(Math.abs(o.pct24h! - 4) < 1e-9);
});

test("1H replay window can be rolled back by environment variable", async () => {
  const m = await import("../src/lib/auto-range-history.js");
  assert.equal(m.resolveAutoRange1hReplayWindow({}), 2000);
  assert.equal(
    m.resolveAutoRange1hReplayWindow({ AUTO_RANGE_1H_REPLAY_WINDOW: "600" }),
    600,
  );
  assert.equal(
    m.resolveAutoRange1hReplayWindow({ AUTO_RANGE_1H_REPLAY_WINDOW: "abc" }),
    2000,
  );
  assert.equal(m.autoRangeHistoryFetchLimit(600), 901);
  assert.equal(m.autoRangeHistoryFetchLimit(2000), 2200);
});
