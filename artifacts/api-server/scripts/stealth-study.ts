/**
 * Stealth study (owner 2026-11-06): backtest of the new Stealth — breakout of an ABNeon resistance
 * level on a closed 4H or 1D candle — with entry-time features, to see what separates good breakouts
 * from stops, how many signals there are, and what repeated crossings of the same level do.
 *
 * Detector: the production evaluateNeonLevelBreakout (lib/stealth-neon-level-breakout.ts), unchanged:
 * Neon zones on 4H (last 700 bars, like the live cache), 4H close above a zone top after a close at/below
 * it; at the 20:00 UTC 4H close also the UTC day (1D wins when both). Entry = breakout candle close.
 *
 * Every event is written (fired = 0 when a previous Stealth trade of the symbol was still open — the live
 * duplicate guard), so repeated crossings can be studied too.
 *
 * Outcomes on 15m candles (stop first when both are hit in one candle), fee 0.1%:
 *  - out72 / out7d: GOOD = +10% before −8%, STOP = −8% before +10%, MID = neither (72 h / 7 days);
 *  - win5: +5% before −8%; trk = live Stealth exit (stop −8%, B.U. after +8%, trailing from +15% at
 *    10 p.p.), closed at the 7-day close if still open; trk_hours = how long it lasted;
 *  - peak / worst over 72 h and 7 days.
 *
 * Public BingX klines only; no DB, no secrets.
 * Run (from artifacts/api-server):
 *   pnpm dlx tsx scripts/stealth-study.ts --days 60 --out ../../reports/stealth-study
 * Optional: --symbols AIN-USDT,JCT-USDT  --limit 50
 * Output: trades.csv (one row per event: coin, time, TF, every feature, outcome), summary.txt, errors.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { dailyFrom4h, evaluateNeonLevelBreakout, type NlCandle } from "../src/lib/stealth-neon-level-breakout.js";
import { computeWyckoff } from "../src/lib/wyckoff-metrics.js";
import { ictReading } from "../src/lib/ict.js";

type C = NlCandle;
const H1 = 3_600_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const M15 = 900_000;
const BASE = "https://open-api.bingx.com";
const STOP_PCT = 8;
const FEE = 0.1;
const H72 = 72 * H1;
const D7 = 7 * D1;
const ZONE_BARS = 700;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "stealth-study";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(path: string): Promise<any> {
  let last: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path);
      const json = await res.json();
      if (json.code === 0) return json.data;
      last = new Error(`code ${json.code} ${json.msg}`);
    } catch (err) {
      last = err;
    }
    await sleep(800 * (attempt + 1));
  }
  throw last;
}
async function klines(symbol: string, interval: "15m" | "1h" | "4h", start: number, end: number): Promise<C[]> {
  const step = interval === "15m" ? M15 : interval === "1h" ? H1 : H4;
  const rows = new Map<number, C>();
  let cursor = start;
  while (cursor < end) {
    const pageEnd = Math.min(end, cursor + step * 1000);
    const data = (await getJson(
      `/openApi/swap/v3/quote/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${pageEnd}&limit=1000`,
    )) as Array<Record<string, string | number>>;
    for (const k of data ?? []) {
      const time = Number(k.time);
      rows.set(time, { time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) });
    }
    cursor = pageEnd;
    await sleep(60);
  }
  return [...rows.values()].filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
}

const pct = (a: number, b: number): number | null => (b > 0 && Number.isFinite(a) && Number.isFinite(b) ? (a / b - 1) * 100 : null);
function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (const v of values.slice(n)) e = v * k + e * (1 - k);
  return e;
}
function wilderAtrPct(cs: C[], n = 14): number | null {
  if (cs.length <= n) return null;
  const tr = cs.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1]!.close), Math.abs(c.low - cs[i - 1]!.close))));
  let atr = tr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < tr.length; i++) atr = (atr * (n - 1) + tr[i]!) / n;
  const close = cs.at(-1)!.close;
  return close > 0 ? (atr / close) * 100 : null;
}
/** Owner's «VSA Wyckoff Volume»: Wilder MA(20) seeded with 0, bar inside its own MA; colour letter. */
function vsaColor(vols: number[], i: number): { ratio: number | null; color: string | null } {
  let ma = 0;
  for (let k = 0; k <= i; k++) ma = ma + (vols[k]! - ma) / 20;
  if (!(ma > 0) || i < 60) return { ratio: null, color: null };
  const r = vols[i]! / ma;
  return { ratio: r, color: r >= 2.2 ? "P" : r >= 1.8 ? "R" : r >= 1.2 ? "O" : r >= 0.8 ? "G" : r >= 0.4 ? "B" : "S" };
}
/** Owner's «Welkin VSA»: SMA(20) ± σ including the bar. */
function welkin(vols: number[], i: number): string | null {
  if (i < 19) return null;
  const w = vols.slice(i - 19, i + 1);
  const avg = w.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / 20);
  const v = vols[i]!;
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  const prev = i > 0 ? vols[i - 1]! : 0;
  if (prev > 0 && v / prev >= 1.25) return "Y";
  if (v < avg) return "N";
  return "=";
}
/** Candle, VSA, Welkin, Wyckoff and ICT of bar `i` in series `cs` (any timeframe). */
function barReadings(prefix: string, cs: C[], i: number, levelTop: number | null, levelBottom: number | null): Row {
  if (i < 0) return {};
  const b = cs[i]!;
  const vols = cs.map((c) => c.volume);
  const avg20 = i >= 20 ? vols.slice(i - 20, i).reduce((a, x) => a + x, 0) / 20 : null;
  const spr20 = i >= 20 ? cs.slice(i - 20, i).reduce((a, c) => a + (c.high - c.low), 0) / 20 : null;
  const vsa = vsaColor(vols, i);
  const wy = computeWyckoff(cs.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })), new Map(cs.map((c) => [c.time, c.volume])), b.time);
  const ib = cs.map((c) => ({ ...c }));
  const ict = i >= 30 ? (ictReading(ib, i, { w0: i - 23, levelTop, levelBottom }) as Record<string, any>) : null;
  return {
    [`${prefix}_body_pct`]: pct(b.close, b.open),
    [`${prefix}_range_pct`]: b.open > 0 ? ((b.high - b.low) / b.open) * 100 : null,
    [`${prefix}_close_pos`]: b.high > b.low ? (b.close - b.low) / (b.high - b.low) : null,
    [`${prefix}_vol_ratio20`]: avg20 && avg20 > 0 ? b.volume / avg20 : null,
    [`${prefix}_spread_ratio20`]: spr20 && spr20 > 0 ? (b.high - b.low) / spr20 : null,
    [`${prefix}_vsa_ratio`]: vsa.ratio,
    [`${prefix}_vsa_color`]: vsa.color,
    [`${prefix}_welkin`]: welkin(vols, i),
    [`${prefix}_welkin_grey_prev3`]: i >= 3 ? [1, 2, 3].filter((k) => welkin(vols, i - k) === "N").length : null,
    [`${prefix}_colored_prev12`]: i >= 12 ? [...Array(12).keys()].map((k) => vsaColor(vols, i - 1 - k).color).filter((c) => c === "P" || c === "R" || c === "O").length : null,
    [`${prefix}_wy_phase`]: wy.phase,
    [`${prefix}_wy_position`]: wy.entryPositionInRange,
    [`${prefix}_wy_range_height_pct`]: wy.rangeHeightPct,
    [`${prefix}_wy_spring`]: wy.events.filter((e) => e.type === "spring").length,
    [`${prefix}_wy_sos`]: wy.events.filter((e) => e.type === "sign_of_strength").length,
    [`${prefix}_ict_sweep14`]: ict?.sweep14?.swept ?? null,
    [`${prefix}_ict_mss`]: ict?.sweep14?.mss ?? null,
    [`${prefix}_ict_structure`]: ict?.structure ?? null,
    [`${prefix}_ict_premium_discount`]: ict?.premiumDiscount ?? null,
    [`${prefix}_ict_fvg_bear_above`]: ict?.fvgBearAboveCount ?? null,
    [`${prefix}_ict_broke_high`]: ict?.entryBarBrokeHigh ?? null,
    [`${prefix}_ict_swept_high`]: ict?.entryBarSweptHigh ?? null,
    [`${prefix}_atr_pct`]: wilderAtrPct(cs.slice(Math.max(0, i - 199), i + 1)),
  };
}

