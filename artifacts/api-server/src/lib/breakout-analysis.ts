/**
 * Deterministic technical breakout classifier used in shadow mode.
 *
 * It intentionally has no network, database, or scanner dependencies so the
 * exact same candle snapshot can be replayed in tests and later telemetry.
 */

export type BreakoutStatus =
  | "no_breakout"
  | "approaching"
  | "fresh_breakout"
  | "confirmed_breakout"
  | "retest"
  | "fakeout"
  | "insufficient_data";

export type BreakoutKind = "horizontal" | "trendline" | "both" | "none";
export type BreakoutTimeframe = "30m" | "1h" | "4h";

export interface BreakoutCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Aggregated multi-exchange USD volume; the only volume used for gates. */
  volumeUsd?: number;
}

export interface BreakoutCandleSource {
  time: number | string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

export interface BreakoutPivot {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
}

export interface BreakoutLevel {
  price: number;
  touches: number;
}

export interface BreakoutTrendline {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  kind: "resistance" | "support";
}

export interface BreakoutRetestZone {
  fromIndex: number;
  toIndex: number;
  level: number;
}

export interface BreakoutZone {
  lower: number;
  upper: number;
}

export interface BreakoutLifecycle {
  breakoutIndex: number;
  endIndex: number;
  retestIndices: number[];
}

export interface BreakoutEvidence {
  status: BreakoutStatus;
  kind: BreakoutKind;
  breakoutSource: "horizontal" | "trendline" | "none";
  timeframe: BreakoutTimeframe;
  score: number;
  quietZone: boolean;
  breakoutLevel: number | null;
  distanceFromLevelPct: number | null;
  barsSinceBreakout: number | null;
  touches: number;
  roomToResistancePct: number | null;
  breakoutTolerance: number | null;
  breakoutZone: BreakoutZone | null;
  lifecycle: BreakoutLifecycle | null;
  reasons: string[];
  pivots: BreakoutPivot[];
  levels: BreakoutLevel[];
  trendline: BreakoutTrendline | null;
  retestZone: BreakoutRetestZone | null;
}

export interface ContinuationShelfEvidence extends BreakoutEvidence {
  continuationShelf: {
    method: "post_impulse_consolidation_v1";
    impulseIndex: number;
    impulseStartPrice: number;
    impulseEndPrice: number;
    impulsePct: number;
    consolidationFromIndex: number;
    consolidationToIndex: number;
    shelfLower: number;
    shelfUpper: number;
    nearestUpperResistance: number | null;
  } | null;
}

export interface StealthBreakoutFlowConfirmation {
  oi: boolean;
  cvd: boolean;
  spotTaker: boolean;
}

export interface StealthOneHourConfirmation {
  status: "fresh_breakout" | "fakeout" | "no_breakout" | "insufficient_data";
  timeframe: "1h";
  crossed: boolean;
  breakoutLevel: number | null;
  breakoutTolerance: number | null;
  breakoutZone: BreakoutZone | null;
  lifecycle: BreakoutLifecycle | null;
  distanceFromLevelPct: number | null;
  closeStrength: number | null;
  atr: number | null;
  bodyAtr: number | null;
  bodyRange: number | null;
  closeDistanceAtr: number | null;
  previousClose: number | null;
  triggerCandle: BreakoutCandle | null;
  reasons: string[];
}

/** The only confirmation that is allowed to qualify a live quiet-zone setup. */
export interface StealthFourHourConfirmation extends Omit<
  StealthOneHourConfirmation,
  "timeframe"
> {
  timeframe: "4h";
}

export interface StealthThirtyMinuteRefinement {
  status: "near_level" | "extended" | "rejected" | "insufficient_data";
  timeframe: "30m" | "1h";
  distanceFromLevelPct: number | null;
  closeStrength: number | null;
  consecutiveClosesAbove: number;
  confirmationCandleTimes: number[];
  confirmationAt: number | null;
  reasons: string[];
}

export interface StealthBreakoutTimeframeAnalysis {
  structure: BreakoutEvidence;
  confirmation: StealthFourHourConfirmation;
  oneHourContext: StealthOneHourConfirmation | null;
  refinement: StealthThirtyMinuteRefinement;
}

export interface StealthEarlyBreakoutObservation {
  symbol: string;
  observationKey: string;
  levelKey: string;
  breakoutSource: "horizontal" | "trendline";
  breakoutLevel: number;
  touches: number;
  quietZone: true;
  firstCrossAt: number;
  firstDetectedAt: number;
  confirmationAt: number | null;
}

export function isFreshStealthBreakout(
  evidence: Pick<BreakoutEvidence, "status" | "quietZone">,
  flow: StealthBreakoutFlowConfirmation,
): boolean {
  return (
    evidence.status === "fresh_breakout" &&
    evidence.quietZone &&
    (flow.oi || flow.cvd || flow.spotTaker)
  );
}

/**
 * The Stealth pattern is intentionally multi-timeframe:
 * - 4h supplies the resistance structure, quiet-zone context, and sole breakout gate.
 * - 1h is optional context/telemetry and can never qualify an event.
 * - 30m only says whether the entry is still close enough to the level.
 */
export function isQualifiedStealthBreakout(
  structure: Pick<
    BreakoutEvidence,
    "timeframe" | "quietZone" | "breakoutLevel"
  >,
  confirmation: StealthFourHourConfirmation,
  refinement: StealthThirtyMinuteRefinement,
  flow: StealthBreakoutFlowConfirmation,
): boolean {
  return (
    structure.timeframe === "4h" &&
    structure.quietZone &&
    structure.breakoutLevel !== null &&
    confirmation.status === "fresh_breakout" &&
    refinement.status === "near_level" &&
    (flow.oi || flow.cvd || flow.spotTaker)
  );
}

/**
 * Technical-only Stealth mode.
 *
 * Keep only the three price-structure layers while we measure how often the
 * detector recognizes fresh breakouts before adding flow or volume filters.
 */
export function isTechnicalStealthBreakout(
  structure: Pick<
    BreakoutEvidence,
    "timeframe" | "quietZone" | "breakoutLevel"
  >,
  confirmation: StealthFourHourConfirmation,
  refinement: StealthThirtyMinuteRefinement,
): boolean {
  return (
    structure.timeframe === "4h" &&
    structure.quietZone &&
    structure.breakoutLevel !== null &&
    confirmation.status === "fresh_breakout" &&
    refinement.status === "near_level"
  );
}

/**
 * Builds the durable, non-trading observation from the same frozen 4H level
 * and closed 4H confirmation. A 1H-only confirmation is rejected so legacy
 * callers cannot emit events under the superseded contract.
 */
export function buildStealthEarlyBreakoutObservation(input: {
  symbol: string;
  structure: Pick<
    BreakoutEvidence,
    "breakoutSource" | "breakoutLevel" | "touches" | "quietZone"
  >;
  confirmation:
    | Pick<StealthFourHourConfirmation, "status" | "lifecycle" | "timeframe">
    | Pick<StealthOneHourConfirmation, "status" | "lifecycle" | "timeframe">;
  confirmationCandles: readonly BreakoutCandle[];
  firstDetectedAt: number;
}): StealthEarlyBreakoutObservation | null {
  const { structure, confirmation, confirmationCandles } = input;
  const breakoutIndex = confirmation.lifecycle?.breakoutIndex ?? null;
  const breakoutLevel = structure.breakoutLevel;
  if (
    structure.breakoutSource === "none" ||
    breakoutLevel === null ||
    !structure.quietZone ||
    confirmation.timeframe !== "4h" ||
    confirmation.status !== "fresh_breakout" ||
    breakoutIndex === null ||
    breakoutIndex < 0 ||
    breakoutIndex >= confirmationCandles.length
  ) {
    return null;
  }

  const firstCrossCandle = confirmationCandles[breakoutIndex];
  const firstCrossAt =
    firstCrossCandle === undefined
      ? null
      : firstCrossCandle.time + FOUR_HOURS_MS;
  if (
    firstCrossAt === null ||
    !Number.isFinite(firstCrossAt) ||
    !Number.isFinite(input.firstDetectedAt)
  ) {
    return null;
  }

  const levelKey = `${structure.breakoutSource}:${breakoutLevel.toFixed(4)}`;
  return {
    symbol: input.symbol,
    observationKey: `${input.symbol}:${levelKey}:${firstCrossAt}`,
    levelKey,
    breakoutSource: structure.breakoutSource,
    breakoutLevel,
    touches: structure.touches,
    quietZone: true,
    firstCrossAt,
    firstDetectedAt: input.firstDetectedAt,
    confirmationAt: null,
  };
}

export interface StealthTechnicalFallbackState {
  prefetchTimedOut: boolean;
  attempts: number;
}

/**
 * A timed-out global prefetch makes missing higher-timeframe candles
 * inconclusive, not proof that a symbol lacks enough history. Keep recovery
 * bounded so a slow cycle cannot turn into an unbounded retry storm.
 */
export function claimStealthTechnicalKlineFallback(
  state: StealthTechnicalFallbackState,
  hasMissingTimeframe: boolean,
  maxAttempts: number,
): boolean {
  if (
    !state.prefetchTimedOut ||
    !hasMissingTimeframe ||
    state.attempts >= maxAttempts
  ) {
    return false;
  }
  state.attempts += 1;
  return true;
}

interface CandidateEvidence {
  source: "horizontal" | "trendline";
  status: Exclude<BreakoutStatus, "insufficient_data">;
  level: number;
  score: number;
  touches: number;
  breakIndex: number | null;
  quietZone: boolean;
  reasons: string[];
  trendline: BreakoutTrendline | null;
  retestZone: BreakoutRetestZone | null;
  breakoutLevel: number | null;
  breakoutTolerance: number;
  lifecycle: BreakoutLifecycle | null;
}

const MIN_CANDLES = 40;
export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const PIVOT_WINDOW = 2;
const MAX_BREAKOUT_AGE_BARS = 10;
const QUIET_ZONE_BARS = 8;
const MIN_QUIET_ZONE_BARS = 6;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function round(value: number, digits = 4): number {
  // Four fixed decimal places erase the breakout boundary for sub-cent
  // instruments (e.g. 0.0004799 becomes 0.0005, a 4.2% displacement).
  const priceDigits =
    value === 0 || !Number.isFinite(value)
      ? digits
      : Math.max(digits, 5 - Math.floor(Math.log10(Math.abs(value))));
  const precision = 10 ** priceDigits;
  return Math.round(value * precision) / precision;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function calculateAtr(candles: BreakoutCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const trueRanges: number[] = [];
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previous = candles[index - 1]!;
    trueRanges.push(
      Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previous.close),
        Math.abs(candle.low - previous.close),
      ),
    );
  }
  return median(trueRanges.filter((value) => value > 0 && finite(value)));
}

