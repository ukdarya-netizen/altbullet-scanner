import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";
import { NEON_RANGE_VERSION } from "./stealth-neon-level-breakout.js";

/**
 * Owner 2026-11-07: Stealth detection changes from the plain ABNeon level crossing (stealth-neon-level-v1) to the
 * Auto Range breakout whose range top sits on an ABNeon zone (stealth-neon-range-v2). Every still-open Stealth
 * position of the previous detection is closed neutrally: no exit fill, no PnL, outside the statistics (status
 * reclassified; the original state is kept in decision_metrics.beforeNeutralClose). The tracker trigger sends
 * cancel_entry to the trading bot, which closes the exchange position. Closed signals are not touched; signals of
 * the new detection (their version) are never touched. Production only; repeat boots find nothing to do.
 */
export const STEALTH_LEVEL_V1_CLOSE_REASON = "stealth_level_v1_replaced_2026_11_07_neutral_close";

export async function closeOpenStealthLevelV1(): Promise<{ openClosed: number }> {
  if (process.env.NODE_ENV !== "production") return { openClosed: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stealth_level_v1_neutral_close'))");
    const open = (
      await client.query(
        `SELECT id, signal_id, symbol FROM tracked_signals
          WHERE sentiment_key = 'stealth_breakout'
            AND status::text IN ('active', 'in_run')
            AND (decision_metrics #>> '{stealthNeonLevel,version}') IS DISTINCT FROM $1
          ORDER BY id FOR UPDATE`,
        [NEON_RANGE_VERSION],
      )
    ).rows as { id: number; signal_id: number; symbol: string }[];
    let openClosed = 0;
    if (open.length > 0) {
      await client.query(
        `UPDATE tracked_signals
            SET decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
              WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
              ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
                'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
                'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $2::text, 'at', NOW()))
            END
          WHERE id = ANY($1::integer[])`,
        [open.map((r) => r.id), STEALTH_LEVEL_V1_CLOSE_REASON],
      );
      openClosed = await closeGroup(
        client as never,
        open.map((r) => [r.id, r.signal_id, r.symbol, "stealth_breakout"]) as never,
        "stealth_breakout",
        STEALTH_LEVEL_V1_CLOSE_REASON,
      );
    }
    await client.query("COMMIT");
    return { openClosed };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
