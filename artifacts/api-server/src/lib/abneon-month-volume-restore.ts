import { pool } from "@workspace/db";
import { ABNEON_MONTH_VOLUME_CLOSE_REASON } from "./abneon-month-volume-neutral-close.js";

/**
 * Owner 2026-11-12: GRVT and ZEST were closed by mistake by the month-volume one-time close (a wrong filter —
 * the owner asked for Lucy's VSA rule, not 24h vs 30 days). Both go back to the state saved in
 * decision_metrics.beforeNeutralClose (status active / in_run, no exit, no PnL) so the watcher manages them again;
 * the removed backup is kept as decision_metrics.restoredFromWrongClose. The exchange positions are not reopened.
 * Production only, once (marker), only GRVT / ZEST rows still carrying that close reason.
 */
const MARKER = "abneon_month_volume_restore_grvt_zest_20261112";
const SYMBOLS = ["GRVT-USDT", "GRVTUSDT", "ZEST-USDT", "ZESTUSDT"];

export async function restoreGrvtZestAfterMonthVolumeClose(): Promise<{
  skipped?: string;
  restored: { id: number; symbol: string; status: string }[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", restored: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_month_volume_restore'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (done.rows.length > 0) {
      await client.query("ROLLBACK");
      return { skipped: "already_applied", restored: [] };
    }
    const restored = await client.query<{ id: number; symbol: string; status: string }>(
      `UPDATE tracked_signals
          SET status = (decision_metrics #>> '{beforeNeutralClose,status}')::tracked_status,
              cancel_reason = NULL,
              decision_metrics = (decision_metrics - 'beforeNeutralClose')
                || jsonb_build_object('restoredFromWrongClose', decision_metrics -> 'beforeNeutralClose',
                                      'restoredAt', NOW()),
              updated_at = NOW()
        WHERE symbol = ANY($1::text[])
          AND sentiment_key = 'neon_support_bounce'
          AND status::text = 'reclassified'
          AND cancel_reason = $2
          AND decision_metrics #>> '{beforeNeutralClose,status}' IN ('active', 'in_run')
        RETURNING id, symbol, status::text AS status`,
      [SYMBOLS, ABNEON_MONTH_VOLUME_CLOSE_REASON],
    );
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return { restored: restored.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
