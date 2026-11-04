import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrailingAnalysis,
  buildTrailingTradeDetail,
  getTrailingMarketRegime,
  isTrailingAnalysisClosedOutcome,
  buildRunnerV1CandidateReport,
  replayTrailingVariant,
  replayRunnerV1Candidate,
  type TrailingAnalysisTrade,
} from "../src/lib/trailing-analysis.js";

test("includes only measurable cancelled outcomes in the replay cohort", () => {
  assert.equal(
    isTrailingAnalysisClosedOutcome({
      status: "cancelled",
      exitPrice: 101,
      pnlPct: 1,
    }),
    true,
  );
  assert.equal(
    isTrailingAnalysisClosedOutcome({
      status: "cancelled",
      exitPrice: null,
      pnlPct: null,
    }),
    false,
  );
  assert.equal(
    isTrailingAnalysisClosedOutcome({
      status: "reclassified",
      exitPrice: 101,
      pnlPct: 1,
    }),
    false,
  );
});

const trade: TrailingAnalysisTrade = {
  signalId: 1272,
  symbol: "BTR-USDT",
  sentimentKey: "stealth_breakout",
  isShort: false,
  detectedAt: "2026-08-24T06:00:00.000Z",
  closedAt: "2026-08-24T09:00:00.000Z",
  entryPrice: 100,
  actualExitPrice: 105,
  actualPnlPct: 5,
  actualPeakPnlPct: 16,
  entryBtc24h: 1.92,
  firstTargetPct: 10,
  actualActivationPct: 15,
  actualTrailingGapPct: 10,
  wasActualTrailing: true,
};

const candles = [
  {
    time: Date.parse("2026-08-24T06:15:00.000Z"),
    open: "100",
    high: "106",
    low: "100",
    close: "105",
    volume: "1",
  },
  {
    time: Date.parse("2026-08-24T06:30:00.000Z"),
    open: "105",
    high: "116",
    low: "110",
    close: "115",
    volume: "1",
  },
  {
    time: Date.parse("2026-08-24T06:45:00.000Z"),
    open: "115",
    high: "115",
    low: "103",
    close: "104",
    volume: "1",
  },
  {
    time: Date.parse("2026-08-24T10:00:00.000Z"),
    open: "104",
    high: "205",
    low: "103",
    close: "200",
    volume: "1",
  },
];

test("replays activation plus gap without changing the actual result", () => {
  assert.deepEqual(
    replayTrailingVariant({
      trade,
      candles,
      activationPct: 10,
      trailingGapPct: 10,
    }),
    { candidatePnlPct: 6, hit: true, ambiguous: false },
  );
  assert.equal(trade.actualPnlPct, 5);
});

test("excludes an intrabar stop whose activation order is unknowable", () => {
  assert.deepEqual(
    replayTrailingVariant({
      trade,
      candles: [
        {
          time: Date.parse("2026-08-24T06:15:00.000Z"),
          open: "100",
          high: "120",
          low: "100",
          close: "115",
          volume: "1",
        },
      ],
      activationPct: 10,
      trailingGapPct: 10,
    }),
    { candidatePnlPct: null, hit: true, ambiguous: true },
  );
});

test("does not use pre-entry extremes from the containing 15m candle", () => {
  const nonAlignedTrade = {
    ...trade,
    detectedAt: "2026-08-24T06:05:00.000Z",
  };
  assert.deepEqual(
    replayTrailingVariant({
      trade: nonAlignedTrade,
      candles: [
        {
          time: Date.parse("2026-08-24T06:00:00.000Z"),
          open: "100",
          high: "130",
          low: "99",
          close: "120",
          volume: "1",
        },
      ],
      activationPct: 10,
      trailingGapPct: 10,
    }),
    { candidatePnlPct: 5, hit: false, ambiguous: false },
  );
});

test("excludes a possible stop hit in the candle overlapping actual close", () => {
  const closingTrade = {
    ...trade,
    closedAt: "2026-08-24T06:20:00.000Z",
  };
  assert.deepEqual(
    replayTrailingVariant({
      trade: closingTrade,
      candles: [
        {
          time: Date.parse("2026-08-24T06:15:00.000Z"),
          open: "100",
          high: "101",
          low: "89",
          close: "95",
          volume: "1",
        },
      ],
      activationPct: 0,
      trailingGapPct: 10,
    }),
    { candidatePnlPct: null, hit: false, ambiguous: true },
  );
});

