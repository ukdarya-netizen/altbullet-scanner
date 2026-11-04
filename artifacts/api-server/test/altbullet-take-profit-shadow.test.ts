import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { buildAltBulletTpCandidates } from "../src/lib/altbullet-take-profit-shadow-policy.js";

test("ABNeon TP shadow is retired from new backend observation writes", () => {
  const watcherPath = existsSync("src/lib/watcher.ts")
    ? "src/lib/watcher.ts"
    : "artifacts/api-server/src/lib/watcher.ts";
  const indicatorPath = existsSync("src/lib/altbullet-indicator.ts")
    ? "src/lib/altbullet-indicator.ts"
    : "artifacts/api-server/src/lib/altbullet-indicator.ts";
  const watcher = readFileSync(watcherPath, "utf8");
  const indicator = readFileSync(indicatorPath, "utf8");

  assert.doesNotMatch(
    watcher,
    /ensureAltBulletTpShadowForSignal|reconcileAltBulletTpShadowObservations|recordAltBulletTpShadowPrices/,
  );
  assert.doesNotMatch(
    indicator,
    /ensureAltBulletTpShadowForSignal|reconcileAltBulletTpShadowObservations|recordAltBulletTpShadowPrices/,
  );
});

test("ABNeon TP shadow records exact and two ATR-buffer variants", () => {
  const candidates = buildAltBulletTpCandidates({
    entryPrice: 100,
    resistancePrice: 110,
    atr14: 5,
    isShort: false,
  });

  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.variant,
      candidate.status,
      candidate.targetPrice,
      candidate.targetPct,
      candidate.targetAtr,
    ]),
    [
      ["exact_resistance", "tracking", 110, 10, 2],
      ["before_0_10_atr", "tracking", 109.5, 9.5, 1.9],
      ["before_0_20_atr", "tracking", 109, 9, 1.8],
    ],
  );
});

test("ABNeon TP shadow preserves missing resistance as coverage evidence", () => {
  const candidates = buildAltBulletTpCandidates({
    entryPrice: 100,
    resistancePrice: null,
    atr14: 5,
    isShort: false,
  });

  assert.equal(candidates.length, 3);
  assert.ok(
    candidates.every(
      (candidate) =>
        candidate.status === "not_eligible" &&
        candidate.eligibilityReason === "resistance_unavailable",
    ),
  );
});

test("ABNeon TP shadow rejects targets at or below entry", () => {
  const candidates = buildAltBulletTpCandidates({
    entryPrice: 100,
    resistancePrice: 100.1,
    atr14: 2,
    isShort: false,
  });

  assert.equal(candidates[0]?.status, "tracking");
  assert.equal(candidates[1]?.status, "not_eligible");
  assert.equal(candidates[1]?.eligibilityReason, "target_at_or_below_entry");
});

test("ABNeon TP shadow does not silently apply long targets to shorts", () => {
  const candidates = buildAltBulletTpCandidates({
    entryPrice: 100,
    resistancePrice: 110,
    atr14: 5,
    isShort: true,
  });

  assert.ok(
    candidates.every(
      (candidate) =>
        candidate.status === "not_eligible" &&
        candidate.eligibilityReason === "short_direction_not_supported",
    ),
  );
});
