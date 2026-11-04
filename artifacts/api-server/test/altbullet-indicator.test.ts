import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  ALT_BULLET_SNAPSHOT_MAX_AGE_MS,
  ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS,
  ALT_BULLET_MIN_CLOSED_SNAPSHOTS,
  analyzeAltBulletIndicator,
  calculateAltBulletTrend,
  getAltBulletAnalysisRecommendation,
  getAltBulletSnapshotFetchEligibility,
  getAltBulletSnapshotRetryDecision,
  scheduleAltBulletIndicatorSnapshot,
  toClosedCandles,
} from "../src/lib/altbullet-indicator.js";

test("AltBullet remains observational and does not participate in scanner gates", () => {
  const sourcePath = existsSync("src/lib/altbullet-indicator.ts")
    ? "src/lib/altbullet-indicator.ts"
    : "artifacts/api-server/src/lib/altbullet-indicator.ts";
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /already been accepted for tracking/);
  assert.match(source, /setTimeout\(callback, 0\)/);
  assert.doesNotMatch(source, /return\s+(?:true|false)\s*;\s*\/\/\s*gate/i);
});

test("AltBullet uses BingX open timestamps without look-ahead", () => {
  const hour = 60 * 60 * 1000;
  const cutoff = new Date(10 * hour);
  const rows = [8, 9].map((time) => ({
    open: "1",
    high: "1",
    low: "1",
    close: "1",
    volume: "1",
    time: time * hour,
  }));
  // 8h candle closed at 9h is retained; 9h candle closes after the 10h cutoff
  // only when the cutoff is before its close.
  assert.equal(toClosedCandles(rows, hour, cutoff).length, 2);
  assert.equal(toClosedCandles(rows, hour, new Date(9.5 * hour)).length, 1);
});

test("AltBullet structure switches up only after a confirmed swing-high break", () => {
  const candles = [
    [99, 100, 90, 99],
    [100, 102, 91, 101],
    [102, 111, 92, 105],
    [104, 106, 93, 100],
    [100, 105, 94, 102],
    [102, 109, 95, 108],
    [110, 113, 96, 112],
  ].map(([open, high, low, close], index) => ({
    open,
    high,
    low,
    close,
    volume: 100,
    time: index * 60 * 60 * 1000,
  }));

  assert.equal(calculateAltBulletTrend(candles, 2), "up");
});

type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
};

function makeBaseCandles(intervalMs: number): Candle[] {
  return Array.from({ length: 31 }, (_, index) => ({
    open: 100,
    high: 101,
    low: 99.1,
    close: 100,
    volume: 100,
    time: 1_700_000_000_000 + index * intervalMs,
  }));
}

function makeUptrendCandles(intervalMs: number): Candle[] {
  const candles = makeBaseCandles(intervalMs);
  candles[10] = { ...candles[10]!, high: 110 };
  candles[21] = { ...candles[21]!, high: 112, close: 111 };
  candles[24] = { ...candles[24]!, close: 100 };
  candles[30] = {
    ...candles[30]!,
    open: 115,
    high: 119,
    low: 111,
    close: 115,
    volume: 100,
  };
  return candles;
}

function read(
  candles4h: Candle[],
  candles1h = makeUptrendCandles(60 * 60 * 1000),
) {
  return analyzeAltBulletIndicator({ candles4h, candles1h });
}

test("AltBullet audit makes every passed check and its threshold explicit", () => {
  const result = read(makeUptrendCandles(4 * 60 * 60 * 1000));

  assert.equal(result.status, "ready");
  assert.equal(result.score, null);
  assert.equal(result.verdict, null);
  assert.equal(result.checks?.chase, "pass");
  assert.equal(result.checks?.volume, "pass");
  assert.ok(result.context.nearestResistance !== undefined);
  assert.ok(result.context.nearestSupport !== undefined);
  assert.ok(result.audit);
  assert.equal(result.audit.dataSource, "BingX");
  assert.equal(result.audit.isClosed, true);
  assert.equal(result.audit.checks.chase.actual, 15);
  assert.equal(result.audit.checks.chase.threshold, 15);
  assert.equal(result.audit.checks.chase.passed, true);
  assert.equal(result.audit.checks.volume.actual, 100);
  assert.equal(result.audit.checks.volume.threshold, 100);
  assert.equal(result.audit.checks.capitulationWick.actual, 0.5);
  assert.equal(result.audit.checks.capitulationWick.threshold, 0.5);
  assert.equal(
    result.audit.lastClosed4hAt,
    new Date(1_700_000_000_000 + 31 * 4 * 60 * 60 * 1000).toISOString(),
  );
});

