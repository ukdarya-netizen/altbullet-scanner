/**
 * ABNeon: zones on 4H, volume on 15m (owner 2026-11-12: "зоны смотреть на 4 часах, а объемы на более мелких ТФ?").
 * Every 4H zone touch the live detector arms (as abneon-entry-variants). Within 48 h after the arm the entry is
 * taken at the close of a 15m candle whose AGGREGATED CoinGlass 15m volume is bright; the setup is void once a 4H
 * candle closes under the zone bottom before the entry. CoinGlass keeps ≈ 46 days of 15m bars, so run with --days 44.
 *
 *   LIVE          the live zone entry, same period, for reference
 *   F15           first green 15m with futures volume Welkin O / M / W (20 bars)
 *   S15           first green 15m with spot volume Welkin O / M / W
 *   FS15          first green 15m bright on futures AND spot
 *   F15_LUCY      first green 15m bright on futures by Lucy's rule (O / M / W and above the 120-bar average)
 *   F15_IN_ZONE   first green bright (futures) 15m whose low is inside the zone (the level is being bought)
 *   F15_RECLAIM   first green bright (futures) 15m closing above the zone top
 *   F15_SECOND    the second green bright (futures) 15m since the touch
 *   F15_ANY_LOW   the lowest low since the touch printed on a bright (futures) 15m bar of any colour, entry at the
 *                 first green 15m closing above that bar's high
 *
 * Exit as live ABNeon (stop under the zone bottom −1%, B.U. +10, trailing +20/20, cancel at a 4H close under the zone
 * bottom, 4 days, fee 0.1%). One trade per coin at a time per entry. summary.txt: per entry trades, average / sum,
 * % in profit, % with peak ≥ +10%, by month (November = the check month), the owner's coins by name; trades.csv.
 * Run (from artifacts/api-server):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-15m-volume-study.ts --days 44 --out ../../reports/abneon-15m-volume
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgHistoryTf, cgStats, withVolume, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, usdtSymbols, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 44);
const OUT = args.get("out") ?? "abneon-15m-volume";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const HER = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,PRIORS,BIKETYSON,HBAR,XTZ,CFX,JASMY,USELESS,POL,ERA").split(",").map((s) => `${s}-USDT`);
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-28T00:00:00Z");
const WAIT = 48 * H1, HORIZON = 4 * D1, FEE = 0.1, BE = 10, TR_ACT = 20, TR_GAP = 20;
const ENTRIES = ["LIVE", "F15", "S15", "FS15", "F15_LUCY", "F15_IN_ZONE", "F15_RECLAIM", "F15_SECOND", "F15_ANY_LOW"] as const;
type E = (typeof ENTRIES)[number];

const r2 = (x: number) => Math.round(x * 100) / 100;
const fmtT = (t: number) => { const d = new Date(t + 4 * H1), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:00`; };

function agg4hMap(agg: Map<number, VBar> | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!agg) return out;
  const sums = new Map<number, { usd: number; n: number }>();
  for (const [t, b] of agg) { const k = Math.floor(t / H4) * H4; const s = sums.get(k) ?? { usd: 0, n: 0 }; s.usd += b.buy + b.sell; s.n++; sums.set(k, s); }
  for (const [k, s] of sums) if (s.n === 4) out.set(k, s.usd);
  return out;
}
function welkinWin(cs: C[], i: number, n: number, longN = 0): string | null {
  if (i < 0 || i - Math.max(n, longN) + 1 < 0) return null;
  const vs: number[] = [];
  for (let k = i - n + 1; k <= i; k++) { const v = cs[k]!.volume; if (!Number.isFinite(v)) return null; vs.push(v); }
  const avg = vs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(vs.reduce((a, v) => a + (v - avg) ** 2, 0) / n);
  const v = vs[n - 1]!, prev = vs[n - 2]!;
  if (longN > 0) {
    let s = 0;
    for (let k = i - longN + 1; k <= i; k++) { const x = cs[k]!.volume; if (!Number.isFinite(x)) return null; s += x; }
    if (v < s / longN) return "N";
  }
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}

type Arm = { armTime: number; top: number; bottom: number; liveEntryAt: number | null; liveEntry: number | null };

/** The live replay (same loop as abneon-full-study): every zone touch the detector arms, with its zone, and the
 *  live rule's entry if it fired. */
