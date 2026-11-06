/**
 * ABNeon levels study (owner 2026-11-06): which support levels the bot does not see, and what they give.
 * The same production detector (evaluateAbneonSupportBounce, sweep k = 3, 1H reaction on BingX futures,
 * one open trade per coin per variant) is run on six level sets:
 *
 *   V0  as live: zones from BingX futures 4H (600-bar Neon algorithm, 6 strongest zones, 22.10 rule)
 *   V1  without the 22.10 rule (zones price traded through after their last pivot are kept)
 *   V2  12 zones instead of 6 (weaker / lower levels the 6-zone limit hides)
 *   V3  zones from BingX SPOT 4H (what the owner sees on a BingX spot chart)
 *   V4  zones from Binance SPOT 4H (CoinGlass price history)
 *   V5  zones from Binance FUTURES 4H (CoinGlass price history)
 *
 * The reaction and the entry are always on BingX futures (that is where the bot trades). For every signal:
 * the zone, outcomes (24h / 72h / 7d,
 * best / worst move), trades (−8% / stop under the zone × tracker / B.U.+5 / take +10), the volume
 * readings that mattered in v3 (blue / grey / coloured 1H bars before the touch on aggregated CoinGlass
 * futures and on BingX), ATR, the market and the result against it.
 *
 * Run (from artifacts/api-server; uses the candle and CoinGlass cache of v2 / v3):
 *   pnpm dlx tsx scripts/abneon-levels-study.ts --variants V0,V1 --days 60 --out ../../reports/abneon-levels
 * Variants can run in parallel processes (each writes signals_<V>.csv); summary_<V>.txt per variant.
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateAbneonSupportBounce, resolveFrozenZone, computeSupportZones } from "../src/lib/stealth-abneon-detectors.js";
import { applyCgAlias } from "../src/lib/cg-symbol-alias.js";
import { cgHistory, volumeReadings, withVolume, type VBar } from "./study-v2/cg.js";
import {
  type C, type Row, D1, D7, H1, H4, M15, Market, OFFLINE,
  addMarket, ensureDir, grid, idxAtOrBefore, klines, lastClosed, parseArgs, path, pct, series, sleep, trade, usdtSymbols, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "abneon-levels";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const VARIANTS = (args.get("variants") ?? "V0,V1,V2,V3,V4,V5").split(",").filter(Boolean);
const SWEEP = 3;
const ARM_TTL_MS = 24 * H1;
const H4_BACK = 720, H1_BACK = 400;

// ─── Level candles from other venues ─────────────────────────────────────────

type CRow = [number, number, number, number, number, number];
function readCandleCache(file: string, start: number): C[] | null {
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as { from: number; items: CRow[] | null };
    if (c.from > start) return null;
    return c.items ? c.items.map((x) => ({ time: x[0], open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] })) : [];
  } catch { return null; }
}
function writeCandleCache(file: string, start: number, items: C[] | null) {
  writeFileSync(file, JSON.stringify({ from: start, items: items ? items.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) : null }));
}
const closedOnly = (cs: C[], now: number, step: number) => cs.filter((c) => c.time + step <= now).sort((a, b) => a.time - b.time);

/** BingX SPOT 4H (public). Empty when the coin has no spot market. */
async function bingxSpot4h(symbol: string, start: number, now: number): Promise<C[]> {
  const file = join(CACHE, `${symbol}_spot4h.json`);
  const cached = readCandleCache(file, start);
  if (cached) return closedOnly(cached, now, H4);
  if (OFFLINE) return [];
  const out = new Map<number, C>();
  let cursor = start;
  try {
    while (cursor < now) {
      const end = Math.min(now, cursor + 1000 * H4);
      let data: any = null;
      for (const ver of ["v2", "v1"]) {
        const res = await fetch(`https://open-api.bingx.com/openApi/spot/${ver}/market/kline?symbol=${symbol}&interval=4h&startTime=${cursor}&endTime=${end}&limit=1000`);
        const j = (await res.json().catch(() => null)) as any;
        if (j && j.code === 0 && Array.isArray(j.data)) { data = j.data; break; }
      }
      if (!data) break;
      for (const k of data) {
        const c = Array.isArray(k)
          ? { time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }
          : { time: Number(k.time ?? k.openTime), open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) };
        if (c.close > 0) out.set(c.time, c);
      }
      cursor = end;
      await sleep(80);
    }
  } catch { /* keep what we have */ }
  const items = [...out.values()].sort((a, b) => a.time - b.time);
  writeCandleCache(file, start, items);
  return closedOnly(items, now, H4);
}

