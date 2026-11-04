/**
 * Causal replay of LuxAlgo's default internal order-block path for LC waiting.
 *
 * This is an approximation, not bit-for-bit Pine emulation: Pine runtime
 * series/UDT behavior and ta.atr internals cannot be reproduced exactly.
 * The volatility filter is Cumulative Mean Range (matching the owner's chart
 * settings), not ATR; structure/mitigation logic follows the uploaded source.
 */
export const APPROXIMATION =
  "Bar-by-bar approximation of LuxAlgo Pine v5; Pine runtime series/UDT behavior and chart history length cannot be reproduced bit-for-bit. Volatility filter is Cumulative Mean Range (ta.cum(ta.tr)/bar_index); order-block logic follows the uploaded source.";

export interface LcWaitingObCandle {
  /** Closed candle time in Unix milliseconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface LcWaitingOrderBlock {
  high: number;
  low: number;
  /** LuxAlgo order-block source kind. LC waiting uses internal blocks only. */
  kind: "internal";
  /** Opening time of the confirming candle; confirmation occurs at its close. */
  detectedAt: number;
  /** Candle time of the extremum candle that supplies this zone. */
  createdAt: number;
  bias: "bullish" | "bearish";
}

export interface LcWaitingObReplay {
  /** Newest active internal zones, capped at five across both biases. */
  orderBlocks: LcWaitingOrderBlock[];
  /** Highest active bullish zone top 1–10% below entryPrice, or null. */
  nearestBullishDemandZone: LcWaitingOrderBlock | null;
}

export interface LuxAlgoDemandZoneResult {
  /** Visible newest active internal blocks; both bullish and bearish. */
  zones: LcWaitingOrderBlock[];
  /** Nearest qualifying bullish demand zone, or null when none qualifies. */
  nearest: LcWaitingOrderBlock | null;
}

interface Pivot {
  currentLevel: number | null;
  crossed: boolean;
  barIndex: number | null;
}

interface StructureState {
  kind: "internal" | "swing";
  length: number;
  trackZones: boolean;
  leg: number;
  high: Pivot;
  low: Pivot;
  previousHighLevel: number | null;
  previousLowLevel: number | null;
  previousClose: number | null;
  zones: LcWaitingOrderBlock[];
}

type Bias = LcWaitingOrderBlock["bias"];

function validateInput(candles: LcWaitingObCandle[], entryPrice: number): void {
  if (!Array.isArray(candles)) {
    throw new TypeError("candles must be an array");
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new RangeError("entryPrice must be a positive finite number");
  }

  let previousTime = -Infinity;
  candles.forEach((bar, index) => {
    if (!bar || typeof bar !== "object") {
      throw new TypeError(`candle ${index} must be an object`);
    }
    if (!Number.isFinite(bar.time)) {
      throw new TypeError(`candle ${index}.time must be finite milliseconds`);
    }
    for (const key of ["open", "high", "low", "close"] as const) {
      if (!Number.isFinite(bar[key])) {
        throw new TypeError(`candle ${index}.${key} must be finite`);
      }
    }
    if (
      bar.high < bar.low ||
      bar.high < bar.open ||
      bar.high < bar.close ||
      bar.low > bar.open ||
      bar.low > bar.close
    ) {
      throw new RangeError(`candle ${index} has inconsistent OHLC values`);
    }
    if (bar.time <= previousTime) {
      throw new RangeError("candle times must be strictly chronological");
    }
    previousTime = bar.time;
  });
}

function makeState(
  kind: StructureState["kind"],
  length: number,
  trackZones: boolean,
): StructureState {
  return {
    kind,
    length,
    trackZones,
    leg: 0,
    high: { currentLevel: null, crossed: false, barIndex: null },
    low: { currentLevel: null, crossed: false, barIndex: null },
    previousHighLevel: null,
    previousLowLevel: null,
    previousClose: null,
    zones: [],
  };
}

function getNewLeg(
  candles: LcWaitingObCandle[],
  index: number,
  length: number,
  priorLeg: number,
): number {
  if (index < length) return priorLeg;
  const candidateIndex = index - length;
  let highestAfter = -Infinity;
  let lowestAfter = Infinity;
  for (let cursor = candidateIndex + 1; cursor <= index; cursor += 1) {
    highestAfter = Math.max(highestAfter, candles[cursor]!.high);
    lowestAfter = Math.min(lowestAfter, candles[cursor]!.low);
  }
  const candidate = candles[candidateIndex]!;
  if (candidate.high > highestAfter) return 0;
  if (candidate.low < lowestAfter) return 1;
  return priorLeg;
}

