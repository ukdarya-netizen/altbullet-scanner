import assert from "node:assert/strict";
import test from "node:test";
import { buildLcRepeatWatchReport } from "../src/lib/lc-repeat-watch.js";

const now = new Date("2026-04-30T12:00:00.000Z");

function signal(
  id: number,
  symbol: string,
  at: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    symbol,
    detected_at: at,
    closed_at: null,
    status,
    original_entry_price: "100",
    entry_price: null,
    pnl_percent: null,
    decision_metrics: null,
    peak_15m_pct: null,
    elapsed_15m_ms: null,
    peak_1h_pct: null,
    elapsed_1h_ms: null,
    ...extra,
  };
}

function validMap(fetchedAt: string) {
  return {
    liqHeatmapShadow: {
      available: true,
      source: "coinglass_binance_heatmap_model2_3d",
      fetchedAt,
      entryPrice: 100,
      bands: { below0to5: 30, above0to5: 70 },
      topBelow: [{ price: 98, value: 5 }],
      topAbove: [{ price: 102, value: 10 }],
    },
  };
}

test("builds ordered repeat sequences and only flags an immediately prior completed stop", () => {
  const rows = [
    signal(1, "UAI-USDT", "2026-04-21T00:00:00Z", "stop_loss", {
      closed_at: "2026-04-21T01:00:00Z",
      pnl_percent: "-4",
    }),
    signal(2, "UAI-USDT", "2026-04-22T00:00:00Z", "active"),
    signal(3, "UAI-USDT", "2026-04-23T00:00:00Z", "profit", {
      closed_at: "2026-04-23T02:00:00Z",
      pnl_percent: "12.5",
      decision_metrics: validMap("2026-04-22T23:55:00Z"),
      peak_15m_pct: "8",
      elapsed_15m_ms: 900_000,
      peak_1h_pct: "11",
      elapsed_1h_ms: 3_600_000,
    }),
    signal(4, "ARB-USDT", "2026-04-24T00:00:00Z", "stop_loss", {
      closed_at: "2026-04-24T01:00:00Z",
      pnl_percent: "-6",
    }),
    signal(5, "ARB-USDT", "2026-04-25T00:00:00Z", "in_run"),
    signal(6, "ONE-USDT", "2026-04-26T00:00:00Z", "active"),
    signal(7, "OLD-USDT", "2026-03-01T00:00:00Z", "stop_loss"),
  ];

  const report = buildLcRepeatWatchReport(rows, now);
  const uai = report.groups.find((group) => group.symbol === "UAI-USDT")!;
  assert.deepEqual(
    uai.signals.map((item) => item.trackedId),
    [1, 2, 3],
  );
  assert.equal(uai.signals[1]!.priorSignalStopped, true);
  assert.equal(uai.signals[2]!.priorSignalStatus, "active");
  assert.equal(uai.signals[2]!.priorSignalStopped, false);
  assert.equal(uai.signals[2]!.hoursSincePreviousClose, null);
  assert.equal(uai.signals[2]!.realizedPnlPercent, 12.5);
  assert.equal(uai.signals[1]!.realizedPnlPercent, null);
  assert.equal(uai.signals[2]!.first15mPeakPct, 8);
  assert.equal(uai.signals[2]!.first1hPeakPct, 11);

  const arb = report.groups.find((group) => group.symbol === "ARB-USDT")!;
  assert.equal(arb.signals[1]!.priorSignalStopped, true);
  assert.equal(arb.signals[1]!.hoursSincePreviousClose, 23);
  assert.equal(report.summary.repeatedSymbolCount, 2);
  assert.equal(report.summary.signalCount, 5);
  assert.equal(report.summary.immediatelyAfterStopCount, 2);
  assert.equal(report.summary.openSignalCount, 2);
  assert.equal(report.summary.terminalSignalCount, 3);
  assert.equal(report.windowDays, 30);
});