/**
 * BingX can include a still-forming final candle. Both shadow analysis and the
 * live signal gate must use exactly the same closed-candle view so an intrabar
 * wick never becomes a Stealth Breakout entry.
 */
export function normalizeClosedBreakoutCandles(
  rows: readonly BreakoutCandleSource[],
): BreakoutCandle[] {
  const closed = rows
    .map(
      (row): BreakoutCandle => ({
        time: Number(row.time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
      }),
    )
    .filter(
      (row) =>
        finite(row.time) &&
        finite(row.open) &&
        finite(row.high) &&
        finite(row.low) &&
        finite(row.close) &&
        finite(row.volume) &&
        row.high >= row.low,
    );
  return closed.slice(0, -1);
}

function findPivots(candles: BreakoutCandle[]): BreakoutPivot[] {
  const pivots: BreakoutPivot[] = [];
  for (
    let index = PIVOT_WINDOW;
    index < candles.length - PIVOT_WINDOW;
    index += 1
  ) {
    const current = candles[index]!;
    let isHigh = true;
    let isLow = true;
    for (
      let neighbor = index - PIVOT_WINDOW;
      neighbor <= index + PIVOT_WINDOW;
      neighbor += 1
    ) {
      if (neighbor === index) continue;
      const comparison = candles[neighbor]!;
      if (comparison.high >= current.high) isHigh = false;
      if (comparison.low <= current.low) isLow = false;
    }
    if (isHigh) {
      pivots.push({
        index,
        time: current.time,
        price: current.high,
        kind: "high",
      });
    }
    if (isLow) {
      pivots.push({
        index,
        time: current.time,
        price: current.low,
        kind: "low",
      });
    }
  }
  return pivots;
}

function horizontalLevels(
  pivots: BreakoutPivot[],
  atr: number,
  upperBoundary = false,
): BreakoutLevel[] {
  const clusters: Array<{ prices: number[]; indices: number[] }> = [];
  for (const pivot of pivots.filter((item) => item.kind === "high")) {
    const tolerance = Math.max(atr * 0.7, pivot.price * 0.0025);
    const existing = clusters.find(
      (cluster) => Math.abs(median(cluster.prices) - pivot.price) <= tolerance,
    );
    if (existing) {
      existing.prices.push(pivot.price);
      existing.indices.push(pivot.index);
    } else {
      clusters.push({ prices: [pivot.price], indices: [pivot.index] });
    }
  }
  return clusters
    .filter((cluster) => cluster.prices.length >= 2)
    .map((cluster) => ({
      // Stealth must clear the top of a resistance cluster, not its median:
      // a close above the median may still be below the same cluster's high.
      price: round(
        upperBoundary ? Math.max(...cluster.prices) : median(cluster.prices),
      ),
      touches: cluster.prices.length,
    }))
    .sort(
      (left, right) => right.touches - left.touches || right.price - left.price,
    )
    .slice(0, 8);
}

function bestResistanceTrendline(
  pivots: BreakoutPivot[],
  atr: number,
): BreakoutTrendline | null {
  const highs = pivots.filter((pivot) => pivot.kind === "high");
  let best:
    | { line: BreakoutTrendline; score: number; endIndex: number }
    | undefined;

  for (let left = 0; left < highs.length - 1; left += 1) {
    for (let right = left + 1; right < highs.length; right += 1) {
      const start = highs[left]!;
      const end = highs[right]!;
      if (end.index - start.index < 4 || end.price >= start.price) continue;
      const slope = (end.price - start.price) / (end.index - start.index);
      const tolerance = Math.max(atr * 0.75, start.price * 0.0025);
      const touches = highs.filter((pivot) => {
        if (pivot.index < start.index || pivot.index > end.index + 14)
          return false;
        const projected = start.price + slope * (pivot.index - start.index);
        return Math.abs(pivot.price - projected) <= tolerance;
      }).length;
      if (touches < 2) continue;

      const score = touches * 10 + Math.min(10, end.index - start.index);
      if (!best || score > best.score || end.index > best.endIndex) {
        best = {
          score,
          endIndex: end.index,
          line: {
            startIndex: start.index,
            endIndex: end.index,
            startPrice: round(start.price),
            endPrice: round(end.price),
            kind: "resistance",
          },
        };
      }
    }
  }
  return best?.line ?? null;
}

function recentCross(
  candles: BreakoutCandle[],
  valueAt: (index: number) => number,
  buffer: number,
): number | null {
  const firstIndex = Math.max(1, candles.length - MAX_BREAKOUT_AGE_BARS - 1);
  // Keep the first cross in the recent window. Later returns to the same
  // level belong to that breakout lifecycle, rather than becoming a new one.
  for (let index = firstIndex; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    if (
      previous.close <= valueAt(index - 1) + buffer &&
      current.close > valueAt(index) + buffer
    ) {
      return index;
    }
  }
  return null;
}

function hasQuietZone(
  candles: BreakoutCandle[],
  breakoutIndex: number,
  levelAt: (index: number) => number,
  tolerance: number,
  atr: number,
): boolean {
  const start = Math.max(0, breakoutIndex - QUIET_ZONE_BARS);
  const preceding = candles.slice(start, breakoutIndex);
  if (preceding.length < MIN_QUIET_ZONE_BARS) return false;

  const rangeHigh = Math.max(...preceding.map((candle) => candle.high));
  const rangeLow = Math.min(...preceding.map((candle) => candle.low));
  const referenceLevel = levelAt(breakoutIndex);
  const maxQuietRange = Math.max(atr * 5, referenceLevel * 0.03);
  const heldBelowResistance = preceding.every(
    (candle, offset) => candle.close <= levelAt(start + offset) + tolerance,
  );

  return rangeHigh - rangeLow <= maxQuietRange && heldBelowResistance;
}

function classifyCandidate(
  candles: BreakoutCandle[],
  source: "horizontal" | "trendline",
  levelAt: (index: number) => number,
  level: number,
  touches: number,
  atr: number,
  trendline: BreakoutTrendline | null,
): CandidateEvidence {
  const lastIndex = candles.length - 1;
  const last = candles[lastIndex]!;
  const tolerance = Math.max(atr * 0.65, level * 0.0025);
  const currentLevel = levelAt(lastIndex);
  const breakoutIndex = recentCross(candles, levelAt, tolerance * 0.35);
  const reasons: string[] = [];
  let status: Exclude<BreakoutStatus, "insufficient_data"> = "no_breakout";
  let retestZone: BreakoutRetestZone | null = null;
  let lifecycle: BreakoutLifecycle | null = null;
  const breakoutLevel =
    breakoutIndex === null ? null : round(levelAt(breakoutIndex));
  const quietZone =
    breakoutIndex !== null
      ? hasQuietZone(candles, breakoutIndex, levelAt, tolerance, atr)
      : false;

  if (breakoutIndex !== null) {
    const barsSince = lastIndex - breakoutIndex;
    const retestIndices: number[] = [];
    for (let index = breakoutIndex + 1; index <= lastIndex; index += 1) {
      const value = levelAt(index);
      const candle = candles[index]!;
      const isRetest =
        candle.low >= value - tolerance && candle.low <= value + tolerance;
      if (isRetest && retestIndices[retestIndices.length - 1] !== index - 1) {
        retestIndices.push(index);
      }
    }
    lifecycle = {
      breakoutIndex,
      endIndex: lastIndex,
      retestIndices,
    };

    if (last.close < currentLevel - tolerance) {
      status = "fakeout";
      reasons.push("Цена вернулась ниже уровня после пробоя");
    } else if (retestIndices.length > 0 && last.close > currentLevel) {
      status = "retest";
      retestZone = {
        fromIndex: breakoutIndex,
        toIndex: retestIndices[retestIndices.length - 1]!,
        level: breakoutLevel ?? round(currentLevel),
      };
      reasons.push("Уровень был протестирован сверху и удержан");
    } else if (barsSince === 0) {
      status = "fresh_breakout";
      reasons.push("Свежий пробой на последнем закрытии");
    } else {
      status = "confirmed_breakout";
      reasons.push(
        `Пробой удерживается ${barsSince} ${barsSince === 1 ? "свечу" : "свечи"}`,
      );
    }
  } else if (
    last.close <= currentLevel &&
    currentLevel - last.close <= tolerance * 1.6
  ) {
    status = "approaching";
    reasons.push("Цена подошла к сопротивлению в пределах ATR-зоны");
  }

  if (touches >= 3) reasons.push(`${touches} касания подтверждают уровень`);
  else if (touches >= 2) reasons.push("Уровень подтверждён повторным касанием");
  if (quietZone) {
    reasons.push(
      "Перед пробоем цена удерживалась в тихой зоне под сопротивлением",
    );
  } else if (breakoutIndex !== null) {
    reasons.push("Перед пробоем не набралась тихая зона нужной длины");
  }

  const body = Math.abs(last.close - last.open);
  const range = Math.max(last.high - last.low, Number.EPSILON);
  const closeStrength = (last.close - last.low) / range;
  let score = Math.min(30, touches * 9);
  if (
    status === "fresh_breakout" ||
    status === "confirmed_breakout" ||
    status === "retest"
  ) {
    score += 26;
    if (body / range >= 0.45) score += 12;
    if (closeStrength >= 0.7) score += 10;
    if (last.close - currentLevel >= atr * 0.35) score += 8;
  } else if (status === "approaching") {
    score += 16;
  } else if (status === "fakeout") {
    score = Math.max(0, score - 8);
  }

  return {
    source,
    status,
    level: round(currentLevel),
    score: Math.min(100, Math.round(score)),
    touches,
    breakIndex: breakoutIndex,
    quietZone,
    reasons,
    trendline,
    retestZone,
    breakoutLevel,
    breakoutTolerance: tolerance,
    lifecycle,
  };
}

function chooseCandidate(
  candidates: CandidateEvidence[],
): CandidateEvidence | null {
  if (candidates.length === 0) return null;
  // A close back below a just-broken, multi-touch level is a stronger warning
  // than a parallel line that still looks technically intact.
  const fakeouts = candidates.filter(
    (candidate) => candidate.status === "fakeout",
  );
  if (fakeouts.length > 0) {
    return [...fakeouts].sort((left, right) => right.score - left.score)[0]!;
  }
  const statusWeight: Record<BreakoutStatus, number> = {
    fresh_breakout: 6,
    retest: 5,
    confirmed_breakout: 4,
    approaching: 3,
    fakeout: 2,
    no_breakout: 1,
    insufficient_data: 0,
  };
  return [...candidates].sort(
    (left, right) =>
      statusWeight[right.status] - statusWeight[left.status] ||
      right.score - left.score,
  )[0]!;
}

export function analyzeBreakout(
  rawCandles: BreakoutCandle[],
  timeframe: BreakoutTimeframe = "30m",
): BreakoutEvidence {
  const candles = rawCandles.filter(
    (candle) =>
      finite(candle.time) &&
      finite(candle.open) &&
      finite(candle.high) &&
      finite(candle.low) &&
      finite(candle.close) &&
      candle.high >= candle.low,
  );

  const empty: BreakoutEvidence = {
    status: "insufficient_data",
    kind: "none",
    breakoutSource: "none",
    timeframe,
    score: 0,
    quietZone: false,
    breakoutLevel: null,
    distanceFromLevelPct: null,
    barsSinceBreakout: null,
    touches: 0,
    roomToResistancePct: null,
    breakoutTolerance: null,
    breakoutZone: null,
    lifecycle: null,
    reasons: [
      `Недостаточно закрытых ${timeframe === "30m" ? "30-минутных" : timeframe === "1h" ? "часовых" : "4-часовых"} свечей для анализа`,
    ],
    pivots: [],
    levels: [],
    trendline: null,
    retestZone: null,
  };
  if (candles.length < MIN_CANDLES) return empty;

  const atr = calculateAtr(candles);
  if (!finite(atr) || atr <= 0) return empty;

  const pivots = findPivots(candles);
  const levels = horizontalLevels(pivots, atr);
  const trendline = bestResistanceTrendline(pivots, atr);
  const candidates: CandidateEvidence[] = [];

  for (const level of levels) {
    candidates.push(
      classifyCandidate(
        candles,
        "horizontal",
        () => level.price,
        level.price,
        level.touches,
        atr,
        null,
      ),
    );
  }

  if (trendline) {
    const slope =
      (trendline.endPrice - trendline.startPrice) /
      (trendline.endIndex - trendline.startIndex);
    const levelAt = (index: number) =>
      trendline.startPrice + slope * (index - trendline.startIndex);
    candidates.push(
      classifyCandidate(
        candles,
        "trendline",
        levelAt,
        levelAt(candles.length - 1),
        2,
        atr,
        trendline,
      ),
    );
  }

  const selected = chooseCandidate(candidates);
  if (!selected) {
    return {
      ...empty,
      status: "no_breakout",
      reasons: ["Подтверждённый уровень сопротивления не найден"],
      pivots,
      levels,
      trendline,
    };
  }

  const latest = candles[candles.length - 1]!;
  const levelDistancePct =
    selected.level > 0
      ? round(((latest.close - selected.level) / selected.level) * 100, 3)
      : null;
  const nextResistance = levels
    .filter(
      (item) =>
        item.price > latest.close + Math.max(atr * 0.5, latest.close * 0.002),
    )
    .sort((left, right) => left.price - right.price)[0];
  const roomToResistancePct = nextResistance
    ? round(((nextResistance.price - latest.close) / latest.close) * 100, 3)
    : null;
  const hasHorizontal = candidates.some(
    (candidate) =>
      candidate.source === "horizontal" && candidate.status !== "no_breakout",
  );
  const hasTrendline = candidates.some(
    (candidate) =>
      candidate.source === "trendline" && candidate.status !== "no_breakout",
  );

  return {
    status: selected.status,
    kind: hasHorizontal && hasTrendline ? "both" : selected.source,
    breakoutSource: selected.source,
    timeframe,
    score: selected.score,
    quietZone: selected.quietZone,
    breakoutLevel: selected.breakoutLevel ?? selected.level,
    distanceFromLevelPct: levelDistancePct,
    barsSinceBreakout:
      selected.breakIndex === null
        ? null
        : candles.length - 1 - selected.breakIndex,
    touches: selected.touches,
    roomToResistancePct,
    breakoutTolerance: selected.breakoutTolerance,
    breakoutZone: {
      lower: round(
        (selected.breakoutLevel ?? selected.level) - selected.breakoutTolerance,
      ),
      upper: round(
        (selected.breakoutLevel ?? selected.level) + selected.breakoutTolerance,
      ),
    },
    lifecycle: selected.lifecycle,
    reasons: selected.reasons,
    pivots,
    levels,
    trendline: selected.trendline ?? trendline,
    retestZone: selected.retestZone,
  };
}

function emptyStealthStructure(): BreakoutEvidence {
  return {
    status: "insufficient_data",
    kind: "none",
    breakoutSource: "none",
    timeframe: "4h",
    score: 0,
    quietZone: false,
    breakoutLevel: null,
    distanceFromLevelPct: null,
    barsSinceBreakout: null,
    touches: 0,
    roomToResistancePct: null,
    breakoutTolerance: null,
    breakoutZone: null,
    lifecycle: null,
    reasons: ["Недостаточно закрытых 4-часовых свечей для структуры"],
    pivots: [],
    levels: [],
    trendline: null,
    retestZone: null,
  };
}

/**
 * Finds a new resistance shelf created after a strong 1H impulse. This is a
 * separate continuation method: it does not relax the multi-pivot 4H Stealth
 * structure and only consumes closed event-time candles supplied by callers.
 */
export function analyzeStealthContinuationShelf(
  rawCandles: BreakoutCandle[],
): ContinuationShelfEvidence {
  const candles = rawCandles
    .filter(
      (candle) =>
        finite(candle.time) &&
        finite(candle.open) &&
        finite(candle.high) &&
        finite(candle.low) &&
        finite(candle.close) &&
        candle.high >= candle.low,
    )
    .sort((left, right) => left.time - right.time);
  const baseEmpty = emptyStealthStructure();
  const empty: ContinuationShelfEvidence = {
    ...baseEmpty,
    reasons: ["1H: свежая полка продолжения не подтверждена"],
    continuationShelf: null,
  };
  if (candles.length < 20) return empty;
  const oneHourMs = 60 * 60 * 1000;
  if (
    candles
      .slice(-13)
      .some(
        (candle, index, recent) =>
          index > 0 && candle.time - recent[index - 1]!.time !== oneHourMs,
      )
  ) {
    return {
      ...empty,
      reasons: ["1H: полка отклонена из-за разрыва event-time свечей"],
    };
  }

  const atr = calculateAtr(candles);
  if (!finite(atr) || atr <= 0) return empty;

  const lastIndex = candles.length - 1;
  const firstImpulseIndex = Math.max(2, lastIndex - 12);
  let selected:
    | {
        impulseIndex: number;
        impulseStartPrice: number;
        impulseEndPrice: number;
        impulsePct: number;
        consolidationFromIndex: number;
        consolidationToIndex: number;
        shelfLower: number;
        shelfUpper: number;
        level: number;
      }
    | undefined;

  for (
    let impulseIndex = firstImpulseIndex;
    impulseIndex <= lastIndex - 3;
    impulseIndex += 1
  ) {
    const impulse = candles[impulseIndex]!;
    const impulseStartPrice = candles[impulseIndex - 2]!.close;
    const impulseMove = impulse.close - impulseStartPrice;
    const impulsePct = (impulseMove / impulseStartPrice) * 100;
    if (
      impulseMove < atr * 3 ||
      impulsePct < 4 ||
      impulse.close - impulse.open < atr * 1.5 ||
      impulse.close <= impulse.open
    ) {
      continue;
    }

    const consolidation = candles.slice(impulseIndex + 1);
    if (consolidation.length < 3 || consolidation.length > 8) continue;
    const highs = consolidation.map((candle) => candle.high);
    const lows = consolidation.map((candle) => candle.low);
    const shelfLower = Math.min(...highs);
    const shelfUpper = Math.max(...highs);
    const level = median(highs);
    const maxShelfWidth = Math.max(atr * 1.2, level * 0.015);
    const maxConsolidationRange = Math.max(atr * 3.5, level * 0.04);
    const heldBelowShelf = consolidation.every(
      (candle) => candle.close <= level + Math.max(atr * 0.2, level * 0.0015),
    );
    const touchTolerance = Math.max(atr * 0.3, level * 0.004);
    const hasRepeatedShelf =
      highs.filter((high) => Math.abs(high - level) <= touchTolerance).length >=
      2;
    if (
      shelfUpper - shelfLower > maxShelfWidth ||
      Math.max(...highs) - Math.min(...lows) > maxConsolidationRange ||
      !heldBelowShelf ||
      !hasRepeatedShelf
    ) {
      continue;
    }
    selected = {
      impulseIndex,
      impulseStartPrice,
      impulseEndPrice: impulse.close,
      impulsePct,
      consolidationFromIndex: impulseIndex + 1,
      consolidationToIndex: lastIndex,
      shelfLower,
      shelfUpper,
      level,
    };
  }

  if (!selected) return empty;
  const latest = candles[lastIndex]!;
  const tolerance = Math.max(atr * 0.35, selected.level * 0.0025);
  const distanceFromLevelPct =
    ((latest.close - selected.level) / selected.level) * 100;
  if (distanceFromLevelPct > 0 || distanceFromLevelPct < -3) return empty;

  const nearestUpperResistance =
    candles
      .slice(0, selected.impulseIndex)
      .map((candle) => candle.high)
      .filter((high) => high > selected.shelfUpper + tolerance)
      .sort((left, right) => left - right)[0] ?? null;
  const pivots = findPivots(candles);
  const levels = horizontalLevels(pivots, atr);
  return {
    status: "approaching",
    kind: "horizontal",
    breakoutSource: "horizontal",
    timeframe: "4h",
    score: 72,
    quietZone: true,
    breakoutLevel: round(selected.level),
    distanceFromLevelPct: round(distanceFromLevelPct, 3),
    barsSinceBreakout: null,
    touches: Math.max(
      2,
      selected.consolidationToIndex - selected.consolidationFromIndex + 1,
    ),
    roomToResistancePct:
      nearestUpperResistance === null
        ? null
        : round(
            ((nearestUpperResistance - latest.close) / latest.close) * 100,
            3,
          ),
    breakoutTolerance: tolerance,
    breakoutZone: {
      lower: round(selected.shelfLower - tolerance),
      upper: round(selected.shelfUpper + tolerance),
    },
    lifecycle: null,
    reasons: [
      "1H: свежая полка подтверждена после сильного импульса",
      nearestUpperResistance === null
        ? "Ближайшее старое верхнее сопротивление не найдено"
        : `Старое верхнее сопротивление ${round(nearestUpperResistance)} сохранено как контекст`,
    ],
    pivots,
    levels,
    trendline: null,
    retestZone: null,
    continuationShelf: {
      method: "post_impulse_consolidation_v1",
      impulseIndex: selected.impulseIndex,
      impulseStartPrice: round(selected.impulseStartPrice),
      impulseEndPrice: round(selected.impulseEndPrice),
      impulsePct: round(selected.impulsePct, 3),
      consolidationFromIndex: selected.consolidationFromIndex,
      consolidationToIndex: selected.consolidationToIndex,
      shelfLower: round(selected.shelfLower),
      shelfUpper: round(selected.shelfUpper),
      nearestUpperResistance:
        nearestUpperResistance === null ? null : round(nearestUpperResistance),
    },
  };
}

export function chooseStealthResistanceCeiling<
  T extends { level: number; touches: number },
>(candidates: readonly T[], latestClose: number, tolerance: number): T | null {
  const nearest = [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(left.level - latestClose);
    const rightDistance = Math.abs(right.level - latestClose);
    return leftDistance - rightDistance || right.touches - left.touches;
  })[0];
  if (!nearest) return null;

  const immediateCeiling =
    [...candidates]
      .filter(
        (candidate) =>
          candidate.level >= nearest.level &&
          candidate.level <= nearest.level + tolerance,
      )
      .sort(
        (left, right) =>
          right.level - left.level || right.touches - left.touches,
      )[0] ?? nearest;

  // A weak inner shelf is not the breakout boundary when a clearly stronger
  // horizontal ceiling remains just above it. HOME exposed this case: 0.0062
  // had two touches, while the visible quiet-zone resistance at 0.0064 had
  // three; a close at 0.006303 cleared only the inner shelf. Keep the search
  // bounded both by volatility and by distance from price so a much higher,
  // unrelated historical level cannot replace the actionable resistance.
  const strongerNearbyCeiling = [...candidates]
    .filter(
      (candidate) =>
        candidate.level > immediateCeiling.level &&
        candidate.touches > immediateCeiling.touches &&
        candidate.level <= immediateCeiling.level + tolerance * 3 &&
        candidate.level <= latestClose * 1.06,
    )
    .sort(
      (left, right) => right.touches - left.touches || left.level - right.level,
    )[0];

  const sameStrengthNearbyCeiling = [...candidates]
    .filter(
      (candidate) =>
        candidate.level > immediateCeiling.level &&
        candidate.touches === immediateCeiling.touches &&
        candidate.level <= immediateCeiling.level * 1.06,
    )
    .sort((left, right) => right.level - left.level)[0];

  return strongerNearbyCeiling ?? sameStrengthNearbyCeiling ?? immediateCeiling;
}

