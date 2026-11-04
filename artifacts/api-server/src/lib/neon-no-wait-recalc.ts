import { pool } from "@workspace/db";
import { NEON_NO_WAIT_ROWS } from "./neon-no-wait-recalc-data.js";

const MARKER = "neon_no_wait_recalc_2026_10_25_v3";
const BACKUP_TABLE = "tracked_signals_backup_neon_no_wait_20261025";

export type NeonNoWaitRecalcResult = {
  applied: number;
  skipped: number[];
  alreadyApplied: boolean;
};

/**
 * Owner order 2026-10-25: October ABNeon dashboard rows are restated as if the
 * entry had been taken at the reaction-candle close (no waiting). Closed rows
 * only; originals are copied to a backup table in the same transaction. A row
 * is changed only while its id, lineage, entry price and detection time still
 * equal the reviewed original, so a rerun or a different database is a no-op.
 */
export async function applyNeonNoWaitRecalc(): Promise<NeonNoWaitRecalcResult> {
  if (process.env.NODE_ENV !== "production") {
    return { applied: 0, skipped: [], alreadyApplied: false };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('neon_no_wait_recalc'))",
    );
    await client.query(
      `CREATE TABLE IF NOT EXISTS neon_recalc_markers (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query(
      "SELECT 1 FROM neon_recalc_markers WHERE name = $1",
      [MARKER],
    );
    if (done.rows.length > 0) {
      await client.query("COMMIT");
      return { applied: 0, skipped: [], alreadyApplied: true };
    }
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE}
         (LIKE tracked_signals INCLUDING DEFAULTS)`,
    );
    const eligible: Array<(typeof NEON_NO_WAIT_ROWS)[number]> = [];
    const skipped: number[] = [];
    const locked = await client.query(
      `SELECT t.id, t.signal_id, t.symbol, t.sentiment_key, t.status::text AS status,
              t.entry_price, t.detected_at,
              (abs(t.entry_price / NULLIF(d.old_entry, 0) - 1) < 1e-6
                AND abs(extract(epoch FROM t.detected_at - (d.old_detected::timestamptz AT TIME ZONE 'UTC'))) < 1)
                AS is_original
         FROM tracked_signals t
         JOIN unnest($1::integer[], $2::float8[], $3::text[]) AS d(id, old_entry, old_detected)
           ON d.id = t.id
         FOR UPDATE OF t`,
      [
        NEON_NO_WAIT_ROWS.map((r) => r.id),
        NEON_NO_WAIT_ROWS.map((r) => r.oldEntryPrice),
        NEON_NO_WAIT_ROWS.map((r) => r.oldDetectedAt),
      ],
    );
    for (const row of NEON_NO_WAIT_ROWS) {
      const cur = (
        locked.rows as Array<{
          id: number;
          signal_id: number;
          symbol: string;
          sentiment_key: string;
          status: string;
          entry_price: number;
          detected_at: Date;
          is_original: boolean | null;
        }>
      ).find((r) => r.id === row.id);
      // 2026-10-29: the marker table is not in the drizzle schema, so a Replit
      // publish can drop it and this ran again on 29.10, resetting rows that
      // were already restated. A row is changed only while it still holds its
      // original (pre-recalc) entry price and detection time.
      if (
        !cur ||
        cur.is_original !== true ||
        cur.signal_id !== row.signalId ||
        cur.symbol !== row.symbol ||
        cur.sentiment_key !== "neon_support_bounce" ||
        cur.status === "reclassified"
      ) {
        skipped.push(row.id);
        continue;
      }
      eligible.push(row);
    }
    if (eligible.length > 0) {
      await client.query(
        `INSERT INTO ${BACKUP_TABLE}
         SELECT * FROM tracked_signals t WHERE t.id = ANY($1::integer[])
            AND NOT EXISTS (SELECT 1 FROM ${BACKUP_TABLE} b WHERE b.id = t.id)`,
        [eligible.map((r) => r.id)],
      );
    }
    for (const r of eligible) {
      const breakEvenArmed =
        r.status === "bu_stop" ||
        r.status === "profit" ||
        ((r.status === "active" || r.status === "in_run") &&
          r.lastMilestone !== null &&
          r.lastMilestone >= 8);
      const stopPrice = breakEvenArmed
        ? r.entryPrice
        : r.entryPrice * (1 - r.stopPct / 100);
      const trailingLevel = r.status === "profit" ? r.exitPrice : null;
      await client.query(
        `UPDATE tracked_signals SET
           detected_at = $2::timestamptz AT TIME ZONE 'UTC',
           entry_price = $3, original_entry_price = $3,
           status = $4::tracked_status,
           exit_price = $5, pnl_percent = $6, peak_price = $7,
           closed_at = $8::timestamptz AT TIME ZONE 'UTC',
           stop_loss_price = $9, stop_loss_pct = $10,
           last_milestone = $11,
           trailing_stop_level = $12,
           trailing_stop_armed_at =
             CASE WHEN $13::text IS NULL THEN NULL
                  ELSE $13::timestamptz AT TIME ZONE 'UTC' END,
           detect_lag_min = 0, confirm_lag_min = 0,
           pending_milestone = NULL, pending_milestone_kind = NULL,
           pending_milestone_price = NULL,
           pending_milestone_trailing_stop = NULL,
           pending_milestone_status = NULL,
           pending_milestone_lease_until = NULL,
           updated_at = NOW()
         WHERE id = $1`,
        [
          r.id,
          r.detectedAt,
          r.entryPrice,
          r.status,
          r.exitPrice,
          r.pnlPercent,
          r.peakPrice,
          r.closedAt,
          stopPrice,
          r.stopPct,
          r.lastMilestone,
          trailingLevel,
          r.trailingArmedAt,
        ],
      );
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1)", [
      MARKER,
    ]);
    await client.query("COMMIT");
    return { applied: eligible.length, skipped, alreadyApplied: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
