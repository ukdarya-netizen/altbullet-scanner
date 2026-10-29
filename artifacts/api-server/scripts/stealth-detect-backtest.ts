/**
 * Read-only Stealth detection backtest: which way of trading a 1H Auto Range
 * upside break works, on all BingX USDT perpetuals, public candles only.
 *
 * Breakouts come from the production closed-candle detector
 * (detectAutoRangePine1h, non-repainting: an event is known at its candle
 * close). Each variant decides whether/when to enter that break; the outcome
 * is the trading-bot rule: +5% before -8% on 1H candles within 72h, stop
 * first when both are hit in one candle, fee 0.1%. One open trade per symbol
 * and variant. Volume is BingX quote volume (not CoinGlass aggregated).
 *
 * Run (from artifacts/api-server):
 *   npx tsx scripts/stealth-detect-backtest.ts --days 60 --out ../../reports/oct30/stealth_detect
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectAutoRangePine, detectAutoRangePine1h } from "../src/lib/auto-range-pine.js";
import { isAnalysisBlockedSymbol, isSignalSymbolExcluded } from "../src/lib/excluded-signal-symbols.js";

const H1 = 3_600_000;
const BASE = "https://open-api.bingx.com";
const WIN = 5, STOP = 8, FEE = 0.1, HORIZON = 72;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "stealth_detect";
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIMIT = Number(args.get("limit") ?? 10_000);
// --tf 4h: the same old detection (Auto Range upside break) on 4H candles.
// Breaks, filters and entries are on 4H bars (entry = the 4H close); exits
// and outcomes stay on 1H candles from that close, as in the 1H run.
const TF4H = args.get("tf") === "4h";
const H4 = 4 * H1;

type C = { time: number; open: number; high: number; low: number; close: number; vol: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any> {
  let last: unknown;
  for (let a = 0; a < 5; a++) {
    try {
      const j = await (await fetch(BASE + path)).json();
      if (j.code === 0) return j.data;
      last = new Error(`code ${j.code} ${j.msg}`);
    } catch (e) { last = e; }
    await sleep(800 * (a + 1));
  }
  throw last;
}

async function candles1h(symbol: string, start: number, end: number, interval: "1h" | "4h" = "1h"): Promise<C[]> {
  const step = interval === "4h" ? H4 : H1;
  const rows = new Map<number, C>();
  for (let cur = start; cur < end; cur += step * 1000) {
    const data = await getJson(`/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&startTime=${cur}&endTime=${Math.min(end, cur + step * 1000)}&limit=1000`);
    for (const k of data ?? []) {
      const close = Number(k.close);
      rows.set(Number(k.time), { time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close, vol: Number(k.volume) * close });
    }
    await sleep(60);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time).filter((c) => c.time + step <= end);
}

/** Owner 2026-10-27: the target is a +10% peak. True = +10% reached before the -8% stop within 72h. */
function hit10(cs: C[], from: number, entry: number): boolean | null {
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  for (const c of after) {
    if (c.low <= entry * (1 - STOP / 100)) return false;
    if (c.high >= entry * 1.1) return true;
  }
  return after.length < HORIZON ? null : false;
}

/**
 * Exit variants on the same entry (1H candles, 72h, stop -8% first, fee 0.1%):
 *  take5      — all at +5%;
 *  half_trail — 50% at +5%, rest: stop to entry, trailing from +10% at peak-5pp;
 *  trail10    — stop to entry at +5%, trailing from +10% at peak-5pp, all;
 *  trail15    — stop to entry at +5%, trailing from +15% at peak-10pp, all (CAB tracker style).
 * An open remainder at 72h is closed at that candle's close.
 */
const EXITS = ["take5", "half_trail", "trail10", "trail15"] as const;
function exitResult(cs: C[], from: number, entry: number, mode: (typeof EXITS)[number]): number | null {
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  if (after.length < HORIZON) return null;
  let stop = entry * (1 - STOP / 100), peak = entry, part = 0, rem = 1, be = false;
  const act = mode === "trail15" ? 15 : 10, gap = mode === "trail15" ? 10 : 5;
  for (const c of after) {
    if (c.low <= stop) return part + rem * ((stop / entry - 1) * 100) - FEE;
    if (mode === "take5" && c.high >= entry * 1.05) return 5 - FEE;
    peak = Math.max(peak, c.high);
    const pp = (peak / entry - 1) * 100;
    if (mode !== "take5" && pp >= 5 && !be) {
      be = true; stop = Math.max(stop, entry);
      if (mode === "half_trail") { part += 0.5 * 5; rem = 0.5; }
    }
    if (mode !== "take5" && pp >= act) stop = Math.max(stop, entry * (1 + (pp - gap) / 100));
  }
  return part + rem * ((after[after.length - 1]!.close / entry - 1) * 100) - FEE;
}

