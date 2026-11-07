/**
 * IMPULSE BUY × VSA (owner 2026-11-07): OUR live Impulse Buy signals (every IB the bot sent, from the production
 * tracker, with its real outcome) read through VSA on every volume source and timeframe.
 *
 * Input: --signals ../../reports/ib-signals.csv (exported read-only from production: tracked_id, signal_id, symbol,
 * detected_at, entry_price, status, pnl_percent, core_pnl_percent, runner_pnl_percent, peak_price, closed_at,
 * cancel_reason, candle_closed_at, before_status, before_pnl).
 *
 * For every signal, on 15m / 30m / 1H / 4H (BingX candles; the last bar CLOSED at the impulse candle close) and on
 * every volume source — bx (BingX own), aggfut (CoinGlass aggregated futures, as live), aggspot (aggregated spot),
 * binance, bybit, okx, bitget, bingxcg (CoinGlass per exchange):
 *   the trigger bar: Welkin colour (W/M/O/A/Y/N), VSA colour (P/R/O/G/B/S) and ratio, volume / 20-bar average,
 *   spread / 20-bar average, close position, up or down bar, takers (buy − sell share);
 *   the 12 bars before it: blue (Welkin above average: A/O/M/W) / grey (N) / bright (O/M/W) counts, the longest
 *   blue run, volume of the last 12 vs the 36 before, takers of the 12 bars, high-volume down bars (climax).
 * 15m / 30m volume of CoinGlass sources comes from its 15m history (≈ 46 days deep); 1H / 4H from its 1H history.
 * Outcome: the real tracker outcome (status, PnL, core / runner, peak; the original one for neutrally closed rows)
 * and, the same for every signal, the BingX 15m path from the entry: +10 before −8 (72 h), peak / worst 72 h,
 * close 24 h / 72 h / 7 d, hours to +5 / +10 / −8.
 *
 * Run (from artifacts/api-server; CoinGlass key from Secrets, never printed; one process):
 *   pnpm dlx tsx scripts/ib-vsa-study.ts --signals ../../reports/ib-signals.csv --out ../../reports/ib-vsa-study
 * Optional: STUDY_CG_RPM (CoinGlass requests per minute for this run, default 40).
 */
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { SOURCES, type Source, type VBar, cgHistoryTf, cgStats } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, atrPctSeries, ensureDir, klines, lastClosed, parseArgs, path, pct, vsaSeries, welkin, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "../../reports/ib-vsa-study";
/** Own cache: the other studies' offline caches are never overwritten. */
const CACHE = args.get("cache") ?? "../../reports/.cache-ib";
const SIGNALS = args.get("signals") ?? "../../reports/ib-signals.csv";
const M30 = 2 * M15;
const TFS = [["15m", M15], ["30m", M30], ["1h", H1], ["4h", H4]] as const;
const CG15_DEPTH = 4400 * M15;

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { cur.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; cur.push(f); f = ""; if (cur.some((x) => x !== "")) rows.push(cur); cur = []; }
    else f += ch;
  }
  if (f !== "" || cur.length) { cur.push(f); rows.push(cur); }
  const head = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}
const ms = (s: string | undefined) => { if (!s) return null; const t = Date.parse(s.includes("T") || s.endsWith("Z") ? s : s.replace(" ", "T") + "Z"); return Number.isFinite(t) ? t : null; };
const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number(s));

/** Complete bars of `step` built from 15m bars (UTC-aligned). */
function agg(cs15: C[], step: number): C[] {
  const by = new Map<number, C[]>();
  for (const c of cs15) { const k = Math.floor(c.time / step) * step; (by.get(k) ?? by.set(k, []).get(k)!).push(c); }
  const need = step / M15, out: C[] = [];
  for (const [k, bs] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    if (bs.length !== need) continue;
    bs.sort((a, b) => a.time - b.time);
    out.push({ time: k, open: bs[0]!.open, high: Math.max(...bs.map((b) => b.high)), low: Math.min(...bs.map((b) => b.low)), close: bs.at(-1)!.close, volume: bs.reduce((a, b) => a + b.volume, 0) });
  }
  return out;
}
/** Volume of a CoinGlass source on the bars of `cs` (USD / close; NaN where any sub-bar is missing) + takers share. */
function withSource(cs: C[], vb: Map<number, VBar> | null, vbStep: number, step: number): { cs: C[]; tk: (number | null)[] } {
  const tk: (number | null)[] = [];
  const out = cs.map((c) => {
    if (!vb) { tk.push(null); return { ...c, volume: NaN }; }
    let buy = 0, sell = 0, n = 0;
    for (let t = c.time; t < c.time + step; t += vbStep) { const b = vb.get(t); if (b) { buy += b.buy; sell += b.sell; n++; } }
    const ok = n === step / vbStep && c.close > 0 && buy + sell > 0;
    tk.push(ok ? (buy - sell) / (buy + sell) : null);
    return { ...c, volume: ok ? (buy + sell) / c.close : NaN };
  });
  return { cs: out, tk };
}
const BLUE = new Set(["A", "O", "M", "W"]), BRIGHT = new Set(["O", "M", "W"]);

