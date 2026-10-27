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
import { detectAutoRangePine1h } from "../src/lib/auto-range-pine.js";

const H1 = 3_600_000;
const BASE = "https://open-api.bingx.com";
const WIN = 5, STOP = 8, FEE = 0.1, HORIZON = 72;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "stealth_detect";
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIMIT = Number(args.get("limit") ?? 10_000);

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

async function candles1h(symbol: string, start: number, end: number): Promise<C[]> {
  const rows = new Map<number, C>();
  for (let cur = start; cur < end; cur += H1 * 1000) {
    const data = await getJson(`/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=1h&startTime=${cur}&endTime=${Math.min(end, cur + H1 * 1000)}&limit=1000`);
    for (const k of data ?? []) {
      const close = Number(k.close);
      rows.set(Number(k.time), { time: Number(k.time), open: Number(k.open), high: Number(k.high), low: Number(k.low), close, vol: Number(k.volume) * close });
    }
    await sleep(60);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time).filter((c) => c.time + H1 <= end);
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
const confirm2 = (cs: C[], e: Ev) => (cs[e.k + 1] && cs[e.k + 1]!.close > e.upper ? e.k + 1 : null);
const retest = (cs: C[], e: Ev) => {
  for (let j = e.k + 1; j <= e.k + 24 && j < cs.length; j++) {
    const c = cs[j]!;
    if (c.close < e.upper) return null; // lost the level before a clean retest
    if (c.low <= e.upper * 1.01) return j; // touched the broken top and held above it
  }
  return null;
};

const VARIANTS: Variant[] = [
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

async function main() {
  const now = Date.now(), from = now - DAYS * 24 * H1;
  const symbols: string[] = ONLY ?? ((await getJson("/openApi/swap/v2/quote/contracts")) as { symbol: string }[])
    .map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-")).slice(0, LIMIT);
  mkdirSync(OUT, { recursive: true });
  const trades: { v: string; s: string; t: number; r: number; p10: boolean; pk: number; ex: Record<string, number> }[] = [];
  const champions = { c20: 0, c50: 0 };
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const cs = await candles1h(symbol, from - 400 * H1, now);
      if (cs.length < 300) { errors[symbol] = "short_history"; continue; }
      const res = detectAutoRangePine1h(cs.map((c) => ({ ...c, closed: true })), { mergeDeviations: false });
      const idx = new Map(cs.map((c, i) => [c.time, i]));
      const evs: Ev[] = (res.upsideBreakouts ?? [])
        .map((b) => ({ upper: b.upper, lower: b.lower, anchorAt: b.anchorAt, k: idx.get(b.breakoutCloseTime - H1) ?? -1 }))
        .filter((e) => e.k >= 0 && cs[e.k]!.time >= from);
      // Champions: breakouts whose price ran +20% / +50% within 72h of the break.
      for (const e of evs) {
        if (e.k + HORIZON >= cs.length) continue;
        const pk = peak72(cs, e.k, cs[e.k]!.close);
        if (pk >= 20) champions.c20++;
        if (pk >= 50) champions.c50++;
      }
      for (const v of VARIANTS) {
        let busyUntil = -1;
        for (const e of evs) {
          const j = v.entry(cs, e);
          if (j === null || j <= busyUntil || j >= cs.length) continue;
          const r = outcome(cs, j, cs[j]!.close);
          const p10 = hit10(cs, j, cs[j]!.close);
          if (r === null || p10 === null) continue;
          const ex: Record<string, number> = {};
          for (const m of EXITS) { const x = exitResult(cs, j, cs[j]!.close, m); if (x !== null) ex[m] = x; }
          trades.push({ v: v.name, s: symbol, t: cs[j]!.time, r, p10, pk: peak72(cs, j, cs[j]!.close), ex });
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
    const exits = EXITS.map((m) => {
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
  }
  writeFileSync(join(OUT, "summary.txt"), out.join("\n"));
  writeFileSync(join(OUT, "trades.csv"), ["variant,symbol,entry_time,net_pct,hit10_before_stop", ...trades.map((t) => `${t.v},${t.s},${new Date(t.t).toISOString()},${t.r.toFixed(3)},${t.p10 ? 1 : 0}`)].join("\n"));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(out.join("\n"));
}

main().catch((e) => { console.error(e); process.exit(1); });
