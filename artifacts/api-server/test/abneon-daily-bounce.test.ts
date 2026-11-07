import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAbneonDailyBounce } from "../src/lib/abneon-daily-bounce.js";
import { liveSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import type { NlCandle } from "../src/lib/stealth-neon-level-breakout.js";

const H4 = 4 * 3_600_000, D1 = 24 * 3_600_000;
const T0 = Date.UTC(2026, 6, 1);
/** 4H bars swinging between ~100 and ~120 (pivot lows near 100), then `tail` bars appended. */
function history(tail: Array<[number, number, number, number]>): NlCandle[] {
  const out: NlCandle[] = [];
  let t = T0;
  for (let i = 0; i < 540; i++) {
    const mid = 110 + 10 * Math.sin((i / 30) * Math.PI);
    out.push({ time: t, open: mid - 0.5, high: mid + 1, low: mid - 1, close: mid + 0.5, volume: 1000 });
    t += H4;
  }
  // align to a UTC day start
  while (t % D1 !== 0) { out.push({ time: t, open: 115, high: 116, low: 114, close: 115, volume: 1000 }); t += H4; }
  for (const [o, h, l, c] of tail) { out.push({ time: t, open: o, high: h, low: l, close: c, volume: 1000 }); t += H4; }
  return out;
}
const dayOf = (open: number, low: number, close: number): Array<[number, number, number, number]> => [
  [open, open + 0.5, open - 1, open - 1],
  [open - 1, open - 0.5, low + 1, low + 1],
  [low + 1, low + 1.5, low, low + 0.5],
  [low + 0.5, close - 1, low + 0.3, close - 1],
  [close - 1, close, close - 1.5, close - 0.5],
  [close - 0.5, close + 0.3, close - 1, close],
];

test("1D bounce: the day dips into a Neon support and closes bullish back above it → event on that zone", () => {
  const base = history([]);
  const zones = liveSupportZones(base).sort((a, b) => a.bottom - b.bottom);
  const zone = zones.find((x) => x.top < 112);
  assert.ok(zone, `a support zone exists: ${JSON.stringify(zones)}`);
  const open = zone.top * 1.05;
  const h4 = history(dayOf(open, zone.top * 0.999, open * 1.01));
  const last = h4.at(-1)!;
  const ev = evaluateAbneonDailyBounce(h4, last.time);
  assert.ok(ev, "event");
  assert.equal(ev.tf, "1d");
  assert.equal(ev.dayTime, last.time - 5 * H4);
  assert.ok(ev.low <= ev.zone.top * 1.01 && ev.close >= ev.zone.bottom * 0.99);
});

test("1D bounce: a bearish day, a day that never reaches the zone, and a 4H candle that does not close the day → nothing", () => {
  const base = history([]);
  const zone = liveSupportZones(base).sort((a, b) => a.bottom - b.bottom).find((x) => x.top < 112)!;
  const open = zone.top * 1.05;
  const bearish = history(dayOf(open, zone.top * 0.999, open * 0.99));
  assert.equal(evaluateAbneonDailyBounce(bearish, bearish.at(-1)!.time), null);
  const noTouch = history(dayOf(open, zone.top * 1.03, open * 1.01));
  assert.equal(evaluateAbneonDailyBounce(noTouch, noTouch.at(-1)!.time), null);
  const ok = history(dayOf(open, zone.top * 0.999, open * 1.01));
  assert.equal(evaluateAbneonDailyBounce(ok.slice(0, -1), ok.at(-2)!.time), null);
});
