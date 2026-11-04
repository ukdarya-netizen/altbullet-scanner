import type { BingXKline } from "./bingx.js";

export const TRAILING_ANALYSIS_SINCE = "2026-08-23T00:00:00.000Z";
export const TRAILING_ANALYSIS_GAPS = [5, 8, 10, 12, 15] as const;
const TRAILING_CANDLE_MS = 15 * 60_000;
export const TRAILING_ANALYSIS_HORIZON_DAYS = 4;
export const IMPULSE_RUNNER_V1 = {
  key: "impulse_runner_v1" as const,
  coreWeight: 0.8,
  runnerWeight: 0.2,
  emergencyStopPct: 10,
  trailingActivationPct: 30,
  trailingGapPct: 30,
};
export const TRAILING_ANALYSIS_CLOSED_STATUSES = [
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
  "cancelled",
] as const;
export const TRAILING_ANALYSIS_ACTIVATIONS = [
  { key: "immediate", label: "Сразу после входа", thresholdPct: 0 },
  { key: "after_5", label: "После +5%", thresholdPct: 5 },
  { key: "after_10", label: "После +10%", thresholdPct: 10 },
] as const;

export type TrailingActivationKey =
  | (typeof TRAILING_ANALYSIS_ACTIVATIONS)[number]["key"]
  | "first_target";

export type TrailingAnalysisTrade = {
  signalId: number;
  symbol: string;
  sentimentKey: string;
  isShort: boolean;
  detectedAt: Date | string;
  analysisStartAt?: Date | string | null;
  closedAt: Date | string | null;
  entryPrice: number;
  actualExitPrice: number | null;
  actualPnlPct: number | null;
  actualPeakPnlPct: number | null;
  entryBtc24h: number | null;
  firstTargetPct: number;
  actualActivationPct: number | null;
  actualTrailingGapPct: number | null;
  /** Persisted stop depth, when available, for the runner candidate. */
  runnerEmergencyStopPct?: number | null;
  wasActualTrailing: boolean;
};

export type TrailingTradeDetail = {
  signalId: number;
  symbol: string;
  sentimentKey: string;
  direction: "long" | "short";
  marketRegime: string;
  detectedAt: string;
  closedAt: string | null;
  peakPnlPct: number | null;
  exitPrice: number | null;
  exitPnlPct: number | null;
  postExitMaxPnlPct: number | null;
  missedUpsidePct: number | null;
  postExitObservedUntil: string | null;
  actualActivationPct: number | null;
  actualTrailingGapPct: number | null;
  isBtr: boolean;
  isSimilarToBtr: boolean;
  dataComplete: boolean;
};

export type TrailingVariantResult = {
  key: string;
  activationKey: TrailingActivationKey;
  activationLabel: string;
  activationPct: number;
  trailingGapPct: number;
  trades: number;
  excludedAmbiguous: number;
  hits: number;
  ambiguousHits: number;
  averageCandidatePnlPct: number | null;
  totalCandidatePnlPct: number;
  averageActualPnlPct: number | null;
  totalActualPnlPct: number;
  totalDeltaPp: number;
  downsideDeviationPct: number | null;
  riskAdjustedEv: number | null;
  worstTradePnlPct: number | null;
};

export type RunnerV1CandidateTrade = {
  signalId: number;
  runnerPnlPct: number | null;
  weightedPnlPct: number | null;
  hit: boolean;
  hitType: "emergency_stop" | "trailing_stop" | null;
  ambiguous: boolean;
  coverageComplete: boolean;
  coverageStatus: "complete" | "zero_candles" | "incomplete" | "censored";
};

export type RunnerV1CandidateReport = {
  key: typeof IMPULSE_RUNNER_V1.key;
  policyVersion: typeof IMPULSE_RUNNER_V1.key;
  coreWeight: number;
  runnerWeight: number;
  emergencyStopPct: number;
  trailingActivationPct: number;
  trailingGapPct: number;
  trades: number;
  hits: number;
  excludedAmbiguous: number;
  averageRunnerPnlPct: number | null;
  averageWeightedPnlPct: number | null;
  totalWeightedPnlPct: number;
  completeCoverageTrades: number;
  incompleteCoverageTrades: number;
  zeroCandleTrades: number;
  candidates: RunnerV1CandidateTrade[];
};

