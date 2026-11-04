import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { loadLcDetectionVolume } from "./stealth-volume-gate.js";
import {
  captureRange15m,
  captureRangeDeviation,
} from "./range-deviation-capture.js";

/**
 * One-time, idempotent, NON-FATAL enrichment of every still-open position that
 * fired before Range/deviation observation existed. Context is rebuilt from
 * closed candles as of the signal's detection time and labelled
 * `backfilled_as_of_fire_time`; live decision values are untouched.
 */
export async function backfillOpenRangeDeviation(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await db.execute(sql`
    SELECT id, symbol, entry_price,
           (extract(epoch FROM detected_at) * 1000)::bigint AS detected_ms
      FROM tracked_signals
     WHERE status::text IN ('active', 'in_run')
       AND detected_at IS NOT NULL
       AND NOT (COALESCE(decision_metrics, '{}'::jsonb) ? 'rangeDeviation')
     ORDER BY id
  `);
  let written = 0;
  for (const row of result.rows as {
    id: number;
    symbol: string;
    entry_price: number | string;
    detected_ms: string;
  }[]) {
    try {
      const entryPrice = Number(row.entry_price);
      const asOf = Number(row.detected_ms);
      if (!(entryPrice > 0) || !Number.isFinite(asOf)) continue;
      const context = await captureRangeDeviation(row.symbol, entryPrice, asOf);
      await db.execute(sql`
        UPDATE tracked_signals
           SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) ||
               jsonb_build_object('rangeDeviation', ${JSON.stringify(context)}::jsonb)
         WHERE id = ${row.id}
           AND NOT (COALESCE(decision_metrics, '{}'::jsonb) ? 'rangeDeviation')
      `);
      written += 1;
    } catch (error) {
      logger.warn(
        { error, id: row.id, symbol: row.symbol },
        "Open position Range/deviation backfill failed",
      );
    }
  }
  return written;
}

/**
 * Idempotent, non-fatal: add the 15m Range observation (as of detection time)
 * to recent LC positions that were captured before tf15m existed, so rebounds
 * such as PONS keep their 15m lower-bound evidence even after closure.
 */
export async function backfillLc15mRange(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await db.execute(sql`
    SELECT id, symbol, entry_price,
           (extract(epoch FROM detected_at) * 1000)::bigint AS detected_ms
      FROM tracked_signals
     WHERE sentiment_key = 'liquidation_cascade'
       AND detected_at > now() - interval '14 days'
       AND decision_metrics ? 'rangeDeviation'
       AND NOT (decision_metrics->'rangeDeviation' ? 'tf15m')
     ORDER BY id DESC
     LIMIT 200
  `);
  let written = 0;
  for (const row of result.rows as {
    id: number;
    symbol: string;
    entry_price: number | string;
    detected_ms: string;
  }[]) {
    try {
      const entryPrice = Number(row.entry_price);
      const asOf = Number(row.detected_ms);
      if (!(entryPrice > 0) || !Number.isFinite(asOf)) continue;
      const tf15m = await captureRange15m(row.symbol, entryPrice, asOf);
      if (!tf15m) continue;
      await db.execute(sql`
        UPDATE tracked_signals
           SET decision_metrics = jsonb_set(
                 decision_metrics, '{rangeDeviation,tf15m}',
                 ${JSON.stringify(tf15m)}::jsonb, true)
         WHERE id = ${row.id}
           AND NOT (decision_metrics->'rangeDeviation' ? 'tf15m')
      `);
      written += 1;
    } catch (error) {
      logger.warn(
        { error, id: row.id, symbol: row.symbol },
        "LC 15m Range backfill failed",
      );
    }
  }
  return written;
}

/**
 * Idempotent, non-fatal: record aggregated futures AND spot volume ratios of
 * the closed 15m liquidation-detection candle for open LC positions that were
 * opened before this observation existed (labelled backfilled_as_of_detection).
 */
export async function backfillLcDetectionVolume(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await db.execute(sql`
    SELECT t.id, t.symbol,
           (extract(epoch FROM w.detected_at) * 1000)::bigint AS detected_ms
      FROM tracked_signals t
      JOIN liq_cascade_watch w ON w.signal_id = t.id AND w.symbol = t.symbol
     WHERE t.sentiment_key = 'liquidation_cascade'
       AND t.status::text IN ('active', 'in_run')
       AND NOT (COALESCE(t.decision_metrics, '{}'::jsonb) ? 'lcDetectionVolume')
     ORDER BY t.id
  `);
  let written = 0;
  for (const row of result.rows as {
    id: number;
    symbol: string;
    detected_ms: string;
  }[]) {
    try {
      const v = await loadLcDetectionVolume(
        row.symbol,
        Number(row.detected_ms),
      );
      if (v.status !== "ok") continue;
      const payload = {
        version: "lc_detection_volume:v1",
        source: "backfilled_as_of_detection",
        candleOpen: v.candleOpen,
        futuresRatio: v.ratio,
        spotRatio: v.spotRatio,
      };
      await db.execute(sql`
        UPDATE tracked_signals
           SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) ||
               jsonb_build_object('lcDetectionVolume', ${JSON.stringify(payload)}::jsonb)
         WHERE id = ${row.id}
           AND NOT (COALESCE(decision_metrics, '{}'::jsonb) ? 'lcDetectionVolume')
      `);
      written += 1;
    } catch (error) {
      logger.warn(
        { error, id: row.id, symbol: row.symbol },
        "LC detection volume backfill failed",
      );
    }
  }
  return written;
}
