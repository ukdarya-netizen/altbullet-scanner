import { pool } from "@workspace/db";

/**
 * Owner order 2026-11-12 (one-time action, with the new LC detection-candle rule): every Liquidation Cascade
 * signal of Dubai November 2026 EXCEPT BTC leaves the statistics (status 'reclassified', no exit, no PnL);
 * the open LC positions (any date, except BTC) are closed neutrally — the tracker trigger sends cancel_entry
 * to the trading bot. The original outcome is kept in decision_metrics.beforeNeutralClose.
 *
 * It can never repeat (the Stealth lesson of 2026-11-11):
 *   1) marker lc_owner_neutral_close_2026_11 — after the first run every start does nothing;
 *   2) only rows detected before LC_NEUTRAL_CLOSE_CUTOFF_UTC — signals of the new rule are never selected,
 *      even if the marker were lost.
 * Production only.
 */
export const LC_NEUTRAL_CLOSE_REASON = "lc_owner_neutral_close_2026_11";
const MARKER = "lc_owner_neutral_close_2026_11";
const DUBAI_NOVEMBER_START_UTC = "2026-10-31 20:00:00+00";
/** Hard upper bound: nothing detected after this moment is ever touched. */
export const LC_NEUTRAL_CLOSE_CUTOFF_UTC = "2026-11-13 00:00:00+00";

export async function runLcMonthNeutralClose(): Promise<{
  skipped?: string;
  reviewed: number;
  reclassified: number;
  openAtReview: number;
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", reviewed: 0, reclassified: 0, openAtReview: 0 };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('lc_month_neutral_close'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (done.rows.length > 0) {
      await client.query("COMMIT");
      return { skipped: "already_applied", reviewed: 0, reclassified: 0, openAtReview: 0 };
    }
    const locked = await client.query<{ id: number; signal_id: number; status: string }>(
      `SELECT id, signal_id, status::text AS status
         FROM tracked_signals
        WHERE sentiment_key = 'liquidation_cascade'
          AND symbol NOT IN ('BTC-USDT', 'BTCUSDT')
          AND status::text <> 'reclassified'
          AND detected_at < $2::timestamptz
          AND (detected_at >= $1::timestamptz OR status::text IN ('active', 'in_run'))
        ORDER BY id
        FOR UPDATE`,
      [DUBAI_NOVEMBER_START_UTC, LC_NEUTRAL_CLOSE_CUTOFF_UTC],
    );
    const rows = locked.rows;
    const trackedIds = rows.map((r) => r.id);
    const signalIds = rows.map((r) => r.signal_id);
    let reclassified = 0;
    if (trackedIds.length > 0) {
      const updated = await client.query(
        `UPDATE tracked_signals AS t
            SET decision_metrics = CASE
                  WHEN COALESCE(t.decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN t.decision_metrics
                  ELSE COALESCE(t.decision_metrics, '{}'::jsonb) || jsonb_build_object('beforeNeutralClose', jsonb_build_object(
                    'status', t.status::text, 'pnlPercent', t.pnl_percent, 'exitPrice', t.exit_price,
                    'closedAt', t.closed_at, 'peakPrice', t.peak_price, 'cancelReason', t.cancel_reason,
                    'corePnlPercent', t.core_pnl_percent, 'coreExitPrice', t.core_exit_price, 'coreClosedAt', t.core_closed_at,
                    'runnerState', t.runner_state, 'runnerPnlPercent', t.runner_pnl_percent,
                    'runnerExitPrice', t.runner_exit_price, 'runnerClosedAt', t.runner_closed_at,
                    'reason', $2::text, 'at', NOW()))
                END,
                status = 'reclassified', cancel_reason = $2::text,
                exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
                trailing_stop_level = NULL, trailing_stop_armed_at = NULL, last_smart_cancel_check_at = NULL,
                core_closed_at = NULL, core_exit_price = NULL, core_pnl_percent = NULL, core_close_event_key = NULL,
                runner_state = NULL, runner_peak_price = NULL, runner_trailing_stop_level = NULL,
                runner_trailing_stop_armed_at = NULL, runner_exit_price = NULL, runner_pnl_percent = NULL,
                runner_closed_at = NULL, runner_close_event_key = NULL,
                pending_milestone = NULL, pending_milestone_kind = NULL, pending_milestone_price = NULL,
                pending_milestone_trailing_stop = NULL, pending_milestone_status = NULL,
                pending_milestone_lease_until = NULL,
                updated_at = NOW()
          WHERE t.id = ANY($1::integer[]) AND t.status::text <> 'reclassified'
        RETURNING t.id`,
        [trackedIds, LC_NEUTRAL_CLOSE_REASON],
      );
      reclassified = updated.rows.length;
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2::text
          WHERE tracked_signal_id = ANY($1::integer[]) AND status IN ('ready', 'retry', 'failed')`,
        [trackedIds, LC_NEUTRAL_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('public.trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2::text
            WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
          [signalIds, LC_NEUTRAL_CLOSE_REASON],
        );
      }
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return {
      reviewed: rows.length,
      reclassified,
      openAtReview: rows.filter((r) => r.status === "active" || r.status === "in_run").length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
