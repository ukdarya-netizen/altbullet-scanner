import {
  minTurnoverUsd,
  STEALTH_MIN_TURNOVER_PCT_OF_MCAP,
} from "./turnover-threshold.js";
import {
  confirmStealthFourHourBreakout,
  FOUR_HOURS_MS,
  isStealthStructureReadyToArm,
  refineStealthBreakoutEntry,
  type BreakoutCandle,
  type BreakoutEvidence,
  type StealthFourHourConfirmation,
  type StealthThirtyMinuteRefinement,
} from "./breakout-analysis.js";
import type { AutoRangePineResult } from "./auto-range-pine.js";

export const STEALTH_ARM_TTL_MS = 72 * 60 * 60 * 1000;
export const STEALTH_BREAKOUT_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
export const STEALTH_BREAKOUT_VOLUME_LOOKBACK = 20;
export const STEALTH_AUTO_RANGE_ARM_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export interface StealthAutoRangeIdentity {
  version: "auto_range_pine_v1" | "auto_range_pine_v1_1h";
  /** Missing only on legacy rows, which are treated as BingX provenance. */
  venue?: AutoRangeVenue;
  /** Frozen venue set that independently qualified this lifecycle. */
  confirmingVenues?: AutoRangeVenue[];
  openedAt: number;
  anchorAt: number;
  upper: number;
  lower: number;
  candleCutoff: number;
}

export type AutoRangeVenue =
  | "bingx"
  | "binance"
  | "okx"
  | "bybit"
  | "gate"
  | "kucoin"
  | "mexc"
  | "bitget"
  | "htx"
  | "kraken";

export type StealthAutoRangeBreakoutEvent = NonNullable<
  AutoRangePineResult["latestUpsideBreakout"]
> & { venue?: AutoRangeVenue };

function autoRangeVenue(
  identity: { venue?: AutoRangeVenue } | null | undefined,
): AutoRangeVenue {
  return identity?.venue ?? "bingx";
}

