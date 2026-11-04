import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

export const STEALTH_INSIDE_RANGE_RECLASSIFICATION_REASON =
  "stealth_1h_inside_wider_range_reclassified";

// Reviewed 2026-10-02 production lineage: CFX fired from a narrow 1H Auto Range
// whose close never cleared the wider range it sat inside.
const TARGET = { trackedId: 2098, signalId: 17146, armId: 7231 } as const;
const SYMBOL = "CFX-USDT";

/**
 * One-time correction: neutralize the false CFX entry (no outcome/PnL) and put
 * its frozen ARMED setup back to waiting. Any mismatch (already closed, already
 * corrected, different lineage) leaves everything untouched.
 */
export async function reclassifyReviewedStealthInsideRangeEntry(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const reason = STEALTH_INSIDE_RANGE_RECLASSIFICATION_REASON;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('stealth_cfx_inside_range_20261002'))`,
    );
    const locked = await tx.execute(sql`
      SELECT t.status::text AS status, t.runner_state, t.core_closed_at,
             a.status AS arm_status
        FROM tracked_signals t
        JOIN stealth_breakout_armed_setups a
          ON a.id = ${TARGET.armId}
         AND a.fired_signal_id = ${TARGET.signalId}
         AND a.symbol = ${SYMBOL}
       WHERE t.id = ${TARGET.trackedId}
         AND t.signal_id = ${TARGET.signalId}
         AND t.symbol = ${SYMBOL}
         AND t.sentiment_key = 'stealth_breakout'
       FOR UPDATE OF t, a
    `);
    const row = locked.rows[0] as
      | {
          status: string;
          runner_state: string | null;
          core_closed_at: Date | null;
          arm_status: string;
        }
      | undefined;
    if (
      !row ||
      row.arm_status !== "fired" ||
      !["active", "in_run"].includes(row.status) ||
      (row.runner_state === "open" && row.core_closed_at != null)
    ) {
      logger.info(
        { found: Boolean(row), status: row?.status ?? null },
        "Stealth CFX inside-range correction skipped",
      );
      return 0;
    }

    await tx.execute(sql`
      UPDATE tracked_signals
         SET status = 'reclassified',
             cancel_reason = ${reason},
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE id = ${TARGET.trackedId}
    `);
    await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
         SET status = 'armed',
             fired_at = NULL,
             fired_signal_id = NULL,
             fire_claimed_at = NULL,
             first_cross_at = NULL,
             terminal_reason = NULL,
             decision_at = now(),
             decision_json = COALESCE(decision_json, '{}'::jsonb) ||
               jsonb_build_object(
                 'status', 'armed',
                 'reason', 'awaiting_later_1h_auto_range_breakout',
                 'correction', ${reason}::text
               ),
             updated_at = NOW()
       WHERE id = ${TARGET.armId}
         AND status = 'fired'
    `);
    await tx.execute(sql`
      UPDATE milestone_notification_deliveries
         SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
             last_error = ${reason}
       WHERE tracked_signal_id = ${TARGET.trackedId}
         AND status IN ('ready', 'failed')
    `);
    await tx.execute(sql`
      UPDATE telegram_photo_deliveries
         SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
             last_error = ${reason}, updated_at = NOW()
       WHERE status IN ('ready', 'failed')
         AND (dedup_key = ${"signal:" + TARGET.signalId}
              OR dedup_key LIKE ${"position:" + TARGET.trackedId + ":%"}
              OR dedup_key LIKE ${"milestone:v3:" + TARGET.trackedId + ":%"})
    `);
    return 1;
  });
}