/**
 * Breakout-trader exit as live Stealth (owner 2026-10-28), in % of entry:
 * stop at the broken range top - 1%; at +1R the stop goes to entry, then
 * trails 1R below the peak; 72h; stop first in a candle; fee 0.1%.
 * Null when the stop is not below the entry by more than 0.3%.
 */
function rTrailPct(cs: C[], from: number, entry: number, stop0: number): number | null {
  const risk = entry - stop0;
  if (!(risk > entry * 0.003)) return null;
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  if (after.length < HORIZON) return null;
  let stop = stop0, peak = entry;
  for (const c of after) {
    if (c.low <= stop) return (stop / entry - 1) * 100 - FEE;
    peak = Math.max(peak, c.high);
    if (peak >= entry + risk) stop = Math.max(stop, entry, peak - risk);
  }
  return (after[after.length - 1]!.close / entry - 1) * 100 - FEE;
}

/**
 * Owner 2026-10-29: Stealth cancel rules on top of the R exit. Each cancel
 * exits at the CLOSE of the 1H candle that triggers it (known only at close):
 *  in      any 1H close back below the range top (price is back in the range)
 *  in6     the same, only within the first 6 hours
 *  in2     two 1H closes in a row below the range top
 *  mid     a 1H close below the middle of the breakout candle
 *  nofol3  none of the next 3 1H candles closes above the breakout candle high
 * Stop/B.U./trail as rTrailPct, stop first inside a candle.
 */
type CancelRule = "in" | "in6" | "in2" | "mid" | "nofol3";
function rTrailCancelPct(cs: C[], from: number, entry: number, stop0: number, top: number, rule: CancelRule): number | null {
  const risk = entry - stop0;
  if (!(risk > entry * 0.003)) return null;
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  if (after.length < HORIZON) return null;
  const brk = cs[from]!;
  const mid = (brk.open + brk.close) / 2;
  let stop = stop0, peak = entry, below = 0, followed = false;
  for (let i = 0; i < after.length; i++) {
    const c = after[i]!;
    if (c.low <= stop) return (stop / entry - 1) * 100 - FEE;
    peak = Math.max(peak, c.high);
    if (peak >= entry + risk) stop = Math.max(stop, entry, peak - risk);
    if (c.close > brk.high) followed = true;
    below = c.close < top ? below + 1 : 0;
    const cancel =
      rule === "in" ? c.close < top
      : rule === "in6" ? i < 6 && c.close < top
      : rule === "in2" ? below >= 2
      : rule === "mid" ? c.close < mid
      : i === 2 && !followed;
    // A cancel never closes below the protective stop already in force.
    if (cancel && c.close > stop) return (c.close / entry - 1) * 100 - FEE;
  }
  return (after[after.length - 1]!.close / entry - 1) * 100 - FEE;
}
const CANCELS: CancelRule[] = ["in", "in6", "in2", "mid", "nofol3"];

/**
 * Owner 2026-10-29: the 1% wick stop under the top is too tight for crypto and
 * ignores whether price actually settles back in the range. Here the exit on
 * failure needs a 1H CLOSE back in the range (закреп), with a wide hard stop
 * (intrabar) only as disaster protection. The R unit for B.U./trail stays
 * entry - top*0.99 so results are comparable with the live exit.
 *  hard: "low" = range bottom, "mid" = range middle
 *  hold: "c1" = one 1H close below the top, "c2" = two in a row,
 *        "cmid" = one 1H close below the range middle
 */
