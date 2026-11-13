/**
 * Owner 2026-11-13: the delta line of position updates (OI, CVD 15m / 30m / 1h) — pure helpers of watcher.ts.
 */
import type { SpotHealth } from "./watcher-formatters.js";

export const HEALTH_LAST_GOOD_MAX_MS = 60 * 60_000;

/** Fills what the fresh read lacks from the last good reading of the coin (≤ 60 min), with its age. */
export function mergeWithLastGoodHealth(
  symbol: string,
  fresh: SpotHealth | null,
  now: number,
  store: Map<string, { health: SpotHealth; at: number }>,
): SpotHealth | null {
  const complete = (h: SpotHealth | null) =>
    h != null && h.oiPct != null && (h.cvd15m != null || h.cvd30m != null || h.cvd1h != null);
  if (complete(fresh)) {
    store.set(symbol, { health: fresh!, at: now });
    return fresh;
  }
  const prev = store.get(symbol);
  if (!prev || now - prev.at > HEALTH_LAST_GOOD_MAX_MS) return fresh;
  const freshCvd = fresh != null && (fresh.cvd15m != null || fresh.cvd30m != null || fresh.cvd1h != null);
  const merged: SpotHealth = {
    oiPct: fresh?.oiPct ?? prev.health.oiPct,
    cvd15m: freshCvd ? fresh!.cvd15m : prev.health.cvd15m,
    cvd30m: freshCvd ? fresh!.cvd30m : prev.health.cvd30m,
    cvd1h: freshCvd ? fresh!.cvd1h : prev.health.cvd1h,
    cvdSource: freshCvd ? fresh!.cvdSource : prev.health.cvdSource,
    staleMin: Math.max(1, Math.round((now - prev.at) / 60_000)),
  };
  return merged;
}

/** CVD direction from aggregated futures taker 15m candles (oldest → newest; the newest may be forming). */
export function futuresCvdFromTakers(
  rows: Array<{ buy: number; sell: number }> | null,
): Pick<SpotHealth, "cvd15m" | "cvd30m" | "cvd1h"> | null {
  const xs = (rows ?? []).filter((r) => r.buy + r.sell > 0);
  if (xs.length < 2) return null;
  const dir = (part: Array<{ buy: number; sell: number }>) => {
    const b = part.reduce((a, r) => a + r.buy, 0), s = part.reduce((a, r) => a + r.sell, 0);
    return b + s > 0 ? b > s : null;
  };
  // Same windows as the spot CVD: 15m = the last closed bar, 30m = the last two, 1h = the last four.
  return {
    cvd15m: dir([xs[xs.length - 2]!]),
    cvd30m: dir(xs.slice(-2)),
    cvd1h: xs.length >= 4 ? dir(xs.slice(-4)) : null,
  };
}

