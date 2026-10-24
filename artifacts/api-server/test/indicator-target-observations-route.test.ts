import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildIndicatorTargetObservationsResponse } from "../src/routes/tracker.js";

test("indicator target response has the read-only contract and per-group sample gate", () => {
  const generatedAt = new Date("2026-08-01T00:00:00.000Z");
  const response = buildIndicatorTargetObservationsResponse(
    [
      {
        pattern: "balanced_grind",
        targetPct: 8,
        total: 21,
        awaitingHit: 1,
        hit: 18,
        noHitBeforeClose: 1,
        unknown: 1,
        followupPending: 2,
        followupDelayed: 1,
        followupComplete: 19,
        followupPartial: 1,
        followupUnavailable: 1,
        completeOutcomeCount: 19,
        completeAverageChangePct: "2.5" as unknown as number,
        completePositiveAfter72: 12,
        completeAverageMaxFavorablePct: 6,
        completeAverageMinFavorablePct: -3,
      },
      {
        pattern: "balanced_grind",
        targetPct: 12,
        total: 20,
        awaitingHit: 0,
        hit: 20,
        noHitBeforeClose: 0,
        unknown: 0,
        followupPending: 0,
        followupDelayed: 0,
        followupComplete: 20,
        followupPartial: 0,
        followupUnavailable: 0,
        completeOutcomeCount: 20,
        completeAverageChangePct: null,
        completePositiveAfter72: 0,
        completeAverageMaxFavorablePct: null,
        completeAverageMinFavorablePct: null,
      },
    ],
    [
      {
        trackedSignalId: 92,
        symbol: "BTC-USDT",
        pattern: "balanced_grind",
        signalAt: generatedAt,
        targetPct: 8,
        indicatorProvenanceStatus: "entry_indicator_telemetry_frozen",
        status: "hit",
        hitAt: new Date("2026-07-29T00:00:00.000Z"),
        hitPrice: 108,
        hitSource: "bingx_15m_ohlc_high_low_conservative_candle_close",
        tradeClosedAt: null,
        followupStatus: "complete",
        followupDeadline: new Date("2026-08-01T00:00:00.000Z"),
        priceAt72h: 110.7,
        priceAt72hChangePct: 2.5,
        maxFavorablePct: 6,
        minFavorablePct: -3,
        followupSampleCount: 288,
        followupExpectedSampleCount: 288,
        priceAt72hObservedAt: generatedAt,
      },
    ],
    generatedAt,
  );

  assert.equal(response.observationOnly, true);
  assert.equal(response.decisionUse, false);
  assert.equal(response.generatedAt, generatedAt.toISOString());
  assert.deepEqual(response.benchmarksPercent, [8, 12, 16]);
  assert.deepEqual(Object.keys(response.groups[0]!), [
    "pattern",
    "targetPct",
    "total",
    "awaitingHit",
    "hit",
    "noHitBeforeClose",
    "unknown",
    "followupNotStarted",
    "followupPending",
    "followupDelayed",
    "followupRetry",
    "followupComplete",
    "followupPartial",
    "followupUnavailable",
    "followupNotApplicable",
    "completeOutcomeCount",
    "completeAverageChangePct",
    "completePositiveAfter72",
    "completeAverageMaxFavorablePct",
    "completeAverageMinFavorablePct",
    "lowSample",
  ]);
  assert.equal(response.groups[0]?.completeAverageChangePct, 2.5);
  assert.equal(response.groups[0]?.lowSample, true);
  assert.equal(response.groups[1]?.lowSample, false);
  assert.deepEqual(Object.keys(response.recent[0]!), [
    "trackedSignalId",
    "symbol",
    "pattern",
    "signalAt",
    "targetPct",
    "indicatorProvenanceStatus",
    "status",
    "hitAt",
    "hitPrice",
    "hitSource",
    "tradeClosedAt",
    "followupStatus",
    "followupDeadline",
    "priceAt72h",
    "priceAt72hChangePct",
    "maxFavorablePct",
    "minFavorablePct",
    "followupSampleCount",
    "followupExpectedSampleCount",
    "priceAt72hObservedAt",
  ]);
  assert.equal(response.recent[0]?.hitAt, "2026-07-29T00:00:00.000Z");
  assert.equal(response.recent[0]?.hitPrice, 108);
  assert.equal(response.recent[0]?.priceAt72h, 110.7);
  assert.match(response.methodology, /no take-profit recommendation/);
});

test("route is authenticated, schema-gated, bounded, and strictly observational", () => {
  const source = readFileSync(
    new URL("../src/routes/tracker.ts", import.meta.url),
    "utf8",
  );
  const routeStart = source.indexOf(
    'router.get(\n  "/admin/tracker/indicator-target-observations"',
  );
  const routeEnd = source.indexOf(
    'router.get(\n  "/admin/tracker/lc-waiting-shadow"',
    routeStart,
  );
  assert.notEqual(routeStart, -1);
  assert.notEqual(routeEnd, -1);
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /requireAdminToken/);
  assert.match(route, /indicatorTargetObservationExperimentsTable\.startAt/);
  assert.match(
    route,
    /\.groupBy\(\s*indicatorTargetObservationsTable\.pattern,\s*indicatorTargetObservationsTable\.targetPct/,
  );
  assert.match(route, /\.limit\(parsedQuery\.data\.limit\)/);
  assert.match(route, /followup_sample_count|followupSampleCount/);
  assert.match(route, /followupExpectedSampleCount/);
  assert.match(route, /getIndicatorTargetObservationWorkerHealth/);
  assert.match(route, /missingEnrollmentTrackedSignalsSinceStart/);
  assert.match(route, /count\(DISTINCT observation\.target_pct\)/);
  assert.doesNotMatch(
    route,
    /altBulletTakeProfitShadowTable|bingx|getKlinesRange/,
  );
});

test("observation scheduler and immediate enrollment are both wired", () => {
  const server = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  const watcher = readFileSync(
    new URL("../src/lib/watcher.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    server,
    /runDeferredMarketTimer\("indicator-target-observations"/,
  );
  assert.match(
    server,
    /withSchedulerLease\(\s*"indicator-target-observations"/,
  );
  assert.match(server, /runIndicatorTargetObservationCycle/);
  assert.match(
    watcher,
    /void enrollIndicatorTargetCandidatesForTrackedSignal\(trackedSignalId\)\.catch/,
  );
});
