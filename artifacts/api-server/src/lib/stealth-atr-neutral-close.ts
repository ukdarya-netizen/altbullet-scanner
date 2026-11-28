import { pool } from "@workspace/db";
import { getKlines } from "./bingx.js";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";
import {
  NEON_LEVEL_HISTORY_BARS,
  NEON_LEVEL_MIN_ATR_EXPANSION_PCT,
  neonLevelAtrExpansionPct,
  type NlCandle,
} from "./stealth-neon-level-breakout.js";
import { logger } from "./logger.js";

/**
 * Owner 2026-11-28: the new Stealth rule «4H ATR14 ≥ 100% of ATR50 at the breakout» is applied to November
 * retroactively. Every November Stealth with a recorded breakout candle whose ratio is below 100% leaves
 * the statistics (all outcomes). Closed rows → reclassified; open rows close neutrally (no fill, no PnL; the
 * tracker trigger sends cancel to the trading bot). Nothing is deleted: the original outcome stays in
 * decision_metrics.beforeNeutralClose. Ratio uses the same function as the scanner on BingX 4H candles.
 * Rows whose candles cannot be loaded are left untouched and logged. Runs once (marker). Production only.
 */
export const STEALTH_ATR_REASON = "stealth_neon_level_atr_contracting_owner_20261128";
const H4 = 4 * 60 * 60_000;

const KEEP_ORIGINAL = `decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
    WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
    ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
      'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
      'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $2::text,
      'atrExpansionPct', ($3::jsonb ->> id::text)::double precision, 'at', NOW()))
  END`;

function parseOpenAt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12) return n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export async function neutralizeStealthAtrRejects(): Promise<{
  skipped?: string; reclassified: number; openClosed: number; ids: number[]; unresolved: string[];
}> {
  const empty = { reclassified: 0, openClosed: 0, ids: [] as number[], unresolved: [] as string[] };
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", ...empty };
  const done = await pool.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [STEALTH_ATR_REASON]);
  if (done.rows.length) return { skipped: "already_applied", ...empty };

  const rows = (
    await pool.query(
      `SELECT id, symbol, decision_metrics #> '{stealthNeonLevel,candleOpenAt}' AS open_at
         FROM tracked_signals
        WHERE sentiment_key = 'stealth_breakout'
          AND detected_at >= '2026-11-01 00:00:00'::timestamp
          AND status::text <> 'reclassified'
          AND decision_metrics #> '{stealthNeonLevel,candleOpenAt}' IS NOT NULL
        ORDER BY id`,
    )
  ).rows as { id: number; symbol: string; open_at: unknown }[];

  const ratios: Record<string, number> = {};
  const unresolved: string[] = [];
  for (const r of rows) {
    const h4Start = parseOpenAt(r.open_at);
    if (h4Start == null) { unresolved.push(`${r.id}:${r.symbol}:no_open_at`); continue; }
    try {
      const k = await getKlines(r.symbol, "4h", NEON_LEVEL_HISTORY_BARS,
        h4Start - (NEON_LEVEL_HISTORY_BARS - 1) * H4, h4Start + H4 - 1);
      const candles: NlCandle[] = k
        .map((x) => ({ time: Number(x.time), open: Number(x.open), high: Number(x.high), low: Number(x.low), close: Number(x.close), volume: Number(x.volume) }))
        .sort((a, b) => a.time - b.time);
      const ratio = neonLevelAtrExpansionPct(candles, h4Start);
      if (ratio == null) unresolved.push(`${r.id}:${r.symbol}:short_history`);
      else ratios[String(r.id)] = ratio;
    } catch (err) {
      unresolved.push(`${r.id}:${r.symbol}:fetch_error:${(err as Error).message}`);
    }
  }
  const rejectIds = Object.entries(ratios)
    .filter(([, v]) => v < NEON_LEVEL_MIN_ATR_EXPANSION_PCT)
    .map(([id]) => Number(id));
  logger.info({ ratios, unresolved, rejectIds }, "Stealth ATR14/ATR50 November check");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('stealth_atr_neutral_close'))");
    const again = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [STEALTH_ATR_REASON]);
    if (again.rows.length) { await client.query("COMMIT"); return { skipped: "already_applied", ...empty }; }
    const cur = rejectIds.length
      ? ((await client.query(
          `SELECT id, signal_id, symbol, status::text AS status FROM tracked_signals
            WHERE id = ANY($1::integer[]) AND sentiment_key = 'stealth_breakout' AND status::text <> 'reclassified'
            ORDER BY id FOR UPDATE`,
          [rejectIds],
        )).rows as { id: number; signal_id: number; symbol: string; status: string }[])
      : [];
    const isOpen = (s: string) => s === "active" || s === "in_run";
    const closedRows = cur.filter((r) => !isOpen(r.status));
    const openRows = cur.filter((r) => isOpen(r.status));
    const ratioJson = JSON.stringify(ratios);
    let reclassified = 0;
    if (closedRows.length) {
      const u = await client.query(
        `UPDATE tracked_signals
            SET ${KEEP_ORIGINAL},
                status = 'reclassified', cancel_reason = $2,
                exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
                trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
                pending_milestone = NULL, pending_milestone_kind = NULL, pending_milestone_price = NULL,
                pending_milestone_trailing_stop = NULL, pending_milestone_status = NULL,
                pending_milestone_lease_until = NULL, updated_at = NOW()
          WHERE id = ANY($1::integer[]) AND sentiment_key = 'stealth_breakout'
            AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled', 'breakeven')
          RETURNING id`,
        [closedRows.map((r) => r.id), STEALTH_ATR_REASON, ratioJson],
      );
      reclassified = u.rows.length;
    }
    let openClosed = 0;
    if (openRows.length) {
      await client.query(`UPDATE tracked_signals SET ${KEEP_ORIGINAL} WHERE id = ANY($1::integer[])`,
        [openRows.map((r) => r.id), STEALTH_ATR_REASON, ratioJson]);
      openClosed = await closeGroup(
        client as never,
        openRows.map((r) => [r.id, r.signal_id, r.symbol, "stealth_breakout"]) as never,
        "stealth_breakout",
        STEALTH_ATR_REASON,
      );
    }
    if (cur.length) {
      await client.query(
        `UPDATE stealth_breakout_armed_setups
            SET status = 'reclassified', terminal_reason = $2::text, updated_at = NOW()
          WHERE fired_signal_id = ANY($1::integer[]) AND status = 'fired'`,
        [cur.map((r) => r.signal_id), STEALTH_ATR_REASON],
      );
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [STEALTH_ATR_REASON]);
    await client.query("COMMIT");
    return { reclassified, openClosed, ids: cur.map((r) => r.id), unresolved };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
