import {
  db,
  neonSnapshotsTable,
  stealthHourlySnapshotsTable,
  vsaEntryMetricsTable,
  wyckoffEntryMetricsTable,
} from "@workspace/db";
import type { trackedSignalsTable } from "@workspace/db";
import { logger } from "./logger.js";
import { getCoinglassOI } from "./coinglass_oi.js";
import {
  getAggFuturesTakerHistory,
  getAggFuturesVolumeByInterval,
  getAggregatedFuturesTakerNetBuyPct15m,
} from "./coinglass_taker.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { getSpotVolume } from "./coinglass_spot_volume.js";
import { computeVsa, loadVsaInputs } from "./vsa-metrics.js";
import { computeWyckoff } from "./wyckoff-metrics.js";

const ENTRY_ANALYTICS_KEYS = new Set([
  "stealth_breakout",
  "neon_support_bounce",
  "impulse_buy",
  "liquidation_cascade",
]);

const HOUR_MS = 3_600_000;
const MAX_HOURS = 72;
// Owner 2026-11-02: Neon snapshots every 10 minutes (own table neon_snapshots, slot_index is the
// 10-minute slot number, stored in its own neon_snapshots table).
const SLOT_MS_BY_KEY: Record<string, number> = {
  stealth_breakout: HOUR_MS,
  neon_support_bounce: 600_000,
};
const METRIC_TIMEOUT_MS = 8_000;

const done = new Set<string>();
const vsaEntryDone = new Set<number>();
const vsaEntryInflight = new Set<number>();

/**
 * One VSA reading per signal on the last closed 1H candle before it (the entry
 * candle). Runs for every open Stealth/Neon position once per process, so
 * signals opened before this existed are filled from history ("backfill").
 */
async function recordVsaEntry(
  tracked: typeof trackedSignalsTable.$inferSelect,
): Promise<void> {
  if (!ENTRY_ANALYTICS_KEYS.has(tracked.sentimentKey ?? "")) return;
  if (vsaEntryDone.has(tracked.id) || vsaEntryInflight.has(tracked.id)) return;
  vsaEntryInflight.add(tracked.id);
  try {
    const entryCandle =
      Math.floor(tracked.detectedAt.getTime() / HOUR_MS) * HOUR_MS - HOUR_MS;
    const { candles, volumes } = await loadVsaInputs(
      tracked.symbol,
      entryCandle + HOUR_MS,
      Date.now(),
      100,
    );
    const [entry] = computeVsa(candles, volumes, [entryCandle]);
    if (!entry) return;
    const ageMs = Date.now() - tracked.detectedAt.getTime();
    const source = ageMs <= 30 * 60_000 ? "live" : "backfill";
    await db
      .insert(wyckoffEntryMetricsTable)
      .values({
        trackedSignalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        source,
        metrics: computeWyckoff(candles, volumes, entryCandle),
      })
      .onConflictDoNothing();
    await db
      .insert(vsaEntryMetricsTable)
      .values({
        trackedSignalId: tracked.id,
        symbol: tracked.symbol,
        sentimentKey: tracked.sentimentKey ?? "unknown",
        source,
        metrics: {
          entryCandle: entry,
          source: "bingx_price_ohlc+coinglass_agg_volume",
        },
      })
      .onConflictDoNothing();
    vsaEntryDone.add(tracked.id);
  } catch (err) {
    logger.warn(
      { err, symbol: tracked.symbol },
      "vsa entry record failed (non-critical)",
    );
  } finally {
    vsaEntryInflight.delete(tracked.id);
  }
}
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
  void recordVsaEntry(tracked);
  const slotMs = SLOT_MS_BY_KEY[tracked.sentimentKey ?? ""];
  if (!slotMs) return;
  const elapsedMs = Date.now() - tracked.detectedAt.getTime();
  const hourIndex = Math.floor(elapsedMs / slotMs);
  // Slot 0 = first snapshot right after the signal; then every full slot.
  if (hourIndex < 0 || hourIndex > (MAX_HOURS * HOUR_MS) / slotMs) return;
  const key = `${tracked.id}:${hourIndex}`;
  if (done.has(key) || inflight.has(key)) return;
  inflight.add(key);
  try {
    const [oi, taker, cvd, spot, vol15m, vol1h, vol4h, takerHist] =
      await Promise.all([
        withTimeout(
          getCoinglassOI(tracked.symbol, currentPrice, undefined, {
            bypassCache: true,
            priority: "low",
          }),
        ),
        withTimeout(
          getAggregatedFuturesTakerNetBuyPct15m(tracked.symbol, 7000),
        ),
        withTimeout(
          getSpotCvdMtf(tracked.symbol, {
            priority: "low",
          }),
        ),
        withTimeout(getSpotVolume(tracked.symbol, { priority: "low" })),
        withTimeout(getAggFuturesVolumeByInterval(tracked.symbol, "15m", 8)),
        withTimeout(getAggFuturesVolumeByInterval(tracked.symbol, "1h", 4)),
        withTimeout(getAggFuturesVolumeByInterval(tracked.symbol, "4h", 4)),
        withTimeout(getAggFuturesTakerHistory(tracked.symbol, 8)),
      ]);
    const nowCandle = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    const vsaInputs = await loadVsaInputs(tracked.symbol, nowCandle).catch(
      () => null,
    );
    const vsa = vsaInputs
      ? computeVsa(vsaInputs.candles, vsaInputs.volumes, [
          nowCandle - 3 * HOUR_MS,
          nowCandle - 2 * HOUR_MS,
          nowCandle - HOUR_MS,
        ])
      : null;
    const volObj = (m: Map<number, number> | null) =>
      m
        ? Object.fromEntries(
            [...m.entries()]
              .sort((a, b) => a[0] - b[0])
              .map(([t, v]) => [new Date(t).toISOString(), v]),
          )
        : null;
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
      // Aggregated (CoinGlass, all exchanges) candle volumes in USD, keyed by
      // candle start; the newest key may be the still-open candle.
      futuresVolumeUsd15m: volObj(vol15m),
      futuresVolumeUsd1h: volObj(vol1h),
      futuresVolumeUsd4h: volObj(vol4h),
      futuresTakerHistory15m: takerHist
        ? takerHist.map((r) => ({
            time: new Date(r.time).toISOString(),
            buyUsd: r.buy,
            sellUsd: r.sell,
          }))
        : null,
      // Raw provider objects, stored whole so no field is lost.
      raw: { oi: oi ?? null, spotCvd: cvd ?? null, spotVolume: spot ?? null },
      // VSA of the last 3 closed 1H candles (spread/close from price OHLC,
      // volume aggregated).
      vsa,
      source: "coinglass_aggregated",
    };
    const row = {
      trackedSignalId: tracked.id,
      symbol: tracked.symbol,
      elapsedMs,
      priceAt: currentPrice,
      pctFromEntry: pnlPct,
      peakPct,
      status: tracked.status,
      metrics,
    };
    if (tracked.sentimentKey === "neon_support_bounce") {
      await db
        .insert(neonSnapshotsTable)
        .values({ ...row, slotIndex: hourIndex })
        .onConflictDoNothing();
    } else {
      await db
        .insert(stealthHourlySnapshotsTable)
        .values({ ...row, hourIndex })
        .onConflictDoNothing();
    }
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
