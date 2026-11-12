import { pool } from "@workspace/db";
import { monthVolumeGate } from "./abneon-volume-gate.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { getAggSpotVolume1h } from "./coinglass_spot_taker.js";

/**
 * Owner order 2026-11-12, two one-time actions with the ABNeon month-volume gate (abneon-volume-gate.ts):
 *
 * A) Every OPEN ABNeon position (sentiment_key 'neon_support_bounce') that the gate would not have let through at
 *    its detection — the last 24h of aggregated futures or spot volume below 80% of the coin's 30-day average
 *    day, or no aggregated data — is closed neutrally: status 'reclassified', no exit, no PnL; the tracker trigger
 *    sends cancel_entry to the trading bot. Every open row gets a verdict in abneon_month_volume_review.
 *    A row whose CoinGlass request failed is retried on the next start; after 3 starts without data it is closed
 *    (the live rule: no aggregated data → no signal).
 * B) Every ABNeon stop loss of Dubai November 2026 leaves the statistics (status 'reclassified', no exit, no PnL).
 *    Already closed — no trading command. The original outcome is kept in decision_metrics.beforeNeutralClose.
 *
 * It can never repeat (the Stealth lesson of 2026-11-11):
 *   1) markers abneon_month_volume_close_20261112 (A) and abneon_nov_stops_zeroed_20261112 (B);
 *   2) only rows detected before ABNEON_MONTH_VOLUME_CUTOFF_UTC — signals after it are never selected, even if a
 *      marker were lost; (B) only rows already in stop_loss at that run.
 * Production only.
 */
export const ABNEON_MONTH_VOLUME_CLOSE_REASON = "abneon_month_volume_neutral_close";
export const ABNEON_NOV_STOPS_ZERO_REASON = "abneon_nov_2026_stops_zeroed_by_owner_20261112";
const MARKER_A = "abneon_month_volume_close_20261112";
const MARKER_B = "abneon_nov_stops_zeroed_20261112";
const DUBAI_NOVEMBER_START_UTC = "2026-10-31 20:00:00+00";
/** Hard upper bound: nothing detected after this moment is ever touched. */
export const ABNEON_MONTH_VOLUME_CUTOFF_UTC = "2026-11-13 00:00:00+00";
const H1 = 3_600_000;
const MAX_NO_DATA_STARTS = 3;

async function markers(): Promise<{ a: boolean; b: boolean }> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const { rows } = await pool.query<{ name: string }>("SELECT name FROM neon_recalc_markers WHERE name = ANY($1::text[])", [[MARKER_A, MARKER_B]]);
  return { a: rows.some((r) => r.name === MARKER_A), b: rows.some((r) => r.name === MARKER_B) };
}

const SNAPSHOT = `CASE
      WHEN COALESCE(t.decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN t.decision_metrics
      ELSE COALESCE(t.decision_metrics, '{}'::jsonb) || jsonb_build_object('beforeNeutralClose', jsonb_build_object(
        'status', t.status::text, 'pnlPercent', t.pnl_percent, 'exitPrice', t.exit_price,
        'closedAt', t.closed_at, 'peakPrice', t.peak_price, 'cancelReason', t.cancel_reason,
        'reason', $2::text, 'at', NOW()))
    END`;

async function closeOpenNeutral(trackedId: number, signalId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_month_volume_close'))");
    const updated = await client.query(
      `UPDATE tracked_signals AS t
          SET decision_metrics = ${SNAPSHOT},
              status = 'reclassified', cancel_reason = $2::text,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              trailing_stop_level = NULL, trailing_stop_armed_at = NULL, last_smart_cancel_check_at = NULL,
              pending_milestone = NULL, pending_milestone_kind = NULL, pending_milestone_price = NULL,
              pending_milestone_trailing_stop = NULL, pending_milestone_status = NULL,
              pending_milestone_lease_until = NULL,
              updated_at = NOW()
        WHERE t.id = $1
          AND t.sentiment_key = 'neon_support_bounce'
          AND t.status::text IN ('active', 'in_run')
          AND t.detected_at < $3::timestamptz
        RETURNING t.id`,
      [trackedId, ABNEON_MONTH_VOLUME_CLOSE_REASON, ABNEON_MONTH_VOLUME_CUTOFF_UTC],
    );
    if (updated.rows.length > 0) {
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = $1 AND status IN ('ready', 'retry', 'failed')`,
        [trackedId, ABNEON_MONTH_VOLUME_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('public.trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = $1 AND status = 'pending'`,
          [signalId, ABNEON_MONTH_VOLUME_CLOSE_REASON],
        );
      }
    }
    await client.query("COMMIT");
    return updated.rows.length > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A) open ABNeon positions the month-volume gate would not have let through. */
