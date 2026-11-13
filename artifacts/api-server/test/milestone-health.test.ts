import test from "node:test";
import assert from "node:assert/strict";
import { futuresCvdFromTakers, mergeWithLastGoodHealth } from "../src/lib/milestone-health.js";
import { fmtHealthLine, type SpotHealth } from "../src/lib/watcher-formatters.js";

const good: SpotHealth = { oiPct: 1.2, cvd15m: true, cvd30m: false, cvd1h: true, cvdSource: "spot" };

test("delta line: a CoinGlass failure shows the last good reading (≤ 60 min) with its age", () => {
  const store = new Map<string, { health: SpotHealth; at: number }>();
  const t0 = Date.parse("2026-11-13T04:00:00Z");
  assert.deepEqual(mergeWithLastGoodHealth("BARD-USDT", good, t0, store), good);
  const failed = mergeWithLastGoodHealth("BARD-USDT", null, t0 + 12 * 60_000, store)!;
  assert.equal(failed.oiPct, 1.2);
  assert.equal(failed.cvd1h, true);
  assert.equal(failed.staleMin, 12);
  assert.equal(fmtHealthLine(failed, true), "📈 OI: +1.2% | CVD15 ↑ | CVD30 ↓ | CVD1h ↑ (данные 12 мин назад)");
  // OI failed, CVD fresh: fresh CVD, old OI
  const part = mergeWithLastGoodHealth("BARD-USDT", { oiPct: null, cvd15m: false, cvd30m: false, cvd1h: false, cvdSource: "spot" }, t0 + 5 * 60_000, store)!;
  assert.equal(part.cvd15m, false);
  assert.equal(part.oiPct, 1.2);
  // older than an hour: nothing invented
  assert.equal(mergeWithLastGoodHealth("BARD-USDT", null, t0 + 61 * 60_000, store), null);
  assert.equal(fmtHealthLine(null, true), "📈 OI: н/д | CVD15 н/д | CVD30 н/д | CVD1h н/д");
});

test("delta from futures takers when the coin has no spot CVD: 15m = last closed bar, 30m = last two, 1h = last four", () => {
  const rows = [{ buy: 5, sell: 1 }, { buy: 5, sell: 1 }, { buy: 1, sell: 3 }, { buy: 2, sell: 1 }];
  assert.deepEqual(futuresCvdFromTakers(rows), { cvd15m: false, cvd30m: false, cvd1h: true });
  assert.equal(futuresCvdFromTakers([{ buy: 1, sell: 0 }]), null);
  assert.equal(fmtHealthLine({ oiPct: -0.4, cvd15m: true, cvd30m: true, cvd1h: false, cvdSource: "futures" }, true),
    "📈 OI: -0.4% | CVD15 ↑ | CVD30 ↑ | CVD1h ↓ (CVD по фьючам)");
});
