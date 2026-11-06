/**
 * ABNeon study (owner 2026-11-06): backtest of the support bounce with entry-time features, to see
 * what separates good bounces from stops — and whether level breakouts are told apart from bounces.
 *
 * Detector: the production evaluateAbneonSupportBounce, live settings (Neon zones on 4H, sweep rule
 * k = 3, confirmation on the closed 1H candle only — the 15m path is off in production). One open
 * trade per symbol. A reaction that closes above the next Neon resistance is NOT a signal in
 * production (abneon_level_breakout_not_bounce); here it is kept as its own row (kind = breakout,
 * entry at that candle's close) so both can be compared on the same rules.
 *
 * Not reproduced (they need history the public API does not give): the live gates on aggregated
 * (CoinGlass) volume, takers and spot CVD. BingX volume of the same candles is recorded instead, so its
 * effect can be measured. Public BingX klines only; no DB writes, no secrets.
 *
 * Outcome on 15m candles, 72 h after the entry (stop first when both are hit in one candle):
 *  - out: GOOD = +10% before −8%, STOP = −8% before +10%, MID = neither in 72 h;
 *  - win5: +5% before −8% (the bot's rule); trk = live tracker exit (stop −8%, B.U. after +8%, trailing
 *    from +15% at 10 p.p.), % net of 0.1% fee; peak72 / worst72 = best / worst move in 72 h.
 *
 * Run (from artifacts/api-server):
 *   npx tsx scripts/abneon-study.ts --days 60 --out ../../reports/abneon-study
 * Optional: --symbols AIN-USDT,JCT-USDT  --limit 50
 * Output: trades.csv (one row per signal: coin, time, every feature, outcome), summary.txt, errors.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABNEON_LEVEL_BREAKOUT_REASON,
  computeSupportZones,
  evaluateAbneonSupportBounce,
  resolveFrozenZone,
  type ClosedDetectorCandle,
} from "../src/lib/stealth-abneon-detectors.js";
import { computeWyckoff } from "../src/lib/wyckoff-metrics.js";
import { ictReading } from "../src/lib/ict.js";

type C = ClosedDetectorCandle;
const H1 = 3_600_000;
const H4 = 4 * H1;
const M15 = 900_000;
const BASE = "https://open-api.bingx.com";
const STOP_PCT = 8;
const FEE = 0.1;
const HORIZON_MS = 72 * H1;
const ARM_TTL_MS = 24 * H1;
const SWEEP = 3;

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "abneon-study";
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
      const time = Number(k.time), close = Number(k.close), volume = Number(k.volume);
      rows.set(time, { time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close, volume, volumeUsd: volume * close });
    }
    cursor = pageEnd;
    await sleep(60);
  }
  return [...rows.values()].sort((a, b) => a.time - b.time);
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
/**
 * Owner's «VSA Wyckoff Volume» (same as CAB entry-volume-colors): Wilder MA(20) seeded with 0,
 * ma := ma + (v − ma) / 20 with the bar's own volume inside, ratio = v / ma; colour letter.
 * Note: the MA starts at the first loaded bar (≈220 h before the window), so early bars are not used.
 */