test("replays valid candles after close through the fixed detection horizon", () => {
  const replay = replayTrailingVariant({
    trade,
    activationPct: 10,
    trailingGapPct: 10,
    candles: [
      {
        time: Date.parse("2026-08-24T06:30:00.000Z"),
        open: "100",
        high: "115",
        low: "110",
        close: "112",
        volume: "1",
      },
      // 08:45–09:00 contains the actual close and is excluded.
      {
        time: Date.parse("2026-08-24T08:45:00.000Z"),
        open: "112",
        high: "120",
        low: "95",
        close: "110",
        volume: "1",
      },
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "110",
        high: "112",
        low: "110",
        close: "111",
        volume: "1",
      },
      {
        time: Date.parse("2026-08-24T09:15:00.000Z"),
        open: "111",
        high: "112",
        low: "104",
        close: "104",
        volume: "1",
      },
      // Five days from detection: outside the replay horizon.
      {
        time: Date.parse("2026-08-29T06:15:00.000Z"),
        open: "109",
        high: "200",
        low: "108",
        close: "200",
        volume: "1",
      },
    ],
  });
  assert.deepEqual(replay, {
    candidatePnlPct: 5,
    hit: true,
    ambiguous: false,
  });
});

test("reports the impulse runner v1 weighted candidate separately", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    signalId: 9001,
    sentimentKey: "impulse_buy",
    actualPnlPct: 5,
    actualPeakPnlPct: 5,
  };
  const runner = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "105",
        high: "135",
        low: "120",
        close: "130",
        volume: "1",
      },
      {
        time: Date.parse("2026-08-24T09:15:00.000Z"),
        open: "130",
        high: "130",
        low: "104",
        close: "104",
        volume: "1",
      },
    ],
  });
  assert.deepEqual(runner, {
    runnerPnlPct: 5,
    weightedPnlPct: 5,
    hit: true,
    hitType: "trailing_stop",
    ambiguous: false,
    coverageComplete: false,
    coverageStatus: "incomplete",
  });
  const report = buildRunnerV1CandidateReport({
    trades: [impulseTrade],
    candlesBySignal: new Map([
      [
        impulseTrade.signalId,
        [
          {
            time: Date.parse("2026-08-24T09:00:00.000Z"),
            open: "105",
            high: "135",
            low: "120",
            close: "130",
            volume: "1",
          },
          {
            time: Date.parse("2026-08-24T09:15:00.000Z"),
            open: "130",
            high: "130",
            low: "104",
            close: "104",
            volume: "1",
          },
        ],
      ],
    ]),
  });
  assert.equal(report.key, "impulse_runner_v1");
  assert.equal(report.trades, 1);
  assert.equal(report.totalWeightedPnlPct, 5);
});

test("runner replay reports zero and incomplete coverage without fabricating PnL", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    sentimentKey: "impulse_buy",
    actualPnlPct: 8,
  };
  const empty = replayRunnerV1Candidate({ trade: impulseTrade, candles: [] });
  assert.equal(empty.runnerPnlPct, null);
  assert.equal(empty.weightedPnlPct, null);
  assert.equal(empty.coverageStatus, "zero_candles");
  const incomplete = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "105",
        high: "110",
        low: "104",
        close: "108",
        volume: "1",
      },
    ],
  });
  assert.equal(incomplete.runnerPnlPct, null);
  assert.equal(incomplete.weightedPnlPct, null);
  assert.equal(incomplete.coverageStatus, "incomplete");
  assert.equal(incomplete.hit, false);
});

test("runner replay preserves ambiguity when activation and stop share one candle", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    sentimentKey: "impulse_buy",
    actualPnlPct: 8,
  };
  const replay = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "105",
        high: "140",
        low: "100",
        close: "110",
        volume: "1",
      },
    ],
  });
  assert.equal(replay.ambiguous, true);
  assert.equal(replay.runnerPnlPct, null);
  assert.equal(replay.weightedPnlPct, null);
});

test("runner replay distinguishes missing start and internal candle gaps", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    sentimentKey: "impulse_buy",
    actualPnlPct: 8,
  };
  const hitCandle = {
    time: Date.parse("2026-08-24T09:30:00.000Z"),
    open: "130",
    high: "130",
    low: "104",
    close: "104",
    volume: "1",
  };
  const missingStart = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:15:00.000Z"),
        open: "105",
        high: "135",
        low: "120",
        close: "130",
        volume: "1",
      },
      hitCandle,
    ],
  });
  assert.equal(missingStart.hit, true);
  assert.equal(missingStart.runnerPnlPct, null);
  assert.equal(missingStart.coverageStatus, "incomplete");

  const internalGap = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "105",
        high: "135",
        low: "120",
        close: "130",
        volume: "1",
      },
      hitCandle,
    ],
  });
  assert.equal(internalGap.hit, true);
  assert.equal(internalGap.runnerPnlPct, null);
  assert.equal(internalGap.coverageStatus, "incomplete");
});

