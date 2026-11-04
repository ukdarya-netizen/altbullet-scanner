import { db } from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { getKlines, type BingXKline } from "./bingx.js";

/**
 * Observation only. Fills tracked_signals.entry_candle_analysis for open
 * positions that have none, from the last CLOSED 1H BingX candle at detection
 * time. It is explicitly marked as reconstructed and never feeds a decision.
 */
const HOUR_MS = 3_600_000;
const ATR_PERIOD = 14;
const VOL_BASE = 20;
const MAX_PER_RUN = 15;
export const ENTRY_CANDLE_ANALYSIS_VERSION = "entry_candle_1h_reconstructed_v1";

export function buildEntryCandleAnalysis(
  candles: readonly BingXKline[],
  detectedAt: number,
): Record<string, unknown> | null {
  const closed = candles
    .filter((k) => k.time + HOUR_MS <= detectedAt)
    .sort((a, b) => a.time - b.time);
  const idx = closed.length - 1;
  if (idx < ATR_PERIOD) return null;
  const k = closed[idx];
  const open = Number(k.open);
  const high = Number(k.high);
  const low = Number(k.low);
  const close = Number(k.close);
  const volume = Number(k.volume);
  if (![open, high, low, close, volume].every(Number.isFinite) || open <= 0) {
    return null;
  }
  let trSum = 0;
  for (let i = idx - ATR_PERIOD + 1; i <= idx; i++) {
    const c = closed[i];
    const prevClose = Number(closed[i - 1].close);
    trSum += Math.max(
      Number(c.high) - Number(c.low),
      Math.abs(Number(c.high) - prevClose),
      Math.abs(Number(c.low) - prevClose),
    );
  }
  const atr = trSum / ATR_PERIOD;
  const base = closed.slice(Math.max(0, idx - VOL_BASE), idx);
  const baseMean =
    base.length > 0
      ? base.reduce((s, c) => s + Number(c.volume), 0) / base.length
      : null;
  const range = high - low;
  return {
    version: ENTRY_CANDLE_ANALYSIS_VERSION,
    source: "bingx_1h_reconstructed_at_detection",
    timeframe: "1h",
    candleAt: k.time,
    candleCloseAt: k.time + HOUR_MS,
    open,
    high,
    low,
    close,
    bodyPct: (close / open - 1) * 100,
    rangePct: (high / low - 1) * 100,
    closeInRangePct: range > 0 ? ((close - low) / range) * 100 : null,
    atr14: atr,
    atr14Pct: close > 0 ? (atr / close) * 100 : null,
    bodyAtr: atr > 0 ? Math.abs(close - open) / atr : null,
    volume,
    volumeMult20: baseMean !== null && baseMean > 0 ? volume / baseMean : null,
    volumeBaseCandles: base.length,
  };
}

export async function runEntryCandleAnalysisBackfillCycle(): Promise<number> {
  const rows = (
    await db.execute(sql`
      SELECT t.id, t.detected_at, s.symbol
      FROM tracked_signals t
      JOIN signals s ON s.id = t.signal_id
      WHERE t.status IN ('active', 'in_run')
        AND t.entry_candle_analysis IS NULL
      ORDER BY t.detected_at DESC
      LIMIT ${MAX_PER_RUN}
    `)
  ).rows as Array<{ id: number; detected_at: unknown; symbol: string }>;
  let written = 0;
  for (const row of rows) {
    try {
      const detectedAt =
        row.detected_at instanceof Date
          ? row.detected_at.getTime()
          : Date.parse(String(row.detected_at));
      if (!Number.isFinite(detectedAt)) continue;
      const end = Math.floor(detectedAt / HOUR_MS) * HOUR_MS;
      const candles = await withAggregatedKlineVolume(
        row.symbol,
        "1h",
        await getKlines(
          row.symbol,
          "1h",
          ATR_PERIOD + VOL_BASE + 6,
          end - (ATR_PERIOD + VOL_BASE + 5) * HOUR_MS,
          end,
          { strictPayload: true },
        ),
      );
      const analysis = buildEntryCandleAnalysis(candles, detectedAt);
      if (!analysis) continue;
      await db.execute(sql`
        UPDATE tracked_signals
        SET entry_candle_analysis = ${JSON.stringify(analysis)}::jsonb
        WHERE id = ${row.id} AND entry_candle_analysis IS NULL
      `);
      written += 1;
    } catch (err) {
      logger.warn(
        { err, symbol: row.symbol },
        "Entry candle analysis backfill failed for symbol",
      );
    }
  }
  return written;
}