type HoldRule = { hard: "low" | "mid"; hold: "c1" | "c2" | "cmid" };
function rSettlePct(cs: C[], from: number, entry: number, top: number, bottom: number, rule: HoldRule): number | null {
  const risk = entry - top * 0.99;
  if (!(risk > entry * 0.003)) return null;
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  if (after.length < HORIZON) return null;
  const midR = (top + bottom) / 2;
  let stop = (rule.hard === "low" ? bottom : midR) * 0.995;
  let peak = entry, below = 0;
  for (const c of after) {
    if (c.low <= stop) return (stop / entry - 1) * 100 - FEE;
    peak = Math.max(peak, c.high);
    if (peak >= entry + risk) stop = Math.max(stop, entry, peak - risk);
    below = c.close < top ? below + 1 : 0;
    const settled = rule.hold === "c1" ? below >= 1 : rule.hold === "c2" ? below >= 2 : c.close < midR;
    if (settled && c.close > stop) return (c.close / entry - 1) * 100 - FEE;
  }
  return (after[after.length - 1]!.close / entry - 1) * 100 - FEE;
}
const SETTLES: Array<[string, HoldRule]> = [
  ["s_low_c1", { hard: "low", hold: "c1" }],
  ["s_low_c2", { hard: "low", hold: "c2" }],
  ["s_low_cmid", { hard: "low", hold: "cmid" }],
  ["s_mid_c1", { hard: "mid", hold: "c1" }],
  ["s_mid_c2", { hard: "mid", hold: "c2" }],
];

/** Highest high within 72h after entry, % of entry (champion size). */
function peak72(cs: C[], from: number, entry: number): number {
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  return after.length ? (Math.max(...after.map((c) => c.high)) / entry - 1) * 100 : 0;
}

function outcome(cs: C[], from: number, entry: number): number | null {
  const after = cs.slice(from + 1, from + 1 + HORIZON);
  for (const c of after) {
    if (c.low <= entry * (1 - STOP / 100)) return -STOP - FEE;
    if (c.high >= entry * (1 + WIN / 100)) return WIN - FEE;
  }
  if (after.length < HORIZON) return null;
  return (after[after.length - 1]!.close / entry - 1) * 100 - FEE;
}

function atr14(cs: C[], i: number): number | null {
  if (i < 15) return null;
  let s = 0;
  for (let j = i - 14; j < i; j++) s += Math.max(cs[j]!.high - cs[j]!.low, Math.abs(cs[j]!.high - cs[j - 1]!.close), Math.abs(cs[j]!.low - cs[j - 1]!.close));
  return s / 14;
}
const volRatio = (cs: C[], i: number) => {
  if (i < 20) return null;
  const base = cs.slice(i - 20, i).reduce((a, c) => a + c.vol, 0) / 20;
  return base > 0 ? cs[i]!.vol / base : null;
};

type Ev = { upper: number; lower: number; anchorAt: number; k: number };
/** Entry index for a variant, or null (no trade). */
type Variant = { name: string; entry: (cs: C[], e: Ev) => number | null };

const breakoutOk = (cs: C[], e: Ev) => e.k;
const live = (cs: C[], e: Ev) => {
  const c = cs[e.k]!, a = atr14(cs, e.k), v = volRatio(cs, e.k);
  const height = (e.upper / e.lower - 1) * 100;
  return a !== null && v !== null && c.close >= e.upper * 1.01 && c.close - c.open >= a && v >= 2 && height > 4.5;
};
const momAt = (cs: C[], i: number, pct: number) => i >= 3 && (cs[i]!.close / cs[i - 3]!.close - 1) * 100 >= pct;
const mom = (cs: C[], i: number) => momAt(cs, i, 2.3);
const bodyDist = (cs: C[], e: Ev) => {
  const c = cs[e.k]!, a = atr14(cs, e.k);
  return a !== null && c.close >= e.upper * 1.01 && c.close - c.open >= a;
};
const vol2 = (cs: C[], e: Ev) => (volRatio(cs, e.k) ?? 0) >= 2;
const longRange = (e: Ev, cs: C[]) => cs[e.k]!.time - e.anchorAt >= 48 * H1;
const RETEST_BARS = TF4H ? 6 : 24; // 24h either way
const confirm2 = (cs: C[], e: Ev) => (cs[e.k + 1] && cs[e.k + 1]!.close > e.upper ? e.k + 1 : null);
const retest = (cs: C[], e: Ev) => {
  for (let j = e.k + 1; j <= e.k + RETEST_BARS && j < cs.length; j++) {
    const c = cs[j]!;
    if (c.close < e.upper) return null; // lost the level before a clean retest
    if (c.low <= e.upper * 1.01) return j; // touched the broken top and held above it
  }
  return null;
};