test("runner hit remains measurable when a later candle gap is after the hit", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    sentimentKey: "impulse_buy",
    actualPnlPct: 8,
  };
  const replay = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles: [
      {
        time: Date.parse("2026-08-24T09:00:00.000Z"),
        open: "105",
        high: "135",
        low: "120",
        close: "130",
        volume: "1",
      },
      {
        time: Date.parse("2026-08-24T09:15:00.000Z"),
        open: "130",
        high: "130",
        low: "104",
        close: "104",
        volume: "1",
      },
      // 09:30 is intentionally absent; the hit at 09:15 is still a
      // continuously observed outcome from runner inception.
      {
        time: Date.parse("2026-08-24T09:45:00.000Z"),
        open: "104",
        high: "105",
        low: "103",
        close: "104",
        volume: "1",
      },
    ],
  });
  assert.equal(replay.hit, true);
  assert.equal(replay.runnerPnlPct, 5);
  assert.equal(replay.coverageComplete, false);
  assert.equal(replay.coverageStatus, "incomplete");
});

test("runner replay excludes a candle beginning exactly at the horizon", () => {
  const impulseTrade: TrailingAnalysisTrade = {
    ...trade,
    sentimentKey: "impulse_buy",
    actualPnlPct: 8,
    actualExitPrice: 100,
    actualPeakPnlPct: 0,
  };
  const first = Date.parse("2026-08-24T09:00:00.000Z");
  const horizon = Date.parse("2026-08-28T06:00:00.000Z");
  const candles = Array.from(
    { length: (horizon - first) / (15 * 60_000) },
    (_, index) => ({
      time: first + index * 15 * 60_000,
      open: "100",
      high: "100",
      low: "100",
      close: "100",
      volume: "1",
    }),
  );
  candles.push({
    time: horizon,
    open: "100",
    high: "100",
    low: "1",
    close: "1",
    volume: "1",
  });
  const replay = replayRunnerV1Candidate({
    trade: impulseTrade,
    candles,
  });
  assert.equal(replay.hit, false);
  assert.equal(replay.coverageComplete, true);
  assert.equal(replay.coverageStatus, "complete");
});

test("reports BTR post-exit upside from direction-aware candle extremes", () => {
  const detail = buildTrailingTradeDetail(
    trade,
    candles,
    new Date("2026-08-25T00:00:00.000Z"),
  );
  assert.equal(detail.isBtr, true);
  assert.equal(detail.postExitMaxPnlPct, 105);
  assert.equal(detail.missedUpsidePct, 100);
  assert.equal(detail.marketRegime, "btc_bullish");
});

test("ranks all twenty requested activation and gap profiles", () => {
  const report = buildTrailingAnalysis({
    trades: [trade],
    candlesBySignal: new Map([[trade.signalId, candles]]),
    generatedAt: new Date("2026-08-25T00:00:00.000Z"),
  });
  assert.equal(report.variants.length, 20);
  assert.deepEqual(
    [...new Set(report.variants.map((variant) => variant.trailingGapPct))],
    [5, 8, 10, 12, 15],
  );
  assert.deepEqual(
    [...new Set(report.variants.map((variant) => variant.activationKey))],
    ["immediate", "after_5", "after_10", "first_target"],
  );
  assert.equal(report.recommendation.status, "provisional");
  assert.equal(report.methodology.liveRuleChanged, true);
  assert.deepEqual(report.livePolicy, {
    key: "impulse_runner_v1",
    mode: "live",
    appliesTo: "newly_policy_stamped_positions",
  });
  assert.match(report.methodology.runnerCandidate, /is live/);
  assert.doesNotMatch(
    report.methodology.runnerCandidate,
    /is observation-only/,
  );
});

test("classifies BTC entry context without inventing missing regimes", () => {
  assert.equal(getTrailingMarketRegime(-1), "btc_bearish");
  assert.equal(getTrailingMarketRegime(0.5), "btc_neutral");
  assert.equal(getTrailingMarketRegime(1), "btc_bullish");
  assert.equal(getTrailingMarketRegime(null), "unknown");
});