/**
 * Finds the 4h resistance and checks the quiet zone without requiring the 4h
 * candle itself to break it. This is the structure layer for Stealth.
 */
export function analyzeStealthStructure(
  rawCandles: BreakoutCandle[],
): BreakoutEvidence {
  const candles = rawCandles.filter(
    (candle) =>
      finite(candle.time) &&
      finite(candle.open) &&
      finite(candle.high) &&
      finite(candle.low) &&
      finite(candle.close) &&
      candle.high >= candle.low,
  );
  const empty = emptyStealthStructure();
  if (candles.length < MIN_CANDLES) return empty;

  const atr = calculateAtr(candles);
  if (!finite(atr) || atr <= 0) return empty;

  const pivots = findPivots(candles);
  const levels = horizontalLevels(pivots, atr, true);
  const trendline = bestResistanceTrendline(pivots, atr);
  const latest = candles[candles.length - 1]!;
  const candidates: Array<{
    source: "horizontal" | "trendline";
    levelAt: (index: number) => number;
    level: number;
    touches: number;
    trendline: BreakoutTrendline | null;
  }> = levels.map((level) => ({
    source: "horizontal" as const,
    levelAt: () => level.price,
    level: level.price,
    touches: level.touches,
    trendline: null,
  }));

  if (trendline) {
    const slope =
      (trendline.endPrice - trendline.startPrice) /
      (trendline.endIndex - trendline.startIndex);
    candidates.push({
      source: "trendline",
      levelAt: (index) =>
        trendline.startPrice + slope * (index - trendline.startIndex),
      level:
        trendline.startPrice +
        slope * (candles.length - 1 - trendline.startIndex),
      touches: 2,
      trendline,
    });
  }

  const tolerance = Math.max(atr * 0.65, latest.close * 0.0025);
  // An already-broken 4H level is not a fresh resistance just because the
  // last eight candles have settled below it again. Otherwise a prior impulse
  // can re-arm an inner shelf and the next 1H cross becomes a false breakout.
  const unbrokenCandidates = candidates.filter((candidate) => {
    const start = Math.max(0, candles.length - 12);
    return !candles.slice(start).some((candle, offset) => {
      const levelAtCandle = candidate.levelAt(start + offset);
      return (
        candle.close >
        levelAtCandle + Math.max(atr * 0.15, levelAtCandle * 0.0025)
      );
    });
  });
  const resistanceCandidates = unbrokenCandidates.filter(
    (candidate) =>
      candidate.levelAt(candles.length - 1) >= latest.close - tolerance,
  );
  const pool =
    resistanceCandidates.length > 0 ? resistanceCandidates : unbrokenCandidates;
  // A descending trendline can project below a still-relevant horizontal
  // ceiling. Crossing that lower line is not a breakout while the nearby
  // overhead resistance remains intact, so freeze the highest candidate in
  // the same ATR-sized resistance cluster.
  const selected = chooseStealthResistanceCeiling(
    pool,
    latest.close,
    tolerance,
  );
  if (!selected) {
    return {
      ...empty,
      status: "no_breakout",
      reasons: ["Подтверждённая 4H структура сопротивления не найдена"],
      pivots,
      levels,
      trendline,
    };
  }

  const selectedLevelAt = selected.levelAt;
  const level = selectedLevelAt(candles.length - 1);
  const quietZone = hasQuietZone(
    candles,
    candles.length,
    selectedLevelAt,
    tolerance,
    atr,
  );
  const distanceFromLevelPct =
    level > 0 ? round(((latest.close - level) / level) * 100, 3) : null;
  const reasons = quietZone
    ? ["4H: сопротивление сформировано, перед ним есть тихая зона"]
    : ["4H: тихая зона перед сопротивлением не подтверждена"];

  return {
    status: quietZone ? "approaching" : "no_breakout",
    kind: selected.source,
    breakoutSource: selected.source,
    timeframe: "4h",
    score: Math.min(100, selected.touches * 12 + (quietZone ? 30 : 0)),
    quietZone,
    breakoutLevel: round(level),
    distanceFromLevelPct,
    barsSinceBreakout: null,
    touches: selected.touches,
    roomToResistancePct: null,
    breakoutTolerance: tolerance,
    breakoutZone: {
      lower: round(level - tolerance),
      upper: round(level + tolerance),
    },
    lifecycle: null,
    reasons,
    pivots,
    levels,
    trendline: selected.trendline ?? trendline,
    retestZone: null,
  };
}