async function closeOpenBelowMonthVolume(): Promise<{ reviewed: number; closed: number[]; unresolved: number[] }> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS abneon_month_volume_review (
       tracked_id integer PRIMARY KEY,
       symbol text NOT NULL,
       status_before text NOT NULL,
       detected_at timestamptz,
       fut_vs_month double precision,
       spot_vs_month double precision,
       verdict text NOT NULL,
       action text NOT NULL,
       attempts integer NOT NULL DEFAULT 1,
       reviewed_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const rows = (
    await pool.query<{ id: number; signal_id: number; symbol: string; status: string; detected_at: Date }>(
      `SELECT id, signal_id, symbol, status::text AS status, detected_at
         FROM tracked_signals
        WHERE sentiment_key = 'neon_support_bounce'
          AND status::text IN ('active', 'in_run')
          AND detected_at < $1::timestamptz
        ORDER BY id`,
      [ABNEON_MONTH_VOLUME_CUTOFF_UTC],
    )
  ).rows;
  const closed: number[] = [];
  const unresolved: number[] = [];
  for (const r of rows) {
    const det = new Date(r.detected_at).getTime();
    const lastHourOpen = Math.floor(det / H1) * H1 - H1;
    const hours = Math.min(4500, Math.ceil((Date.now() - (lastHourOpen - 32 * 24 * H1)) / H1) + 5);
    let verdict = "error";
    let fut: number | null = null, spot: number | null = null;
    try {
      const [futMap, spotMap] = await Promise.all([
        getAggFuturesVolumeByInterval(r.symbol, "1h", hours, Date.now(), "low", 60_000).catch(() => null),
        getAggSpotVolume1h(r.symbol, hours).catch(() => null),
      ]);
      const g = monthVolumeGate({ futUsdByHour: futMap, spotUsdByHour: spotMap, lastHourOpen });
      fut = g.fut; spot = g.spot;
      verdict = g.ok ? "pass" : futMap === null || spotMap === null ? "no_response" : g.reason;
    } catch (err) {
      verdict = `error_${String(err).slice(0, 60)}`;
    }
    const prev = await pool.query<{ attempts: number }>("SELECT attempts FROM abneon_month_volume_review WHERE tracked_id = $1", [r.id]);
    const attempts = (prev.rows[0]?.attempts ?? 0) + 1;
    const close = verdict === "month_volume_low" || verdict === "no_aggregated_volume" ||
      ((verdict === "no_response" || verdict.startsWith("error")) && attempts >= MAX_NO_DATA_STARTS);
    let action = "kept_open";
    if (close) {
      if (await closeOpenNeutral(r.id, r.signal_id)) { action = "closed_neutral"; closed.push(r.id); }
      else action = "already_closed_meanwhile";
    } else if (verdict !== "pass") {
      action = "retry_next_start";
      unresolved.push(r.id);
    }
    await pool.query(
      `INSERT INTO abneon_month_volume_review
         (tracked_id, symbol, status_before, detected_at, fut_vs_month, spot_vs_month, verdict, action, attempts, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (tracked_id) DO UPDATE SET
         fut_vs_month = EXCLUDED.fut_vs_month, spot_vs_month = EXCLUDED.spot_vs_month, verdict = EXCLUDED.verdict,
         action = EXCLUDED.action, attempts = EXCLUDED.attempts, reviewed_at = now()
       WHERE abneon_month_volume_review.action <> 'closed_neutral'`,
      [r.id, r.symbol, r.status, r.detected_at, fut, spot, verdict, action, attempts],
    );
  }
  if (unresolved.length === 0) {
    await pool.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER_A]);
  }
  return { reviewed: rows.length, closed, unresolved };
}

/** B) every ABNeon stop loss of Dubai November 2026 out of the statistics. */
async function zeroNovemberStops(): Promise<{ zeroed: number[] }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_nov_stops_zeroed_20261112'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER_B]);
    if (done.rows.length > 0) { await client.query("COMMIT"); return { zeroed: [] }; }
    const updated = await client.query<{ id: number }>(
      `UPDATE tracked_signals AS t
          SET decision_metrics = ${SNAPSHOT},
              status = 'reclassified', cancel_reason = $2::text,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE t.sentiment_key = 'neon_support_bounce'
          AND t.status::text = 'stop_loss'
          AND t.detected_at >= $1::timestamptz
          AND t.detected_at < $3::timestamptz
        RETURNING t.id`,
      [DUBAI_NOVEMBER_START_UTC, ABNEON_NOV_STOPS_ZERO_REASON, ABNEON_MONTH_VOLUME_CUTOFF_UTC],
    );
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER_B]);
    await client.query("COMMIT");
    return { zeroed: updated.rows.map((r) => r.id).sort((a, b) => a - b) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runAbneonMonthVolumeOneTime(): Promise<{
  skipped?: string;
  open?: { skipped?: string; reviewed: number; closed: number[]; unresolved: number[] };
  novemberStops?: { skipped?: string; zeroed: number[] };
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production" };
  const m = await markers();
  const novemberStops = m.b ? { skipped: "already_applied", zeroed: [] } : await zeroNovemberStops();
  const open = m.a ? { skipped: "already_applied", reviewed: 0, closed: [], unresolved: [] } : await closeOpenBelowMonthVolume();
  return { open, novemberStops };
}
