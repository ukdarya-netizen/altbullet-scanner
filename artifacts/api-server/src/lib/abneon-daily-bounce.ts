/**
 * ABNeon support bounce on the closed UTC DAY (owner 2026-11-07, AIO / OLAXBT 1D chart).
 *
 * Same Neon support zones as the 4H bounce (4H pivots, the same levels on any chart timeframe, minus the
 * zones price already broke through after their last pivot). The daily candle (built from its six 4H bars)
 *  - opened above the zone bottom (price came down to support, not up from under it),
 *  - dipped into the zone: low ≤ zone top +1%,
 *  - closed bullish (close > open) and back at/above the zone bottom −1%,
 *  - did NOT close above the next Neon resistance over the support (that is a breakout = Stealth).
 * Several touched zones → the highest one (the nearest support). Zones are taken as they stood when the
 * day opened (the day's own low never makes its zone).
 *
 * The 4H rules that follow the event (pre-touch volume gate, −8% stop, exits) are the same as for the
 * 4H bounce; the signal carries its timeframe (1д) everywhere it is shown.
 */
import { liveSupportZones, type ClosedDetectorCandle } from "./stealth-abneon-detectors.js";
import { dailyFrom4h, D1_MS, H4_MS, type NlCandle } from "./stealth-neon-level-breakout.js";

export const ABNEON_DAILY_VERSION = "abneon-daily-bounce-v1" as const;
const TOL = 0.01;

type Zone = { top: number; bottom: number; count: number };
export type AbneonDailyBounce = {
  tf: "1d";
  dayTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  zone: Zone;
  /** The next Neon resistance above the support (null = none). */
  nextResistance: Zone | null;
  zones: Zone[];
};

const z = (x: Zone): Zone => ({ top: x.top, bottom: x.bottom, count: x.count });

/** Evaluated when the 4H candle that opened at `h4Start` (the last bar of `h4`) closes the UTC day. */
export function evaluateAbneonDailyBounce(h4: readonly NlCandle[], h4Start: number): AbneonDailyBounce | null {
  if ((h4Start + H4_MS) % D1_MS !== 0) return null;
  const last = h4.at(-1);
  if (!last || last.time !== h4Start) return null;
  const day = dailyFrom4h(h4).at(-1);
  if (!day || day.time !== h4Start + H4_MS - D1_MS) return null;
  if (!(day.close > day.open)) return null;
  const before = h4.filter((c) => c.time < day.time) as ClosedDetectorCandle[];
  if (before.length < 60) return null;
  const all = liveSupportZones(before).sort((a, b) => a.bottom - b.bottom);
  const touched = all
    .filter(
      (x) =>
        day.open >= x.bottom &&
        day.low <= x.top * (1 + TOL) &&
        day.close >= x.bottom * (1 - TOL),
    )
    .sort((a, b) => b.top - a.top);
  const zone = touched[0];
  if (!zone) return null;
  const next = all.filter((x) => x.bottom > zone.top).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  if (next && day.close > next.top) return null; // closed through the next resistance: a breakout
  return {
    tf: "1d",
    dayTime: day.time,
    open: day.open,
    high: day.high,
    low: day.low,
    close: day.close,
    zone: z(zone),
    nextResistance: next ? z(next) : null,
    zones: all.map(z),
  };
}