/**
 * Confirms that the latest closed 1h candle is the actual cross of the 4h
 * resistance. A forming candle is removed by the caller's normalization.
 */
export function confirmStealthOneHourBreakout(
  structure: Pick<BreakoutEvidence, "breakoutLevel">,
  candles: BreakoutCandle[],
): StealthOneHourConfirmation {
  const empty: StealthOneHourConfirmation = {
    status: "insufficient_data",
    timeframe: "1h",
    crossed: false,
    breakoutLevel: structure.breakoutLevel,
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
    reasons: ["Недостаточно 1H свечей для подтверждения пробоя"],
  };
  if (structure.breakoutLevel === null || candles.length < 2) return empty;

  const latest = candles[candles.length - 1]!;
  const previous = candles[candles.length - 2]!;
  const atr = calculateAtr(candles);
  const level = structure.breakoutLevel;
  const buffer = Math.max(level * 0.0015, atr * 0.35);
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const body = Math.abs(latest.close - latest.open);
  const closeStrength = (latest.close - latest.low) / range;
  const metrics = {
    atr,
    bodyAtr: atr > 0 ? body / atr : null,
    bodyRange: body / range,
    closeDistanceAtr: atr > 0 ? (latest.close - level) / atr : null,
    previousClose: previous.close,
    triggerCandle: latest,
  };
  const breakoutIndex = recentCross(candles, () => level, buffer);
  const retestIndices: number[] = [];
  if (breakoutIndex !== null) {
    for (let index = breakoutIndex + 1; index < candles.length; index += 1) {
      const candle = candles[index]!;
      const isRetest =
        candle.low >= level - buffer && candle.low <= level + buffer;
      if (isRetest && retestIndices[retestIndices.length - 1] !== index - 1) {
        retestIndices.push(index);
      }
    }
  }
  const lifecycle =
    breakoutIndex === null
      ? null
      : {
          breakoutIndex,
          endIndex: candles.length - 1,
          retestIndices,
        };
  const breakoutZone = {
    lower: round(level - buffer),
    upper: round(level + buffer),
  };
  const distanceFromLevelPct =
    level > 0 ? round(((latest.close - level) / level) * 100, 3) : null;
  const crossed =
    previous.close <= level + buffer && latest.close > level + buffer;
  const crossedFromBelow =
    previous.close <= level - buffer && latest.open <= level + buffer;
  const strictCandleConfirmation =
    crossedFromBelow &&
    closeStrength >= 0.75 &&
    metrics.bodyRange >= 0.5 &&
    body >= atr * 0.35;
  const decisiveDisplacementConfirmation =
    previous.close <= level + buffer &&
    latest.open <= level + buffer &&
    closeStrength >= 0.65 &&
    metrics.bodyRange >= 0.4 &&
    body >= atr * 0.35 &&
    latest.close - level >= Math.max(level * 0.006, atr * 0.5);
  const closeConfirmed =
    strictCandleConfirmation || decisiveDisplacementConfirmation;

  if (latest.close < level - buffer) {
    return {
      ...empty,
      status: "fakeout",
      crossed,
      breakoutTolerance: buffer,
      breakoutZone,
      lifecycle,
      distanceFromLevelPct,
      closeStrength,
      ...metrics,
      reasons: ["1H цена закрылась ниже уровня сопротивления"],
    };
  }
  if (!crossed || !closeConfirmed) {
    return {
      ...empty,
      status: "no_breakout",
      crossed,
      breakoutTolerance: buffer,
      breakoutZone,
      lifecycle,
      distanceFromLevelPct,
      closeStrength,
      ...metrics,
      reasons: [
        crossed
          ? "1H пробой есть, но закрытие или смещение над уровнем недостаточно сильное"
          : "Последняя закрытая 1H свеча не пересекла 4H уровень",
      ],
    };
  }

  return {
    status: "fresh_breakout",
    timeframe: "1h",
    crossed: true,
    breakoutLevel: level,
    breakoutTolerance: buffer,
    breakoutZone,
    lifecycle,
    distanceFromLevelPct,
    closeStrength,
    ...metrics,
    reasons: ["Свежий пробой 4H сопротивления на закрытой 1H свече"],
  };
}