function updatePivot(
  state: StructureState,
  candles: LcWaitingObCandle[],
  index: number,
): void {
  const leg = getNewLeg(candles, index, state.length, state.leg);
  const changed = leg !== state.leg;
  const oldLeg = state.leg;
  state.leg = leg;
  if (!changed) return;

  const pivotIndex = index - state.length;
  if (oldLeg === 0 && leg === 1) {
    state.low.currentLevel = candles[pivotIndex]!.low;
    state.low.crossed = false;
    state.low.barIndex = pivotIndex;
  } else if (oldLeg === 1 && leg === 0) {
    state.high.currentLevel = candles[pivotIndex]!.high;
    state.high.crossed = false;
    state.high.barIndex = pivotIndex;
  }
}

/**
 * LuxAlgo "Cumulative Mean Range" volatility filter: ta.cum(ta.tr) / bar_index.
 * ta.tr is na on the first bar, so it contributes nothing; bar_index is 0-based.
 * The value depends on how much history the chart (or our fetch) contains.
 */
function cumulativeMeanRangeValues(
  candles: LcWaitingObCandle[],
): Array<number | null> {
  const values: Array<number | null> = Array(candles.length).fill(null);
  let cumulative = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const bar = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    cumulative += Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose),
    );
    values[index] = cumulative / index;
  }
  return values;
}

function parsedBars(
  candles: LcWaitingObCandle[],
): Array<{ high: number; low: number }> {
  const measure = cumulativeMeanRangeValues(candles);
  return candles.map((bar, index) => {
    const volatile =
      measure[index] !== null && bar.high - bar.low >= 2 * measure[index]!;
    return volatile
      ? { high: bar.low, low: bar.high }
      : { high: bar.high, low: bar.low };
  });
}

function addOrderBlock(
  state: StructureState,
  parsed: Array<{ high: number; low: number }>,
  candles: LcWaitingObCandle[],
  index: number,
  bias: Bias,
): void {
  const pivotIndex =
    bias === "bullish" ? state.high.barIndex : state.low.barIndex;
  if (pivotIndex === null || pivotIndex >= index) return;

  let selectedIndex = pivotIndex;
  for (let cursor = pivotIndex + 1; cursor < index; cursor += 1) {
    const moreExtreme =
      bias === "bullish"
        ? parsed[cursor]!.low < parsed[selectedIndex]!.low
        : parsed[cursor]!.high > parsed[selectedIndex]!.high;
    if (moreExtreme) selectedIndex = cursor;
  }

  state.zones.unshift({
    high: parsed[selectedIndex]!.high,
    low: parsed[selectedIndex]!.low,
    kind: "internal",
    createdAt: candles[selectedIndex]!.time,
    detectedAt: candles[index]!.time,
    bias,
  });
  if (state.zones.length > 100) state.zones.pop();
}

function processState(
  state: StructureState,
  candles: LcWaitingObCandle[],
  parsed: Array<{ high: number; low: number }>,
  index: number,
  bias: Bias,
  allowStructure: boolean,
): void {
  const candle = candles[index]!;
  const pivot = bias === "bullish" ? state.high : state.low;
  const previousPivotLevel =
    bias === "bullish" ? state.previousHighLevel : state.previousLowLevel;
  const pivotChangedThisBar =
    pivot.barIndex === index - state.length && pivot.barIndex !== null;
  const crossed =
    bias === "bullish"
      ? pivot.currentLevel !== null &&
        state.previousClose !== null &&
        candle.close > pivot.currentLevel &&
        previousPivotLevel !== null &&
        state.previousClose <= previousPivotLevel
      : pivot.currentLevel !== null &&
        state.previousClose !== null &&
        candle.close < pivot.currentLevel &&
        previousPivotLevel !== null &&
        state.previousClose >= previousPivotLevel;

  if (crossed && allowStructure && !pivot.crossed) {
    pivot.crossed = true;
    if (state.trackZones) addOrderBlock(state, parsed, candles, index, bias);
  } else if (pivotChangedThisBar) {
    pivot.crossed = false;
  }

  // LuxAlgo defaults to High/Low mitigation: bullish by low, bearish by high.
  state.zones = state.zones.filter((zone) =>
    bias === "bullish" ? candle.low >= zone.low : candle.high <= zone.high,
  );
  state.previousHighLevel = state.high.currentLevel;
  state.previousLowLevel = state.low.currentLevel;
  state.previousClose = candle.close;
}

