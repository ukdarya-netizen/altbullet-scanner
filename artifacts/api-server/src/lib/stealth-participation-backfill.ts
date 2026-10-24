import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { logger } from "./logger.js";

/**
 * Historical participation (OI, spot CVD, spot/futures taker) at the exact
 * crossing time of Stealth arms whose live telemetry was captured late or not
 * at all. Values come from CoinGlass 15m aggregated history and are stored in
 * decision_json.backfilledParticipation, clearly separate from live captures.
 */
import {
  getAllFuturesExchanges,
  getAllSpotExchanges,
} from "./coinglass-exchanges.js";

const SPOT_EXCHANGES = getAllSpotExchanges();
const FUT_EXCHANGES = getAllFuturesExchanges();
const STEP_MS = 15 * 60_000;
const ARMS_PER_RUN = 25;
const MAX_AGE_MS = 9 * 24 * 3600_000; // 15m history depth is ~10 days

type Row = Record<string, unknown> & { time: number };

async function fetchHistory(
  path: string,
  params: Record<string, string>,
  priority: "critical" | "high" | "normal" | "low" = "low",
): Promise<Row[] | null> {
  const key = getNextCgKey();
  if (!key) return null;
  const url = new URL(`https://open-api-v4.coinglass.com/api/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("limit", "1000");
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
      { priority, endpoint: path },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { code?: string; data?: Row[] };
    if (body.code !== "0") return null;
    return (body.data ?? []).map((r) => ({ ...r, time: Number(r.time) }));
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function closed(rows: Row[], at: number): Row[] {
  return rows.filter((r) => r.time + STEP_MS <= at);
}

function netBuyPct(rows: Row[], buy: string, sell: string): number | null {
  if (rows.length === 0) return null;
  let b = 0;
  let s = 0;
  for (const r of rows) {
    b += num(r[buy]) ?? 0;
    s += num(r[sell]) ?? 0;
  }
  return b + s > 0 ? ((b - s) / (b + s)) * 100 : null;
}

function oiChange(rows: Row[], back: number): number | null {
  if (rows.length <= back) return null;
  const last = num(rows[rows.length - 1]!.close);
  const prev = num(rows[rows.length - 1 - back]!.close);
  return last !== null && prev !== null && prev > 0
    ? ((last - prev) / prev) * 100
    : null;
}

function cvdFlag(rows: Row[], n: number): boolean | null {
  if (rows.length < n) return null;
  const slice = rows.slice(-n);
  let d = 0;
  for (const r of slice) {
    d += (num(r.agg_taker_buy_vol) ?? 0) - (num(r.agg_taker_sell_vol) ?? 0);
  }
  return d > 0;
}

export async function loadSymbol(base: string) {
  const [oi, cvd, spotTaker, futTaker] = await Promise.all([
    fetchHistory("futures/open-interest/aggregated-history", { symbol: base }),
    fetchHistory("spot/aggregated-cvd/history", {
      symbol: base,
      exchange_list: SPOT_EXCHANGES,
    }),
    fetchHistory("spot/aggregated-taker-buy-sell-volume/history", {
      symbol: base,
      exchange_list: SPOT_EXCHANGES,
    }),
    fetchHistory("futures/aggregated-taker-buy-sell-volume/history", {
      symbol: base,
      exchange_list: FUT_EXCHANGES,
    }),
  ]);
  return { oi, cvd, spotTaker, futTaker };
}

export function computeParticipationAt(
  data: Awaited<ReturnType<typeof loadSymbol>>,
  at: number,
) {
  const oi = data.oi ? closed(data.oi, at) : [];
  const cvd = data.cvd ? closed(data.cvd, at) : [];
  const st = data.spotTaker ? closed(data.spotTaker, at) : [];
  const ft = data.futTaker ? closed(data.futTaker, at) : [];
  const fresh = (rows: Row[]) =>
    rows.length > 0 && at - (rows[rows.length - 1]!.time + STEP_MS) <= STEP_MS;
  return {
    oi: fresh(oi)
      ? {
          oi30m: oiChange(oi, 2),
          oi1h: oiChange(oi, 4),
          oi4h: oiChange(oi, 16),
        }
      : null,
    cvd: fresh(cvd)
      ? {
          cvd15m: cvdFlag(cvd, 1),
          cvd30m: cvdFlag(cvd, 2),
          cvd1h: cvdFlag(cvd, 4),
          cvd4h: cvdFlag(cvd, 16),
        }
      : null,
    spotTakerNetBuyPct1h: fresh(st)
      ? netBuyPct(
          st.slice(-4),
          "aggregated_buy_volume_usd",
          "aggregated_sell_volume_usd",
        )
      : null,
    futuresTakerNetBuyPct1h: fresh(ft)
      ? netBuyPct(
          ft.slice(-4),
          "aggregated_buy_volume_usd",
          "aggregated_sell_volume_usd",
        )
      : null,
  };
}

/** One bounded pass; arms already backfilled are skipped (idempotent). */
export async function runStealthParticipationBackfillCycle(): Promise<number> {
  const since = new Date(Date.now() - MAX_AGE_MS);
  const rows = (
    await db.execute(sql`
      SELECT id, symbol, extract(epoch from first_cross_at) * 1000 AS cross_ms
      FROM stealth_breakout_armed_setups
      WHERE first_cross_at IS NOT NULL
        AND first_cross_at >= ${since}
        AND first_cross_at <= now() - interval '30 minutes'
        AND NOT (COALESCE(decision_json, '{}'::jsonb) ? 'backfilledParticipation')
      ORDER BY first_cross_at DESC
      LIMIT ${ARMS_PER_RUN}
    `)
  ).rows as { id: number; symbol: string; cross_ms: string }[];
  if (rows.length === 0) return 0;
  const cache = new Map<string, Awaited<ReturnType<typeof loadSymbol>>>();
  let written = 0;
  for (const row of rows) {
    const base = applyCgAlias(row.symbol.replace(/-?USDT$/i, ""));
    let data = cache.get(base);
    if (!data) {
      data = await loadSymbol(base);
      cache.set(base, data);
    }
    // A fully failed fetch (network/429) is retried next cycle, not recorded.
    if (!data.oi && !data.cvd && !data.spotTaker && !data.futTaker) continue;
    const at = Math.round(Number(row.cross_ms));
    const result = {
      source: "coinglass_15m_history",
      kind: "historical_backfill_not_live_capture",
      crossingAt: at,
      computedAt: Date.now(),
      ...computeParticipationAt(data, at),
    };
    await db.execute(sql`
      UPDATE stealth_breakout_armed_setups
      SET decision_json = COALESCE(decision_json, '{}'::jsonb) ||
        jsonb_build_object('backfilledParticipation', ${JSON.stringify(result)}::jsonb)
      WHERE id = ${row.id}
    `);
    written++;
  }
  logger.info(
    { written, picked: rows.length },
    "Stealth participation backfill",
  );
  return written;
}

/**
 * Aggregated futures OI change over the 1h (4 x 15m) ending at the breakout
 * candle close. Same computation as the analysis behind the Stealth OI filter.
 * Returns null when history is unavailable or stale (caller fails closed).
 */
export async function fetchOi1hChangeAt(
  base: string,
  at: number,
): Promise<number | null> {
  return fetchOiChangeAt(base, at, 4);
}

/** Aggregated futures OI change over the 4h (16 x 15m) ending at the breakout candle close. */
export async function fetchOi4hChangeAt(
  base: string,
  at: number,
): Promise<number | null> {
  return fetchOiChangeAt(base, at, 16);
}

async function fetchOiChangeAt(
  base: string,
  at: number,
  bars: number,
): Promise<number | null> {
  const oi = await fetchHistory(
    "futures/open-interest/aggregated-history",
    { symbol: base },
    "high",
  );
  if (!oi) return null;
  const rows = closed(oi, at);
  if (rows.length === 0) return null;
  if (at - (rows[rows.length - 1]!.time + STEP_MS) > STEP_MS) return null;
  return oiChange(rows, bars);
}
