/**
 * Port of the TradingView indicator "Support Resistance - Dynamic v2" (SRv2).
 * Defaults match the Pine inputs: pivot period 10, High/Low source, 20 pivots,
 * channel width 10% of the 300-bar range, 5 zones, minimum strength 2.
 * Pure and deterministic: only the candles passed in are inspected.
 */
export type Srv2Candle = { high: number; low: number; close: number };

export type Srv2Zone = {
  lo: number;
  hi: number;
  mid: number;
  strength: number;
};

export const SRV2_PIVOT_PERIOD = 10;
const MAX_PIVOTS = 20;
const CHANNEL_WIDTH_PCT = 10;
const MAX_ZONES = 5;
const MIN_STRENGTH = 2;
const RANGE_BARS = 300;

function pivotValue(
  candles: readonly Srv2Candle[],
  i: number,
  prd: number,
): number | null {
  const c = candles[i]!;
  let isHigh = true;
  let isLow = true;
  for (let j = i - prd; j <= i + prd; j++) {
    if (j === i) continue;
    const o = candles[j]!;
    if (o.high > c.high) isHigh = false;
    if (o.low < c.low) isLow = false;
    if (!isHigh && !isLow) return null;
  }
  // Pine: `ph ? ph : pl` — a high pivot wins on the same bar.
  if (isHigh) return c.high;
  if (isLow) return c.low;
  return null;
}

/** SRv2 zones as the chart shows them after the last confirmed pivot. */
export function computeSrv2Zones(
  candles: readonly Srv2Candle[],
  prd = SRV2_PIVOT_PERIOD,
): Srv2Zone[] {
  const n = candles.length;
  if (n < 2 * prd + 1) return [];
  const pivots: number[] = []; // newest first
  let lastEventBar = -1;
  for (let i = prd; i <= n - 1 - prd; i++) {
    const v = pivotValue(candles, i, prd);
    if (v === null) continue;
    pivots.unshift(v);
    if (pivots.length > MAX_PIVOTS) pivots.pop();
    lastEventBar = i + prd;
  }
  if (lastEventBar < 0) return [];

  let highest = -Infinity;
  let lowest = Infinity;
  for (
    let j = Math.max(0, lastEventBar - RANGE_BARS + 1);
    j <= lastEventBar;
    j++
  ) {
    highest = Math.max(highest, candles[j]!.high);
    lowest = Math.min(lowest, candles[j]!.low);
  }
  const cwidth = ((highest - lowest) * CHANNEL_WIDTH_PCT) / 100;

  const upLevel: number[] = [];
  const dnLevel: number[] = [];
  const strengths: number[] = [];

  const getSrVals = (ind: number) => {
    let lo = pivots[ind]!;
    let hi = lo;
    let numpp = 0;
    for (const cpp of pivots) {
      const wdth = cpp <= lo ? hi - cpp : cpp - lo;
      if (wdth <= cwidth) {
        if (cpp <= hi) lo = Math.min(lo, cpp);
        else hi = Math.max(hi, cpp);
        numpp += 1;
      }
    }
    return { hi, lo, numpp };
  };

  const checkSr = (hi: number, lo: number, strength: number): boolean => {
    for (let i = 0; i < upLevel.length; i++) {
      const included =
        (upLevel[i]! >= lo && upLevel[i]! <= hi) ||
        (dnLevel[i]! >= lo && dnLevel[i]! <= hi);
      if (included) {
        if (strength >= strengths[i]!) {
          strengths.splice(i, 1);
          upLevel.splice(i, 1);
          dnLevel.splice(i, 1);
          return true;
        }
        return false;
      }
    }
    return true;
  };

  const findLoc = (strength: number): number => {
    let ret = strengths.length;
    for (let i = strengths.length - 1; i >= 0; i--) {
      if (strength <= strengths[i]!) break;
      ret = i;
    }
    return ret;
  };

  for (let x = 0; x < pivots.length; x++) {
    const { hi, lo, numpp } = getSrVals(x);
    if (!checkSr(hi, lo, numpp)) continue;
    const loc = findLoc(numpp);
    if (loc < MAX_ZONES && numpp >= MIN_STRENGTH) {
      strengths.splice(loc, 0, numpp);
      upLevel.splice(loc, 0, hi);
      dnLevel.splice(loc, 0, lo);
      if (strengths.length > MAX_ZONES) {
        strengths.pop();
        upLevel.pop();
        dnLevel.pop();
      }
    }
  }

  return strengths.map((strength, i) => ({
    lo: dnLevel[i]!,
    hi: upLevel[i]!,
    mid: (upLevel[i]! + dnLevel[i]!) / 2,
    strength,
  }));
}
