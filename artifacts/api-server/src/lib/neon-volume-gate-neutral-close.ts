import { pool } from "@workspace/db";

export const NEON_VOLUME_GATE_NEUTRAL_CLOSE_REASON =
  "neon_volume_gate_4x_neutral_close";

// Owner order 2026-10-22: Neon reaction volume must be >= 4x. These open Neon
// positions fired with 1.5x-3.2x (aggregated) and would not pass the new gate.
export const NEON_VOLUME_GATE_NEUTRAL_CLOSE_TRACKED_IDS = [
  2738, 2742, 2744, 2746, 2748, 2749, 2750, 2751, 2752, 2753, 2756, 2757,
] as const;

/**
 * Neutral (no PnL, no outcome) reclassification of exact reviewed positions.
 * Only still-open Neon rows are touched; already-closed outcomes are kept.
 */
export async function neutralizeNeonVolumeGateSignals(): Promise<{
  moved: number;
}> {
  if (process.env.NODE_ENV !== "production") return { moved: 0 };
  const ids = [...NEON_VOLUME_GATE_NEUTRAL_CLOSE_TRACKED_IDS];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_volume_gate_neutral_close'))",
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
              last_smart_cancel_check_at = NULL,
              pending_milestone = NULL, pending_milestone_kind = NULL,
              pending_milestone_price = NULL,
              pending_milestone_trailing_stop = NULL,
              pending_milestone_status = NULL,
              pending_milestone_lease_until = NULL,
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'neon_support_bounce'
          AND status IN ('active', 'in_run')
        RETURNING id, signal_id`,
      [ids, NEON_VOLUME_GATE_NEUTRAL_CLOSE_REASON],
    );
    const trackedIds = updated.rows.map((r: { id: number }) => r.id);
    const signalIds = updated.rows.map(
      (r: { signal_id: number }) => r.signal_id,
    );
    if (trackedIds.length > 0) {
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
                last_error = $2
          WHERE tracked_signal_id = ANY($1::integer[])
            AND status IN ('ready', 'retry', 'failed')`,
        [trackedIds, NEON_VOLUME_GATE_NEUTRAL_CLOSE_REASON],
      );
      const relay = await client.query(
        "SELECT to_regclass('trading_signal_deliveries') AS relation",
      );
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
                  last_error = $2
            WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
          [signalIds, NEON_VOLUME_GATE_NEUTRAL_CLOSE_REASON],
        );
      }
    }
    await client.query("COMMIT");
    return { moved: trackedIds.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
