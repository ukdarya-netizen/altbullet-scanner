/**
 * Strategy report for the trading bot (owner 2026-11-03), as Nihilist's: what each way
 * the trading bot can lead a CAB trade would have given, on CAB's real closed signals.
 *
 * Signals: tracked longs of the four traded patterns, closed (profit / stop_loss / bu_stop /
 * breakeven / expired) with an exit price; BTC apart (own leverage); cancelled never entered.
 * Per strategy, % of the entry price, fee 0.1% per round trip:
 *   follow_cab — CAB's exit price (the bot follows CAB's stop and close on the whole position);
 *   takeN      — +N% when CAB's peak reached entry × (1 + N%) (the peak is seen before the
 *                close, so the take came first), else CAB's exit price.
 * Known simplification: Impulse Buy is valued at CAB's final exit, as the bot trades it
 * (whole position), not CAB's own 80/20 core/runner split.
 */
import { pool } from "@workspace/db";
import { ACTIVE_PATTERN_KEYS } from "./dead-patterns.js";

export const REPORT_FEE_PCT = 0.1;
export const REPORT_EXITS = { follow_cab: null, take5: 5, take8: 8, take10: 10 } as const;
export type ExitId = keyof typeof REPORT_EXITS;
const CLOSED = ["profit", "stop_loss", "bu_stop", "breakeven", "expired"];

export type ReportRow = {
  pattern: string; symbol: string; status: string; detectedAt: number; closedAt: number;
  entry: number; exit: number; peak: number | null;
};
export type Stats = {
  n: number; winPct: number; stopPct: number; avg: number; sum: number; maxDd: number;
  half1: { n: number; avg: number | null }; half2: { n: number; avg: number | null };
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/** % of the entry price of one trade under an exit, net of fees. */
export function tradePct(row: ReportRow, exit: ExitId): number {
  const cab = (row.exit / row.entry - 1) * 100 - REPORT_FEE_PCT;
  const take = REPORT_EXITS[exit];
  if (take === null) return cab;
  return row.peak !== null && row.peak >= row.entry * (1 + take / 100) ? take - REPORT_FEE_PCT : cab;
}

/** Same shape as Nihilist's stats: drawdown on the running sum by close time, halves by signal time. */
export function stats(rows: ReportRow[], exit: ExitId): Stats {
  const xs = [...rows].sort((a, b) => a.closedAt - b.closedAt).map((r) => ({ r, pct: tradePct(r, exit) }));
  const n = xs.length;
  let cum = 0, peak = 0, maxDd = 0;
  for (const x of xs) { cum += x.pct; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); }
  const opens = xs.map((x) => x.r.detectedAt);
  const mid = n ? (Math.min(...opens) + Math.max(...opens)) / 2 : 0;
  const half = (first: boolean) => {
    const p = xs.filter((x) => (x.r.detectedAt < mid) === first);
    return { n: p.length, avg: p.length ? r2(p.reduce((a, x) => a + x.pct, 0) / p.length) : null };
  };
  const take = REPORT_EXITS[exit];
  const stopped = xs.filter((x) => x.r.status === "stop_loss" && !(take !== null && x.pct === take - REPORT_FEE_PCT)).length;
  return {
    n,
    winPct: n ? r2((100 * xs.filter((x) => x.pct > 0.5).length) / n) : 0,
    stopPct: n ? r2((100 * stopped) / n) : 0,
    avg: n ? r2(cum / n) : 0, sum: r2(cum), maxDd: r2(maxDd),
    half1: half(true), half2: half(false),
  };
}

export type StrategyReport = {
  days: number | null; from: string | null; to: string | null; trades: number;
  exits: Record<ExitId, Stats>;
  byPattern: Record<string, Record<ExitId, Stats>>;
};

export function buildReport(rows: ReportRow[], days: number | null): StrategyReport {
  const exits = Object.keys(REPORT_EXITS) as ExitId[];
  const all = (rs: ReportRow[]) => Object.fromEntries(exits.map((e) => [e, stats(rs, e)])) as Record<ExitId, Stats>;
  const byPattern: StrategyReport["byPattern"] = {};
  for (const p of ACTIVE_PATTERN_KEYS) {
    const rs = rows.filter((r) => r.pattern === p);
    if (rs.length) byPattern[p] = all(rs);
  }
  const ts = rows.map((r) => r.detectedAt);
  return {
    days, trades: rows.length,
    from: ts.length ? new Date(Math.min(...ts)).toISOString() : null,
    to: ts.length ? new Date(Math.max(...ts)).toISOString() : null,
    exits: all(rows), byPattern,
  };
}

export async function readStrategyReport(days: number | null): Promise<StrategyReport> {
  const { rows } = await pool.query<{
    pattern: string; symbol: string; status: string; detected_at: Date; closed_at: Date;
    entry_price: number; exit_price: number; peak_price: number | null; runner_peak_price: number | null;
  }>(
    `SELECT sentiment_key AS pattern, symbol, status::text AS status, detected_at, closed_at,
            entry_price, exit_price, peak_price, runner_peak_price
     FROM tracked_signals
     WHERE NOT is_short AND sentiment_key = ANY($1::text[]) AND status::text = ANY($2::text[])
       AND exit_price > 0 AND entry_price > 0 AND closed_at IS NOT NULL
       AND upper(replace(symbol, '-', '')) NOT IN ('BTCUSDT', 'BTC')
       AND ($3::int IS NULL OR detected_at > now() - make_interval(days => $3))`,
    [[...ACTIVE_PATTERN_KEYS], CLOSED, days],
  );
  const out: ReportRow[] = rows.map((r) => {
    const peaks = [r.peak_price, r.runner_peak_price].map(Number).filter((v) => Number.isFinite(v) && v > 0);
    return {
      pattern: r.pattern, symbol: r.symbol, status: r.status,
      detectedAt: r.detected_at.getTime(), closedAt: r.closed_at.getTime(),
      entry: Number(r.entry_price), exit: Number(r.exit_price), peak: peaks.length ? Math.max(...peaks) : null,
    };
  });
  return buildReport(out, days);
}