test("AltBullet retains raw checks without generating score or verdict", () => {
  const partial4h = makeBaseCandles(4 * 60 * 60 * 1000);
  partial4h[24] = { ...partial4h[24]!, close: 100 };
  partial4h[30] = { ...partial4h[30]!, close: 115, volume: 100 };
  const partial = read(partial4h, makeBaseCandles(60 * 60 * 1000));

  assert.equal(partial.score, null);
  assert.equal(partial.verdict, null);
  assert.ok(partial.checks);
  assert.equal(partial.context.passCount, 3);
  assert.equal(partial.context.failCount, 3);

  const strong4h = makeBaseCandles(4 * 60 * 60 * 1000);
  strong4h[24] = { ...strong4h[24]!, close: 100 };
  strong4h[30] = { ...strong4h[30]!, close: 115.01, volume: 99 };
  const strong = read(strong4h, makeBaseCandles(60 * 60 * 1000));

  assert.equal(strong.score, null);
  assert.equal(strong.verdict, null);
  assert.ok(strong.checks);
  assert.ok((strong.context.failCount as number) > 0);
  assert.equal(strong.audit?.checks.chase.passed, false);
  assert.equal(strong.audit?.checks.volume.passed, false);
});

test("new AltBullet snapshot persistence hard-writes nullable legacy score columns", () => {
  const sourcePath = existsSync("src/lib/altbullet-indicator.ts")
    ? "src/lib/altbullet-indicator.ts"
    : "artifacts/api-server/src/lib/altbullet-indicator.ts";
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /score:\s*null,\s*verdict:\s*null/);
  assert.match(
    source,
    /score:\s*null,\s*verdict:\s*null,[\s\S]{0,300}Snapshot JSON/,
  );
});

test("AltBullet audit preserves threshold boundaries for ROC, volume and wick", () => {
  const atLimit = makeUptrendCandles(4 * 60 * 60 * 1000);
  const atLimitResult = read(atLimit);
  assert.equal(atLimitResult.audit?.checks.chase.passed, true);
  assert.equal(atLimitResult.audit?.checks.volume.passed, true);
  assert.equal(atLimitResult.audit?.checks.capitulationWick.passed, true);

  const beyondLimit = makeUptrendCandles(4 * 60 * 60 * 1000);
  beyondLimit[30] = {
    ...beyondLimit[30]!,
    close: 115.01,
    volume: 99,
    low: 111.08,
  };
  const beyondLimitResult = read(beyondLimit);

  assert.equal(beyondLimitResult.audit?.checks.chase.passed, false);
  assert.equal(beyondLimitResult.audit?.checks.volume.passed, false);
  assert.equal(beyondLimitResult.audit?.checks.capitulationWick.passed, false);
  assert.equal(beyondLimitResult.audit?.checks.capitulationWick.threshold, 0.5);
});

test("AltBullet exposes a recent 4H resistance after two closed right-hand candles", () => {
  const candles4h = makeBaseCandles(4 * 60 * 60 * 1000);
  candles4h[27] = {
    ...candles4h[27]!,
    open: 105,
    high: 110,
    low: 104,
    close: 105,
  };
  const result = read(candles4h);

  assert.equal(result.status, "ready");
  assert.equal(result.context.nearestResistance, 110);
});

test("AltBullet records nearby support only after two closed 4H confirming candles", () => {
  const candles4h = makeBaseCandles(4 * 60 * 60 * 1000);
  candles4h[27] = { ...candles4h[27]!, low: 90, close: 96 };
  const beforeConfirmation = read(candles4h.slice(0, 29));
  const confirmed = read(candles4h);

  assert.equal(beforeConfirmation.status, "ready");
  assert.notEqual(beforeConfirmation.context.nearestSupport, 90);
  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.context.nearestSupport, 90);
  assert.equal(confirmed.context.supportPresent, true);
  assert.equal(confirmed.context.supportDistancePct, 10);
  assert.equal(confirmed.context.supportWithin1Atr, false);
});

test("AltBullet marks unavailable support as unknown, not absent", () => {
  const result = analyzeAltBulletIndicator({ candles4h: [], candles1h: [] });
  assert.equal(result.status, "unavailable");
  assert.equal(result.context.supportPresent, undefined);
});

function group(
  verdict: "confirmed" | "partial_conflict" | "strong_conflict",
  closed: number,
  successRate: number,
  averagePnl: number,
) {
  return {
    verdict,
    total: closed,
    closed,
    successful: Math.round((closed * successRate) / 100),
    successRate,
    averagePnl,
  };
}

