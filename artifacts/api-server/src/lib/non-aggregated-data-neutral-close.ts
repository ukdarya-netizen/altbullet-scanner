import { pool } from "@workspace/db";

export const NON_AGGREGATED_DATA_NEUTRAL_CLOSE_REASON =
  "non_aggregated_data_neutral_close";

// Owner-ordered 2026-10-03: every position open before the switch to
// aggregated taker/CVD data is closed neutrally (no PnL, no outcome).
export const NON_AGGREGATED_DATA_NEUTRAL_CLOSE_TARGETS = [
  [2038, 15358, "PROM-USDT", "liquidation_cascade"],
  [2046, 15488, "OP-USDT", "liquidation_cascade"],
  [2054, 15904, "KSM-USDT", "price_led_momentum"],
  [2067, 16018, "AVAX-USDT", "liquidation_cascade"],
  [2072, 16174, "JCT-USDT", "price_led_momentum"],
  [2074, 16426, "LTC-USDT", "liquidation_cascade"],
  [2079, 16706, "APT-USDT", "liquidation_cascade"],
  [2080, 16782, "CGPT-USDT", "price_led_momentum"],
  [2086, 17074, "AKT-USDT", "impulse_buy"],
  [2093, 17109, "ATOM-USDT", "liquidation_cascade"],
  [2094, 17120, "ARC-USDT", "whale_watch"],
  [2104, 17174, "ENA-USDT", "neon_support_bounce"],
  [2105, 17175, "ORDI-USDT", "liquidation_cascade"],
  [2106, 17176, "GRT-USDT", "liquidation_cascade"],
  [2107, 17177, "XLM-USDT", "liquidation_cascade"],
  [2108, 17184, "DASH-USDT", "liquidation_cascade"],
  [2109, 17189, "BTC-USDT", "liquidation_cascade"],
  [2111, 17199, "LDO-USDT", "liquidation_cascade"],
  [2112, 17200, "1000SHIB-USDT", "liquidation_cascade"],
  [2114, 17204, "1000BONK-USDT", "liquidation_cascade"],
  [2115, 17208, "CASHCAT-USDT", "liquidation_cascade"],
  [2116, 17209, "MARSCOIN-USDT", "liquidation_cascade"],
  [2119, 17220, "LAB-USDT", "liquidation_cascade"],
  [2125, 17240, "2Z-USDT", "liquidation_cascade"],
  [2127, 17245, "GALA-USDT", "price_led_momentum"],
  [2128, 17247, "BIGTIME-USDT", "stealth_breakout"],
  [2129, 17253, "ASTER-USDT", "liquidation_cascade"],
  [2130, 17254, "BEAT-USDT", "liquidation_cascade"],
  [2131, 17255, "WLFI-USDT", "liquidation_cascade"],
  [2134, 17262, "USELESS-USDT", "liquidation_cascade"],
  [2135, 17265, "ETHFI-USDT", "liquidation_cascade"],
  [2136, 17268, "COTI-USDT", "liquidation_cascade"],
  [2137, 17299, "RESOLV-USDT", "liquidation_cascade"],
] as const;

type LockedRow = {
  id: number;
  signal_id: number;
  symbol: string;
  tracker_pattern: string;
  status: string;
  runner_state: string | null;
  core_closed_at: Date | null;
};

export type NonAggregatedCloseResult = {
  moved: number;
  skippedTerminal: number[];
  partialRunners: number[];
  missing: number[];
};

/**
 * Neutralizes only the exact reviewed rows that are still open. Rows that
 * already ended or hold a realized partial (runner) keep their outcome.
 */
