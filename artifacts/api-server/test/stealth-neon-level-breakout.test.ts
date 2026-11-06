import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dailyFrom4h,
  evaluateNeonLevelBreakout,
  H4_MS,
  mergeCandles,
  NEON_LEVEL_1D_METHOD,
  NEON_LEVEL_4H_METHOD,
  type NlCandle,
} from "../src/lib/stealth-neon-level-breakout.js";

// 4H series swinging between ~90 and ~110 (pivot highs cluster at 110 = resistance), then a breakout.
function series(n: number, t0: number): NlCandle[] {
  const out: NlCandle[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 100 + 10 * Math.sin((i / 26) * 2 * Math.PI);
    out.push({ time: t0 + i * H4_MS, open: mid - 0.5, high: mid + 1, low: mid - 1, close: mid + 0.2, volume: 1 });
  }
  return out;
}
const T0 = Date.UTC(2026, 6, 1, 0, 0);

test("closed 4H candle above a Neon resistance zone is a 4H breakout; both zone edges kept", () => {
  const h4 = series(400, T0);
  const last = h4.at(-1)!;
  const prevClose = 105;
  h4[h4.length - 2] = { ...h4.at(-2)!, close: prevClose };
  // 4H bar that is not the day close (00:00–04:00 UTC bars close at 04:00).
  const start = Math.floor(last.time / (24 * 3_600_000)) * 24 * 3_600_000 + 4 * 3_600_000;
  const shifted = h4.map((c, i) => ({ ...c, time: start - (h4.length - 1 - i) * H4_MS }));
  shifted[shifted.length - 1] = { ...shifted.at(-1)!, open: 105, high: 125, low: 104, close: 124 };
  const ev = evaluateNeonLevelBreakout(shifted, start);
  assert.ok(ev, "breakout expected");
  assert.equal(ev.tf, "4h");
  assert.equal(ev.method, NEON_LEVEL_4H_METHOD);
  assert.ok(ev.level.top < 124 && ev.level.top >= 105);
  assert.ok(ev.level.bottom < ev.level.top);
  assert.ok(ev.zones.length >= 2 && ev.zones.every((z) => z.bottom < z.top));
  assert.ok(Math.abs(ev.stopPrice - 124 * 0.92) < 1e-9);
});

test("no breakout when the close stays below every zone top or the previous close was already above", () => {
  const h4 = series(400, T0);
  const start = h4.at(-1)!.time;
  assert.equal(evaluateNeonLevelBreakout(h4, start), null);
  const above = h4.map((c) => ({ ...c }));
  above[above.length - 2] = { ...above.at(-2)!, close: 130 };
  above[above.length - 1] = { ...above.at(-1)!, close: 131, high: 132 };
  assert.equal(evaluateNeonLevelBreakout(above, start), null);
});

test("the 20:00 UTC 4H bar closes the day: a daily close above a zone is a 1D breakout", () => {
  const dayEndStart = Date.UTC(2026, 9, 20, 20, 0);
  const h4 = series(420, 0).map((c, i, a) => ({ ...c, time: dayEndStart - (a.length - 1 - i) * H4_MS }));
  // previous day closes low, this day closes high
  for (let k = 1; k <= 12; k++) h4[h4.length - k] = { ...h4[h4.length - k]!, close: 100, high: 101, low: 99, open: 100 };
  h4[h4.length - 1] = { ...h4.at(-1)!, open: 100, high: 126, close: 125 };
  const days = dailyFrom4h(h4);
  assert.equal(days.at(-1)!.time, Date.UTC(2026, 9, 20));
  assert.equal(days.at(-1)!.close, 125);
  const ev = evaluateNeonLevelBreakout(h4, dayEndStart);
  assert.ok(ev);
  assert.equal(ev.tf, "1d");
  assert.equal(ev.method, NEON_LEVEL_1D_METHOD);
  assert.equal(ev.candleTime, Date.UTC(2026, 9, 20));
});

test("candle cache merge keeps one bar per time, sorted, newest wins, capped", () => {
  const a = series(5, T0);
  const b = [{ ...a[4]!, close: 999 }, { ...a[4]!, time: a[4]!.time + H4_MS }];
  const m = mergeCandles(a, b, 4);
  assert.equal(m.length, 4);
  assert.equal(m.at(-1)!.time, a[4]!.time + H4_MS);
  assert.equal(m.at(-2)!.close, 999);
});
