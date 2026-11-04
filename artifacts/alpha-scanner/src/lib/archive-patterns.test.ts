import assert from "node:assert/strict";
import test from "node:test";
import { ensureActiveArchivePatternRows } from "./archive-patterns";

const row = (sentimentKey: string, total: number) => ({
  sentimentKey,
  total,
  profit: 0,
  breakeven: 0,
  expired: 0,
  buStop: 0,
  stopLoss: 0,
  cancelled: 0,
  netPnlPercent: 0,
  winRate: null,
  avgPnl: null,
  avgPeak: null,
  bestDeal: null,
  lastSignalAt: null,
});

test("adds all active archive baselines in registry order", () => {
  const rows = ensureActiveArchivePatternRows([row("liquidation_cascade", 2)]);

  assert.deepEqual(
    rows.slice(0, 4).map((item) => [item.sentimentKey, item.total]),
    [
      ["liquidation_cascade", 2],
      ["stealth_breakout", 0],
      ["neon_support_bounce", 0],
      ["impulse_buy", 0],
    ],
  );
  assert.equal(
    rows.filter((item) => item.sentimentKey === "stealth_breakout").length,
    1,
  );
});

test("does not synthesize retired pattern rows", () => {
  const rows = ensureActiveArchivePatternRows([row("demark", 1)]);
  assert.equal(rows.find((item) => item.sentimentKey === "demark")?.total, 1);
  assert.equal(rows.filter((item) => item.sentimentKey === "demark").length, 1);
});
