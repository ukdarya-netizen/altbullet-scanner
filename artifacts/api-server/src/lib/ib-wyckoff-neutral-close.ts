import { pool } from "@workspace/db";
import { closeGroup } from "./impulse-buy-filter-neutral-close.js";

/**
 * Owner 2026-11-05: the new filters are applied to November retroactively.
 *  - Impulse Buy: Wyckoff phase «breakout without base» at the entry → no signal.
 *  - Stealth (1H range breakout): the 3 hourly bars before the breakout all grey on Welkin VSA
 *    (BingX volume) → no signal.
 * Every November signal the filter would have rejected is reclassified neutrally: open positions
 * are closed without PnL, closed ones leave the statistics and the page PnL. The original outcome
 * (status, PnL, exit price, close time) is kept in decision_metrics.beforeNeutralClose, so nothing is
 * lost for analysis. Reviewed production lineages (tracker id, signal id, symbol) from the export of
 * 2026-11-05.
 */
export const IB_WYCKOFF_CLOSE_REASON = "impulse_buy_wyckoff_no_base_neutral_close";
export const STEALTH_WELKIN_CLOSE_REASON = "stealth_welkin_empty_3h_neutral_close";

type Target = readonly [number, number, string];

export const IB_WYCKOFF_OPEN_TARGETS: readonly Target[] = [[3122, 20523, "XAN-USDT"]];
export const IB_WYCKOFF_CLOSED_TARGETS: readonly Target[] = [
  [3256, 20909, "HEI-USDT"], [3254, 20903, "ESPORTS-USDT"], [3251, 20888, "ARIA-USDT"],
  [3233, 20837, "DOOD-USDT"], [3127, 20563, "G-USDT"], [3129, 20561, "MUBARAK-USDT"],
  [3126, 20557, "ESPORTS-USDT"], [3112, 20486, "EVAA-USDT"], [3113, 20487, "ESPORTS-USDT"],
  [3111, 20479, "CT-USDT"], [3101, 20455, "ZRO-USDT"], [3095, 20441, "LAB-USDT"],
  [3089, 20412, "GUN-USDT"], [3083, 20392, "NEAR-USDT"], [3080, 20379, "CT-USDT"],
  [3079, 20377, "EVAA-USDT"], [3078, 20375, "HUMA-USDT"], [3070, 20339, "PROVE-USDT"],
  [3068, 20329, "BEAM-USDT"], [3059, 20295, "APR-USDT"], [3058, 20294, "LAB-USDT"],
];

export const STEALTH_WELKIN_OPEN_TARGETS: readonly Target[] = [
  [3283, 21072, "NOMINA-USDT"], [3277, 21045, "FLOCK-USDT"], [3263, 20944, "AERO-USDT"],
  [3261, 20926, "WOTAMALAILE-USDT"], [3208, 20779, "AR-USDT"], [3197, 20751, "WOO-USDT"],
  [3194, 20743, "DOGS-USDT"], [3186, 20725, "NIGHT-USDT"], [3180, 20711, "ENJ-USDT"],
  [3167, 20681, "PIXEL-USDT"], [3159, 20663, "GWEI-USDT"], [3156, 20657, "ROBO-USDT"],
  [3154, 20653, "RVN-USDT"], [3151, 20646, "GOAT-USDT"], [3143, 20627, "USELESS-USDT"],
  [3096, 20443, "GRVT-USDT"], [3032, 20228, "TA-USDT"], [3024, 20215, "JST-USDT"],
];
export const STEALTH_WELKIN_CLOSED_TARGETS: readonly Target[] = [
  [3235, 20847, "CGPT-USDT"], [3162, 20671, "SKR-USDT"], [3098, 20444, "NOMINA-USDT"],
  [3097, 20449, "AMEMECOIN-USDT"], [3091, 20413, "COLLECT-USDT"], [3050, 20271, "RON-USDT"],
  [3049, 20269, "GUA-USDT"], [3046, 20261, "ARK-USDT"], [3042, 20254, "VEIL-USDT"],
  [3041, 20251, "TAKE-USDT"], [3040, 20250, "CORE-USDT"], [3030, 20224, "TRIA-USDT"],
  [3029, 20221, "HEI-USDT"], [3023, 20211, "AGI-USDT"], [3022, 20210, "BUN-USDT"],
  [3020, 20203, "WLFI-USDT"], [3003, 20159, "MOVR-USDT"], [2997, 20153, "VRAX-USDT"],
  [2994, 20151, "TAG-USDT"], [2986, 20133, "KOMA-USDT"], [2983, 20121, "MUBARAK-USDT"],
  [2976, 20109, "BRETT-USDT"], [2961, 20081, "REZ-USDT"],
];

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
};