function arms(h4: C[], h1: C[], a4: Map<number, number>, from: number, now: number): Arm[] {
  const out: Arm[] = [];
  const seen = new Map<string, number>();
  const note = (level: number, time: number, i4: number): number => {
    const k = `${time}:${level}`;
    let idx = seen.get(k);
    if (idx === undefined) {
      const zone = resolveFrozenZone(h4.slice(0, i4 + 1), time, level);
      out.push({ armTime: time, top: zone.top, bottom: zone.bottom, liveEntryAt: null, liveEntry: null });
      idx = out.length - 1;
      seen.set(k, idx);
    }
    return idx;
  };
  let arm: { level: number; time: number } | null = null;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const i4 = lastClosed(h4, t, H4), i1 = lastClosed(h1, t, H1);
    if (i4 < 0 || i1 < 0) continue;
    const c4 = h4.slice(Math.max(0, i4 - 639), i4 + 1), c1 = h1.slice(Math.max(0, i1 - 29), i1 + 1);
    const res = evaluateAbneonSupportBounce({ candles4h: c4, candles1h: c1, observedAt: t, marketCapUsd: null, ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}), sweepReclaimBars: 3 });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const idx = note(res.frozenLevel, res.armCandleTime, i4);
      const tv = touchVolumeNotGrey({ candles1h: h1.slice(0, i1 + 1), candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: a4, armCandleTime: res.armCandleTime, triggerCandleTime: res.triggerCandleTime, zoneTop: res.frozenLevel, nowMs: t });
      if (!tv.ok && tv.reason === "touch_bar_not_closed") { if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime }; continue; }
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      arm = null;
      if (tv.ok && ti >= 0 && out[idx]!.liveEntryAt === null) { out[idx]!.liveEntryAt = t; out[idx]!.liveEntry = h1[ti]!.close; }
      continue;
    }
    if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      note(res.frozenLevel, res.armCandleTime, i4);
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
      continue;
    }
    if (arm && (res.status === "terminal" || t - arm.time > 24 * H1)) arm = null;
  }
  return out;
}

function sim(h4: C[], m15: C[], at: number, entry: number, level: number, now: number): { pct: number; end: number; how: string; peak: number } | null {
  const stopP = stopUnderLevel(entry, level);
  if (stopP === null) return null;
  let stop = stopP, peak = entry, how = "стоп";
  const done = (price: number, t: number, h: string) => ({ pct: (price / entry - 1) * 100 - FEE, end: t, how: h, peak: (peak / entry - 1) * 100 });
  for (let i = idxAtOrBefore(m15, at - 1) + 1; i < m15.length; i++) {
    const c = m15[i]!;
    if (c.time >= at + HORIZON) break;
    if ((c.time % H4) === 0 && c.time > at) {
      const j = idxAtOrBefore(h4, c.time - H4);
      if (j >= 0 && h4[j]!.time + H4 === c.time && h4[j]!.close < level) return done(h4[j]!.close, c.time, "отмена 4H под уровнем");
    }
    if (c.low <= stop) return done(Math.min(stop, c.open), c.time + M15, how);
    peak = Math.max(peak, c.high);
    const pp = (peak / entry - 1) * 100;
    if (pp >= BE && stop < entry) { stop = entry; how = "безубыток"; }
    if (pp >= TR_ACT) { const ts = entry * (1 + (pp - TR_GAP) / 100); if (ts > stop) { stop = ts; how = "трейлинг"; } }
  }
  if (at + HORIZON > now) return null;
  const j = idxAtOrBefore(m15, at + HORIZON - M15);
  return j >= 0 ? done(m15[j]!.close, at + HORIZON, "4 дня") : null;
}

