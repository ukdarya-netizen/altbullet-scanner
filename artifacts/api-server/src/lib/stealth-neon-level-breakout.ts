/**
 * Stealth = breakout of an ABNeon resistance level (owner 2026-11-06).
 *
 * Levels: the Neon zones of the owner's ABNeon indicator (computeSupportZones — 4H pivots, the same
 * levels on any chart timeframe). Every zone is kept with BOTH edges (bottom and top), lower and upper
 * ones alike; a zone above the previous close is resistance.
 *
 * Breakout, on a CLOSED candle of one of two timeframes:
 *  - 4H: the last closed 4H candle closes above a zone top while the previous 4H close was at/below it;
 *  - 1D: the last closed UTC day (built from its six 4H candles) closes above a zone top while the
 *    previous day's close was at/below it.
 * If several zones were crossed at once, the highest one is the broken level. No other filter.
 * Stop −8% from the breakout close (standard Stealth stop); the rest of the management is the standard
 * Stealth exit (B.U. after +8%, trailing from +15%).
 *
 * Candles are cached per symbol: the full history is loaded once, then each 4H close fetches only the
 * newest bars, so the scan does not get longer.
 */
import { computeSupportZones, type SupportZone } from "./stealth-abneon-detectors.js";

export const NEON_LEVEL_4H_METHOD = "neon_level_4h_breakout" as const;
export const NEON_LEVEL_1D_METHOD = "neon_level_1d_breakout" as const;
export type NeonLevelTf = "4h" | "1d";
export const NEON_LEVEL_VERSION = "stealth-neon-level-v1" as const;
export const NEON_LEVEL_STOP_PCT = 8;
export const H4_MS = 4 * 60 * 60_000;
export const D1_MS = 24 * 60 * 60_000;
/** History kept per symbol: the indicator's 600-bar lookback + pivots + ATR warm-up. */
export const NEON_LEVEL_HISTORY_BARS = 700;

export type NlCandle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type NeonLevelBreakout = {
  tf: NeonLevelTf;
  method: typeof NEON_LEVEL_4H_METHOD | typeof NEON_LEVEL_1D_METHOD;
  candleTime: number;
  open: number;
  close: number;
  prevClose: number;
  level: { top: number; bottom: number; count: number };
  crossed: { top: number; bottom: number; count: number }[];
  /** The next resistance zone above the close (null = none). */
  nextResistance: { top: number; bottom: number; count: number } | null;
  /** All Neon zones at the breakout, both edges, low to high. */
  zones: { top: number; bottom: number; count: number }[];
  stopPrice: number;
};

const z = (x: SupportZone) => ({ top: x.top, bottom: x.bottom, count: x.count });

/** Merge newly fetched bars into the cached series (time-unique, sorted, last `max` bars). */
export function mergeCandles(cached: readonly NlCandle[], incoming: readonly NlCandle[], max = NEON_LEVEL_HISTORY_BARS): NlCandle[] {
  const byTime = new Map<number, NlCandle>();
  for (const c of cached) byTime.set(c.time, c);
  for (const c of incoming) if (Number.isFinite(c.time) && c.close > 0) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-max);
}

/** Completed UTC days built from 4H candles (all six 4H bars of the day must be present). */
export function dailyFrom4h(h4: readonly NlCandle[]): NlCandle[] {
  const days = new Map<number, NlCandle[]>();
  for (const c of h4) {
    const d = Math.floor(c.time / D1_MS) * D1_MS;
    (days.get(d) ?? days.set(d, []).get(d)!).push(c);
  }
  const out: NlCandle[] = [];
  for (const [d, bars] of [...days.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length !== 6) continue;
    bars.sort((a, b) => a.time - b.time);
    out.push({
      time: d,
      open: bars[0]!.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[5]!.close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

function breakoutOf(zones: SupportZone[], prevClose: number, close: number) {
  const crossed = zones.filter((x) => prevClose <= x.top && close > x.top).sort((a, b) => b.top - a.top);
  if (!crossed.length) return null;
  const next = zones.filter((x) => x.top > close).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  return { level: crossed[0]!, crossed, next };
}

/**
 * Evaluates the 4H candle that opened at `h4Start` (it must be the last bar of `h4`, closed) and, when
 * that candle ends a UTC day, the day. At most one breakout per symbol and candle: the 1D one wins
 * (the stronger timeframe), the 4H crossing is still recorded in `crossed`.
 */
export function evaluateNeonLevelBreakout(h4: readonly NlCandle[], h4Start: number): NeonLevelBreakout | null {
  const last = h4.at(-1);
  if (!last || last.time !== h4Start || h4.length < 60) return null;
  const prev = h4.at(-2);
  if (!prev || prev.time !== h4Start - H4_MS) return null;
  const zones = computeSupportZones(h4);
  if (!zones.length) return null;
  const all = [...zones].sort((a, b) => a.bottom - b.bottom).map(z);
  const make = (tf: NeonLevelTf, candleTime: number, open: number, close: number, prevClose: number,
    b: NonNullable<ReturnType<typeof breakoutOf>>): NeonLevelBreakout => ({
    tf,
    method: tf === "4h" ? NEON_LEVEL_4H_METHOD : NEON_LEVEL_1D_METHOD,
    candleTime, open, close, prevClose,
    level: z(b.level),
    crossed: b.crossed.map(z),
    nextResistance: b.next ? z(b.next) : null,
    zones: all,
    stopPrice: close * (1 - NEON_LEVEL_STOP_PCT / 100),
  });
  // Day close: the 4H candle 20:00–24:00 UTC closes the UTC day.
  if ((h4Start + H4_MS) % D1_MS === 0) {
    const days = dailyFrom4h(h4);
    const day = days.at(-1), prevDay = days.at(-2);
    if (day && prevDay && day.time === h4Start + H4_MS - D1_MS && prevDay.time === day.time - D1_MS) {
      const b = breakoutOf(zones, prevDay.close, day.close);
      if (b) return make("1d", day.time, day.open, day.close, prevDay.close, b);
    }
  }
  const b = breakoutOf(zones, prev.close, last.close);
  return b ? make("4h", last.time, last.open, last.close, prev.close, b) : null;
}

export const neonLevelTfLabel = (tf: NeonLevelTf) => (tf === "4h" ? "4ч" : "1д");