type NormalizedCandle = {
  time: number;
  high: number;
  low: number;
  close: number;
};

export function isTrailingAnalysisClosedOutcome(input: {
  status: string;
  exitPrice: number | null;
  pnlPct: number | null;
}): boolean {
  return (
    TRAILING_ANALYSIS_CLOSED_STATUSES.includes(
      input.status as (typeof TRAILING_ANALYSIS_CLOSED_STATUSES)[number],
    ) &&
    input.exitPrice != null &&
    Number.isFinite(input.exitPrice) &&
    input.exitPrice > 0 &&
    input.pnlPct != null &&
    Number.isFinite(input.pnlPct)
  );
}

function finite(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeCandles(candles: readonly BingXKline[]): NormalizedCandle[] {
  return candles
    .map((candle) => {
      const high = finite(candle.high);
      const low = finite(candle.low);
      const close = finite(candle.close);
      return high == null || low == null || close == null
        ? null
        : { time: candle.time, high, low, close };
    })
    .filter((row): row is NormalizedCandle => row != null)
    .sort((left, right) => left.time - right.time);
}

function pnl(entryPrice: number, price: number, isShort: boolean): number {
  return (
    ((isShort ? entryPrice - price : price - entryPrice) / entryPrice) * 100
  );
}

function trailingPriceFromPeakPnl(
  entryPrice: number,
  peakPrice: number,
  trailingGapPct: number,
  isShort: boolean,
): number {
  const protectedPnlPct = pnl(entryPrice, peakPrice, isShort) - trailingGapPct;
  return isShort
    ? entryPrice * (1 - protectedPnlPct / 100)
    : entryPrice * (1 + protectedPnlPct / 100);
}

function favorablePrice(candle: NormalizedCandle, isShort: boolean): number {
  return isShort ? candle.low : candle.high;
}

function stopTouched(
  candle: NormalizedCandle,
  stopPrice: number,
  isShort: boolean,
): boolean {
  return isShort ? candle.high >= stopPrice : candle.low <= stopPrice;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function average(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getTrailingMarketRegime(
  entryBtc24h: number | null,
): "btc_bearish" | "btc_neutral" | "btc_bullish" | "unknown" {
  if (entryBtc24h == null || !Number.isFinite(entryBtc24h)) return "unknown";
  if (entryBtc24h <= -1) return "btc_bearish";
  if (entryBtc24h >= 1) return "btc_bullish";
  return "btc_neutral";
}

export function replayTrailingVariant(input: {
  trade: TrailingAnalysisTrade;
  candles: readonly BingXKline[];
  activationPct: number;
  trailingGapPct: number;
}): {
  candidatePnlPct: number | null;
  hit: boolean;
  ambiguous: boolean;
} {
  const { trade } = input;
  const closedAt = trade.closedAt
    ? new Date(trade.closedAt).getTime()
    : Infinity;
  const startAt = new Date(trade.analysisStartAt ?? trade.detectedAt).getTime();
  const horizonAt =
    new Date(trade.detectedAt).getTime() +
    TRAILING_ANALYSIS_HORIZON_DAYS * 24 * 60 * 60_000;
  const firstCandleAt =
    Math.floor(startAt / TRAILING_CANDLE_MS) * TRAILING_CANDLE_MS;
  const candles = normalizeCandles(input.candles).filter(
    (candle) => candle.time >= firstCandleAt && candle.time <= horizonAt,
  );
  let activated = input.activationPct === 0;
  let peakPrice = trade.entryPrice;
  let stopPrice: number | null = activated
    ? trailingPriceFromPeakPnl(
        trade.entryPrice,
        peakPrice,
        input.trailingGapPct,
        trade.isShort,
      )
    : null;
  let ambiguous = false;

  for (const candle of candles) {
    const overlapsEntry = candle.time < startAt;
    const overlapsClose =
      closedAt !== Infinity &&
      candle.time < closedAt &&
      candle.time + TRAILING_CANDLE_MS > closedAt;
    if (overlapsEntry || overlapsClose) {
      if (
        activated &&
        stopPrice != null &&
        stopTouched(candle, stopPrice, trade.isShort)
      ) {
        if (overlapsEntry) {
          return { candidatePnlPct: null, hit: true, ambiguous: true };
        }
        // The candle containing the actual close has no knowable high/low
        // order. Exclude it, but keep replaying later candles through the
        // fixed detection horizon.
        ambiguous = true;
      }
      // High/low before the exact entry timestamp cannot arm or raise a stop.
      continue;
    }
    if (
      activated &&
      stopPrice != null &&
      stopTouched(candle, stopPrice, trade.isShort)
    ) {
      return {
        candidatePnlPct: ambiguous
          ? null
          : round(pnl(trade.entryPrice, stopPrice, trade.isShort), 4),
        hit: true,
        ambiguous,
      };
    }
    const favorable = favorablePrice(candle, trade.isShort);
    const favorablePnl = pnl(trade.entryPrice, favorable, trade.isShort);
    const activatesNow = !activated && favorablePnl >= input.activationPct;
    if (activatesNow) activated = true;
    if (!activated) continue;

    const nextPeakPrice = trade.isShort
      ? Math.min(peakPrice, favorable)
      : Math.max(peakPrice, favorable);
    const raised = nextPeakPrice !== peakPrice;
    peakPrice = nextPeakPrice;
    const nextStopPrice = trailingPriceFromPeakPnl(
      trade.entryPrice,
      peakPrice,
      input.trailingGapPct,
      trade.isShort,
    );
    if (
      (activatesNow || raised) &&
      stopTouched(candle, nextStopPrice, trade.isShort)
    ) {
      return {
        candidatePnlPct: null,
        hit: true,
        ambiguous: true,
      };
    }
    stopPrice = nextStopPrice;
  }

  return {
    candidatePnlPct: ambiguous ? null : trade.actualPnlPct,
    hit: false,
    ambiguous,
  };
}

/**
 * Observation-only replay for the selected impulse_buy runner policy.
 * The runner does not exist before the confirmed core close, so the candle
 * containing that close is deliberately excluded rather than guessing its
 * intrabar high/low ordering.
 */
export function replayRunnerV1Candidate(input: {
  trade: TrailingAnalysisTrade;
  candles: readonly BingXKline[];
}): {
  runnerPnlPct: number | null;
  weightedPnlPct: number | null;
  hit: boolean;
  hitType: "emergency_stop" | "trailing_stop" | null;
  ambiguous: boolean;
  coverageComplete: boolean;
  coverageStatus: "complete" | "zero_candles" | "incomplete" | "censored";
} {
  const { trade } = input;
  if (
    trade.sentimentKey !== "impulse_buy" ||
    trade.isShort ||
    !trade.wasActualTrailing ||
    !trade.closedAt ||
    trade.actualPnlPct == null
  ) {
    return {
      runnerPnlPct: null,
      weightedPnlPct: null,
      hit: false,
      hitType: null,
      ambiguous: false,
      coverageComplete: false,
      coverageStatus: "censored",
    };
  }
  const closedAt = new Date(trade.closedAt).getTime();
  const horizonAt =
    new Date(trade.detectedAt).getTime() +
    TRAILING_ANALYSIS_HORIZON_DAYS * 24 * 60 * 60_000;
  const emergencyStopPct = Math.min(
    IMPULSE_RUNNER_V1.emergencyStopPct,
    trade.runnerEmergencyStopPct != null &&
      Number.isFinite(trade.runnerEmergencyStopPct) &&
      trade.runnerEmergencyStopPct > 0
      ? trade.runnerEmergencyStopPct
      : IMPULSE_RUNNER_V1.emergencyStopPct,
  );
  const emergencyStopPrice = trade.entryPrice * (1 - emergencyStopPct / 100);
  const rows = normalizeCandles(input.candles).filter(
    (candle) => candle.time >= closedAt && candle.time < horizonAt,
  );
  const firstBoundary =
    Math.ceil(closedAt / TRAILING_CANDLE_MS) * TRAILING_CANDLE_MS;
  // A candle beginning exactly at the horizon is outside the observation
  // window. The final admissible start is the preceding 15m boundary.
  const expectedLastBoundary =
    Math.ceil(horizonAt / TRAILING_CANDLE_MS) * TRAILING_CANDLE_MS -
    TRAILING_CANDLE_MS;
  let fullCoverageContinuous = rows.length > 0;
  let expectedBoundary = firstBoundary;
  for (const candle of rows) {
    if (candle.time !== expectedBoundary) fullCoverageContinuous = false;
    expectedBoundary = candle.time + TRAILING_CANDLE_MS;
  }
  let prefixCoverageContinuous = rows.length > 0;
  expectedBoundary = firstBoundary;
  const coverageEndAt =
    rows.length > 0 ? rows[rows.length - 1]!.time + TRAILING_CANDLE_MS : null;
  const coverageComplete =
    fullCoverageContinuous &&
    rows[0]?.time === firstBoundary &&
    rows.at(-1)?.time === expectedLastBoundary &&
    coverageEndAt != null &&
    coverageEndAt >= horizonAt;
  const coverageStatus =
    rows.length === 0
      ? "zero_candles"
      : coverageComplete
        ? "complete"
        : "incomplete";
  let peakPrice = Math.max(
    trade.entryPrice,
    trade.actualExitPrice ?? trade.entryPrice,
    trade.entryPrice * (1 + Math.max(0, trade.actualPeakPnlPct ?? 0) / 100),
  );
  let trailingStopPrice: number | null =
    pnl(trade.entryPrice, peakPrice, false) >=
    IMPULSE_RUNNER_V1.trailingActivationPct
      ? trailingPriceFromPeakPnl(
          trade.entryPrice,
          peakPrice,
          IMPULSE_RUNNER_V1.trailingGapPct,
          false,
        )
      : null;
  let ambiguous = false;

  for (const candle of rows) {
    if (candle.time !== expectedBoundary) prefixCoverageContinuous = false;
    expectedBoundary = candle.time + TRAILING_CANDLE_MS;
    if (candle.low <= emergencyStopPrice) {
      return {
        runnerPnlPct:
          ambiguous || !prefixCoverageContinuous ? null : -emergencyStopPct,
        weightedPnlPct:
          ambiguous || !prefixCoverageContinuous
            ? null
            : round(
                IMPULSE_RUNNER_V1.coreWeight * trade.actualPnlPct -
                  IMPULSE_RUNNER_V1.runnerWeight * emergencyStopPct,
                4,
              ),
        hit: true,
        hitType: "emergency_stop",
        ambiguous,
        coverageComplete,
        coverageStatus,
      };
    }
    if (trailingStopPrice != null && candle.low <= trailingStopPrice) {
      return {
        runnerPnlPct:
          ambiguous || !prefixCoverageContinuous
            ? null
            : round(pnl(trade.entryPrice, trailingStopPrice, false), 4),
        weightedPnlPct:
          ambiguous || !prefixCoverageContinuous
            ? null
            : round(
                IMPULSE_RUNNER_V1.coreWeight * trade.actualPnlPct +
                  IMPULSE_RUNNER_V1.runnerWeight *
                    pnl(trade.entryPrice, trailingStopPrice, false),
                4,
              ),
        hit: true,
        hitType: "trailing_stop",
        ambiguous,
        coverageComplete,
        coverageStatus,
      };
    }
    const nextPeak = Math.max(peakPrice, candle.high);
    const activatedNow =
      trailingStopPrice == null &&
      pnl(trade.entryPrice, nextPeak, false) >=
        IMPULSE_RUNNER_V1.trailingActivationPct;
    const raised = nextPeak > peakPrice;
    peakPrice = nextPeak;
    const nextStop =
      pnl(trade.entryPrice, peakPrice, false) >=
      IMPULSE_RUNNER_V1.trailingActivationPct
        ? trailingPriceFromPeakPnl(
            trade.entryPrice,
            peakPrice,
            IMPULSE_RUNNER_V1.trailingGapPct,
            false,
          )
        : null;
    if (
      (activatedNow || raised) &&
      nextStop != null &&
      candle.low <= nextStop
    ) {
      ambiguous = true;
    }
    trailingStopPrice = nextStop;
  }

  if (ambiguous) {
    return {
      runnerPnlPct: null,
      weightedPnlPct: null,
      hit: true,
      hitType: "trailing_stop",
      ambiguous: true,
      coverageComplete,
      coverageStatus,
    };
  }
  if (!coverageComplete) {
    return {
      runnerPnlPct: null,
      weightedPnlPct: null,
      hit: false,
      hitType: null,
      ambiguous: false,
      coverageComplete: false,
      coverageStatus,
    };
  }
  const finalPrice = rows.at(-1)?.close ?? trade.actualExitPrice;
  const runnerPnlPct =
    finalPrice == null
      ? null
      : round(pnl(trade.entryPrice, finalPrice, false), 4);
  return {
    runnerPnlPct,
    weightedPnlPct:
      runnerPnlPct == null
        ? null
        : round(
            IMPULSE_RUNNER_V1.coreWeight * trade.actualPnlPct +
              IMPULSE_RUNNER_V1.runnerWeight * runnerPnlPct,
            4,
          ),
    hit: false,
    hitType: null,
    ambiguous: false,
    coverageComplete: true,
    coverageStatus: "complete",
  };
}

export function buildRunnerV1CandidateReport(input: {
  trades: readonly TrailingAnalysisTrade[];
  candlesBySignal: ReadonlyMap<number, readonly BingXKline[]>;
}): RunnerV1CandidateReport {
  const candidates = input.trades
    .filter(
      (trade) =>
        trade.sentimentKey === "impulse_buy" &&
        !trade.isShort &&
        trade.wasActualTrailing &&
        trade.closedAt != null,
    )
    .map((trade) => {
      const replay = replayRunnerV1Candidate({
        trade,
        candles: input.candlesBySignal.get(trade.signalId) ?? [],
      });
      return {
        signalId: trade.signalId,
        runnerPnlPct: replay.runnerPnlPct,
        weightedPnlPct: replay.weightedPnlPct,
        hit: replay.hit,
        hitType: replay.hitType,
        ambiguous: replay.ambiguous,
        coverageComplete: replay.coverageComplete,
        coverageStatus: replay.coverageStatus,
      };
    });
  const measurable = candidates.filter(
    (
      candidate,
    ): candidate is typeof candidate & {
      runnerPnlPct: number;
      weightedPnlPct: number;
    } => candidate.runnerPnlPct != null && candidate.weightedPnlPct != null,
  );
  return {
    ...IMPULSE_RUNNER_V1,
    policyVersion: IMPULSE_RUNNER_V1.key,
    trades: measurable.length,
    hits: candidates.filter(
      (candidate) => candidate.hit && candidate.runnerPnlPct != null,
    ).length,
    excludedAmbiguous: candidates.filter((candidate) => candidate.ambiguous)
      .length,
    averageRunnerPnlPct: average(
      measurable.map((candidate) => candidate.runnerPnlPct),
    ),
    averageWeightedPnlPct: average(
      measurable.map((candidate) => candidate.weightedPnlPct),
    ),
    totalWeightedPnlPct: round(
      measurable.reduce((sum, candidate) => sum + candidate.weightedPnlPct, 0),
    ),
    completeCoverageTrades: candidates.filter(
      (candidate) => candidate.coverageComplete,
    ).length,
    incompleteCoverageTrades: candidates.filter(
      (candidate) => !candidate.coverageComplete,
    ).length,
    zeroCandleTrades: candidates.filter(
      (candidate) => candidate.coverageStatus === "zero_candles",
    ).length,
    candidates,
  };
}

export function buildTrailingTradeDetail(
  trade: TrailingAnalysisTrade,
  candles: readonly BingXKline[],
  generatedAt: Date,
): TrailingTradeDetail {
  const rows = normalizeCandles(candles);
  const closedAtMs = trade.closedAt ? new Date(trade.closedAt).getTime() : null;
  const horizonAt =
    new Date(trade.detectedAt).getTime() +
    TRAILING_ANALYSIS_HORIZON_DAYS * 24 * 60 * 60_000;
  const postExit =
    closedAtMs == null
      ? []
      : rows.filter((row) => row.time > closedAtMs && row.time <= horizonAt);
  const postExitPeakPrice =
    postExit.length === 0
      ? null
      : trade.isShort
        ? Math.min(...postExit.map((row) => row.low))
        : Math.max(...postExit.map((row) => row.high));
  const postExitMaxPnlPct =
    postExitPeakPrice == null
      ? null
      : pnl(trade.entryPrice, postExitPeakPrice, trade.isShort);
  const exitPnlPct = trade.actualPnlPct;
  const missedUpsidePct =
    postExitMaxPnlPct == null || exitPnlPct == null
      ? null
      : Math.max(0, postExitMaxPnlPct - exitPnlPct);
  const isBtr = trade.symbol.toUpperCase().startsWith("BTR-");

  return {
    signalId: trade.signalId,
    symbol: trade.symbol,
    sentimentKey: trade.sentimentKey,
    direction: trade.isShort ? "short" : "long",
    marketRegime: getTrailingMarketRegime(trade.entryBtc24h),
    detectedAt: new Date(trade.detectedAt).toISOString(),
    closedAt: trade.closedAt ? new Date(trade.closedAt).toISOString() : null,
    peakPnlPct:
      trade.actualPeakPnlPct == null ? null : round(trade.actualPeakPnlPct),
    exitPrice:
      trade.actualExitPrice == null ? null : round(trade.actualExitPrice, 8),
    exitPnlPct: exitPnlPct == null ? null : round(exitPnlPct),
    postExitMaxPnlPct:
      postExitMaxPnlPct == null ? null : round(postExitMaxPnlPct),
    missedUpsidePct: missedUpsidePct == null ? null : round(missedUpsidePct),
    postExitObservedUntil:
      postExit.length === 0
        ? null
        : new Date(
            Math.min(generatedAt.getTime(), postExit.at(-1)!.time),
          ).toISOString(),
    actualActivationPct: trade.actualActivationPct,
    actualTrailingGapPct: trade.actualTrailingGapPct,
    isBtr,
    isSimilarToBtr: !isBtr && (missedUpsidePct ?? 0) >= 25,
    dataComplete:
      rows.length > 0 && (closedAtMs == null || postExit.length > 0),
  };
}

function variantResult(
  trades: readonly TrailingAnalysisTrade[],
  candlesBySignal: ReadonlyMap<number, readonly BingXKline[]>,
  activation: {
    key: TrailingActivationKey;
    label: string;
    thresholdFor: (trade: TrailingAnalysisTrade) => number;
  },
  trailingGapPct: number,
): TrailingVariantResult {
  const outcomes = trades
    .map((trade) => {
      const actual = trade.actualPnlPct;
      const candles = candlesBySignal.get(trade.signalId) ?? [];
      if (actual == null || candles.length === 0) return null;
      const activationPct = activation.thresholdFor(trade);
      const replay = replayTrailingVariant({
        trade,
        candles,
        activationPct,
        trailingGapPct,
      });
      return {
        actual,
        activationPct,
        candidatePnlPct: replay.candidatePnlPct,
        hit: replay.hit,
        ambiguous: replay.ambiguous,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row != null);
  const resolved = outcomes.filter(
    (
      row,
    ): row is typeof row & {
      candidatePnlPct: number;
    } => row.candidatePnlPct != null,
  );
  const candidate = resolved.map((row) => row.candidatePnlPct);
  const actual = resolved.map((row) => row.actual);
  const deltas = resolved.map((row) => row.candidatePnlPct - row.actual);
  const negative = deltas.filter((value) => value < 0);
  const downsideDeviation =
    negative.length === 0
      ? 0
      : Math.sqrt(
          negative.reduce((sum, value) => sum + value ** 2, 0) /
            negative.length,
        );
  const avgCandidate = average(candidate);

  return {
    key: `${activation.key}:${trailingGapPct}`,
    activationKey: activation.key,
    activationLabel: activation.label,
    activationPct:
      outcomes.length === 0
        ? activation.key === "first_target"
          ? 0
          : activation.thresholdFor(trades[0]!)
        : round(
            outcomes.reduce((sum, row) => sum + row.activationPct, 0) /
              outcomes.length,
          ),
    trailingGapPct,
    trades: resolved.length,
    excludedAmbiguous: outcomes.filter((row) => row.ambiguous).length,
    hits: outcomes.filter((row) => row.hit).length,
    ambiguousHits: outcomes.filter((row) => row.ambiguous).length,
    averageCandidatePnlPct: avgCandidate == null ? null : round(avgCandidate),
    totalCandidatePnlPct: round(
      candidate.reduce((sum, value) => sum + value, 0),
    ),
    averageActualPnlPct: actual.length === 0 ? null : round(average(actual)!),
    totalActualPnlPct: round(actual.reduce((sum, value) => sum + value, 0)),
    totalDeltaPp: round(
      candidate.reduce((sum, value) => sum + value, 0) -
        actual.reduce((sum, value) => sum + value, 0),
    ),
    downsideDeviationPct: round(downsideDeviation),
    riskAdjustedEv:
      deltas.length === 0
        ? null
        : round((average(deltas) ?? 0) - downsideDeviation),
    worstTradePnlPct:
      candidate.length === 0 ? null : round(Math.min(...candidate)),
  };
}

export function buildTrailingAnalysis(input: {
  trades: readonly TrailingAnalysisTrade[];
  candlesBySignal: ReadonlyMap<number, readonly BingXKline[]>;
  generatedAt: Date;
}) {
  const activations = [
    ...TRAILING_ANALYSIS_ACTIVATIONS.map((activation) => ({
      key: activation.key,
      label: activation.label,
      thresholdFor: () => activation.thresholdPct,
    })),
    {
      key: "first_target" as const,
      label: "После первого тейка",
      thresholdFor: (trade: TrailingAnalysisTrade) => trade.firstTargetPct,
    },
  ];
  const variants = activations.flatMap((activation) =>
    TRAILING_ANALYSIS_GAPS.map((gap) =>
      variantResult(input.trades, input.candlesBySignal, activation, gap),
    ),
  );
  const runnerV1 = buildRunnerV1CandidateReport({
    trades: input.trades,
    candlesBySignal: input.candlesBySignal,
  });
  const ranked = variants
    .filter(
      (
        variant,
      ): variant is TrailingVariantResult & { riskAdjustedEv: number } =>
        variant.riskAdjustedEv != null,
    )
    .sort(
      (left, right) =>
        right.riskAdjustedEv - left.riskAdjustedEv ||
        right.totalCandidatePnlPct - left.totalCandidatePnlPct,
    );
  const trades = input.trades
    .filter((trade) => trade.wasActualTrailing)
    .map((trade) =>
      buildTrailingTradeDetail(
        trade,
        input.candlesBySignal.get(trade.signalId) ?? [],
        input.generatedAt,
      ),
    )
    .sort((left, right) =>
      (right.closedAt ?? "").localeCompare(left.closedAt ?? ""),
    );

  const dimensions = (selector: (trade: TrailingAnalysisTrade) => string) =>
    [...new Set(input.trades.map(selector))].sort().map((key) => {
      const signalIds = new Set(
        input.trades
          .filter((trade) => selector(trade) === key)
          .map((trade) => trade.signalId),
      );
      const cohort = input.trades.filter((trade) =>
        signalIds.has(trade.signalId),
      );
      const cohortCandles = new Map(
        cohort.map((trade) => [
          trade.signalId,
          input.candlesBySignal.get(trade.signalId) ?? [],
        ]),
      );
      const cohortVariants = activations.flatMap((activation) =>
        TRAILING_ANALYSIS_GAPS.map((gap) =>
          variantResult(cohort, cohortCandles, activation, gap),
        ),
      );
      const best = cohortVariants
        .filter((variant) => variant.riskAdjustedEv != null)
        .sort(
          (left, right) =>
            (right.riskAdjustedEv ?? -Infinity) -
            (left.riskAdjustedEv ?? -Infinity),
        )[0];
      return { key, trades: cohort.length, bestVariant: best ?? null };
    });

  return {
    generatedAt: input.generatedAt.toISOString(),
    // The replay profiles and runner comparison below are observational. The
    // policy metadata is explicit separately: impulse_runner_v1 is live for
    // positions stamped with that policy at creation time.
    observationOnly: true,
    livePolicy: {
      key: IMPULSE_RUNNER_V1.key,
      mode: "live" as const,
      appliesTo: "newly_policy_stamped_positions" as const,
    },
    since: TRAILING_ANALYSIS_SINCE,
    sample: {
      trades: input.trades.length,
      withCandles: input.trades.filter(
        (trade) => (input.candlesBySignal.get(trade.signalId)?.length ?? 0) > 0,
      ).length,
      minimumForDecision: 20,
      sufficient: (ranked[0]?.trades ?? 0) >= 20,
    },
    methodology: {
      timeframe: "15m",
      gaps: [...TRAILING_ANALYSIS_GAPS],
      activations: activations.map((activation) => ({
        key: activation.key,
        label: activation.label,
      })),
      riskAdjustedEv:
        "average per-trade delta versus actual PnL minus downside deviation of negative deltas; higher is better",
      sameCandlePolicy:
        "A prior-candle stop is checked before raising it. A stop touched in the same 15m candle that activates or raises it is excluded as ambiguous.",
      boundaryPolicy: `The entry-overlap candle cannot arm or raise trailing. The close-overlap candle is excluded from replay because its high/low order is ambiguous; later candles are replayed through ${TRAILING_ANALYSIS_HORIZON_DAYS} days from detection.`,
      liveRuleChanged: true,
      runnerCandidate:
        "impulse_runner_v1 is live for newly policy-stamped positions. Replay/candidate comparison is observational; after a confirmed standard trailing close, 20% remains open with an entry-anchored -10% emergency stop, +30% trailing activation, and a 30-point gap.",
      runnerCoverage:
        "Runner candidates with zero candles or a horizon ending before four days are excluded from PnL unless an unambiguous emergency/trailing stop was hit before coverage ended; close-overlap and same-candle activation/raise hits remain ambiguous.",
    },
    recommendation: {
      status: (ranked[0]?.trades ?? 0) >= 20 ? "decision_ready" : "provisional",
      bestVariant: ranked[0] ?? null,
      reason:
        (ranked[0]?.trades ?? 0) >= 20
          ? "Best risk-adjusted EV on the completed trailing cohort."
          : "Fewer than 20 trades: show the current leader, but keep the live rule unchanged.",
    },
    variants,
    runnerV1,
    trades,
    btr: trades.find((trade) => trade.isBtr) ?? null,
    similarToBtr: trades.filter((trade) => trade.isSimilarToBtr),
    byPattern: dimensions((trade) => trade.sentimentKey),
    byDirection: dimensions((trade) => (trade.isShort ? "short" : "long")),
    byMarketRegime: dimensions((trade) =>
      getTrailingMarketRegime(trade.entryBtc24h),
    ),
  };
}
