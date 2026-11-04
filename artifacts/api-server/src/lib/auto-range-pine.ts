/**
 * Closed-candle, non-repainting TypeScript port of Auto Range Detector
 * [QuantAlgo], © QuantAlgo, licensed under CC BY-NC-SA 4.0:
 * https://creativecommons.org/licenses/by-nc-sa/4.0/
 *
 * This is a data-only adaptation of the default detection/range settings.
 * It intentionally contains no Pine visual/UI code. Distributing this
 * adaptation requires attribution, non-commercial use, and ShareAlike terms.
 */

export const AUTO_RANGE_PINE_INTERVAL_MS = 4 * 60 * 60 * 1_000;
export const AUTO_RANGE_PINE_1H_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Deterministic replay window. A sliding "last N candles" window moves its
 * start every candle, which changes the state machine's initial state and made
 * range levels drift/flicker between scans (frozen arms were then dropped as
 * replaced/obsolete). The start is instead pinned to a weekly UTC grid, so
 * consecutive scans replay the same history and only jump once a week.
 * Result length is minBars..minBars+7 days.
 */
export function anchoredAutoRangeWindow<T extends { time: number }>(
  candles: readonly T[],
  intervalMs: number,
  minBars: number,
): T[] {
  const last = candles.at(-1);
  if (!last) return [];
  const week = 7 * 24 * 60 * 60 * 1_000;
  const start =
    Math.floor((last.time + intervalMs - minBars * intervalMs) / week) * week;
  return candles.filter((candle) => candle.time >= start);
}

export type AutoRangeCandle = {
  /** Unix milliseconds at the candle's open. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Omit only when the caller guarantees every candle is closed. */
  closed?: boolean;
};

export type AutoRangePineResult = {
  status: "ready" | "unknown";
  reason: string;
  activeConfirmedRange: {
    upper: number;
    lower: number;
    /** Candle open time on which Pine detected/opened the range. */
    openedAt: number;
    /** Open time of Pine's containment-extended left edge. */
    anchorAt: number;
  } | null;
  latestUpsideBreakout: {
    upper: number;
    lower: number;
    /** Candle open time on which Pine detected/opened the range. */
    openedAt: number;
    /** Open time of Pine's containment-extended left edge. */
    anchorAt: number;
    /** Close time of the confirmed breakout candle. */
    breakoutCloseTime: number;
  } | null;
  /** Latest range that broke downward (same shape as the upside breakout). */
  latestDownsideBreakout?: {
    upper: number;
    lower: number;
    openedAt: number;
    anchorAt: number;
    breakoutCloseTime: number;
  } | null;
  /**
   * Indicator-style deviations on this timeframe's own bars: a confirmed range
   * closed outside (with the ATR buffer) and a later close re-entered it within
   * the deviation window. `direction` "down" = broke below, then reclaimed.
   */
  deviations?: AutoRangeDeviation[];
  /** Research only (backtests): every confirmed upside break in order. */
  upsideBreakouts?: {
    upper: number;
    lower: number;
    openedAt: number;
    anchorAt: number;
    breakoutCloseTime: number;
  }[];
};

export type AutoRangeDeviation = {
  direction: "down" | "up";
  upper: number;
  lower: number;
  /** Close time of the candle that closed outside the range. */
  breakoutCloseTime: number;
  /** Close time of the candle that closed back inside the range. */
  reentryCloseTime: number;
  /** Furthest excursion beyond the border, % of that border. */
  extremePct: number;
};

const ATR_LENGTH = 200;
/**
 * Owner 2026-10-20: a new listing with a short 1H history must still get a
 * confirmed Range when the history is long enough for the range itself.
 * Below the full ATR(200) seed, 1H replays seed ATR over the available bars
 * minus a 20-bar calibration tail. Pine parity is unchanged whenever 200 or
 * more closed bars exist.
 */