/** Binance spot / futures 4H through CoinGlass price history (4H, else 1H summed to 4H). */
const RPM = Number(process.env.STUDY_CG_RPM ?? 40);
let lastReq = 0;
async function cgPrice(market: "spot" | "futures", symbol: string, start: number, now: number): Promise<C[]> {
  const file = join(CACHE, `${symbol}_cgprice_${market}_binance4h.json`);
  const cached = readCandleCache(file, start);
  if (cached) return closedOnly(cached, now, H4);
  const key = process.env.CoinGlassAPI?.trim();
  if (!key || OFFLINE) return [];
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const get = async (interval: "4h" | "1h"): Promise<any[] | null> => {
    const url = new URL(`https://open-api-v4.coinglass.com/api/${market}/price/history`);
    const step = interval === "4h" ? H4 : H1;
    for (const [k, v] of Object.entries({ exchange: "Binance", symbol: `${base}USDT`, interval, start_time: String(start), end_time: String(now), limit: String(Math.min(4500, Math.ceil((now - start) / step) + 4)) })) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastReq + 60_000 / RPM - Date.now();
      if (wait > 0) await sleep(wait);
      lastReq = Date.now();
      try {
        const res = await fetch(url, { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
        if (res.status === 429) { await sleep(60_000); continue; }
        if (!res.ok) return null;
        const body = (await res.json()) as { code?: string; data?: any[] };
        return String(body.code) === "0" ? (body.data ?? []) : null;
      } catch { await sleep(3_000); }
    }
    return null;
  };
  const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);
  const parse = (rows: any[]) => rows.map((r) => ({ time: toMs(Number(r.time)), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume_usd ?? r.volume ?? 0) })).filter((c) => c.close > 0);
  let items: C[] = [];
  const r4 = await get("4h");
  if (r4 && r4.length) items = parse(r4);
  else {
    const r1 = await get("1h");
    if (r1 && r1.length) {
      const m = new Map<number, C>();
      for (const c of parse(r1)) {
        const k = Math.floor(c.time / H4) * H4;
        const x = m.get(k);
        if (!x) m.set(k, { ...c, time: k });
        else { x.high = Math.max(x.high, c.high); x.low = Math.min(x.low, c.low); x.close = c.close; x.volume += c.volume; }
      }
      items = [...m.values()];
    } else if (r1 === null && r4 === null) return []; // network / plan error: not cached
  }
  items.sort((a, b) => a.time - b.time);
  writeCandleCache(file, start, items);
  return closedOnly(items, now, H4);
}

// ─── One variant on one coin ─────────────────────────────────────────────────

type Coin = { h4: C[]; h1: C[]; m15: C[]; lv: C[]; agg: Map<number, VBar> | null };
const isBlue = (w: string | null) => w === "A" || w === "O" || w === "M" || w === "W";

