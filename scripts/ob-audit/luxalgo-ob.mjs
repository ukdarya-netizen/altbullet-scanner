/**
 * Chronological replay of the bullish and bearish order-block paths in the
 * supplied LuxAlgo Smart Money Concepts Pine v5 source.
 *
 * This is a close bar-by-bar translation, not bit-for-bit Pine emulation:
 * Pine's runtime/series semantics (notably ta.atr warm-up and mutable UDT
 * history) are not available in Node. ATR uses Wilder RMA seeded by the
 * first 200 true ranges and pivot/cross history is modeled explicitly.
 * Inputs must be closed candles.
 */

export const APPROXIMATION =
  'Bar-by-bar approximation of LuxAlgo Pine v5; Pine runtime series/UDT behavior and ta.atr internals cannot be reproduced bit-for-bit. ATR uses Wilder RMA seeded with an SMA; order-block logic follows the uploaded source.';

const DEFAULTS = Object.freeze({
  atrLength: 200,
  internalLength: 5,
  swingLength: 50,
  mitigation: 'highlow',
  // Replay both zone classes, even though the uploaded indicator visually
  // disables swing order blocks by default.
  kinds: ['internal', 'swing'],
});

function validateCandles(candles) {
  if (!Array.isArray(candles)) throw new TypeError('candles must be an array');
  let previousTime;
  candles.forEach((bar, index) => {
    if (!bar || typeof bar !== 'object') {
      throw new TypeError(`candle ${index} must be an object`);
    }
    for (const key of ['time', 'open', 'high', 'low', 'close']) {
      if (bar[key] === undefined || bar[key] === null) {
        throw new TypeError(`candle ${index} is missing ${key}`);
      }
    }
    for (const key of ['open', 'high', 'low', 'close']) {
      if (!Number.isFinite(bar[key])) {
        throw new TypeError(`candle ${index}.${key} must be finite`);
      }
    }
    if (bar.high < bar.low || bar.high < bar.open || bar.high < bar.close ||
        bar.low > bar.open || bar.low > bar.close) {
      throw new RangeError(`candle ${index} has inconsistent OHLC values`);
    }
    if (index > 0 && !(bar.time > previousTime)) {
      throw new RangeError('candle times must be strictly chronological');
    }
    previousTime = bar.time;
  });
}

function trueRanges(candles) {
  return candles.map((bar, i) => i === 0
    ? bar.high - bar.low
    : Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - candles[i - 1].close),
      Math.abs(bar.low - candles[i - 1].close),
    ));
}

function atrValues(candles, length) {
  const tr = trueRanges(candles);
  const values = Array(candles.length).fill(null);
  if (candles.length < length) return values;
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += tr[i];
  let atr = sum / length;
  values[length - 1] = atr;
  for (let i = length; i < candles.length; i += 1) {
    atr = ((atr * (length - 1)) + tr[i]) / length;
    values[i] = atr;
  }
  return values;
}

function makeStructureState(kind, length, trackZones = true) {
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

function getNewLeg(candles, index, length, priorLeg) {
  if (index < length) return priorLeg;
  const candidateIndex = index - length;
  let highestAfter = -Infinity;
  let lowestAfter = Infinity;
  for (let i = candidateIndex + 1; i <= index; i += 1) {
    highestAfter = Math.max(highestAfter, candles[i].high);
    lowestAfter = Math.min(lowestAfter, candles[i].low);
  }
  const newHighLeg = candles[candidateIndex].high > highestAfter;
  const newLowLeg = candles[candidateIndex].low < lowestAfter;
  if (newHighLeg) return 0;
  if (newLowLeg) return 1;
  return priorLeg;
}

function parsedBar(candle, atr) {
  const volatile = atr !== null && candle.high - candle.low >= 2 * atr;
  // Exact parsedHigh/parsedLow transformation in the uploaded Pine source.
  return volatile
    ? { high: candle.low, low: candle.high }
    : { high: candle.high, low: candle.low };
}

function updatePivot(state, candles, index) {
  const leg = getNewLeg(candles, index, state.length, state.leg);
  const changed = leg !== state.leg;
  const oldLeg = state.leg;
  state.leg = leg;
  if (changed) {
    const pivotIndex = index - state.length;
    if (oldLeg === 0 && leg === 1) {
      state.low.currentLevel = candles[pivotIndex].low;
      state.low.crossed = false;
      state.low.barIndex = pivotIndex;
    } else if (oldLeg === 1 && leg === 0) {
      state.high.currentLevel = candles[pivotIndex].high;
      state.high.crossed = false;
      state.high.barIndex = pivotIndex;
    }
  }
}

function addOrderBlock(state, parsed, candles, index, direction) {
  const bullish = direction === 'bullish';
  const pivotIndex = bullish ? state.high.barIndex : state.low.barIndex;
  if (pivotIndex === null || pivotIndex >= index) return;
  let selectedIndex = pivotIndex;
  for (let i = pivotIndex + 1; i < index; i += 1) {
    const isMoreExtreme = bullish
      ? parsed[i].low < parsed[selectedIndex].low
      : parsed[i].high > parsed[selectedIndex].high;
    if (isMoreExtreme) selectedIndex = i;
  }
  const zone = {
    high: parsed[selectedIndex].high,
    low: parsed[selectedIndex].low,
    kind: state.kind,
    // Pine's orderBlock.barTime is the source candle's time coordinate.
    createdAt: candles[selectedIndex].time,
    detectedAt: candles[index].time,
  };
  if (state.zones.length >= 100) state.zones.pop();
  state.zones.unshift(zone);
}

function processState(state, candles, parsed, index, mitigation, direction, allowStructure = true) {
  const candle = candles[index];
  const bullish = direction === 'bullish';
  const pivot = bullish ? state.high : state.low;
  const previousPivotLevel = bullish ? state.previousHighLevel : state.previousLowLevel;
  const pivotChangedThisBar = pivot.barIndex === index - state.length &&
    pivot.barIndex !== null;
  // Pine ta.crossover/crossunder compare both current and previous series
  // values, including the pivot's value on the previous bar.
  const crossed = bullish
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
    if (state.trackZones) addOrderBlock(state, parsed, candles, index, direction);
  } else if (pivotChangedThisBar) {
    // The pivot is fresh and cannot have been crossed before confirmation.
    pivot.crossed = false;
  }

  // Bullish OBs mitigate on low; bearish OBs mitigate on high by default.
  const mitigationValue = mitigation === 'close'
    ? candle.close
    : bullish ? candle.low : candle.high;
  state.zones = state.zones.filter((zone) => bullish
    ? mitigationValue >= zone.low
    : mitigationValue <= zone.high);

  state.previousHighLevel = state.high.currentLevel;
  state.previousLowLevel = state.low.currentLevel;
  state.previousClose = candle.close;
}

