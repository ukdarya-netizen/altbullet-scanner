/**
 * Stealth = breakout of an ABNeon resistance level (owner 2026-11-06).
 *
 * Levels: the Neon zones of the owner's ABNeon indicator (computeSupportZones — DAILY pivots since
 * 2026-11-14, the same levels on any chart timeframe; 4H before). Every zone is kept with BOTH edges (bottom and top), lower and upper
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
import { detectAutoRangePine, detectAutoRangePine1d, type AutoRangeCandle } from "./auto-range-pine.js";
import { welkinColour } from "./abneon-volume-gate.js";

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

// ── Owner 2026-11-07: Stealth = Auto Range breakout whose range top sits on an ABNeon zone ──────────────
// The level crossing alone (above) had no edge. The event is now the Auto Range [QuantAlgo] upside breakout
// (CAB's port, the indicator's default settings) on a closed BingX-futures 4H candle — or on the closed UTC day
// (daily range, ≥ 200 daily candles) — when the TOP of the broken range lies on a Neon zone (zone bottom −1% …
// zone top +1%). No deviation condition (owner: later). No other filter; stop −8% from the close.

export const NEON_RANGE_VERSION = "stealth-neon-range-v2" as const;
const ZONE_TOL = 0.01;
const toAr = (cs: readonly NlCandle[]): AutoRangeCandle[] =>
  cs.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, closed: true }));

export type NeonRangeBreakout = NeonLevelBreakout & {
  range: { upper: number; lower: number; anchorAt: number; heightPct: number };
};

/** The Neon zone the range top sits on (bottom −1% … top +1%); the strongest when several. */
export function zoneUnderRangeTop(zones: readonly SupportZone[], upper: number): SupportZone | null {
  return (
    zones
      .filter((x) => upper >= x.bottom * (1 - ZONE_TOL) && upper <= x.top * (1 + ZONE_TOL))
      .sort((a, b) => b.count - a.count)[0] ?? null
  );
}

/**
 * Evaluates the 4H candle that opened at `h4Start` (the last bar of `h4`, closed) and, when it closes the UTC
 * day and `d1` (closed daily candles up to that day) is given, the day. At most one event; 1D wins.
 */
export function evaluateNeonRangeBreakout(
  h4: readonly NlCandle[],
  h4Start: number,
  d1?: readonly NlCandle[],
): NeonRangeBreakout | null {
  const last = h4.at(-1);
  if (!last || last.time !== h4Start || h4.length < 220) return null;
  const prev = h4.at(-2);
  if (!prev || prev.time !== h4Start - H4_MS) return null;
  const zones = computeSupportZones(h4);
  if (!zones.length) return null;
  const all = [...zones].sort((a, b) => a.bottom - b.bottom).map(z);
  const make = (tf: NeonLevelTf, candleTime: number, open: number, close: number, prevClose: number,
    zone: SupportZone, b: { upper: number; lower: number; anchorAt: number }): NeonRangeBreakout => {
    const next = zones.filter((x) => x.bottom > close).sort((a, c) => a.bottom - c.bottom)[0] ?? null;
    return {
      tf,
      method: tf === "4h" ? NEON_LEVEL_4H_METHOD : NEON_LEVEL_1D_METHOD,
      candleTime, open, close, prevClose,
      level: z(zone),
      crossed: [z(zone)],
      nextResistance: next ? z(next) : null,
      zones: all,
      stopPrice: close * (1 - NEON_LEVEL_STOP_PCT / 100),
      range: { upper: b.upper, lower: b.lower, anchorAt: b.anchorAt, heightPct: ((b.upper - b.lower) / b.lower) * 100 },
    };
  };
  const closeAt = h4Start + H4_MS;
  if (closeAt % D1_MS === 0 && d1 && d1.length >= 200) {
    const day = d1.at(-1), pd = d1.at(-2);
    if (day && pd && day.time === closeAt - D1_MS && pd.time === day.time - D1_MS) {
      const res = detectAutoRangePine1d(toAr(d1));
      const b = (res.upsideBreakouts ?? []).find((x) => x.breakoutCloseTime === closeAt);
      const zone = b ? zoneUnderRangeTop(zones, b.upper) : null;
      if (b && zone) return make("1d", day.time, day.open, day.close, pd.close, zone, b);
    }
  }
  const res = detectAutoRangePine(toAr(h4));
  const b = (res.upsideBreakouts ?? []).find((x) => x.breakoutCloseTime === closeAt);
  const zone = b ? zoneUnderRangeTop(zones, b.upper) : null;
  return b && zone ? make("4h", last.time, last.open, last.close, prev.close, zone, b) : null;
}

// ── Owner 2026-11-11: Stealth = 4H close above an ABNeon zone top on bright aggregated volume ───────────
// Her charts (Everlyn AI 02.11, BLESS 28.10) break out on purple / white VSA bars; the Auto Range
// condition missed Everlyn and entered BLESS +27% late. The event: the closed 4H candle closes above the top
// of an ABNeon zone (previous 4H close at/below it; the highest crossed zone is the level) AND its CoinGlass
// aggregated futures volume is Welkin M or W (≥ average + 3σ of the last 20 4H candles). No aggregated
// volume = no signal. 4H only. Stop −8% from the close; the standard Stealth exit.

export const NEON_VSA_VERSION = "stealth-neon-vsa-v3" as const;
const VSA_BRIGHT = new Set(["M", "W"]);

/**
 * Price-only: the 4H crossing of the candle that opened at `h4Start` (last bar of `h4`, closed), or null.
 * Owner 2026-11-14: `zones` = the DAILY ABNeon zones (live); without it the zones come from the 4H candles.
 */
export function neonLevelCrossing4h(h4: readonly NlCandle[], h4Start: number, zonesIn?: readonly SupportZone[]): NeonLevelBreakout | null {
  const last = h4.at(-1);
  if (!last || last.time !== h4Start || h4.length < 60) return null;
  const prev = h4.at(-2);
  if (!prev || prev.time !== h4Start - H4_MS) return null;
  const zones = zonesIn ? [...zonesIn] : computeSupportZones(h4);
  if (!zones.length) return null;
  const b = breakoutOf(zones, prev.close, last.close);
  if (!b) return null;
  return {
    tf: "4h",
    method: NEON_LEVEL_4H_METHOD,
    candleTime: last.time,
    open: last.open,
    close: last.close,
    prevClose: prev.close,
    level: z(b.level),
    crossed: b.crossed.map(z),
    nextResistance: b.next ? z(b.next) : null,
    zones: [...zones].sort((a, c) => a.bottom - c.bottom).map(z),
    stopPrice: last.close * (1 - NEON_LEVEL_STOP_PCT / 100),
  };
}

/** Welkin colour of the last 4H candle on aggregated futures volume (USD by candle open time), or null. */
export function neonBreakoutColour(h4: readonly NlCandle[], agg4hUsdByTime: ReadonlyMap<number, number>): string | null {
  const n = h4.length;
  if (n < 20) return null;
  const vol: number[] = [];
  for (let q = n - 20; q < n; q++) {
    if (q > n - 20 && h4[q]!.time - h4[q - 1]!.time !== H4_MS) return null;
    const usd = agg4hUsdByTime.get(h4[q]!.time);
    if (!(usd != null && usd > 0 && h4[q]!.close > 0)) return null;
    vol.push(usd / h4[q]!.close);
  }
  return welkinColour(vol, vol.length - 1);
}

export const isNeonVsaBright = (colour: string | null): colour is string => colour !== null && VSA_BRIGHT.has(colour);