/** VSA readings of the bar `i` and the 12 bars before it. */
function readings(p: string, cs: C[], tk: (number | null)[] | null, i: number): Row {
  const out: Row = {};
  if (i < 60 || !Number.isFinite(cs[i]!.volume)) { out[`${p}_ok`] = 0; return out; }
  out[`${p}_ok`] = 1;
  const vsa = vsaSeries(cs.slice(0, i + 1));
  const avg = (a: number, b: number, f: (c: C) => number) => { const xs = cs.slice(Math.max(0, a), b + 1).map(f).filter(Number.isFinite); return xs.length >= (b - a + 1) * 0.75 ? xs.reduce((x, y) => x + y, 0) / xs.length : null; };
  const b = cs[i]!;
  const v20 = avg(i - 20, i - 1, (c) => c.volume), s20 = avg(i - 20, i - 1, (c) => c.high - c.low);
  out[`${p}_welkin`] = welkin(cs, i);
  out[`${p}_vsa_color`] = vsa.color[i] ?? null;
  out[`${p}_vsa_ratio`] = vsa.ratio[i] ?? null;
  out[`${p}_vol_ratio20`] = v20 ? b.volume / v20 : null;
  out[`${p}_spread_ratio20`] = s20 ? (b.high - b.low) / s20 : null;
  out[`${p}_close_pos`] = b.high > b.low ? (b.close - b.low) / (b.high - b.low) : null;
  out[`${p}_up_bar`] = b.close > b.open ? 1 : 0;
  out[`${p}_tk_delta`] = tk?.[i] ?? null;
  let blue = 0, grey = 0, bright = 0, run = 0, maxRun = 0, climaxDown = 0, n = 0;
  const tks: number[] = [];
  for (let k = i - 12; k < i; k++) {
    const w = welkin(cs, k);
    if (w === null) continue;
    n++;
    if (BLUE.has(w)) { blue++; run++; maxRun = Math.max(maxRun, run); } else run = 0;
    if (w === "N") grey++;
    if (BRIGHT.has(w)) { bright++; if (cs[k]!.close < cs[k]!.open) climaxDown++; }
    const t = tk?.[k];
    if (t != null) tks.push(t);
  }
  out[`${p}_pre12_n`] = n;
  out[`${p}_pre12_blue`] = n ? blue : null;
  out[`${p}_pre12_grey`] = n ? grey : null;
  out[`${p}_pre12_bright`] = n ? bright : null;
  out[`${p}_pre12_blue_run`] = n ? maxRun : null;
  out[`${p}_pre12_bright_down`] = n ? climaxDown : null;
  const v12 = avg(i - 12, i - 1, (c) => c.volume), v36 = avg(i - 48, i - 13, (c) => c.volume);
  out[`${p}_pre12_vol_vs_prev36`] = v12 && v36 ? v12 / v36 : null;
  out[`${p}_pre12_tk_delta`] = tks.length >= 9 ? tks.reduce((a, x) => a + x, 0) / tks.length : null;
  return out;
}

