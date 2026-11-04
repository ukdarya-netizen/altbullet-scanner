import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner 2026-10-20: the PLM lower p24h bound (>= 5%) is restored. These open
 * (active, no first target reached) PLM positions were fired with p24h below 5%
 * and would not pass the current gate; they are closed neutrally (no exit fill,
 * no PnL). In-run positions already earned profit protection and are not
 * touched.
 */
export const PLM_P24H_CLOSE_REASON = "plm_p24h_lower_bound_neutral_close";

export const PLM_P24H_CLOSE_TARGETS = [
  [2571, 19075, "PARTI-USDT"],
  [2580, 19095, "BANK-USDT"],
  [2582, 19099, "TST-USDT"],
  [2592, 19119, "LUMIA-USDT"],
] as const;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function neutralizePlmP24hInTransaction(
  client: QueryClient,
): Promise<number> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('plm_p24h_neutral_close'))",
  );
  const eligible: Array<readonly [number, number, string]> = [];
  for (const target of PLM_P24H_CLOSE_TARGETS) {
    const [id, signalId, symbol] = target;
    const rows = (
      await client.query(
        `SELECT id FROM tracked_signals
          WHERE id = $1 AND signal_id = $2 AND symbol = $3
            AND sentiment_key = 'price_led_momentum'
            AND status::text = 'active'
            AND runner_state IS NULL AND core_closed_at IS NULL
            FOR UPDATE`,
        [id, signalId, symbol],
      )
    ).rows;
    if (rows.length > 0) eligible.push(target);
  }
  if (eligible.length === 0) return 0;
  return closeGroup(
    client,
    eligible.map(([id, signalId, symbol]) => [
      id,
      signalId,
      symbol,
      "price_led_momentum",
    ]) as never,
    "price_led_momentum",
    PLM_P24H_CLOSE_REASON,
  );
}

/** Production boot only; advisory lock and the status filter make repeats no-ops. */
export async function neutralizePlmP24hSignals(): Promise<number> {
  if (process.env.NODE_ENV !== "production") return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const count = await neutralizePlmP24hInTransaction(client);
    await client.query("COMMIT");
    return count;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
