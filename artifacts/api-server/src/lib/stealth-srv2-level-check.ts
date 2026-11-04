import { computeSrv2Zones, type Srv2Zone } from "./srv2-zones.js";
import { getKlines } from "./bingx.js";

/**
 * Owner decision 2026-10-15 (AT): a Stealth breakout level must coincide with
 * an SRv2 zone, otherwise it is only a line inside a larger range and its
 * "breakout" is not a breakout. Tolerance is the owner-approved 1% of level.
 */
export const STEALTH_SRV2_LEVEL_TOLERANCE_PCT = 1;

export type StealthSrv2LevelCheck =
  | { ok: true; zone: Srv2Zone }
  | {
      ok: false;
      reason: "level_not_on_srv2_zone" | "srv2_unavailable";
      detail: string;
    };

export function checkLevelAgainstSrv2Zones(
  level: number,
  zones: readonly Srv2Zone[],
  tolerancePct = STEALTH_SRV2_LEVEL_TOLERANCE_PCT,
): StealthSrv2LevelCheck {
  if (zones.length === 0) {
    return { ok: false, reason: "srv2_unavailable", detail: "no_zones" };
  }
  const tol = (level * tolerancePct) / 100;
  const hit = zones.find((z) => level >= z.lo - tol && level <= z.hi + tol);
  if (hit) return { ok: true, zone: hit };
  const nearest = zones
    .map((z) => ({
      z,
      d: level < z.lo ? z.lo - level : level > z.hi ? level - z.hi : 0,
    }))
    .sort((a, b) => a.d - b.d)[0]!;
  return {
    ok: false,
    reason: "level_not_on_srv2_zone",
    detail: `level ${level} nearest zone ${nearest.z.lo}-${nearest.z.hi} (${((nearest.d / level) * 100).toFixed(2)}% away)`,
  };
}

export async function checkStealthLevelOnSrv2(
  symbol: string,
  level: number,
  timeframe: "1h" | "4h",
  now: number = Date.now(),
): Promise<StealthSrv2LevelCheck> {
  try {
    const barMs = timeframe === "1h" ? 3_600_000 : 14_400_000;
    const klines = await getKlines(
      symbol,
      timeframe,
      500,
      undefined,
      undefined,
      {
        strictPayload: true,
      },
    );
    const candles = klines
      .filter((k) => k.time + barMs <= now)
      .map((k) => ({
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
      }))
      .filter((k) => [k.high, k.low, k.close].every(Number.isFinite));
    return checkLevelAgainstSrv2Zones(level, computeSrv2Zones(candles));
  } catch (error) {
    return {
      ok: false,
      reason: "srv2_unavailable",
      detail: error instanceof Error ? error.name : "unknown",
    };
  }
}