type Row = Record<string, string | number | boolean | null>;

function outcome(m15: C[], from: number, entry: number) {
  const stop = entry * (1 - STOP_PCT / 100);
  const res = (horizon: number) => {
    let out: string | null = null, peak = 0, worst = 0, last: C | null = null;
    for (const c of m15) {
      if (c.time < from) continue;
      if (c.time >= from + horizon) break;
      last = c;
      if (out === null && c.low <= stop) out = "STOP";
      if (out === null && c.high >= entry * 1.1) out = "GOOD";
      peak = Math.max(peak, (c.high / entry - 1) * 100);
      worst = Math.min(worst, (c.low / entry - 1) * 100);
    }
    const complete = from + horizon <= Date.now();
    return { out: out ?? (complete ? "MID" : "OPEN"), peak, worst, close: complete && last ? (last.close / entry - 1) * 100 : null };
  };
  let win5: number | null = null;
  let trkStop = stop, trkPeak = entry, trk: number | null = null, trkEnd: number | null = null, last: C | null = null;
  for (const c of m15) {
    if (c.time < from) continue;
    if (c.time >= from + D7) break;
    last = c;
    if (win5 === null && c.low <= stop) win5 = 0;
    if (win5 === null && c.high >= entry * 1.05) win5 = 1;
    if (trk === null) {
      if (c.low <= trkStop) {
        trk = (trkStop / entry - 1) * 100 - FEE;
        trkEnd = c.time + M15;
      } else {
        trkPeak = Math.max(trkPeak, c.high);
        const pp = (trkPeak / entry - 1) * 100;
        if (pp >= 8) trkStop = Math.max(trkStop, entry);
        if (pp >= 15) trkStop = Math.max(trkStop, entry * (1 + (pp - 10) / 100));
      }
    }
  }
  const complete7 = from + D7 <= Date.now();
  if (trk === null && last && complete7) {
    trk = (last.close / entry - 1) * 100 - FEE;
    trkEnd = from + D7;
  }
  const r72 = res(H72), r7 = res(D7);
  return {
    out72: r72.out, peak72: r72.peak, worst72: r72.worst, close72: r72.close,
    out7d: r7.out, peak7d: r7.peak, worst7d: r7.worst, close7d: r7.close,
    win5: win5 ?? (complete7 ? 0 : null),
    trk,
    trk_hours: trkEnd !== null ? (trkEnd - from) / H1 : null,
    /** Live duplicate guard: the next Stealth of the symbol waits until this trade is closed. */
    busyUntil: trkEnd ?? Number.POSITIVE_INFINITY,
  };
}

