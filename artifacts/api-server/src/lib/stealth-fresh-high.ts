/**
 * Stealth Breakout — experimental detection "fresh 24H-high breakout" (owner
 * 2026-10-28, live, no shadow). Replaces the quiet-zone / Range arm detection.
 *
 * Fitted on reports/full/stealth_research2 (BingX 1H, 100 days, 954 coins,
 * reports/full/analysis/stealth_r_exits.py + stealth_r_scan.py):
 *  - the closed 1H candle closes above the highest high of the previous 24
 *    candles (new 24H high close);
 *  - fresh: none of the previous 24 candles was such a close;
 *  - the 72 candles before it span >= 16% (high/low);
 *  - close vs close 24 candles earlier >= +4.36%;
 *  - stop = previous 24H high - 1%; the stop must be > 0.3% below the close;
 *  - the coin has >= 800 closed 1H candles before the candle (as in the study).
 * Exit (tracker): initial stop at the level; at +1R the stop moves to entry and
 * then trails 1R below the peak; 72h. Study result: 2059 trades, +0.15R /
 * +0.62% per trade, every month and every chronological third positive.
 */
import type { BingXKline } from "./bingx.js";

export const STEALTH_FRESH_HIGH_METHOD = "fresh_24h_high_breakout" as const;
export const STEALTH_FH_LOOKBACK = 24;
export const STEALTH_FH_BASE_HOURS = 72;
export const STEALTH_FH_MIN_BASE_HEIGHT_PCT = 16;
export const STEALTH_FH_MIN_RET24H_PCT = 4.36;
export const STEALTH_FH_STOP_BELOW_LEVEL = 0.99;
export const STEALTH_FH_MIN_RISK_PCT = 0.3;
export const STEALTH_FH_MIN_HISTORY_HOURS = 800;
/** Candles needed: candle + 48 for the freshness check + 72-hour base. */
export const STEALTH_FH_REQUIRED_CANDLES = 1 + Math.max(2 * STEALTH_FH_LOOKBACK, STEALTH_FH_BASE_HOURS);
const HOUR_MS = 60 * 60 * 1000;

export type FreshHighCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type FreshHighDecision = {
  pass: boolean;
  reason: string;
  candleTime: number;
  close: number;
  prevHigh24: number | null;
  stopPrice: number | null;
  riskPct: number | null;
  baseHeightPct: number | null;
  ret24hPct: number | null;
  newHighsPrev24: number | null;
};

const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : NaN);

function maxHigh(cs: FreshHighCandle[], a: number, b: number): number {
  let m = -Infinity;
  for (let j = Math.max(0, a); j < b; j++) m = Math.max(m, cs[j]!.high);
  return m;
}

function minLow(cs: FreshHighCandle[], a: number, b: number): number {
  let m = Infinity;
  for (let j = Math.max(0, a); j < b; j++) m = Math.min(m, cs[j]!.low);
  return m;
}

export function toFreshHighCandles(rows: readonly BingXKline[]): FreshHighCandle[] {
  return rows
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0,
    )
    .sort((a, b) => a.time - b.time);
}

/**
 * Evaluates the last candle of `candles` (closed 1H candles, ascending, no
 * gaps). History age (>= 800 candles) is checked separately by the caller.
 */
