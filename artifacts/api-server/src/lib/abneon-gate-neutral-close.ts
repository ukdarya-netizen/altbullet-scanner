import { pool } from "@workspace/db";
import { ABNEON_PRE_TOUCH_BLUE_MIN, preTouchBlueCount } from "./abneon-volume-gate.js";
import { getKlines } from "./bingx.js";
import { getAggFuturesVolumeByInterval } from "./coinglass_taker.js";
import { normalizeClosedBreakoutCandles } from "./breakout-analysis.js";

/**
 * Owner order 2026-11-06/07: open ABNeon positions that the new pre-touch volume gate
 * (abneon-volume-gate.ts, ≥ 11 of 12) would not have let through are closed neutrally —
 * status 'reclassified', no exit price, no PnL, excluded from statistics. The tracker trigger
 * sends cancel_entry to the trading bot, which closes the exchange position.
 *
 * Runs in production only (the production database), once (marker), in the background after start.
 * Every open ABNeon row and every ABNeon row detected since 2026-11-01 gets a verdict in
 * abneon_gate_review (read it to see the list). Only OPEN rows with verdict 'close' are changed;
 * closed November rows are only recorded (owner decides). No data → nothing changed, retried on the
 * next start (the marker is written only when every open row got a real verdict).
 */
export const ABNEON_GATE_NEUTRAL_CLOSE_REASON = "abneon_pre_touch_volume_neutral_close";
const MARKER = "abneon_gate_neutral_close_20261107";
const MONTH_START = "2026-11-01T00:00:00Z";
const H1 = 3_600_000;

type Row = {
  id: number;
  signal_id: number;
  symbol: string;
  status: string;
  pnl_percent: number | null;
  detected_at: Date;
};

async function verdictFor(r: Row): Promise<{
  armedAt: Date | null;
  triggerAt: Date | null;
  zoneTop: number | null;
  blue: number | null;
  verdict: string;
}> {
  const det = new Date(r.detected_at).getTime();
  const ev = await pool.query<{ frozen_level: number; armed_at: Date; trigger_candle_at: Date }>(
    `SELECT frozen_level, armed_at, trigger_candle_at FROM stealth_abneon_shadow_candidates
      WHERE symbol = $1 AND detection_method = 'abneon_support_bounce' AND trigger_candle_at IS NOT NULL
        AND trigger_candle_at <= to_timestamp($2 / 1000.0) + interval '2 hours'
      ORDER BY trigger_candle_at DESC LIMIT 1`,
    [r.symbol, det],
  );
  const e = ev.rows[0];
  const trig = e ? new Date(e.trigger_candle_at).getTime() : null;
  if (!e || trig === null || Math.abs(det - trig) > 6 * H1) {
    return { armedAt: null, triggerAt: null, zoneTop: null, blue: null, verdict: "no_event" };
  }
  const arm = new Date(e.armed_at).getTime();
  const zoneTop = Number(e.frozen_level);
  const start = Math.min(arm, trig) - 80 * H1;
  const end = trig + 3 * H1;
  const raw = await getKlines(r.symbol, "1h", 1000, start, end);
  // normalizeClosedBreakoutCandles drops the last row (the forming bar); here the window ends in the
  // past, so add one far bar to keep every real one.
  const candles = normalizeClosedBreakoutCandles([...raw, { ...raw[raw.length - 1]!, time: end + H1 }]);
  const hours = Math.ceil((Date.now() - start) / H1) + 5;
  const agg = await getAggFuturesVolumeByInterval(r.symbol, "1h", Math.min(4500, hours), Date.now(), "low", 60_000);
  if (!agg) return { armedAt: e.armed_at, triggerAt: e.trigger_candle_at, zoneTop, blue: null, verdict: "no_data_no_aggregated_volume" };
  const g = preTouchBlueCount({ candles1h: candles, aggUsdByTime: agg, armCandleTime: arm, triggerCandleTime: trig, zoneTop });
  if (!g.ok) return { armedAt: e.armed_at, triggerAt: e.trigger_candle_at, zoneTop, blue: null, verdict: `no_data_${g.reason}` };
  return {
    armedAt: e.armed_at,
    triggerAt: e.trigger_candle_at,
    zoneTop,
    blue: g.blue,
    verdict: g.blue >= ABNEON_PRE_TOUCH_BLUE_MIN ? "pass" : "close",
  };
}

