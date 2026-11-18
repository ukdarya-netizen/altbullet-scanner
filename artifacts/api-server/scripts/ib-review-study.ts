/**
 * Impulse Buy review (owner 2026-11-18: «разобрать импульс-бай… проверить все метрики сигналов с последних правок…
 * помимо 30-минутного объёма, включая индикаторы, стадию Вайкофа и так далее»). Read-only, one run, nothing in the
 * bot changes. The period starts at the last IB rule change (≥15% over 24h + Wyckoff fail-closed, 09.11; the 30m
 * candle volume recorded from 10.11) — the analysis marks which rules each event saw.
 *
 * Inputs (exported read-only from production as JSON lines, see the prompt):
 *   signals.jsonl — every impulse_buy row of tracked_signals since 2026-11-09 (all statuses, neutral ones too) with
 *                   what the bot recorded at the entry: the row's own entry_* columns, impulse_decision_metrics,
 *                   decision_metrics, signal_entry_extras (30m candle pack, takers, OI), vsa_entry_metrics,
 *                   wyckoff_entry_metrics, and the decision snapshot of the fire;
 *   blocked.jsonl — IB stopped ONLY by the 24h-growth and / or the Wyckoff filter since 2026-11-10 (pattern decision
 *                   snapshots) — one per coin per 24 h, the first.
 * Every recorded value goes into the table as it is (rec_*). Recomputed at the entry from history (last CLOSED
 * candles, same data as the bot: BingX price, CoinGlass aggregated futures + spot USD volume):
 *   Lucy's VSA (the TradingView rule CAB uses since 15.11: colour on futures + spot USD, grey under the 120-bar
 *     average; buying = not grey and the close above the middle) on the 30m detection candle, the 3 30m bars before
 *     it, the last closed 1H and 4H;
 *   Wyckoff phase (the live IB reading: last closed 1H, 120 bars);
 *   MFI 14, CMF 20 (Chaikin money flow), Chaikin oscillator on 1H and 4H; RSI 14 on 1H / 4H; ATR% 1H;
 *   price: 1h / 3h / 24h / 72h change, distance to the 7-day high and to the 30-day high, 30m candle shape;
 *   aggregated OI change 1h / 4h / 24h; futures taker buy share (candle, previous 4h); BTC / ETH context.
 * Outcomes on BingX 15m from the entry: 24h / 72h / 7d classes (GOOD +10% before −8%, STOP), peaks, time to +5 /
 * +10 / −8, closes; simulated exits (stop −10% and the signal's stop × tracker / B.U.+5 / takes 5–15); for real
 * signals the bot's own result (status, pnl, core / runner) as recorded.
 *
 * Run (from artifacts/api-server; candle / CoinGlass cache of the earlier studies is reused):
 *   pnpm dlx tsx scripts/ib-review-study.ts --in ../../reports/ib-review-1118 --out ../../reports/ib-review-1118
 * Output: events.csv (one row per event, every column), errors.json, run.txt (counts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeWyckoff } from "../src/lib/wyckoff-metrics.js";
import { lucyColour, closesAboveMiddle, LUCY_LONG_BARS } from "../src/lib/abneon-volume-gate.js";
import { cgHistory, cgHistoryTf, cgOiAgg, type VBar } from "./study-v2/cg.js";
import {
  type C, type Row, D1, H1, H4, M15, atrPctSeries, ensureDir, grid, idxAtOrBefore, klines, majors, parseArgs, path, pct, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const IN = args.get("in") ?? "../../reports/ib-review-1118";
const OUT = args.get("out") ?? IN;
const CACHE = args.get("cache") ?? "../../reports/.cache";
const M30 = 30 * 60_000;
const WY_BARS = 120;

type Ev = { set: "signal" | "blocked"; id: string; symbol: string; at: number; entry: number | null; stop: number | null; candleAt: number | null; rec: Row };

function jsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const sym = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"));
const time = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = typeof v === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? `${v.replace(" ", "T")}Z` : v; // timestamps without zone are UTC
  const t = typeof s === "number" ? s : Date.parse(s);
  return Number.isFinite(t) ? t : null;
};

/** Every leaf of a JSON value as prefix_path columns (arrays joined; objects flattened). */
function flat(prefix: string, v: unknown, out: Row) {
  if (v === null || v === undefined) return;
  if (typeof v === "string" && /^[[{]/.test(v.trim())) { try { return flat(prefix, JSON.parse(v), out); } catch { /* plain text */ } }
  if (Array.isArray(v)) { out[prefix] = v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("|"); return; }
  if (typeof v === "object") { for (const [k, x] of Object.entries(v as Record<string, unknown>)) flat(`${prefix}_${k}`, x, out); return; }
  out[prefix] = typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" ? v.replace(/\s+/g, " ") : (v as number);
}
/** The first value of a key anywhere inside an object. */
function find(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object") return undefined;
  if (key in (v as Record<string, unknown>)) return (v as Record<string, unknown>)[key];
  for (const x of Object.values(v as Record<string, unknown>)) { const r = find(x, key); if (r !== undefined) return r; }
  return undefined;
}
const parse = (v: unknown) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);

const SKIP = new Set(["extras", "vsa", "wy", "snap", "snap_reason"]);
function events(): { evs: Ev[]; note: string[] } {
  const note: string[] = [];
  const sig = jsonl(join(IN, "signals.jsonl"));
  const a: Ev[] = sig.map((r) => {
    const rec: Row = {};
    for (const [k, v] of Object.entries(r)) if (!SKIP.has(k)) flat(`rec_${k}`, parse(v), rec);
    flat("rec_extras", parse(r.extras), rec); flat("rec_vsa", parse(r.vsa), rec); flat("rec_wy", parse(r.wy), rec); flat("rec_snap", parse(r.snap), rec);
    const idm = parse(r.impulse_decision_metrics);
    return {
      set: "signal" as const, id: String(r.id ?? ""), symbol: sym(String(r.symbol ?? "")), at: time(r.detected_at) ?? NaN,
      entry: num(r.entry_price), stop: num(r.stop_loss_price ?? r.stop_price), candleAt: time(find(idm, "candleClosedAt") ?? find(parse(r.snap), "candleClosedAt")), rec,
    };
  });
  note.push(`signals.jsonl: ${sig.length} строк`);
  const blk = jsonl(join(IN, "blocked.jsonl")).sort((x, y) => (time(x.decision_at) ?? 0) - (time(y.decision_at) ?? 0));
  const seen = new Map<string, number>();
  const b: Ev[] = [];
  for (const r of blk) {
    const at = time(r.decision_at), s = sym(String(r.symbol ?? ""));
    if (at === null || !s) continue;
    if (seen.has(s) && at - seen.get(s)! < D1) continue;
    seen.set(s, at);
    const rec: Row = {};
    flat("rec", parse(r.entry_metrics), rec);
    rec.rec_decision_reason = String(r.decision_reason ?? "");
    rec.rec_decision_kind = String(r.decision_kind ?? "");
    b.push({ set: "blocked", id: String(r.id ?? ""), symbol: s, at, entry: num(r.entry_price), stop: null, candleAt: time(find(parse(r.entry_metrics), "candleClosedAt")), rec });
  }
  note.push(`blocked.jsonl: ${blk.length} строк → ${b.length} событий (первое по монете за 24 ч)`);
  return { evs: [...a, ...b].filter((e) => e.symbol && Number.isFinite(e.at)), note };
}

function bucket(vb: Map<number, VBar> | null, src: number, step: number): Map<number, number> {
  const m = new Map<number, number>(), n = new Map<number, number>();
  if (!vb) return m;
  for (const b of vb.values()) {
    const k = Math.floor(b.time / step) * step;
    m.set(k, (m.get(k) ?? 0) + b.buy + b.sell);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  for (const [k, c] of n) if (c !== step / src) m.delete(k);
  return m;
}
const takerBuy = (vb: Map<number, VBar> | null, from: number, to: number): number | null => {
  if (!vb) return null;
  let b = 0, s = 0;
  for (const x of vb.values()) if (x.time >= from && x.time < to) { b += x.buy; s += x.sell; }
  return b + s > 0 ? (100 * b) / (b + s) : null;
};
/** 30m candles from 15m pairs (both halves present). */
function to30(m15: C[]): C[] {
  const out: C[] = [];
  for (let i = 0; i + 1 < m15.length; i++) {
    const a = m15[i]!, b = m15[i + 1]!;
    if (a.time % M30 !== 0 || b.time !== a.time + M15) continue;
    out.push({ time: a.time, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, volume: a.volume + b.volume });
  }
  return out;
}

function lucyAt(cs: C[], i: number, fut: Map<number, number>, spot: Map<number, number>, step: number): string | null {
  if (i < LUCY_LONG_BARS - 1) return null;
  const vol: number[] = [];
  for (let q = i - LUCY_LONG_BARS + 1; q <= i; q++) {
    if (q > i - LUCY_LONG_BARS + 1 && cs[q]!.time - cs[q - 1]!.time !== step) return null;
    const f = fut.get(cs[q]!.time);
    if (f == null) return null;
    vol.push(f + (spot.get(cs[q]!.time) ?? 0));
  }
  return lucyColour(vol, vol.length - 1);
}
function wyckoffAt(h1: C[], i: number, fut1: Map<number, number>): string | null {
  if (i < 30) return null;
  const part = h1.slice(Math.max(0, i - WY_BARS + 1), i + 1);
  const vols = new Map<number, number>();
  for (const c of part) { const v = fut1.get(c.time); if (v != null) vols.set(c.time, v); }
  if (vols.size < part.length * 0.9) return null;
  const w = computeWyckoff(part.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })), vols, h1[i]!.time);
  return w.phase === "insufficient_history" ? null : w.phase;
}