async function main() {
  ensureDir(CACHE); ensureDir(OUT);
  const sigs = parseCsv(readFileSync(SIGNALS, "utf8"));
  const now = Math.floor(Date.now() / M15) * M15;
  const bySym = new Map<string, Record<string, string>[]>();
  for (const s of sigs) (bySym.get(s.symbol!) ?? bySym.set(s.symbol!, []).get(s.symbol!)!).push(s);
  const rows: Row[] = [];
  const errors: Record<string, string> = {};
  const cover: Record<string, number> = {};
  let done = 0;
  for (const [symbol, list] of bySym) {
    try {
      const times = list.map((s) => ms(s.candle_closed_at) ?? ms(s.detected_at)).filter((x): x is number => x !== null);
      const first = Math.min(...times);
      const start = Math.floor((first - 14 * D1) / H4) * H4;
      const m15 = await klines(CACHE, symbol, "15m", start, now);
      const vb15: Partial<Record<Source, Map<number, VBar> | null>> = {}, vb1: Partial<Record<Source, Map<number, VBar> | null>> = {};
      const start15 = Math.max(start, now - CG15_DEPTH);
      for (const src of SOURCES) {
        vb15[src] = await cgHistoryTf(CACHE, symbol, src, start15, now, "15m");
        vb1[src] = await cgHistoryTf(CACHE, symbol, src, start, now, "1h");
      }
      const bars: Record<string, C[]> = { "15m": m15, "30m": agg(m15, M30), "1h": agg(m15, H1), "4h": agg(m15, H4) };
      const atr4 = atrPctSeries(bars["4h"]!);
      const src: Record<string, Record<string, { cs: C[]; tk: (number | null)[] | null }>> = {};
      for (const [tf, step] of TFS) {
        src[tf] = { bx: { cs: bars[tf]!, tk: null } };
        for (const s of SOURCES) {
          const use15 = step < H1 || !vb1[s];
          src[tf]![s] = withSource(bars[tf]!, use15 ? vb15[s] ?? null : vb1[s] ?? null, use15 ? M15 : H1, step);
        }
      }
      for (const s of list) {
        const trigT = ms(s.candle_closed_at) ?? ms(s.detected_at)!;
        const entryT = ms(s.detected_at) ?? trigT;
        const entry = num(s.entry_price);
        if (!entry || !trigT) { errors[`${symbol}:${s.tracked_id}`] = "no_entry_or_time"; continue; }
        const row: Row = {
          tracked_id: s.tracked_id ?? null, signal_id: s.signal_id ?? null, symbol,
          time_utc: new Date(entryT).toISOString(), entry_time_ms: entryT, trigger_close_utc: new Date(trigT).toISOString(), entry,
          status: s.status ?? null, pnl_percent: num(s.pnl_percent), core_pnl_percent: num(s.core_pnl_percent), runner_pnl_percent: num(s.runner_pnl_percent),
          peak_pct: num(s.peak_price) ? pct(num(s.peak_price)!, entry) : null, closed_at: s.closed_at ?? null, cancel_reason: s.cancel_reason ?? null,
          before_status: s.before_status ?? null, before_pnl: num(s.before_pnl),
          // the outcome of the signal as the bot traded it (original outcome for neutrally closed rows)
          real_status: s.status === "reclassified" && s.before_status ? s.before_status : s.status ?? null,
          real_pnl: s.status === "reclassified" && s.before_status ? num(s.before_pnl) : num(s.pnl_percent),
        };
        for (const [tf, step] of TFS) {
          const i = lastClosed(bars[tf]!, trigT, step);
          row[`${tf}_bar_close_utc`] = i >= 0 ? new Date(bars[tf]![i]!.time + step).toISOString() : null;
          for (const name of ["bx", ...SOURCES] as const) {
            const v = src[tf]![name]!;
            const r = readings(`${name}_${tf}`, v.cs, v.tk, i);
            Object.assign(row, r);
            if (r[`${name}_${tf}_ok`] === 1) cover[`${name}_${tf}`] = (cover[`${name}_${tf}`] ?? 0) + 1;
          }
        }
        const i4 = lastClosed(bars["4h"]!, entryT, H4);
        Object.assign(row, path(m15, entryT, entry, i4 >= 0 ? atr4[i4] ?? null : null));
        rows.push(row);
      }
    } catch (e) {
      errors[symbol] = String(e).slice(0, 160);
    }
    if (++done % 10 === 0) console.error(`монет ${done}/${bySym.size}, сигналов ${rows.length} · CoinGlass запросов ${cgStats.requests} (ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429 ${cgStats.r429})`);
  }
  rows.sort((a, b) => Number(a.entry_time_ms) - Number(b.entry_time_ms));
  writeCsv(join(OUT, "ib_signals_vsa.csv"), rows);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  const real = rows.map((r) => r.real_pnl).filter((v): v is number => typeof v === "number");
  const text =
    `IB × VSA · сигналов в файле ${sigs.length}, монет ${bySym.size}, обработано ${rows.length}, ошибок ${Object.keys(errors).length}\n` +
    `реальный результат (PnL трекера, исходный для нейтрально закрытых): ${real.length} сделок, среднее ${real.length ? (real.reduce((a, b) => a + b, 0) / real.length).toFixed(2) : "—"}%\n` +
    `+10% раньше −8% за 72ч (BingX 15m): ${rows.filter((r) => r.out72 === "GOOD").length}, −8% раньше: ${rows.filter((r) => r.out72 === "STOP").length}\n` +
    `покрытие VSA (сигналов с данными) по источнику и ТФ:\n` +
    ["bx", ...SOURCES].map((s) => `  ${s}: ${TFS.map(([tf]) => `${tf} ${cover[`${s}_${tf}`] ?? 0}`).join(", ")}`).join("\n") +
    `\nCoinGlass: запросов ${cgStats.requests}, ok ${cgStats.ok}, пусто ${cgStats.empty}, ошибок ${cgStats.errors}, 429 ${cgStats.r429}`;
  writeFileSync(join(OUT, "summary.txt"), text);
  console.log(text);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
