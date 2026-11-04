import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export const STEALTH_ONE_HOUR_RECLASSIFICATION_REASON =
  "stealth_1h_confirmation_reclassified";

// Exact production lineage of the reviewed September 21–23 signals. Source
// signals and frozen ARMED evidence stay intact for audit and deduplication.
export const STEALTH_ONE_HOUR_RECLASSIFICATION_TARGETS = [
  [1745, 6374, 2507, "SPX-USDT"],
  [1750, 6400, 2525, "A-USDT"],
  [1754, 6434, 2530, "NXPC-USDT"],
  [1756, 6444, 2540, "CVX-USDT"],
  [1760, 6476, 2493, "RIF-USDT"],
  [1774, 7628, 2925, "BEAT-USDT"],
  [1785, 7970, 2965, "BANANA-USDT"],
  [1790, 8058, 3013, "KAITO-USDT"],
  [1791, 8088, 3015, "BERA-USDT"],
  [1792, 8224, 3104, "RE-USDT"],
  [1793, 8288, 2854, "AAVE-USDT"],
  [1795, 8422, 2903, "F-USDT"],
  [1796, 8424, 3011, "BASED-USDT"],
  [1798, 8446, 3150, "NEIROCTO-USDT"],
  [1799, 8452, 2905, "EUL-USDT"],
  [1800, 8472, 3173, "BIRB-USDT"],
  [1803, 8632, 3222, "OPN-USDT"],
] as const;

/**
 * One-time production correction. All 17 tracker/signal/arm identities must
 * match before any row changes; partial/mismatched states stop startup rather
 * than silently neutralizing an arbitrary subset of positions.
 */
export async function reclassifyReviewedStealthOneHourFailures(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('stealth_1h_reviewed_reclassification_20260923'))`,
    );
    await tx.execute(sql`
      CREATE TEMP TABLE startup_stealth_1h_reviewed_targets (
        tracked_id integer PRIMARY KEY,
        signal_id integer NOT NULL UNIQUE,
        arm_id integer NOT NULL UNIQUE,
        symbol text NOT NULL
      ) ON COMMIT DROP
    `);
    await tx.execute(sql`
      INSERT INTO startup_stealth_1h_reviewed_targets
        (tracked_id, signal_id, arm_id, symbol)
      VALUES ${sql.join(
        STEALTH_ONE_HOUR_RECLASSIFICATION_TARGETS.map(
          ([trackedId, signalId, armId, symbol]) =>
            sql`(${trackedId}, ${signalId}, ${armId}, ${symbol})`,
        ),
        sql`, `,
      )}
    `);
    const locked = await tx.execute(sql`
      SELECT t.id, t.status::text AS status, t.cancel_reason,
             t.runner_state, t.core_closed_at, a.status AS arm_status,
             a.terminal_reason
        FROM startup_stealth_1h_reviewed_targets x
        JOIN tracked_signals t
          ON t.id = x.tracked_id
         AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol
         AND t.sentiment_key = 'stealth_breakout'
        JOIN signals s
          ON s.id = x.signal_id
         AND s.symbol = x.symbol
         AND s.sentiment_key = 'stealth_breakout'
        JOIN stealth_breakout_armed_setups a
          ON a.id = x.arm_id
         AND a.fired_signal_id = x.signal_id
         AND a.symbol = x.symbol
       FOR UPDATE OF t, s, a
    `);
    const rows = locked.rows as Array<{
      status: string;
      cancel_reason: string | null;
      runner_state: string | null;
      core_closed_at: Date | null;
      arm_status: string;
      terminal_reason: string | null;
    }>;
    if (rows.length !== STEALTH_ONE_HOUR_RECLASSIFICATION_TARGETS.length) {
      throw new Error(
        `Stealth 1H review: expected 17 exact tracker/signal/arm matches, found ${rows.length}`,
      );
    }
    const reason = STEALTH_ONE_HOUR_RECLASSIFICATION_REASON;
    if (
      rows.every(
        (row) =>
          row.status === "reclassified" &&
          row.cancel_reason === reason &&
          row.arm_status === "reclassified" &&
          row.terminal_reason === reason,
      )
    ) {
      return 0;
    }
    if (
      rows.some(
        (row) =>
          row.status === "reclassified" ||
          row.arm_status !== "fired" ||
          (row.runner_state === "open" && row.core_closed_at != null),
      )
    ) {
      throw new Error("Stealth 1H review: mixed or unsafe target state");
    }

    const tracked = await tx.execute(sql`
      UPDATE tracked_signals t
         SET status = 'reclassified',
             cancel_reason = ${reason},
             exit_price = NULL,
             pnl_percent = NULL,
             closed_at = NULL,
             trailing_stop_level = NULL,
             last_smart_cancel_check_at = NULL,
             updated_at = NOW()
        FROM startup_stealth_1h_reviewed_targets x
       WHERE t.id = x.tracked_id
         AND t.signal_id = x.signal_id
         AND t.symbol = x.symbol
         AND t.sentiment_key = 'stealth_breakout'
      RETURNING t.id
    `);
    if (tracked.rows.length !== rows.length) {
      throw new Error("Stealth 1H review: tracker update was incomplete");
    }
    const arms = await tx.execute(sql`
      UPDATE stealth_breakout_armed_setups a
         SET status = 'reclassified',
             terminal_reason = ${reason},
             updated_at = NOW()
        FROM startup_stealth_1h_reviewed_targets x
       WHERE a.id = x.arm_id
         AND a.fired_signal_id = x.signal_id
         AND a.symbol = x.symbol
         AND a.status = 'fired'
      RETURNING a.id
    `);
    if (arms.rows.length !== rows.length) {
      throw new Error("Stealth 1H review: ARMED update was incomplete");
    }

    // Prevent unsent milestones and alerts from being delivered for positions
    // that are no longer trades. Preserve delivered and ambiguous audit rows.
    await tx.execute(sql`
      UPDATE milestone_notification_deliveries d
         SET status = 'abandoned',
             lease_until = NULL,
             claim_token = NULL,
             last_error = ${reason}
       WHERE d.tracked_signal_id IN (
         SELECT tracked_id FROM startup_stealth_1h_reviewed_targets
       )
         AND d.status IN ('ready', 'failed')
    `);
    await tx.execute(sql`
      UPDATE telegram_photo_deliveries p
         SET status = 'abandoned',
             lease_until = NULL,
             claim_token = NULL,
             last_error = ${reason},
             updated_at = NOW()
       WHERE p.status IN ('ready', 'failed')
         AND EXISTS (
           SELECT 1 FROM startup_stealth_1h_reviewed_targets x
            WHERE p.dedup_key = 'signal:' || x.signal_id::text
               OR p.dedup_key LIKE 'position:' || x.tracked_id::text || ':%'
               OR p.dedup_key LIKE 'milestone:v3:' || x.tracked_id::text || ':%'
         )
    `);
    return rows.length;
  });
}