function replayBias(
  candles: LcWaitingObCandle[],
  parsed: Array<{ high: number; low: number }>,
  bias: Bias,
  kind: "internal" | "swing" = "internal",
): LcWaitingOrderBlock[] {
  // Swing pivots are maintained because LuxAlgo's internal structure guard
  // suppresses internal pivots that equal the corresponding swing pivot.
  const swing = makeState("swing", 50, kind === "swing");
  const internal = makeState("internal", 5, kind === "internal");

  for (let index = 0; index < candles.length; index += 1) {
    updatePivot(swing, candles, index);
    updatePivot(internal, candles, index);

    // LuxAlgo evaluates swing structure before internal structure.
    processState(swing, candles, parsed, index, bias, true);
    const internalPivot = bias === "bullish" ? internal.high : internal.low;
    const swingPivot = bias === "bullish" ? swing.high : swing.low;
    const guardAllowsInternal =
      internalPivot.currentLevel !== null &&
      swingPivot.currentLevel !== null &&
      internalPivot.currentLevel !== swingPivot.currentLevel;
    processState(internal, candles, parsed, index, bias, guardAllowsInternal);
  }
  return kind === "swing"
    ? swing.zones.map((zone) => ({ ...zone, kind: "internal" as const }))
    : internal.zones;
}

/**
 * Active bullish LuxAlgo SWING order blocks (swing length 50), shown on the
 * owner's chart alongside internal blocks. Zones carry no distinct kind in the
 * shared type; callers label provenance themselves.
 */
export function detectLuxAlgoSwingDemandZones(
  candles: LcWaitingObCandle[],
): LcWaitingOrderBlock[] {
  if (candles.length === 0) return [];
  return replayBias(candles, parsedBars(candles), "bullish", "swing");
}

/**
 * Every active bullish LuxAlgo internal order block (no 5-zone chart cap and
 * no entry-distance filter), for callers that need the full demand-zone set.
 */
export function detectLuxAlgoInternalDemandZones(
  candles: LcWaitingObCandle[],
): LcWaitingOrderBlock[] {
  if (candles.length === 0) return [];
  return replayBias(candles, parsedBars(candles), "bullish", "internal");
}

/**
 * Replay active default internal order blocks using only the supplied closed
 * candles. Confirmations are timestamped at the close of the confirming bar;
 * no candle after the last input candle is consulted.
 */
export function replayLcWaitingOrderBlocks(
  candles: LcWaitingObCandle[],
  entryPrice: number,
): LcWaitingObReplay {
  validateInput(candles, entryPrice);
  const parsed = parsedBars(candles);
  const active = [
    ...replayBias(candles, parsed, "bullish"),
    ...replayBias(candles, parsed, "bearish"),
  ]
    .sort((left, right) => right.detectedAt - left.detectedAt)
    .slice(0, 5);

  const nearestBullishDemandZone =
    active
      .filter((zone) => zone.bias === "bullish" && zone.high < entryPrice)
      .filter((zone) => {
        const distancePct = ((entryPrice - zone.high) / entryPrice) * 100;
        return distancePct >= 1 && distancePct <= 10;
      })
      .sort((left, right) => right.high - left.high)[0] ?? null;

  return { orderBlocks: active, nearestBullishDemandZone };
}

/**
 * Backend-facing LC waiting API. Invalid candle/entry data is rejected by
 * replay validation; valid input with no qualifying zones normalizes to
 * `zones: []` and `nearest: null`.
 */
export function detectLuxAlgoDemandZones(
  candles: LcWaitingObCandle[],
  entryPrice: number,
): LuxAlgoDemandZoneResult {
  const result = replayLcWaitingOrderBlocks(candles, entryPrice);
  return {
    zones: result.orderBlocks.map((zone) => ({
      high: zone.high,
      low: zone.low,
      detectedAt: zone.detectedAt,
      createdAt: zone.createdAt,
      kind: zone.kind,
      bias: zone.bias,
    })),
    nearest: result.nearestBullishDemandZone
      ? { ...result.nearestBullishDemandZone }
      : null,
  };
}
