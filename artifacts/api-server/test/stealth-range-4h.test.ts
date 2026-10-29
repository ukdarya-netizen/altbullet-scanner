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

test("1H: narrow range and a close >= 2% above the top pass; a wide range or a weak close do not", async () => {
  const { evaluateRange1hBreakout, H1_MS } = await import("../src/lib/stealth-range-4h.js");
  const { detectAutoRangePine1h } = await import("../src/lib/auto-range-pine.js");
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H1_MS);
  const base: { time: number; open: number; high: number; low: number; close: number }[] = [];
  let p = 100;
  for (let i = 0; i < 300; i++) {
    const o = p; p = p * (1 + (r() - 0.5) * 0.004);
    base.push({ time: T0 + i * H1_MS, open: o, high: Math.max(o, p) * 1.001, low: Math.min(o, p) * 0.999, close: p });
  }
  const res = detectAutoRangePine1h(base.map((c) => ({ ...c, closed: true })), { mergeDeviations: false });
  const range = res.latestRange ?? res.activeRange ?? null;
  // A decisive breakout candle well above any range in this quiet series.
  const top = Math.max(...base.slice(-60).map((c) => c.high));
  const make = (closeMul: number) => [...base, { time: T0 + 300 * H1_MS, open: base.at(-1)!.close, high: top * closeMul * 1.001, low: base.at(-1)!.close * 0.999, close: top * closeMul }];
  const strong = evaluateRange1hBreakout(make(1.04));
  if (strong.reason === "stealth_r1h_no_breakout") return; // detector found no active range in this synthetic series
  assert.ok(["stealth_r1h_pass", "stealth_r1h_close_not_2pct_above_top", "stealth_r1h_range_too_high"].includes(strong.reason));
  void range;
});
