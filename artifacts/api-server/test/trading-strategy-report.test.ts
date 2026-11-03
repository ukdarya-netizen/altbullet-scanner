import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, tradePct, type ReportRow } from "../src/lib/trading-strategy-report.js";

const row = (p: Partial<ReportRow>): ReportRow => ({ pattern: "stealth_breakout", symbol: "XUSDT", status: "profit", detectedAt: 0, closedAt: 1, entry: 100, exit: 100, peak: null, ...p });

test("take N counts only when CAB's peak reached it; otherwise CAB's exit", () => {
  const r = row({ exit: 96, peak: 106, status: "stop_loss" });
  assert.equal(tradePct(r, "take5"), 4.9);
  assert.ok(Math.abs(tradePct(r, "take8") - (-4.1)) < 1e-9);
  assert.ok(Math.abs(tradePct(r, "follow_cab") - (-4.1)) < 1e-9);
});

test("report: per exit and per pattern; stops not counted when the take came first; drawdown and halves", () => {
  const rows = [
    row({ detectedAt: 0, closedAt: 10, exit: 110, peak: 112 }),
    row({ detectedAt: 5, closedAt: 20, exit: 95, peak: 106, status: "stop_loss" }),
    row({ pattern: "impulse_buy", detectedAt: 10, closedAt: 30, exit: 90, peak: 101, status: "stop_loss" }),
  ];
  const rep = buildReport(rows, 60);
  assert.equal(rep.trades, 3);
  assert.equal(rep.exits.take5.stopPct, 33.33);  // the second hit +5% before its stop
  assert.equal(rep.exits.follow_cab.stopPct, 66.67);
  assert.equal(rep.byPattern.impulse_buy!.follow_cab.n, 1);
  assert.equal(rep.exits.follow_cab.maxDd, 15.2); // −5.1 then −10.1
  assert.equal(rep.exits.follow_cab.half1.n + rep.exits.follow_cab.half2.n, 3);
});