export function evaluateFreshHighBreakout(
  candles: readonly FreshHighCandle[],
): FreshHighDecision {
  const cs = candles as FreshHighCandle[];
  const i = cs.length - 1;
  const c = cs[i];
  const empty = {
    candleTime: c?.time ?? 0,
    close: c?.close ?? 0,
    prevHigh24: null,
    stopPrice: null,
    riskPct: null,
    baseHeightPct: null,
    ret24hPct: null,
    newHighsPrev24: null,
  };
  if (!c || cs.length < STEALTH_FH_REQUIRED_CANDLES) {
    return { pass: false, reason: "stealth_fh_short_history", ...empty };
  }
  const first = cs[i - (STEALTH_FH_REQUIRED_CANDLES - 1)]!;
  if (c.time - first.time !== (STEALTH_FH_REQUIRED_CANDLES - 1) * HOUR_MS) {
    return { pass: false, reason: "stealth_fh_candle_gap", ...empty };
  }
  const isNew24 = (j: number) => cs[j]!.close > maxHigh(cs, j - STEALTH_FH_LOOKBACK, j);
  const prevHigh24 = maxHigh(cs, i - STEALTH_FH_LOOKBACK, i);
  let newHighsPrev24 = 0;
  for (let j = i - STEALTH_FH_LOOKBACK; j < i; j++) if (isNew24(j)) newHighsPrev24++;
  const baseHeightPct = pct(
    maxHigh(cs, i - STEALTH_FH_BASE_HOURS, i),
    minLow(cs, i - STEALTH_FH_BASE_HOURS, i),
  );
  const ret24hPct = pct(c.close, cs[i - STEALTH_FH_LOOKBACK]!.close);
  const stopPrice = prevHigh24 * STEALTH_FH_STOP_BELOW_LEVEL;
  const riskPct = ((c.close - stopPrice) / c.close) * 100;
  const metrics = {
    candleTime: c.time,
    close: c.close,
    prevHigh24,
    stopPrice,
    riskPct,
    baseHeightPct,
    ret24hPct,
    newHighsPrev24,
  };
  if (!(c.close > prevHigh24)) {
    return { pass: false, reason: "stealth_fh_no_new_24h_high", ...metrics };
  }
  if (newHighsPrev24 > 0) {
    return { pass: false, reason: "stealth_fh_not_fresh", ...metrics };
  }
  if (!(baseHeightPct >= STEALTH_FH_MIN_BASE_HEIGHT_PCT)) {
    return { pass: false, reason: "stealth_fh_base72_below_16pct", ...metrics };
  }
  if (!(ret24hPct >= STEALTH_FH_MIN_RET24H_PCT)) {
    return { pass: false, reason: "stealth_fh_ret24h_below_4_36pct", ...metrics };
  }
  if (!(riskPct > STEALTH_FH_MIN_RISK_PCT)) {
    return { pass: false, reason: "stealth_fh_risk_below_0_3pct", ...metrics };
  }
  return { pass: true, reason: "stealth_fh_pass", ...metrics };
}

/**
 * Breakout-trader protection in R (1R = entry - initial stop): the initial
 * stop until the peak reaches +1R, then max(entry, peak - 1R). Returns the
 * active protective level, or null while only the initial stop applies.
 */
export function resolveFreshHighProtectionLevel(input: {
  entryPrice: number;
  initialStopPrice: number;
  peakPrice: number;
}): number | null {
  const risk = input.entryPrice - input.initialStopPrice;
  if (!(risk > 0) || !(input.entryPrice > 0)) return null;
  if (input.peakPrice < input.entryPrice + risk) return null;
  return Math.max(input.entryPrice, input.peakPrice - risk);
}

export type FreshHighEvent = FreshHighDecision & {
  symbol: string;
  detectedAt: number;
};

/** Start of the last fully closed 1H candle at `now`. */
export function lastClosedHourStart(now: number): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
}

export type FreshHighScanDeps = {
  listSymbols: () => Promise<string[]>;
  loadCandles: (symbol: string) => Promise<BingXKline[]>;
  /** true when the coin has a 1H candle at or before `time`. */
  hasCandleAtOrBefore: (symbol: string, time: number) => Promise<boolean>;
  concurrency?: number;
  now?: () => number;
  log?: (msg: string, data: Record<string, unknown>) => void;
};

/**
 * Evaluates one closed hour over all symbols. Errors per symbol are counted,
 * never thrown.
 */
export async function scanFreshHighHour(
  hourStart: number,
  deps: FreshHighScanDeps,
): Promise<{ events: FreshHighEvent[]; stats: Record<string, number> }> {
  const symbols = await deps.listSymbols();
  const stats: Record<string, number> = { symbols: symbols.length, errors: 0 };
  const events: FreshHighEvent[] = [];
  let next = 0;
  const worker = async () => {
    while (next < symbols.length) {
      const symbol = symbols[next++]!;
      try {
        const candles = toFreshHighCandles(await deps.loadCandles(symbol)).filter(
          (c) => c.time <= hourStart,
        );
        if (candles.at(-1)?.time !== hourStart) {
          stats.stealth_fh_candle_missing = (stats.stealth_fh_candle_missing ?? 0) + 1;
          continue;
        }
        const decision = evaluateFreshHighBreakout(candles);
        let reason = decision.reason;
        if (decision.pass) {
          const old = await deps.hasCandleAtOrBefore(
            symbol,
            hourStart - STEALTH_FH_MIN_HISTORY_HOURS * HOUR_MS,
          );
          if (!old) reason = "stealth_fh_listing_younger_than_800h";
        }
        stats[reason] = (stats[reason] ?? 0) + 1;
        if (reason === "stealth_fh_pass") {
          events.push({ ...decision, symbol, detectedAt: (deps.now ?? Date.now)() });
        }
      } catch {
        stats.errors++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, deps.concurrency ?? 6) }, () => worker()),
  );
  return { events, stats };
}
