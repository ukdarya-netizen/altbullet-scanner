import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";

/**
 * Owner decision 2026-10-11: a Stealth Range breakout that has not reached its
 * first target is cancelled when closed candles of the signal's own timeframe
 * (1H for a 1H Range, 4H for a 4H Range) close back below the broken Range
 * upper level, after the entry, and stay there for the hold below (2h for 1H, 4h for 4H).
 * Wicks and the live price do not cancel.
 */
export const STEALTH_RANGE_RETURN_CANCEL_REASON = "stealth_returned_to_range";

const BAR_MS = { auto_range_1h: 3_600_000, auto_range_4h: 14_400_000 } as const;
type RangeSource = keyof typeof BAR_MS;

export interface RangeReturnVerdict {
  returned: boolean;
  level: number;
  timeframe: "1h" | "4h";
  holdHours: number;
  barTime: number | null;
  barClose: number | null;
}

/**
 * Owner decision 2026-10-18: one closed candle below the level is not enough.
 * Price must stay closed back in the Range for 4 hours: from the close of the
 * first candle below the level to the close of the latest candle, with no
 * candle closing at/above the level in between (that resets the countdown).
 */
export const STEALTH_RANGE_RETURN_HOLD_MS = 4 * 60 * 60 * 1_000;

/**
 * Owner decision 2026-10-21 (replay of 241 closed Range signals, hold 0–4h):
 * a 1H Range is cancelled after 2 hours (three closed 1H candles) below the
 * level; a 4H Range keeps the 4-hour hold.
 */
export const STEALTH_RANGE_RETURN_HOLD_1H_MS = 2 * 60 * 60 * 1_000;

export function rangeReturnHoldMs(source: RangeSource): number {
  return source === "auto_range_1h"
    ? STEALTH_RANGE_RETURN_HOLD_1H_MS
    : STEALTH_RANGE_RETURN_HOLD_MS;
}

export function evaluateRangeReturn(
  klines: ReadonlyArray<{ time: number; close: string | number }>,
  barMs: number,
  detectedAtMs: number,
  level: number,
  nowMs: number,
  holdMs: number = STEALTH_RANGE_RETURN_HOLD_MS,
): { barTime: number; barClose: number } | null {
  let first: { barTime: number; barClose: number } | null = null;
  let lastCloseTime = 0;
  for (const k of [...klines].sort((a, b) => a.time - b.time)) {
    if (k.time < detectedAtMs) continue; // only candles fully after entry
    if (k.time + barMs > nowMs) continue; // closed candles only
    const close = Number(k.close);
    if (!Number.isFinite(close)) continue;
    if (close < level) {
      if (first === null) first = { barTime: k.time, barClose: close };
      lastCloseTime = k.time + barMs;
    } else {
      first = null; // reclaimed the level: countdown resets
    }
  }
  if (first === null || lastCloseTime - (first.barTime + barMs) < holdMs) {
    return null;
  }
  return first;
}

const cache = new Map<
  string,
  { at: number; verdict: RangeReturnVerdict | null }
>();
const CACHE_MS = 60_000;

export async function checkStealthRangeReturn(
  trackedSignalId: number,
  signalId: number | null,
  symbol: string,
  detectedAt: Date | null,
  nowMs = Date.now(),
): Promise<RangeReturnVerdict | null> {
  if (signalId === null || !detectedAt) return null;
  const hit = cache.get(`${trackedSignalId}`);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.verdict;
  let verdict: RangeReturnVerdict | null = null;
  try {
    const arm = await db.execute(sql`
      SELECT level_source, breakout_level
        FROM stealth_breakout_armed_setups
       WHERE fired_signal_id = ${signalId} AND symbol = ${symbol}
         AND level_source IN ('auto_range_1h', 'auto_range_4h')
       ORDER BY id DESC LIMIT 1
    `);
    let row = arm.rows[0] as
      | { level_source: RangeSource; breakout_level: number | string }
      | undefined;
    if (!row) {
      // A Stealth re-entry has no arm of its own: it carries the frozen level
      // of the arm it re-entered (decision_metrics.stealthReentry).
      const re = await db.execute(sql`
        SELECT decision_metrics #>> '{stealthReentry,levelSource}' AS level_source,
               decision_metrics #>> '{stealthReentry,level}' AS breakout_level
          FROM tracked_signals
         WHERE id = ${trackedSignalId}
           AND decision_metrics #> '{stealthReentry}' IS NOT NULL
      `);
      const r = re.rows[0] as
        | { level_source: string; breakout_level: string }
        | undefined;
      if (r?.level_source === "auto_range_1h") {
        row = {
          level_source: "auto_range_1h",
          breakout_level: r.breakout_level,
        };
      }
    }
    const level = Number(row?.breakout_level);
    if (row && level > 0) {
      const barMs = BAR_MS[row.level_source];
      const holdMs = rangeReturnHoldMs(row.level_source);
      const klines = await getKlinesRange(
        symbol,
        row.level_source === "auto_range_4h" ? "4h" : "1h",
        Math.floor(detectedAt.getTime() / barMs) * barMs,
        nowMs,
        { strictPayload: true },
      );
      const found = evaluateRangeReturn(
        klines,
        barMs,
        detectedAt.getTime(),
        level,
        nowMs,
        holdMs,
      );
      verdict = {
        returned: found !== null,
        level,
        timeframe: row.level_source === "auto_range_4h" ? "4h" : "1h",
        holdHours: holdMs / 3_600_000,
        barTime: found?.barTime ?? null,
        barClose: found?.barClose ?? null,
      };
    }
  } catch {
    return null; // data unavailable never cancels
  }
  cache.set(`${trackedSignalId}`, { at: nowMs, verdict });
  return verdict;
}
