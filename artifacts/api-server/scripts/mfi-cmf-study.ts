/**
 * MFI × CHAIKIN STUDY (owner 2026-11-09): do the Money Flow Index and the Chaikin indicators separate good and
 * bad signals of ABNeon, the new Stealth and Liquidation Cascade? Impulse Buy is settled and not studied.
 *
 * Reads event files and writes, for every row, the readings at the signal time (the last CLOSED bar), on 1H and
 * 4H BingX candles with the AGGREGATED volume (owner rule: aggregated only) of CoinGlass futures (aggfut) and of
 * spot (aggspot):
 *   mfi14            Money Flow Index (14)
 *   cmf20            Chaikin Money Flow (20)
 *   cho              Chaikin Oscillator (EMA3 − EMA10 of the A/D line) / 20-bar average volume
 *   cmf_long         Chaikin Money Flow over 3 days (1H: 72 bars) / 7 days (4H: 42 bars)
 *   mfi_bull_div / cmf_bull_div   price made a lower low (last 12 bars vs the 36 before) while the indicator did not
 *   mfi_bear_div / cmf_bear_div   price made a higher high while the indicator did not
 *   mfi_slope12 / cmf_slope12     change of the indicator over the last 12 bars
 * Every input column is kept, so the outcome columns of the source study stay next to the readings.
 *
 * Inputs (each written to <out>/<name>_mfi.csv):
 *   --abneon ../../reports/abneon-study-v3/trades.csv          (time: entry_time_ms)
 *   --stealth ../../reports/range-level-study/events_part1.csv,…  (time: entry_time_ms)
 *   --lc ../../reports/lc-signals.csv  (live LC from production; time: candle_closed_at or detected_at)
 * Offline from a cache with STUDY_OFFLINE=1 (--cache; --now from the cache's _breakout_now.txt), or online
 * (own cache, e.g. ../../reports/.cache-lc for the live LC signals newer than the study cache).
 */
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cgHistory, withVolume } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, ensureDir, klines, lastClosed, parseArgs, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "../../reports/mfi-cmf-study";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const nowFile = join(CACHE, "_breakout_now.txt");
const NOW = Number(args.get("now") ?? (process.env.STUDY_OFFLINE === "1" && existsSync(nowFile) ? readFileSync(nowFile, "utf8") : Math.floor(Date.now() / H1) * H1));

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (ch === '"') q = false; else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { cur.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; cur.push(f); f = ""; if (cur.some((x) => x !== "")) rows.push(cur); cur = []; }
    else f += ch;
  }
  if (f !== "" || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}
const timeOf = (r: Record<string, string>): number | null => {
  for (const k of ["entry_time_ms"]) if (r[k]) { const n = Number(r[k]); if (Number.isFinite(n)) return n; }
  for (const k of ["candle_closed_at", "detected_at", "time_utc"]) if (r[k]) {
    const s = r[k]!; const t = Date.parse(s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + "Z");
    if (Number.isFinite(t)) return t;
  }
  return null;
};

// ─── indicators on bars that carry the aggregated volume (NaN where missing) ─────────────
const tp = (c: C) => (c.high + c.low + c.close) / 3;
const clv = (c: C) => (c.high > c.low ? (c.close - c.low - (c.high - c.close)) / (c.high - c.low) : 0);
function mfiAt(cs: C[], i: number, n = 14): number | null {
  if (i < n) return null;
  let pos = 0, neg = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = cs[k]!.volume;
    if (!Number.isFinite(v)) return null;
    const a = tp(cs[k]!), b = tp(cs[k - 1]!);
    if (a > b) pos += a * v; else if (a < b) neg += a * v;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}