/** Keeps the original outcome before the row is neutralized (idempotent: first value wins). */
const KEEP_ORIGINAL = `decision_metrics = COALESCE(decision_metrics, '{}'::jsonb) || CASE
    WHEN COALESCE(decision_metrics, '{}'::jsonb) ? 'beforeNeutralClose' THEN '{}'::jsonb
    ELSE jsonb_build_object('beforeNeutralClose', jsonb_build_object(
      'status', status::text, 'pnlPercent', pnl_percent, 'exitPrice', exit_price,
      'closedAt', closed_at, 'peakPrice', peak_price, 'reason', $5::text, 'at', NOW()))
  END`;

async function neutralize(
  client: QueryClient,
  pattern: "impulse_buy" | "stealth_breakout",
  reason: string,
  open: readonly Target[],
  closedTargets: readonly Target[],
): Promise<{ open: number; closed: number }> {
  let closed = 0;
  for (const [id, signalId, symbol] of closedTargets) {
    const r = await client.query(
      `UPDATE tracked_signals
          SET ${KEEP_ORIGINAL},
              status = 'reclassified', cancel_reason = $4,
              exit_price = NULL, pnl_percent = NULL, closed_at = NULL,
              updated_at = NOW()
        WHERE id = $1 AND signal_id = $2 AND symbol = $3
          AND sentiment_key = $6
          AND status::text IN ('stop_loss', 'bu_stop', 'profit', 'expired', 'cancelled', 'breakeven')
        RETURNING id`,
      [id, signalId, symbol, reason, reason, pattern],
    );
    closed += r.rows.length;
  }
  const ids = open.map(([id]) => id);
  const locked = (await client.query(
    `SELECT id, symbol, status::text AS status, sentiment_key AS pattern, signal_id
       FROM tracked_signals WHERE id = ANY($1::integer[]) FOR UPDATE`,
    [ids],
  )).rows as { id: number; symbol: string; status: string; pattern: string; signal_id: number }[];
  const eligible = open.filter(([id, signalId, symbol]) => {
    const row = locked.find((x) => x.id === id);
    return row && row.symbol === symbol && row.signal_id === signalId && row.pattern === pattern
      && (row.status === "active" || row.status === "in_run");
  });
  if (eligible.length === 0) return { open: 0, closed };
  await client.query(
    `UPDATE tracked_signals SET ${KEEP_ORIGINAL}
      WHERE id = ANY($1::integer[]) AND $2::int IS NOT NULL AND $3::int IS NOT NULL AND $4::text IS NOT NULL`,
    [eligible.map(([id]) => id), 0, 0, "", reason],
  );
  const n = await closeGroup(
    client,
    eligible.map(([id, signalId, symbol]) => [id, signalId, symbol, pattern]) as unknown as Parameters<typeof closeGroup>[1],
    pattern,
    reason,
  );
  return { open: n, closed };
}

export async function neutralizeNewFilterRejectsInTransaction(client: QueryClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('ib_wyckoff_neutral_close'))");
  const ib = await neutralize(client, "impulse_buy", IB_WYCKOFF_CLOSE_REASON, IB_WYCKOFF_OPEN_TARGETS, IB_WYCKOFF_CLOSED_TARGETS);
  const stealth = await neutralize(client, "stealth_breakout", STEALTH_WELKIN_CLOSE_REASON, STEALTH_WELKIN_OPEN_TARGETS, STEALTH_WELKIN_CLOSED_TARGETS);
  return { ibOpen: ib.open, ibClosed: ib.closed, stealthOpen: stealth.open, stealthClosed: stealth.closed };
}

/** Production boot only; already reclassified rows are skipped, so repeat boots are no-ops. */
export async function neutralizeIbWyckoffSignals() {
  if (process.env.NODE_ENV !== "production") return { ibOpen: 0, ibClosed: 0, stealthOpen: 0, stealthClosed: 0 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const res = await neutralizeNewFilterRejectsInTransaction(client);
    await client.query("COMMIT");
    return res;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
