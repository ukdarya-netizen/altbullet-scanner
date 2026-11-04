import { db } from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { sql } from "drizzle-orm";
import { getKlines } from "./bingx.js";
import { logger } from "./logger.js";
import {
  findCandleReaction,
  findDeviations,
  type RawCandle,
} from "./range-deviation-context.js";

/**
 * A deviation can appear hours or days after the liquidations that triggered
 * the signal. For every open position this follow-up keeps recording closed
 * 15m deviations below the Range lower bounds frozen at fire time, so they can
 * be compared with the outcome later. Observation only; fail-open; never
 * throws. Stored in decision_metrics.rangeDeviationAfter.
 */
export const RANGE_DEVIATION_FOLLOWUP_INTERVAL_MS = 15 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const TFS = ["tf1d", "tf4h", "tf1h"] as const;

type FrozenFrame = { hasRange?: boolean; lower?: number | null };
type StoredContext = { capturedAt?: number } & Partial<
  Record<(typeof TFS)[number], FrozenFrame>
>;

export async function runRangeDeviationFollowup(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const result = await db.execute(sql`
    SELECT id, symbol, decision_metrics->'rangeDeviation' AS ctx
      FROM tracked_signals
     WHERE status::text IN ('active', 'in_run')
       AND decision_metrics ? 'rangeDeviation'
     ORDER BY id
  `);
  let updated = 0;
  for (const row of result.rows as {
    id: number;
    symbol: string;
    ctx: StoredContext;
  }[]) {
    try {
      const fireAt = Number(row.ctx?.capturedAt);
      if (!Number.isFinite(fireAt)) continue;
      const frames = TFS.filter(
        (tf) => row.ctx[tf]?.hasRange && Number(row.ctx[tf]?.lower) > 0,
      );
      const now = Date.now();
      const klines = await withAggregatedKlineVolume(
        row.symbol,
        "15m",
        await getKlines(
          row.symbol,
          "15m",
          Math.min(1000, Math.ceil((now - fireAt) / M15) + 4),
        ),
      );
      const candles: RawCandle[] = klines.map((k) => ({
        time: Number(k.time),
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
        volume: Number(k.volume),
      }));
      const out: Record<string, unknown> = {};
      for (const tf of frames) {
        const lower = Number(row.ctx[tf]!.lower);
        const { events, belowUnreclaimed } = findDeviations(
          candles,
          lower,
          now,
          fireAt,
        );
        out[tf] = { lower, events, belowUnreclaimed };
      }
      const payload = {
        candleReaction: findCandleReaction(candles, now, fireAt),

        source: "post_fire_15m",
        since: fireAt,
        updatedAt: now,
        ...out,
      };
      await db.execute(sql`
        UPDATE tracked_signals
           SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) ||
               jsonb_build_object('rangeDeviationAfter', ${JSON.stringify(payload)}::jsonb)
         WHERE id = ${row.id}
           AND status::text IN ('active', 'in_run')
      `);
      updated += 1;
    } catch (error) {
      logger.warn(
        { error, id: row.id, symbol: row.symbol },
        "Range deviation follow-up failed for position",
      );
    }
  }
  return updated;
}

let running = false;
export function startRangeDeviationFollowup(): void {
  const tick = () => {
    if (running) return;
    running = true;
    runRangeDeviationFollowup()
      .then((count) =>
        logger.info({ count }, "Range deviation follow-up updated"),
      )
      .catch((err) => logger.warn({ err }, "Range deviation follow-up failed"))
      .finally(() => {
        running = false;
      });
  };
  setTimeout(tick, 5 * 60 * 1000).unref();
  setInterval(tick, RANGE_DEVIATION_FOLLOWUP_INTERVAL_MS).unref();
}