/**
 * Live Stealth confirmation.  This is intentionally separate from the 1H
 * telemetry helper above: a 1H cross can describe market context, but it can
 * never consume a quiet-zone arm.
 *
 * Callers may pass a forming candle; the event-time check below makes it
 * ineligible until candle.time + 4h <= evaluatedAt.
 */
export function confirmStealthFourHourBreakout(
  structure: Pick<BreakoutEvidence, "breakoutLevel">,
  candles: readonly BreakoutCandle[],
  evaluatedAt = Number.POSITIVE_INFINITY,
): StealthFourHourConfirmation {
  const empty: StealthFourHourConfirmation = {
    status: "insufficient_data",
    timeframe: "4h",
    crossed: false,
    breakoutLevel: structure.breakoutLevel,
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
    reasons: ["Недостаточно закрытых 4H свечей для подтверждения пробоя"],
  };
  if (structure.breakoutLevel === null) return empty;
  const ordered = [...candles]
    .filter(
      (candle) =>
        finite(candle.time) &&
        finite(candle.open) &&
        finite(candle.high) &&
        finite(candle.low) &&
        finite(candle.close),
    )
    .sort((left, right) => left.time - right.time);
  const closed = ordered.filter(
    (candle) => candle.time + FOUR_HOURS_MS <= evaluatedAt,
  );
  if (closed.length < 2) return empty;

  const level = structure.breakoutLevel;
  const atr = calculateAtr(closed);
  if (!finite(atr) || atr <= 0) return empty;
  const buffer = Math.max(level * 0.0015, atr * 0.35);
  let breakoutIndex: number | null = null;
  for (let index = 1; index < closed.length; index += 1) {
    const previous = closed[index - 1]!;
    const current = closed[index]!;
    // The previous close must be at/below the frozen resistance.  In
    // particular, a previous close merely inside the tolerance zone is not a
    // fresh crossing.
    if (previous.close <= level && current.close > level + buffer) {
      breakoutIndex = index;
      break;
    }
  }
  const latest = closed[closed.length - 1]!;
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const body = Math.abs(latest.close - latest.open);
  const closeStrength = (latest.close - latest.low) / range;
  const metrics = {
    atr,
    bodyAtr: atr > 0 ? body / atr : null,
    bodyRange: body / range,
    closeDistanceAtr: atr > 0 ? (latest.close - level) / atr : null,
    previousClose:
      breakoutIndex === null
        ? closed[closed.length - 2]!.close
        : closed[breakoutIndex - 1]!.close,
    triggerCandle: breakoutIndex === null ? null : closed[breakoutIndex]!,
  };
  const lifecycle =
    breakoutIndex === null
      ? null
      : {
          breakoutIndex,
          endIndex: closed.length - 1,
          retestIndices: [] as number[],
        };
  const breakoutZone = {
    lower: round(level - buffer),
    upper: round(level + buffer),
  };
  const distanceFromLevelPct =
    level > 0 ? round(((latest.close - level) / level) * 100, 3) : null;
  if (breakoutIndex === null) {
    return {
      ...empty,
      status: "no_breakout",
      breakoutTolerance: buffer,
      breakoutZone,
      lifecycle,
      distanceFromLevelPct,
      closeStrength,
      ...metrics,
      reasons: [
        "Последняя закрытая 4H свеча не пересекла frozen 4H resistance",
      ],
    };
  }
  const trigger = closed[breakoutIndex]!;
  const triggerRange = Math.max(trigger.high - trigger.low, Number.EPSILON);
  const triggerBody = Math.abs(trigger.close - trigger.open);
  const triggerStrength = (trigger.close - trigger.low) / triggerRange;
  const decisive =
    trigger.close > level + buffer &&
    triggerStrength >= 0.65 &&
    triggerBody / triggerRange >= 0.4 &&
    triggerBody >= atr * 0.35;
  const triggerDistancePct =
    level > 0 ? round(((trigger.close - level) / level) * 100, 3) : null;
  if (!decisive) {
    return {
      ...empty,
      status: "no_breakout",
      crossed: true,
      breakoutTolerance: buffer,
      breakoutZone,
      lifecycle,
      distanceFromLevelPct: triggerDistancePct,
      closeStrength: triggerStrength,
      atr,
      bodyAtr: atr > 0 ? triggerBody / atr : null,
      bodyRange: triggerBody / triggerRange,
      closeDistanceAtr: atr > 0 ? (trigger.close - level) / atr : null,
      previousClose: closed[breakoutIndex - 1]!.close,
      triggerCandle: trigger,
      reasons: ["4H close crossed resistance but was not decisive"],
    };
  }
  return {
    status: "fresh_breakout",
    timeframe: "4h",
    crossed: true,
    breakoutLevel: level,
    breakoutTolerance: buffer,
    breakoutZone,
    lifecycle,
    distanceFromLevelPct: triggerDistancePct,
    closeStrength: triggerStrength,
    atr,
    bodyAtr: atr > 0 ? triggerBody / atr : null,
    bodyRange: triggerBody / triggerRange,
    closeDistanceAtr: atr > 0 ? (trigger.close - level) / atr : null,
    previousClose: closed[breakoutIndex - 1]!.close,
    triggerCandle: trigger,
    reasons: [
      "Свежий decisive breakout frozen 4H resistance на закрытой 4H свече",
    ],
  };
}