async function closeNeutral(trackedId: number, signalId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('abneon_gate_neutral_close'))");
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
        WHERE id = $1
          AND sentiment_key = 'neon_support_bounce'
          AND status IN ('active', 'in_run')
        RETURNING id`,
      [trackedId, ABNEON_GATE_NEUTRAL_CLOSE_REASON],
    );
    if (updated.rows.length > 0) {
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = $1 AND status IN ('ready', 'retry', 'failed')`,
        [trackedId, ABNEON_GATE_NEUTRAL_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = $1 AND status = 'pending'`,
          [signalId, ABNEON_GATE_NEUTRAL_CLOSE_REASON],
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

export async function runAbneonGateNeutralClose(): Promise<{
  skipped?: string;
  reviewed: number;
  closed: number[];
  open: number;
  unresolvedOpen: number[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", reviewed: 0, closed: [], open: 0, unresolvedOpen: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const done = await pool.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
  if (done.rows.length > 0) return { skipped: "already_applied", reviewed: 0, closed: [], open: 0, unresolvedOpen: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS abneon_gate_review (
       tracked_id integer PRIMARY KEY,
       symbol text NOT NULL,
       status_before text NOT NULL,
       pnl_percent_before double precision,
       detected_at timestamptz,
       armed_at timestamptz,
       trigger_at timestamptz,
       zone_top double precision,
       blue_of_12 integer,
       verdict text NOT NULL,
       action text NOT NULL,
       reviewed_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const rows = (
    await pool.query<Row>(
      `SELECT id, signal_id, symbol, status::text AS status, pnl_percent, detected_at
         FROM tracked_signals
        WHERE sentiment_key = 'neon_support_bounce'
          AND (status IN ('active', 'in_run') OR detected_at >= $1::timestamptz)
        ORDER BY id`,
      [MONTH_START],
    )
  ).rows;
  const closed: number[] = [];
  const unresolvedOpen: number[] = [];
  let open = 0;
  for (const r of rows) {
    const isOpen = r.status === "active" || r.status === "in_run";
    if (isOpen) open++;
    let v: Awaited<ReturnType<typeof verdictFor>>;
    try {
      v = await verdictFor(r);
    } catch (err) {
      v = { armedAt: null, triggerAt: null, zoneTop: null, blue: null, verdict: `error_${String(err).slice(0, 80)}` };
    }
    let action = isOpen ? "kept_open" : "recorded_only";
    if (isOpen && v.verdict === "close") {
      if (await closeNeutral(r.id, r.signal_id)) {
        action = "closed_neutral";
        closed.push(r.id);
      } else action = "already_closed_meanwhile";
    }
    if (isOpen && v.verdict !== "close" && v.verdict !== "pass") unresolvedOpen.push(r.id);
    await pool.query(
      `INSERT INTO abneon_gate_review
         (tracked_id, symbol, status_before, pnl_percent_before, detected_at, armed_at, trigger_at, zone_top, blue_of_12, verdict, action, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (tracked_id) DO UPDATE SET
         blue_of_12 = EXCLUDED.blue_of_12, verdict = EXCLUDED.verdict, action = EXCLUDED.action,
         armed_at = EXCLUDED.armed_at, trigger_at = EXCLUDED.trigger_at, zone_top = EXCLUDED.zone_top,
         reviewed_at = now()
       WHERE abneon_gate_review.action <> 'closed_neutral'`,
      [r.id, r.symbol, r.status, r.pnl_percent, r.detected_at, v.armedAt, v.triggerAt, v.zoneTop, v.blue, v.verdict, action],
    );
  }
  // An open row without a real verdict (no event / no data / error) → try again on the next start.
  if (unresolvedOpen.length === 0) {
    await pool.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
  }
  return { reviewed: rows.length, closed, open, unresolvedOpen };
}