export const AUTO_RANGE_SHORT_HISTORY_MIN_BARS = 100;
function effectiveAtrLength(
  candleCount: number,
  intervalLabel: "4H" | "1H" | "1D" | "15m",
): number {
  if (
    intervalLabel === "1H" &&
    candleCount >= AUTO_RANGE_SHORT_HISTORY_MIN_BARS &&
    candleCount < ATR_LENGTH
  )
    return candleCount - 20;
  return ATR_LENGTH;
}
const CALIBRATION_LENGTH = 500;
const WINDOW_LENGTHS = [20, 40, 60] as const;
const COMPRESSION_PERCENTILE = 40;
const MIN_ROTATION = 0.18;
const MIN_TOUCHES = 2;
const TOUCH_TOLERANCE_ATR = 0.1;
const MAX_DRIFT = 0.45;
const MIN_CONTAINMENT = 0.7;
const ANCHOR_LOOKBACK = 300;
const MIN_RANGE_BARS = 10;
const OVERSHOOT_TOLERANCE_ATR = 0.25;
const BREAKOUT_BUFFER_ATR = 0.15;
const DEVIATION_WINDOW = 10;
const COOLDOWN_BARS = 3;

type Candidate = { upper: number; lower: number; length: number };
type Breakout = {
  upper: number;
  lower: number;
  openedAt: number;
  anchorAt: number;
  breakoutCloseTime: number;
};
type ActiveRange = Candidate & {
  openedIndex: number;
  anchorIndex: number;
  confirmed: boolean;
};
type DormantRange = {
  range: ActiveRange;
  sinceIndex: number;
  direction: 1 | -1;
  extreme: number;
};

function percentile(values: readonly number[], percentage: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  // Pine's ta.percentile_linear_interpolation: linear interpolation between
  // closest ranks, rank (1-based) = p/100 * N + 0.5. Verified against the
  // indicator's own boxes on IO/USDT (3.43% and 5.53% ranges reproduced).
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, (sorted.length * percentage) / 100 - 0.5),
  );
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(lowerIndex + 1, sorted.length - 1);
  return (
    sorted[lowerIndex]! +
    (sorted[upperIndex]! - sorted[lowerIndex]!) * (position - lowerIndex)
  );
}

function validateCandles(
  candles: readonly AutoRangeCandle[],
  intervalMs: number,
  intervalLabel: "4H" | "1H" | "1D" | "15m",
  requireExplicitlyClosed: boolean,
): string | null {
  if (candles.length < effectiveAtrLength(candles.length, intervalLabel))
    return `Insufficient closed ${intervalLabel} candles to seed ATR(200)`;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!;
    if (
      candle.closed === false ||
      (requireExplicitlyClosed && candle.closed !== true) ||
      !Number.isFinite(candle.time) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < candle.low ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close)
    )
      return `Incomplete or invalid closed ${intervalLabel} candle history`;
    if (index > 0 && candle.time - candles[index - 1]!.time !== intervalMs)
      return `Closed ${intervalLabel} candle history contains a gap or is not ascending`;
  }
  return null;
}

function anchorSpan(
  candles: readonly AutoRangeCandle[],
  currentIndex: number,
  length: number,
  upper: number,
  lower: number,
  tolerance: number,
): number {
  let span = length;
  const allowedOutside = Math.max(
    2,
    Math.round((1 - MIN_CONTAINMENT) * length),
  );
  let outside = 0;
  const limit = Math.min(ANCHOR_LOOKBACK, currentIndex);
  for (let offset = 0; offset < limit && outside <= allowedOutside; offset++) {
    const candle = candles[currentIndex - offset]!;
    const closeInside = candle.close <= upper && candle.close >= lower;
    const fullyInside =
      closeInside &&
      candle.high <= upper + tolerance &&
      candle.low >= lower - tolerance;
    if (closeInside) {
      outside = Math.max(0, outside - 1);
      if (fullyInside && offset + 1 >= length) span = offset + 1;
    } else outside++;
  }
  return span;
}