// Momentum variants are 3-bar (3h) rules from the 1H run; on 4H they would
// mean 12h, so the 4H run keeps only the timeframe-neutral variants.
const MOMENTUM = /^(C|J|K|L|M|N)_/;
const ALL_VARIANTS: Variant[] = [
  { name: "A_all_breakouts", entry: breakoutOk },
  { name: "B_live_proxy(dist1%+body1ATR+vol2x+height4.5)", entry: (cs, e) => (live(cs, e) ? e.k : null) },
  { name: "C_momentum3h>=2.3", entry: (cs, e) => (mom(cs, e.k) ? e.k : null) },
  { name: "D_confirm_2nd_close", entry: confirm2 },
  { name: "E_retest_hold", entry: retest },
  { name: "F_retest_hold+vol2x_breakout", entry: (cs, e) => ((volRatio(cs, e.k) ?? 0) >= 2 ? retest(cs, e) : null) },
  { name: "G_range>=48h", entry: (cs, e) => (longRange(e, cs) ? e.k : null) },
  { name: "H_range>=48h+retest", entry: (cs, e) => (longRange(e, cs) ? retest(cs, e) : null) },
  { name: "I_live_proxy+retest", entry: (cs, e) => (live(cs, e) ? retest(cs, e) : null) },
  { name: "J_momentum3h>=3", entry: (cs, e) => (momAt(cs, e.k, 3) ? e.k : null) },
  { name: "K_momentum3h>=5", entry: (cs, e) => (momAt(cs, e.k, 5) ? e.k : null) },
  { name: "L_momentum3h>=2.3+vol2x", entry: (cs, e) => (mom(cs, e.k) && vol2(cs, e) ? e.k : null) },
  { name: "M_momentum3h>=2.3+dist1%+body1ATR", entry: (cs, e) => (mom(cs, e.k) && bodyDist(cs, e) ? e.k : null) },
  { name: "N_momentum3h>=3+vol2x", entry: (cs, e) => (momAt(cs, e.k, 3) && vol2(cs, e) ? e.k : null) },
  { name: "O_dist1%+body1ATR", entry: (cs, e) => (bodyDist(cs, e) ? e.k : null) },
  { name: "P_vol2x", entry: (cs, e) => (vol2(cs, e) ? e.k : null) },
];
const VARIANTS = TF4H ? ALL_VARIANTS.filter((v) => !MOMENTUM.test(v.name)) : ALL_VARIANTS;