test("keeps missing and invalid entry-map evidence explicit and cohort denominators honest", () => {
  const rows = [
    signal(1, "MAP-USDT", "2026-04-28T00:00:00Z", "stop_loss", {
      closed_at: "2026-04-28T01:00:00Z",
      pnl_percent: "-2",
      decision_metrics: validMap("2026-04-27T23:55:00Z"),
    }),
    signal(2, "MAP-USDT", "2026-04-29T00:00:00Z", "profit", {
      closed_at: "2026-04-29T02:00:00Z",
      pnl_percent: "11",
      decision_metrics: validMap("2026-04-28T23:00:00Z"),
    }),
    signal(3, "MAP-USDT", "2026-04-30T00:00:00Z", "cancelled", {
      pnl_percent: "99",
    }),
  ];
  const report = buildLcRepeatWatchReport(rows, now);
  const signals = report.groups[0]!.signals;
  assert.equal(signals[0]!.entryMapEvidence.status, "available");
  assert.equal(
    signals[0]!.entryMapEvidence.source,
    "coinglass_binance_heatmap_model2_3d",
  );
  assert.equal(signals[0]!.entryMapEvidence.belowShareWithin5Pct, 0.3);
  assert.equal(signals[1]!.entryMapEvidence.status, "unavailable");
  assert.equal(signals[1]!.entryMapEvidence.reason, "stale_at_detection");
  assert.equal(signals[2]!.entryMapEvidence.status, "missing");
  assert.equal(signals[2]!.realizedPnlPercent, null);

  assert.equal(report.summary.validEntryMapCount, 1);
  assert.equal(report.summary.missingEntryMapCount, 1);
  const available = report.cohorts.entryMapStatus.find(
    (cohort) => cohort.group === "available",
  )!;
  assert.equal(available.signalDenominator, 1);
  assert.equal(available.eligibleOutcomeDenominator, 1);
  assert.equal(available.realizedPnlDenominator, 1);
  assert.equal(available.realizedAbove10Count, 0);
  assert.equal(available.stopLossCount, 1);
});

test("rejects map captures with future time, mismatched entry, or invalid band totals", () => {
  const base = validMap("2026-04-29T23:55:00Z");
  const mismatch = structuredClone(base);
  mismatch.liqHeatmapShadow.entryPrice = 150;
  const invalidBands = {
    liqHeatmapShadow: {
      ...base.liqHeatmapShadow,
      bands: { below0to5: -1, above0to5: 70 },
    },
  };
  const future = validMap("2026-04-30T00:01:00Z");
  const rows = [
    signal(1, "CHECK-USDT", "2026-04-30T00:00:00Z", "active", {
      decision_metrics: mismatch,
    }),
    signal(2, "CHECK-USDT", "2026-04-30T00:00:00Z", "active", {
      decision_metrics: invalidBands,
    }),
    signal(3, "CHECK-USDT", "2026-04-30T00:00:00Z", "active", {
      decision_metrics: future,
    }),
  ];
  const report = buildLcRepeatWatchReport(rows, now);
  assert.deepEqual(
    report.groups[0]!.signals.map((item) => item.entryMapEvidence.reason),
    ["entry_price_mismatch", "invalid_0to5_bands", "fetched_after_detection"],
  );
});

test("accepts valid band totals when full-capture top-three bins omit the 0-5% range", () => {
  const map = validMap("2026-04-29T23:55:00Z");
  map.liqHeatmapShadow.topBelow = [{ price: 80, value: 50 }];
  map.liqHeatmapShadow.topAbove = [{ price: 120, value: 60 }];
  const rows = [
    signal(1, "TOP3-USDT", "2026-04-30T00:00:00Z", "active", {
      decision_metrics: map,
    }),
    signal(2, "TOP3-USDT", "2026-04-30T01:00:00Z", "active"),
  ];

  const report = buildLcRepeatWatchReport(rows, now);
  assert.equal(
    report.groups[0]!.signals[0]!.entryMapEvidence.status,
    "available",
  );
  assert.equal(
    report.groups[0]!.signals[0]!.entryMapEvidence.belowShareWithin5Pct,
    0.3,
  );
});

