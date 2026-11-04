import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  buildIndicatorTargetCandidates,
  calculateHypothesisTargetPrice,
  calculateTargetFollowup,
  classifyNoHitHistoryOutcome,
  createKlineRangeCache,
  findFirstConfirmedTargetHit,
  freezeEntryMetricsSnapshot,
  freezeIndicatorProvenance,
  hasCompleteNoHitBoundaryEvidence,
  hasAmbiguousSignalOverlap,
  hasAmbiguousTradeCloseOverlap,
  hasContinuousClosed15mCoverage,
  INDICATOR_TARGET_HYPOTHESES,
  resolveTargetHitOrder,
} from "../src/lib/indicator-target-observations.js";

const start = new Date("2026-08-01T00:00:00.000Z");
const candle = (offset: number, high: number, low = 100, close = 101) => ({
  time: start.getTime() + offset * 15 * 60_000,
  open: "100",
  high: String(high),
  low: String(low),
  close: String(close),
  volume: "1",
});

describe("indicator target observation hypotheses", () => {
  test("creates exactly three fixed long targets, all at least +8%", () => {
    const candidates = buildIndicatorTargetCandidates({
      signalId: 44,
      trackedSignalId: 92,
      entryPrice: 100,
      isShort: false,
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.targetPct),
      [8, 12, 16],
    );
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((candidate) => candidate.targetPct >= 8));
    const targetPrices = candidates.map((candidate) =>
      calculateHypothesisTargetPrice({
        entryPrice: candidate.entryPrice,
        targetPct: candidate.targetPct,
        isShort: candidate.isShort,
      }),
    );
    assert.deepEqual(
      targetPrices.map((price) => Math.round(price * 100) / 100),
      [108, 112, 116],
    );
    assert.ok(
      INDICATOR_TARGET_HYPOTHESES.every((hypothesis) =>
        hypothesis.label.includes("not_trade_exit"),
      ),
    );
  });

  test("caches identical market-history requests within one worker batch", async () => {
    let calls = 0;
    const rows = [candle(0, 109)];
    const getCached = createKlineRangeCache(async () => {
      calls += 1;
      return rows;
    });
    const [first, second] = await Promise.all([
      getCached(
        "BTC-USDT",
        "15m",
        start.getTime(),
        start.getTime() + 30 * 60_000,
        {
          strictPayload: true,
        },
      ),
      getCached(
        "BTC-USDT",
        "15m",
        start.getTime(),
        start.getTime() + 30 * 60_000,
        {
          strictPayload: true,
        },
      ),
    ]);
    assert.equal(calls, 1);
    assert.strictEqual(first, second);
  });

  test("freezes immutable entry indicator provenance with explicit missing coverage", () => {
    const telemetry = { "1h": { rsi: 61, source: "closed_candle" } };
    const input = {
      entryIndicatorTelemetry: telemetry,
      entryIndicatorTimeframe: "1h",
      entryIndicatorCandleCloseAt: start,
      entryIndicatorSource: "bingx",
      entryMetricsProvenance: {
        rsi: { source: "signal_time", observedAt: start.toISOString() },
      },
    };
    const frozen = freezeIndicatorProvenance(input);
    telemetry["1h"]!.rsi = 2;
    assert.equal(frozen.status, "entry_indicator_telemetry_frozen");
    assert.equal((frozen.payload!.values as typeof telemetry)["1h"]!.rsi, 61);

    const missing = freezeIndicatorProvenance({
      ...input,
      entryIndicatorTelemetry: null,
    });
    assert.equal(missing.status, "missing_entry_indicator_telemetry");
    assert.equal(missing.payload?.coverage, "missing");
  });

  test("freezes all entry-prefixed tracker metrics with per-field coverage", () => {
    const oi = { entryOi30m: 4.2, entryRsi1h: null, entryCvd1h: true };
    const enrollmentAt = new Date("2026-08-02T00:00:00.000Z");
    const snapshot = freezeEntryMetricsSnapshot(
      {
        detectedAt: start,
        ...oi,
        entryIndicatorTelemetry: { "1h": { adx14: 22 } },
        entryMetricsProvenance: {
          entryOi30m: {
            source: "signal_fire",
            observedAt: start.toISOString(),
          },
        },
      },
      enrollmentAt,
    );
    oi.entryOi30m = 90;
    const values = snapshot.values as typeof oi & Record<string, unknown>;
    assert.equal(values.entryOi30m, 4.2);
    assert.equal(values.entryCvd1h, true);
    assert.equal(snapshot.coverageStatus, "partial");
    assert.equal(snapshot.signalAt, start.toISOString());
    assert.equal(snapshot.enrollmentAt, enrollmentAt.toISOString());
    assert.equal("observedAt" in snapshot, false);
    assert.equal(snapshot.provenanceStatus, "partial");
    assert.equal(
      (snapshot.fieldProvenance as Record<string, { status: string }>)
        .entryOi30m!.status,
      "provenanced",
    );
    assert.equal(
      (snapshot.fieldProvenance as Record<string, { status: string }>)
        .entryCvd1h!.status,
      "unknown_observation_time",
    );

    const reconstructed = freezeEntryMetricsSnapshot(
      {
        detectedAt: start,
        entryOi30m: 4.2,
        entryMetricsProvenance: {
          entryOi30m: {
            source: "prescan_snapshot",
            observedAt: new Date(start.getTime() - 60_000).toISOString(),
          },
        },
      },
      enrollmentAt,
    );
    assert.equal(reconstructed.cohortKind, "reconstructed_prescan_snapshot");
    assert.equal(
      (
        reconstructed.entryMetricsProvenance as Record<
          string,
          { source: string }
        >
      ).entryOi30m!.source,
      "prescan_snapshot",
    );
    assert.equal(
      (snapshot.fieldCoverage as Record<string, string>).entryRsi1h,
      "missing",
    );
  });

  test("closed OHLC gaps retry before unknown terminalization", () => {
    assert.deepEqual(
      classifyNoHitHistoryOutcome({
        continuousCoverage: false,
        tradeClosedAt: null,
      }),
      { status: "awaiting_hit", followupStatus: "not_started" },
    );
    assert.deepEqual(
      classifyNoHitHistoryOutcome({
        continuousCoverage: false,
        tradeClosedAt: new Date(start.getTime() + 10 * 60 * 60_000),
      }),
      { status: "awaiting_hit", followupStatus: "not_started" },
    );
    assert.deepEqual(
      classifyNoHitHistoryOutcome({
        continuousCoverage: false,
        tradeClosedAt: new Date(start.getTime() + 10 * 60 * 60_000),
        retryWindowExpired: true,
      }),
      { status: "unknown", followupStatus: "unavailable" },
    );
    assert.deepEqual(
      classifyNoHitHistoryOutcome({
        continuousCoverage: true,
        tradeClosedAt: new Date(start.getTime() + 10 * 60 * 60_000),
      }),
      { status: "no_hit_before_close", followupStatus: "not_applicable" },
    );
  });

  test("records first 15m hit only when its conservative close precedes trade close", () => {
    const bars = [candle(0, 105), candle(1, 109), candle(2, 120)];
    const closedAt = new Date(start.getTime() + 2 * 15 * 60_000);
    const hit = findFirstConfirmedTargetHit({
      candles: bars,
      targetPrice: 108,
      isShort: false,
      signalAt: start,
      tradeClosedAt: closedAt,
      now: new Date(start.getTime() + 4 * 15 * 60_000),
    });
    assert.equal(hit?.hitAt.getTime(), start.getTime() + 2 * 15 * 60_000);
    assert.equal(hit?.candleOpenedAt.getTime(), start.getTime() + 15 * 60_000);

    const tradeClosedInsideHitCandle = findFirstConfirmedTargetHit({
      candles: [candle(0, 110)],
      targetPrice: 108,
      isShort: false,
      signalAt: start,
      tradeClosedAt: new Date(start.getTime() + 10 * 60_000),
      now: new Date(start.getTime() + 15 * 60_000),
    });
    assert.equal(tradeClosedInsideHitCandle, null);
  });

  test("missing historical candles cannot prove first-hit order", () => {
    const sparse = [candle(1, 109)];
    assert.equal(
      hasContinuousClosed15mCoverage({
        candles: sparse,
        startAt: start,
        endAt: new Date(start.getTime() + 30 * 60_000),
      }),
      false,
    );
  });

  test("a later hit cannot be first while the signal-overlap boundary candle is missing", () => {
    const signalAt = new Date(start.getTime() + 5 * 60_000);
    const laterHitOnly = [candle(1, 109)];
    const hit = findFirstConfirmedTargetHit({
      candles: laterHitOnly,
      targetPrice: 108,
      isShort: false,
      signalAt,
      tradeClosedAt: null,
      now: new Date(start.getTime() + 45 * 60_000),
    });
    assert.equal(hit?.hitAt.getTime(), start.getTime() + 30 * 60_000);
    assert.equal(
      hasCompleteNoHitBoundaryEvidence({
        candles: laterHitOnly,
        startAt: signalAt,
        endAt: hit!.hitAt,
        now: new Date(start.getTime() + 45 * 60_000),
      }),
      false,
    );
    assert.equal(
      hasCompleteNoHitBoundaryEvidence({
        candles: [candle(0, 107), ...laterHitOnly],
        startAt: signalAt,
        endAt: hit!.hitAt,
        now: new Date(start.getTime() + 45 * 60_000),
      }),
      true,
    );
  });

  test("closed short-trade history requires its boundary candle to be present and closed", () => {
    const closeAt = new Date(start.getTime() + 10 * 60_000);
    assert.equal(
      hasContinuousClosed15mCoverage({
        candles: [],
        startAt: start,
        endAt: closeAt,
      }),
      false,
    );
    assert.equal(
      hasCompleteNoHitBoundaryEvidence({
        candles: [],
        startAt: start,
        endAt: closeAt,
        now: new Date(start.getTime() + 10 * 60_000),
      }),
      false,
    );
    const bars = [candle(0, 107)];
    assert.equal(
      hasCompleteNoHitBoundaryEvidence({
        candles: bars,
        startAt: start,
        endAt: closeAt,
        now: new Date(start.getTime() + 10 * 60_000),
      }),
      false,
    );
    assert.equal(
      hasCompleteNoHitBoundaryEvidence({
        candles: bars,
        startAt: start,
        endAt: closeAt,
        now: new Date(start.getTime() + 15 * 60_000),
      }),
      true,
    );
  });

  test("overlapping fire-time candle is ambiguous only when its wick touches target", () => {
    const signalAt = new Date(start.getTime() + 5 * 60_000);
    assert.equal(
      hasAmbiguousSignalOverlap({
        candles: [candle(0, 109)],
        targetPrice: 108,
        isShort: false,
        signalAt,
      }),
      true,
    );
    assert.equal(
      hasAmbiguousSignalOverlap({
        candles: [candle(0, 107)],
        targetPrice: 108,
        isShort: false,
        signalAt,
      }),
      false,
    );
  });

  test("target wick in trade-closing 15m candle cannot be ordered before close", () => {
    const tradeClosedAt = new Date(start.getTime() + 5 * 60_000);
    assert.equal(
      hasAmbiguousTradeCloseOverlap({
        candles: [candle(0, 109)],
        targetPrice: 108,
        isShort: false,
        tradeClosedAt,
      }),
      true,
    );
    assert.equal(
      hasAmbiguousTradeCloseOverlap({
        candles: [candle(0, 107)],
        targetPrice: 108,
        isShort: false,
        tradeClosedAt,
      }),
      false,
    );
  });

  test("earlier confirmed hit wins over a later ambiguous trade-closing candle", () => {
    const tradeClosedAt = new Date(start.getTime() + 37 * 60_000);
    const candles = [candle(0, 109), candle(1, 107), candle(2, 120)];
    const result = resolveTargetHitOrder({
      candles,
      targetPrice: 108,
      isShort: false,
      signalAt: start,
      tradeClosedAt,
      now: new Date(start.getTime() + 45 * 60_000),
    });
    assert.equal(result.kind, "confirmed_hit");
    if (result.kind === "confirmed_hit") {
      assert.equal(result.hit.candleOpenedAt.getTime(), start.getTime());
    }
    assert.equal(
      resolveTargetHitOrder({
        candles: [candle(0, 107), candle(1, 107), candle(2, 120)],
        targetPrice: 108,
        isShort: false,
        signalAt: start,
        tradeClosedAt,
        now: new Date(start.getTime() + 45 * 60_000),
      }).kind,
      "ambiguous_trade_close",
    );
  });

  test("captures post-hit 72h price and favorable range independently of trade close", () => {
    const bars = Array.from({ length: 288 }, (_, index) =>
      candle(index, 110 + (index % 3), 98, 105),
    );
    const result = calculateTargetFollowup({
      candles: bars,
      hitAt: start,
      hitPrice: 100,
      isShort: false,
      now: new Date(start.getTime() + 72 * 60 * 60_000),
    });
    assert.equal(result.status, "complete");
    assert.equal(result.priceAt72h, 105);
    assert.equal(result.priceAt72hChangePct, 5);
    assert.equal(result.sampleCount, 288);
    assert.equal(result.maxFavorablePct, 12);
    assert.equal(result.minFavorablePct, -2);

    const oneMissing = calculateTargetFollowup({
      candles: bars.filter((_, index) => index !== 80),
      hitAt: start,
      hitPrice: 100,
      isShort: false,
      now: new Date(start.getTime() + 72 * 60 * 60_000),
    });
    assert.equal(oneMissing.status, "partial");
    assert.equal(oneMissing.priceAt72h, 105);
    assert.equal(oneMissing.sampleCount, 287);

    const duplicateCandle = calculateTargetFollowup({
      candles: [...bars, bars[100]!],
      hitAt: start,
      hitPrice: 100,
      isShort: false,
      now: new Date(start.getTime() + 72 * 60 * 60_000),
    });
    assert.equal(duplicateCandle.status, "partial");
    assert.equal(duplicateCandle.sampleCount, 288);
  });

  test("labels missing or sparse post-hit history instead of imputing outcome", () => {
    const missing = calculateTargetFollowup({
      candles: [],
      hitAt: start,
      hitPrice: 100,
      isShort: false,
      now: new Date(start.getTime() + 72 * 60 * 60_000),
    });
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.priceAt72h, null);

    const partial = calculateTargetFollowup({
      candles: [candle(287, 105, 99, 104)],
      hitAt: start,
      hitPrice: 100,
      isShort: false,
      now: new Date(start.getTime() + 72 * 60 * 60_000),
    });
    assert.equal(partial.status, "partial");
    assert.equal(partial.priceAt72h, 104);
    assert.equal(partial.sampleCount, 1);
  });

  test("durable contract is idempotent, restart reclaimable, and multiworker leased", () => {
    const implementation = readFileSync(
      new URL("../src/lib/indicator-target-observations.ts", import.meta.url),
      "utf8",
    );
    const schema = readFileSync(
      new URL(
        "../../../lib/db/src/schema/indicatorTargetObservations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(schema, /indicator_target_observation_tracked_target_unique/);
    assert.match(schema, /indicator_target_observation_experiments/);
    assert.match(implementation, /\.onConflictDoNothing\(\)/);
    assert.match(implementation, /FOR UPDATE SKIP LOCKED/);
    assert.match(
      implementation,
      /observation\.lease_until IS NULL OR observation\.lease_until < \$\{now\}/,
    );
    assert.match(implementation, /claim_token = \$\{claimToken\}/);
    assert.match(implementation, /closedAt/);
    assert.match(implementation, /indicator_provenance/);
    assert.match(implementation, /followup_deadline \+ interval '7 days'/);
    assert.match(implementation, /observation\.updated_at/);
    assert.match(implementation, /observation\.next_retry_at/);
    assert.match(
      implementation,
      /FOLLOWUP_RETRY_DELAY_MS = 12 \* 60 \* 60_000/,
    );
    assert.match(implementation, /postHit\.length === expectedSampleCount/);
    assert.match(implementation, /noDuplicateCandles/);
    assert.match(
      implementation,
      /hasCompleteNoHitBoundaryEvidence\(\{\s+candles,\s+startAt: row\.signal_at,\s+endAt: hit\.hitAt/,
    );
    assert.match(
      implementation,
      /abneon_snapshot_status = 'awaiting_entry_snapshot'/,
    );
    assert.match(implementation, /tracked\.closed_at/);
    assert.match(implementation, /indicator_target_observation_experiments/);
    assert.match(
      implementation,
      /ON CONFLICT \(experiment_version\) DO NOTHING/,
    );
    assert.match(
      implementation,
      /trackedSignalsTable\.detectedAt,\s+indicatorTargetObservationExperimentsTable\.startAt/,
    );
    assert.match(implementation, /createKlineRangeCache\(\)/);
    assert.match(implementation, /count\(DISTINCT observation\.target_pct\)/);
    assert.match(implementation, /observation\.target_pct IN \(8, 12, 16\)/);
    assert.match(implementation, /history_retry_started_at/);
    assert.match(
      implementation,
      /history_retry_started_at \+ interval '7 days' <= \$\{now\}/,
    );
    assert.match(
      implementation,
      /tracked_signals_indicator_target_close_capture/,
    );
    assert.match(
      implementation,
      /AFTER INSERT OR UPDATE OF closed_at, status ON tracked_signals/,
    );
    assert.match(implementation, /observation\.followup_status = 'pending'/);
    assert.match(
      implementation,
      /observation\.followup_status = 'pending'\s+AND observation\.followup_deadline <= \$\{now\}/,
    );
    assert.match(
      implementation,
      /UPDATE indicator_target_observations observation\s+SET trade_closed_at/,
    );
  });
});