function simulate(symbol: string, h4: C[], h1: C[], m15: C[], btc4h: C[], from: number, now: number): Row[] {
  const out: Row[] = [];
  const past: { at: number; top: number }[] = [];
  let busyUntil = -Infinity;
  const days = dailyFrom4h(h4);
  for (let start = Math.ceil(from / H4) * H4; start + H4 <= now; start += H4) {
    const t = start + H4; // close time = entry time
    const hist = h4.filter((c) => c.time <= start).slice(-ZONE_BARS);
    const ev = evaluateNeonLevelBreakout(hist, start);
    if (!ev) continue;
    const entry = ev.close;
    const fired = t >= busyUntil;
    const sameLevel = past.filter((p) => t - p.at <= 30 * D1 && Math.abs(p.top - ev.level.top) / ev.level.top <= 0.01);
    past.push({ at: t, top: ev.level.top });
    // Bars since a 4H close was last above the level top before this breakout.
    let barsSinceAbove: number | null = null;
    for (let k = hist.length - 2; k >= 0; k--) if (hist[k]!.close > ev.level.top) { barsSinceAbove = hist.length - 1 - k; break; }
    const zones = computeSupportZones(hist);
    const below = zones.filter((z) => z.top < ev.level.bottom).sort((a, b) => b.top - a.top)[0] ?? null;
    const c4 = hist;
    const c1 = h1.filter((c) => c.time + H1 <= t);
    const last180 = c4.slice(-180);
    const hi30 = last180.length ? Math.max(...last180.map((c) => c.high)) : Number.NaN;
    const lo30 = last180.length ? Math.min(...last180.map((c) => c.low)) : Number.NaN;
    const e50 = ema(c4.map((c) => c.close), 50), e200 = ema(c4.map((c) => c.close), 200);
    const at1 = (ms: number) => c1.filter((c) => c.time + H1 <= t - ms).at(-1)?.close ?? Number.NaN;
    const vol24 = c1.slice(-24).reduce((a, c) => a + c.volume * c.close, 0);
    const vol7d = c1.slice(-168).reduce((a, c) => a + c.volume * c.close, 0) / 7;
    const btc = btc4h.filter((c) => c.time + H4 <= t);
    const btcClose = btc.at(-1)?.close ?? Number.NaN;
    const btc24 = btc.filter((c) => c.time + H4 <= t - D1).at(-1)?.close ?? Number.NaN;
    const btcE50 = ema(btc.map((c) => c.close), 50);
    // Readings on the breakout timeframe and on the last closed 1H bar.
    const tfSeries = ev.tf === "4h" ? c4 : days.filter((d) => d.time + D1 <= t);
    const tfIdx = tfSeries.findIndex((c) => c.time === ev.candleTime);
    const o = outcome(m15, t, entry);
    if (fired) busyUntil = o.busyUntil;
    out.push({
      symbol,
      time_utc: new Date(t).toISOString(),
      tf: ev.tf,
      fired: fired ? 1 : 0,
      entry,
      prev_close: ev.prevClose,
      level_bottom: ev.level.bottom,
      level_top: ev.level.top,
      level_pivots: ev.level.count,
      level_height_pct: pct(ev.level.top, ev.level.bottom),
      levels_crossed: ev.crossed.length,
      close_above_level_pct: pct(entry, ev.level.top),
      prev_close_below_level_pct: pct(ev.level.top, ev.prevClose),
      room_to_next_resistance_pct: ev.nextResistance ? pct(ev.nextResistance.bottom, entry) : null,
      next_resistance_pivots: ev.nextResistance?.count ?? null,
      next_support_below_pct: below ? pct(entry, below.top) : null,
      zones_total: ev.zones.length,
      same_level_breakouts_30d_before: sameLevel.length,
      bars4h_since_close_above_level: barsSinceAbove,
      ...barReadings("tf", tfSeries, tfIdx, ev.level.top, ev.level.bottom),
      ...barReadings("h1", c1, c1.length - 1, ev.level.top, ev.level.bottom),
      price_24h_pct: pct(entry, at1(D1)),
      price_7d_pct: pct(entry, c4.filter((c) => c.time + H4 <= t - 7 * D1).at(-1)?.close ?? Number.NaN),
      from_high30d_pct: pct(entry, hi30),
      from_low30d_pct: pct(entry, lo30),
      vs_ema50_4h_pct: e50 ? pct(entry, e50) : null,
      vs_ema200_4h_pct: e200 ? pct(entry, e200) : null,
      vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null,
      vol24h_usd_bingx: vol24,
      btc_24h_pct: pct(btcClose, btc24),
      btc_vs_ema50_4h_pct: btcE50 ? pct(btcClose, btcE50) : null,
      out72: o.out72, peak72: o.peak72, worst72: o.worst72, close72: o.close72,
      out7d: o.out7d, peak7d: o.peak7d, worst7d: o.worst7d, close7d: o.close7d,
      win5: o.win5, trk: o.trk, trk_hours: o.trk_hours,
    });
  }
  return out;
}

