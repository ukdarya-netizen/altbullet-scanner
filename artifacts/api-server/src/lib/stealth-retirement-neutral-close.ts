import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner 2026-11-06: the old Stealth (Range / quiet-zone / fresh-high / ABNeon-arm detections) is retired —
 * there is no difference between its good and bad signals. Stealth is rebuilt as the breakout of Neon
 * resistance levels on closed 4H / 1D candles (lib/stealth-neon-level-breakout.ts).
 *  - every open old-Stealth position is closed neutrally: no exit fill, no PnL, outside the statistics;
 *  - every old-Stealth signal of November that already closed leaves the statistics and the page PnL
 *    (status reclassified). Its original outcome is kept in decision_metrics.beforeNeutralClose.
 * New-detector signals (their own detection methods) are never touched. Rows are never deleted.
 */
export const STEALTH_RETIREMENT_CLOSE_REASON = "stealth_retired_2026_11_06_neutral_close";
export const NEW_STEALTH_METHODS = ["neon_level_4h_breakout", "neon_level_1d_breakout"] as const;
/** November in UTC, like the statistics page. */
export const STEALTH_NOVEMBER_FROM = "2026-11-01T00:00:00Z";

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

const OLD_STEALTH = `sentiment_key = 'stealth_breakout'
  AND (stealth_detection_method IS NULL OR stealth_detection_method <> ALL($1::text[]))`;

/** Keeps the original outcome before the row is neutralized (first value wins). */
const KEEP_ORIGINAL = `decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
    WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
    ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
      'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
      'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $2::text, 'at', NOW()))
  END`;

export async function retireOldStealthInTransaction(client: QueryClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('stealth_retirement_neutral_close'))");
  const methods = [...NEW_STEALTH_METHODS];
  // 1) November closed signals leave the statistics.
  const closed = await client.query(
    `UPDATE tracked_signals
        SET ${KEEP_ORIGINAL},
            status = 'reclassified', cancel_reason = $2,
            exit_price = NULL, pnl_percent = NULL, closed_at = NULL, updated_at = NOW()
      WHERE ${OLD_STEALTH}
        AND detected_at >= $3::timestamptz
        AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'breakeven')
      RETURNING id`,
    [methods, STEALTH_RETIREMENT_CLOSE_REASON, STEALTH_NOVEMBER_FROM],
  );
  // 2) Open positions are closed neutrally (all of them, whatever the month).
  const open = (await client.query(
    `SELECT id, signal_id, symbol FROM tracked_signals
      WHERE ${OLD_STEALTH} AND status::text IN ('active', 'in_run')
      ORDER BY id FOR UPDATE`,
    [methods],
  )).rows as { id: number; signal_id: number; symbol: string }[];
  let openClosed = 0;
  if (open.length > 0) {
    await client.query(
      `UPDATE tracked_signals SET ${KEEP_ORIGINAL} WHERE id = ANY($3::integer[]) AND $1::text[] IS NOT NULL`,
      [methods, STEALTH_RETIREMENT_CLOSE_REASON, open.map((r) => r.id)],
    );
    openClosed = await closeGroup(
      client,
      open.map((r) => [r.id, r.signal_id, r.symbol, "stealth_breakout"]) as never,
      "stealth_breakout",
      STEALTH_RETIREMENT_CLOSE_REASON,
    );
  }
  return { novemberClosedRemoved: closed.rows.length, openClosed };
}

/** Production boot only; already reclassified rows are skipped, so repeat boots are no-ops. */
export async function retireOldStealthSignals() {
  if (process.env.NODE_ENV !== "production") return { novemberClosedRemoved: 0, openClosed: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const res = await retireOldStealthInTransaction(client);
    await client.query("COMMIT");
    return res;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