function cmfAt(cs: C[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let s = 0, v = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const x = cs[k]!.volume;
    if (!Number.isFinite(x)) return null;
    s += clv(cs[k]!) * x; v += x;
  }
  return v > 0 ? s / v : null;
}
function choAt(cs: C[], i: number): number | null {
  const from = Math.max(1, i - 150);
  if (i - from < 60) return null;
  let ad = 0, e3: number | null = null, e10: number | null = null;
  for (let k = from; k <= i; k++) {
    const x = cs[k]!.volume;
    if (!Number.isFinite(x)) return null;
    ad += clv(cs[k]!) * x;
    e3 = e3 === null ? ad : e3 + (2 / 4) * (ad - e3);
    e10 = e10 === null ? ad : e10 + (2 / 11) * (ad - e10);
  }
  let v = 0;
  for (let k = i - 19; k <= i; k++) v += cs[k]!.volume;
  return v > 0 && e3 !== null && e10 !== null ? (e3 - e10) / (v / 20) : null;
}
function readings(p: string, cs: C[], i: number, longN: number): Row {
  const out: Row = {};
  const mfi = (k: number) => mfiAt(cs, k), cmf = (k: number) => cmfAt(cs, k, 20);
  out[`${p}_mfi14`] = mfi(i);
  out[`${p}_cmf20`] = cmf(i);
  out[`${p}_cho`] = choAt(cs, i);
  out[`${p}_cmf_long`] = cmfAt(cs, i, longN);
  const m12 = mfi(i - 12), c12 = cmf(i - 12);
  out[`${p}_mfi_slope12`] = out[`${p}_mfi14`] != null && m12 != null ? (out[`${p}_mfi14`] as number) - m12 : null;
  out[`${p}_cmf_slope12`] = out[`${p}_cmf20`] != null && c12 != null ? (out[`${p}_cmf20`] as number) - c12 : null;
  // Divergences: last 12 bars vs the 36 before them.
  if (i >= 60) {
    const rng = (a: number, b: number, f: (k: number) => number | null, pick: "min" | "max") => {
      let r: number | null = null;
      for (let k = a; k <= b; k++) { const x = f(k); if (x === null) return null; r = r === null ? x : pick === "min" ? Math.min(r, x) : Math.max(r, x); }
      return r;
    };
    const lowR = rng(i - 11, i, (k) => cs[k]!.low, "min")!, lowP = rng(i - 47, i - 12, (k) => cs[k]!.low, "min")!;
    const hiR = rng(i - 11, i, (k) => cs[k]!.high, "max")!, hiP = rng(i - 47, i - 12, (k) => cs[k]!.high, "max")!;
    for (const [name, f] of [["mfi", mfi], ["cmf", cmf]] as const) {
      const minR = rng(i - 11, i, f, "min"), minP = rng(i - 47, i - 12, f, "min");
      const maxR = rng(i - 11, i, f, "max"), maxP = rng(i - 47, i - 12, f, "max");
      out[`${p}_${name}_bull_div`] = minR === null || minP === null ? null : lowR < lowP && minR > minP ? 1 : 0;
      out[`${p}_${name}_bear_div`] = maxR === null || maxP === null ? null : hiR > hiP && maxR < maxP ? 1 : 0;
    }
  }
  return out;
}

async function study(name: string, files: string[]) {
  const rows = files.flatMap((f) => parseCsv(readFileSync(f, "utf8")));
  const bySym = new Map<string, { r: Record<string, string>; t: number }[]>();
  let noTime = 0;
  for (const r of rows) {
    const t = timeOf(r);
    if (t === null || !r.symbol) { noTime++; continue; }
    (bySym.get(r.symbol) ?? bySym.set(r.symbol, []).get(r.symbol)!).push({ r, t });
  }
  const out: Row[] = [];
  let done = 0, failed = 0;
  for (const [symbol, list] of bySym) {
    try {
      const first = Math.min(...list.map((x) => x.t));
      // Lookbacks inside the study caches (1H and CoinGlass: 400 h before the window; 4H: 720 bars):
      // 1H readings need ≤ 150 bars, 4H ones ≤ 150 bars (the 4H Chaikin oscillator may be empty early on).
      const start1 = Math.floor((first - 14 * D1) / H1) * H1;
      const start4 = Math.floor((first - 40 * D1) / H4) * H4;
      const h1 = await klines(CACHE, symbol, "1h", start1, NOW);
      const h4 = await klines(CACHE, symbol, "4h", start4, NOW);
      const fut = await cgHistory(CACHE, symbol, "aggfut", start1, NOW);
      const spot = await cgHistory(CACHE, symbol, "aggspot", start1, NOW);
      const S = {
        aggfut_1h: withVolume(h1, fut, H1), aggfut_4h: withVolume(h4, fut, H4),
        aggspot_1h: withVolume(h1, spot, H1), aggspot_4h: withVolume(h4, spot, H4),
      };
      for (const { r, t } of list) {
        const row: Row = { ...r };
        for (const [k, cs] of Object.entries(S)) {
          const step = k.endsWith("1h") ? H1 : H4;
          const i = lastClosed(cs, t, step);
          Object.assign(row, i >= 0 ? readings(k, cs, i, step === H1 ? 72 : 42) : {});
        }
        out.push(row);
      }
    } catch (e) {
      failed++;
      console.error(`${symbol}: ${String(e).slice(0, 120)}`);
    }
    if (++done % 20 === 0) console.error(`${name}: монет ${done}/${bySym.size}, строк ${out.length}`);
  }
  writeCsv(join(OUT, `${name}_mfi.csv`), out);
  const filled = out.filter((r) => typeof r.aggfut_1h_mfi14 === "number").length;
  console.log(`${name}: строк ${rows.length}, без времени ${noTime}, записано ${out.length}, с MFI агрегата 1H ${filled}, монет с ошибкой ${failed}`);
}

async function main() {
  ensureDir(OUT);
  const sets: [string, string | undefined][] = [["abneon", args.get("abneon")], ["stealth", args.get("stealth")], ["lc", args.get("lc")]];
  for (const [name, list] of sets) if (list) await study(name, list.split(",").filter(Boolean));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