function scanWindow(
  candles: readonly AutoRangeCandle[],
  currentIndex: number,
  length: number,
  atr: number,
  compressionHistory: readonly number[],
  atrLength: number,
): Candidate | null {
  if (currentIndex < length - 1 || currentIndex <= length + 5) return null;
  const firstIndex = currentIndex - length + 1;
  const segment = candles.slice(firstIndex, currentIndex + 1);
  const upper = percentile(
    segment.map((candle) => candle.high),
    90,
  );
  const lower = percentile(
    segment.map((candle) => candle.low),
    10,
  );
  const height = upper - lower;
  if (!(height > 0) || !(atr > 0)) return null;

  const compression = height / (atr * Math.sqrt(length));
  // ta.percentrank ranks against the previous span_cap values, excluding the
  // current bar (the history array already contains the current bar last).
  const rankLength = Math.max(
    1,
    Math.min(CALIBRATION_LENGTH, currentIndex - atrLength),
  );
  const previousHistory = compressionHistory.slice(0, -1);
  const historyStart = Math.max(0, previousHistory.length - rankLength);
  let atOrBelow = 0;
  for (let index = historyStart; index < previousHistory.length; index++)
    if (previousHistory[index]! <= compression) atOrBelow++;
  const rankCount = previousHistory.length - historyStart;
  if (rankCount <= 0) return null;
  const rank = (100 * atOrBelow) / rankCount;
  if (rank > COMPRESSION_PERCENTILE) return null;

  const midpoint = (upper + lower) / 2;
  const tolerance = TOUCH_TOLERANCE_ATR * atr;
  let crossings = 0;
  let upperTouches = 0;
  let lowerTouches = 0;
  let contained = 0;
  const beforeFirst = candles[firstIndex - 1]!;
  if (beforeFirst.close > midpoint !== segment[0]!.close > midpoint)
    crossings++;
  for (const candle of segment) {
    if (candle.high >= upper - tolerance) upperTouches++;
    if (candle.low <= lower + tolerance) lowerTouches++;
    if (candle.close <= upper && candle.close >= lower) contained++;
  }
  for (let index = 1; index < segment.length; index++)
    if (
      segment[index - 1]!.close > midpoint !==
      segment[index]!.close > midpoint
    )
      crossings++;

  // ta.linreg(src, length, 0) - ta.linreg(src, length, 1) is the
  // least-squares slope over the window.
  const meanX = (length - 1) / 2;
  let meanClose = 0;
  for (const candle of segment) meanClose += candle.close / length;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < length; index++) {
    covariance += (index - meanX) * (segment[index]!.close - meanClose);
    variance += (index - meanX) ** 2;
  }
  const drift =
    variance > 0 ? (Math.abs(covariance / variance) * length) / height : 99;
  if (
    crossings < Math.max(3, Math.round(MIN_ROTATION * length)) ||
    upperTouches < MIN_TOUCHES ||
    lowerTouches < MIN_TOUCHES ||
    drift > MAX_DRIFT ||
    contained / length < MIN_CONTAINMENT
  )
    return null;
  return { upper, lower, length };
}

/**
 * Replays Pine's default Auto Range Detector state machine over ascending,
 * continuous closed 4H OHLC candles. `time` values are candle-open timestamps;
 * breakout times are returned as candle-close timestamps. This function has
 * no external state, so repeated calls with identical candles are identical.
 */
export function detectAutoRangePine(
  candles: readonly AutoRangeCandle[],
  options: AutoRangeReplayOptions = {},
): AutoRangePineResult {
  return replayAutoRangePine(
    candles,
    AUTO_RANGE_PINE_INTERVAL_MS,
    "4H",
    false,
    options,
  );
}

/**
 * Replays the same closed-candle Auto Range state machine at 1H resolution.
 * Every candle must explicitly be marked closed; omitted/partial candles fail
 * closed. Candle times are opens and breakout times are closes.
 */
export function detectAutoRangePine1h(
  candles: readonly AutoRangeCandle[],
  options: AutoRangeReplayOptions = {},
): AutoRangePineResult {
  return replayAutoRangePine(
    candles,
    AUTO_RANGE_PINE_1H_INTERVAL_MS,
    "1H",
    true,
    options,
  );
}

/**
 * 15-minute resolution of the same closed-candle state machine. Observation
 * only (LC entry hypothesis: enter from the 15m Range lower bound); same bar
 * parameters as 1H, applied to 15m bars - not a TradingView-verified port.
 */