/**
 * Replay active bullish internal/swing OB zones.
 *
 * Each returned row is the set of zones known at the beginning of that bar,
 * before processing its OHLC. This makes row[i] safe to use for decisions on
 * candle[i] without look-ahead.
 *
 * @param {{time: number|string, open: number, high: number, low: number, close: number}[]} candles
 * @param {{atrLength?: number, internalLength?: number, swingLength?: number,
 *   mitigation?: 'highlow'|'close', kinds?: ('internal'|'swing')[]}} options
 * @returns {{time: number|string, zones: {createdAt: number|string, detectedAt: number|string, high: number, low: number, kind: string}[]}[]
 */
function replayLuxAlgoOrderBlocks(candles, options, direction) {
  validateCandles(candles);
  const settings = { ...DEFAULTS, ...options };
  if (!Number.isInteger(settings.atrLength) || settings.atrLength < 1 ||
      !Number.isInteger(settings.internalLength) || settings.internalLength < 1 ||
      !Number.isInteger(settings.swingLength) || settings.swingLength < 1) {
    throw new RangeError('ATR and pivot lengths must be positive integers');
  }
  if (!['highlow', 'close'].includes(settings.mitigation)) {
    throw new RangeError("mitigation must be 'highlow' or 'close'");
  }
  if (!Array.isArray(settings.kinds) ||
      settings.kinds.some((kind) => !['internal', 'swing'].includes(kind))) {
    throw new TypeError("kinds must contain only 'internal' and/or 'swing'");
  }

  const atr = atrValues(candles, settings.atrLength);
  const parsed = candles.map((bar, i) => parsedBar(bar, atr[i]));
  const states = [];
  const wantsInternal = settings.kinds.includes('internal');
  const wantsSwing = settings.kinds.includes('swing');
  // displayStructure(true) compares its internal pivot against the
  // corresponding swing pivot (high for bullish, low for bearish).
  // Swing pivots are updated earlier in the Pine execution path even if the
  // caller only asks to emit internal zones.
  const swingState = wantsSwing || wantsInternal
    ? makeStructureState('swing', settings.swingLength, wantsSwing)
    : null;
  const internalState = wantsInternal
    ? makeStructureState('internal', settings.internalLength)
    : null;
  if (swingState) states.push(swingState);
  if (internalState) states.push(internalState);
  const outputStates = states.filter((state) => state.trackZones)
    .sort((left, right) => left.kind === 'internal' ? -1 : right.kind === 'internal' ? 1 : 0);

  return candles.map((bar, index) => {
    // Snapshot zones before this candle's structure detection/mitigation.
    const zones = outputStates.flatMap((state) => state.zones.map((zone) => ({ ...zone })));
    // Pine calls getCurrentStructure for swing first, then internal, before
    // either displayStructure call. Thus both newly confirmed pivot values
    // must be available to the internal display guard on this same bar.
    for (const state of states) updatePivot(state, candles, index);
    // Structure detection then runs internal followed by swing.
    for (const state of states) {
      const pivot = direction === 'bullish' ? state.high : state.low;
      const swingPivot = direction === 'bullish'
        ? swingState?.high.currentLevel
        : swingState?.low.currentLevel;
      const guardAllowsInternal = state.kind !== 'internal' ||
        (pivot.currentLevel !== null &&
          swingPivot !== null &&
          pivot.currentLevel !== swingPivot);
      processState(state, candles, parsed, index, settings.mitigation,
        direction, guardAllowsInternal);
    }
    return { time: bar.time, zones };
  });
}

/** Replay active bullish internal/swing OB zones. */
export function replayLuxAlgoBullishOrderBlocks(candles, options = {}) {
  return replayLuxAlgoOrderBlocks(candles, options, 'bullish');
}

/** Replay active bearish internal/swing OB zones. */
export function replayLuxAlgoBearishOrderBlocks(candles, options = {}) {
  return replayLuxAlgoOrderBlocks(candles, options, 'bearish');
}