function vsaColor(vols: number[], i: number): { ratio: number | null; color: string | null } {
  let ma = 0;
  for (let k = 0; k <= i; k++) ma = ma + (vols[k]! - ma) / 20;
  if (!(ma > 0) || i < 100) return { ratio: null, color: null };
  const r = vols[i]! / ma;
  const color = r >= 2.2 ? "P" : r >= 1.8 ? "R" : r >= 1.2 ? "O" : r >= 0.8 ? "G" : r >= 0.4 ? "B" : "S";
  return { ratio: r, color };
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

type Row = Record<string, string | number | null>;

function outcome(m15: C[], from: number, entry: number) {
  const stop = entry * (1 - STOP_PCT / 100);
  let out: "GOOD" | "STOP" | null = null, win5: number | null = null, peak = 0, worst = 0, last: C | null = null;
  let decidedAt: number | null = null;
  let trkStop = stop, trkPeak = entry, trk: number | null = null;
  for (const c of m15) {
    if (c.time < from) continue;
    if (c.time >= from + HORIZON_MS) break;
    last = c;
    if (out === null && c.low <= stop) out = "STOP";
    if (out === null && c.high >= entry * 1.1) out = "GOOD";
    if (out !== null && decidedAt === null) decidedAt = c.time + M15;
    if (win5 === null && c.low <= stop) win5 = 0;
    if (win5 === null && c.high >= entry * 1.05) win5 = 1;
    if (trk === null) {
      if (c.low <= trkStop) trk = (trkStop / entry - 1) * 100 - FEE;
      else {
        trkPeak = Math.max(trkPeak, c.high);
        const pp = (trkPeak / entry - 1) * 100;
        if (pp >= 8) trkStop = Math.max(trkStop, entry);
        if (pp >= 15) trkStop = Math.max(trkStop, entry * (1 + (pp - 10) / 100));
      }
    }
    peak = Math.max(peak, (c.high / entry - 1) * 100);
    worst = Math.min(worst, (c.low / entry - 1) * 100);
  }
  const complete = from + HORIZON_MS <= Date.now();
  if (trk === null && last && complete) trk = (last.close / entry - 1) * 100 - FEE;
  return {
    out: out ?? (complete ? "MID" : "OPEN"),
    win5: win5 ?? (complete ? 0 : null),
    trk,
    peak72: peak,
    worst72: worst,
    close72: complete && last ? (last.close / entry - 1) * 100 : null,
    /** One trade per symbol: the next signal is possible after +10% / −8% or 72 h. */
    resolvedAt: decidedAt ?? from + HORIZON_MS,
  };
}

function features(kind: string, trig: C, frozenLevel: number, armTime: number, h4: C[], h1: C[], btc4h: C[], t: number, entry: number): Row {
  const c4 = h4.filter((c) => c.time + H4 <= t);
  const c1 = h1.filter((c) => c.time + H1 <= t);
  const zone = resolveFrozenZone(c4, armTime, frozenLevel, H4);
  const zones = computeSupportZones(c4);
  const above = zones.filter((z) => z.bottom > zone.top).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
  const below = zones.filter((z) => z.top < zone.bottom).sort((a, b) => b.top - a.top)[0] ?? null;
  const at = (arr: C[], ms: number, step: number) => arr.filter((c) => c.time + step <= t - ms).at(-1)?.close ?? Number.NaN;
  const last180 = c4.slice(-180);
  const hi30 = last180.length ? Math.max(...last180.map((c) => c.high)) : Number.NaN;
  const lo30 = last180.length ? Math.min(...last180.map((c) => c.low)) : Number.NaN;
  const e50 = ema(c4.map((c) => c.close), 50);
  const e200 = ema(c4.map((c) => c.close), 200);
  const vol24 = c1.slice(-24).reduce((a, c) => a + (c.volumeUsd ?? 0), 0);
  const vol7d = c1.slice(-168).reduce((a, c) => a + (c.volumeUsd ?? 0), 0) / 7;
  // Touch window: 1H candles from the arm to the reaction — how deep under the zone price went.
  const win = c1.filter((c) => c.time + H1 > armTime && c.time <= trig.time);
  const minLow = win.length ? Math.min(...win.map((c) => c.low)) : trig.low;
  const touches30d = last180.filter((c) => c.low <= zone.top && c.high >= zone.bottom).length;
  // Reaction candle VSA on 1H (BingX volume).
  const vols = c1.map((c) => c.volume);
  const ti = c1.findIndex((c) => c.time === trig.time);
  const vsa = ti >= 0 ? vsaColor(vols, ti) : { ratio: null, color: null };
  const avg20 = ti >= 20 ? vols.slice(ti - 20, ti).reduce((a, b) => a + b, 0) / 20 : null;
  const spreadAvg = ti >= 20 ? c1.slice(ti - 20, ti).reduce((a, c) => a + (c.high - c.low), 0) / 20 : null;
  // Wyckoff on the 48 hourly bars before the entry (CAB rules).
  let wy: ReturnType<typeof computeWyckoff> | null = null;
  if (ti >= 0) {
    const volMap = new Map(c1.map((c) => [c.time, c.volume]));
    wy = computeWyckoff(c1.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })), volMap, trig.time);
  }
  // ICT on 1H (same module as CAB / Nihilist), window = last 24 bars.
  const ib = c1.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
  const ie = ib.findIndex((x) => x.time === trig.time);
  const ict = ie >= 0 ? (ictReading(ib, ie, { w0: ie - 23, levelTop: zone.top, levelBottom: zone.bottom }) as Record<string, any>) : null;
  const btc = btc4h.filter((c) => c.time + H4 <= t);
  const btcClose = btc.at(-1)?.close ?? Number.NaN;
  const btc24 = btc.filter((c) => c.time + H4 <= t - 24 * H1).at(-1)?.close ?? Number.NaN;
  const btcE50 = ema(btc.map((c) => c.close), 50);
  return {
    kind,
    zone_bottom: zone.bottom,
    zone_top: zone.top,
    zone_pivots: zone.count,
    zone_height_pct: pct(zone.top, zone.bottom),
    zone_touches_30d: touches30d,
    arm_age_h: (t - armTime) / H1,
    sweep_below_zone_pct: pct(zone.bottom, minLow),
    entry_above_zone_top_pct: pct(entry, zone.top),
    room_to_next_resistance_pct: above ? pct(above.bottom, entry) : null,
    next_resistance_pivots: above ? above.count : null,
    next_support_below_pct: below ? pct(entry, below.top) : null,
    zones_total: zones.length,
    trig_body_pct: pct(trig.close, trig.open),
    trig_range_pct: trig.open > 0 ? ((trig.high - trig.low) / trig.open) * 100 : null,
    trig_close_pos: trig.high > trig.low ? (trig.close - trig.low) / (trig.high - trig.low) : null,
    trig_vol_ratio20: avg20 && avg20 > 0 ? trig.volume / avg20 : null,
    trig_spread_ratio20: spreadAvg && spreadAvg > 0 ? (trig.high - trig.low) / spreadAvg : null,
    trig_vsa_ratio: vsa.ratio,
    trig_vsa_color: vsa.color,
    trig_welkin: ti >= 0 ? welkin(vols, ti) : null,
    welkin_grey_prev3: ti >= 3 ? [1, 2, 3].filter((k) => welkin(vols, ti - k) === "N").length : null,
    atr4h_pct: wilderAtrPct(c4.slice(-200)),
    atr1h_pct: wilderAtrPct(c1.slice(-200)),
    price_4h_pct: pct(entry, at(c1, 4 * H1, H1)),
    price_24h_pct: pct(entry, at(c1, 24 * H1, H1)),
    price_7d_pct: pct(entry, at(c4, 7 * 24 * H1, H4)),
    from_high30d_pct: pct(entry, hi30),
    from_low30d_pct: pct(entry, lo30),
    vs_ema50_4h_pct: e50 ? pct(entry, e50) : null,
    vs_ema200_4h_pct: e200 ? pct(entry, e200) : null,
    vol24h_vs_7d: vol7d > 0 ? vol24 / vol7d : null,
    vol24h_usd_bingx: vol24,
    wy_phase: wy?.phase ?? null,
    wy_position: wy?.entryPositionInRange ?? null,
    wy_range_height_pct: wy?.rangeHeightPct ?? null,
    wy_spring: wy ? wy.events.filter((e) => e.type === "spring").length : null,
    wy_sos: wy ? wy.events.filter((e) => e.type === "sign_of_strength").length : null,
    ict_sweep14: ict?.sweep14?.swept ?? null,
    ict_mss: ict?.sweep14?.mss ?? null,
    ict_structure: ict?.structure ?? null,
    ict_premium_discount: ict?.premiumDiscount ?? null,
    btc_24h_pct: pct(btcClose, btc24),
    btc_vs_ema50_4h_pct: btcE50 ? pct(btcClose, btcE50) : null,
  };
}

