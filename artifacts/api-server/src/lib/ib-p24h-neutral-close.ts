import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";
import { IMPULSE_BUY_MIN_PRICE_24H_PCT } from "./scanner-patterns.js";

/**
 * Owner 2026-11-09 (final IB tuning): the new rule «IB only when the coin is up ≥ 15% over 24 h» is applied
 * to November retroactively. Every November IB whose 24 h change at the entry (the fired decision snapshot,
 * else the tracker's decision_metrics) was below 15% leaves the statistics and the page PnL — all outcomes,
 * winners and losers alike. Open positions close neutrally (no fill, no PnL; the tracker trigger sends
 * cancel_entry to the trading bot). The original outcome stays in decision_metrics.beforeNeutralClose.
 * Rows without the metric are not touched (reported). Already reclassified rows are skipped, new IB always
 * pass the rule → repeat boots are no-ops. Production only.
 */
export const IB_P24H_CLOSE_REASON = "impulse_buy_p24h_below_15_neutral_close";
const MONTH_START = "2026-11-01T00:00:00Z";

const KEEP_ORIGINAL = `decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
    WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
    ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
      'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
      'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $2::text, 'at', NOW()))
  END`;

export async function neutralizeIbPrice24hRejects(): Promise<{ closed: number; open: number; noMetric: number }> {
  if (process.env.NODE_ENV !== "production") return { closed: 0, open: 0, noMetric: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ib_p24h_neutral_close'))");
    const rows = (
      await client.query(
        `SELECT t.id, t.signal_id, t.symbol, t.status::text AS status,
                COALESCE(
                  NULLIF(s.entry_metrics->'decision_metrics'->>'price24h', '')::double precision,
                  NULLIF(t.decision_metrics->>'price24h', '')::double precision
                ) AS p24
           FROM tracked_signals t
           LEFT JOIN LATERAL (
             SELECT entry_metrics FROM pattern_decision_snapshots
              WHERE tracked_signal_id = t.id AND pattern_key = 'impulse_buy' AND decision_kind = 'fired'
              ORDER BY id DESC LIMIT 1
           ) s ON true
          WHERE t.sentiment_key = 'impulse_buy'
            AND t.detected_at >= $1::timestamptz
            AND t.status::text <> 'reclassified'
          ORDER BY t.id
          FOR UPDATE OF t`,
        [MONTH_START],
      )
    ).rows as { id: number; signal_id: number; symbol: string; status: string; p24: number | null }[];
    const noMetric = rows.filter((r) => r.p24 === null).length;
    const reject = rows.filter((r) => r.p24 !== null && r.p24 < IMPULSE_BUY_MIN_PRICE_24H_PCT);
    const open = reject.filter((r) => r.status === "active" || r.status === "in_run");
    const closedRows = reject.filter((r) => r.status !== "active" && r.status !== "in_run");
    let closed = 0;
    if (closedRows.length) {
      const r = await client.query(
        `UPDATE tracked_signals
            SET ${KEEP_ORIGINAL},
                status = 'reclassified', cancel_reason = $2,
                exit_price = NULL, pnl_percent = NULL, closed_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::integer[]) AND sentiment_key = 'impulse_buy'
            AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled', 'breakeven')
          RETURNING id`,
        [closedRows.map((x) => x.id), IB_P24H_CLOSE_REASON],
      );
      closed = r.rows.length;
    }
    let openClosed = 0;
    if (open.length) {
      await client.query(`UPDATE tracked_signals SET ${KEEP_ORIGINAL} WHERE id = ANY($1::integer[])`, [open.map((x) => x.id), IB_P24H_CLOSE_REASON]);
      openClosed = await closeGroup(
        client as never,
        open.map((x) => [x.id, x.signal_id, x.symbol, "impulse_buy"]) as never,
        "impulse_buy",
        IB_P24H_CLOSE_REASON,
      );
    }
    await client.query("COMMIT");
    return { closed, open: openClosed, noMetric };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