export function sameStealthAutoRangeIdentity(
  left:
    | (Pick<
        StealthAutoRangeIdentity,
        "openedAt" | "anchorAt" | "upper" | "lower"
      > & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
  right:
    | (Pick<
        StealthAutoRangeIdentity,
        "openedAt" | "anchorAt" | "upper" | "lower"
      > & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    sameStealthAutoRangeInstance(left, right) &&
    autoRangeVenue(left) === autoRangeVenue(right) &&
    left.upper === right.upper &&
    left.lower === right.lower,
  );
}

export function sameStealthAutoRangeInstance(
  left:
    | (Pick<StealthAutoRangeIdentity, "openedAt" | "anchorAt"> & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
  right:
    | (Pick<StealthAutoRangeIdentity, "openedAt" | "anchorAt"> & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    (!left.version || !right.version || left.version === right.version) &&
    autoRangeVenue(left) === autoRangeVenue(right) &&
    left.openedAt === right.openedAt &&
    left.anchorAt === right.anchorAt,
  );
}

export function updateStealthAutoRangeBounds(
  current: StealthAutoRangeIdentity,
  observed: Pick<
    StealthAutoRangeIdentity,
    "version" | "openedAt" | "anchorAt" | "upper" | "lower"
  > & { venue?: AutoRangeVenue },
  candleCutoff = current.candleCutoff,
): StealthAutoRangeIdentity | null {
  if (!sameStealthAutoRangeInstance(current, observed)) return null;
  return {
    ...current,
    venue: autoRangeVenue(observed),
    upper: observed.upper,
    lower: observed.lower,
    candleCutoff,
  };
}

export function autoRangeIdentityFromResult(
  result: AutoRangePineResult,
  candleCutoff: number,
  timeframe: "4h" | "1h" = "4h",
  venue: AutoRangeVenue = "bingx",
): StealthAutoRangeIdentity | null {
  const range = result.activeConfirmedRange;
  if (
    result.status !== "ready" ||
    !range ||
    !Number.isFinite(candleCutoff) ||
    !(range.upper > range.lower)
  ) {
    return null;
  }
  return {
    version:
      timeframe === "1h" ? "auto_range_pine_v1_1h" : "auto_range_pine_v1",
    venue,
    openedAt: range.openedAt,
    anchorAt: range.anchorAt,
    upper: range.upper,
    lower: range.lower,
    candleCutoff,
  };
}

export function autoRangeEventMatchesIdentity(
  identity:
    | (Pick<
        StealthAutoRangeIdentity,
        "openedAt" | "anchorAt" | "upper" | "lower"
      > & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
  event:
    | (NonNullable<AutoRangePineResult["latestUpsideBreakout"]> & {
        version?: StealthAutoRangeIdentity["version"];
        venue?: AutoRangeVenue;
      })
    | null
    | undefined,
): boolean {
  return Boolean(
    identity && event && sameStealthAutoRangeIdentity(identity, event),
  );
}

export function calculateStealthAtr(
  candles: readonly BreakoutCandle[],
  period = 14,
): number | null {
  const ranges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    const range = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
    if (Number.isFinite(range) && range > 0) ranges.push(range);
  }
  if (ranges.length === 0) return null;
  return (
    ranges.slice(-period).reduce((sum, value) => sum + value, 0) /
    Math.min(period, ranges.length)
  );
}

export interface StealthBreakoutParticipationTelemetry {
  capturedAt: number;
  oi: { value: number | null; source: string; available: boolean };
  cvd: {
    value: {
      cvd15m: boolean | null;
      cvd30m: boolean | null;
      cvd1h: boolean | null;
      cvd4h: boolean | null;
    };
    source: string;
    available: boolean;
  };
  spotTaker: { value: number | null; source: string; available: boolean };
}

export type StealthBreakoutVolumeShadow =
  | {
      status: "available";
      method: "breakout_4h_base_volume_over_prior_mean";
      lookback: 20;
      breakoutCandleTime: number;
      breakoutVolume: number;
      breakoutTurnover: number;
      priorMeanVolume: number;
      ratio: number;
    }
  | {
      status: "unavailable";
      method: "breakout_4h_base_volume_over_prior_mean";
      lookback: 20;
      breakoutCandleTime: number | null;
      breakoutVolume: number | null;
      breakoutTurnover: number | null;
      priorMeanVolume: null;
      ratio: null;
      reason:
        | "missing_breakout_candle"
        | "insufficient_prior_candles"
        | "invalid_volume";
    };

export type StealthOneHourVolumeEvidence = {
  timeframe: "1h";
  breakoutCandleTime: number;
  closeTime: number;
  breakoutVolume: number | null;
  breakoutTurnover: number | null;
  priorMeanVolume: number | null;
  ratio: number | null;
  gatePassed: boolean;
  reason?:
    | "below_relative_volume"
    | "below_turnover"
    | "missing_volume"
    | "insufficient_history";
  minimumRatio: 0.3;
  minimumTurnover: number | null;
  turnoverGate?: "pct_of_market_cap" | "market_cap_unavailable";
};

/** Aggregated (CoinGlass, multi-exchange) USD volume; NaN when unavailable. */
const volumeUsdOf = (candle: BreakoutCandle): number =>
  candle.volumeUsd ?? Number.NaN;

function buildStealthOneHourVolumeEvidence(
  candles: readonly BreakoutCandle[],
  index: number,
  marketCapUsd?: number | null,
): StealthOneHourVolumeEvidence | null {
  const minTurnover = minTurnoverUsd(
    marketCapUsd,
    STEALTH_MIN_TURNOVER_PCT_OF_MCAP,
  );
  const turnoverGate =
    minTurnover == null
      ? ("market_cap_unavailable" as const)
      : ("pct_of_market_cap" as const);
  const candle = candles[index];
  const prior = candles.slice(Math.max(0, index - 20), index);
  if (!candle) return null;
  if (prior.length !== 20 || !Number.isFinite(candle.close)) {
    return {
      timeframe: "1h",
      breakoutCandleTime: candle.time,
      closeTime: candle.time + 60 * 60 * 1000,
      breakoutVolume: Number.isFinite(volumeUsdOf(candle))
        ? volumeUsdOf(candle)
        : null,
      breakoutTurnover: null,
      priorMeanVolume: null,
      ratio: null,
      gatePassed: false,
      reason: "insufficient_history",
      minimumRatio: 0.3,
      minimumTurnover: minTurnover,
      turnoverGate,
    };
  }
  const validVolume =
    Number.isFinite(volumeUsdOf(candle)) &&
    volumeUsdOf(candle) > 0 &&
    prior.every(
      (item) => Number.isFinite(volumeUsdOf(item)) && volumeUsdOf(item) > 0,
    );
  if (!validVolume) {
    return {
      timeframe: "1h",
      breakoutCandleTime: candle.time,
      closeTime: candle.time + 60 * 60 * 1000,
      breakoutVolume: Number.isFinite(volumeUsdOf(candle))
        ? volumeUsdOf(candle)
        : null,
      breakoutTurnover: null,
      priorMeanVolume: null,
      ratio: null,
      gatePassed: false,
      reason: "missing_volume",
      minimumRatio: 0.3,
      minimumTurnover: minTurnover,
      turnoverGate,
    };
  }
  const priorMeanVolume =
    prior.reduce((sum, item) => sum + volumeUsdOf(item), 0) / 20;
  const breakoutTurnover = volumeUsdOf(candle);
  const ratio = volumeUsdOf(candle) / priorMeanVolume;
  const reason =
    ratio < 0.3
      ? "below_relative_volume"
      : minTurnover != null && breakoutTurnover < minTurnover
        ? "below_turnover"
        : undefined;
  return {
    timeframe: "1h",
    breakoutCandleTime: candle.time,
    closeTime: candle.time + 60 * 60 * 1000,
    breakoutVolume: volumeUsdOf(candle),
    breakoutTurnover,
    priorMeanVolume,
    ratio,
    gatePassed: reason == null,
    ...(reason ? { reason } : {}),
    minimumRatio: 0.3,
    minimumTurnover: minTurnover,
    turnoverGate,
  };
}

export function buildStealthBreakoutVolumeShadow(
  candles: readonly BreakoutCandle[],
  breakoutIndex: number,
): StealthBreakoutVolumeShadow {
  const breakout = candles[breakoutIndex];
  if (!breakout) {
    return {
      status: "unavailable",
      method: "breakout_4h_base_volume_over_prior_mean",
      lookback: STEALTH_BREAKOUT_VOLUME_LOOKBACK,
      breakoutCandleTime: null,
      breakoutVolume: null,
      breakoutTurnover: null,
      priorMeanVolume: null,
      ratio: null,
      reason: "missing_breakout_candle",
    };
  }
  const prior = candles.slice(
    Math.max(0, breakoutIndex - STEALTH_BREAKOUT_VOLUME_LOOKBACK),
    breakoutIndex,
  );
  if (prior.length !== STEALTH_BREAKOUT_VOLUME_LOOKBACK) {
    return {
      status: "unavailable",
      method: "breakout_4h_base_volume_over_prior_mean",
      lookback: STEALTH_BREAKOUT_VOLUME_LOOKBACK,
      breakoutCandleTime: breakout.time,
      breakoutVolume: Number.isFinite(volumeUsdOf(breakout))
        ? volumeUsdOf(breakout)
        : null,
      breakoutTurnover:
        Number.isFinite(volumeUsdOf(breakout)) &&
        Number.isFinite(breakout.close)
          ? volumeUsdOf(breakout)
          : null,
      priorMeanVolume: null,
      ratio: null,
      reason: "insufficient_prior_candles",
    };
  }
  if (
    !Number.isFinite(volumeUsdOf(breakout)) ||
    volumeUsdOf(breakout) <= 0 ||
    prior.some(
      (candle) =>
        !Number.isFinite(volumeUsdOf(candle)) || volumeUsdOf(candle) <= 0,
    )
  ) {
    return {
      status: "unavailable",
      method: "breakout_4h_base_volume_over_prior_mean",
      lookback: STEALTH_BREAKOUT_VOLUME_LOOKBACK,
      breakoutCandleTime: breakout.time,
      breakoutVolume: Number.isFinite(volumeUsdOf(breakout))
        ? volumeUsdOf(breakout)
        : null,
      breakoutTurnover:
        Number.isFinite(volumeUsdOf(breakout)) &&
        Number.isFinite(breakout.close)
          ? volumeUsdOf(breakout)
          : null,
      priorMeanVolume: null,
      ratio: null,
      reason: "invalid_volume",
    };
  }
  const priorMeanVolume =
    prior.reduce((sum, candle) => sum + volumeUsdOf(candle), 0) /
    STEALTH_BREAKOUT_VOLUME_LOOKBACK;
  return {
    status: "available",
    method: "breakout_4h_base_volume_over_prior_mean",
    lookback: STEALTH_BREAKOUT_VOLUME_LOOKBACK,
    breakoutCandleTime: breakout.time,
    breakoutVolume: volumeUsdOf(breakout),
    breakoutTurnover: volumeUsdOf(breakout),
    priorMeanVolume,
    ratio: volumeUsdOf(breakout) / priorMeanVolume,
  };
}

export const STEALTH_PARTICIPATION_MIN_COMPLETED = 20;

export type StealthParticipationOutcome =
  | "profit"
  | "bu_stop"
  | "stop_loss"
  | "breakeven"
  | "expired";

export interface StealthParticipationCalibrationRow {
  firedAt: number;
  outcome: StealthParticipationOutcome;
  volumeRatio: number | null;
  turnover: number | null;
  oi30m: number | null;
  cvdPositiveCount: number | null;
  spotTakerNetBuy: number | null;
}

type StealthParticipationMetricKey =
  | "volumeRatio"
  | "turnover"
  | "oi30m"
  | "cvdPositiveCount"
  | "spotTakerNetBuy";

export interface StealthParticipationRuleReport {
  metric: StealthParticipationMetricKey;
  rule: string;
  available: number;
  unavailable: number;
  goodOutcomesLost: number;
  badOutcomesRemoved: number;
  goodLostPerBadRemoved: number | null;
}

export interface StealthParticipationCalibrationReport {
  decision: "shadow_only" | "eligible_for_live_hybrid_review";
  reason:
    | "insufficient_completed_fires"
    | "no_robust_zero_cost_rule"
    | "robust_zero_cost_rule";
  completed: number;
  minimumCompleted: number;
  chronologicalSplit: {
    firstHalf: number;
    secondHalf: number;
  };
  rules: StealthParticipationRuleReport[];
}

const isGoodStealthParticipationOutcome = (
  outcome: StealthParticipationOutcome,
) => outcome === "profit" || outcome === "bu_stop";
const isBadStealthParticipationOutcome = (
  outcome: StealthParticipationOutcome,
) => outcome === "stop_loss";

function reportStealthParticipationRule(
  rows: readonly StealthParticipationCalibrationRow[],
  metric: StealthParticipationMetricKey,
  threshold: number,
): StealthParticipationRuleReport {
  const available = rows.filter((row) => Number.isFinite(row[metric]));
  const excluded = available.filter(
    (row) => (row[metric] as number) < threshold,
  );
  const badOutcomesRemoved = excluded.filter((row) =>
    isBadStealthParticipationOutcome(row.outcome),
  ).length;
  const goodOutcomesLost = excluded.filter((row) =>
    isGoodStealthParticipationOutcome(row.outcome),
  ).length;
  return {
    metric,
    rule: `${metric} >= ${threshold}`,
    available: available.length,
    unavailable: rows.length - available.length,
    goodOutcomesLost,
    badOutcomesRemoved,
    goodLostPerBadRemoved:
      badOutcomesRemoved === 0 ? null : goodOutcomesLost / badOutcomesRemoved,
  };
}

export function analyzeStealthParticipation(
  input: readonly StealthParticipationCalibrationRow[],
): StealthParticipationCalibrationReport {
  const rows = [...input].sort((left, right) => left.firedAt - right.firedAt);
  const midpoint = Math.ceil(rows.length / 2);
  const candidates = [
    reportStealthParticipationRule(rows, "volumeRatio", 1),
    reportStealthParticipationRule(rows, "turnover", 100_000),
    reportStealthParticipationRule(rows, "oi30m", 0),
    reportStealthParticipationRule(rows, "cvdPositiveCount", 2),
    reportStealthParticipationRule(rows, "spotTakerNetBuy", 0),
  ];
  if (rows.length < STEALTH_PARTICIPATION_MIN_COMPLETED) {
    return {
      decision: "shadow_only",
      reason: "insufficient_completed_fires",
      completed: rows.length,
      minimumCompleted: STEALTH_PARTICIPATION_MIN_COMPLETED,
      chronologicalSplit: {
        firstHalf: midpoint,
        secondHalf: rows.length - midpoint,
      },
      rules: candidates,
    };
  }
  const halves = [rows.slice(0, midpoint), rows.slice(midpoint)];
  const robust = candidates.some((candidate) =>
    halves.every((half) => {
      const halfReport = reportStealthParticipationRule(
        half,
        candidate.metric,
        Number(candidate.rule.split(" ").at(-1)),
      );
      return (
        halfReport.badOutcomesRemoved > 0 && halfReport.goodOutcomesLost === 0
      );
    }),
  );
  return {
    decision: robust ? "eligible_for_live_hybrid_review" : "shadow_only",
    reason: robust ? "robust_zero_cost_rule" : "no_robust_zero_cost_rule",
    completed: rows.length,
    minimumCompleted: STEALTH_PARTICIPATION_MIN_COMPLETED,
    chronologicalSplit: {
      firstHalf: midpoint,
      secondHalf: rows.length - midpoint,
    },
    rules: candidates,
  };
}

export interface StealthArmedSnapshot {
  structureKey: string;
  breakoutSource: "horizontal" | "trendline";
  breakoutLevel: number;
  touches: number;
  armedAt: number;
  /** Event-time cursor: no 4H candle at or before this time can fire. */
  armedAfterFourHourCandleTime?: number;
  /** Kept as a read-compatible alias for historical callers/rows. */
  armedAfterOneHourCandleTime?: number;
  expiresAt: number;
  /** Internal fast-entry mode; never exposed as a sentiment/pattern key. */
  technicalMode?:
    | "four_hour"
    | "closed_30m"
    | "closed_1h_30m"
    | "auto_range_4h"
    | "auto_range_1h";
  autoRangeIdentity?: StealthAutoRangeIdentity;
  atr?: number;
  rawCrossObservedAt?: number | null;
  rawCrossCandleAt?: number | null;
  rawCrossPrice?: number | null;
  reclaimCount?: number;
  lastCandleAt?: number | null;
}

export type StealthArmedDecision = (
  | {
      status: "armed";
      reason:
        | "awaiting_later_4h_cross"
        | "awaiting_later_1h_cross_with_volume"
        | "awaiting_later_1h_auto_range_breakout";
    }
  | {
      status: "armed";
      reason:
        | "breakout_active_waiting_retest"
        | "breakout_active_waiting_30m_data"
        | "breakout_active_waiting_1h_data";
      firstCrossAt: number;
      confirmation: StealthFourHourConfirmation;
      refinement: StealthThirtyMinuteRefinement;
      volumeShadow: StealthBreakoutVolumeShadow;
    }
  | { status: "expired"; reason: "arm_ttl_elapsed" }
  | {
      status: "invalidated";
      reason: string;
      firstCrossAt: number;
      confirmation: StealthFourHourConfirmation;
      refinement: StealthThirtyMinuteRefinement;
      volumeShadow: StealthBreakoutVolumeShadow;
    }
  | {
      status: "qualified";
      reason: "later_frozen_level_cross";
      firstCrossAt: number;
      confirmation: StealthFourHourConfirmation;
      refinement: StealthThirtyMinuteRefinement;
      volumeShadow: StealthBreakoutVolumeShadow;
    }
) & {
  oneHourVolume?: StealthOneHourVolumeEvidence | null;
  closed30mState?: {
    rawCrossObservedAt: number | null;
    rawCrossCandleAt: number | null;
    rawCrossPrice: number | null;
    reclaimCount: number;
    lastCandleAt: number | null;
  };
};

export function buildStealthArmStructureKey(
  structure: Pick<
    BreakoutEvidence,
    "breakoutSource" | "breakoutLevel" | "touches" | "trendline" | "quietZone"
  >,
): string | null {
  if (
    !structure.quietZone ||
    structure.breakoutSource === "none" ||
    structure.breakoutLevel === null
  ) {
    return null;
  }
  if (structure.breakoutSource === "trendline" && structure.trendline) {
    return [
      "trendline",
      structure.trendline.startPrice.toPrecision(10),
      structure.trendline.endPrice.toPrecision(10),
      structure.trendline.startIndex,
      structure.trendline.endIndex,
    ].join(":");
  }
  return [
    "horizontal",
    structure.breakoutLevel.toPrecision(10),
    structure.touches,
  ].join(":");
}

export function buildStealthArmedSnapshot(input: {
  structure: Pick<
    BreakoutEvidence,
    | "status"
    | "breakoutSource"
    | "breakoutLevel"
    | "breakoutZone"
    | "distanceFromLevelPct"
    | "touches"
    | "trendline"
    | "quietZone"
  >;
  latestClosedFourHourCandleTime?: number;
  /** @deprecated compatibility for old replay callers; live callsites use 4H. */
  latestClosedOneHourCandleTime?: number;
  confirmationCandles?: readonly BreakoutCandle[];
  armedAt: number;
  ttlMs?: number;
  structureKeyPrefix?: string;
  technicalMode?:
    | "four_hour"
    | "closed_30m"
    | "closed_1h_30m"
    | "auto_range_4h"
    | "auto_range_1h";
  atr?: number;
}): StealthArmedSnapshot | null {
  const baseStructureKey = buildStealthArmStructureKey(input.structure);
  const structureKey =
    baseStructureKey && input.structureKeyPrefix
      ? `${input.structureKeyPrefix}:${baseStructureKey}`
      : baseStructureKey;
  if (
    structureKey === null ||
    input.structure.breakoutSource === "none" ||
    input.structure.breakoutLevel === null ||
    !Number.isFinite(
      input.latestClosedFourHourCandleTime ??
        input.latestClosedOneHourCandleTime,
    ) ||
    !Number.isFinite(input.armedAt)
  ) {
    return null;
  }
  if (
    input.confirmationCandles &&
    !isStealthStructureReadyToArm(input.structure, input.confirmationCandles)
  ) {
    return null;
  }
  return {
    structureKey,
    breakoutSource: input.structure.breakoutSource,
    breakoutLevel: input.structure.breakoutLevel,
    touches: input.structure.touches,
    armedAt: input.armedAt,
    armedAfterFourHourCandleTime:
      input.latestClosedFourHourCandleTime ??
      input.latestClosedOneHourCandleTime!,
    armedAfterOneHourCandleTime:
      input.latestClosedOneHourCandleTime ??
      input.latestClosedFourHourCandleTime!,
    expiresAt: input.armedAt + (input.ttlMs ?? STEALTH_ARM_TTL_MS),
    technicalMode: input.technicalMode ?? "four_hour",
    atr: input.atr,
  };
}

export function evaluateStealthArmedSetup(input: {
  arm: StealthArmedSnapshot;
  /** Closed 4H candles are the sole live breakout gate. */
  breakoutCandles4h?: readonly BreakoutCandle[];
  /** Closed 1H candles used by the explicit early-entry mode. */
  breakoutCandles1h?: readonly BreakoutCandle[];
  /** @deprecated alias retained for durable replay compatibility. */
  confirmationCandles?: readonly BreakoutCandle[];
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt: number;
  participationTelemetry?: StealthBreakoutParticipationTelemetry;
  autoRangeBreakoutEvent?: StealthAutoRangeBreakoutEvent | null;
  /** 1H Range fast path: breakout-candle spot or futures volume >= 10x. */
  fastVolumePass?: boolean;
  marketCapUsd?: number | null;
}): StealthArmedDecision {
  if (input.arm.technicalMode === "auto_range_4h") {
    return evaluateStealthAutoRangeSetup(input);
  }
  if (input.arm.technicalMode === "auto_range_1h") {
    return evaluateStealthAutoRangeOneHourSetup(input);
  }
  if (input.arm.technicalMode === "closed_30m") {
    return evaluateStealthClosed30mSetup(input);
  }
  if (input.arm.technicalMode === "closed_1h_30m") {
    return evaluateStealthClosedOneHourSetup(input);
  }
  const candles = [
    ...(input.breakoutCandles4h ?? input.confirmationCandles ?? []),
  ].sort((left, right) => left.time - right.time);
  const armCursor =
    input.arm.armedAfterFourHourCandleTime ??
    input.arm.armedAfterOneHourCandleTime ??
    input.arm.armedAt;
  if (
    input.arm.touches < 2 ||
    !Number.isFinite(input.arm.breakoutLevel) ||
    input.arm.breakoutLevel <= 0
  ) {
    return { status: "armed", reason: "awaiting_later_4h_cross" };
  }
  const firstEligible = candles.findIndex((candle) => candle.time > armCursor);
  if (firstEligible >= 0) {
    for (let index = firstEligible; index < candles.length; index += 1) {
      const previous = candles[index - 1];
      const current = candles[index]!;
      const rawCross =
        previous !== undefined &&
        previous.close <= input.arm.breakoutLevel &&
        current.close > input.arm.breakoutLevel;
      const finishedAt = current.time + FOUR_HOURS_MS;
      if (finishedAt > input.evaluatedAt) continue;
      const confirmation = confirmStealthFourHourBreakout(
        { breakoutLevel: input.arm.breakoutLevel },
        previous === undefined ? [current] : [previous, current],
        input.evaluatedAt,
      );
      if (!rawCross && !confirmation.crossed) continue;

      const firstCrossAt = finishedAt;
      if (firstCrossAt > input.arm.expiresAt) {
        return { status: "expired", reason: "arm_ttl_elapsed" };
      }
      const crossRefinement = refineStealthBreakoutEntry(
        { breakoutLevel: input.arm.breakoutLevel },
        input.refinementCandles.filter(
          (candle) => candle.time + 30 * 60 * 1000 <= firstCrossAt,
        ),
      );
      const volumeShadow = buildStealthBreakoutVolumeShadow(candles, index);
      const decisiveBreakout = confirmation.status === "fresh_breakout";
      // A raw wick/weak close is not the strategy breakout and must not consume
      // the frozen setup. Keep scanning for a later decisive first crossing.
      if (!decisiveBreakout) continue;

      if (input.evaluatedAt - firstCrossAt > STEALTH_BREAKOUT_ENTRY_TTL_MS) {
        return {
          status: "invalidated",
          reason: "breakout_entry_window_elapsed",
          firstCrossAt,
          confirmation,
          refinement: crossRefinement,
          volumeShadow,
        };
      }

      // Entry quality is evaluated at the current decision time, not only at
      // the original cross. A valid breakout remains active for 24 hours:
      // extended price waits for a retest, while a confirmed close back below
      // the frozen level invalidates the setup.
      const currentRefinement = refineStealthBreakoutEntry(
        { breakoutLevel: input.arm.breakoutLevel },
        input.refinementCandles.filter(
          (candle) => candle.time + 30 * 60 * 1000 <= input.evaluatedAt,
        ),
        {
          confirmationStartsAt: firstCrossAt,
          requiredConsecutiveCloses: 1,
        },
      );
      if (currentRefinement.status === "near_level") {
        return {
          status: "qualified",
          reason: "later_frozen_level_cross",
          firstCrossAt,
          confirmation,
          refinement: currentRefinement,
          volumeShadow,
        };
      }
      if (currentRefinement.status === "rejected") {
        return {
          status: "invalidated",
          reason: "breakout_rejected_below_level",
          firstCrossAt,
          confirmation,
          refinement: currentRefinement,
          volumeShadow,
        };
      }
      return {
        status: "armed",
        reason:
          currentRefinement.status === "extended"
            ? "breakout_active_waiting_retest"
            : "breakout_active_waiting_30m_data",
        firstCrossAt,
        confirmation,
        refinement: currentRefinement,
        volumeShadow,
      };
    }
  }
  if (input.evaluatedAt >= input.arm.expiresAt) {
    return { status: "expired", reason: "arm_ttl_elapsed" };
  }
  return { status: "armed", reason: "awaiting_later_4h_cross" };
}

/** Historical resistance arms are never eligible for new live trades. */
export function isLiveStealthBreakoutSource(levelSource: string): boolean {
  return levelSource === "auto_range_1h";
}

/**
 * Owner decision 2026-10-08: a replay of Auto Range depends on how much
 * history is loaded, so the frozen range can disappear exactly when price
 * breaks it (CTSI 2026-10-08). When the replay no longer yields the matching
 * event, the first closed bar after the arm that closes above the frozen upper
 * bound (previous close not more than 1% above it) is the breakout.
 */
function deriveFrozenRangeBreakoutEvent(
  identity: StealthAutoRangeIdentity,
  candles: readonly BreakoutCandle[],
  intervalMs: number,
  cursor: number,
  armedAt: number,
  evaluatedAt: number,
): StealthAutoRangeBreakoutEvent | null {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  for (let index = 1; index < sorted.length; index++) {
    const candle = sorted[index]!;
    const previous = sorted[index - 1]!;
    const closeTime = candle.time + intervalMs;
    if (
      candle.time <= cursor ||
      closeTime <= armedAt ||
      closeTime > evaluatedAt ||
      previous.time + intervalMs !== candle.time
    ) {
      continue;
    }
    if (
      candle.close > identity.upper &&
      previous.close <= identity.upper * (1 + 0.01)
    ) {
      return {
        upper: identity.upper,
        lower: identity.lower,
        openedAt: identity.openedAt,
        anchorAt: identity.anchorAt,
        breakoutCloseTime: closeTime,
        venue: identity.venue,
      } as StealthAutoRangeBreakoutEvent;
    }
  }
  return null;
}

function evaluateStealthAutoRangeSetup(input: {
  arm: StealthArmedSnapshot;
  breakoutCandles4h?: readonly BreakoutCandle[];
  breakoutCandles1h?: readonly BreakoutCandle[];
  evaluatedAt: number;
  autoRangeBreakoutEvent?: StealthAutoRangeBreakoutEvent | null;
}): StealthArmedDecision {
  const identity = input.arm.autoRangeIdentity;
  const candles = [...(input.breakoutCandles4h ?? [])].sort(
    (left, right) => left.time - right.time,
  );
  const event =
    identity &&
    autoRangeEventMatchesIdentity(identity, input.autoRangeBreakoutEvent)
      ? input.autoRangeBreakoutEvent
      : identity
        ? deriveFrozenRangeBreakoutEvent(
            identity,
            candles,
            FOUR_HOURS_MS,
            input.arm.armedAfterFourHourCandleTime ?? identity.candleCutoff,
            input.arm.armedAt,
            input.evaluatedAt,
          )
        : null;
  if (!identity || !event || !autoRangeEventMatchesIdentity(identity, event)) {
    return input.evaluatedAt >= input.arm.expiresAt
      ? { status: "expired", reason: "arm_ttl_elapsed" }
      : { status: "armed", reason: "awaiting_later_4h_cross" };
  }
  const eventCandleTime = event.breakoutCloseTime - FOUR_HOURS_MS;
  const cursor =
    input.arm.armedAfterFourHourCandleTime ?? identity.candleCutoff;
  const eventCandle = candles.find((candle) => candle.time === eventCandleTime);
  const previous = candles.find(
    (candle) => candle.time === eventCandleTime - FOUR_HOURS_MS,
  );
  if (
    !eventCandle ||
    !previous ||
    eventCandle.time <= cursor ||
    event.breakoutCloseTime > input.evaluatedAt
  ) {
    return input.evaluatedAt >= input.arm.expiresAt
      ? { status: "expired", reason: "arm_ttl_elapsed" }
      : { status: "armed", reason: "awaiting_later_4h_cross" };
  }

  // The Pine event is the sole 4H breakout gate. Generic crosses are not
  // considered because they do not prove this exact frozen range broke.
  const alreadyBroken = candles.some(
    (candle) =>
      candle.time >= identity.openedAt &&
      candle.time < previous.time &&
      candle.close > identity.upper,
  );
  const measured = confirmStealthFourHourBreakout(
    { breakoutLevel: identity.upper },
    [previous, eventCandle],
    input.evaluatedAt,
  );
  const confirmation: StealthFourHourConfirmation = {
    ...measured,
    status: "fresh_breakout",
    crossed: true,
    breakoutLevel: identity.upper,
    previousClose: previous.close,
    triggerCandle: eventCandle,
    reasons: [
      "Closed 4H upside-break event matches the frozen Auto Range identity",
    ],
  };
  const volumeShadow = buildStealthBreakoutVolumeShadow(
    candles,
    candles.findIndex((candle) => candle.time === eventCandleTime),
  );
  if (
    alreadyBroken ||
    input.evaluatedAt - event.breakoutCloseTime > STEALTH_BREAKOUT_ENTRY_TTL_MS
  ) {
    return {
      status: "invalidated",
      reason: alreadyBroken
        ? "range_already_broken_deviation"
        : "breakout_entry_window_elapsed",
      firstCrossAt: event.breakoutCloseTime,
      confirmation,
      refinement: refineStealthBreakoutEntry(
        { breakoutLevel: identity.upper },
        [],
        { confirmationTimeframe: "1h" },
      ),
      volumeShadow,
    };
  }
  const refinement = refineStealthBreakoutEntry(
    { breakoutLevel: identity.upper },
    (input.breakoutCandles1h ?? []).filter(
      (candle) => candle.time + 60 * 60 * 1000 <= input.evaluatedAt,
    ),
    {
      confirmationStartsAt: event.breakoutCloseTime,
      requiredConsecutiveCloses: 2,
      confirmationTimeframe: "1h",
      requireContinuousHold: true,
      maxDistancePct: AUTO_RANGE_MAX_CHASE_PCT,
    },
  );
  // Owner rule: trade at the verified Pine breakout close; no extra waiting
  // for later 1H closes (only an observed close back below the level rejects).
  if (
    refinement.status === "near_level" ||
    refinement.status === "insufficient_data"
  ) {
    return {
      status: "qualified",
      reason: "later_frozen_level_cross",
      firstCrossAt: event.breakoutCloseTime,
      confirmation,
      refinement,
      volumeShadow,
    };
  }
  if (refinement.status === "rejected") {
    return {
      status: "invalidated",
      reason: "breakout_rejected_below_level",
      firstCrossAt: event.breakoutCloseTime,
      confirmation,
      refinement,
      volumeShadow,
    };
  }
  return {
    status: "armed",
    reason:
      refinement.status === "extended"
        ? "breakout_active_waiting_retest"
        : "breakout_active_waiting_1h_data",
    firstCrossAt: event!.breakoutCloseTime,
    confirmation,
    refinement,
    volumeShadow,
  };
}

const STEALTH_ONE_HOUR_MS = 60 * 60 * 1000;
// A previous 1H close up to 1% above the frozen upper bound still counts as the
// same breakout (ZZZ 2026-10-08: 0.00855 vs 0.00851 rejected a clean entry).
const STEALTH_PREVIOUS_CLOSE_TOLERANCE = 0.01;

function evaluateStealthAutoRangeOneHourSetup(input: {
  arm: StealthArmedSnapshot;
  breakoutCandles1h?: readonly BreakoutCandle[];
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt: number;
  autoRangeBreakoutEvent?: StealthAutoRangeBreakoutEvent | null;
  fastVolumePass?: boolean;
  marketCapUsd?: number | null;
}): StealthArmedDecision {
  const identity = input.arm.autoRangeIdentity;
  const event =
    identity &&
    autoRangeEventMatchesIdentity(identity, input.autoRangeBreakoutEvent)
      ? input.autoRangeBreakoutEvent
      : identity
        ? deriveFrozenRangeBreakoutEvent(
            identity,
            input.breakoutCandles1h ?? [],
            STEALTH_ONE_HOUR_MS,
            input.arm.armedAfterOneHourCandleTime ?? identity.candleCutoff,
            input.arm.armedAt,
            input.evaluatedAt,
          )
        : null;
  const wait = (): StealthArmedDecision =>
    input.evaluatedAt >= input.arm.expiresAt
      ? { status: "expired", reason: "arm_ttl_elapsed" }
      : { status: "armed", reason: "awaiting_later_1h_auto_range_breakout" };
  if (
    !identity ||
    identity.version !== "auto_range_pine_v1_1h" ||
    !event ||
    !autoRangeEventMatchesIdentity(identity, event)
  ) {
    return wait();
  }

  const eventCandleTime = event.breakoutCloseTime - STEALTH_ONE_HOUR_MS;
  const cursor = input.arm.armedAfterOneHourCandleTime ?? identity.candleCutoff;
  if (
    eventCandleTime <= cursor ||
    event.breakoutCloseTime <= input.arm.armedAt ||
    event.breakoutCloseTime > input.evaluatedAt
  ) {
    return wait();
  }
  const emptyRefinement = refineStealthBreakoutEntry(
    { breakoutLevel: identity.upper },
    [],
  );
  const invalidBreakout = (
    reason: string,
    confirmation?: StealthFourHourConfirmation,
  ): StealthArmedDecision => ({
    status: "invalidated",
    reason,
    firstCrossAt: event.breakoutCloseTime,
    confirmation: confirmation ?? {
      status: "insufficient_data",
      timeframe: "4h",
      crossed: false,
      breakoutLevel: identity.upper,
      breakoutTolerance: null,
      breakoutZone: null,
      lifecycle: null,
      distanceFromLevelPct: null,
      closeStrength: null,
      atr: null,
      bodyAtr: null,
      bodyRange: null,
      closeDistanceAtr: null,
      previousClose: null,
      triggerCandle: null,
      reasons: [
        "Matched Pine event could not be verified against closed 1H bars",
      ],
    },
    refinement: emptyRefinement,
    volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
  });
  if (
    input.evaluatedAt - event.breakoutCloseTime >
    STEALTH_BREAKOUT_ENTRY_TTL_MS
  ) {
    return invalidBreakout("breakout_entry_window_elapsed");
  }

  const candles = [...(input.breakoutCandles1h ?? [])].sort(
    (left, right) => left.time - right.time,
  );
  const eventCandle = candles.find((candle) => candle.time === eventCandleTime);
  const previous = candles.find(
    (candle) => candle.time === eventCandleTime - STEALTH_ONE_HOUR_MS,
  );
  // A Pine breakout is only usable when its exact closed 1H bar can be
  // correlated and independently verifies the frozen-level close crossing.
  if (
    !eventCandle ||
    !previous ||
    eventCandle.time + STEALTH_ONE_HOUR_MS !== event.breakoutCloseTime ||
    previous.close > identity.upper * (1 + STEALTH_PREVIOUS_CLOSE_TOLERANCE) ||
    eventCandle.close <= identity.upper
  ) {
    return invalidBreakout(
      "auto_range_1h_breakout_candle_unavailable_or_mismatched",
    );
  }

  const confirmation: StealthFourHourConfirmation = {
    ...closed30mConfirmation(
      identity.upper,
      eventCandle,
      event.breakoutCloseTime,
      "1h",
    ),
    previousClose: previous.close,
    reasons: [
      "Closed 1H Pine upside-break event matches the versioned frozen Auto Range identity",
    ],
  };
  const refinement = refineStealthBreakoutEntry(
    { breakoutLevel: identity.upper },
    input.refinementCandles.filter(
      (candle) =>
        candle.time >= event.breakoutCloseTime &&
        candle.time + 30 * 60 * 1000 <= input.evaluatedAt,
    ),
    {
      confirmationStartsAt: event.breakoutCloseTime,
      requiredConsecutiveCloses: 1,
      requireContinuousHold: true,
      maxDistancePct: AUTO_RANGE_MAX_CHASE_PCT,
    },
  );
  const common = {
    firstCrossAt: event.breakoutCloseTime,
    confirmation,
    refinement,
    volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
    // Observation only: the Pine 1H path has no volume gate. Recorded so the
    // breakout-candle volume can be calibrated against outcomes later.
    oneHourVolume: buildStealthOneHourVolumeEvidence(
      candles,
      candles.indexOf(eventCandle),
      input.marketCapUsd,
    ),
  };
  // hold_30m needs a closed 30m candle at/above the level after the 1H close;
  // without one (insufficient_data) the arm waits instead of firing.
  const normalQualified = refinement.status === "near_level";
  // Owner fast path (2026-10-11): spot or futures breakout-candle volume
  // >= 10x qualifies without waiting for the 30m hold. A closed 30m back
  // below the level (rejected) still invalidates.
  const fastQualified =
    !normalQualified &&
    input.fastVolumePass === true &&
    refinement.status !== "rejected";
  if (normalQualified || fastQualified) {
    return {
      status: "qualified",
      reason: "later_frozen_level_cross",
      ...common,
      entryPath: fastQualified ? "fast_volume" : "hold_30m",
    } as StealthArmedDecision;
  }
  if (refinement.status === "rejected") {
    return {
      status: "invalidated",
      reason: "breakout_rejected_below_level",
      ...common,
    };
  }
  return {
    status: "armed",
    reason:
      refinement.status === "extended"
        ? "breakout_active_waiting_retest"
        : "breakout_active_waiting_30m_data",
    ...common,
  };
}

const STEALTH_30M_MAX_RECLAIMS = 1;
const STEALTH_30M_ENTRY_TTL_MS = 6 * 60 * 60 * 1000;
const STEALTH_30M_CHASE_PCT = 2.5;
/** Auto Range (1H and 4H) has no late-entry cap (owner's experiment; revisit with outcomes). */
const AUTO_RANGE_MAX_CHASE_PCT = Number.POSITIVE_INFINITY;

function closed30mRefinement(
  status: StealthThirtyMinuteRefinement["status"],
  candles: readonly BreakoutCandle[],
  level: number,
  confirmationCandleTimes: number[] = [],
): StealthThirtyMinuteRefinement {
  const last = candles.at(-1);
  return {
    status,
    timeframe: "30m",
    distanceFromLevelPct:
      last == null ? null : ((last.close - level) / level) * 100,
    closeStrength:
      last == null
        ? null
        : (last.close - last.low) /
          Math.max(last.high - last.low, Number.EPSILON),
    consecutiveClosesAbove: confirmationCandleTimes.length,
    confirmationCandleTimes,
    confirmationAt:
      confirmationCandleTimes.at(-1) == null
        ? null
        : confirmationCandleTimes.at(-1)! + 30 * 60 * 1000,
    reasons: [],
  };
}

function closed30mConfirmation(
  level: number,
  candle: BreakoutCandle,
  firstCrossAt: number,
  timeframe: "1h" | "30m" = "30m",
): StealthFourHourConfirmation {
  return {
    status: "fresh_breakout",
    timeframe,
    breakoutLevel: level,
    distanceFromLevelPct: ((candle.close - level) / level) * 100,
    closeStrength:
      (candle.close - candle.low) /
      Math.max(candle.high - candle.low, Number.EPSILON),
    atr: null,
    bodyAtr: null,
    bodyRange:
      Math.abs(candle.close - candle.open) /
      Math.max(candle.high - candle.low, Number.EPSILON),
    previousClose: null,
    triggerCandle: candle,
    triggerCandleAt: candle.time,
    reasons: [
      timeframe === "1h"
        ? "closed 1h cross of frozen 4h resistance"
        : "closed 30m Stealth early breakout",
    ],
  } as unknown as StealthFourHourConfirmation;
}

function evaluateStealthClosedOneHourSetup(input: {
  arm: StealthArmedSnapshot;
  breakoutCandles1h?: readonly BreakoutCandle[];
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt: number;
  marketCapUsd?: number | null;
}): StealthArmedDecision {
  if (input.evaluatedAt >= input.arm.expiresAt) {
    return { status: "expired", reason: "arm_ttl_elapsed" };
  }
  const candles = [...(input.breakoutCandles1h ?? [])].sort(
    (left, right) => left.time - right.time,
  );
  const armCursor =
    input.arm.armedAfterOneHourCandleTime ??
    input.arm.armedAfterFourHourCandleTime ??
    input.arm.armedAt;
  let rejectedVolume: StealthOneHourVolumeEvidence | null = null;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    const closeTime = current.time + 60 * 60 * 1000;
    if (
      closeTime <= Math.max(armCursor, input.arm.armedAt) ||
      closeTime > input.evaluatedAt ||
      previous.close > input.arm.breakoutLevel ||
      current.close <= input.arm.breakoutLevel
    )
      continue;
    const volume = buildStealthOneHourVolumeEvidence(
      candles,
      index,
      input.marketCapUsd,
    );
    if (!volume || !volume.gatePassed) {
      rejectedVolume = volume;
      continue;
    }
    if (input.evaluatedAt - closeTime > STEALTH_30M_ENTRY_TTL_MS) {
      return {
        status: "invalidated",
        reason: "breakout_entry_window_elapsed",
        firstCrossAt: closeTime,
        confirmation: closed30mConfirmation(
          input.arm.breakoutLevel,
          current,
          closeTime,
          "1h",
        ),
        refinement: refineStealthBreakoutEntry(
          { breakoutLevel: input.arm.breakoutLevel },
          [],
          { confirmationStartsAt: closeTime, requiredConsecutiveCloses: 1 },
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
        oneHourVolume: volume,
      };
    }
    const postCross = input.refinementCandles.filter(
      (candle) =>
        candle.time >= closeTime &&
        candle.time + 30 * 60 * 1000 <= input.evaluatedAt,
    );
    const refinement = refineStealthBreakoutEntry(
      { breakoutLevel: input.arm.breakoutLevel },
      postCross,
      { confirmationStartsAt: closeTime, requiredConsecutiveCloses: 1 },
    );
    const confirmation = closed30mConfirmation(
      input.arm.breakoutLevel,
      current,
      closeTime,
      "1h",
    );
    const base = {
      firstCrossAt: closeTime,
      confirmation,
      refinement,
      volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      oneHourVolume: volume,
    };
    if (refinement.status === "rejected") {
      return {
        status: "invalidated",
        reason: "breakout_rejected_below_level",
        ...base,
      };
    }
    if (refinement.status === "near_level") {
      return {
        status: "qualified",
        reason: "later_frozen_level_cross",
        ...base,
      };
    }
    return {
      status: "armed",
      reason:
        refinement.status === "extended"
          ? "breakout_active_waiting_retest"
          : "breakout_active_waiting_30m_data",
      ...base,
    };
  }
  return {
    status: "armed",
    reason: "awaiting_later_1h_cross_with_volume",
    oneHourVolume: rejectedVolume,
  };
}

function evaluateStealthClosed30mSetup(input: {
  arm: StealthArmedSnapshot;
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt: number;
}): StealthArmedDecision {
  const arm = input.arm;
  const candles = [...input.refinementCandles]
    .filter((candle) => candle.time + 30 * 60 * 1000 <= input.evaluatedAt)
    .sort((left, right) => left.time - right.time);
  if (input.evaluatedAt >= arm.expiresAt) {
    return { status: "expired", reason: "arm_ttl_elapsed" };
  }
  let rawCrossObservedAt = arm.rawCrossObservedAt ?? null;
  let rawCrossCandleAt = arm.rawCrossCandleAt ?? null;
  let rawCrossPrice = arm.rawCrossPrice ?? null;
  let reclaimCount = arm.reclaimCount ?? 0;
  let lastCandleAt = arm.lastCandleAt ?? null;
  const withState = <T extends object>(value: T) => ({
    ...value,
    closed30mState: {
      rawCrossObservedAt,
      rawCrossCandleAt,
      rawCrossPrice,
      reclaimCount,
      lastCandleAt,
    },
  });
  const eligible = candles.filter(
    (candle) =>
      candle.time + 30 * 60 * 1000 > arm.armedAt &&
      (lastCandleAt == null || candle.time > lastCandleAt),
  );
  for (const candle of eligible) {
    if (
      rawCrossObservedAt != null &&
      lastCandleAt != null &&
      candle.time - lastCandleAt !== 30 * 60 * 1000
    ) {
      return withState({
        status: "invalidated",
        reason: "candle_gap_after_raw_cross",
        firstCrossAt: rawCrossObservedAt,
        confirmation: closed30mConfirmation(
          arm.breakoutLevel,
          candle,
          rawCrossObservedAt,
        ),
        refinement: closed30mRefinement(
          "rejected",
          [candle],
          arm.breakoutLevel,
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      });
    }
    lastCandleAt = candle.time;
    if (rawCrossObservedAt == null) {
      if (candle.close <= arm.breakoutLevel) continue;
      rawCrossCandleAt = candle.time;
      rawCrossObservedAt = candle.time + 30 * 60 * 1000;
      rawCrossPrice = candle.close;
      // Discovery and fire are separate event-time cycles. Persist this cursor
      // first; never consume a second candle from the same invocation.
      return withState({
        status: "armed",
        reason: "breakout_active_waiting_30m_data",
        firstCrossAt: rawCrossObservedAt,
        confirmation: closed30mConfirmation(
          arm.breakoutLevel,
          candle,
          rawCrossObservedAt,
        ),
        refinement: closed30mRefinement(
          "insufficient_data",
          [candle],
          arm.breakoutLevel,
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      });
    }
    if (input.evaluatedAt - rawCrossObservedAt > STEALTH_30M_ENTRY_TTL_MS) {
      return withState({
        status: "invalidated",
        reason: "breakout_entry_window_elapsed",
        firstCrossAt: rawCrossObservedAt,
        confirmation: closed30mConfirmation(
          arm.breakoutLevel,
          candle,
          rawCrossObservedAt,
        ),
        refinement: closed30mRefinement(
          "rejected",
          [candle],
          arm.breakoutLevel,
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      });
    }
    if (candle.close >= arm.breakoutLevel) {
      const chasePct =
        ((candle.close - arm.breakoutLevel) / arm.breakoutLevel) * 100;
      const range = Math.max(candle.high - candle.low, Number.EPSILON);
      const momentum =
        (candle.close - candle.low) / range >= 0.7 &&
        Math.abs(candle.close - candle.open) / range >= 0.55;
      const consecutive =
        rawCrossCandleAt != null &&
        candle.time - rawCrossCandleAt === 30 * 60 * 1000;
      if (reclaimCount > 0 || consecutive) {
        const atrChasePct =
          arm.atr != null && arm.atr > 0
            ? (arm.atr / arm.breakoutLevel) * 100 * 0.6
            : STEALTH_30M_CHASE_PCT;
        const allowed =
          chasePct <= Math.min(STEALTH_30M_CHASE_PCT, atrChasePct) || momentum;
        if (allowed) {
          const times =
            consecutive && rawCrossCandleAt != null
              ? [rawCrossCandleAt, candle.time]
              : [candle.time];
          return withState({
            status: "qualified",
            reason:
              reclaimCount > 0
                ? "later_frozen_level_cross"
                : "later_frozen_level_cross",
            firstCrossAt: rawCrossObservedAt,
            confirmation: closed30mConfirmation(
              arm.breakoutLevel,
              candle,
              rawCrossObservedAt,
            ),
            refinement: closed30mRefinement(
              "near_level",
              [candle],
              arm.breakoutLevel,
              times,
            ),
            volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
          });
        }
        return withState({
          status: "armed",
          reason: "breakout_active_waiting_retest",
          firstCrossAt: rawCrossObservedAt,
          confirmation: closed30mConfirmation(
            arm.breakoutLevel,
            candle,
            rawCrossObservedAt,
          ),
          refinement: closed30mRefinement(
            "extended",
            [candle],
            arm.breakoutLevel,
          ),
          volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
        });
      }
      continue;
    }
    if (reclaimCount >= STEALTH_30M_MAX_RECLAIMS) {
      return withState({
        status: "invalidated",
        reason: "second_close_below_level",
        firstCrossAt: rawCrossObservedAt,
        confirmation: closed30mConfirmation(
          arm.breakoutLevel,
          candle,
          rawCrossObservedAt,
        ),
        refinement: closed30mRefinement(
          "rejected",
          [candle],
          arm.breakoutLevel,
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      });
    }
    const displacement = Math.max(
      arm.breakoutLevel - candle.close,
      arm.breakoutLevel - candle.low,
    );
    if (displacement > (arm.atr ?? arm.breakoutLevel * 0.01)) {
      return withState({
        status: "invalidated",
        reason: "reclaim_exceeded_atr_bound",
        firstCrossAt: rawCrossObservedAt,
        confirmation: closed30mConfirmation(
          arm.breakoutLevel,
          candle,
          rawCrossObservedAt,
        ),
        refinement: closed30mRefinement(
          "rejected",
          [candle],
          arm.breakoutLevel,
        ),
        volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
      });
    }
    reclaimCount += 1;
  }
  if (rawCrossObservedAt == null) {
    return withState({ status: "armed", reason: "awaiting_later_4h_cross" });
  }
  const last = candles.at(-1);
  return withState({
    status: "armed",
    reason: "breakout_active_waiting_30m_data",
    firstCrossAt: rawCrossObservedAt,
    confirmation: closed30mConfirmation(
      arm.breakoutLevel,
      last ?? {
        time: rawCrossCandleAt ?? arm.armedAt,
        open: arm.breakoutLevel,
        high: arm.breakoutLevel,
        low: arm.breakoutLevel,
        close: arm.breakoutLevel,
        volume: 0,
      },
      rawCrossObservedAt,
    ),
    refinement: closed30mRefinement(
      "insufficient_data",
      last ? [last] : [],
      arm.breakoutLevel,
    ),
    volumeShadow: buildStealthBreakoutVolumeShadow([], 0),
  });
}
