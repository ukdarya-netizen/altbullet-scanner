import { pool } from "@workspace/db";

/**
 * Owner 2026-10-29: after this publish every Stealth position that is open
 * right now is closed without affecting statistics. Open at review time:
 * 2871, 2912, 2945 (no realized core/runner part). The cut-off is the highest
 * open id, so Stealth signals fired after the review are never touched.
 * Rows get status `cancelled` with neutral PnL; originals are kept as JSON in
 * stealth_publish_close_backup.
 */
export const STEALTH_PUBLISH_CLOSE_REASON = "stealth_owner_neutral_close_2026_10_29";
export const STEALTH_PUBLISH_CLOSE_MAX_TRACKED_ID = 2945;

export async function neutralizeStealthOnPublish(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stealth_publish_neutral_close'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS stealth_publish_close_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      neutralized_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      `INSERT INTO stealth_publish_close_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id <= $1 AND t.sentiment_key = 'stealth_breakout'
          AND t.status IN ('active', 'in_run')
       ON CONFLICT (tracked_id) DO NOTHING`,
      [STEALTH_PUBLISH_CLOSE_MAX_TRACKED_ID],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'cancelled', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL,
              closed_at = NOW(), updated_at = NOW()
        WHERE id <= $1 AND sentiment_key = 'stealth_breakout'
          AND status IN ('active', 'in_run')
        RETURNING id`,
      [STEALTH_PUBLISH_CLOSE_MAX_TRACKED_ID, STEALTH_PUBLISH_CLOSE_REASON],
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