/**
 * ARMED may only be created while price is still below a fresh 4H resistance.
 * A level that was already held above during the recent 4H window belongs to
 * an old breakout lifecycle and must not be resurrected as a new setup.
 */
export function isStealthStructureReadyToArm(
  structure: Pick<
    BreakoutEvidence,
    | "status"
    | "quietZone"
    | "breakoutLevel"
    | "breakoutZone"
    | "distanceFromLevelPct"
    | "touches"
  >,
  confirmationCandles: readonly BreakoutCandle[],
): boolean {
  if (
    structure.status !== "approaching" ||
    !structure.quietZone ||
    structure.breakoutLevel === null ||
    structure.touches < 2 ||
    confirmationCandles.length < 8
  ) {
    return false;
  }
  const level = structure.breakoutLevel;
  const distance = structure.distanceFromLevelPct;
  if (distance === null || distance > 0 || distance < -3) return false;

  const recent = confirmationCandles.slice(-8);
  const latest = recent[recent.length - 1]!;
  return (
    latest.close <= level && recent.every((candle) => candle.close <= level)
  );
}

/**
 * 30m is deliberately not a breakout detector. It only prevents a late entry
 * after price has run too far, or a stale entry after a rejection.
 */
export function refineStealthBreakoutEntry(
  structure: Pick<BreakoutEvidence, "breakoutLevel">,
  candles: BreakoutCandle[],
  options: {
    confirmationStartsAt?: number;
    requiredConsecutiveCloses?: number;
    confirmationTimeframe?: "30m" | "1h";
    /** Range signals require immediate, gap-free candles strictly above the level. */
    requireContinuousHold?: boolean;
    /** Late-entry cap in % above the level; defaults to 2.5. */
    maxDistancePct?: number;
  } = {},
): StealthThirtyMinuteRefinement {
  const timeframe = options.confirmationTimeframe ?? "30m";
  const intervalMs = timeframe === "1h" ? 60 * 60 * 1000 : 30 * 60 * 1000;
  const requiredConsecutiveCloses = Math.max(
    1,
    options.requiredConsecutiveCloses ?? 1,
  );
  const eligibleCandles = candles
    .slice()
    .sort((left, right) => left.time - right.time)
    .filter(
      (candle) =>
        options.confirmationStartsAt === undefined ||
        candle.time >= options.confirmationStartsAt,
    );
  const empty: StealthThirtyMinuteRefinement = {
    status: "insufficient_data",
    timeframe,
    distanceFromLevelPct: null,
    closeStrength: null,
    consecutiveClosesAbove: 0,
    confirmationCandleTimes: [],
    confirmationAt: null,
    reasons: ["Недостаточно 30m свечей для уточнения входа"],
  };
  if (structure.breakoutLevel === null || eligibleCandles.length === 0)
    return empty;

  const latest = eligibleCandles[eligibleCandles.length - 1]!;
  const level = structure.breakoutLevel;
  const range = Math.max(latest.high - latest.low, Number.EPSILON);
  const closeStrength = (latest.close - latest.low) / range;
  const distanceFromLevelPct =
    level > 0 ? round(((latest.close - level) / level) * 100, 3) : null;

  const firstRejected =
    options.confirmationStartsAt === undefined
      ? (
          options.requireContinuousHold
            ? latest.close <= level
            : latest.close < level
        )
        ? latest
        : undefined
      : eligibleCandles.find((candle) =>
          options.requireContinuousHold
            ? candle.close <= level
            : candle.close < level,
        );
  if (firstRejected) {
    return {
      status: "rejected",
      timeframe,
      distanceFromLevelPct,
      closeStrength,
      consecutiveClosesAbove: 0,
      confirmationCandleTimes: [],
      confirmationAt: null,
      reasons: [`${timeframe} цена не закрепилась выше пробитого уровня`],
    };
  }
  const confirmationCandles = eligibleCandles.slice(
    0,
    requiredConsecutiveCloses,
  );
  const confirmationCandleTimes = confirmationCandles.map(
    (candle) => candle.time,
  );
  const confirmationAt =
    confirmationCandles.length === requiredConsecutiveCloses
      ? confirmationCandles[confirmationCandles.length - 1]!.time + intervalMs
      : null;
  if (
    options.requireContinuousHold &&
    (options.confirmationStartsAt === undefined ||
      confirmationCandles.length < requiredConsecutiveCloses ||
      confirmationCandles.some(
        (candle, index) =>
          candle.time !== options.confirmationStartsAt! + index * intervalMs,
      ))
  ) {
    return {
      ...empty,
      distanceFromLevelPct,
      closeStrength,
      consecutiveClosesAbove: confirmationCandles.length,
      confirmationCandleTimes,
      reasons: [
        `Нужны ${requiredConsecutiveCloses} подряд закрытые ${timeframe} свечи сразу после пробоя`,
      ],
    };
  }
  if ((distanceFromLevelPct ?? 0) > (options.maxDistancePct ?? 2.5)) {
    return {
      status: "extended",
      timeframe,
      distanceFromLevelPct,
      closeStrength,
      consecutiveClosesAbove: eligibleCandles.length,
      confirmationCandleTimes,
      confirmationAt,
      reasons: [`${timeframe} движение уже слишком далеко от уровня для входа`],
    };
  }
  if (eligibleCandles.length < requiredConsecutiveCloses) {
    return {
      ...empty,
      distanceFromLevelPct,
      closeStrength,
      consecutiveClosesAbove: eligibleCandles.length,
      confirmationCandleTimes,
      reasons: [
        `Ожидается ещё ${requiredConsecutiveCloses - eligibleCandles.length} закрытая ${timeframe} свеча выше пробитого уровня`,
      ],
    };
  }
  return {
    status: "near_level",
    timeframe,
    distanceFromLevelPct,
    closeStrength,
    consecutiveClosesAbove: eligibleCandles.length,
    confirmationCandleTimes,
    confirmationAt,
    reasons: [
      requiredConsecutiveCloses > 1
        ? `${requiredConsecutiveCloses} закрытые ${timeframe} свечи удержались выше пробитого уровня`
        : `${timeframe} цена остаётся рядом с уровнем — вход не запоздал`,
    ],
  };
}

