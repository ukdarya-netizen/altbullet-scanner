import { pool } from "@workspace/db";

/**
 * Owner order 2026-11-10: remove the reviewed, already-closed November ABNeon
 * outcomes from statistics after the entry rule changed. The original status,
 * PnL, exit, close time and peak are retained in decision_metrics.
 *
 * Only these eight closed rows are eligible. The open ABNeon #3613 is
 * intentionally excluded. Production only; safe to repeat.
 */
export const ABNEON_NOVEMBER_NEUTRAL_REASON =
  "abneon_november_2026_removed_from_statistics";

const TARGETS = [
  { id: 3039, symbol: "XAUT-USDT", status: "expired" },
  { id: 3053, symbol: "ELSA-USDT", status: "profit" },
  { id: 3072, symbol: "DOS-USDT", status: "expired" },
  { id: 3073, symbol: "MEGA-USDT", status: "bu_stop" },
  { id: 3115, symbol: "CAP-USDT", status: "profit" },
  { id: 3118, symbol: "ZEC-USDT", status: "profit" },
  { id: 3214, symbol: "IDOL-USDT", status: "bu_stop" },
  { id: 3631, symbol: "ARX-USDT", status: "bu_stop" },
] as const;

const KEEP_ORIGINAL = `decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
    WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
    ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
      'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
      'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $3::text, 'at', NOW()))
  END`;

export async function reclassifyClosedAbneonNovemberStats(): Promise<{
  reclassified: number[];
  alreadyExcluded: number[];
}> {
  if (process.env.NODE_ENV !== "production") {
    return { reclassified: [], alreadyExcluded: [] };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('abneon_november_neutral_stats'))",
    );

    const ids = TARGETS.map((target) => target.id);
    const { rows } = await client.query<{
      id: number;
      symbol: string;
      status: string;
    }>(
      `SELECT id, symbol, status::text AS status
         FROM tracked_signals
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'neon_support_bounce'
        FOR UPDATE`,
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (byId.size !== TARGETS.length) {
      throw new Error(
        `ABNeon November neutralization: expected ${TARGETS.length} rows, found ${byId.size}`,
      );
    }

    const alreadyExcluded: number[] = [];
    for (const target of TARGETS) {
      const row = byId.get(target.id);
      if (!row || row.symbol !== target.symbol) {
        throw new Error(
          `ABNeon November neutralization: identity mismatch for ${target.id}`,
        );
      }
      if (row.status === "reclassified") {
        alreadyExcluded.push(target.id);
        continue;
      }
      if (row.status !== target.status) {
        throw new Error(
          `ABNeon November neutralization: unexpected status for ${target.id}: ${row.status}`,
        );
      }
    }

    const pending = TARGETS.filter(
      (target) => !alreadyExcluded.includes(target.id),
    );
    let reclassified: number[] = [];
    if (pending.length > 0) {
      const updated = await client.query<{ id: number }>(
        `UPDATE tracked_signals
            SET ${KEEP_ORIGINAL},
                status = 'reclassified',
                cancel_reason = $3,
                exit_price = NULL,
                pnl_percent = NULL,
                closed_at = NULL,
                updated_at = NOW()
          WHERE id = ANY($1::integer[])
            AND sentiment_key = 'neon_support_bounce'
            AND status::text = ANY($2::text[])
          RETURNING id`,
        [
          pending.map((target) => target.id),
          [...new Set(pending.map((target) => target.status))],
          ABNEON_NOVEMBER_NEUTRAL_REASON,
        ],
      );
      reclassified = updated.rows.map((row) => row.id).sort((a, b) => a - b);
      if (reclassified.length !== pending.length) {
        throw new Error(
          `ABNeon November neutralization: expected ${pending.length} updates, got ${reclassified.length}`,
        );
      }
    }

    await client.query("COMMIT");
    return { reclassified, alreadyExcluded };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
