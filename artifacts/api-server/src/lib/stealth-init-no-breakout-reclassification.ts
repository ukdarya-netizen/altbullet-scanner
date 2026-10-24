import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

export const STEALTH_INIT_NO_BREAKOUT_REASON =
  "stealth_owner_no_breakout_2026_10_11";

const TARGET = { trackedId: 2312, signalId: 18237, armId: 34470 } as const;
const SYMBOL = "INIT-USDT";

/**
 * One-time owner correction 2026-10-11: INIT entered from a narrow 1H Range
 * nested inside a wider Range on the owner's chart; no real breakout happened.
 * Neutralize the position (no PnL/exit, outside statistics). The arm becomes
 * terminal so it cannot fire again. Any mismatch leaves everything untouched.
 */
export async function reclassifyOwnerReviewedInitNoBreakout(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const reason = STEALTH_INIT_NO_BREAKOUT_REASON;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('stealth_init_no_breakout_20261011'))`,
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
      row.core_closed_at != null ||
      row.runner_state != null
    ) {
      logger.info(
        { found: Boolean(row), status: row?.status ?? null },
        "Stealth INIT no-breakout correction skipped",
      );
      return 0;
    }
    await tx.execute(sql`
      UPDATE tracked_signals
         SET status = 'reclassified', cancel_reason = ${reason},
             exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
             trailing_stop_level = NULL, last_smart_cancel_check_at = NULL,
             updated_at = NOW()
       WHERE id = ${TARGET.trackedId}
    `);
    await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups
         SET status = 'reclassified', terminal_reason = ${reason},
             updated_at = NOW()
       WHERE id = ${TARGET.armId} AND status = 'fired'
    `);
    await tx.execute(sql`
      UPDATE milestone_notification_deliveries
         SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
             last_error = ${reason}
       WHERE tracked_signal_id = ${TARGET.trackedId}
         AND status IN ('ready', 'failed')
    `);
    return 1;
  });
}