/**
 * Produces the three evidence layers shown in the Breakout Analysis detail
 * view. Keeping this composition pure prevents the chart from drifting from
 * the live scanner's 4H resistance → closed 4H breakout → 30m sequence. The
 * returned 1H confirmation remains optional chart telemetry.
 */
export function analyzeStealthBreakoutTimeframes(input: {
  structureCandles: readonly BreakoutCandle[];
  breakoutCandles4h: readonly BreakoutCandle[];
  contextCandles1h?: BreakoutCandle[];
  refinementCandles: readonly BreakoutCandle[];
  evaluatedAt: number;
}): StealthBreakoutTimeframeAnalysis {
  const closed4h = input.breakoutCandles4h
    .slice()
    .sort((left, right) => left.time - right.time)
    .filter((candle) => candle.time + FOUR_HOURS_MS <= input.evaluatedAt);
  const structureCandles = input.structureCandles.filter(
    (candle) => candle.time + FOUR_HOURS_MS <= input.evaluatedAt,
  );
  const structure = analyzeStealthStructure(structureCandles);
  return {
    structure,
    confirmation: confirmStealthFourHourBreakout(
      structure,
      closed4h,
      input.evaluatedAt,
    ),
    oneHourContext: input.contextCandles1h
      ? confirmStealthOneHourBreakout(
          structure,
          input.contextCandles1h.filter(
            (candle) => candle.time + 60 * 60 * 1000 <= input.evaluatedAt,
          ),
        )
      : null,
    refinement: refineStealthBreakoutEntry(
      structure,
      input.refinementCandles.filter(
        (candle) => candle.time + 30 * 60 * 1000 <= input.evaluatedAt,
      ),
    ),
  };
}

export type StealthReplayHorizon = 4 | 8 | 24 | 48;

export interface StealthReplayOutcome {
  status: "complete" | "not_available";
  closeAt: number | null;
  closePct: number | null;
  peakPct: number | null;
}

