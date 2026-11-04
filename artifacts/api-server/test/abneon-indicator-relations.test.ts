import assert from "node:assert/strict";
import test from "node:test";
import {
  ABNEON_RELATION_MAX_READY_SNAPSHOTS,
  aggregateIndicatorRelations,
  aggregateTargetAudit,
  bucketProximity,
  bucketRelationMetric,
  classifyRelationProvenance,
  relationOutcomePnl,
  type RelationTrade,
} from "../src/lib/abneon-indicator-relations.js";

test("indicator buckets preserve units and boundaries", () => {
  assert.equal(bucketRelationMetric("cvd1h", true), "true");
  assert.equal(bucketRelationMetric("oi30m", 2), "2–5%");
  assert.equal(bucketRelationMetric("fundingRate", 0.0001), "0.01–0.05%");
  assert.equal(bucketRelationMetric("williamsR21", -80), "≤−80");
  assert.equal(bucketRelationMetric("rsi1h", null), "unknown");
  assert.equal(bucketProximity(1), "0–1%");
  assert.equal(bucketProximity(2), ">1–3%");
});

test("aggregates isolate pattern/version and never infer targets from PnL", () => {
  const trades: RelationTrade[] = [
    {
      pattern: "alpha",
      version: "v1",
      pnlPercent: 12,
      terminal: true,
      metrics: [
        {
          key: "oi30m",
          value: 3,
          unit: "%",
          provenance: "signal_fire",
          provenanceCohort: "fire_time",
        },
      ],
      supportDistancePct: 0.5,
      resistanceDistancePct: 4,
    },
    {
      pattern: "alpha",
      version: "v2",
      pnlPercent: 20,
      terminal: true,
      metrics: [
        {
          key: "oi30m",
          value: 3,
          unit: "%",
          provenance: "signal_fire",
          provenanceCohort: "fire_time",
        },
      ],
      supportDistancePct: 0.5,
      resistanceDistancePct: 4,
    },
    {
      pattern: "alpha",
      version: "v1",
      pnlPercent: null,
      terminal: true,
      metrics: [
        {
          key: "oi30m",
          value: null,
          unit: "%",
          provenance: "not_recorded",
          provenanceCohort: "unknown",
        },
      ],
      supportDistancePct: null,
      resistanceDistancePct: null,
    },
  ];
  const groups = aggregateIndicatorRelations(trades);
  const v1 = groups.find(
    (group) => group.version === "v1" && group.bucket === "2–5%",
  );
  assert.ok(v1);
  assert.equal(v1.eligibleCount, 1);
  assert.equal(v1.averageRawPnlPercent, 12);
  assert.equal(v1.outcomesAtLeast10Pct, 1);
  assert.ok(groups.some((group) => group.version === "v2"));
  const unknown = groups.find((group) => group.bucket === "unknown");
  assert.equal(unknown?.unknownEntryCount, 1);
  assert.equal(unknown?.unknownOutcomeCount, 1);
});

test("reconstructed telemetry is isolated from decision-time cohorts", () => {
  assert.equal(classifyRelationProvenance("bingx_1h_closed"), "fire_time");
  assert.equal(
    classifyRelationProvenance("reconstructed_from_bingx_1h"),
    "reconstructed",
  );
  assert.equal(
    classifyRelationProvenance("prescan_snapshot"),
    "prescan_snapshot",
  );
  assert.equal(classifyRelationProvenance("reconstruction_retry"), "unknown");
  const trades: RelationTrade[] = ["fire_time", "reconstructed"].map(
    (provenanceCohort) => ({
      pattern: "alpha",
      version: "v1",
      pnlPercent: 4,
      terminal: true,
      metrics: [
        {
          key: "rsi5",
          value: 55,
          unit: "RSI points",
          provenance: provenanceCohort,
          provenanceCohort: provenanceCohort as "fire_time" | "reconstructed",
        },
      ],
      supportDistancePct: 1,
      resistanceDistancePct: 2,
    }),
  );
  const groups = aggregateIndicatorRelations(trades);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.provenanceCohort).sort(), [
    "fire_time",
    "reconstructed",
  ]);
  assert.equal(ABNEON_RELATION_MAX_READY_SNAPSHOTS, 1_000);
});

test("cancellation outcomes require positive exit and finite PnL", () => {
  assert.equal(
    relationOutcomePnl({
      status: "cancelled",
      cancelReason: "no_price_30m",
      exitPrice: null,
      pnlPercent: null,
    }),
    null,
  );
  assert.equal(
    relationOutcomePnl({
      status: "cancelled",
      cancelReason: "entered_stale",
      exitPrice: 101,
      pnlPercent: 1,
    }),
    1,
  );
  assert.equal(
    relationOutcomePnl({
      status: "cancelled",
      cancelReason: "entered_stale",
      exitPrice: 101,
      pnlPercent: Number.NaN,
    }),
    null,
  );
});

test("shadow audit counts only event-ordered touches, with unknown never a miss", () => {
  const base = {
    version: "v8",
    pattern: "lc",
    variant: "exact_resistance",
    eligible: true,
    pnlPercent: 12,
    targetPct: 8,
    requestedAt: "2026-01-01T00:00:00Z",
    capturedAt: "2026-01-01T00:10:00Z",
    hitAt: "2026-01-01T01:00:00Z",
    closedAt: "2026-01-01T03:00:00Z",
  };
  const [group] = aggregateTargetAudit([
    base,
    { ...base, hitAt: null },
    { ...base, hitAt: "2026-01-01T04:00:00Z" },
    { ...base, hitAt: "2026-01-01T00:05:00Z" },
    { ...base, pnlPercent: null },
    { ...base, eligible: false },
  ]);
  assert.equal(group.measuredClosed, 4);
  assert.equal(group.confirmedHits, 1);
  assert.equal(group.unknownTouch, 3);
  assert.equal(group.unknownOutcome, 1);
  assert.equal(group.actualStrong, 4);
  assert.equal(group.confirmedStrongClipped, 1);
  assert.equal(group.actualAverageRawPnl, 12);
  assert.equal(group.confirmedHitDeltaPp, -4);
  assert.equal(group.sufficient, false);
});
