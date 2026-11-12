/**
 * ABNeon entry by the trading rules of a support bounce (owner 2026-11-12: "обычный отскок уровня по правилам";
 * the 1%-above-the-zone limit removed: "не работает по логическим законам трейдинга").
 * Study reports/abneon-bounce-rules (555 coins, 09.09–12.11), variant R8 — the one put live.
 *
 * On an armed ABNeon zone (the detector's frozen level, the zone resolved as the detector holds it):
 *   - the test: a closed 1H candle after the arm whose low reaches the zone top +2% (a sweep under the zone is
 *     allowed — liquidity grab);
 *   - the entry: the FIRST closed green 1H candle that closes at or above the zone bottom, at most 8 hours after the
 *     lowest low of the test (a later lower low is a new test); no limit on how far above the zone it closes;
 *   - Lucy's VSA on the touch: the touch 4H candle or one of the next two not grey (futures + spot; a grey touch voids
 *     the setup; while the touch 4H candle is open the candidate waits);
 *   - void: a closed 4H candle under the zone bottom, or 48 h after the arm without an entry.
 * Exit (owner, variant B): take at the nearest resistance — the bottom of the nearest ABNeon zone above the entry;
 *   no zone above → the usual ABNeon exit (B.U. +10%, trailing from +20% at 20 p.p.). Stop −6% from the entry and
 *   the cancel on a 4H close under the zone stay.
 * The bounce from a fresh low (no zone) is not part of R8 and is off (study: −1.11% a trade, the worst).
 */
import type { TouchVolume } from "./abneon-volume-gate.js";

const H1 = 3_600_000;
const H4 = 4 * H1;
export const ABNEON_RULE_VERSION = "abneon-r8-v1";
export const ABNEON_REACTION_WINDOW_H = 8;
export const ABNEON_ARM_WINDOW_H = 48;
export const ABNEON_TOUCH_ABOVE_TOP = 1.02;
/** Owner 2026-11-12: the bounce from a fresh low is off with R8. */
export const ABNEON_LOW_BOUNCE_LIVE = false;

type Bar = { time: number; open: number; high: number; low: number; close: number };

export type RuleEntryResult =
  | { status: "entry"; candleTime: number; closeAt: number; entry: number; testTime: number; testLow: number; testLowAt: number; touch: TouchVolume & { ok: true } }
  | { status: "void"; reason: string; colours?: string[] }
  | { status: "waiting"; reason: "no_test_yet" | "no_reaction_yet" | "awaiting_touch_4h_close" };

/**
 * The R8 entry on one armed zone, from closed candles (oldest first). `lucy(triggerCandleTime, closeAt)` = Lucy's
 * VSA on the touch for that trigger (touchVolumeNotGrey); asked only for a price trigger.
 */
export async function ruleEntryOnArm(input: {
  candles1h: readonly Bar[];
  candles4h: readonly Bar[];
  zone: { bottom: number; top: number };
  armTime: number;
  nowMs: number;
  lucy: (triggerCandleTime: number, closeAt: number) => Promise<TouchVolume>;
}): Promise<RuleEntryResult> {
  const { bottom, top } = input.zone;
  const h4close = new Map(input.candles4h.map((c) => [c.time + H4, c.close]));
  let touched = false, testTime = 0, low = Infinity, lowAt = 0;
  let waiting: "no_test_yet" | "no_reaction_yet" | "awaiting_touch_4h_close" = "no_test_yet";
  for (const c of input.candles1h) {
    if (c.time < input.armTime) continue;
    const closeAt = c.time + H1;
    if (closeAt > input.nowMs) break;
    if (closeAt > input.armTime + ABNEON_ARM_WINDOW_H * H1) return { status: "void", reason: "arm_window_over" };
    if (closeAt % H4 === 0) {
      const c4 = h4close.get(closeAt);
      if (c4 !== undefined && c4 < bottom) return { status: "void", reason: "closed_4h_under_zone" };
    }
    if (!touched && c.low <= top * ABNEON_TOUCH_ABOVE_TOP) { touched = true; testTime = c.time; }
    if (!touched) continue;
    waiting = waiting === "awaiting_touch_4h_close" ? waiting : "no_reaction_yet";
    if (c.low < low) { low = c.low; lowAt = closeAt; }
    if (!(c.close > c.open && c.close >= bottom)) continue;
    if (closeAt - lowAt > ABNEON_REACTION_WINDOW_H * H1) continue;
    const tv = await input.lucy(c.time, closeAt);
    if (!tv.ok && tv.reason === "touch_bar_not_closed") { waiting = "awaiting_touch_4h_close"; continue; }
    if (!tv.ok) return { status: "void", reason: tv.reason === "touch_volume_grey" ? `touch_volume_grey_${tv.colours.join("")}` : `touch_${tv.reason}`, colours: tv.colours };
    return { status: "entry", candleTime: c.time, closeAt, entry: c.close, testTime, testLow: low, testLowAt: lowAt, touch: tv };
  }
  if (input.nowMs > input.armTime + ABNEON_ARM_WINDOW_H * H1) return { status: "void", reason: "arm_window_over" };
  return { status: "waiting", reason: waiting };
}

