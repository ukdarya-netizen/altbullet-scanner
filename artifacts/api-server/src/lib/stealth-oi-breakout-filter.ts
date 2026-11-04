import { applyCgAlias } from "./cg-symbol-alias.js";
import { fetchOi4hChangeAt } from "./stealth-participation-backfill.js";

/**
 * Owner 2026-10-23: replaces the OI 1h > 1.28% and range-height > 4.5% gates.
 * Backtest of 1506 closed-1H breakouts (+8% before -8%): OI 4h > 4.6% with
 * 1H volume ratio > 1.01x gave 42% train / 56% held-out vs 35% base.
 * Range height is kept as telemetry only.
 */
export const STEALTH_MIN_OI4H_AT_BREAKOUT_PCT = 4.6;
export const STEALTH_MIN_1H_VOLUME_RATIO = 1.01;

export function stealthOi4hPasses(value: number | null): boolean {
  return value !== null && value > STEALTH_MIN_OI4H_AT_BREAKOUT_PCT;
}

export function stealth1hVolumeRatioPasses(value: number | null): boolean {
  return value !== null && value > STEALTH_MIN_1H_VOLUME_RATIO;
}

const FAILURE_RETRY_MS = 60_000;
const cache = new Map<string, { value: number | null; at: number }>();

/** Measured once per symbol+breakout; failures are retried after a short TTL. */
export async function getStealthOi4hAtBreakout(
  symbol: string,
  crossingAt: number,
): Promise<number | null> {
  const key = `${symbol}:${crossingAt}`;
  const hit = cache.get(key);
  if (hit && (hit.value !== null || Date.now() - hit.at < FAILURE_RETRY_MS))
    return hit.value;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, ""));
  const value = await fetchOi4hChangeAt(base, crossingAt);
  cache.set(key, { value, at: Date.now() });
  if (cache.size > 500) {
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size <= 250) break;
    }
  }
  return value;
}
