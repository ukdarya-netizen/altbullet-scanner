import { pool } from "@workspace/db";

/**
 * Owner request on 2026-11-10: neutralize every non-neutralized Stealth signal
 * detected or closed during Dubai November 2026.
 * This is a one-time tracker/statistics change; it does not close exchange
 * positions. Open-row status changes enqueue cancel_entry + position_review.
 */
export const STEALTH_NEUTRAL_CLOSE_MONTH = "2026-11";
export const STEALTH_NEUTRAL_CLOSE_REASON =
  "stealth_owner_neutral_close_2026_11";
export const STEALTH_NEUTRAL_CLOSE_MARKER =
  "stealth_owner_neutral_close_2026_11";

const DUBAI_NOVEMBER_START_UTC = "2026-10-31 20:00:00";
const DUBAI_DECEMBER_START_UTC = "2026-11-30 20:00:00";

export type StealthMonthNeutralCloseResult = {
  skipped?: string;
  month: string;
  reviewed: number;
  reclassified: number;
  openAtReview: number;
};

export async function neutralizeStealthNovemberPositions(): Promise<StealthMonthNeutralCloseResult> {
  if (process.env.NODE_ENV !== "production") {
    return {
      skipped: "not_production",
      month: STEALTH_NEUTRAL_CLOSE_MONTH,
      reviewed: 0,
      reclassified: 0,
      openAtReview: 0,
    };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stealth_november_neutral_close'))",
    );

    const markerTable = await client.query(
      "SELECT to_regclass('public.neon_recalc_markers') IS NOT NULL AS present",
    );
    if (markerTable.rows[0]?.present !== true) {
      await client.query("COMMIT");
      return {
        skipped: "marker_table_missing",
        month: STEALTH_NEUTRAL_CLOSE_MONTH,
        reviewed: 0,
        reclassified: 0,
        openAtReview: 0,
      };
    }

    const prior = await client.query(
      "SELECT 1 FROM neon_recalc_markers WHERE name = $1",
      [STEALTH_NEUTRAL_CLOSE_MARKER],
    );
    if (prior.rows.length > 0) {
      await client.query("COMMIT");
      return {
        skipped: "already_applied",
        month: STEALTH_NEUTRAL_CLOSE_MONTH,
        reviewed: 0,
        reclassified: 0,
        openAtReview: 0,
      };
    }

    const locked = await client.query(
      `SELECT id, signal_id, status::text AS status
         FROM tracked_signals
        WHERE sentiment_key = 'stealth_breakout'
          AND status <> 'reclassified'
          AND (
            (
              detected_at >= $1::timestamp
              AND detected_at < $2::timestamp
            )
            OR (
              closed_at >= $1::timestamp
              AND closed_at < $2::timestamp
            )
          )
        ORDER BY id
        FOR UPDATE`,
      [DUBAI_NOVEMBER_START_UTC, DUBAI_DECEMBER_START_UTC],
    );
    const rows = locked.rows as {
      id: number;
      signal_id: number;
      status: string;
    }[];
    const trackedIds = rows.map((row) => row.id);
    const signalIds = rows.map((row) => row.signal_id);
    let reclassified = 0;

    if (trackedIds.length > 0) {
      const updated = await client.query(
        `UPDATE tracked_signals AS t
            SET decision_metrics = CASE
                  WHEN COALESCE(t.decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose'
                    THEN t.decision_metrics
                  ELSE COALESCE(t.decision_metrics, '{}'::jsonb)
                    || jsonb_build_object(
                      'beforeNeutralClose',
                      jsonb_build_object(
                        'status', t.status::text,
                        'pnlPercent', t.pnl_percent,
                        'exitPrice', t.exit_price,
                        'closedAt', t.closed_at,
                        'peakPrice', t.peak_price,
                        'cancelReason', t.cancel_reason,
                        'corePnlPercent', t.core_pnl_percent,
                        'coreExitPrice', t.core_exit_price,
                        'coreClosedAt', t.core_closed_at,
                        'runnerState', t.runner_state,
                        'runnerPnlPercent', t.runner_pnl_percent,
                        'runnerExitPrice', t.runner_exit_price,
                        'runnerClosedAt', t.runner_closed_at,
                        'reason', $2::text,
                        'snapshot', to_jsonb(t)
                      )
                    )
                END,
                status = 'reclassified',
                cancel_reason = $2::text,
                exit_price = NULL,
                pnl_percent = NULL,
                closed_at = NULL,
                trailing_stop_level = NULL,
                trailing_stop_armed_at = NULL,
                last_smart_cancel_check_at = NULL,
                core_closed_at = NULL,
                core_exit_price = NULL,
                core_pnl_percent = NULL,
                core_close_event_key = NULL,
                runner_state = NULL,
                runner_peak_price = NULL,
                runner_trailing_stop_level = NULL,
                runner_trailing_stop_armed_at = NULL,
                runner_exit_price = NULL,
                runner_pnl_percent = NULL,
                runner_closed_at = NULL,
                runner_close_event_key = NULL,
                pending_milestone = NULL,
                pending_milestone_kind = NULL,
                pending_milestone_price = NULL,
                pending_milestone_trailing_stop = NULL,
                pending_milestone_status = NULL,
                pending_milestone_lease_until = NULL,
                updated_at = NOW()
          WHERE t.id = ANY($1::integer[])
            AND t.status <> 'reclassified'
        RETURNING t.id`,
        [trackedIds, STEALTH_NEUTRAL_CLOSE_REASON],
      );
      reclassified = updated.rows.length;

      await client.query(
        `UPDATE stealth_breakout_armed_setups
            SET status = 'reclassified', terminal_reason = $2::text, updated_at = NOW()
          WHERE fired_signal_id = ANY($1::integer[]) AND status = 'fired'`,
        [signalIds, STEALTH_NEUTRAL_CLOSE_REASON],
      );
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
                last_error = $2::text
          WHERE tracked_signal_id = ANY($1::integer[])
            AND status IN ('ready', 'retry', 'failed')`,
        [trackedIds, STEALTH_NEUTRAL_CLOSE_REASON],
      );
      await client.query(
        `WITH abandoned AS (
           UPDATE telegram_photo_deliveries p
              SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
                   last_error = $3::text, updated_at = NOW()
            WHERE (p.status IN ('ready', 'retry', 'failed')
                   OR (p.status = 'processing' AND p.send_attempted_at IS NULL))
              AND EXISTS (
                SELECT 1 FROM unnest($1::integer[], $2::integer[])
                  AS x(tracked_id, signal_id)
                 WHERE p.dedup_key = 'signal:' || x.signal_id::text
                    OR p.dedup_key LIKE 'position:' || x.tracked_id::text || ':%'
                    OR p.dedup_key LIKE 'milestone:v3:' || x.tracked_id::text || ':%'
              )
           RETURNING p.dedup_key
         )
         UPDATE telegram_delivery_events e
            SET status = 'attention',
                attention_at = COALESCE(e.attention_at, NOW()),
                last_error = $3, updated_at = NOW()
          WHERE e.event_key IN (SELECT dedup_key FROM abandoned)
            AND e.status <> 'delivered'`,
        [trackedIds, signalIds, STEALTH_NEUTRAL_CLOSE_REASON],
      );

      const relayTable = await client.query(
        "SELECT to_regclass('public.trading_signal_deliveries') AS relation",
      );
      if (relayTable.rows[0]?.relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
                  last_error = $2::text
            WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
          [signalIds, STEALTH_NEUTRAL_CLOSE_REASON],
        );
      }
    }

    await client.query(
      "INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING",
      [STEALTH_NEUTRAL_CLOSE_MARKER],
    );
    await client.query("COMMIT");
    return {
      month: STEALTH_NEUTRAL_CLOSE_MONTH,
      reviewed: rows.length,
      reclassified,
      openAtReview: rows.filter(
        (row) => row.status === "active" || row.status === "in_run",
      ).length,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
