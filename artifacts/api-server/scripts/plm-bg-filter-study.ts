/**
 * PLM and BG through the Wyckoff and Lucy's VSA filters (owner 2026-11-16: «вернуть PLM, BG — но прогнать через
 * фильтры Вайкофа и VSA Lucy»; «сначала история, потом решить»). Read-only, one run, nothing in the bot changes.
 *
 * Inputs (exported from production, see the prompt):
 *   signals.csv — every Price Led Momentum / Balanced Grind row of tracked_signals (all statuses, neutral ones too);
 *   blocked.csv — PLM / BG that passed every gate after 22.10 and were stopped only by «pattern_decommissioned»
 *                 (pattern_decision_snapshots); one per coin per 24 h.
 * For every event, at its entry time:
 *   Wyckoff — the live Impulse Buy reading (last closed 1H, BingX price, aggregated CoinGlass futures volume):
 *             filter W passes unless the phase is «breakout_without_base» or undetermined (as IB, fail-closed);
 *   Lucy's VSA — the indicator's rule (USD volume futures + spot, Welkin 20 bars, grey under the 120-bar average)
 *             on the last closed 4H and 1H candle: colour and buying (an active bar closing above its middle);
 *             filters V4 / V1 pass on a not-grey colour with buying (the CAB ABNeon rule since 15.11).
 * Outcomes on BingX 15m from the entry: 24h / 72h / 7d classes (GOOD +10% before −8%, STOP), peaks, the PLM / BG
 * stop −10% and the signal's own stop × tracker / B.U.+5 / takes 5–15; for the real signals also the tracker's own
 * result. Summary: per pattern × set × filter (none, W, V4, V1, W+V4, W+V1) — count, GOOD / STOP shares, peak ≥10%,
 * average and sum, both halves of the period; every event by name in events.csv.
 *
 * Run (from artifacts/api-server; candle / CoinGlass cache of the earlier studies is reused):
 *   pnpm dlx tsx scripts/plm-bg-filter-study.ts --signals ../../reports/plm-bg/signals.csv --blocked ../../reports/plm-bg/blocked.csv --out ../../reports/plm-bg
 * Output: events.csv, summary.txt, errors.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeWyckoff } from "../src/lib/wyckoff-metrics.js";
import { lucyColour, closesAboveMiddle, LUCY_LONG_BARS } from "../src/lib/abneon-volume-gate.js";
import { cgHistory, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, ensureDir, grid, idxAtOrBefore, klines, parseArgs, path, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const OUT = args.get("out") ?? "../../reports/plm-bg";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const SIGNALS = args.get("signals") ?? join(OUT, "signals.csv");
const BLOCKED = args.get("blocked") ?? join(OUT, "blocked.csv");
const WY_BARS = 120;

type Ev = {
  set: "signal" | "blocked"; id: string; symbol: string; pattern: string; at: number; entry: number | null; stop: number | null;
  status: string | null; pnl: number | null; reason: string | null;
};

function readCsv(file: string): Array<Record<string, string>> {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift()!.split(",").map((h) => h.trim());
  return lines.map((l) => { const v = l.split(","); return Object.fromEntries(head.map((h, i) => [h, (v[i] ?? "").trim()])); });
}
const num = (s: string | undefined) => (s === undefined || s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);
const sym = (s: string) => (s.includes("-") ? s : s.replace(/USDT$/, "-USDT"));

function events(): Ev[] {
  const a: Ev[] = readCsv(SIGNALS).map((r) => ({
    set: "signal", id: r.id ?? "", symbol: sym(r.symbol ?? ""), pattern: r.sentiment_key ?? "", at: Date.parse(r.detected_at ?? ""),
    entry: num(r.entry_price), stop: num(r.stop_loss_price), status: r.status ?? null, pnl: num(r.pnl_percent), reason: r.cancel_reason || null,
  }));
  // Blocked: one per coin and pattern per 24 h (the first).
  const seen = new Map<string, number>();
  const b: Ev[] = [];
  for (const r of readCsv(BLOCKED).sort((x, y) => Date.parse(x.decision_at ?? "") - Date.parse(y.decision_at ?? ""))) {
    const at = Date.parse(r.decision_at ?? ""), key = `${r.pattern_key}|${r.symbol}`;
    if (!Number.isFinite(at) || (seen.has(key) && at - seen.get(key)! < D1)) continue;
    seen.set(key, at);
    b.push({ set: "blocked", id: r.id ?? "", symbol: sym(r.symbol ?? ""), pattern: r.pattern_key ?? "", at, entry: num(r.entry_price), stop: null, status: null, pnl: null, reason: r.decision_reason || null });
  }
  return [...a, ...b].filter((e) => e.symbol && Number.isFinite(e.at));
}

/** Sum of 1H bars into the step (only complete buckets). */
function bucket(vb: Map<number, VBar> | null, step: number): Map<number, number> {
  const m = new Map<number, number>(), n = new Map<number, number>();
  if (!vb) return m;
  for (const b of vb.values()) {
    const k = Math.floor(b.time / step) * step;
    m.set(k, (m.get(k) ?? 0) + b.buy + b.sell);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  for (const [k, c] of n) if (c !== step / H1) m.delete(k);
  return m;
}

/** Lucy's colour of candle i (USD futures + spot, spot missing = 0, futures required; 120 bars). */
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

const FILTERS: Array<[string, (r: Row) => boolean]> = [
  ["без фильтров", () => true],
  ["W (Вайкоф)", (r) => r.f_w === 1],
  ["V4 (Lucy 4H)", (r) => r.f_v4 === 1],
  ["V1 (Lucy 1H)", (r) => r.f_v1 === 1],
  ["W+V4", (r) => r.f_w === 1 && r.f_v4 === 1],
  ["W+V1", (r) => r.f_w === 1 && r.f_v1 === 1],
];

function summarize(rows: Row[]): string {
  const out: string[] = [];
  const f = (v: number | null, d = 1) => (v === null ? "—" : v.toFixed(d));
  const stat = (xs: Row[], col: string) => {
    const v = xs.map((r) => r[col]).filter((x): x is number => typeof x === "number");
    return v.length ? { n: v.length, avg: v.reduce((a, b) => a + b, 0) / v.length, sum: v.reduce((a, b) => a + b, 0) } : null;
  };
  const times = rows.map((r) => Number(r.entry_time_ms)).sort((a, b) => a - b);
  for (const pattern of [...new Set(rows.map((r) => String(r.pattern)))]) {
    for (const set of ["signal", "blocked"]) {
      const base = rows.filter((r) => r.pattern === pattern && r.set === set);
      if (!base.length) continue;
      const pt = base.map((r) => Number(r.entry_time_ms)).sort((a, b) => a - b);
      const mid = (pt[0]! + pt[pt.length - 1]!) / 2;
      out.push(`\n=== ${pattern} · ${set === "signal" ? "реальные сигналы" : "заблокированные после 22.10"} · ${new Date(pt[0]!).toISOString().slice(0, 10)} — ${new Date(pt[pt.length - 1]!).toISOString().slice(0, 10)} ===`);
      out.push("фильтр | n | GOOD 7д % | STOP 7д % | пик7д ≥10% | трекер −10% ср / сумма | фикс +10 ср | 1-я пол. трекер ср (n) | 2-я пол. (n)" + (set === "signal" ? " | итог бота ср / сумма (n)" : ""));
      for (const [name, pass] of FILTERS) {
        const xs = base.filter(pass);
        const done = xs.filter((r) => r.out7d === "GOOD" || r.out7d === "STOP" || r.out7d === "MID");
        const share = (k: string) => (done.length ? (100 * done.filter((r) => r.out7d === k).length) / done.length : null);
        const p10 = xs.filter((r) => typeof r.peak7d_pct === "number").length ? (100 * xs.filter((r) => Number(r.peak7d_pct) >= 10).length) / xs.filter((r) => typeof r.peak7d_pct === "number").length : null;
        const trk = stat(xs, "g_s10_trk"), tp10 = stat(xs, "g_s10_tp10");
        const h1 = stat(xs.filter((r) => Number(r.entry_time_ms) < mid), "g_s10_trk"), h2 = stat(xs.filter((r) => Number(r.entry_time_ms) >= mid), "g_s10_trk");
        const bot = set === "signal" ? stat(xs, "bot_pnl_pct") : null;
        out.push(`${name} | ${xs.length} | ${f(share("GOOD"))} | ${f(share("STOP"))} | ${f(p10)} | ${f(trk?.avg ?? null, 2)} / ${f(trk?.sum ?? null)} | ${f(tp10?.avg ?? null, 2)} | ${f(h1?.avg ?? null, 2)} (${h1?.n ?? 0}) | ${f(h2?.avg ?? null, 2)} (${h2?.n ?? 0})`
          + (set === "signal" ? ` | ${f(bot?.avg ?? null, 2)} / ${f(bot?.sum ?? null)} (${bot?.n ?? 0})` : ""));
      }
      const miss = base.filter((r) => r.wyckoff === null || r.lucy4 === null).length;
      out.push(`без данных для фильтра (Вайкоф или Lucy 4H не прочитались): ${miss} из ${base.length} — такие фильтр не пропускает`);
    }
  }
  out.unshift(`PLM / BG через фильтры Вайкофа и Lucy's VSA · событий ${rows.length} · период ${times.length ? new Date(times[0]!).toISOString().slice(0, 10) : "—"} — ${times.length ? new Date(times[times.length - 1]!).toISOString().slice(0, 10) : "—"}`,
    "GOOD = +10% раньше −8% за 7 дней; STOP = −8% раньше +10%; трекер = безубыток после +8%, трейлинг от +15% на 10 п.п., стоп −10% (стоп PLM / BG); комиссия 0.1%.",
    "W: фаза Вайкофа не «пробой без базы» и определена (как у Impulse Buy). V4 / V1: последняя закрытая свеча 4H / 1H не серая по Lucy's VSA и закрылась выше середины (покупки).");
  return out.join("\n");
}

async function main() {
  ensureDir(OUT); ensureDir(CACHE);
  const now = Math.floor(Date.now() / M15) * M15;
  const evs = events();
  const errors: Record<string, string> = {};
  const rows: Row[] = [];
  const bySym = new Map<string, Ev[]>();
  for (const e of evs) bySym.set(e.symbol, [...(bySym.get(e.symbol) ?? []), e]);
  let done = 0;
  for (const [s, list] of bySym) {
    try {
      const first = Math.min(...list.map((e) => e.at));
      const h4 = await klines(CACHE, s, "4h", first - 30 * D1, now);
      const h1 = await klines(CACHE, s, "1h", first - 8 * D1, now);
      const m15 = await klines(CACHE, s, "15m", first - D1, now);
      const fut = await cgHistory(CACHE, s, "aggfut", first - 30 * D1, now).catch(() => null);
      const spot = await cgHistory(CACHE, s, "aggspot", first - 30 * D1, now).catch(() => null);
      const fut4 = bucket(fut, H4), spot4 = bucket(spot, H4), fut1 = bucket(fut, H1), spot1 = bucket(spot, H1);
      for (const e of list) {
        const i4 = idxAtOrBefore(h4, e.at - H4), i1 = idxAtOrBefore(h1, e.at - H1);
        const i15 = idxAtOrBefore(m15, e.at);
        const entry = e.entry ?? (i15 >= 0 ? m15[i15]!.close : null);
        const lucy4 = i4 >= 0 ? lucyAt(h4, i4, fut4, spot4, H4) : null;
        const lucy1 = i1 >= 0 ? lucyAt(h1, i1, fut1, spot1, H1) : null;
        const buy4 = i4 >= 0 ? closesAboveMiddle(h4[i4]!) : null, buy1 = i1 >= 0 ? closesAboveMiddle(h1[i1]!) : null;
        const wyckoff = i1 >= 0 ? wyckoffAt(h1, i1, fut1) : null;
        const r: Row = {
          set: e.set, id: e.id, symbol: s, pattern: e.pattern, detected_at: new Date(e.at).toISOString(), entry_time_ms: e.at,
          entry, signal_stop: e.stop, bot_status: e.status, bot_pnl_pct: e.pnl, reason: e.reason,
          wyckoff, lucy4, buy4, lucy1, buy1,
          f_w: wyckoff !== null && wyckoff !== "breakout_without_base" ? 1 : 0,
          f_v4: lucy4 !== null && lucy4 !== "N" && buy4 ? 1 : 0,
          f_v1: lucy1 !== null && lucy1 !== "N" && buy1 ? 1 : 0,
        };
        if (entry) {
          Object.assign(r, path(m15, e.at, entry, null));
          Object.assign(r, grid("g", m15, e.at, entry, { s10: entry * 0.9, sig: e.stop && e.stop < entry ? e.stop : null }));
        }
        rows.push(r);
      }
    } catch (err) {
      errors[s] = String(err).slice(0, 160);
    }
    if (++done % 20 === 0) console.error(`${done}/${bySym.size} монет · событий ${rows.length}`);
  }
  writeCsv(join(OUT, "events.csv"), rows);
  writeFileSync(join(OUT, "summary.txt"), summarize(rows) + `\n\nошибок по монетам: ${Object.keys(errors).length}\n`);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
  console.error(`готово: событий ${rows.length}, ошибок ${Object.keys(errors).length}`);
}

void main();
