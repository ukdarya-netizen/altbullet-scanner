import { resolveAutoRange1hReplayWindow } from "./auto-range-history.js";
import {
  anchoredAutoRangeWindow,
  detectAutoRangePine1h,
} from "./auto-range-pine.js";
import { getKlinesRange } from "./bingx.js";
/**
 * Max relative difference (either bound) between the frozen range and the
 * independent replay. Replayed fired 1H arms differed by <= 2.9%; the SAND
 * 2026-10-07 phantom range differed by 22% on the upper bound.
 */
export const STEALTH_RANGE_RECHECK_TOLERANCE_PCT = 5;

export type StealthRangeRecheck =
  | { ok: true; upper: number; lower: number }
  | {
      ok: false;
      reason: "range_not_confirmed_by_recheck" | "range_recheck_unavailable";
      detail: string;
    };

type Frozen = { upper: number; lower: number };
type Breakout = { upper: number; lower: number } | null;

export function compareFrozenRangeWithReplay(
  frozen: Frozen,
  replayed: Breakout,
  tolerancePct = STEALTH_RANGE_RECHECK_TOLERANCE_PCT,
): StealthRangeRecheck {
  if (!replayed) {
    return {
      ok: false,
      reason: "range_not_confirmed_by_recheck",
      detail: "no_upside_breakout_in_replay",
    };
  }
  const du = Math.abs(replayed.upper / frozen.upper - 1) * 100;
  const dl = Math.abs(replayed.lower / frozen.lower - 1) * 100;
  if (du > tolerancePct || dl > tolerancePct) {
    return {
      ok: false,
      reason: "range_not_confirmed_by_recheck",
      detail: `frozen ${frozen.lower}-${frozen.upper} vs replay ${replayed.lower}-${replayed.upper}`,
    };
  }
  return { ok: true, upper: replayed.upper, lower: replayed.lower };
}

/**
 * Fresh BingX 1H candles are replayed through the same Pine state machine; the
 * latest upside breakout must be the frozen range the arm claims. A stored
 * range that the chart does not contain never fires a signal.
 */
export async function recheckFrozenOneHourRange(
  symbol: string,
  frozen: Frozen,
  now: number = Date.now(),
): Promise<StealthRangeRecheck> {
  try {
    const hour = 60 * 60 * 1000;
    const replayWindow = resolveAutoRange1hReplayWindow();
    // Same replay as the live scanner: N=2000, weekly-anchored start.
    const klines = await getKlinesRange(
      symbol,
      "1h",
      now - (replayWindow + 300) * hour,
      now,
      {
        strictPayload: true,
      },
    );
    const candles = anchoredAutoRangeWindow(
      klines.filter((k) => k.time + hour <= now),
      hour,
      replayWindow,
    ).map((k) => ({
      time: k.time,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      closed: true,
    }));
    const replay = detectAutoRangePine1h(candles, { mergeDeviations: false });
    if (replay.status !== "ready") {
      return {
        ok: false,
        reason: "range_recheck_unavailable",
        detail: replay.reason,
      };
    }
    return compareFrozenRangeWithReplay(frozen, replay.latestUpsideBreakout);
  } catch (error) {
    return {
      ok: false,
      reason: "range_recheck_unavailable",
      detail: error instanceof Error ? error.name : "unknown",
    };
  }
}
