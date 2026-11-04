import { db } from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { sql } from "drizzle-orm";
import { getKlinesRange } from "./bingx.js";
import { logger } from "./logger.js";

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK = 20;

/**
 * One-time, idempotent, NON-FATAL enrichment of still-open Stealth 1H Auto
 * Range positions that fired before breakout-candle volume was recorded.
 * The breakout bar is a closed 1H candle whose time is stored on the armed
 * setup, so its volume is read back from closed BingX klines. Stored under a
 * separate key with explicit provenance; live decision values are untouched.
 */
export async function backfillOpenStealthBreakoutVolume(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await db.execute(sql`
    SELECT t.id, t.symbol,
           (a.decision_json->'confirmation'->>'triggerCandleAt')::bigint AS trigger_at
      FROM tracked_signals t
      JOIN stealth_breakout_armed_setups a ON a.fired_signal_id = t.signal_id
     WHERE t.sentiment_key = 'stealth_breakout'
       AND t.status::text IN ('active', 'in_run')
       AND a.level_source = 'auto_range_1h'
       AND a.decision_json->'confirmation'->>'triggerCandleAt' IS NOT NULL
       AND NOT (COALESCE(t.decision_metrics, '{}'::jsonb) ? 'entryVolume')
       AND NOT (COALESCE(t.decision_metrics, '{}'::jsonb) ? 'breakoutVolumeBackfill')
  `);
  let written = 0;
  for (const row of result.rows as {
    id: number;
    symbol: string;
    trigger_at: string;
  }[]) {
    try {
      const triggerAt = Number(row.trigger_at);
      const candles = await withAggregatedKlineVolume(
        row.symbol,
        "1h",
        await getKlinesRange(
          row.symbol,
          "1h",
          triggerAt - (LOOKBACK + 1) * HOUR_MS,
          triggerAt + HOUR_MS,
          { strictPayload: true },
        ),
      );
      const bar = candles.find((c) => Number(c.time) === triggerAt);
      const prior = candles.filter(
        (c) =>
          Number(c.time) < triggerAt &&
          Number(c.time) >= triggerAt - LOOKBACK * HOUR_MS,
      );
      if (!bar || prior.length !== LOOKBACK) {
        logger.warn(
          { id: row.id, symbol: row.symbol },
          "Stealth breakout volume backfill skipped: candles incomplete",
        );
        continue;
      }
      const volume = Number(bar.volume);
      const close = Number(bar.close);
      const priorMean =
        prior.reduce((s, c) => s + Number(c.volume), 0) / LOOKBACK;
      if (!(volume > 0) || !(priorMean > 0) || !Number.isFinite(close))
        continue;
      const payload = {
        source: "backfilled_from_closed_1h_klines",
        timeframe: "1h",
        breakoutCandleTime: triggerAt,
        volume,
        turnoverUsd: volume * close,
        priorMeanVolume: priorMean,
        ratio: volume / priorMean,
        backfilledAt: Date.now(),
      };
      await db.execute(sql`
        UPDATE tracked_signals
           SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) ||
               jsonb_build_object('breakoutVolumeBackfill', ${JSON.stringify(payload)}::jsonb)
         WHERE id = ${row.id}
           AND NOT (COALESCE(decision_metrics, '{}'::jsonb) ? 'breakoutVolumeBackfill')
      `);
      written += 1;
    } catch (error) {
      logger.warn(
        { error, id: row.id, symbol: row.symbol },
        "Stealth breakout volume backfill failed for position",
      );
    }
  }
  return written;
}