// ─── indicators (formulas of CAB's entry-money-flow) ─────────────────────────
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
function cmfAt(cs: C[], i: number, n = 20): number | null {
  if (i < n - 1) return null;
  let s = 0, v = 0;
  for (let k = i - n + 1; k <= i; k++) { const x = cs[k]!.volume; if (!Number.isFinite(x)) return null; s += clv(cs[k]!) * x; v += x; }
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
function rsiAt(cs: C[], i: number, n = 14): number | null {
  if (i < n * 3) return null;
  let g = 0, l = 0;
  for (let k = i - n * 3 + 1; k <= i; k++) {
    const d = cs[k]!.close - cs[k - 1]!.close;
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (k <= i - n * 3 + n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
/** OHLC with the aggregated USD volume of the same candle (NaN where missing). */
const withUsd = (cs: C[], vol: Map<number, number>): C[] => cs.map((c) => ({ ...c, volume: vol.get(c.time) ?? NaN }));
const hi = (cs: C[], from: number, to: number) => { let h = -Infinity; for (const c of cs) if (c.time >= from && c.time < to) h = Math.max(h, c.high); return Number.isFinite(h) ? h : null; };

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Math.floor(Date.now() / M15) * M15;
  const { evs, note } = events();
  const errors: Record<string, string> = {};
  const rows: Row[] = [];
  const first = Math.min(...evs.map((e) => e.at));
  const kl = (s: string, iv: "1h" | "4h", from: number) => klines(CACHE, s, iv, from, now).catch((e) => { errors[`${s} ${iv}`] = String(e).slice(0, 160); return [] as C[]; });
  const btc = { h1: await kl("BTC-USDT", "1h", first - 30 * D1), h4: await kl("BTC-USDT", "4h", first - 60 * D1) };
  const eth = { h1: await kl("ETH-USDT", "1h", first - 30 * D1), h4: await kl("ETH-USDT", "4h", first - 60 * D1) };
  const fired = new Map<string, number[]>();
  for (const e of evs) if (e.set === "signal") fired.set(e.symbol, [...(fired.get(e.symbol) ?? []), e.at]);
  const bySym = new Map<string, Ev[]>();
  for (const e of evs) bySym.set(e.symbol, [...(bySym.get(e.symbol) ?? []), e]);
  let done = 0;
  for (const [s, list] of bySym) {
    try {
      const f0 = Math.min(...list.map((e) => e.at));
      const h4 = await klines(CACHE, s, "4h", f0 - 40 * D1, now);
      const h1 = await klines(CACHE, s, "1h", f0 - 32 * D1, now);
      const m15 = await klines(CACHE, s, "15m", f0 - 6 * D1, now);
      const m30 = to30(m15);
      const fut = await cgHistory(CACHE, s, "aggfut", f0 - 40 * D1, now).catch(() => null);
      const spot = await cgHistory(CACHE, s, "aggspot", f0 - 40 * D1, now).catch(() => null);
      const fut15 = await cgHistoryTf(CACHE, s, "aggfut", f0 - 6 * D1, now, "15m").catch(() => null);
      const spot15 = await cgHistoryTf(CACHE, s, "aggspot", f0 - 6 * D1, now, "15m").catch(() => null);
      const oi = await cgOiAgg(CACHE, s, f0 - 3 * D1, now).catch(() => null);
      const fut4 = bucket(fut, H1, H4), spot4 = bucket(spot, H1, H4), fut1 = bucket(fut, H1, H1), spot1 = bucket(spot, H1, H1);
      const fut30 = bucket(fut15, M15, M30), spot30 = bucket(spot15, M15, M30);
      const tot1 = new Map([...fut1].map(([t, v]) => [t, v + (spot1.get(t) ?? 0)]));
      const tot4 = new Map([...fut4].map(([t, v]) => [t, v + (spot4.get(t) ?? 0)]));
      const h1v = withUsd(h1, tot1), h4v = withUsd(h4, tot4);
      const atr1 = atrPctSeries(h1);
      for (const e of list) {
        const i4 = idxAtOrBefore(h4, e.at - H4), i1 = idxAtOrBefore(h1, e.at - H1), i15 = idxAtOrBefore(m15, e.at);
        // The detection 30m candle: the one the scanner judged (its close time recorded), else the last closed.
        const c30at = e.candleAt !== null ? e.candleAt - M30 : Math.floor(e.at / M30) * M30 - M30;
        const i30 = idxAtOrBefore(m30, c30at);
        const entry = e.entry ?? (i15 >= 0 ? m15[i15]!.close : null);
        const r: Row = {
          set: e.set, id: e.id, symbol: s, detected_at: new Date(e.at).toISOString(), entry_time_ms: e.at, entry, signal_stop: e.stop,
          fired_same_coin_24h: e.set === "blocked" ? ((fired.get(s) ?? []).some((t) => Math.abs(t - e.at) < D1) ? 1 : 0) : null,
          det30_open_at: i30 >= 0 ? new Date(m30[i30]!.time).toISOString() : null,
        };
        // Lucy's VSA
        const l30 = i30 >= 0 ? lucyAt(m30, i30, fut30, spot30, M30) : null;
        r.lucy30 = l30; r.lucy30_buy = i30 >= 0 && l30 !== null ? (l30 !== "N" && closesAboveMiddle(m30[i30]!) ? 1 : 0) : null;
        let prevBright = 0, prevKnown = 0;
        for (let k = i30 - 3; k < i30 && k >= 0; k++) { const c = lucyAt(m30, k, fut30, spot30, M30); if (c !== null) { prevKnown++; if (c !== "N") prevBright++; } }
        r.lucy30_prev3_bright = prevKnown === 3 ? prevBright : null;
        const l1 = i1 >= 0 ? lucyAt(h1, i1, fut1, spot1, H1) : null, l4 = i4 >= 0 ? lucyAt(h4, i4, fut4, spot4, H4) : null;
        r.lucy1 = l1; r.lucy1_buy = l1 !== null ? (l1 !== "N" && closesAboveMiddle(h1[i1]!) ? 1 : 0) : null;
        r.lucy4 = l4; r.lucy4_buy = l4 !== null ? (l4 !== "N" && closesAboveMiddle(h4[i4]!) ? 1 : 0) : null;
        // 30m candle volume vs 20 bars (aggregated futures USD, as the bot records)
        if (i30 >= 20) {
          let sm = 0, n = 0;
          for (let k = i30 - 20; k < i30; k++) { const v = fut30.get(m30[k]!.time); if (v != null) { sm += v; n++; } }
          const v = fut30.get(m30[i30]!.time);
          r.vol30_mult_recalc = n === 20 && v != null && sm > 0 ? v / (sm / 20) : null;
        }
        if (i30 >= 0) {
          const c = m30[i30]!;
          r.c30_body_pct = pct(c.close, c.open); r.c30_range_pct = pct(c.high, c.low);
          r.c30_close_pos = c.high > c.low ? (c.close - c.low) / (c.high - c.low) : null;
          r.c30_taker_buy = takerBuy(fut15, c.time, c.time + M30);
        }
        r.taker_buy_prev4h = takerBuy(fut, e.at - 5 * H1, Math.floor(e.at / H1) * H1);
        // Wyckoff, indicators
        r.wyckoff = i1 >= 0 ? wyckoffAt(h1, i1, fut1) : null;
        r.mfi1h = mfiAt(h1v, i1); r.cmf1h = cmfAt(h1v, i1); r.cho1h = choAt(h1v, i1);
        r.mfi4h = mfiAt(h4v, i4); r.cmf4h = cmfAt(h4v, i4); r.cho4h = choAt(h4v, i4);
        r.rsi1h = rsiAt(h1, i1); r.rsi4h = rsiAt(h4, i4);
        r.atr1h_pct = i1 >= 0 ? atr1[i1] ?? null : null;
        // Price context (entry vs closed candles)
        if (entry && i1 >= 72) {
          r.px_1h = pct(entry, h1[i1]!.open); r.px_3h = pct(entry, h1[i1 - 2]!.open);
          r.px_24h = pct(entry, h1[i1 - 23]!.open); r.px_72h = pct(entry, h1[i1 - 71]!.open);
          r.to_high7d_pct = pct(entry, hi(h1, e.at - 7 * D1, e.at)); r.to_high30d_pct = pct(entry, hi(h4, e.at - 30 * D1, e.at));
        }
        if (oi) {
          const t = Math.floor(e.at / H1) * H1 - H1, at = (k: number) => oi.get(t - k * H1) ?? null;
          r.oi_1h = pct(at(0), at(1)); r.oi_4h = pct(at(0), at(4)); r.oi_24h = pct(at(0), at(24));
        }
        Object.assign(r, majors("btc", btc.h1, btc.h4, e.at), majors("eth", eth.h1, eth.h4, e.at));
        if (entry) {
          Object.assign(r, path(m15, e.at, entry, r.atr1h_pct as number | null));
          Object.assign(r, grid("g", m15, e.at, entry, { s10: entry * 0.9, sig: e.stop && e.stop < entry ? e.stop : null }));
        }
        Object.assign(r, e.rec);
        rows.push(r);
      }
    } catch (err) {
      errors[s] = String(err).slice(0, 160);
    }
    if (++done % 20 === 0) console.error(`${done}/${bySym.size} монет · событий ${rows.length}`);
  }
  // One header for all rows (recorded columns differ between events).
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  writeCsv(join(OUT, "events.csv"), rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))));
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  writeFileSync(join(OUT, "run.txt"), [...note, `событий в events.csv: ${rows.length} (сигналов ${rows.filter((r) => r.set === "signal").length}, заблокированных ${rows.filter((r) => r.set === "blocked").length})`, `колонок: ${cols.length}`, `ошибок по монетам: ${Object.keys(errors).length}`].join("\n") + "\n");
  console.error(`готово: событий ${rows.length}, ошибок ${Object.keys(errors).length}`);
}

void main();