export function detectAutoRangePine15m(
  candles: readonly AutoRangeCandle[],
): AutoRangePineResult {
  return replayAutoRangePine(candles, 15 * 60 * 1_000, "15m", true);
}

/**
 * Daily resolution of the same closed-candle state machine. Observation only:
 * needs at least 200 closed daily candles, otherwise the result is "unknown".
 */
export function detectAutoRangePine1d(
  candles: readonly AutoRangeCandle[],
): AutoRangePineResult {
  return replayAutoRangePine(candles, 24 * 60 * 60 * 1_000, "1D", true);
}

/**
 * mergeDeviations=false matches the indicator's "Deviation Merging" disabled:
 * every break is final and a fresh range may open (owner's chart behaves so).
 */
export type AutoRangeReplayOptions = { mergeDeviations?: boolean };

function replayAutoRangePine(
  candles: readonly AutoRangeCandle[],
  intervalMs: number,
  intervalLabel: "4H" | "1H" | "1D" | "15m",
  requireExplicitlyClosed: boolean,
  options: AutoRangeReplayOptions = {},
): AutoRangePineResult {
  const deviationWindow =
    options.mergeDeviations === false ? 0 : DEVIATION_WINDOW;
  const atrLength = effectiveAtrLength(candles.length, intervalLabel);
  const invalidReason = validateCandles(
    candles,
    intervalMs,
    intervalLabel,
    requireExplicitlyClosed,
  );
  if (invalidReason)
    return {
      status: "unknown",
      reason: invalidReason,
      activeConfirmedRange: null,
      latestUpsideBreakout: null,
    };

  const compressionByLength = new Map<number, number[]>(
    WINDOW_LENGTHS.map((length) => [length, []]),
  );
  let trueRangeSeed = 0;
  let atr = 0;
  let active: ActiveRange | null = null;
  let dormant: DormantRange | null = null;
  let cooldown = 0;
  let latestUpside: Breakout | null = null;
  let previousUpside: Breakout | null = null;
  let latestDownside: Breakout | null = null;
  let previousDownside: Breakout | null = null;
  let lastBreakWasUpside = false;
  const deviations: AutoRangeDeviation[] = [];
  // Research only: every confirmed upside break, in the order it happened.
  const upsideBreakouts: Breakout[] = [];

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]?.close;
    // ta.tr(true) uses high - low on the first bar, before a previous close
    // exists; subsequent bars include gaps from the previous close.
    const trueRange =
      previousClose === undefined
        ? candle.high - candle.low
        : Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - previousClose),
            Math.abs(candle.low - previousClose),
          );
    if (index < atrLength) {
      trueRangeSeed += trueRange;
      if (index === atrLength - 1) atr = trueRangeSeed / atrLength;
    } else atr = (atr * (atrLength - 1) + trueRange) / atrLength;
    for (const length of WINDOW_LENGTHS) {
      const history = compressionByLength.get(length)!;
      let compression = 99;
      if (index >= length - 1 && index >= atrLength - 1 && atr > 0) {
        const start = index - length + 1;
        const top = percentile(
          candles.slice(start, index + 1).map((item) => item.high),
          90,
        );
        const bottom = percentile(
          candles.slice(start, index + 1).map((item) => item.low),
          10,
        );
        if (top > bottom)
          compression = (top - bottom) / (atr * Math.sqrt(length));
      }
      history.push(compression);
      if (history.length > CALIBRATION_LENGTH + 1) history.shift();
    }

    if (index < atrLength - 1 || !(atr > 0)) continue;
    const candidateA = scanWindow(
      candles,
      index,
      WINDOW_LENGTHS[0],
      atr,
      compressionByLength.get(WINDOW_LENGTHS[0])!,
      atrLength,
    );
    const candidateB = scanWindow(
      candles,
      index,
      WINDOW_LENGTHS[1],
      atr,
      compressionByLength.get(WINDOW_LENGTHS[1])!,
      atrLength,
    );
    const candidateC = scanWindow(
      candles,
      index,
      WINDOW_LENGTHS[2],
      atr,
      compressionByLength.get(WINDOW_LENGTHS[2])!,
      atrLength,
    );
    // Default is Base + 2x + 3x; Pine chooses the longest passing window.
    const candidate = candidateC ?? candidateB ?? candidateA;

    if (cooldown > 0) cooldown--;
    if (!active && !dormant && cooldown <= 0 && candidate) {
      const span = anchorSpan(
        candles,
        index,
        candidate.length,
        candidate.upper,
        candidate.lower,
        TOUCH_TOLERANCE_ATR * atr,
      );
      active = {
        ...candidate,
        openedIndex: index,
        anchorIndex: index - span + 1,
        confirmed: false,
      };
    }

    if (active) {
      const wasConfirmed = active.confirmed;
      const closeInside =
        candle.close <= active.upper && candle.close >= active.lower;
      if (closeInside) {
        const absorb = OVERSHOOT_TOLERANCE_ATR * atr;
        if (candle.high > active.upper && candle.high <= active.upper + absorb)
          active.upper = candle.high;
        if (candle.low < active.lower && candle.low >= active.lower - absorb)
          active.lower = candle.low;
      }
      const buffer = BREAKOUT_BUFFER_ATR * atr;
      const brokeUp: boolean = candle.close > active.upper + buffer;
      const brokeDown: boolean = candle.close < active.lower - buffer;
      if (brokeUp || brokeDown) {
        if (wasConfirmed) {
          const frozen: Breakout = {
            upper: active.upper,
            lower: active.lower,
            openedAt: candles[active.openedIndex]!.time,
            anchorAt: candles[active.anchorIndex]!.time,
            breakoutCloseTime: candle.time + intervalMs,
          };
          lastBreakWasUpside = brokeUp;
          if (brokeUp) {
            previousUpside = latestUpside;
            latestUpside = frozen;
            upsideBreakouts.push(frozen);
          } else {
            previousDownside = latestDownside;
            latestDownside = frozen;
          }
          dormant =
            deviationWindow > 0
              ? {
                  range: active,
                  sinceIndex: index,
                  direction: brokeUp ? 1 : -1,
                  extreme: brokeUp ? candle.high : candle.low,
                }
              : null;
        } else {
          dormant = null;
        }
        active = null;
        cooldown = COOLDOWN_BARS;
      } else {
        active.confirmed = index - active.anchorIndex + 1 >= MIN_RANGE_BARS;
      }
    }

    if (dormant) {
      const excursion = dormant.direction === 1 ? candle.high : candle.low;
      dormant.extreme =
        dormant.direction === 1
          ? Math.max(dormant.extreme, excursion)
          : Math.min(dormant.extreme, excursion);
      const reentered =
        dormant.direction === 1
          ? candle.close <= dormant.range.upper
          : candle.close >= dormant.range.lower;
      const expired = index - dormant.sinceIndex >= deviationWindow;
      if (reentered && index > dormant.sinceIndex) {
        const down = dormant.direction === -1;
        const border = down ? dormant.range.lower : dormant.range.upper;
        deviations.push({
          direction: down ? "down" : "up",
          upper: dormant.range.upper,
          lower: dormant.range.lower,
          breakoutCloseTime: candles[dormant.sinceIndex]!.time + intervalMs,
          reentryCloseTime: candle.time + intervalMs,
          extremePct: (Math.abs(dormant.extreme - border) / border) * 100,
        });
        active = { ...dormant.range, confirmed: true };
        dormant = null;
        cooldown = 0;
        if (lastBreakWasUpside) {
          latestUpside = previousUpside;
        } else {
          latestDownside = previousDownside;
        }
        lastBreakWasUpside = false;
      } else if (expired) {
        dormant = null;
        lastBreakWasUpside = false;
      }
    }
  }

  const currentActive =
    active?.confirmed && !dormant
      ? {
          upper: active.upper,
          lower: active.lower,
          openedAt: candles[active.openedIndex]!.time,
          anchorAt: candles[active.anchorIndex]!.time,
        }
      : null;
  return {
    status: "ready",
    reason: `Closed ${intervalLabel} history replayed`,
    activeConfirmedRange: currentActive,
    latestUpsideBreakout: latestUpside,
    latestDownsideBreakout: latestDownside,
    deviations,
    upsideBreakouts,
  };
}
