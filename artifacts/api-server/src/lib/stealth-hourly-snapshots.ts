import { db, stealthHourlySnapshotsTable } from "@workspace/db";
import type { trackedSignalsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { getCoinglassOI } from "./coinglass_oi.js";
import { getAggregatedFuturesTakerNetBuyPct15m } from "./coinglass_taker.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { getSpotVolume } from "./coinglass_spot_volume.js";

const HOUR_MS = 3_600_000;
const MAX_HOURS = 72;
const METRIC_TIMEOUT_MS = 8_000;

const done = new Set<string>();
const inflight = new Set<string>();

function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), METRIC_TIMEOUT_MS).unref?.(),
    ),
  ]);
}

/**
 * Hourly metric snapshot of an open Stealth Breakout position (observation
 * only). Called from FastCycle; never throws, never blocks trading paths.
 */
export async function maybeRecordStealthHourlySnapshot(
  tracked: typeof trackedSignalsTable.$inferSelect,
  currentPrice: number,
  pnlPct: number,
  peakPct: number,
): Promise<void> {
  if (tracked.sentimentKey !== "stealth_breakout") return;
  const elapsedMs = Date.now() - tracked.detectedAt.getTime();
  const hourIndex = Math.floor(elapsedMs / HOUR_MS);
  if (hourIndex < 1 || hourIndex > MAX_HOURS) return;
  const key = `${tracked.id}:${hourIndex}`;
  if (done.has(key) || inflight.has(key)) return;
  inflight.add(key);
  try {
    const [oi, taker, cvd, spot] = await Promise.all([
      withTimeout(
        getCoinglassOI(tracked.symbol, currentPrice, undefined, {
          bypassCache: true,
          priority: "low",
        }),
      ),
      withTimeout(getAggregatedFuturesTakerNetBuyPct15m(tracked.symbol, 7000)),
      withTimeout(
        getSpotCvdMtf(tracked.symbol, {
          priority: "low",
        }),
      ),
      withTimeout(getSpotVolume(tracked.symbol, { priority: "low" })),
    ]);
    const oiOk = oi?.available === true;
    const metrics = {
      oiUsd: oiOk ? (oi.oiUsd ?? null) : null,
      oiChange30mPct: oiOk ? (oi.oiChange30m ?? null) : null,
      oiChange1hPct: oiOk ? (oi.oiChange1h ?? null) : null,
      oiChange4hPct: oiOk ? (oi.oiChange4h ?? null) : null,
      oiChange24hPct: oiOk ? (oi.oiChange24h ?? null) : null,
      futuresTakerNetBuyPct15m: taker?.available ? taker.netBuyPct : null,
      spotCvdAvailable: cvd?.available === true,
      spotCvd15m: cvd?.available ? cvd.cvd15m : null,
      spotCvd1h: cvd?.available ? cvd.cvd1h : null,
      spotCvd4h: cvd?.available ? cvd.cvd4h : null,
      spotCvdStrength1h: cvd?.available ? cvd.cvdStrength1h : null,
      spotVolumeUsd1h: spot?.available ? spot.volumeUsd1h : null,
      spotNetBuyPct1h: spot?.available ? spot.netBuyPct1h : null,
      source: "coinglass_aggregated",
    };
    await db
      .insert(stealthHourlySnapshotsTable)
      .values({
        trackedSignalId: tracked.id,
        symbol: tracked.symbol,
        hourIndex,
        elapsedMs,
        priceAt: currentPrice,
        pctFromEntry: pnlPct,
        peakPct,
        status: tracked.status,
        metrics,
      })
      .onConflictDoNothing();
    done.add(key);
  } catch (err) {
    logger.warn(
      { err, symbol: tracked.symbol },
      "stealth hourly snapshot failed (non-critical)",
    );
  } finally {
    inflight.delete(key);
  }
}
