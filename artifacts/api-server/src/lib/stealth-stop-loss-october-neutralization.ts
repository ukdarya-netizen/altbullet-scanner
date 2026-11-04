import { pool } from "@workspace/db";

/**
 * Owner 2026-10-28: Stealth stop losses closed in October 2026 (Dubai close
 * month) leave the main PnL statistics. In history they stay as `cancelled`
 * rows with neutral PnL (no exit fill, no PnL). Exact production ids reviewed
 * on 2026-10-28 (status stop_loss, sentiment_key stealth_breakout, closed from
 * 2026-09-30 20:00 UTC); later stop losses are not touched. Original rows are
 * kept as JSON in stealth_stop_loss_october_backup; nothing is deleted.
 */
export const STEALTH_STOP_LOSS_OCTOBER_REASON =
  "stealth_stop_loss_october_removed_from_statistics";

export const STEALTH_STOP_LOSS_OCTOBER_IDS = [
  2288, 2290, 2295, 2307, 2430, 2480, 2506, 2465, 2512, 2528, 2739, 2743, 2728,
  2788, 2798, 2810, 2613, 2814, 2811, 2616, 2842, 2634, 2838, 2858, 2812, 2843,
  2860, 2795, 2791, 2792, 2793, 2806, 2813, 2933, 2819,
] as const;

const OCTOBER_START_UTC = "2026-09-30T20:00:00Z";

export async function neutralizeStealthOctoberStopLosses(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stealth_stop_loss_october_neutralization'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS stealth_stop_loss_october_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      neutralized_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...STEALTH_STOP_LOSS_OCTOBER_IDS];
    await client.query(
      `INSERT INTO stealth_stop_loss_october_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
          AND t.sentiment_key = 'stealth_breakout'
          AND t.status = 'stop_loss'
          AND t.closed_at >= $2::timestamptz
       ON CONFLICT (tracked_id) DO NOTHING`,
      [ids, OCTOBER_START_UTC],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'cancelled', cancel_reason = $3,
              exit_price = NULL, pnl_percent = NULL,
              updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'stealth_breakout'
          AND status = 'stop_loss'
          AND closed_at >= $2::timestamptz
        RETURNING id`,
      [ids, OCTOBER_START_UTC, STEALTH_STOP_LOSS_OCTOBER_REASON],
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
