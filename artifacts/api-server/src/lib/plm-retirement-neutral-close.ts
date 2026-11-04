import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner decision: Price Led Momentum is removed from trading. Every open (active
 * or in_run) PLM position is closed neutrally: no exit fill, no PnL, no closed_at,
 * outside outcome statistics and the calculator. Rows are never deleted.
 */
export const PLM_RETIREMENT_CLOSE_REASON = "plm_retirement_neutral_close";

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function neutralizeOpenPlmInTransaction(
  client: QueryClient,
): Promise<number> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('plm_retirement_neutral_close'))",
  );
  const locked = (await client.query(
    `SELECT id, signal_id, symbol
       FROM tracked_signals
      WHERE sentiment_key = 'price_led_momentum'
        AND status::text IN ('active', 'in_run')
      ORDER BY id
      FOR UPDATE`,
  )) as {
    rows: { id: number; signal_id: number; symbol: string }[];
  };
  // PLM never uses the runner policy (impulse_buy only), so every open row is
  // a plain position; core_* columns are left as stored if ever present.
  const eligible = locked.rows;
  if (eligible.length === 0) return 0;
  return closeGroup(
    client,
    eligible.map((r) => [
      r.id,
      r.signal_id,
      r.symbol,
      "price_led_momentum",
    ]) as never,
    "price_led_momentum",
    PLM_RETIREMENT_CLOSE_REASON,
  );
}

/** Production boot only; advisory lock and status filter make repeats no-ops. */
export async function neutralizeOpenPlmSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const count = await neutralizeOpenPlmInTransaction(client);
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
