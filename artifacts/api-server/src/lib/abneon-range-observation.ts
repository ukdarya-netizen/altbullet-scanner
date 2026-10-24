/**
 * Independent, observational range estimate. This is not an execution of the
 * TradingView Pine indicator: it keeps only closed-candle, frozen box evidence
 * for comparing 1H and 4H contexts alongside ABNeon at signal time.
 */
export const ABNEON_RANGE_VERSION = "abneon-range-observation-v1";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type RangeObservation = {
  state:
    | "active"
    | "break_up"
    | "break_down"
    | "reentered"
    | "none"
    | "unknown";
  upper: number | null;
  lower: number | null;
  eventAt: string | null;
  reason: string;
};

const windows = [20, 40, 60] as const;
const atrPeriod = 200;
const referencePeriod = 500;

function percentile(values: number[], portion: number): number {
  const ordered = values.sort((a, b) => a - b);
  const index = ((ordered.length - 1) * portion) / 100;
  const lower = Math.floor(index);
  return (
    ordered[lower]! +
    (ordered[Math.min(lower + 1, ordered.length - 1)]! - ordered[lower]!) *
      (index - lower)
  );
}

type Box = { upper: number; lower: number; started: number };

export function observeAbneonRange(
  candles: readonly Candle[],
  intervalMs: number,
): RangeObservation {
  const unknown = (reason: string): RangeObservation => ({
    state: "unknown",
    upper: null,
    lower: null,
    eventAt: null,
    reason,
  });
  if (candles.length < atrPeriod + referencePeriod + 60)
    return unknown("Недостаточно закрытых свечей для ATR и истории сжатия");
  if (
    candles.some(
      (c, i) =>
        !Number.isFinite(c.time) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.low <= 0 ||
        c.high < c.low ||
        (i > 0 && c.time - candles[i - 1]!.time !== intervalMs),
    )
  )
    return unknown("Неполная или некорректная история закрытых свечей");

  const ratios = new Map<number, number[]>(windows.map((n) => [n, []]));
  let seed = 0;
  let atr = 0;
  let active: Box | null = null;
  let lastBreak:
    | (Box & { direction: "break_up" | "break_down"; at: number })
    | null = null;
  let cooldown = 0;

  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]?.close ?? candle.close;
    const tr = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    if (index < atrPeriod) {
      seed += tr;
      if (index === atrPeriod - 1) atr = seed / atrPeriod;
    } else atr = (atr * (atrPeriod - 1) + tr) / atrPeriod;
    if (index < atrPeriod || atr <= 0) continue;

    let candidate: Box | null = null;
    for (const length of windows) {
      const segment = candles.slice(index - length + 1, index + 1);
      const upper = percentile(
        segment.map((c) => c.high),
        90,
      );
      const lower = percentile(
        segment.map((c) => c.low),
        10,
      );
      const height = upper - lower;
      const normalized = height / (atr * Math.sqrt(length));
      const history = ratios.get(length)!;
      history.push(normalized);
      if (history.length > referencePeriod) history.shift();
      if (
        height <= 0 ||
        history.length < referencePeriod ||
        (100 * history.filter((v) => v <= normalized).length) / history.length >
          40
      )
        continue;

      const midpoint = (upper + lower) / 2;
      const tolerance = atr * 0.1;
      let crosses = 0;
      let upperTouches = 0;
      let lowerTouches = 0;
      let contained = 0;
      for (let j = 0; j < length; j++) {
        const here = segment[j]!;
        const before = candles[index - length + j];
        if (before && here.close > midpoint !== before.close > midpoint)
          crosses++;
        if (here.high >= upper - tolerance) upperTouches++;
        if (here.low <= lower + tolerance) lowerTouches++;
        if (here.close >= lower && here.close <= upper) contained++;
      }
      const meanX = (length - 1) / 2;
      const meanY = segment.reduce((sum, c) => sum + c.close, 0) / length;
      let covariance = 0;
      let variance = 0;
      for (let j = 0; j < length; j++) {
        covariance += (j - meanX) * (segment[j]!.close - meanY);
        variance += (j - meanX) ** 2;
      }
      if (
        crosses >= Math.max(3, Math.round(length * 0.18)) &&
        upperTouches >= 2 &&
        lowerTouches >= 2 &&
        contained / length >= 0.7 &&
        Math.abs(covariance / variance) * length <= height * 0.45
      ) {
        candidate = { upper, lower, started: candle.time + intervalMs };
      }
    }

    if (cooldown > 0) cooldown--;
    if (!active && cooldown === 0 && candidate) {
      active = candidate;
      lastBreak = null;
      continue;
    }
    if (!active) continue;
    const buffer = atr * 0.15;
    const direction =
      candle.close > active.upper + buffer
        ? "break_up"
        : candle.close < active.lower - buffer
          ? "break_down"
          : null;
    if (direction) {
      lastBreak = { ...active, direction, at: candle.time + intervalMs };
      active = null;
      cooldown = 3;
    } else if (candle.close <= active.upper && candle.close >= active.lower) {
      // A small wick can expand the frozen observation box while the close
      // remains inside it. It does not create a retrospective breakout.
      if (candle.high <= active.upper + atr * 0.25)
        active.upper = Math.max(active.upper, candle.high);
      if (candle.low >= active.lower - atr * 0.25)
        active.lower = Math.min(active.lower, candle.low);
    }
  }

  const finalClose = candles.at(-1)!.time + intervalMs;
  if (lastBreak && finalClose - lastBreak.at <= 24 * 60 * 60_000) {
    const since = candles.filter((c) => c.time + intervalMs > lastBreak.at);
    const reentered = since.some((c) =>
      lastBreak.direction === "break_up"
        ? c.close <= lastBreak.upper
        : c.close >= lastBreak.lower,
    );
    return {
      state: reentered ? "reentered" : lastBreak.direction,
      upper: lastBreak.upper,
      lower: lastBreak.lower,
      eventAt: new Date(lastBreak.at).toISOString(),
      reason: reentered
        ? "Возврат за границу после пробоя"
        : "Пробой последнего найденного диапазона",
    };
  }
  if (active)
    return {
      state: "active",
      upper: active.upper,
      lower: active.lower,
      eventAt: new Date(active.started).toISOString(),
      reason: "Диапазон на последней закрытой свече",
    };
  return {
    state: "none",
    upper: null,
    lower: null,
    eventAt: null,
    reason: "Подходящий диапазон не найден",
  };
}