export interface StealthReplayEvent {
  eventAt: number;
  entryPrice: number;
  technicalPass: boolean;
  technicalRejectReason: string | null;
  structure: {
    kind: BreakoutKind;
    breakoutSource: "horizontal" | "trendline" | "none";
    quietZone: boolean;
    horizontalLevel: number | null;
    horizontalTouches: number;
    breakoutLevel: number | null;
    trendline: BreakoutTrendline | null;
  };
  confirmation: {
    status: StealthFourHourConfirmation["status"];
    breakoutAt: number | null;
    distanceFromLevelPct: number | null;
    closeStrength: number | null;
  };
  refinement: {
    status: StealthThirtyMinuteRefinement["status"];
    distanceFromLevelPct: number | null;
    closeStrength: number | null;
  };
  flow: {
    status: "not_available";
    oi: null;
    cvd: null;
    spotTaker: null;
  };
  outcomes: Record<`h${StealthReplayHorizon}`, StealthReplayOutcome>;
}

export interface StealthReplayResult {
  events: StealthReplayEvent[];
  closedCandles: {
    structure: number;
    confirmation: number;
    refinement: number;
  };
}

const REPLAY_INTERVAL_MS = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
} as const;

function candleCloseAt(
  candle: BreakoutCandle,
  timeframe: keyof typeof REPLAY_INTERVAL_MS,
): number {
  return candle.time + REPLAY_INTERVAL_MS[timeframe];
}

function latestClosedCandle(
  candles: BreakoutCandle[],
  timeframe: keyof typeof REPLAY_INTERVAL_MS,
  at: number,
): BreakoutCandle | null {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candleCloseAt(candles[index]!, timeframe) <= at) {
      return candles[index]!;
    }
  }
  return null;
}

function candlesClosedBy(
  candles: BreakoutCandle[],
  timeframe: keyof typeof REPLAY_INTERVAL_MS,
  at: number,
): BreakoutCandle[] {
  return candles.filter((candle) => candleCloseAt(candle, timeframe) <= at);
}

function replayOutcome(
  candles: BreakoutCandle[],
  eventAt: number,
  entryPrice: number,
  horizonHours: StealthReplayHorizon,
): StealthReplayOutcome {
  const target = eventAt + horizonHours * 60 * 60 * 1000;
  const available = candles.filter(
    (candle) =>
      candleCloseAt(candle, "30m") > eventAt &&
      candleCloseAt(candle, "30m") <= target,
  );
  const targetCandle = available[available.length - 1];
  const expectedCandleCount = horizonHours * 2;
  const firstExpectedClose = eventAt + REPLAY_INTERVAL_MS["30m"];
  const hasContiguousCoverage =
    available.length === expectedCandleCount &&
    available.every(
      (candle, index) =>
        candleCloseAt(candle, "30m") ===
        firstExpectedClose + index * REPLAY_INTERVAL_MS["30m"],
    );
  if (!targetCandle || !hasContiguousCoverage) {
    return {
      status: "not_available",
      closeAt: null,
      closePct: null,
      peakPct: null,
    };
  }
  const closePct = ((targetCandle.close - entryPrice) / entryPrice) * 100;
  const peakPct =
    ((Math.max(...available.map((candle) => candle.high)) - entryPrice) /
      entryPrice) *
    100;
  return {
    status: "complete",
    closeAt: candleCloseAt(targetCandle, "30m"),
    closePct: round(closePct, 3),
    peakPct: round(peakPct, 3),
  };
}

function replayRejectReason(
  structure: BreakoutEvidence,
  confirmation: StealthFourHourConfirmation,
  refinement: StealthThirtyMinuteRefinement,
): string | null {
  if (structure.breakoutLevel === null)
    return "4H: горизонтальный уровень или trendline не найден";
  if (!structure.quietZone) return "4H: quiet-zone не подтверждена";
  if (confirmation.status !== "fresh_breakout") {
    return `4H: ${confirmation.reasons[0] ?? "закрытие не прошло технический тест"}`;
  }
  if (refinement.status !== "near_level") {
    return `30m: ${refinement.reasons[0] ?? "вход не прошёл проверку дистанции"}`;
  }
  return null;
}

/**
 * Replays the technical Stealth sequence over historical closed candles.
 *
 * Every event is evaluated at the close of the 4H candle that first crosses
 * the frozen resistance. The structure prefix and the 30m refinement are cut at that same
 * timestamp, so neither the classifier nor the flow placeholder can see the
 * future. OHLCV contains no historical OI/CVD/taker values, therefore flow is
 * explicitly marked unavailable rather than treated as a pass.
 */
export function replayStealthBreakouts(input: {
  structureCandles: BreakoutCandle[];
  breakoutCandles4h: BreakoutCandle[];
  refinementCandles: BreakoutCandle[];
  fromTime: number;
  toTime: number;
}): StealthReplayResult {
  const breakoutCandles4h = [...input.breakoutCandles4h].sort(
    (a, b) => a.time - b.time,
  );
  const events = new Map<number, StealthReplayEvent>();

  for (let index = 1; index < breakoutCandles4h.length; index += 1) {
    const confirmationCandle = breakoutCandles4h[index]!;
    const previousCandle = breakoutCandles4h[index - 1]!;
    const eventAt = candleCloseAt(confirmationCandle, "4h");
    if (eventAt < input.fromTime || eventAt > input.toTime) continue;

    // Freeze resistance before the candidate candle. A buffered pre-arm or
    // earlier weak cross must never become the confirmation for this event.
    const structureCandles = candlesClosedBy(
      input.structureCandles,
      "4h",
      confirmationCandle.time,
    );
    const structure = analyzeStealthStructure(structureCandles);
    if (
      structure.breakoutLevel === null ||
      previousCandle.close > structure.breakoutLevel ||
      confirmationCandle.close <= structure.breakoutLevel
    ) {
      continue;
    }
    const confirmation = confirmStealthFourHourBreakout(
      structure,
      [previousCandle, confirmationCandle],
      eventAt,
    );
    const refinementPrefix = candlesClosedBy(
      input.refinementCandles,
      "30m",
      eventAt,
    );
    const entryCandle = latestClosedCandle(
      input.refinementCandles,
      "30m",
      eventAt,
    );
    if (!entryCandle || entryCandle.close <= 0) continue;
    if (events.has(eventAt)) continue;
    const refinement = refineStealthBreakoutEntry(structure, refinementPrefix);
    const horizontal = structure.levels
      .slice()
      .sort(
        (left, right) =>
          Math.abs(
            left.price - (structure.breakoutLevel ?? entryCandle.close),
          ) -
          Math.abs(
            right.price - (structure.breakoutLevel ?? entryCandle.close),
          ),
      )[0];
    const rejectReason = replayRejectReason(
      structure,
      confirmation,
      refinement,
    );

    events.set(eventAt, {
      eventAt,
      entryPrice: round(entryCandle.close, 8),
      technicalPass: rejectReason === null,
      technicalRejectReason: rejectReason,
      structure: {
        kind: structure.kind,
        breakoutSource: structure.breakoutSource,
        quietZone: structure.quietZone,
        horizontalLevel: horizontal?.price ?? null,
        horizontalTouches: horizontal?.touches ?? 0,
        breakoutLevel: structure.breakoutLevel,
        trendline: structure.trendline,
      },
      confirmation: {
        status: confirmation.status,
        breakoutAt: eventAt,
        distanceFromLevelPct: confirmation.distanceFromLevelPct,
        closeStrength: confirmation.closeStrength,
      },
      refinement: {
        status: refinement.status,
        distanceFromLevelPct: refinement.distanceFromLevelPct,
        closeStrength: refinement.closeStrength,
      },
      flow: {
        status: "not_available",
        oi: null,
        cvd: null,
        spotTaker: null,
      },
      outcomes: {
        h4: replayOutcome(
          input.refinementCandles,
          eventAt,
          entryCandle.close,
          4,
        ),
        h8: replayOutcome(
          input.refinementCandles,
          eventAt,
          entryCandle.close,
          8,
        ),
        h24: replayOutcome(
          input.refinementCandles,
          eventAt,
          entryCandle.close,
          24,
        ),
        h48: replayOutcome(
          input.refinementCandles,
          eventAt,
          entryCandle.close,
          48,
        ),
      },
    });
  }

  return {
    events: [...events.values()].sort(
      (left, right) => left.eventAt - right.eventAt,
    ),
    closedCandles: {
      structure: input.structureCandles.length,
      confirmation: input.breakoutCandles4h.length,
      refinement: input.refinementCandles.length,
    },
  };
}