function run(variant: string, symbol: string, coin: Coin, from: number, now: number): Row[] {
  const { h1, m15, lv } = coin;
  if (lv.length < 100) return [];
  const opts = variant === "V1" ? { researchKeepBrokenZones: true } : variant === "V2" ? { researchMaxZones: 12 } : {};
  const S1 = series(h1);
  const aggH1 = withVolume(h1, coin.agg, H1), aggH4 = withVolume(coin.h4, coin.agg, H4);
  const out: Row[] = [];
  let arm: { level: number; time: number } | null = null;
  let busyUntil = -Infinity;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const iL = lastClosed(lv, t, H4), i1 = lastClosed(h1, t, H1);
    if (iL < 50 || i1 < 30) continue;
    const res = evaluateAbneonSupportBounce({
      candles4h: lv.slice(Math.max(0, iL - 639), iL + 1),
      candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
      observedAt: t,
      marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: SWEEP,
      ...opts,
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      arm = null;
      const ti = idxAtOrBefore(h1, res.triggerCandleTime);
      if (ti < 0 || h1[ti]!.time !== res.triggerCandleTime) continue;
      const fired = t >= busyUntil;
      const entry = h1[ti]!.close;
      if (fired) {
        const lvHist = lv.slice(0, iL + 1);
        const zone = resolveFrozenZone(lvHist, res.armCandleTime, res.frozenLevel, H4, variant === "V2" ? 12 : undefined);
        const zonesAll = computeSupportZones(lvHist.slice(-640), variant === "V2" ? 12 : undefined);
        let w0 = ti;
        while (w0 - 1 >= 0 && h1[w0 - 1]!.time + H1 > res.armCandleTime) w0--;
        let first = w0, deep = w0;
        for (let k = w0; k <= ti; k++) if (h1[k]!.low <= zone.top * 1.002) { first = k; break; }
        for (let k = w0; k <= ti; k++) if (h1[k]!.low < h1[deep]!.low) deep = k;
        const i4 = lastClosed(coin.h4, t, H4);
        const vA = volumeReadings("aggfut", aggH1, aggH4, first, deep, ti, i4, coin.agg, t);
        const vB = volumeReadings("bx", h1, coin.h4, first, deep, ti, i4, null, t);
        const keep = (r: Row, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => keys.some((x) => k.endsWith(x))));
        const volKeys = ["_cov24", "_pre_blue12", "_pre_grey12", "_pre_colored12", "_pre_blue_run24", "_pre_vol12_vs_prev36", "_4h_blue6", "_4h_grey6", "_trig1h_vsa_color", "_trig1h_welkin", "_tk_pre12_delta", "_tk_24h_delta"];
        const minLow = h1[deep]!.low;
        const atr4 = series(coin.h4).atr[i4] ?? null;
        const stops = { s8: entry * 0.92, struct: Math.min(zone.bottom, minLow) * 0.997 < entry ? Math.min(zone.bottom, minLow) * 0.997 : null };
        const g = grid("x", m15, t, entry, stops);
        out.push({
          variant, symbol, time_utc: new Date(t).toISOString(), entry_time_ms: t, entry, fired: 1,
          frozen_level: res.frozenLevel,
          zone_bottom: zone.bottom, zone_top: zone.top, zone_pivots: zone.count,
          zone_rank_from_bottom: zonesAll.filter((z) => z.top < zone.bottom).length,
          zone_below_price_pct: pct(zone.top, entry),
          sweep_below_zone_pct: pct(zone.bottom, minLow),
          atr1h_pct: S1.atr[ti] ?? null, atr4h_pct: atr4,
          price_24h_pct: pct(entry, h1[ti - 24]?.close),
          ...keep(vA, volKeys), ...keep(vB, volKeys),
          ...path(m15, t, entry, atr4),
          x_s8_trk: g.x_s8_trk, x_s8_be5trk: g.x_s8_be5trk, x_s8_tp10: g.x_s8_tp10, x_s8_trk_h: g.x_s8_trk_h,
          x_struct_trk: g.x_struct_trk, x_struct_be5trk: g.x_struct_be5trk, x_struct_tp10: g.x_struct_tp10, x_stopdist_struct_pct: g.x_stopdist_struct_pct,
        });
        const tr = trade(m15, t, entry, entry * 0.92, "trk");
        busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
      }
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT);
  ensureDir(CACHE);
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const market = new Market();
  const rows: Record<string, Row[]> = Object.fromEntries(VARIANTS.map((v) => [v, []]));
  const levelCov: Record<string, number> = Object.fromEntries(VARIANTS.map((v) => [v, 0]));
  const errors: Record<string, string> = {};
  let done = 0;
  for (const s of symbols) {
    try {
      const h4 = await klines(CACHE, s, "4h", from - H4_BACK * H4, now);
      const h1 = await klines(CACHE, s, "1h", from - H1_BACK * H1, now);
      const m15 = await klines(CACHE, s, "15m", from - 8 * M15, now);
      if (h4.length < 100 || h1.length < 200 || m15.length < 100) { errors[s] = "short_history"; continue; }
      market.addCoin(h1, h4);
      const agg = await cgHistory(CACHE, s, "aggfut", from - H1_BACK * H1, now);
      for (const v of VARIANTS) {
        const lv = v === "V3" ? await bingxSpot4h(s, from - H4_BACK * H4, now)
          : v === "V4" ? await cgPrice("spot", s, from - H4_BACK * H4, now)
          : v === "V5" ? await cgPrice("futures", s, from - H4_BACK * H4, now)
          : h4;
        if (lv.length >= 100) levelCov[v]!++;
        rows[v]!.push(...run(v, s, { h4, h1, m15, lv, agg }, from, now));
      }
    } catch (e) {
      errors[s] = String(e).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`${done}/${symbols.length} · ` + VARIANTS.map((v) => `${v} ${rows[v]!.length}`).join(", "));
  }
  for (const v of VARIANTS) {
    const rs = rows[v]!;
    addMarket(rs, market);
    writeCsv(join(OUT, `signals_${v}.csv`), rs);
    const done72 = rs.filter((r) => r.out72 !== "OPEN");
    const p = (k: string) => (done72.length ? Math.round((100 * done72.filter((r) => r.out72 === k).length) / done72.length) : 0);
    const trk = rs.map((r) => r.x_s8_trk).filter((x): x is number => typeof x === "number");
    const text = `${v} · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет с уровнями ${levelCov[v]} из ${symbols.length}\n` +
      `сигналов ${rs.length} (в день ${(rs.length / DAYS).toFixed(1)}): GOOD ${p("GOOD")}%, STOP ${p("STOP")}%, сделка (−8%, трекер) ${trk.length ? (trk.reduce((a, b) => a + b, 0) / trk.length).toFixed(2) : "—"}%`;
    writeFileSync(join(OUT, `summary_${v}.txt`), text);
    console.log(text);
  }
  writeFileSync(join(OUT, `errors_${VARIANTS.join("_")}.json`), JSON.stringify(errors, null, 1));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
