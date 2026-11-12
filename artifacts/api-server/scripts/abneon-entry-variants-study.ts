/**
 * ABNeon: which entry makes the zone bounce profitable (owner 2026-11-12: "change the entry — we look for what
 * works on the market"). Every zone touch the live detector arms (evaluateAbneonSupportBounce → armed /
 * qualified), on every BingX USDT coin, 64 days. For each touch every entry below is tried within 48 h after
 * the arm; the setup is void once a 4H candle closes under the zone bottom before the entry. Entry at the close
 * of the 1H (or 4H) candle; nothing from the future.
 *
 *   LIVE          the live zone rule as it is now (touch volume not grey + 1H reaction), for reference;
 *                 the live low-bounce path (no zone) is not part of this comparison
 *   RECLAIM_1H    first 1H close above the zone top after the touch
 *   RECLAIM_4H    first 4H close above the zone top after the touch
 *   BOUNCE_3/5    first 1H close ≥ 3% / 5% above the lowest low since the arm
 *   BOS_1H        after the lowest low: first 1H close above the highest high of the 6 1H bars before it
 *   HL_1H         higher low: ≥ 2 bars after the lowest low, a 1H close above the high of the lowest-low bar
 *   GREEN_4H      first green 4H candle closing above the previous 4H high
 *   BRIGHT_1H     green 1H candle on bright aggregated futures volume (Welkin O / M / W, 20 bars)
 *   LUCY_4H       green 4H candle above the previous 4H high whose aggregated volume is above the 120-bar
 *                 average (Lucy's VSA rule: not grey)
 *   SPOT_1H       green 1H candle with aggregated spot volume ≥ 2× its 20-bar average
 *
 * Every entry: stop under the zone bottom −1% (stopUnderLevel, 3…15%), exit as live ABNeon (B.U. +10, trailing
 * +20/20 p.p., cancel at a 4H close under the zone bottom, 4 days, fee 0.1%). One trade per coin at a time per entry.
 *
 * Out: summary.txt — per entry: trades, average / sum, % in profit, % with peak ≥ +10%, by month, waiting time,
 *      the owner's coins by name (ELSA, INIT, PIEVERSE, EDGEX, KNOTS, GANG, SI, …) with every entry's result;
 *      trades.csv.
 * Run (from artifacts/api-server; candles and CoinGlass from the study cache):
 *   STUDY_CG_RPM=30 pnpm dlx tsx scripts/abneon-entry-variants-study.ts --days 64 --out ../../reports/abneon-entry-variants
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone } from "../src/lib/stealth-abneon-detectors.js";
import { touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { stopUnderLevel } from "../src/lib/abneon-low-bounce.js";
import { cgHistory, cgStats, withVolume, type VBar } from "./study-v2/cg.js";
import { type C, type Row, D1, H1, H4, M15, ensureDir, idxAtOrBefore, klines, lastClosed, parseArgs, usdtSymbols, writeCsv } from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 64);
const OUT = args.get("out") ?? "abneon-entry-variants";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const HER = (args.get("her") ?? "ELSA,INIT,PIEVERSE,EDGEX,KNOTS,GANG,SI,PRIORS,BIKETYSON,HBAR,XTZ,CFX,JASMY,USELESS,POL,ERA").split(",").map((s) => `${s}-USDT`);
const HER_FROM = Date.parse(args.get("her-from") ?? "2026-10-28T00:00:00Z");
const WAIT = 48 * H1, HORIZON = 4 * D1, FEE = 0.1, BE = 10, TR_ACT = 20, TR_GAP = 20;
const ENTRIES = ["LIVE", "RECLAIM_1H", "RECLAIM_4H", "BOUNCE_3", "BOUNCE_5", "BOS_1H", "HL_1H", "GREEN_4H", "BRIGHT_1H", "LUCY_4H", "SPOT_1H"] as const;
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

/** Entry time (close of the bar) and price for one variant, or null. */
function findEntry(e: Exclude<E, "LIVE">, a: Arm, h1: C[], h4: C[], h1f: C[], h1s: C[], h4f: C[], now: number): { at: number; price: number } | null {
  const i0 = h1.findIndex((c) => c.time >= a.armTime);
  if (i0 < 0) return null;
  let low = Infinity, iLow = -1, touched = false;
  for (let k = i0; k < h1.length; k++) {
    const c = h1[k]!, closeAt = c.time + H1;
    if (closeAt > a.armTime + WAIT || closeAt > now) return null;
    // void: a 4H close under the zone bottom before the entry
    if (closeAt % H4 === 0) { const j = idxAtOrBefore(h4, closeAt - H4); if (j >= 0 && h4[j]!.close < a.bottom) return null; }
    if (c.low <= a.top * 1.02) touched = true;
    if (c.low < low) { low = c.low; iLow = k; }
    if (!touched) continue;
    const green = c.close > c.open;
    switch (e) {
      case "RECLAIM_1H": if (c.close > a.top && k > iLow) return { at: closeAt, price: c.close }; break;
      case "BOUNCE_3": if (c.close >= low * 1.03) return { at: closeAt, price: c.close }; break;
      case "BOUNCE_5": if (c.close >= low * 1.05) return { at: closeAt, price: c.close }; break;
      case "BOS_1H": {
        if (k <= iLow || iLow < 6) break;
        let hi = 0;
        for (let q = iLow - 6; q < iLow; q++) hi = Math.max(hi, h1[q]!.high);
        if (c.close > hi) return { at: closeAt, price: c.close };
        break;
      }
      case "HL_1H": if (k >= iLow + 2 && c.close > h1[iLow]!.high) return { at: closeAt, price: c.close }; break;
      case "BRIGHT_1H": {
        const w = welkinWin(h1f, k, 20);
        if (green && (w === "O" || w === "M" || w === "W")) return { at: closeAt, price: c.close };
        break;
      }
      case "SPOT_1H": {
        if (!green || k < 20) break;
        let s = 0, n = 0;
        for (let q = k - 20; q < k; q++) { const v = h1s[q]!.volume; if (Number.isFinite(v)) { s += v; n++; } }
        const v = h1s[k]!.volume;
        if (n === 20 && Number.isFinite(v) && v >= 2 * (s / 20)) return { at: closeAt, price: c.close };
        break;
      }
      case "RECLAIM_4H": case "GREEN_4H": case "LUCY_4H": {
        if (closeAt % H4 !== 0) break;
        const j = idxAtOrBefore(h4, closeAt - H4);
        if (j < 1) break;
        const b = h4[j]!, prev = h4[j - 1]!;
        if (e === "RECLAIM_4H" && b.close > a.top) return { at: closeAt, price: b.close };
        if (e === "GREEN_4H" && b.close > b.open && b.close > prev.high) return { at: closeAt, price: b.close };
        if (e === "LUCY_4H" && b.close > b.open && b.close > prev.high) {
          const jf = idxAtOrBefore(h4f, b.time);
          const w = jf >= 0 ? welkinWin(h4f, jf, 20, 120) : null;
          if (w !== null && w !== "N") return { at: closeAt, price: b.close };
        }
        break;
      }
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
      const m15 = await klines(CACHE, symbol, "15m", from - 8 * M15, now);
      if (h4.length < 60 || h1.length < 60 || m15.length < 100) continue;
      const aggF = await cgHistory(CACHE, symbol, "aggfut", from - 720 * H4, now);
      if (!aggF) continue; // ABNeon needs the aggregated volume (live rule)
      const aggS = await cgHistory(CACHE, symbol, "aggspot", from - 30 * D1, now);
      const a4 = agg4hMap(aggF);
      const h1f = withVolume(h1, aggF, H1), h4f = withVolume(h4, aggF, H4), h1s = withVolume(h1, aggS, H1);
      const list = arms(h4, h1, a4, from, now);
      nArms += list.length;
      const busy = new Map<E, number>(ENTRIES.map((e) => [e, -Infinity]));
      for (const a of list) {
        for (const e of ENTRIES) {
          const en = e === "LIVE" ? (a.liveEntryAt !== null ? { at: a.liveEntryAt, price: a.liveEntry! } : null) : findEntry(e, a, h1, h4, h1f, h1s, h4f, now);
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
    `ABNeon: какой вход работает · ${new Date(from).toISOString().slice(0, 10)} … ${new Date(now).toISOString().slice(0, 10)} · монет ${symbols.length}, касаний зоны ${nArms}`,
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
