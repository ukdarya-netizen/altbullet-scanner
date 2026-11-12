import { pool } from "@workspace/db";
import { ABNEON_R8_CLOSE_REASON } from "./abneon-r8-neutral-close.js";

/**
 * Owner 2026-11-12 ("Верни"): the R8 one-time close shut every open ABNeon position but SXT, and the reasons were
 * the check's and the rule's faults, not the bounces':
 *   ERA, ICP — the check demanded the R8 entry within an hour of the signal (R8 accepted both bounces, hours later);
 *   ASTER, CAP, OKB — Lucy's rule was read at the R8 entry, before the next two 4H candles had closed: one grey
 *     touch candle voided the setup instead of waiting for the next two;
 *   APE, BARD, FLOW, RE, ZEST — bounces from a fresh low: no zone exists yet (a pivot is confirmed a day later),
 *     so R8 cannot see them.
 * Every row closed by it goes back to the state saved in decision_metrics.beforeNeutralClose (status active /
 * in_run, no exit, no PnL) so the watcher manages it again with its old exit; the backup is kept as
 * decision_metrics.restoredFromWrongClose. The exchange positions are not reopened.
 * The R8 one-time close is retired for good: its marker is set here (its call is removed from index.ts too).
 * Production only, once (marker).
 */
const MARKER = "abneon_r8_restore_20261112";
const R8_CLOSE_MARKER = "abneon_r8_close_20261112";

export async function restoreAfterAbneonR8Close(): Promise<{
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_r8_restore'))");
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
        WHERE sentiment_key = 'neon_support_bounce'
          AND status::text = 'reclassified'
          AND cancel_reason = $1
          AND decision_metrics #>> '{beforeNeutralClose,status}' IN ('active', 'in_run')
        RETURNING id, symbol, status::text AS status`,
      [ABNEON_R8_CLOSE_REASON],
    );
    await client.query(
      "INSERT INTO neon_recalc_markers (name) VALUES ($1), ($2) ON CONFLICT DO NOTHING",
      [MARKER, R8_CLOSE_MARKER],
    );
    await client.query("COMMIT");
    return { restored: restored.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
