import assert from "node:assert/strict";
import { test } from "node:test";
import { closesAboveMiddle, lucyColour, touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { neonBreakoutColour } from "../src/lib/stealth-neon-level-breakout.js";

const H1 = 3_600_000, H4 = 4 * H1;

test("Lucy's VSA (owner 2026-11-15): the colour is on USD volume, as the TradingView indicator", () => {
  // 20 calm bars and a bar with the same coins but at a 3x price: in USD it is bright, in coins it was not.
  const usd = [...Array.from({ length: 140 }, (_, i) => 100 + (i % 5)), 600];
  assert.equal(lucyColour(usd, usd.length - 1), "W");
});

test("ABNeon touch (owner 2026-11-15): not grey is not enough — the bar must show buying (close above its middle)", () => {
  const n = 130, t0 = 0;
  const c4 = Array.from({ length: n }, (_, i) => ({ time: t0 + i * H4, open: 10, high: 10.2, low: 9.8, close: 10 }));
  const touch = n - 3;
  const c1 = Array.from({ length: 12 }, (_, k) => ({ time: c4[touch]!.time + k * H1, low: k === 0 ? 9.0 : 10, close: 10 }));
  const fut = new Map(c4.map((c, i) => [c.time, i >= touch ? 1000 : 100 + (i % 3)] as [number, number]));
  const base = { candles1h: c1, agg4hUsdByTime: fut, spot4hUsdByTime: null, armCandleTime: c4[touch]!.time - H1, triggerCandleTime: c1[3]!.time, zoneTop: 9.5, nowMs: c4[n - 1]!.time + H4 };
  // Bright volume but every bar closes in its lower half (selling): rejected.
  const selling = c4.map((c, i) => (i >= touch ? { ...c, close: 9.85 } : c));
  const r1 = touchVolumeNotGrey({ ...base, candles4h: selling });
  assert.equal(r1.ok, false);
  assert.equal(!r1.ok && r1.reason, "touch_volume_no_buying");
  // The same with one bar closing in its upper half: buying, accepted.
  const buying = selling.map((c, i) => (i === touch + 1 ? { ...c, close: 10.15 } : c));
  assert.equal(touchVolumeNotGrey({ ...base, candles4h: buying }).ok, true);
  assert.equal(closesAboveMiddle({ high: 2, low: 1, close: 1.5 }), false);
});

test("Stealth breakout colour (owner 2026-11-15): futures + spot, grey under the 120-bar average", () => {
  const n = 130;
  const h4 = Array.from({ length: n }, (_, i) => ({ time: i * H4, open: 1, high: 1.1, low: 0.9, close: 1 }));
  const fut = new Map(h4.map((c, i) => [c.time, i === n - 1 ? 400 : 100] as [number, number]));
  const spot = new Map(h4.map((c, i) => [c.time, i === n - 1 ? 2000 : 10] as [number, number]));
  assert.equal(neonBreakoutColour(h4 as never, fut, spot), "W");
  assert.equal(neonBreakoutColour(h4.slice(-60) as never, fut, spot), null);   // under 120 bars: no colour
});