function simulate(symbol: string, h4: C[], h1: C[], m15: C[], btc4h: C[], from: number, now: number): Row[] {
  const out: Row[] = [];
  let arm: { level: number; time: number; breakoutSeen: boolean } | null = null;
  let busyUntil = -Infinity;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    if (t < busyUntil) continue;
    const res = evaluateAbneonSupportBounce({
      candles4h: h4.filter((c) => c.time + H4 <= t && c.time >= t - 640 * H4),
      candles1h: h1.filter((c) => c.time + H1 <= t && c.time >= t - 30 * H1),
      observedAt: t,
      marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: SWEEP,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const trig = h1.find((c) => c.time === res.triggerCandleTime);
      arm = null;
      if (!trig) continue;
      const o = outcome(m15, t, trig.close);
      out.push({
        symbol,
        time_utc: new Date(t).toISOString(),
        entry: trig.close,
        ...features("bounce", trig, res.frozenLevel, res.armCandleTime, h4, h1, btc4h, t, trig.close),
        ...o,
        resolvedAt: null,
      });
      busyUntil = Math.max(t + H1, o.resolvedAt);
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime, breakoutSeen: false };
      if (res.reason === ABNEON_LEVEL_BREAKOUT_REASON && !arm.breakoutSeen) {
        arm.breakoutSeen = true;
        const trig = h1.find((c) => c.time + H1 === t) ?? h1.filter((c) => c.time + H1 <= t).at(-1);
        if (trig) {
          const o = outcome(m15, t, trig.close);
          out.push({
            symbol,
            time_utc: new Date(t).toISOString(),
            entry: trig.close,
            ...features("breakout", trig, arm.level, arm.time, h4, h1, btc4h, t, trig.close),
            ...o,
            resolvedAt: null,
          });
        }
      }
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
}

function summary(rows: Row[], from: number, now: number): string {
  const lines: string[] = [];
  const mid = from + (now - HORIZON_MS - from) / 2;
  const c = (rs: Row[]) => {
    const done = rs.filter((r) => r.out !== "OPEN");
    const n = (k: string) => done.filter((r) => r.out === k).length;
    const trk = done.filter((r) => typeof r.trk === "number").reduce((a, r) => a + (r.trk as number), 0);
    return `${done.length} сделок: GOOD ${n("GOOD")} (${done.length ? Math.round((100 * n("GOOD")) / done.length) : 0}%), STOP ${n("STOP")} (${done.length ? Math.round((100 * n("STOP")) / done.length) : 0}%), MID ${n("MID")}; трекер сумма ${trk.toFixed(1)}%`;
  };
  for (const kind of ["bounce", "breakout"]) {
    const rs = rows.filter((r) => r.kind === kind);
    lines.push(`== ${kind}: ${c(rs)}`);
    lines.push(`   первая половина: ${c(rs.filter((r) => Date.parse(String(r.time_utc)) < mid))}`);
    lines.push(`   вторая половина: ${c(rs.filter((r) => Date.parse(String(r.time_utc)) >= mid))}`);
  }
  return lines.join("\n");
}

async function main() {
  const now = Date.now();
  const from = now - DAYS * 24 * H1;
  let symbols: string[];
  if (ONLY) symbols = ONLY;
  else {
    const contracts = (await getJson("/openApi/swap/v2/quote/contracts")) as Array<{ symbol: string }>;
    symbols = contracts.map((c) => c.symbol).filter((s) => s.endsWith("-USDT") && !s.startsWith("BTC-") && !/^NC(SK|CO|SI)/.test(s)).slice(0, LIMIT);
  }
  mkdirSync(OUT, { recursive: true });
  const btc4h = await klines("BTC-USDT", "4h", from - 300 * H4, now);
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  let done = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(symbol, "4h", from - 620 * H4, now);
      const h1 = await klines(symbol, "1h", from - 220 * H1, now);
      const m15 = await klines(symbol, "15m", from - 8 * M15, now);
      if (h4.length < 50 || h1.length < 50) errors[symbol] = "short_history";
      else rows.push(...simulate(symbol, h4, h1, m15, btc4h, from, now));
    } catch (err) {
      errors[symbol] = String(err).slice(0, 120);
    }
    done++;
    if (done % 25 === 0) console.error(`${done}/${symbols.length} symbols, ${rows.length} rows`);
  }
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "resolvedAt");
  const fmt = (v: unknown) => (v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(+v.toFixed(5)) : "") : String(v));
  writeFileSync(join(OUT, "trades.csv"), [keys.join(","), ...rows.map((r) => keys.map((k) => fmt(r[k])).join(","))].join("\n"));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const s = `period ${new Date(from).toISOString()} .. ${new Date(now).toISOString()}, symbols ${symbols.length}, errors ${Object.keys(errors).length}\n` + summary(rows, from, now);
  writeFileSync(join(OUT, "summary.txt"), s);
  console.log(s);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
