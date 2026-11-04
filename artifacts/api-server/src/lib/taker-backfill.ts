import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getAggFuturesTakerHistory } from "./coinglass_taker.js";
import { getAggSpotTakerHistory } from "./coinglass_spot_taker.js";
import { logger } from "./logger.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { getKlinesRange } from "./bingx.js";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const SYMBOLS_PER_RUN = 10;
const HISTORY_CANDLES = 200; // ~50h of 15m candles
const LOOKBACK_HOURS = 48;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/** Aggregated OI 30m closes (oldest → newest); null when unavailable. */
async function getAggOiHistory(
  bingxSymbol: string,
): Promise<{ time: number; close: number }[] | null> {
  const key = getNextCgKey();
  if (!key) return null;
  const base = bingxSymbol.replace(/-?USDT$/i, "").toUpperCase();
  try {
    const res = await cgTimedFetch(
      `https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history?symbol=${encodeURIComponent(base)}&interval=30m&limit=200`,
      {
        headers: { "CG-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
      { endpoint: "futures/open-interest/aggregated-history" },
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      code?: string;
      data?: { time: number; close: string | number }[];
    };
    if (String(j.code) !== "0" || !j.data?.length) return null;
    return j.data.map((r) => ({ time: r.time, close: Number(r.close) }));
  } catch {
    return null;
  }
}

function pctBack(
  series: { time: number; close: number }[] | null,
  atMs: number,
  stepMs: number,
  back: number,
): number | null {
  if (!series) return null;
  const i = series.findIndex((c) => c.time === atMs);
  if (i < back || i < 0) return null;
  const a = series[i]!.close;
  const b = series[i - back]!.close;
  return a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b)
    ? (a / b - 1) * 100
    : null;
}

type Candle = { time: number; buy: number; sell: number };
type Row = { id: number; decision_at: string };

function netBuyAt(candles: Candle[] | null, bucketMs: number): number | null {
  const c = candles?.find((x) => x.time === bucketMs);
  if (!c) return null;
  const total = c.buy + c.sell;
  return total > 0 ? ((c.buy - c.sell) / total) * 100 : null;
}

/**
 * Owner policy: taker is stored for every decision. Rows whose live snapshot
 * missed taker get the aggregated CoinGlass 15m candle of the decision's own
 * bucket, labelled `takerBackfill`. One attempt per row; absent candles stay
 * null and are never reconstructed.
 */
export async function backfillDecisionTaker(): Promise<{
  symbols: number;
  rows: number;
  filled: number;
}> {
  const symbols = (
    await db.execute<{ symbol: string }>(sql`
      SELECT symbol FROM pattern_decision_snapshots
      WHERE decision_at > now() - make_interval(hours => ${LOOKBACK_HOURS})
        AND decision_at < now() - interval '15 minutes'
        AND NOT (entry_metrics ? 'takerBackfill')
        AND (entry_metrics->'flowSnapshot'->>'netBuyPct' IS NULL
          OR entry_metrics->'flowSnapshot'->>'spotTakerNetBuy' IS NULL
          OR entry_metrics->'flowSnapshot'->>'oi30m' IS NULL
          OR entry_metrics->'flowSnapshot'->>'price1h' IS NULL)
      GROUP BY symbol ORDER BY min(decision_at) ASC
      LIMIT ${SYMBOLS_PER_RUN}`)
  ).rows.map((r) => r.symbol);
  let rowsTotal = 0;
  let filled = 0;
  for (const symbol of symbols) {
    const [fut, spot] = await Promise.all([
      getAggFuturesTakerHistory(symbol, HISTORY_CANDLES).catch(() => null),
      getAggSpotTakerHistory(symbol, HISTORY_CANDLES).catch(() => null),
    ]);
    const oiSeries = await getAggOiHistory(symbol);
    const now = Date.now();
    const klines = await getKlinesRange(
      symbol,
      "15m",
      now - (LOOKBACK_HOURS + 4) * 3_600_000,
      now,
    ).catch(() => []);
    const px = klines.map((k) => ({ time: k.time, close: Number(k.close) }));
    const rows = (
      await db.execute<Row>(sql`
        SELECT id, decision_at FROM pattern_decision_snapshots
        WHERE symbol = ${symbol}
          AND decision_at > now() - make_interval(hours => ${LOOKBACK_HOURS})
          AND decision_at < now() - interval '15 minutes'
          AND NOT (entry_metrics ? 'takerBackfill')
          AND (entry_metrics->'flowSnapshot'->>'netBuyPct' IS NULL
            OR entry_metrics->'flowSnapshot'->>'spotTakerNetBuy' IS NULL
            OR entry_metrics->'flowSnapshot'->>'oi30m' IS NULL
            OR entry_metrics->'flowSnapshot'->>'price1h' IS NULL)
        LIMIT 2000`)
    ).rows;
    for (const row of rows) {
      rowsTotal++;
      const at = new Date(row.decision_at).getTime();
      const bucket = Math.floor(at / FIFTEEN_MINUTES_MS) * FIFTEEN_MINUTES_MS;
      const f = netBuyAt(fut, bucket);
      const s = netBuyAt(spot, bucket);
      const oiBucket =
        Math.floor(at / THIRTY_MINUTES_MS) * THIRTY_MINUTES_MS -
        THIRTY_MINUTES_MS;
      const extra: Record<string, number> = {};
      const put = (k: string, v: number | null) => {
        if (v !== null && Number.isFinite(v)) extra[k] = v;
      };
      put("oi30m", pctBack(oiSeries, oiBucket, THIRTY_MINUTES_MS, 1));
      put("oi1h", pctBack(oiSeries, oiBucket, THIRTY_MINUTES_MS, 2));
      put("oi4h", pctBack(oiSeries, oiBucket, THIRTY_MINUTES_MS, 8));
      put("oi24h", pctBack(oiSeries, oiBucket, THIRTY_MINUTES_MS, 48));
      const pxBucket = bucket - FIFTEEN_MINUTES_MS;
      put("price1h", pctBack(px, pxBucket, FIFTEEN_MINUTES_MS, 4));
      put("price3h", pctBack(px, pxBucket, FIFTEEN_MINUTES_MS, 12));
      if (f !== null || s !== null || Object.keys(extra).length) filled++;
      const marker = {
        source: "coinglass_aggregated_candle_backfill",
        candleAt: bucket,
        fetchedAt: Date.now(),
        oiBucket,
        extraKeys: Object.keys(extra),
        futuresFilled: f !== null,
        spotFilled: s !== null,
      };
      await db.execute(sql`
        UPDATE pattern_decision_snapshots
        SET entry_metrics = coalesce(entry_metrics, '{}'::jsonb)
          || jsonb_build_object('takerBackfill', ${JSON.stringify(marker)}::jsonb)
          || jsonb_build_object('flowSnapshot',
            coalesce(entry_metrics->'flowSnapshot', '{}'::jsonb)
            || CASE WHEN entry_metrics->'flowSnapshot'->>'netBuyPct' IS NULL
                      AND ${f}::float8 IS NOT NULL
                    THEN jsonb_build_object('netBuyPct', ${f}::float8)
                    ELSE '{}'::jsonb END
            || CASE WHEN entry_metrics->'flowSnapshot'->>'spotTakerNetBuy' IS NULL
                      AND ${s}::float8 IS NOT NULL
                    THEN jsonb_build_object('spotTakerNetBuy', ${s}::float8,
                      'spotTakerDominance',
                      CASE WHEN ${s}::float8 > 2 THEN 'buy'
                           WHEN ${s}::float8 < -2 THEN 'sell' ELSE 'neutral' END)
                    ELSE '{}'::jsonb END
            || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                FROM jsonb_each(${JSON.stringify(extra)}::jsonb) e
                WHERE entry_metrics->'flowSnapshot'->>e.key IS NULL))
        WHERE id = ${row.id}`);
    }
  }
  logger.info(
    { symbols: symbols.length, rows: rowsTotal, filled },
    "Decision taker backfill completed",
  );
  return { symbols: symbols.length, rows: rowsTotal, filled };
}