function summary(rows: Row[], from: number, now: number, symbols: number): string {
  const lines: string[] = [];
  const mid = from + (now - D7 - from) / 2;
  const c = (rs: Row[]) => {
    const done = rs.filter((r) => r.out72 !== "OPEN");
    const n = (k: string) => done.filter((r) => r.out72 === k).length;
    const p = (k: string) => (done.length ? Math.round((100 * n(k)) / done.length) : 0);
    const trk = rs.filter((r) => typeof r.trk === "number");
    return `${rs.length} событий (${done.length} с итогом 72ч): GOOD ${n("GOOD")} (${p("GOOD")}%), STOP ${n("STOP")} (${p("STOP")}%), MID ${n("MID")}; трекер сумма ${trk.reduce((a, r) => a + (r.trk as number), 0).toFixed(1)}% на ${trk.length}`;
  };
  const daysN = (now - from) / D1;
  for (const tf of ["4h", "1d"]) {
    for (const fired of [1, 0]) {
      const rs = rows.filter((r) => r.tf === tf && r.fired === fired);
      lines.push(`== ${tf} ${fired ? "сигналы (вошли бы)" : "повторы при открытой сделке (не вошли бы)"}: ${c(rs)}; в день ${(rs.length / daysN).toFixed(1)}`);
      if (fired) {
        lines.push(`   первая половина: ${c(rs.filter((r) => Date.parse(String(r.time_utc)) < mid))}`);
        lines.push(`   вторая половина: ${c(rs.filter((r) => Date.parse(String(r.time_utc)) >= mid))}`);
        lines.push(`   уровень уже пробивался за 30 дней: ${c(rs.filter((r) => Number(r.same_level_breakouts_30d_before) > 0))}`);
        lines.push(`   первый пробой уровня за 30 дней: ${c(rs.filter((r) => Number(r.same_level_breakouts_30d_before) === 0))}`);
      }
    }
  }
  lines.push(`монет ${symbols}, дней ${daysN.toFixed(0)}`);
  return lines.join("\n");
}

