import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aggregateDailyProfitability,
  DAILY_STATS_INCLUDED_STATUSES,
  getDubaiCalendarDay,
  parseDailyStatsBasis,
  type DailyStatsSourceRow,
} from "../src/lib/daily-profitability.js";

function row(
  overrides: Partial<DailyStatsSourceRow> = {},
): DailyStatsSourceRow {
  return {
    status: "profit",
    sentimentKey: "balanced_grind",
    pnlPercent: 10,
    entryPrice: 100,
    peakPrice: 115,
    entryBtc24h: 2,
    closeBtc24h: -1,
    detectedAt: "2026-08-27T20:30:00.000Z",
    closedAt: "2026-08-28T21:00:00.000Z",
    ...overrides,
  };
}

describe("daily profitability archive", () => {
  test("uses Asia/Dubai days and separates entry from close mode", () => {
    const rows = [row()];
    const entryResult = aggregateDailyProfitability(rows, "entry")[0]!;
    const closeResult = aggregateDailyProfitability(rows, "close")[0]!;
    assert.equal(entryResult.day, "2026-08-28");
    assert.equal(entryResult.btc24hMedian, 2);
    assert.equal(closeResult.day, "2026-08-29");
    assert.equal(closeResult.btc24hMedian, -1);
  });

  test("uses the same Dubai calendar projection at protected month boundaries", () => {
    assert.equal(getDubaiCalendarDay("2026-03-31T20:00:00.000Z"), "2026-04-01");
    assert.equal(getDubaiCalendarDay("2026-04-30T19:59:59.999Z"), "2026-04-30");
    assert.equal(getDubaiCalendarDay("2026-04-30T20:00:00.000Z"), "2026-05-01");
  });

  test("retains BE STOP counts while excluding BE outcomes from PnL averages", () => {
    const result = aggregateDailyProfitability(
      [
        row({ pnlPercent: 7, entryBtc24h: -1 }),
        row({
          status: "bu_stop",
          pnlPercent: 12,
          sentimentKey: "stealth_breakout",
          entryBtc24h: 3,
        }),
        row({
          status: "stop_loss",
          pnlPercent: -10,
          entryBtc24h: 1,
        }),
      ],
      "entry",
    )[0]!;

    assert.equal(result.total, 3);
    assert.equal(result.buStop, 1);
    assert.equal(result.netPnlPercent, -3);
    assert.equal(result.avgPnl, -1.5);
    assert.equal(result.winRate, 67);
    assert.equal(result.btc24hMedian, 1);
    assert.equal(result.btc24hMin, -1);
    assert.equal(result.btc24hMax, 3);
    assert.deepEqual(
      result.byPattern.map((pattern) => pattern.sentimentKey),
      [
        "liquidation_cascade",
        "stealth_breakout",
        "neon_support_bounce",
        "impulse_buy",
        "balanced_grind",
      ],
    );
    assert.equal(
      result.byPattern.find(
        (pattern) => pattern.sentimentKey === "balanced_grind",
      )?.total,
      2,
    );
    assert.equal(
      result.byPattern.find(
        (pattern) => pattern.sentimentKey === "neon_support_bounce",
      )?.total,
      0,
    );
    assert.equal(
      result.byPattern.find(
        (pattern) => pattern.sentimentKey === "stealth_breakout",
      )?.total,
      1,
    );
  });

  test("keeps missing BTC unknown and skips rows without a close date in close mode", () => {
    const entryResult = aggregateDailyProfitability(
      [row({ entryBtc24h: null, closedAt: null })],
      "entry",
    )[0]!;
    assert.equal(entryResult.btc24hMedian, null);
    assert.equal(entryResult.btc24hSamples, 0);
    assert.deepEqual(
      aggregateDailyProfitability(
        [row({ entryBtc24h: null, closedAt: null })],
        "close",
      ),
      [],
    );
  });

  test("merges every historical Stealth provenance into one parent row", () => {
    const result = aggregateDailyProfitability(
      [
        row({
          sentimentKey: "stealth_breakout",
          stealthDetectionMethod: "abneon_support_bounce",
        }),
        row({
          sentimentKey: "stealth_breakout",
          stealthDetectionMethod: null,
        }),
      ],
      "entry",
    )[0]!;

    assert.equal(
      result.byPattern.find(
        (pattern) => pattern.sentimentKey === "stealth_breakout",
      )?.total,
      2,
    );
  });

  test("does not substitute entry BTC when a close snapshot is missing", () => {
    const result = aggregateDailyProfitability(
      [row({ entryBtc24h: 4.2, closeBtc24h: null })],
      "close",
    )[0]!;

    assert.equal(result.btc24hMedian, null);
    assert.equal(result.btc24hMin, null);
    assert.equal(result.btc24hMax, null);
    assert.equal(result.btc24hSamples, 0);
  });

  test("excludes reclassified and other non-outcome statuses", () => {
    assert.equal(
      DAILY_STATS_INCLUDED_STATUSES.includes("reclassified" as never),
      false,
    );
    assert.deepEqual(
      aggregateDailyProfitability(
        [row({ status: "reclassified" }), row({ status: "active" })],
        "entry",
      ),
      [],
    );
  });

  test("excludes only legacy Impulse Buy stop losses from statistics", () => {
    const result = aggregateDailyProfitability(
      [
        row({
          sentimentKey: "impulse_buy",
          status: "stop_loss",
          pnlPercent: -10,
          detectedAt: "2026-09-11T14:50:30.999Z",
        }),
        row({
          sentimentKey: "impulse_buy",
          status: "stop_loss",
          pnlPercent: -10,
          detectedAt: "2026-09-11T14:50:31.000Z",
        }),
        row({
          sentimentKey: "balanced_grind",
          status: "stop_loss",
          pnlPercent: -10,
          detectedAt: "2026-09-10T12:00:00.000Z",
        }),
      ],
      "entry",
    );

    assert.equal(result.length, 2);
    assert.equal(
      result.reduce((sum, day) => sum + day.stopLoss, 0),
      2,
    );
    assert.equal(
      result
        .flatMap((day) => day.byPattern)
        .filter((pattern) => pattern.sentimentKey === "impulse_buy")
        .reduce((sum, pattern) => sum + pattern.stopLoss, 0),
      1,
    );
  });

  test("defaults invalid basis values to entry", () => {
    assert.equal(parseDailyStatsBasis("close"), "close");
    assert.equal(parseDailyStatsBasis("entry"), "entry");
    assert.equal(parseDailyStatsBasis("other"), "entry");
  });
});
