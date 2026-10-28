/**
 * Read-only research for a NEW Stealth detection (owner 2026-10-28: the 1H Auto
 * Range break catches the wrong moves and misses the champions).
 *
 * Instead of trading one detector, it records EVERY closed 1H candle that
 * closes at a new 24H high (a superset of all breakout-style detectors) with
 * features known at that candle's close, plus outcomes. Detection rules are
 * then designed and backtested on this file (filters on the features = the
 * detector), month by month, and checked against the market's champion moves.
 *
 * Outputs (in --out):
 *  events.csv     one row per new-24H-high close (all coins, last --days days)
 *  champions.csv  every move of >= +20% within 72h: base (lowest close before
 *                 the peak), launch (last close within +3% of the base before
 *                 +10% is reached), time of +10%; next episode after the peak
 *  errors.json, summary.txt
 *
 * Outcomes (1H candles, 72h, entry = event candle close, stop first if both hit
 * in one candle, fee 0.1%):
 *  fx8_t5 / fx8_t10   take +5 / +10 before a fixed -8% stop (else close at 72h)
 *  st_t5 / st_t10     same with a structural stop: lowest low of the 24 candles
 *                     before the event - 0.5%; stop_struct_pct = its distance
 *  peak72_pct, close72_pct, hrs_to_peak, mae_before_peak_pct (worst low before the peak)
 *
 * Public BingX klines only. No DB, no secrets. Volume = BingX quote volume.
 * Run (from artifacts/api-server):
 *   npx tsx scripts/stealth-new-detect-research.ts --days 100 --out ../../reports/full/stealth_research
 */
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { detectAutoRangePine1h } from "../src/lib/auto-range-pine.js";

const H1 = 3_600_000;
const BASE = "https://open-api.bingx.com";
const FEE = 0.1;
const HORIZON = 72;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const DAYS = Number(args.get("days") ?? 100);
const OUT = args.get("out") ?? "stealth_research";
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIMIT = Number(args.get("limit") ?? 10_000);

