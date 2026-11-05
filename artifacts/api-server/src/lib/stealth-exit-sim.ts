/**
 * Stealth exit variants on our own signals (owner 2026-11-05): what each way of managing the trade
 * would have given, signal by signal. Entry = our entry price at the signal time; path = BingX 15m
 * candles for 4 days after it (the max watch). Inside a 15m candle the stop is checked first
 * (conservative). Every trade pays 0.1% fees (0.05% in + 0.05% out). Range top / bottom = the live
 * range of the signal (decision_metrics.stealthRange4h).
 *
 * Variants:
 *  current   stop −8%; breakeven at +8%; trailing from +15%, 10 pp under the peak; 4 days
 *  range_in  current + exit when a closed 1H candle closes back inside the range (below the top)
 *  range_mid current + exit when a closed 1H candle closes below the middle of the range
 *  range_mid2 current + exit after two closed 1H candles in a row below the middle of the range
 *  be3 / be5 breakeven at +3% / +5% (rest as current)
 *  part5     half closed at +5%, the rest with breakeven (rest as current)
 * Observation only.
 */
import { pool } from "@workspace/db";
import { getKlinesRange } from "./bingx.js";
import { logger } from "./logger.js";

const M15 = 15 * 60_000;
const H1 = 3_600_000;
const MAX_HOLD = 4 * 24 * H1;
const FEE = 0.1;
const STOP = 8;

export const EXIT_VARIANTS = ["current", "range_in", "range_mid", "range_mid2", "be3", "be5", "part5"] as const;
type Variant = (typeof EXIT_VARIANTS)[number];
type Bar = { time: number; open: number; high: number; low: number; close: number };

/** Pure: % result of one variant (fees included) and how it ended. */
export function simulate(v: Variant, entry: number, bars: Bar[], rangeTop: number, rangeBottom: number) {
  const pct = (p: number) => ((p - entry) / entry) * 100;
  const mid = (rangeTop + rangeBottom) / 2;
  const beAt = v === "be3" ? 3 : v === "be5" ? 5 : 8;
  let stop = -STOP;
  let peak = 0;
  let booked = 0; // part already closed (fraction) and its result
  let bookedPnl = 0;
  let below = 0;
  const finish = (exitPct: number, how: string) => {
    const rest = 1 - booked;
    return { pnl: Math.round((bookedPnl + rest * exitPct - FEE) * 100) / 100, how };
  };
  for (const b of bars) {
    // stop first
    if (pct(b.low) <= stop) return finish(Math.min(stop, pct(b.open)), stop <= -STOP ? "stop" : stop === 0 ? "breakeven" : "trailing");
    const hi = pct(b.high);
    if (v === "part5" && booked === 0 && hi >= 5) { booked = 0.5; bookedPnl = 0.5 * 5; stop = Math.max(stop, 0); }
    if (hi > peak) peak = hi;
    if (peak >= beAt) stop = Math.max(stop, 0);
    if (peak >= 15) stop = Math.max(stop, peak - 10);
    // range rules on the close of each hour (the last 15m candle of the hour)
    if ((b.time + M15) % H1 === 0 && (v === "range_in" || v === "range_mid" || v === "range_mid2")) {
      const c = b.close;
      if (v === "range_in" && c < rangeTop) return finish(pct(c), "range_exit");
      if (v === "range_mid" && c < mid) return finish(pct(c), "range_exit");
      if (v === "range_mid2") {
        below = c < mid ? below + 1 : 0;
        if (below >= 2) return finish(pct(c), "range_exit");
      }
    }
  }
  const last = bars[bars.length - 1];
  return finish(last ? pct(last.close) : 0, "max_hold_or_open");
}

type Job = { status: "idle" | "running" | "done" | "failed"; done: number; total: number; startedAt: number | null; finishedAt: number | null; error: string | null; rows: Record<string, unknown>[] };
const job: Job = { status: "idle", done: 0, total: 0, startedAt: null, finishedAt: null, error: null, rows: [] };
export const exitSimJob = () => job;