async function main() {
  const now = Date.now(), from = now - DAYS * 24 * H1;
  const symbols: string[] = ONLY ?? ((await getJson("/openApi/swap/v2/quote/contracts")) as { symbol: string }[])
    .map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-") &&
      // Crypto only, as live: no NCSK/NCCO stock/commodity/index contracts.
      !isAnalysisBlockedSymbol(s) && !isSignalSymbolExcluded(s)).slice(0, LIMIT);
  mkdirSync(OUT, { recursive: true });
  const trades: { v: string; s: string; t: number; r: number; p10: boolean; pk: number; ex: Record<string, number>; f: Record<string, number | null> }[] = [];
  const champions = { c20: 0, c50: 0 };
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const cs = await candles1h(symbol, from - 400 * H1, now);
      if (cs.length < 300) { errors[symbol] = "short_history"; continue; }
      // Detection bars: 1H, or 4H with --tf 4h (entry/exit stay on 1H `cs`).
      const TF = TF4H ? H4 : H1;
      const ds = TF4H ? await candles1h(symbol, from - 400 * H4, now, "4h") : cs;
      if (TF4H && ds.length < 200) { errors[symbol] = "short_history_4h"; continue; }
      const res = TF4H
        ? detectAutoRangePine(ds.map((c) => ({ ...c, closed: true })), { mergeDeviations: false })
        : detectAutoRangePine1h(ds.map((c) => ({ ...c, closed: true })), { mergeDeviations: false });
      const idx = new Map(ds.map((c, i) => [c.time, i]));
      const idx1 = new Map(cs.map((c, i) => [c.time, i]));
      /** 1H index whose close equals the close of detection bar j (or -1). */
      const to1h = (j: number) => idx1.get(ds[j]!.time + TF - H1) ?? -1;
      const evs: Ev[] = (res.upsideBreakouts ?? [])
        .map((b) => ({ upper: b.upper, lower: b.lower, anchorAt: b.anchorAt, k: idx.get(b.breakoutCloseTime - TF) ?? -1 }))
        .filter((e) => e.k >= 0 && ds[e.k]!.time >= from && to1h(e.k) >= 0);
      // Champions: breakouts whose price ran +20% / +50% within 72h of the break.
      for (const e of evs) {
        const k1 = to1h(e.k);
        if (k1 + HORIZON >= cs.length) continue;
        const pk = peak72(cs, k1, cs[k1]!.close);
        if (pk >= 20) champions.c20++;
        if (pk >= 50) champions.c50++;
      }
      for (const v of VARIANTS) {
        let busyUntil = -1;
        for (const e of evs) {
          const jd = v.entry(ds, e);
          if (jd === null || jd >= ds.length) continue;
          const j = to1h(jd);
          if (j < 0 || j <= busyUntil || j >= cs.length) continue;
          const r = outcome(cs, j, cs[j]!.close);
          const p10 = hit10(cs, j, cs[j]!.close);
          if (r === null || p10 === null) continue;
          const ex: Record<string, number> = {};
          for (const m of EXITS) { const x = exitResult(cs, j, cs[j]!.close, m); if (x !== null) ex[m] = x; }
          const rt = rTrailPct(cs, j, cs[j]!.close, e.upper * 0.99);
          if (rt !== null) ex.r_trail = rt;
          for (const rule of CANCELS) {
            const x = rTrailCancelPct(cs, j, cs[j]!.close, e.upper * 0.99, e.upper, rule);
            if (x !== null) ex[`r_cx_${rule}`] = x;
          }
          for (const [name, rule] of SETTLES) {
            const x = rSettlePct(cs, j, cs[j]!.close, e.upper, e.lower, rule);
            if (x !== null) ex[name] = x;
          }
          // Breakout-candle features on the detection timeframe (for fitting).
          const b = ds[e.k]!, a = atr14(ds, e.k);
          const f: Record<string, number | null> = {
            volRatio: volRatio(ds, e.k),
            bodyAtr: a ? (b.close - b.open) / a : null,
            rangeAtr: a ? (b.high - b.low) / a : null,
            closePos: b.high > b.low ? (b.close - b.low) / (b.high - b.low) : null,
            closeAboveTopPct: (b.close / e.upper - 1) * 100,
            rangeHeightPct: (e.upper / e.lower - 1) * 100,
            rangeHours: (b.time - e.anchorAt) / H1,
            ret24hPct: e.k >= 24 * H1 / TF ? (b.close / ds[e.k - 24 * H1 / TF]!.close - 1) * 100 : null,
            ret7dPct: e.k >= 168 * H1 / TF ? (b.close / ds[e.k - 168 * H1 / TF]!.close - 1) * 100 : null,
            riskPct: (cs[j]!.close - e.upper * 0.99) / cs[j]!.close * 100,
          };
          trades.push({ v: v.name, s: symbol, t: cs[j]!.time, r, p10, pk: peak72(cs, j, cs[j]!.close), ex, f });
          busyUntil = j + HORIZON; // conservative: one trade per symbol per 72h
        }
      }
    } catch (err) { errors[symbol] = String(err).slice(0, 100); }
    if (++done % 50 === 0) console.error(`${done}/${symbols.length} symbols, ${trades.length} trades`);
  }
  const mid = from + (now - HORIZON * H1 - from) / 2;
  const line = (name: string, rs: typeof trades) => {
    if (!rs.length) return `${name.padEnd(48)} n=0`;
    const w = rs.filter((r) => r.r > 0).length;
    const p10 = rs.filter((r) => r.p10).length;
    const c20 = rs.filter((r) => r.pk >= 20).length, c50 = rs.filter((r) => r.pk >= 50).length;
    const exits = [...EXITS, "r_trail", ...CANCELS.map((c) => `r_cx_${c}`), ...SETTLES.map(([n]) => n)].map((m) => {
      const xs = rs.map((r) => r.ex[m]).filter((x): x is number => typeof x === "number");
      return `${m}=${xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-"}%`;
    }).join(" ");
    return `${name.padEnd(48)} n=${String(rs.length).padStart(5)} +10%_before_stop=${Math.round((100 * p10) / rs.length)}% (${p10}) champions>=20%=${c20} >=50%=${c50} | +5%rule win=${Math.round((100 * w) / rs.length)}% exp=${(rs.reduce((a, r) => a + r.r, 0) / rs.length).toFixed(2)}% | exits/trade: ${exits} | days=${new Set(rs.map((r) => new Date(r.t).toISOString().slice(0, 10))).size}`;
  };
  const out: string[] = [`period ${new Date(from).toISOString()}..${new Date(now).toISOString()} symbols=${symbols.length} errors=${Object.keys(errors).length}`,
    `champion breakouts in the market: >=20% in 72h: ${champions.c20}, >=50%: ${champions.c50}`];
  for (const v of VARIANTS) {
    const rs = trades.filter((t) => t.v === v.name);
    out.push(`== ${v.name}`, line("all", rs), line("first half", rs.filter((t) => t.t < mid)), line("second half", rs.filter((t) => t.t >= mid)));
    // Per month, the live-Stealth R exit and trail10 (avg % per trade, n).
    const months = [...new Set(rs.map((t) => new Date(t.t).toISOString().slice(0, 7)))].sort();
    for (const m of ["r_trail", "trail10"]) {
      out.push(`   by month ${m}: ` + months.map((mo) => {
        const xs = rs.filter((t) => new Date(t.t).toISOString().startsWith(mo)).map((t) => t.ex[m])
          .filter((x): x is number => typeof x === "number");
        return `${mo.slice(5)} ${xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "-"}% (${xs.length})`;
      }).join(" | "));
    }
  }
  // Live Stealth 1H rule: range height < 5.5%, close >= 2% above the top, risk > 0.3%.
  if (!TF4H) {
    const live = trades.filter((t) => t.v === VARIANTS[0]!.name && (t.f.rangeHeightPct ?? 99) < 5.5 &&
      (t.f.closeAboveTopPct ?? -1) >= 2 && typeof t.ex.r_trail === "number");
    const months = [...new Set(live.map((t) => new Date(t.t).toISOString().slice(0, 7)))].sort();
    const depth = (k: (t: (typeof live)[number]) => number) => { const xs = live.map(k).sort((a, b) => a - b); return xs.length ? `med ${xs[Math.floor(xs.length / 2)]!.toFixed(2)}% p90 ${xs[Math.floor(xs.length * 0.9)]!.toFixed(2)}%` : "-"; };
    out.push(`stop depth from entry: top-1% ${depth((t) => t.f.riskPct ?? 0)} | range bottom ${depth((t) => (t.f.riskPct ?? 0) + (t.f.rangeHeightPct ?? 0))}`);
    out.push(`== LIVE 1H RULE (height<5.5, close>=2% above top) n=${live.length}, symbols=${new Set(live.map((t) => t.s)).size}`);
    for (const m of ["r_trail", ...CANCELS.map((c) => `r_cx_${c}`), ...SETTLES.map(([n]) => n)]) {
      const xs = live.map((t) => t.ex[m]).filter((x): x is number => typeof x === "number");
      const sum = xs.reduce((a, b) => a + b, 0);
      const thirds = [0, 1, 2].map((k) => live.slice(Math.floor(k * live.length / 3), Math.floor((k + 1) * live.length / 3))
        .reduce((a, t) => a + (t.ex[m] ?? 0), 0).toFixed(0));
      out.push(`${m.padEnd(12)} n=${xs.length} sum=${sum.toFixed(0)}% avg=${(sum / xs.length).toFixed(2)}% win=${Math.round(100 * xs.filter((x) => x > 0).length / xs.length)}% ` +
        `thirds=${thirds.join("/")} | ` + months.map((mo) => {
          const ys = live.filter((t) => new Date(t.t).toISOString().startsWith(mo)).map((t) => t.ex[m]).filter((x): x is number => typeof x === "number");
          return `${mo.slice(5)} ${ys.length ? (ys.reduce((a, b) => a + b, 0) / ys.length).toFixed(2) : "-"}% (${ys.length})`;
        }).join(" | "));
    }
  }
  writeFileSync(join(OUT, "summary.txt"), out.join("\n"));
  const FEAT = ["volRatio", "bodyAtr", "rangeAtr", "closePos", "closeAboveTopPct", "rangeHeightPct", "rangeHours", "ret24hPct", "ret7dPct", "riskPct"];
  const EXALL = [...EXITS, "r_trail", ...CANCELS.map((c) => `r_cx_${c}`), ...SETTLES.map(([n]) => n)];
  const n = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(4) : "");
  writeFileSync(join(OUT, "trades.csv"), [
    ["variant", "symbol", "entry_time", "net_pct", "hit10_before_stop", "peak72_pct", ...EXALL, ...FEAT].join(","),
    ...trades.map((t) => [t.v, t.s, new Date(t.t).toISOString(), t.r.toFixed(3), t.p10 ? 1 : 0, t.pk.toFixed(3),
      ...EXALL.map((m) => n(t.ex[m])), ...FEAT.map((k) => n(t.f[k]))].join(",")),
  ].join("\n"));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(out.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