export async function neutralizeNonAggregatedOpenPositions(): Promise<NonAggregatedCloseResult> {
  const empty = {
    moved: 0,
    skippedTerminal: [],
    partialRunners: [],
    missing: [],
  };
  if (process.env.NODE_ENV !== "production") return empty;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('non_aggregated_data_neutral_close'))",
    );
    const targets = NON_AGGREGATED_DATA_NEUTRAL_CLOSE_TARGETS;
    const locked = await client.query(
      `SELECT t.id, t.signal_id, t.symbol, t.sentiment_key AS tracker_pattern,
              t.status::text AS status, t.runner_state, t.core_closed_at
         FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
        FOR UPDATE OF t`,
      [targets.map(([id]) => id)],
    );
    const rows = locked.rows as LockedRow[];
    const eligible: LockedRow[] = [];
    const skippedTerminal: number[] = [];
    const partialRunners: number[] = [];
    const missing: number[] = [];
    for (const [trackedId, signalId, symbol, pattern] of targets) {
      const row = rows.find((r) => r.id === trackedId);
      if (!row) {
        missing.push(trackedId);
        continue;
      }
      if (
        row.signal_id !== signalId ||
        row.symbol !== symbol ||
        row.tracker_pattern !== pattern
      ) {
        throw new Error(
          `Non-aggregated neutral close: lineage mismatch for ${trackedId}`,
        );
      }
      if (row.status !== "active" && row.status !== "in_run") {
        skippedTerminal.push(trackedId);
        continue;
      }
      if (row.core_closed_at !== null || row.runner_state !== null) {
        partialRunners.push(trackedId);
        continue;
      }
      eligible.push(row);
    }
    if (eligible.length === 0) {
      await client.query("COMMIT");
      return { moved: 0, skippedTerminal, partialRunners, missing };
    }
    const trackedIds = eligible.map((r) => r.id);
    const signalIds = eligible.map((r) => r.signal_id);
    const reason = NON_AGGREGATED_DATA_NEUTRAL_CLOSE_REASON;
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              trailing_stop_level = NULL, trailing_stop_armed_at = NULL,
              last_smart_cancel_check_at = NULL,
              pending_milestone = NULL, pending_milestone_kind = NULL,
              pending_milestone_price = NULL, pending_milestone_trailing_stop = NULL,
              pending_milestone_status = NULL, pending_milestone_lease_until = NULL,
              updated_at = NOW()
        WHERE id = ANY($1::integer[]) AND status IN ('active', 'in_run')
        RETURNING id`,
      [trackedIds, reason],
    );
    if (updated.rows.length !== eligible.length)
      throw new Error(
        "Non-aggregated neutral close: tracker update incomplete",
      );

    await client.query(
      `UPDATE stealth_breakout_armed_setups
          SET status = 'reclassified', terminal_reason = $2, updated_at = NOW()
        WHERE fired_signal_id = ANY($1::integer[]) AND status = 'fired'`,
      [signalIds, reason],
    );
    await client.query(
      `UPDATE milestone_notification_deliveries
          SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
              last_error = $2
        WHERE tracked_signal_id = ANY($1::integer[])
          AND status IN ('ready', 'retry', 'failed')`,
      [trackedIds, reason],
    );
    await client.query(
      `WITH abandoned AS (
         UPDATE telegram_photo_deliveries p
            SET status = 'abandoned', lease_until = NULL, claim_token = NULL,
                last_error = $3, updated_at = NOW()
          WHERE (p.status IN ('ready', 'retry', 'failed')
                 OR (p.status = 'processing' AND p.send_attempted_at IS NULL))
            AND EXISTS (
              SELECT 1 FROM unnest($1::integer[], $2::integer[])
                AS x(tracked_id, signal_id)
               WHERE p.dedup_key = 'signal:' || x.signal_id::text
                  OR p.dedup_key LIKE 'position:' || x.tracked_id::text || ':%'
                  OR p.dedup_key LIKE 'milestone:v3:' || x.tracked_id::text || ':%'
            )
         RETURNING p.dedup_key
       )
       UPDATE telegram_delivery_events e
          SET status = 'attention',
              attention_at = COALESCE(e.attention_at, NOW()),
              last_error = $3, updated_at = NOW()
        WHERE e.event_key IN (SELECT dedup_key FROM abandoned)
          AND e.status <> 'delivered'`,
      [trackedIds, signalIds, reason],
    );
    // A queued relay must not open a trade after its dashboard position closes.
    // Already accepted external trades are not changed by this operation.
    const relayTable = await client.query(
      "SELECT to_regclass('trading_signal_deliveries') AS relation",
    );
    if ((relayTable.rows[0] as { relation: string | null }).relation !== null) {
      await client.query(
        `UPDATE trading_signal_deliveries
            SET status = 'quarantined', claim_token = NULL, claim_until = NULL,
                last_error = $2
          WHERE source_signal_id = ANY($1::integer[]) AND status = 'pending'`,
        [signalIds, reason],
      );
    }
    await client.query("COMMIT");
    return { moved: eligible.length, skippedTerminal, partialRunners, missing };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
