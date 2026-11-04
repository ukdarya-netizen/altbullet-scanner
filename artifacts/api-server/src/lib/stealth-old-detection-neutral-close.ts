import { pool } from "@workspace/db";
import { getFutureTicker } from "./bingx.js";

/**
 * Owner 2026-10-28: open Stealth positions from the retired quiet-zone
 * detection that would not pass the new fresh-24H-high filters are closed
 * without affecting statistics. Exact production ids reviewed on 2026-10-28
 * (open, stealth_detection_method = quiet_zone_breakout), evaluated with
 * evaluateFreshHighBreakout on the 1H candles around detection. ENA (2871) and
 * IOST (2912) pass the filters and stay open. ARX (2901) and M (2917) had
 * already reached +10%: owner asked to close them in profit at the current
 * market price (status `profit`, real PnL); if the price is not above entry
 * they stay open. Rows get status `cancelled` with
 * neutral PnL; originals are kept as JSON in stealth_old_detection_close_backup.
 * Later signals are never touched.
 */
export const STEALTH_OLD_DETECTION_CLOSE_REASON =
  "stealth_old_detection_not_passing_fresh_high_filters";

export const STEALTH_OLD_DETECTION_CLOSE_IDS = [
  2877, 2880, 2888, 2893, 2896, 2897, 2899, 2909, 2913, 2921, 2925, 2926, 2927, 2928, 2930, 2932, 2938, 2941,
] as const;

export const STEALTH_OLD_DETECTION_PROFIT_IDS = [2901, 2917] as const;

export async function neutralizeStealthOldDetectionSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const prices = new Map<number, number>();
  for (const id of STEALTH_OLD_DETECTION_PROFIT_IDS) {
    const sym = id === 2901 ? "ARX-USDT" : "M-USDT";
    const t = await getFutureTicker(sym);
    const p = Number(t?.lastPrice);
    if (Number.isFinite(p) && p > 0) prices.set(id, p);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('stealth_old_detection_neutral_close'))",
    );
    await client.query(`CREATE TABLE IF NOT EXISTS stealth_old_detection_close_backup (
      tracked_id integer PRIMARY KEY,
      original jsonb NOT NULL,
      neutralized_at timestamptz NOT NULL DEFAULT now()
    )`);
    const ids = [...STEALTH_OLD_DETECTION_CLOSE_IDS];
    await client.query(
      `INSERT INTO stealth_old_detection_close_backup (tracked_id, original)
       SELECT t.id, to_jsonb(t) FROM tracked_signals t
        WHERE t.id = ANY($1::integer[])
          AND t.sentiment_key = 'stealth_breakout'
          AND t.stealth_detection_method = 'quiet_zone_breakout'
          AND t.status IN ('active', 'in_run')
       ON CONFLICT (tracked_id) DO NOTHING`,
      [ids],
    );
    const updated = await client.query(
      `UPDATE tracked_signals
          SET status = 'cancelled', cancel_reason = $2,
              exit_price = NULL, pnl_percent = NULL,
              closed_at = NOW(), updated_at = NOW()
        WHERE id = ANY($1::integer[])
          AND sentiment_key = 'stealth_breakout'
          AND stealth_detection_method = 'quiet_zone_breakout'
          AND status IN ('active', 'in_run')
        RETURNING id`,
      [ids, STEALTH_OLD_DETECTION_CLOSE_REASON],
    );
    let closed = updated.rows.length;
    for (const [id, price] of prices) {
      await client.query(
        `INSERT INTO stealth_old_detection_close_backup (tracked_id, original)
         SELECT t.id, to_jsonb(t) FROM tracked_signals t
          WHERE t.id = $1 AND t.status = 'in_run'
         ON CONFLICT (tracked_id) DO NOTHING`,
        [id],
      );
      const r = await client.query(
        `UPDATE tracked_signals
            SET status = 'profit', exit_price = $2,
                pnl_percent = ($2 / entry_price - 1) * 100,
                cancel_reason = NULL, closed_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND sentiment_key = 'stealth_breakout'
            AND stealth_detection_method = 'quiet_zone_breakout'
            AND status = 'in_run' AND entry_price > 0 AND $2 > entry_price
          RETURNING id`,
        [id, price],
      );
      closed += r.rows.length;
    }
    await client.query("COMMIT");
    return closed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
