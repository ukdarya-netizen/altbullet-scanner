import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS,
  buildEntryMetricsProvenance,
  buildHistoricalEntryMetricPatch,
  type HistoricalEntryMetricCandidate,
  type HistoricalPrescanSnapshot,
} from "../src/lib/entry-metric-backfill.js";

const detectedAt = new Date("2026-08-19T10:00:00.000Z");

const emptyCandidate: HistoricalEntryMetricCandidate = {
  price24hAtFire: null,
  entryPrice1h: null,
  entryOi30m: null,
  entryOi1h: null,
  entryOi4h: null,
  entryFutVolMult: null,
  entrySpotVol24h: null,
  entryWhaleIndex: null,
  entryFundingRate: null,
  entryObRatio: null,
  entryCvd30m: null,
  entryCvd1h: null,
  entryCvd4h: null,
};

const snapshot: HistoricalPrescanSnapshot = {
  cycleAt: new Date("2026-08-19T09:53:00.000Z"),
  p24h: 12,
  p1h: 1.5,
  oi30m: 3,
  oi1h: 5,
  oi4h: 9,
  volMult: 2.4,
  spotVolUsd24h: 850_000,
  whaleIndex: 71,
  fundingRate: -0.0001,
  obRatio: 1.3,
  cvd30m: true,
  cvd1h: true,
  cvd4h: false,
};

describe("historical entry-metric backfill", () => {
  test("fills only missing metrics from the nearest earlier prescan snapshot", () => {
    const result = buildHistoricalEntryMetricPatch(
      { ...emptyCandidate, entryOi1h: 99 },
      snapshot,
      detectedAt,
    );

    assert.equal(result.patch.entryOi30m, 3);
    assert.equal(result.patch.entryOi1h, undefined);
    assert.equal(result.patch.entryCvd4h, false);
    assert.equal(result.patch.entrySpotVol24h, 850_000);
    assert.deepEqual(result.provenance.entryOi30m, {
      source: "prescan_snapshot",
      observedAt: snapshot.cycleAt.toISOString(),
    });
  });

  test("rejects later and stale snapshots instead of labelling them as entry data", () => {
    const later = buildHistoricalEntryMetricPatch(
      emptyCandidate,
      { ...snapshot, cycleAt: new Date("2026-08-19T10:00:01.000Z") },
      detectedAt,
    );
    assert.deepEqual(later, { patch: {}, provenance: {} });

    const stale = buildHistoricalEntryMetricPatch(
      emptyCandidate,
      {
        ...snapshot,
        cycleAt: new Date(
          detectedAt.getTime() - HISTORICAL_ENTRY_SNAPSHOT_MAX_AGE_MS - 1,
        ),
      },
      detectedAt,
    );
    assert.deepEqual(stale, { patch: {}, provenance: {} });
  });

  test("does not infer unsupported metrics from similarly named current fields", () => {
    const result = buildHistoricalEntryMetricPatch(
      emptyCandidate,
      snapshot,
      detectedAt,
    );
    assert.equal("entryOi24h" in result.patch, false);
    assert.equal("entrySpotNetBuy1h" in result.patch, false);

    const provenance = buildEntryMetricsProvenance(
      { entryCvd30m: false, entryOi30m: null },
      "signal_fire",
      detectedAt,
    );
    assert.deepEqual(provenance, {
      entryCvd30m: {
        source: "signal_fire",
        observedAt: detectedAt.toISOString(),
      },
    });
  });

  test("keeps the recurring backfill free of live market API calls", () => {
    const watcherSource = readFileSync(
      fileURLToPath(new URL("../../src/lib/watcher.ts", import.meta.url)),
      "utf8",
    );
    const start = watcherSource.indexOf(
      "async function refreshNullEntryMetrics",
    );
    const end = watcherSource.indexOf(
      "\nasync function _runLiqCascadeFireCycle",
      start,
    );
    assert.ok(start >= 0 && end > start, "refresh function boundaries found");

    const refreshSource = watcherSource.slice(start, end);
    assert.doesNotMatch(
      refreshSource,
      /\b(getCoinglass|getSpotTakerFlow|getSpotCvdMtf|getFundingRate|getOrderBookAnalysis|getTokenWhaleIndex|getFsVolume)\b/,
    );
  });
});
