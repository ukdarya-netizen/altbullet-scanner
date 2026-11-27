import { pool } from "@workspace/db";

/**
 * Owner 2026-11-27: November Stealth signals that the new rule «breakout close ≥ 12% above the 24 h low
 * (6×4H)» would not have passed leave the statistics (all outcomes). The ids were computed with
 * neonLevelRiseFrom24hLowPct on BingX 4H candles (Replit check 2026-11-27, 36 rows reviewed, 0 CoinGlass):
 * 3753 MAGMA 9.89, 3796 TRUTH 6.49, 3893 AVAAI 11.72, 3938 SKY 10.82, 3964 PENDLE 2.54,
 * 3979 BLUR 11.82, 3981 SIREN 11.52, 4001 GALA 10.10. All are closed; no open row failed the rule.
 * Nothing is deleted: the original outcome stays in decision_metrics.beforeNeutralClose.
 * Marker-guarded → repeat boots are no-ops. Production only.
 */
export const STEALTH_RISE12_REASON = "stealth_neon_level_rise_below_12pct_owner_20261127";
const MARKER = STEALTH_RISE12_REASON;
const IDS = [3753, 3796, 3893, 3938, 3964, 3979, 3981, 4001];

export async function neutralizeStealthRise12Rejects(): Promise<{ skipped?: string; reclassified: number; ids: number[] }> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", reclassified: 0, ids: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stealth_rise12_neutral_close'))");
    const prior = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (prior.rows.length > 0) {
      await client.query("COMMIT");
      return { skipped: "already_applied", reclassified: 0, ids: [] };
    }
    const rows = (
      await client.query(
        `SELECT id, signal_id FROM tracked_signals
          WHERE id = ANY($1::integer[]) AND sentiment_key = 'stealth_breakout'
            AND detected_at >= '2026-11-01 00:00:00'::timestamp
            AND status::text IN ('profit', 'stop_loss', 'bu_stop', 'breakeven', 'expired', 'cancelled')
          ORDER BY id FOR UPDATE`,
        [IDS],
      )
    ).rows as { id: number; signal_id: number }[];
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
                    'reason', $2::text, 'snapshot', to_jsonb(t)))
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
                pending_milestone_lease_until = NULL, updated_at = NOW()
          WHERE t.id = ANY($1::integer[]) AND t.status <> 'reclassified'
        RETURNING t.id`,
        [trackedIds, STEALTH_RISE12_REASON],
      );
      reclassified = updated.rows.length;
      await client.query(
        `UPDATE stealth_breakout_armed_setups
            SET status = 'reclassified', terminal_reason = $2::text, updated_at = NOW()
          WHERE fired_signal_id = ANY($1::integer[]) AND status = 'fired'`,
        [signalIds, STEALTH_RISE12_REASON],
      );
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return { reclassified, ids: trackedIds };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