export async function runStealthExitSim(days = 30): Promise<void> {
  if (job.status === "running") return;
  Object.assign(job, { status: "running", done: 0, total: 0, startedAt: Date.now(), finishedAt: null, error: null, rows: [] });
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.symbol, t.detected_at, t.status::text AS status, t.entry_price, t.peak_price, t.pnl_percent,
              t.decision_metrics->'stealthRange4h' AS rng,
              t.decision_metrics->'beforeNeutralClose'->>'status' AS status_before_neutral,
              (c.metrics->'bingx'->'welkin3h'->>'notGrey')::int AS welkin3h_not_grey
         FROM tracked_signals t
         LEFT JOIN signal_volume_colors c ON c.tracked_signal_id = t.id
        WHERE t.sentiment_key = 'stealth_breakout' AND t.stealth_detection_method = 'range_1h_breakout'
          AND t.detected_at > now() - ($1::int * interval '1 day')
        ORDER BY t.detected_at`, [days]);
    job.total = rows.length;
    for (const r of rows) {
      const entry = Number(r.entry_price);
      const top = Number(r.rng?.rangeTop), bottom = Number(r.rng?.rangeBottom);
      const t0 = Math.ceil(new Date(r.detected_at).getTime() / M15) * M15;
      const out: Record<string, unknown> = {
        id: r.id, symbol: r.symbol, detected_at: new Date(r.detected_at).toISOString(), status: r.status,
        status_before_neutral: r.status_before_neutral, entry, range_top: top, range_bottom: bottom,
        // Owner's Welkin filter: 0 = all 3 bars before the breakout grey (the live filter now skips these).
        welkin3h_not_grey: r.welkin3h_not_grey, welkin_filter_pass: r.welkin3h_not_grey == null ? null : r.welkin3h_not_grey > 0,
      };
      if (entry > 0 && top > 0 && bottom > 0) {
        const end = Math.min(Date.now(), t0 + MAX_HOLD);
        const raw = await getKlinesRange(r.symbol, "15m", t0, end).catch(() => []);
        const bars = raw
          .map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close) }))
          .filter((k) => k.time >= t0 && k.time + M15 <= end && Number.isFinite(k.close))
          .sort((a, b) => a.time - b.time);
        out.bars_15m = bars.length;
        out.peak_pct = bars.length ? Math.round(((Math.max(...bars.map((b) => b.high)) - entry) / entry) * 10000) / 100 : null;
        for (const v of EXIT_VARIANTS) {
          if (!bars.length) { out[v] = null; continue; }
          const s = simulate(v, entry, bars, top, bottom);
          out[v] = s.pnl;
          out[`${v}_how`] = s.how;
        }
      } else out.note = "нет диапазона или цены входа";
      job.rows.push(out);
      job.done++;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    job.status = "done";
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
    logger.warn({ err }, "stealth exit sim failed");
  } finally {
    job.finishedAt = Date.now();
  }
}

/** Totals per variant: trades, sum, stops, wins (≥ +5%), and the two halves of the period. */
export function exitSimSummary(onlyWelkinPass = true) {
  const rows = job.rows.filter((r) => r.current != null && (!onlyWelkinPass || r.welkin_filter_pass !== false));
  const half = Math.floor(rows.length / 2);
  return EXIT_VARIANTS.map((v) => {
    const vals = rows.map((r) => Number(r[v]));
    const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 10) / 10;
    return {
      variant: v,
      trades: vals.length,
      sum: sum(vals),
      firstHalf: sum(vals.slice(0, half)),
      secondHalf: sum(vals.slice(half)),
      stops: rows.filter((r) => r[`${v}_how`] === "stop").length,
      rangeExits: rows.filter((r) => r[`${v}_how`] === "range_exit").length,
      atLeast5: vals.filter((x) => x >= 5).length,
      losses: vals.filter((x) => x < 0).length,
    };
  });
}
