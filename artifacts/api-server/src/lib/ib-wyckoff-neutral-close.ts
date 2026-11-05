import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner 2026-11-05: the new Impulse Buy filter (Wyckoff phase «breakout without base» at the entry →
 * no signal) is applied to November retroactively. Every November IB whose restored Wyckoff reading
 * is breakout_without_base is reclassified neutrally: the open one is closed without PnL, the closed
 * ones leave the statistics and the total PnL (status reclassified, PnL cleared). Reviewed list of
 * production lineages (tracker id, signal id, symbol) from the export of 2026-11-05.
 */
export const IB_WYCKOFF_CLOSE_REASON = "impulse_buy_wyckoff_no_base_neutral_close";

/** Open position the filter would not have sent (closed without PnL). */
export const IB_WYCKOFF_OPEN_TARGETS = [
  [3122, 20523, "XAN-USDT", "impulse_buy"],
] as const;

/** Closed November trades the filter would not have sent (removed from statistics and PnL). */
export const IB_WYCKOFF_CLOSED_TARGETS = [
  [3256, 20909, "HEI-USDT"],
  [3254, 20903, "ESPORTS-USDT"],
  [3251, 20888, "ARIA-USDT"],
  [3233, 20837, "DOOD-USDT"],
  [3127, 20563, "G-USDT"],
  [3129, 20561, "MUBARAK-USDT"],
  [3126, 20557, "ESPORTS-USDT"],
  [3112, 20486, "EVAA-USDT"],
  [3113, 20487, "ESPORTS-USDT"],
  [3111, 20479, "CT-USDT"],
  [3101, 20455, "ZRO-USDT"],
  [3095, 20441, "LAB-USDT"],
  [3089, 20412, "GUN-USDT"],
  [3083, 20392, "NEAR-USDT"],
  [3080, 20379, "CT-USDT"],
  [3079, 20377, "EVAA-USDT"],
  [3078, 20375, "HUMA-USDT"],
  [3070, 20339, "PROVE-USDT"],
  [3068, 20329, "BEAM-USDT"],
  [3059, 20295, "APR-USDT"],
  [3058, 20294, "LAB-USDT"],
] as const;

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

export async function neutralizeIbWyckoffInTransaction(client: QueryClient): Promise<{ open: number; closed: number }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ib_wyckoff_neutral_close'))");
  let closed = 0;
  for (const [id, signalId, symbol] of IB_WYCKOFF_CLOSED_TARGETS) {
    const r = await client.query(
      `UPDATE tracked_signals
          SET status = 'reclassified', cancel_reason = $4,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND signal_id = $2 AND symbol = $3
          AND sentiment_key = 'impulse_buy'
          AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled', 'breakeven')
        RETURNING id`,
      [id, signalId, symbol, IB_WYCKOFF_CLOSE_REASON],
    );
    closed += r.rows.length;
  }
  const ids = IB_WYCKOFF_OPEN_TARGETS.map(([id]) => id);
  const locked = (await client.query(
    `SELECT id, symbol, status::text AS status, sentiment_key AS pattern, signal_id
       FROM tracked_signals WHERE id = ANY($1::integer[]) FOR UPDATE`,
    [ids],
  )).rows as { id: number; symbol: string; status: string; pattern: string; signal_id: number }[];
  const eligible = IB_WYCKOFF_OPEN_TARGETS.filter(([id, signalId, symbol]) => {
    const row = locked.find((x) => x.id === id);
    return row && row.symbol === symbol && row.signal_id === signalId && row.pattern === "impulse_buy"
      && (row.status === "active" || row.status === "in_run");
  });
  const open = eligible.length
    ? await closeGroup(client, eligible as unknown as Parameters<typeof closeGroup>[1], "impulse_buy", IB_WYCKOFF_CLOSE_REASON)
    : 0;
  return { open, closed };
}

/** Production boot only; already reclassified rows are skipped, so repeat boots are no-ops. */
export async function neutralizeIbWyckoffSignals(): Promise<{ open: number; closed: number }> {
  if (process.env.NODE_ENV !== "production") return { open: 0, closed: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const res = await neutralizeIbWyckoffInTransaction(client);
    await client.query("COMMIT");
    return res;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
