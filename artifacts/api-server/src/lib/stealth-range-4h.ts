/**
 * Stealth Breakout — detection "4H Range breakout with volume" (owner
 * 2026-10-29, live, no shadow; replaces the fresh 24H-high detection).
 *
 * Backtest reports/full/stealth_detect_4h_r (100 days, all BingX USDT perps,
 * old Auto Range detection on 4H, variant P_vol2x, live R exit):
 * 139 trades, +1.29% per trade, both halves positive (+1.19% / +1.40%);
 * by month Jul −5.92% (8) · Aug +1.75% (55) · Sep +4.79% (36) · Oct −1.12% (39).
 * Weak spots: ~1.4 signals/day, October negative, small monthly samples;
 * the study used BingX volume, live uses aggregated (all-exchange) volume.
 *
 * Rules:
 *  - the closed 4H candle is a confirmed upside break of the Auto Range
 *    (Pine replay on closed 4H candles, same detector as the study);
 *  - aggregated futures volume of that 4H candle >= 2× the average of the
 *    previous 20 closed 4H candles;
 *  - stop = range top − 1%, at least 0.3% below the entry;
 *  - owner 2026-10-29, the breakout must not be empty (logic, not backtested):
 *    futures takers net buying over the breakout 4H candle (aggregated) and
 *    spot CVD 4h > 0 (aggregated). Unknown data = no signal.
 * Exit (tracker, same as before): at +1R the stop moves to entry, then trails
 * 1R below the peak; 72h.
 */
import { detectAutoRangePine, type AutoRangeCandle } from "./auto-range-pine.js";

export const STEALTH_RANGE_4H_METHOD = "range_4h_breakout" as const;
export const STEALTH_R4H_MIN_VOL_RATIO = 2;
export const STEALTH_R4H_VOL_LOOKBACK = 20;
export const STEALTH_R4H_STOP_BELOW_LEVEL = 0.99;
export const STEALTH_R4H_MIN_RISK_PCT = 0.3;
export const STEALTH_R4H_MIN_CANDLES = 200;
export const H4_MS = 4 * 60 * 60 * 1000;

export type Range4hDecision = {
  pass: boolean;
  reason: string;
  candleTime: number;
  close: number;
  rangeTop: number | null;
  rangeBottom: number | null;
  rangeHours: number | null;
  stopPrice: number | null;
  riskPct: number | null;
  volRatio: number | null;
};

/**
 * Evaluates the last closed 4H candle of `candles` (closed, ascending).
 * `aggVolume` = aggregated futures volume (USD) by 4H candle open time.
 */
export function evaluateRange4hBreakout(
  candles: readonly AutoRangeCandle[],
  aggVolume: ReadonlyMap<number, number> | null,
): Range4hDecision {
  const last = candles.at(-1);
  const base: Range4hDecision = {
    pass: false, reason: "", candleTime: last?.time ?? 0, close: last?.close ?? 0,
    rangeTop: null, rangeBottom: null, rangeHours: null, stopPrice: null, riskPct: null, volRatio: null,
  };
  if (!last || candles.length < STEALTH_R4H_MIN_CANDLES) return { ...base, reason: "stealth_r4h_short_history" };
  const res = detectAutoRangePine(candles.map((c) => ({ ...c, closed: true })), { mergeDeviations: false });
  const brk = (res.upsideBreakouts ?? []).find((b) => b.breakoutCloseTime === last.time + H4_MS);
  if (!brk) return { ...base, reason: "stealth_r4h_no_breakout" };
  const stopPrice = brk.upper * STEALTH_R4H_STOP_BELOW_LEVEL;
  const riskPct = ((last.close - stopPrice) / last.close) * 100;
  const withRange = {
    ...base, rangeTop: brk.upper, rangeBottom: brk.lower,
    rangeHours: (last.time - brk.anchorAt) / 3_600_000, stopPrice, riskPct,
  };
  if (!aggVolume) return { ...withRange, reason: "stealth_r4h_volume_unknown" };
  const cur = aggVolume.get(last.time);
  const prev: number[] = [];
  for (let k = 1; k <= STEALTH_R4H_VOL_LOOKBACK; k++) {
    const v = aggVolume.get(last.time - k * H4_MS);
    if (v === undefined) break;
    prev.push(v);
  }
  if (cur === undefined || prev.length < STEALTH_R4H_VOL_LOOKBACK) {
    return { ...withRange, reason: "stealth_r4h_volume_unknown" };
  }
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  const volRatio = avg > 0 ? cur / avg : null;
  const withVol = { ...withRange, volRatio };
  if (volRatio === null || !(volRatio >= STEALTH_R4H_MIN_VOL_RATIO)) {
    return { ...withVol, reason: "stealth_r4h_volume_below_2x" };
  }
  if (!(riskPct > STEALTH_R4H_MIN_RISK_PCT)) return { ...withVol, reason: "stealth_r4h_risk_below_0_3pct" };
  return { ...withVol, pass: true, reason: "stealth_r4h_pass" };
}

/** Start of the last fully closed 4H candle at `now`. */
export function lastClosed4hStart(now: number): number {
  return Math.floor(now / H4_MS) * H4_MS - H4_MS;
}
