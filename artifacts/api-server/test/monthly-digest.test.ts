import assert from "node:assert/strict";
import test from "node:test";
import type { TrackedSignal } from "@workspace/db";
import {
  formatMonthlyDigest,
  formatWeeklyDigest,
  getPreviousDubaiMonthRange,
} from "../src/lib/positionsReport.js";

function row(
  symbol: string,
  status: TrackedSignal["status"],
  pnlPercent: number,
  lastMilestone: number | null = null,
  sentimentKey: string = "balanced_grind",
): TrackedSignal {
  return {
    symbol,
    status,
    pnlPercent,
    lastMilestone,
    sentimentKey,
    entryPrice: 100,
  } as TrackedSignal;
}

const rows = [
  row("A-USDT", "profit", 20),
  row("B-USDT", "profit", 12),
  row("C-USDT", "profit", 9),
  row("D-USDT", "profit", 6),
  row("BE5-USDT", "bu_stop", 0, 5),
  row("BE8-USDT", "bu_stop", 0, 8),
  row("BE15-USDT", "bu_stop", 0, 15),
  row("S1-USDT", "stop_loss", -10),
  row("S2-USDT", "stop_loss", -8),
  row("E-USDT", "expired", 2.5),
  row("X-USDT", "cancelled", 100),
];

test("monthly report: top 3, counts with PnL, total; no per-position list", () => {
  const report = formatMonthlyDigest(rows, new Date("2026-08-31T20:00:00Z"));
  assert.match(report, /Месячный отчёт/);
  assert.match(report, /август 2026|сентябрь 2026/);
  assert.match(report, /🥇 A \[.*\] \+20\.0%/);
  assert.match(report, /🥉 C /);
  assert.doesNotMatch(report, /\bD\b \[|BE5|S1|S2|X-USDT/);
  assert.match(report, /Профит: 4 \| PnL: \+47\.0%/);
  assert.match(report, /Стоп-лосс: 2 \| PnL: -18\.0%/);
  assert.match(report, /BE: 3 \| PnL: \+0\.0%/);
  assert.match(report, /после \+5%: 1/);
  assert.match(report, /после \+8%: 1/);
  assert.match(report, /после \+10%: 1/);
  assert.match(report, /Expired: 1 \| PnL: \+2\.5%/);
  assert.match(report, /Общий PnL: \+31\.5%/);
  assert.doesNotMatch(report, /<\/?[a-z][^>]*>/i);
});

test("weekly report uses the same format", () => {
  const now = new Date("2026-10-04T06:00:00Z");
  const report = formatWeeklyDigest(
    rows,
    new Date("2026-09-27T06:00:00Z"),
    now,
  );
  assert.match(report, /Недельный отчёт/);
  assert.match(report, /Общий PnL: \+31\.5%/);
});

test("monthly period is the previous full Dubai month", () => {
  const { start, end } = getPreviousDubaiMonthRange(
    new Date("2026-10-01T07:00:00Z"),
  );
  assert.equal(start.toISOString(), "2026-08-31T20:00:00.000Z");
  assert.equal(end.toISOString(), "2026-09-30T20:00:00.000Z");
});

test("Neon Support label has no experiment marker", () => {
  const report = formatMonthlyDigest(
    [row("NEON-USDT", "profit", 8, null, "neon_support_bounce")],
    new Date("2026-08-31T20:00:00Z"),
  );
  assert.match(report, /\[🩷 Neon Support — Отскок от поддержки\]/);
  assert.doesNotMatch(report, /эксперимент/gi);
});
