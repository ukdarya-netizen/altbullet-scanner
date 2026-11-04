import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateFreshHighBreakout,
  resolveFreshHighProtectionLevel,
  scanFreshHighHour,
  type FreshHighCandle,
} from "../src/lib/stealth-fresh-high.js";

const H = 60 * 60_000;
const T0 = Date.UTC(2026, 9, 1);

/** 72h base 100..120 (height 20%), last 24h quiet under 110, then a breakout. */
function series(lastClose: number, opts: { freshBreak?: boolean } = {}) {
  const cs: FreshHighCandle[] = [];
  for (let i = 0; i < 100; i++) {
    let lo = 100, hi = 101, close = 100.5;
    if (i === 30) { hi = 120; close = 105; } // old spike inside the 72h base
    if (i >= 75) { lo = 103; hi = 106; close = 104; } // last 24h before the candle
    if (opts.freshBreak === false && i === 90) { hi = 107; close = 106.9; } // earlier new-24H-high close
    cs.push({ time: T0 + i * H, open: close, high: hi, low: lo, close });
  }
  cs.push({ time: T0 + 100 * H, open: 106, high: lastClose + 0.5, low: 105.5, close: lastClose });
  return cs;
}

test("passes a fresh 24H-high close with a wide base and +24h move", () => {
  const d = evaluateFreshHighBreakout(series(110));
  assert.equal(d.reason, "stealth_fh_pass");
  assert.equal(d.prevHigh24, 106);
  assert.ok(Math.abs(d.stopPrice! - 104.94) < 1e-9);
  assert.ok(d.baseHeightPct! >= 16);
  assert.ok(d.ret24hPct! >= 4.36);
});

test("rejects with the first failing rule", () => {
  assert.equal(evaluateFreshHighBreakout(series(105.9)).reason, "stealth_fh_no_new_24h_high");
  assert.equal(
    evaluateFreshHighBreakout(series(110, { freshBreak: false })).reason,
    "stealth_fh_not_fresh",
  );
  const lowRet = series(106.5);
  lowRet[lowRet.length - 25]!.close = 104; // ret24h ~ +2.4%
  assert.equal(evaluateFreshHighBreakout(lowRet).reason, "stealth_fh_ret24h_below_4_36pct");
  const narrow = series(110).map((c, i) => (i === 30 ? { ...c, high: 101 } : c));
  assert.equal(evaluateFreshHighBreakout(narrow).reason, "stealth_fh_base72_below_16pct");
  assert.equal(evaluateFreshHighBreakout(series(110).slice(-50)).reason, "stealth_fh_short_history");
});

test("R protection: none below +1R, then max(entry, peak - 1R)", () => {
  const base = { entryPrice: 100, initialStopPrice: 97 };
  assert.equal(resolveFreshHighProtectionLevel({ ...base, peakPrice: 102.9 }), null);
  assert.equal(resolveFreshHighProtectionLevel({ ...base, peakPrice: 103 }), 100);
  assert.equal(resolveFreshHighProtectionLevel({ ...base, peakPrice: 108 }), 105);
});

test("hourly scan skips listings younger than 800h and counts reasons", async () => {
  const hourStart = T0 + 100 * H;
  const toK = (c: FreshHighCandle) => ({
    time: c.time, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: "1",
  });
  const res = await scanFreshHighHour(hourStart, {
    listSymbols: async () => ["OLD-USDT", "NEW-USDT", "FLAT-USDT"],
    loadCandles: async (s) => (s === "FLAT-USDT" ? series(105) : series(110)).map(toK),
    hasCandleAtOrBefore: async (s) => s !== "NEW-USDT",
    now: () => hourStart + H + 60_000,
  });
  assert.deepEqual(res.events.map((e) => e.symbol), ["OLD-USDT"]);
  assert.equal(res.stats.stealth_fh_listing_younger_than_800h, 1);
  assert.equal(res.stats.stealth_fh_no_new_24h_high, 1);
});
