import type { RequestHandler } from "express";
import { sql, type SQL } from "drizzle-orm";
import { getCancellationPolicy } from "../lib/cancellation-policy.js";

type QueryResult = { rows: Record<string, unknown>[] };

export type CancellationReplayQueryExecutor = (
  query: SQL,
) => Promise<QueryResult>;

/**
 * Builds the cancellation-replay endpoint with an injected database executor.
 * Keeping its response assembly here makes it directly testable without a
 * database while the production route uses this exact handler.
 */
export function createCancellationReplayHandler(
  execute: CancellationReplayQueryExecutor,
): RequestHandler {
  return async (req, res) => {
    const thresholdRaw = Number(req.query.thresholdPct ?? 10);
    const limitRaw = Number(req.query.limit ?? 100);
    const thresholdPct = Number.isFinite(thresholdRaw) ? thresholdRaw : 10;
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), 500)
        : 100;

    try {
      const [
        summaryResult,
        byReasonResult,
        rowsResult,
        replayResult,
        pnlBucketResult,
      ] = await Promise.all([
        execute(sql`
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE price_72h_after_exit_pct IS NOT NULL)::int AS measured,
              COUNT(*) FILTER (WHERE price_72h_after_exit_pct IS NULL)::int AS pending,
              COUNT(*) FILTER (
                WHERE price_72h_after_exit_pct IS NOT NULL
                  AND price_72h_after_exit_observed_at IS NOT NULL
              )::int AS timestamped,
              COUNT(*) FILTER (
                WHERE price_72h_after_exit_pct IS NOT NULL
                  AND price_72h_after_exit_observed_at IS NULL
              )::int AS observation_time_unavailable,
              COUNT(*) FILTER (WHERE price_72h_after_exit_pct >= ${thresholdPct})::int AS recovered_10_plus,
              ROUND(AVG(price_72h_after_exit_pct) FILTER (
                WHERE price_72h_after_exit_pct IS NOT NULL
              )::numeric, 2)::float4 AS avg_observed_at_or_after_72h_pct
            FROM tracked_signals
            WHERE (cancel_reason IS NOT NULL OR status = 'bu_stop')
              AND status IN ('cancelled', 'stop_loss', 'bu_stop')
              AND closed_at <= NOW() - INTERVAL '72 hours'
          `),
        execute(sql`
            SELECT
              COALESCE(sentiment_key, 'unknown') AS pattern,
              COALESCE(cancel_reason, status::text, 'unknown') AS cancel_reason,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE price_72h_after_exit_pct IS NOT NULL)::int AS measured,
              COUNT(*) FILTER (WHERE price_72h_after_exit_pct IS NULL)::int AS pending,
              COUNT(*) FILTER (
                WHERE price_72h_after_exit_pct >= ${thresholdPct}
              )::int AS recovered_10_plus,
              ROUND(AVG(price_72h_after_exit_pct) FILTER (
                WHERE price_72h_after_exit_pct IS NOT NULL
              )::numeric, 2)::float4 AS avg_observed_at_or_after_72h_pct
            FROM tracked_signals
            WHERE (cancel_reason IS NOT NULL OR status = 'bu_stop')
              AND status IN ('cancelled', 'stop_loss', 'bu_stop')
              AND closed_at <= NOW() - INTERVAL '72 hours'
            GROUP BY sentiment_key, cancel_reason, status
            ORDER BY recovered_10_plus DESC, total DESC
          `),
        execute(sql`
            SELECT
              id, symbol, sentiment_key AS pattern, status, cancel_reason,
              detected_at, closed_at, entry_price, exit_price, pnl_percent,
              price_72h_after_exit_pct AS observed_price_at_or_after_72h_pct,
              price_72h_after_exit_observed_at AS observed_at,
              ROUND(
                (
                  EXTRACT(
                    EPOCH FROM (
                      price_72h_after_exit_observed_at - closed_at
                    )
                  ) / 3600
                )::numeric,
                2
              )::float4 AS observation_hours_after_exit,
              CASE
                WHEN price_72h_after_exit_pct IS NULL THEN 'pending'
                WHEN price_72h_after_exit_observed_at IS NULL
                  THEN 'observation_time_unavailable'
                ELSE 'observed_at_or_after_72h'
              END AS observation_label,
              (price_72h_after_exit_pct >= ${thresholdPct}) AS highlighted
            FROM tracked_signals
            WHERE (cancel_reason IS NOT NULL OR status = 'bu_stop')
              AND status IN ('cancelled', 'stop_loss', 'bu_stop')
              AND closed_at <= NOW() - INTERVAL '72 hours'
            ORDER BY highlighted DESC NULLS LAST, closed_at DESC
            LIMIT ${limit}
          `),
        execute(sql`
            WITH policy(pattern, stale_hours, smart_hours, max_age_hours) AS (
              VALUES
                ('bullish_accumulation'::text, 6::numeric, 8::numeric, 72::numeric),
                ('balanced_grind'::text, 12::numeric, 24::numeric, 96::numeric),
                ('liquidation_cascade'::text, NULL::numeric, 24::numeric, 120::numeric)
            ),
            history AS (
              SELECT
                ts.sentiment_key,
                ts.status,
                ts.cancel_reason,
                EXTRACT(EPOCH FROM (ts.closed_at - ts.detected_at)) / 3600 AS age_hours
              FROM tracked_signals ts
              WHERE ts.closed_at IS NOT NULL
                AND ts.detected_at IS NOT NULL
                AND ts.closed_at <= NOW() - INTERVAL '72 hours'
            )
            SELECT
              p.pattern,
              COUNT(*) FILTER (
                WHERE h.cancel_reason LIKE 'stale%'
                  AND p.stale_hours IS NOT NULL
                  AND h.age_hours < p.stale_hours
                  AND h.status IN ('cancelled', 'stop_loss')
              )::int AS deferred_stale_poor_outcomes,
              COUNT(*) FILTER (
                WHERE h.cancel_reason LIKE 'smart_cancel%'
                  AND h.age_hours < p.smart_hours
                  AND h.status IN ('cancelled', 'stop_loss')
              )::int AS deferred_smart_poor_outcomes,
              COUNT(*) FILTER (
                WHERE (h.cancel_reason LIKE 'max_age%' OR h.cancel_reason = 'stale_72h')
                  AND h.age_hours < p.max_age_hours
                  AND h.status IN ('cancelled', 'stop_loss')
              )::int AS deferred_max_age_poor_outcomes,
              COUNT(*) FILTER (
                WHERE h.status IN ('profit', 'bu_stop')
                  AND h.age_hours < GREATEST(
                    COALESCE(p.stale_hours, 0), p.smart_hours
                  )
              )::int AS early_profit_or_bu_stop,
              COUNT(*)::int AS mature_closed_rows
            FROM policy p
            LEFT JOIN history h ON h.sentiment_key = p.pattern
            GROUP BY p.pattern, p.stale_hours, p.smart_hours, p.max_age_hours
            ORDER BY p.pattern
          `),
        // PnL-bucket breakdown: groups cancel_reason × pnl-at-cancel bucket to
        // show whether cancellations at different loss levels were correct.
        // early  = pnl > -1% (near-flat),  mid = -1% to -3%,  deep = below -3%.
        execute(sql`
            SELECT
              COALESCE(cancel_reason, 'null') AS cancel_reason,
              CASE
                WHEN pnl_percent > -1 THEN 'early'
                WHEN pnl_percent > -3 THEN 'mid'
                ELSE 'deep'
              END AS pnl_bucket,
              COUNT(*)::int AS cnt,
              ROUND(AVG(price_72h_after_exit_pct)::numeric, 2)::float4
                AS avg_72h_pct,
              ROUND(STDDEV(price_72h_after_exit_pct)::numeric, 2)::float4
                AS stddev_72h_pct,
              COUNT(*) FILTER (
                WHERE price_72h_after_exit_pct > ${thresholdPct}
              )::int AS recovered_threshold_plus,
              COUNT(*) FILTER (
                WHERE price_72h_after_exit_pct < -5
              )::int AS dropped_5plus
            FROM tracked_signals
            WHERE (cancel_reason LIKE '%smart%' OR cancel_reason LIKE '%stale%')
              AND price_72h_after_exit_pct IS NOT NULL
            GROUP BY cancel_reason, pnl_bucket
            ORDER BY cancel_reason, pnl_bucket
          `),
      ]);

      const summary = summaryResult.rows[0] ?? {};
      const measured = Number(summary.measured ?? 0);
      const recovered = Number(summary.recovered_10_plus ?? 0);
      res.json({
        ok: true,
        thresholdPct,
        summary: {
          total: Number(summary.total ?? 0),
          measured,
          pending: Number(summary.pending ?? 0),
          timestamped: Number(summary.timestamped ?? 0),
          observationTimeUnavailable: Number(
            summary.observation_time_unavailable ?? 0,
          ),
          recovered10Plus: recovered,
          recoveredRate:
            measured > 0 ? Number((recovered / measured).toFixed(4)) : null,
          avgObservedAtOrAfter72hPct:
            summary.avg_observed_at_or_after_72h_pct != null
              ? Number(summary.avg_observed_at_or_after_72h_pct)
              : null,
        },
        byReason: byReasonResult.rows,
        rows: rowsResult.rows,
        policyReplay: replayResult.rows.map((row) => ({
          ...row,
          policy: getCancellationPolicy(String(row.pattern)),
        })),
        // cancel_reason × pnl-bucket matrix (early/>-1%, mid/-1..-3%, deep/<-3%)
        // with 72h recovery stats.  Use this to spot incorrect cancellations by
        // loss depth: a high recovered_threshold_plus rate in a bucket signals
        // that the threshold / grace-hours for that reason may need tightening.
        pnlBucketAnalysis: pnlBucketResult.rows,
        notes: [
          "Deferred poor outcomes are historical cancelled/stop-loss rows that the new window would defer.",
          "Early profit/bu_stop is the mature outcome cohort inside the policy window; it is kept separate from cancellations.",
          "BE stop rows use bu_stop as their replay reason because they do not have a cancellation reason.",
          "Observed prices are ticker snapshots collected at or after the 72-hour threshold, not exact 72-hour measurements.",
          "Use observed_at and observation_hours_after_exit to audit timing; legacy snapshots without a timestamp are labeled observation_time_unavailable.",
          "Rows without an observed price remain pending, not negative or positive evidence.",
        ],
      });
    } catch (err) {
      req.log.error({ err }, "admin/tracker/cancellation-replay error");
      res.status(500).json({ error: String(err) });
    }
  };
}
