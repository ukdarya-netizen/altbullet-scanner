import { pool } from "@workspace/db";

/**
 * Owner order 2026-11-11: with the CAB BTC crowd filter (LC fires on BTC only when the Binance global
 * account long share is ≤ 70%, reports/btc-signal-metrics) the November BTC signals that filter would have
 * stopped are taken out of the statistics — status 'reclassified', no exit price, no PnL; the open one is
 * closed neutrally (the tracker trigger sends cancel_entry to the trading bot). The original outcome is kept
 * in decision_metrics.beforeNeutralClose.
 *
 * The rows are named, not searched: #3611 (75.49%), #3704 (74.03%), #3710 (73.64%), #3714 (74.49%), #3717
 * (75.45%, open). #3017 (69.86%) passes and stays. Production only, once (marker).
 */
export const BTC_CROWD_NEUTRAL_CLOSE_REASON = "btc_crowd_filter_neutral_close";
const MARKER = "btc_crowd_filter_neutral_close_20261111";
const IDS = [3611, 3704, 3710, 3714, 3717];

export async function runBtcCrowdNeutralClose(): Promise<{
  skipped?: string;
  closed: { id: number; symbol: string; statusBefore: string; pnlBefore: number | null }[];
}> {
  if (process.env.NODE_ENV !== "production") return { skipped: "not_production", closed: [] };
  await pool.query(
    `CREATE TABLE IF NOT EXISTS neon_recalc_markers (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('btc_crowd_neutral_close'))");
    const done = await client.query("SELECT 1 FROM neon_recalc_markers WHERE name = $1", [MARKER]);
    if (done.rows.length > 0) {
      await client.query("ROLLBACK");
      return { skipped: "already_applied", closed: [] };
    }
    const before = await client.query<{
      id: number; signal_id: number; symbol: string; status: string; pnl_percent: number | null;
    }>(
      `SELECT id, signal_id, symbol, status::text AS status, pnl_percent
         FROM tracked_signals
        WHERE id = ANY($1::integer[])
          AND symbol IN ('BTC-USDT', 'BTCUSDT')
          AND sentiment_key = 'liquidation_cascade'
          AND status::text <> 'reclassified'
        ORDER BY id
        FOR UPDATE`,
      [IDS],
    );
    const ids = before.rows.map((r) => r.id);
    if (ids.length > 0) {
      await client.query(
        `UPDATE tracked_signals
            SET decision_metrics = CASE
                  WHEN decision_metrics ? 'beforeNeutralClose' THEN decision_metrics
                  ELSE coalesce(decision_metrics, '{}'::jsonb) || jsonb_build_object(
                    'beforeNeutralClose', jsonb_build_object(
                      'status', status::text, 'exitPrice', exit_price, 'pnlPercent', pnl_percent,
                      'closedAt', closed_at, 'cancelReason', cancel_reason, 'neutralizedAt', NOW(),
                      'reason', $2::text))
                END,
                status = 'reclassified', cancel_reason = $2,
                exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
                trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
                last_smart_cancel_check_at = NULL,
                pending_milestone = NULL, pending_milestone_kind = NULL,
                pending_milestone_price = NULL,
                pending_milestone_trailing_stop = NULL,
                pending_milestone_status = NULL,
                pending_milestone_lease_until = NULL,
                updated_at = NOW()
          WHERE id = ANY($1::integer[])`,
        [ids, BTC_CROWD_NEUTRAL_CLOSE_REASON],
      );
      await client.query(
        `UPDATE milestone_notification_deliveries
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL, last_error = $2
          WHERE tracked_signal_id = ANY($1::integer[]) AND status IN ('ready', 'retry', 'failed')`,
        [ids, BTC_CROWD_NEUTRAL_CLOSE_REASON],
      );
      const relay = await client.query("SELECT to_regclass('trading_signal_deliveries') AS relation");
      if ((relay.rows[0] as { relation: string | null }).relation !== null) {
        await client.query(
          `UPDATE trading_signal_deliveries
              SET status = 'quarantined', claim_token = NULL, claim_until = NULL, last_error = $2
            WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
          [before.rows.map((r) => r.signal_id), BTC_CROWD_NEUTRAL_CLOSE_REASON],
        );
      }
    }
    await client.query("INSERT INTO neon_recalc_markers (name) VALUES ($1) ON CONFLICT DO NOTHING", [MARKER]);
    await client.query("COMMIT");
    return {
      closed: before.rows.map((r) => ({ id: r.id, symbol: r.symbol, statusBefore: r.status, pnlBefore: r.pnl_percent })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