/** Bottoms of the ABNeon zones above a price, nearest first (the resistances for the take). */
export function resistancesAbove(zones: readonly { bottom: number; top: number }[], price: number): number[] {
  return zones.map((z) => z.bottom).filter((b) => b > price).sort((a, b) => a - b);
}

/** The take: the nearest resistance above the entry, or null (no zone above → the usual exit). */
export function abneonTake(entryPrice: number, resistances: readonly number[] | null | undefined): { price: number; pct: number } | null {
  if (!(entryPrice > 0) || !resistances?.length) return null;
  const price = resistances.filter((r) => Number.isFinite(r) && r > entryPrice).sort((a, b) => a - b)[0];
  return price === undefined ? null : { price, pct: Math.round(((price / entryPrice - 1) * 100) * 100) / 100 };
}

// ── Readings at the entry, for sorting later by takers, delta and open interest (owner) ──
type TakerBar = { time: number; buy: number; sell: number };
type OiBar = { time: number; close: number };

/** (buy − sell) / (buy + sell) over 15m taker bars whose open is in [from, to). */
export function takerDelta(bars: readonly TakerBar[] | null, from: number, to: number): number | null {
  if (!bars) return null;
  let b = 0, s = 0, n = 0;
  for (const x of bars) if (x.time >= from && x.time < to) { b += x.buy; s += x.sell; n++; }
  return n && b + s > 0 ? Math.round(((b - s) / (b + s)) * 10_000) / 10_000 : null;
}

/** OI change, %, from the last OI close at or before `from` to the last at or before `to`. */
export function oiChange(bars: readonly OiBar[] | null, from: number, to: number): number | null {
  if (!bars?.length) return null;
  const at = (t: number) => { let v: number | null = null; for (const x of bars) if (x.time <= t) v = x.close; return v; };
  const a = at(from), b = at(to);
  return a && b ? Math.round(((b / a - 1) * 100) * 100) / 100 : null;
}

/**
 * The same windows as the study (scripts/study-v2/cg.ts): 12 h before the first touch, the touch to the trigger,
 * the trigger hour, the 24 h to the trigger; OI 4 / 24 / 72 h to the entry and from the hour before the touch.
 */
export function entryReadings(input: {
  firstTouchTime: number;
  triggerCandleTime: number;
  entryAt: number;
  futTakers: readonly TakerBar[] | null;
  spotTakers: readonly TakerBar[] | null;
  oi: readonly OiBar[] | null;
}): Record<string, number | null> {
  const t1 = Math.floor(input.firstTouchTime / H1) * H1, tt = input.triggerCandleTime;
  const out: Record<string, number | null> = {};
  for (const [p, bars] of [["fut", input.futTakers], ["spot", input.spotTakers]] as const) {
    out[`${p}_tk_pre12_delta`] = takerDelta(bars, t1 - 12 * H1, t1);
    out[`${p}_tk_win_delta`] = takerDelta(bars, t1, tt + H1);
    out[`${p}_tk_trig_delta`] = takerDelta(bars, tt, tt + H1);
    out[`${p}_tk_24h_delta`] = takerDelta(bars, tt - 23 * H1, tt + H1);
  }
  out.oi_chg4h = oiChange(input.oi, input.entryAt - 4 * H1, input.entryAt);
  out.oi_chg24h = oiChange(input.oi, input.entryAt - 24 * H1, input.entryAt);
  out.oi_chg72h = oiChange(input.oi, input.entryAt - 72 * H1, input.entryAt);
  out.oi_chg_touch_to_entry = oiChange(input.oi, t1 - H1, input.entryAt);
  return out;
}