type C = { time: number; open: number; high: number; low: number; close: number; vol: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any> {
  let last: unknown;
  for (let a = 0; a < 5; a++) {
    try {
      const j: any = await (await fetch(BASE + path)).json();
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

const pct = (a: number, b: number) => (b > 0 ? (a / b - 1) * 100 : NaN);
const maxHigh = (cs: C[], a: number, b: number) => { let m = -Infinity; for (let j = Math.max(0, a); j < b; j++) m = Math.max(m, cs[j]!.high); return m; };
const minLow = (cs: C[], a: number, b: number) => { let m = Infinity; for (let j = Math.max(0, a); j < b; j++) m = Math.min(m, cs[j]!.low); return m; };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };

function atr(cs: C[], i: number, n = 14): number {
  if (i < n + 1) return NaN;
  let s = 0;
  for (let j = i - n; j < i; j++) s += Math.max(cs[j]!.high - cs[j]!.low, Math.abs(cs[j]!.high - cs[j - 1]!.close), Math.abs(cs[j]!.low - cs[j - 1]!.close));
  return s / n;
}

function emaSeries(cs: C[], n: number): number[] {
  const out: number[] = []; const k = 2 / (n + 1); let e = NaN;
  cs.forEach((c, i) => { e = i === 0 ? c.close : c.close * k + e * (1 - k); out.push(i >= n ? e : NaN); });
  return out;
}

/** Bollinger(20,2) width as % of the mid; percentile of the current width over the last 120 bars. */
function bbWidth(cs: C[], i: number): number {
  if (i < 20) return NaN;
  const xs = cs.slice(i - 19, i + 1).map((c) => c.close);
  const m = xs.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
  return m > 0 ? (4 * sd / m) * 100 : NaN;
}

function trade(cs: C[], i: number, entry: number, stop: number, take: number): number | null {
  const after = cs.slice(i + 1, i + 1 + HORIZON);
  if (after.length < HORIZON) return null;
  for (const c of after) {
    if (c.low <= stop) return pct(stop, entry) - FEE;
    if (c.high >= entry * (1 + take / 100)) return take - FEE;
  }
  return pct(after[after.length - 1]!.close, entry) - FEE;
}

const F = (v: number) => (Number.isFinite(v) ? String(+v.toFixed(4)) : "");

async function main() {
  const now = Date.now(), from = now - DAYS * 24 * H1;
  const symbols: string[] = ONLY ?? ((await getJson("/openApi/swap/v2/quote/contracts")) as { symbol: string }[])
    .map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-")).slice(0, LIMIT);
  mkdirSync(OUT, { recursive: true });
  const ev = createWriteStream(join(OUT, "events.csv"));
  const ch = createWriteStream(join(OUT, "champions.csv"));
  const cols = [
    "symbol", "time", "close",
    // breakout structure
    "brk_24", "brk_48", "brk_72", "brk_168", "dist_above_prev24h_high_pct",
    "base24_height_pct", "base48_height_pct", "base72_height_pct", "base168_height_pct",
    "ar_breakout", "ar_height_pct", "ar_hours",
    // candle
    "ret1h_pct", "body_pct", "body_atr", "range_atr", "close_pos", "upper_wick_pct",
    "vol_ratio_20med", "vol_ratio_20med_prev", "vol24_vs_7d", "vol24_usd",
    // context
    "ret3h_pct", "ret6h_pct", "ret24h_pct", "ret72h_pct", "ret7d_pct",
    "atr_pct", "atr24_vs_atr168", "bbw_pct", "bbw_pctile_120",
    "vs_ema50_pct", "vs_ema200_pct", "ema50_slope24_pct", "from_high30d_pct", "from_low30d_pct",
    "new24h_highs_prev24", "hours_since_prev_event",
    // outcomes
    "stop_struct_pct", "fx8_t5", "fx8_t10", "st_t5", "st_t10", "peak72_pct", "close72_pct", "hrs_to_peak", "mae_before_peak_pct",
  ];
  ev.write(cols.join(",") + "\n");
  ch.write("symbol,start_time,start_close,peak_pct,hrs_to_peak,hrs_to_plus10,launch_time,plus10_time\n");
  const errors: Record<string, string> = {};
  let nEv = 0, nCh = 0, done = 0;
  for (const symbol of symbols) {
    try {
      const cs = await candles1h(symbol, from - 800 * H1, now);
      if (cs.length < 400) { errors[symbol] = "short_history"; continue; }
      const ar = detectAutoRangePine1h(cs.map((c) => ({ ...c, closed: true })), { mergeDeviations: false });
      const arAt = new Map<number, { upper: number; lower: number; anchorAt: number }>();
      for (const b of ar.upsideBreakouts ?? []) arAt.set(b.breakoutCloseTime - H1, { upper: b.upper, lower: b.lower, anchorAt: b.anchorAt });
      const e50 = emaSeries(cs, 50), e200 = emaSeries(cs, 200);
      const bbw = cs.map((_, i) => bbWidth(cs, i));
      const vmed = cs.map((_, i) => (i >= 20 ? median(cs.slice(i - 20, i).map((c) => c.vol)) : NaN));
      const isNew24: boolean[] = cs.map((c, i) => i >= 24 && c.close > maxHigh(cs, i - 24, i));
      let lastEvent = -Infinity;
      // champions
      for (let i = 0; i < cs.length - HORIZON; i++) {
        if (cs[i]!.time < from) continue;
        const c0 = cs[i]!.close; let pk = -Infinity, pkAt = -1, t10 = -1;
        for (let j = i + 1; j <= i + HORIZON; j++) {
          if (cs[j]!.high > pk) { pk = cs[j]!.high; pkAt = j; }
          if (t10 < 0 && cs[j]!.high >= c0 * 1.1) t10 = j;
        }
        if (pk >= c0 * 1.2) {
          // Launch base: the lowest close between the first qualifying hour and the peak.
          let s = i;
          for (let j = i; j < pkAt; j++) if (cs[j]!.close < cs[s]!.close) s = j;
          const sc = cs[s]!.close;
          let p2 = -Infinity, p2At = -1, t2 = -1;
          for (let j = s + 1; j <= Math.min(cs.length - 1, s + HORIZON); j++) {
            if (cs[j]!.high > p2) { p2 = cs[j]!.high; p2At = j; }
            if (t2 < 0 && cs[j]!.high >= sc * 1.1) t2 = j;
          }
          // Launch: the last close still within +3% of the base before +10% is reached.
          let launch = s;
          for (let j = s; j < (t2 >= 0 ? t2 : p2At); j++) if (cs[j]!.close <= sc * 1.03) launch = j;
          ch.write([symbol, new Date(cs[s]!.time).toISOString(), sc, F(pct(p2, sc)), p2At - s, t2 >= 0 ? t2 - s : "",
            new Date(cs[launch]!.time).toISOString(), t2 >= 0 ? new Date(cs[t2]!.time).toISOString() : ""].join(",") + "\n");
          nCh++; i = Math.max(i, p2At);
        }
      }
      for (let i = 800; i < cs.length; i++) {
        const c = cs[i]!;
        if (c.time < from || !isNew24[i]) continue;
        const a = atr(cs, i), atr168 = atr(cs, i, 168);
        const prevHigh24 = maxHigh(cs, i - 24, i);
        const baseH = (n: number) => pct(maxHigh(cs, i - n, i), minLow(cs, i - n, i));
        const arb = arAt.get(c.time);
        const after = cs.slice(i + 1, i + 1 + HORIZON);
        let pk = -Infinity, pkAt = -1;
        after.forEach((x, j) => { if (x.high > pk) { pk = x.high; pkAt = j; } });
        const mae = pkAt >= 0 ? minLow(cs, i + 1, i + 2 + pkAt) : NaN;
        const stopStruct = minLow(cs, i - 24, i) * 0.995;
        const bbHist = bbw.slice(Math.max(0, i - 120), i).filter(Number.isFinite);
        const row = [
          symbol, new Date(c.time).toISOString(), c.close,
          1, c.close > maxHigh(cs, i - 48, i) ? 1 : 0, c.close > maxHigh(cs, i - 72, i) ? 1 : 0, c.close > maxHigh(cs, i - 168, i) ? 1 : 0,
          F(pct(c.close, prevHigh24)),
          F(baseH(24)), F(baseH(48)), F(baseH(72)), F(baseH(168)),
          arb ? 1 : 0, arb ? F(pct(arb.upper, arb.lower)) : "", arb ? F((c.time - arb.anchorAt) / H1) : "",
          F(pct(c.close, cs[i - 1]!.close)), F(pct(c.close, c.open)), F((c.close - c.open) / a), F((c.high - c.low) / a),
          F(c.high > c.low ? (c.close - c.low) / (c.high - c.low) : NaN), F(pct(c.high, Math.max(c.open, c.close))),
          F(c.vol / vmed[i]!), F(cs[i - 1]!.vol / vmed[i - 1]!),
          F(cs.slice(i - 23, i + 1).reduce((s, x) => s + x.vol, 0) / (cs.slice(i - 167, i + 1).reduce((s, x) => s + x.vol, 0) / 7)),
          F(cs.slice(i - 23, i + 1).reduce((s, x) => s + x.vol, 0)),
          F(pct(c.close, cs[i - 3]!.close)), F(pct(c.close, cs[i - 6]!.close)), F(pct(c.close, cs[i - 24]!.close)), F(pct(c.close, cs[i - 72]!.close)), F(pct(c.close, cs[i - 168]!.close)),
          F((a / c.close) * 100), F(atr(cs, i, 24) / atr168), F(bbw[i - 1]!), F(bbHist.length ? (bbHist.filter((x) => x <= bbw[i - 1]!).length / bbHist.length) * 100 : NaN),
          F(pct(c.close, e50[i]!)), F(pct(c.close, e200[i]!)), F(pct(e50[i]!, e50[i - 24]!)),
          F(pct(c.close, maxHigh(cs, i - 720, i))), F(pct(c.close, minLow(cs, i - 720, i))),
          isNew24.slice(i - 24, i).filter(Boolean).length, Number.isFinite(lastEvent) ? i - lastEvent : "",
          F(pct(stopStruct, c.close)),
          F(trade(cs, i, c.close, c.close * 0.92, 5) ?? NaN), F(trade(cs, i, c.close, c.close * 0.92, 10) ?? NaN),
          F(trade(cs, i, c.close, stopStruct, 5) ?? NaN), F(trade(cs, i, c.close, stopStruct, 10) ?? NaN),
          after.length === HORIZON ? F(pct(pk, c.close)) : "", after.length === HORIZON ? F(pct(after.at(-1)!.close, c.close)) : "",
          after.length === HORIZON ? pkAt + 1 : "", after.length === HORIZON ? F(pct(mae, c.close)) : "",
        ];
        ev.write(row.join(",") + "\n");
        nEv++; lastEvent = i;
      }
    } catch (err) { errors[symbol] = String(err).slice(0, 100); }
    if (++done % 50 === 0) console.error(`${done}/${symbols.length} symbols, ${nEv} events, ${nCh} champions`);
  }
  await new Promise<void>((r) => ev.end(r));
  await new Promise<void>((r) => ch.end(r));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const summary = `period ${new Date(from).toISOString()}..${new Date(now).toISOString()} symbols=${symbols.length} errors=${Object.keys(errors).length} events=${nEv} champions=${nCh}`;
  writeFileSync(join(OUT, "summary.txt"), summary + "\n");
  console.log(summary);
}

main().catch((e) => { console.error(e); process.exit(1); });