async function main() {
  const now = Date.now();
  const from = now - DAYS * D1;
  let symbols: string[];
  if (ONLY) symbols = ONLY;
  else {
    const contracts = (await getJson("/openApi/swap/v2/quote/contracts")) as Array<{ symbol: string }>;
    symbols = contracts.map((x) => x.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-") && !/^NC(SK|CO|SI)/.test(s)).slice(0, LIMIT);
  }
  mkdirSync(OUT, { recursive: true });
  const btc4h = await klines("BTC-USDT", "4h", from - 300 * H4, now);
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(symbol, "4h", from - (ZONE_BARS + 10) * H4, now);
      const h1 = await klines(symbol, "1h", from - 220 * H1, now);
      const m15 = await klines(symbol, "15m", from - 8 * M15, now);
      if (h4.length < 100 || h1.length < 50) errors[symbol] = "short_history";
      else rows.push(...simulate(symbol, h4, h1, m15, btc4h, from, now));
    } catch (err) {
      errors[symbol] = String(err).slice(0, 120);
    }
    done++;
    if (done % 25 === 0) console.error(`${done}/${symbols.length} symbols, ${rows.length} rows`);
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const fmt = (v: unknown) => (v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(5)) : "") : String(v));
  writeFileSync(join(OUT, "trades.csv"), [keys.join(","), ...rows.map((r) => keys.map((k) => fmt(r[k])).join(","))].join("\n"));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const s = `period ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, symbols ${symbols.length}, errors ${Object.keys(errors).length}\n` + summary(rows, from, now, symbols.length);
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
