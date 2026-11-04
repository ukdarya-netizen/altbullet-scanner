import assert from "node:assert/strict";
import test from "node:test";
import { buildEntryVolumeContext } from "../src/lib/entry-volume-context.js";

const H = 60 * 60 * 1000;

function series(n: number, last: number) {
  const now = 100 * H;
  const rows = Array.from({ length: n }, (_, i) => ({
    time: now - (n - i) * H,
    close: 2,
    volume: i === n - 1 ? last : 10,
  }));
  return { now, rows };
}

test("ratio uses the last closed bar against the prior 20 closed bars", () => {
  const { now, rows } = series(30, 70);
  const ctx = buildEntryVolumeContext({
    candles1h: rows,
    candles30m: null,
    now,
  });
  assert.equal(ctx.tf1h.available, true);
  assert.equal(ctx.tf1h.bars[0]!.ratio, 7);
  assert.equal(ctx.tf1h.bars[0]!.turnoverUsd, 140);
  assert.equal(ctx.tf30m.reason, "no_candles");
});

test("the still-forming bar is excluded and short history is flagged", () => {
  const { now, rows } = series(30, 70);
  rows.push({ time: now - 1000, close: 2, volume: 999 });
  const ctx = buildEntryVolumeContext({
    candles1h: rows,
    candles30m: null,
    now,
  });
  assert.equal(ctx.tf1h.bars[0]!.ratio, 7);
  const short = series(10, 5);
  const c2 = buildEntryVolumeContext({
    candles1h: short.rows,
    candles30m: null,
    now: short.now,
  });
  assert.equal(c2.tf1h.reason, "insufficient_history");
});
