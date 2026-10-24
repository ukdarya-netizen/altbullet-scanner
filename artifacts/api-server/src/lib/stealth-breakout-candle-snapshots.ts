import { db } from "@workspace/db";
import { withAggregatedKlineVolume } from "./aggregated-kline-volume.js";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { getKlines, type BingXKline } from "./bingx.js";
import { getCoinglassOI } from "./coinglass_oi.js";
import { getAggregatedFuturesTakerNetBuyPct15m } from "./coinglass_taker.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import { getSpotVolume } from "./coinglass_spot_volume.js";

/**
 * Observation only: one immutable row per (Stealth setup, closed 1H candle)
 * from the breakout candle onward, for EVERY detected breakout — fired or not.
 * Nothing here feeds a trading decision.
 */
const HOUR_MS = 3_600_000;
const TRACK_HOURS = 48;
/** Aggregated metrics are "now" values: only valid right after the candle closed. */
const FRESH_METRICS_MS = 15 * 60_000;
const METRIC_TIMEOUT_MS = 8_000;
const MAX_SYMBOLS_PER_RUN = 60;
const VOL_BASE_CANDLES = 24;

export async function ensureStealthBreakoutCandleSnapshotsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS stealth_breakout_candle_snapshots (
      id                          serial PRIMARY KEY,
      setup_id                    integer NOT NULL,
      symbol                      text NOT NULL,
      level_source                text NOT NULL,
      setup_status                text NOT NULL,
      fired_signal_id             integer,
      breakout_level              real,
      trigger_candle_at           timestamptz NOT NULL,
      trigger_close               real,
      candle_at                   timestamptz NOT NULL,
      candle_index                integer NOT NULL,
      open                        real NOT NULL,
      high                        real NOT NULL,
      low                         real NOT NULL,
      close                       real NOT NULL,
      volume                      real NOT NULL,
      vol_mult_24h                real,
      close_vs_level_pct          real,
      low_vs_level_pct            real,
      close_vs_trigger_close_pct  real,
      high_vs_trigger_close_pct   real,
      low_vs_trigger_close_pct    real,
      metrics                     jsonb,
      metrics_at                  timestamptz,
      created_at                  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS stealth_breakout_candle_snapshots_setup_candle_unique
      ON stealth_breakout_candle_snapshots (setup_id, candle_at)
  `);
}

function withTimeout<T>(p: Promise<T>): Promise<T | null> {
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), METRIC_TIMEOUT_MS).unref?.(),
    ),
  ]);
}

async function fetchMetrics(symbol: string, price: number) {
  const [oi, taker, cvd, spot] = await Promise.all([
    withTimeout(
      getCoinglassOI(symbol, price, undefined, {
        bypassCache: true,
        priority: "low",
      }),
    ),
    withTimeout(getAggregatedFuturesTakerNetBuyPct15m(symbol, 7000)),
    withTimeout(
      getSpotCvdMtf(symbol, {
        priority: "low",
      }),
    ),
    withTimeout(getSpotVolume(symbol, { priority: "low" })),
  ]);
  const oiOk = oi?.available === true;
  return {
    oiUsd: oiOk ? (oi.oiUsd ?? null) : null,
    oiChange30mPct: oiOk ? (oi.oiChange30m ?? null) : null,
    oiChange1hPct: oiOk ? (oi.oiChange1h ?? null) : null,
    oiChange4hPct: oiOk ? (oi.oiChange4h ?? null) : null,
    oiChange24hPct: oiOk ? (oi.oiChange24h ?? null) : null,
    futuresTakerNetBuyPct15m: taker?.available ? taker.netBuyPct : null,
    spotCvdAvailable: cvd?.available === true,
    spotCvd15m: cvd?.available ? cvd.cvd15m : null,
    spotCvd30m: cvd?.available ? cvd.cvd30m : null,
    spotCvd1h: cvd?.available ? cvd.cvd1h : null,
    spotCvd4h: cvd?.available ? cvd.cvd4h : null,
    spotCvdStrength1h: cvd?.available ? cvd.cvdStrength1h : null,
    spotVolumeUsd1h: spot?.available ? spot.volumeUsd1h : null,
    spotNetBuyPct1h: spot?.available ? spot.netBuyPct1h : null,
    source: "coinglass_aggregated",
  };
}

interface SetupRow {
  id: number;
  symbol: string;
  level_source: string;
  status: string;
  fired_signal_id: number | null;
  breakout_level: number | null;
  first_cross_ms: number;
}

const pct = (a: number, b: number): number | null =>
  b > 0 && Number.isFinite(a) ? ((a - b) / b) * 100 : null;

export async function runStealthBreakoutCandleSnapshotCycle(): Promise<void> {
  const res = await db.execute(sql`
    SELECT id, symbol, level_source, status, fired_signal_id, breakout_level,
           (EXTRACT(EPOCH FROM first_cross_at) * 1000)::bigint AS first_cross_ms
      FROM stealth_breakout_armed_setups
     WHERE first_cross_at IS NOT NULL
       AND first_cross_at > now() - make_interval(hours => ${TRACK_HOURS})
  `);
  const setups = (res.rows as Array<Record<string, unknown>>).map(
    (r): SetupRow => ({
      id: Number(r.id),
      symbol: String(r.symbol),
      level_source: String(r.level_source),
      status: String(r.status),
      fired_signal_id:
        r.fired_signal_id == null ? null : Number(r.fired_signal_id),
      breakout_level:
        r.breakout_level == null ? null : Number(r.breakout_level),
      first_cross_ms: Number(r.first_cross_ms),
    }),
  );
  if (setups.length === 0) return;

  const existingRes = await db.execute(sql`
    SELECT setup_id, (EXTRACT(EPOCH FROM candle_at) * 1000)::bigint AS ms
      FROM stealth_breakout_candle_snapshots
     WHERE setup_id IN (${sql.join(
       setups.map((s) => sql`${s.id}`),
       sql`, `,
     )})
  `);
  const existing = new Set(
    (existingRes.rows as Array<Record<string, unknown>>).map(
      (r) => `${Number(r.setup_id)}:${Number(r.ms)}`,
    ),
  );

  const now = Date.now();
  const bySymbol = new Map<string, SetupRow[]>();
  for (const s of setups) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }

  let symbolsDone = 0;
  for (const [symbol, list] of bySymbol) {
    // Candle open times still owed for this symbol's setups.
    const owed = list.some((s) => {
      const first = Math.floor(s.first_cross_ms / HOUR_MS) * HOUR_MS;
      for (
        let t = first;
        t + HOUR_MS <= now && t < first + TRACK_HOURS * HOUR_MS;
        t += HOUR_MS
      ) {
        if (!existing.has(`${s.id}:${t}`)) return true;
      }
      return false;
    });
    if (!owed) continue;
    if (symbolsDone >= MAX_SYMBOLS_PER_RUN) break;
    symbolsDone++;

    let klines: BingXKline[];
    try {
      klines = await withAggregatedKlineVolume(
        symbol,
        "1h",
        await getKlines(symbol, "1h", 120),
      );
    } catch (err) {
      logger.warn({ err, symbol }, "stealth candle snapshots: klines failed");
      continue;
    }
    const closed = klines.filter((k) => k.time + HOUR_MS <= now);
    const byTime = new Map(closed.map((k) => [k.time, k]));
    let metrics: Awaited<ReturnType<typeof fetchMetrics>> | null = null;
    let metricsAt: number | null = null;

    for (const s of list) {
      const first = Math.floor(s.first_cross_ms / HOUR_MS) * HOUR_MS;
      const trigger = byTime.get(first);
      const triggerClose = trigger ? parseFloat(trigger.close) : NaN;
      for (
        let t = first, idx = 0;
        t + HOUR_MS <= now && t < first + TRACK_HOURS * HOUR_MS;
        t += HOUR_MS, idx++
      ) {
        if (existing.has(`${s.id}:${t}`)) continue;
        const k = byTime.get(t);
        if (!k) continue;
        const o = parseFloat(k.open);
        const h = parseFloat(k.high);
        const l = parseFloat(k.low);
        const c = parseFloat(k.close);
        const v = parseFloat(k.volume);
        if (![o, h, l, c, v].every(Number.isFinite)) continue;
        const prior = closed
          .filter((x) => x.time < t)
          .slice(-VOL_BASE_CANDLES)
          .map((x) => parseFloat(x.volume))
          .filter(Number.isFinite);
        const avg = prior.length
          ? prior.reduce((a, b) => a + b, 0) / prior.length
          : 0;
        const fresh = now - (t + HOUR_MS) <= FRESH_METRICS_MS;
        if (fresh && metrics === null) {
          metrics = await fetchMetrics(symbol, c);
          metricsAt = Date.now();
        }
        const level = s.breakout_level;
        const useMetrics = fresh ? metrics : null;
        await db.execute(sql`
          INSERT INTO stealth_breakout_candle_snapshots (
            setup_id, symbol, level_source, setup_status, fired_signal_id,
            breakout_level, trigger_candle_at, trigger_close, candle_at,
            candle_index, open, high, low, close, volume, vol_mult_24h,
            close_vs_level_pct, low_vs_level_pct, close_vs_trigger_close_pct,
            high_vs_trigger_close_pct, low_vs_trigger_close_pct,
            metrics, metrics_at
          ) VALUES (
            ${s.id}, ${symbol}, ${s.level_source}, ${s.status}, ${s.fired_signal_id},
            ${level}, to_timestamp(${first / 1000}),
            ${Number.isFinite(triggerClose) ? triggerClose : null},
            to_timestamp(${t / 1000}), ${idx}, ${o}, ${h}, ${l}, ${c}, ${v},
            ${avg > 0 ? v / avg : null},
            ${level ? pct(c, level) : null}, ${level ? pct(l, level) : null},
            ${Number.isFinite(triggerClose) ? pct(c, triggerClose) : null},
            ${Number.isFinite(triggerClose) ? pct(h, triggerClose) : null},
            ${Number.isFinite(triggerClose) ? pct(l, triggerClose) : null},
            ${useMetrics ? JSON.stringify(useMetrics) : null}::jsonb,
            ${useMetrics && metricsAt ? sql`to_timestamp(${metricsAt / 1000})` : null}
          )
          ON CONFLICT (setup_id, candle_at) DO NOTHING
        `);
        existing.add(`${s.id}:${t}`);
      }
    }
  }
}
