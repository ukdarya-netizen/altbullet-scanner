/**
 * CoinGlass — Futures vs Spot 24h volume, aggregated across all exchanges.
 *
 * Owner rule: every volume metric uses the CoinGlass aggregate, never a fixed
 * subset of exchanges and never BingX.
 *   - spot 24h    : spot/pairs-markets, sum of volume_usd_24h over every exchange
 *                   in the response (getSpotVolume).
 *   - futures 24h : futures aggregated taker buy+sell volume (7 exchanges),
 *                   sum of the last 96 × 15m candles (getAggFuturesTakerHistory).
 *
 * Result cached 30 minutes per symbol. A missing side stays null; there is no
 * fallback to another source.
 */

import { getSpotVolume } from "./coinglass_spot_volume.js";
import { getAggFuturesTakerHistory } from "./coinglass_taker.js";
import type { CoinglassPriority } from "./coinglass_governor.js";

export interface FsVolumeResult {
  available: boolean;
  futVolUsd24h: number | null; // aggregated futures 24h volume USD
  spotVolUsd24h: number | null; // aggregated spot 24h volume USD (all exchanges)
  futSpotRatio: number | null; // futVolUsd24h / spotVolUsd24h
}

const CACHE_TTL = 30 * 60 * 1000;
const FUT_BARS_24H = 96; // 96 × 15m

const cache = new Map<string, { result: FsVolumeResult; ts: number }>();

export async function getFsVolume(
  bingxSymbol: string,
  options: { priority?: CoinglassPriority } = {},
): Promise<FsVolumeResult> {
  const cached = cache.get(bingxSymbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.result;

  const [spot, futRows] = await Promise.all([
    getSpotVolume(bingxSymbol, { priority: options.priority }).catch(
      () => null,
    ),
    getAggFuturesTakerHistory(bingxSymbol, FUT_BARS_24H).catch(() => null),
  ]);

  const spotVolUsd24h =
    spot?.available && (spot.volumeUsd24h ?? 0) > 0 ? spot.volumeUsd24h : null;
  let futVolUsd24h: number | null = null;
  if (futRows && futRows.length > 0) {
    const total = futRows
      .slice(-FUT_BARS_24H)
      .reduce((sum, r) => sum + r.buy + r.sell, 0);
    futVolUsd24h = total > 0 ? total : null;
  }

  const available = spotVolUsd24h !== null || futVolUsd24h !== null;
  const result: FsVolumeResult = {
    available,
    futVolUsd24h,
    spotVolUsd24h,
    futSpotRatio:
      futVolUsd24h && spotVolUsd24h ? futVolUsd24h / spotVolUsd24h : null,
  };
  if (available) cache.set(bingxSymbol, { result, ts: Date.now() });
  return result;
}

/** Invalidate per-symbol cache (e.g. after forced refresh). */
export function clearFsVolumeCache(bingxSymbol: string): void {
  cache.delete(bingxSymbol);
}
