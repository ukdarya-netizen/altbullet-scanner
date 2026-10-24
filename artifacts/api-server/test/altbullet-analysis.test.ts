import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateAltBulletAnalysis,
  calculateAltBulletTrajectory,
} from "../src/lib/altbullet-analysis.js";

test("AltBullet trajectory is direction-aware and honest about missing ordering", () => {
  const long = calculateAltBulletTrajectory({
    verdict: "confirmed",
    snapshotStatus: "ready",
    status: "profit",
    exitPrice: 110,
    pnlPercent: 10,
    entryPrice: 100,
    peakPrice: 110,
    isShort: false,
    drawdownMinPct: -4,
    trajectorySamples: [{ elapsedMs: 60_000, pctFromEntry: 3 }],
  });
  const short = calculateAltBulletTrajectory({
    verdict: "confirmed",
    snapshotStatus: "ready",
    status: "profit",
    exitPrice: 90,
    pnlPercent: 10,
    entryPrice: 100,
    peakPrice: 90,
    isShort: true,
  });
  assert.equal(long.mfe, 10);
  assert.equal(short.mfe, 10);
  assert.equal(long.mae, -4);
  assert.equal(long.targetBeforeStop, "unknown");
  assert.equal(
    calculateAltBulletTrajectory({
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: null,
      pnlPercent: null,
    }).available,
    false,
  );
});

test("AltBullet aggregation excludes unknown cancellations from outcomes", () => {
  const result = aggregateAltBulletAnalysis([
    {
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: "cancelled",
      cancelReason: "no_price_30m",
      exitPrice: null,
      pnlPercent: null,
    },
    {
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: "cancelled",
      cancelReason: "spot_audit_low_vol",
      exitPrice: null,
      pnlPercent: null,
    },
    {
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: "cancelled",
      cancelReason: "stale_3h",
      exitPrice: 95,
      pnlPercent: -5,
    },
    {
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: "profit",
      exitPrice: 110,
      pnlPercent: 10,
    },
    {
      verdict: "partial_conflict",
      snapshotStatus: "ready",
      status: "stop_loss",
      exitPrice: 90,
      pnlPercent: -10,
    },
    {
      verdict: "strong_conflict",
      snapshotStatus: "unavailable",
      status: "cancelled",
      cancelReason: "dead_pattern",
      exitPrice: null,
      pnlPercent: null,
    },
  ]);

  assert.equal(result.totalSnapshots, 6);
  assert.equal(result.readySnapshots, 5);
  assert.equal(result.unavailableSnapshots, 1);
  assert.equal(result.closedSnapshots, 3);
  assert.deepEqual(result.groups, [
    {
      verdict: "confirmed",
      total: 4,
      closed: 2,
      successful: 1,
      successRate: 50,
      averagePnl: 2.5,
    },
    {
      verdict: "partial_conflict",
      total: 1,
      closed: 1,
      successful: 0,
      successRate: 0,
      averagePnl: -10,
    },
    {
      verdict: "strong_conflict",
      total: 0,
      closed: 0,
      successful: 0,
      successRate: null,
      averagePnl: null,
    },
  ]);
});

test("AltBullet aggregation excludes cancellations with non-finite PnL", () => {
  const result = aggregateAltBulletAnalysis([
    {
      verdict: "confirmed",
      snapshotStatus: "ready",
      status: "cancelled",
      exitPrice: 100,
      pnlPercent: Number.NaN,
    },
  ]);

  assert.equal(result.closedSnapshots, 0);
  assert.deepEqual(result.groups[0], {
    verdict: "confirmed",
    total: 1,
    closed: 0,
    successful: 0,
    successRate: null,
    averagePnl: null,
  });
});