test("AltBullet analysis stays pending until 20 closed snapshots", () => {
  const result = getAltBulletAnalysisRecommendation({
    closedSnapshots: ALT_BULLET_MIN_CLOSED_SNAPSHOTS - 1,
    groups: [group("confirmed", 19, 75, 2)],
  });

  assert.equal(result.code, "insufficient_sample");
  assert.match(result.detail, /20/);
});

test("AltBullet analysis recommends observation when groups do not separate", () => {
  const result = getAltBulletAnalysisRecommendation({
    closedSnapshots: 20,
    groups: [
      group("confirmed", 8, 50, 0.4),
      group("partial_conflict", 7, 57, 0.2),
      group("strong_conflict", 5, 40, -0.3),
    ],
  });

  assert.equal(result.code, "keep_observational");
});

test("AltBullet analysis recommends calibration only with reliable group coverage", () => {
  const result = getAltBulletAnalysisRecommendation({
    closedSnapshots: 21,
    groups: [
      group("confirmed", 7, 86, 3.1),
      group("partial_conflict", 7, 57, 0.8),
      group("strong_conflict", 7, 43, -0.9),
    ],
  });

  assert.equal(result.code, "calibrate_thresholds");
});

test("AltBullet analysis asks for an experiment when separation lacks coverage", () => {
  const result = getAltBulletAnalysisRecommendation({
    closedSnapshots: 20,
    groups: [
      group("confirmed", 15, 80, 2.5),
      group("partial_conflict", 4, 25, -1),
      group("strong_conflict", 1, 0, -2),
    ],
  });

  assert.equal(result.code, "consider_experiment");
});

test("AltBullet snapshot scheduling never waits on an observation", async () => {
  let deferred: (() => void) | undefined;
  let captureStarted = false;
  const completed = new Promise<void>((resolve) => {
    scheduleAltBulletIndicatorSnapshot(
      { signalId: 123, symbol: "TEST-USDT", sentimentKey: "balanced_grind" },
      {
        defer: (callback) => {
          deferred = callback;
        },
        capture: async () => {
          captureStarted = true;
          resolve();
        },
      },
    );
  });

  assert.equal(captureStarted, false);
  assert.ok(deferred);
  deferred();
  await completed;
  assert.equal(captureStarted, true);
});

test("AltBullet retries a transient market failure inside the bounded observation window", () => {
  const requestedAt = new Date("2026-08-25T05:00:00.000Z");
  const retry = getAltBulletSnapshotRetryDecision({
    attemptCount: 1,
    requestedAt,
    now: new Date("2026-08-25T05:00:30.000Z"),
  });

  assert.equal(retry.kind, "retry");
  if (retry.kind === "retry") {
    assert.equal(retry.retryAfter.toISOString(), "2026-08-25T05:02:30.000Z");
  }
});

test("AltBullet finalizes a transient failure after the retry budget", () => {
  const decision = getAltBulletSnapshotRetryDecision({
    attemptCount: ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS,
    requestedAt: new Date("2026-08-25T05:00:00.000Z"),
    now: new Date("2026-08-25T05:05:00.000Z"),
  });

  assert.deepEqual(decision, {
    kind: "unavailable",
    reason: "retry_budget_exhausted",
  });
});

test("AltBullet does not retry past the entry observation window", () => {
  const requestedAt = new Date("2026-08-25T05:00:00.000Z");
  const decision = getAltBulletSnapshotRetryDecision({
    attemptCount: 1,
    requestedAt,
    now: new Date(requestedAt.getTime() + ALT_BULLET_SNAPSHOT_MAX_AGE_MS),
  });

  assert.deepEqual(decision, {
    kind: "unavailable",
    reason: "retry_window_expired",
  });
});

test("AltBullet does not fetch a reclaimed snapshot after its retry budget", () => {
  assert.deepEqual(
    getAltBulletSnapshotFetchEligibility({
      attemptCount: ALT_BULLET_SNAPSHOT_MAX_ATTEMPTS + 1,
      requestedAt: new Date("2026-08-25T05:00:00.000Z"),
      now: new Date("2026-08-25T05:01:00.000Z"),
    }),
    {
      kind: "unavailable",
      reason: "retry_budget_exhausted",
    },
  );
});

test("AltBullet does not fetch a reclaimed snapshot after its observation window", () => {
  const requestedAt = new Date("2026-08-25T05:00:00.000Z");
  assert.deepEqual(
    getAltBulletSnapshotFetchEligibility({
      attemptCount: 1,
      requestedAt,
      now: new Date(requestedAt.getTime() + ALT_BULLET_SNAPSHOT_MAX_AGE_MS),
    }),
    {
      kind: "unavailable",
      reason: "retry_window_expired",
    },
  );
});
