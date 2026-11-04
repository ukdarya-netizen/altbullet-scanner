import { pool } from "@workspace/db";

/**
 * Owner 2026-10-28: ABNeon (neon_support_bounce) stop losses closed in October
 * 2026 (Dubai close month) up to 2026-10-28 leave the statistics. Exact
 * production ids reviewed on 2026-10-28; rows are never deleted: they become
 * neutral `reclassified` rows (no exit fill, no PnL) and the original row is
 * kept as JSON in neon_stop_loss_october_backup. Later stop losses are not
 * touched.
 */
export const NEON_STOP_LOSS_OCTOBER_REASON =
  "neon_stop_loss_october_removed_from_statistics";

export const NEON_STOP_LOSS_OCTOBER_IDS = [
  2765, 2784, 2789, 2794, 2797, 2807, 2808, 2839, 2841, 2844, 2845, 2861, 2866,
] as const;

export async function reclassifyNeonOctoberStopLosses(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_stop_loss_october_reclassification'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS neon_stop_loss_october_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      reclassified_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...NEON_STOP_LOSS_OCTOBER_IDS];
    await client.query(
      `INSERT INTO neon_stop_loss_october_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
          AND t.sentiment_key = 'neon_support_bounce'
          AND t.status = 'stop_loss'
       ON CONFLICT (tracked_id) DO NOTHING`,
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
      [ids, NEON_STOP_LOSS_OCTOBER_REASON],
    );
    await client.query("COMMIT");
    return updated.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
