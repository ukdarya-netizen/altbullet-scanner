import { pool } from "@workspace/db";

/**
 * Owner order 2026-11-07: remove the November 2026 ABNeon stop losses from the statistics.
 * Exact reviewed rows only (abneon_gate_review, status stop_loss). Each row is copied to
 * abneon_nov_stops_backup first (full original row, so it can be restored), then reclassified:
 * no exit price, no PnL, excluded from outcomes. The rows were already closed, so no trading
 * command is sent. Production only; idempotent (only rows still in stop_loss are touched).
 */
export const ABNEON_NOV_STOPS_REASON = "abneon_nov_2026_stop_excluded_by_owner";
export const ABNEON_NOV_STOPS_TRACKED_IDS = [
  3052, 3054, 3055, 3056, 3064, 3065, 3104, 3107, 3234, 3297, 3299, 3361,
] as const;

export async function excludeAbneonNovemberStops(): Promise<{ moved: number }> {
  if (process.env.NODE_ENV !== "production") return { moved: 0 };
  const ids = [...ABNEON_NOV_STOPS_TRACKED_IDS];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_nov_stops_neutral'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS abneon_nov_stops_backup (LIKE tracked_signals INCLUDING DEFAULTS)",
    );
    await client.query(
      `INSERT INTO abneon_nov_stops_backup
       SELECT * FROM tracked_signals t
        WHERE t.id = ANY($1::integer[]) AND t.sentiment_key = 'neon_support_bounce' AND t.status = 'stop_loss'
          AND NOT EXISTS (SELECT 1 FROM abneon_nov_stops_backup b WHERE b.id = t.id)`,
      [ids],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'neon_support_bounce'
          AND status = 'stop_loss'
        RETURNING id`,
      [ids, ABNEON_NOV_STOPS_REASON],
    );
    await client.query("COMMIT");
    return { moved: updated.rows.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