test("does not treat an overlapping prior stop as closed before the next detection", () => {
  const report = buildLcRepeatWatchReport(
    [
      signal(1, "OVERLAP-USDT", "2026-04-20T00:00:00Z", "stop_loss", {
        closed_at: "2026-04-22T00:00:00Z",
        pnl_percent: "-5",
      }),
      signal(2, "OVERLAP-USDT", "2026-04-21T00:00:00Z", "active"),
      signal(3, "OVERLAP-USDT", "2026-04-23T00:00:00Z", "active", {
        original_entry_price: "91",
      }),
    ],
    now,
  );
  const next = report.groups[0]!.signals[1]!;
  assert.equal(next.priorSignalStatus, "stop_loss");
  assert.equal(next.priorSignalStopped, false);
  assert.equal(next.previousClosedAt, null);
  assert.equal(next.hoursSincePreviousClose, null);
  assert.equal(
    report.groups[0]!.signals[0]!.nextLcDetectedAt,
    "2026-04-23T00:00:00.000Z",
  );
  assert.equal(report.groups[0]!.signals[0]!.nextLcEntryPrice, 91);
});

test("shows bounded post-stop depth, explicit gaps, and the next entry without inferring liquidation", () => {
  const at = new Date("2026-04-30T10:00:00Z");
  const report = buildLcRepeatWatchReport(
    [
      signal(10, "TEST-USDT", "2026-04-30T08:00:00Z", "stop_loss", {
        closed_at: "2026-04-30T09:00:00Z",
        pnl_percent: "-10",
      }),
      signal(11, "TEST-USDT", "2026-04-30T09:30:00Z", "profit", {
        original_entry_price: "93",
        closed_at: "2026-04-30T09:50:00Z",
        pnl_percent: "12",
      }),
    ],
    at,
    [
      {
        tracked_signal_id: 10,
        slot_minutes: 0,
        status: "observed",
        observed_at: "2026-04-30T09:01:00Z",
        source: "BingX perpetual",
        reference_price: 95,
        bids: [{ price: 94, qty: 10, usd: 940 }],
      },
      {
        tracked_signal_id: 10,
        slot_minutes: 15,
        status: "observed",
        observed_at: "2026-04-30T09:16:00Z",
        source: "BingX perpetual",
        reference_price: 96,
        bids: [{ price: 94, qty: 5, usd: 470 }],
      },
    ],
  );
  const stop = report.groups[0]!.signals[0]!;
  assert.equal(stop.nextLcEntryPrice, 93);
  assert.equal(stop.nextLcDetectedAt, "2026-04-30T09:30:00.000Z");
  assert.equal(stop.nextLcStatus, "profit");
  assert.equal(stop.nextLcRealizedPnlPercent, 12);
  assert.deepEqual(
    stop.postStopBids.map((row) => row.status),
    ["observed", "observed", "pending", "upcoming"],
  );
  assert.deepEqual(stop.postStopBids[1]!.repeatedPrices, [94]);
  assert.equal(stop.postStopBids[0]!.bids[0]!.qty, 10);
  assert.equal(stop.entryMapEvidence.status, "missing");
  assert.equal(report.groups[0]!.signals[1]!.realizedPnlPercent, 12);
  const later = buildLcRepeatWatchReport(
    [
      signal(10, "TEST-USDT", "2026-04-30T08:00:00Z", "stop_loss", {
        closed_at: "2026-04-30T09:00:00Z",
      }),
    ],
    new Date("2026-04-30T12:00:00Z"),
  );
  assert.equal(
    later.groups[0]!.signals[0]!.postStopBids.every(
      (row) => row.status === "missing",
    ),
    true,
  );
});

test("includes a stop closed in the window even if its LC was detected earlier", () => {
  const report = buildLcRepeatWatchReport(
    [
      signal(20, "OLD-STOP", "2026-03-20T00:00:00Z", "stop_loss", {
        closed_at: "2026-04-30T09:00:00Z",
      }),
    ],
    now,
  );
  assert.equal(report.groups[0]!.signals[0]!.trackedId, 20);
  assert.equal(report.groups[0]!.signals[0]!.postStopBids.length, 4);
});
