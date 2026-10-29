import assert from "node:assert/strict";
import test from "node:test";
import { detectAutoRangePine } from "../src/lib/auto-range-pine.js";
import { evaluateRange4hBreakout, H4_MS } from "../src/lib/stealth-range-4h.js";

function series() {
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cs: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let p = 100;
  const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H4_MS);
  for (let i = 0; i < 400; i++) {
    const o = p;
    p = p * (1 + (i < 150 ? 0.002 : 0) + (r() - 0.5) * 0.01);
    cs.push({ time: T0 + i * H4_MS, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p });
  }
  return cs;
}

test("4H breakout with aggregated volume >= 2x passes; weaker volume, unknown volume or no breakout do not", () => {
  const cs = series();
  const brk = detectAutoRangePine(cs.map((c) => ({ ...c, closed: true })), { mergeDeviations: false }).upsideBreakouts!.at(-1)!;
  const k = (brk.breakoutCloseTime - cs[0]!.time) / H4_MS - 1;
  const sub = cs.slice(0, k + 1);
  const vol = new Map(sub.map((c, i) => [c.time, i === k ? 300 : 100]));
  const ok = evaluateRange4hBreakout(sub, vol);
  assert.equal(ok.reason, "stealth_r4h_pass");
  assert.equal(ok.volRatio, 3);
  assert.ok(Math.abs(ok.stopPrice! - brk.upper * 0.99) < 1e-9);
  vol.set(sub[k]!.time, 150);
  assert.equal(evaluateRange4hBreakout(sub, vol).reason, "stealth_r4h_volume_below_2x");
  assert.equal(evaluateRange4hBreakout(sub, null).reason, "stealth_r4h_volume_unknown");
  assert.equal(evaluateRange4hBreakout(cs.slice(0, k), vol).reason, "stealth_r4h_no_breakout");
});