/** 15m candles with the aggregated 15m CoinGlass volume (USD / close); NaN where missing. */
function vol15(cs: C[], vb: Map<number, VBar> | null): C[] {
  return cs.map((c) => { const b = vb?.get(c.time); return { ...c, volume: b && c.close > 0 ? (b.buy + b.sell) / c.close : NaN }; });
}
const BRIGHT = new Set(["O", "M", "W"]);
/** Entry time (close of the 15m bar) and price for one variant, or null. m15f / m15s: 15m candles with aggregated volume. */
function findEntry(e: Exclude<E, "LIVE">, a: Arm, m15: C[], h4: C[], m15f: C[], m15s: C[], now: number): { at: number; price: number } | null {
  const i0 = m15.findIndex((c) => c.time >= a.armTime);
  if (i0 < 0) return null;
  let low = Infinity, lowBright = false, lowHigh = 0, touched = false, brightGreen = 0;
  for (let k = i0; k < m15.length; k++) {
    const c = m15[k]!, closeAt = c.time + M15;
    if (closeAt > a.armTime + WAIT || closeAt > now) return null;
    if (closeAt % H4 === 0) { const j = idxAtOrBefore(h4, closeAt - H4); if (j >= 0 && h4[j]!.close < a.bottom) return null; }
    if (c.low <= a.top * 1.02) touched = true;
    const wf = welkinWin(m15f, k, 20), bf = wf !== null && BRIGHT.has(wf);
    if (c.low < low) { low = c.low; lowBright = bf; lowHigh = c.high; }
    if (!touched) continue;
    const green = c.close > c.open, hit = { at: closeAt, price: c.close };
    if (green && bf) brightGreen++;
    switch (e) {
      case "F15": if (green && bf) return hit; break;
      case "S15": { const ws = welkinWin(m15s, k, 20); if (green && ws !== null && BRIGHT.has(ws)) return hit; break; }
      case "FS15": { const ws = welkinWin(m15s, k, 20); if (green && bf && ws !== null && BRIGHT.has(ws)) return hit; break; }
      case "F15_LUCY": { const wl = welkinWin(m15f, k, 20, 120); if (green && wl !== null && BRIGHT.has(wl)) return hit; break; }
      case "F15_IN_ZONE": if (green && bf && c.low <= a.top && c.low >= a.bottom * 0.99) return hit; break;
      case "F15_RECLAIM": if (green && bf && c.close > a.top) return hit; break;
      case "F15_SECOND": if (green && bf && brightGreen >= 2) return hit; break;
      case "F15_ANY_LOW": if (lowBright && c.low > low && green && c.close > lowHigh) return hit; break;
    }
  }
  return null;
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15, from = now - DAYS * D1;
  ensureDir(OUT); ensureDir(CACHE);
  const listed = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const symbols = [...new Set([...HER, ...listed])];
  const rows: Row[] = [];
  let done = 0, nArms = 0;
  for (const symbol of symbols) {
    try {
      const h4 = await klines(CACHE, symbol, "4h", from - 720 * H4, now);
      const h1 = await klines(CACHE, symbol, "1h", from - 800 * H1, now);
      const m15 = await klines(CACHE, symbol, "15m", from - 2 * D1, now);
      if (h4.length < 60 || h1.length < 60 || m15.length < 100) continue;
      const aggF = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      if (!aggF) continue; // ABNeon needs the aggregated volume (live rule)
      const aggS = await cgHistory(CACHE, symbol, "aggspot", from - 30 * D1, now);
      const a4 = agg4hMap(aggF);
      const f15 = await cgHistoryTf(CACHE, symbol, "aggfut", from - 2 * D1, now, "15m");
      const s15 = await cgHistoryTf(CACHE, symbol, "aggspot", from - 2 * D1, now, "15m");
      const m15f = vol15(m15, f15), m15s = vol15(m15, s15);
      const list = arms(h4, h1, a4, from, now);
      nArms += list.length;
      const busy = new Map<E, number>(ENTRIES.map((e) => [e, -Infinity]));
      for (const a of list) {
        for (const e of ENTRIES) {
          const en = e === "LIVE" ? (a.liveEntryAt !== null ? { at: a.liveEntryAt, price: a.liveEntry! } : null) : findEntry(e, a, m15, h4, m15f, m15s, now);
          if (!en || en.at < busy.get(e)!) continue;
          const res = sim(h4, m15, en.at, en.price, a.bottom, now);
          busy.set(e, res ? res.end : en.at + HORIZON);
          rows.push({ entry_kind: e, symbol, arm_utc: new Date(a.armTime).toISOString(), entry_utc: new Date(en.at).toISOString(), wait_h: r2((en.at - a.armTime) / H1),
            entry: en.price, zone_top: a.top, zone_bottom: a.bottom, result_pct: res ? r2(res.pct) : null, how: res?.how ?? "open", peak_pct: res ? r2(res.peak) : null });
        }
      }
    } catch { /* coin skipped */ }
    if (++done % 25 === 0) console.error(`монеты ${done}/${symbols.length}, касаний ${nArms}, сделок ${rows.length} · CoinGlass ${cgStats.requests}`);
  }
  writeCsv(join(OUT, "trades.csv"), rows);
  const L: string[] = [
    `ABNeon: зоны 4H, объём 15m (агрегированный CoinGlass) · ${new Date(from).toISOString().slice(0, 10)} … ${new Date(now).toISOString().slice(0, 10)} · монет ${symbols.length}, касаний зоны ${nArms}`,
    `Окно входа 48 ч после касания; касание отменяется, если 4H закрылась под зоной до входа. Выход как живой ABNeon (стоп под зоной −1%, Б.У. +10, трейл +20/20, отмена 4H под уровнем, 4 дня, комиссия 0.1%).`,
    ``,
  ];
  for (const e of ENTRIES) {
    const ts = rows.filter((x) => x.entry_kind === e);
    const cl = ts.filter((x) => typeof x.result_pct === "number");
    const v = cl.map((x) => x.result_pct as number), s = v.reduce((a, b) => a + b, 0);
    const m = new Map<string, number[]>();
    for (const x of cl) { const k = String(x.entry_utc).slice(0, 7); m.set(k, [...(m.get(k) ?? []), x.result_pct as number]); }
    const w = ts.map((x) => Number(x.wait_h)).sort((a, b) => a - b);
    L.push(`${e}: сделок ${ts.length} (${(ts.length / DAYS).toFixed(1)} в день) · закрыто ${v.length} · ср ${v.length ? r2(s / v.length) : "—"}% · сумма ${Math.round(s)}% · в плюсе ${v.length ? Math.round((100 * v.filter((x) => x > 0).length) / v.length) : "—"}% · пик≥10 ${cl.length ? Math.round((100 * cl.filter((x) => (x.peak_pct as number) >= 10).length) / cl.length) : "—"}% · ожидание ${w.length ? `${w[0]}…${w.at(-1)} ч` : "—"}`);
    L.push(`   по месяцам: ${[...m.entries()].sort().map(([k, xs]) => `${k} n${xs.length} ${r2(xs.reduce((a, b) => a + b, 0) / xs.length)}%`).join(" · ")}`);
  }
  L.push(``, `Твои монеты с ${fmtT(HER_FROM)} (Дубай): каждое касание и что сделал каждый вход (итог %, — = входа не было):`);
  const herArms = new Map<string, Row[]>();
  for (const x of rows) if (HER.includes(String(x.symbol)) && Date.parse(String(x.arm_utc)) >= HER_FROM) { const k = `${x.symbol} ${x.arm_utc}`; herArms.set(k, [...(herArms.get(k) ?? []), x]); }
  for (const [k, xs] of [...herArms.entries()].sort()) {
    const [sym, arm] = k.split(" ");
    L.push(`  ${sym!.replace("-USDT", "").padEnd(10)} касание ${fmtT(Date.parse(arm!))} · ${ENTRIES.map((e) => { const x = xs.find((y) => y.entry_kind === e); return `${e} ${x ? (x.result_pct === null ? "идёт" : x.result_pct) : "—"}`; }).join(" · ")}`);
  }
  writeFileSync(join(OUT, "summary.txt"), L.join("\n") + "\n");
  console.log(L.slice(0, 3 + ENTRIES.length * 2).join("\n"));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
