/**
 * ABNeon zone-timeframe study (owner 2026-11-14): are the ABNeon levels true, and should they come from the DAILY
 * candles while the touches / breakouts stay on the lower timeframes? Read-only, offline-capable, one run.
 *
 * The same live rules, only the zone candles differ:
 *   Z4    as live: BingX futures 4H, the last 640 bars (600-bar Neon algorithm, 6 zones, 22.10 rule)
 *   Z1B   BingX futures 1D, the last 640 days (as many as BingX has)
 *   Z1L   1D with the longest history: Binance spot 1D (CoinGlass price history) for the days before BingX had
 *         the coin, BingX futures 1D after (owner: a coin new on BingX is often old elsewhere)
 *
 * Per variant:
 *  A. SUPPORT BOUNCE — the live detector evaluateAbneonSupportBounce (zone candles + zone timeframe, closed 1H
 *     reaction, 15m confirmation, sweep 3 zone-bars, frozen arm, one open trade per coin) every hour; for every
 *     signal the live Lucy's VSA gate on the touch (touchVolumeNotGrey: aggregated futures + spot 4H, 120 bars)
 *     as a column (gate_ok) — results are given with and without it.
 *  B. STEALTH — the live rule: a closed 4H candle closes above a zone top (previous 4H close at / below it, the
 *     highest crossed zone) on bright aggregated futures 4H volume (Welkin M / W, neonBreakoutColour).
 *  C. LEVEL TRUTH — every first entry of a 1H low into a support zone from above (and of a 1H high into a
 *     resistance from below): did price go +5% away from the zone before a 1H close 1% through it (72 h)?
 *     Zones refreshed at every UTC day close for every variant (same cadence).
 * Outcomes: 24h / 72h / 7d (GOOD +10% before −8%, STOP), peaks, the −8% / structural stop × tracker / B.U.+5 /
 * take +10 grid, both halves of the period, the live signals by name (--live: CAB signals csv), coins whose
 * BingX history is shorter than 200 days apart.
 *
 * Run (from artifacts/api-server; the candle / CoinGlass cache of the earlier ABNeon studies is reused):
 *   pnpm dlx tsx scripts/abneon-zone-tf-study.ts --days 60 --out ../../reports/abneon-zone-tf --live ../../reports/abneon/signals.csv
 *   optional: --symbols AIN-USDT,JCT-USDT  --limit 50  --variants Z4,Z1B,Z1L
 * Output: bounce_<V>.csv, stealth_<V>.csv, truth_<V>.csv, live_compare.csv, summary.txt, errors.json.
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeSupportZones, evaluateAbneonSupportBounce, resolveFrozenZone, type SupportZone } from "../src/lib/stealth-abneon-detectors.js";
import { neonBreakoutColour, isNeonVsaBright } from "../src/lib/stealth-neon-level-breakout.js";
import { touchVolumeNotGrey } from "../src/lib/abneon-volume-gate.js";
import { applyCgAlias } from "../src/lib/cg-symbol-alias.js";
import { cgHistory, type VBar } from "./study-v2/cg.js";
import {
  type C, type Row, D1, D7, H1, H4, M15, OFFLINE,
  ensureDir, grid, idxAtOrBefore, klines, lastClosed, parseArgs, path, pct, sleep, trade, usdtSymbols, writeCsv,
} from "./study-v2/lib.js";

const args = parseArgs();
const DAYS = Number(args.get("days") ?? 60);
const OUT = args.get("out") ?? "abneon-zone-tf";
const CACHE = args.get("cache") ?? "../../reports/.cache";
const LIMIT = Number(args.get("limit") ?? 10_000);
const ONLY = args.get("symbols")?.split(",").filter(Boolean) ?? null;
const LIVE = args.get("live");
const VARIANTS = (args.get("variants") ?? "Z4,Z1B,Z1L").split(",").filter(Boolean) as Variant[];
type Variant = "Z4" | "Z1B" | "Z1L";
const ZONE_BARS = 640, SWEEP = 3, ARM_TTL_MS = 24 * H1;
const H4_BACK = 720, H1_BACK = 400, D1_BACK = 700;

// ─── Binance spot 1D (CoinGlass price history), cached ───────────────────────
type CRow = [number, number, number, number, number, number];
const RPM = Number(process.env.STUDY_CG_RPM ?? 40);
let lastReq = 0;
async function binanceSpot1d(symbol: string, start: number, now: number): Promise<C[]> {
  const file = join(CACHE, `${symbol}_cgprice_spot_binance1d.json`);
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { from: number; items: CRow[] };
      if (c.from <= start) return c.items.map((x) => ({ time: x[0], open: x[1], high: x[2], low: x[3], close: x[4], volume: x[5] })).filter((c) => c.time + D1 <= now);
    } catch { /* refetch */ }
  }
  const key = process.env.CoinGlassAPI?.trim();
  if (!key || OFFLINE) return [];
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL("https://open-api-v4.coinglass.com/api/spot/price/history");
  for (const [k, v] of Object.entries({ exchange: "Binance", symbol: `${base}USDT`, interval: "1d", start_time: String(start), end_time: String(now), limit: "1000" })) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = lastReq + 60_000 / RPM - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    try {
      const res = await fetch(url, { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { await sleep(60_000); continue; }
      if (!res.ok) return [];
      const body = (await res.json()) as { code?: string; data?: any[] };
      if (String(body.code) !== "0") return [];
      const toMs = (t: number) => (t < 1e12 ? t * 1000 : t);
      const items = (body.data ?? []).map((r) => ({ time: toMs(Number(r.time)), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume_usd ?? r.volume ?? 0) }))
        .filter((c) => c.close > 0).sort((a, b) => a.time - b.time);
      writeFileSync(file, JSON.stringify({ from: start, items: items.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume]) }));
      return items.filter((c) => c.time + D1 <= now);
    } catch { await sleep(3_000); }
  }
  return [];
}

/** Binance days before BingX's first day, then BingX. */
function longDaily(bingx: C[], binance: C[]): C[] {
  if (!bingx.length) return binance;
  const first = bingx[0]!.time;
  return [...binance.filter((c) => c.time < first), ...bingx];
}

/** 4H aggregated USD volume by 4H open time (futures, and futures + spot for Lucy's VSA). */
function agg4h(vb: Map<number, VBar> | null): Map<number, number> {
  const m = new Map<number, number>();
  if (!vb) return m;
  const n = new Map<number, number>();
  for (const b of vb.values()) {
    const k = Math.floor(b.time / H4) * H4;
    m.set(k, (m.get(k) ?? 0) + b.buy + b.sell);
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  for (const [k, c] of n) if (c !== 4) m.delete(k);
  return m;
}

const zoneStep = (v: Variant) => (v === "Z4" ? H4 : D1);
const half = (t: number, from: number, now: number) => (t < from + (now - from) / 2 ? 1 : 2);

type Coin = { h4: C[]; h1: C[]; m15: C[]; zc: C[]; aggF4: Map<number, number>; aggFS4: Map<number, number>; bingxDays: number };

// ─── A. Support bounce (live detector) ───────────────────────────────────────
function bounces(v: Variant, symbol: string, coin: Coin, from: number, now: number): Row[] {
  const { h1, m15, zc, h4 } = coin;
  const step = zoneStep(v);
  if (zc.length < 200) return [];
  const out: Row[] = [];
  let arm: { level: number; time: number } | null = null;
  let busyUntil = -Infinity;
  for (let t = Math.ceil(from / H1) * H1; t <= now; t += H1) {
    const iZ = lastClosed(zc, t, step), i1 = lastClosed(h1, t, H1);
    if (iZ < 199 || i1 < 30) continue;
    const zSlice = zc.slice(Math.max(0, iZ - ZONE_BARS + 1), iZ + 1);
    const res = evaluateAbneonSupportBounce({
      candles4h: zSlice,
      candles1h: h1.slice(Math.max(0, i1 - 29), i1 + 1),
      candles15m: m15.slice(Math.max(0, idxAtOrBefore(m15, t - 1) - 15), idxAtOrBefore(m15, t - 1) + 1),
      observedAt: t,
      marketCapUsd: null,
      ...(arm ? { frozenLevel: arm.level, armCandleTime: arm.time } : {}),
      sweepReclaimBars: SWEEP,
      ...(v === "Z4" ? {} : { zoneTimeframeMs: step }),
    });
    if (res.status === "qualified" && res.triggerCandleTime != null && res.frozenLevel != null && res.armCandleTime != null) {
      const armTime = res.armCandleTime;
      arm = null;
      if (t < busyUntil) continue;
      const entry = h1[i1]!.close;
      const zone = resolveFrozenZone(zSlice, armTime, res.frozenLevel, step);
      const i4 = lastClosed(h4, t, H4);
      const gate = touchVolumeNotGrey({
        candles1h: h1.slice(0, i1 + 1), candles4h: h4.slice(0, i4 + 1), agg4hUsdByTime: coin.aggF4, spot4hUsdByTime: coin.aggFS4,
        armCandleTime: armTime, triggerCandleTime: res.triggerCandleTime, zoneTop: zone.top, nowMs: t,
      });
      const minLow = Math.min(...h1.slice(Math.max(0, i1 - 24), i1 + 1).map((c) => c.low));
      const struct = Math.min(zone.bottom, minLow) * 0.997;
      const g = grid("x", m15, t, entry, { s8: entry * 0.92, struct: struct < entry ? struct : null });
      out.push({
        variant: v, symbol, time_utc: new Date(t).toISOString(), entry_time_ms: t, half: half(t, from, now), entry,
        zone_bottom: zone.bottom, zone_top: zone.top, zone_width_pct: pct(zone.top, zone.bottom), zone_pivots: zone.count,
        zone_dist_pct: pct(zone.top, entry), gate_ok: gate.ok ? 1 : 0, gate_reason: gate.ok ? "" : gate.reason,
        bingx_days: coin.bingxDays, short_bingx: coin.bingxDays < 200 ? 1 : 0,
        ...path(m15, t, entry, null),
        x_s8_trk: g.x_s8_trk, x_s8_be5trk: g.x_s8_be5trk, x_s8_tp10: g.x_s8_tp10,
        x_struct_trk: g.x_struct_trk, x_struct_be5trk: g.x_struct_be5trk, x_struct_tp10: g.x_struct_tp10, x_stopdist_struct_pct: g.x_stopdist_struct_pct,
      });
      const tr = trade(m15, t, entry, entry * 0.92, "trk");
      busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
    } else if (res.status === "armed" && res.frozenLevel != null && res.armCandleTime != null) {
      if (!arm) arm = { level: res.frozenLevel, time: res.armCandleTime };
    } else if (arm && (res.status === "terminal" || t - arm.time > ARM_TTL_MS)) {
      arm = null;
    }
  }
  return out;
}

// ─── B. Stealth (live rule, zones from the variant) ──────────────────────────
function stealth(v: Variant, symbol: string, coin: Coin, from: number, now: number): Row[] {
  const { h4, m15, zc } = coin;
  const step = zoneStep(v);
  if (zc.length < 200) return [];
  const out: Row[] = [];
  let busyUntil = -Infinity;
  let cacheAt = -1, zones: SupportZone[] = [];
  for (let i = 1; i < h4.length; i++) {
    const bar = h4[i]!, prev = h4[i - 1]!;
    const t = bar.time + H4; // the moment the 4H candle closed
    if (t < from || t > now || prev.time !== bar.time - H4) continue;
    const iZ = lastClosed(zc, t, step);
    if (iZ < 199) continue;
    if (iZ !== cacheAt) { zones = computeSupportZones(zc.slice(Math.max(0, iZ - ZONE_BARS + 1), iZ + 1)); cacheAt = iZ; }
    const crossed = zones.filter((z) => prev.close <= z.top && bar.close > z.top).sort((a, b) => b.top - a.top);
    if (!crossed.length) continue;
    const colour = neonBreakoutColour(h4.slice(0, i + 1), coin.aggF4);
    if (!isNeonVsaBright(colour)) continue;
    if (t < busyUntil) continue;
    const entry = bar.close, zone = crossed[0]!;
    const next = zones.filter((z) => z.top > entry).sort((a, b) => a.bottom - b.bottom)[0] ?? null;
    const g = grid("x", m15, t, entry, { s8: entry * 0.92, struct: zone.bottom * 0.997 < entry ? zone.bottom * 0.997 : null });
    out.push({
      variant: v, symbol, time_utc: new Date(t).toISOString(), entry_time_ms: t, half: half(t, from, now), entry, colour,
      zone_bottom: zone.bottom, zone_top: zone.top, zone_width_pct: pct(zone.top, zone.bottom), zone_pivots: zone.count,
      next_resistance_pct: next ? pct(next.bottom, entry) : null,
      bingx_days: coin.bingxDays, short_bingx: coin.bingxDays < 200 ? 1 : 0,
      ...path(m15, t, entry, null),
      x_s8_trk: g.x_s8_trk, x_s8_be5trk: g.x_s8_be5trk, x_s8_tp10: g.x_s8_tp10,
      x_struct_trk: g.x_struct_trk, x_struct_be5trk: g.x_struct_be5trk, x_struct_tp10: g.x_struct_tp10,
    });
    const tr = trade(m15, t, entry, entry * 0.92, "trk");
    busyUntil = tr.hours !== null ? t + tr.hours * H1 : Infinity;
  }
  return out;
}

// ─── C. Level truth ──────────────────────────────────────────────────────────
function truth(v: Variant, symbol: string, coin: Coin, from: number, now: number): Row[] {
  const { h1, zc } = coin;
  const step = zoneStep(v);
  if (zc.length < 200) return [];
  const out: Row[] = [];
  let zones: SupportZone[] = [], dayAt = -1;
  const last = new Map<string, number>(); // zone key → last touch time (one touch per zone per 24h)
  for (let i = 1; i < h1.length; i++) {
    const c = h1[i]!, p = h1[i - 1]!;
    const t = c.time + H1;
    if (t < from || t > now) continue;
    const day = Math.floor(c.time / D1) * D1; // zones as of the last UTC day close (same cadence for every variant)
    if (day !== dayAt) {
      const iZ = lastClosed(zc, day, step);
      zones = iZ >= 199 ? computeSupportZones(zc.slice(Math.max(0, iZ - ZONE_BARS + 1), iZ + 1)) : [];
      dayAt = day;
    }
    for (const z of zones) {
      const key = `${z.bottom.toFixed(8)}`;
      if ((last.get(key) ?? -Infinity) > t - D1) continue;
      const support = p.low > z.top && c.low <= z.top;
      const resist = p.high < z.bottom && c.high >= z.bottom;
      if (!support && !resist) continue;
      last.set(key, t);
      let res: "HELD" | "BROKE" | "NONE" = "NONE";
      for (let k = i + 1; k < h1.length && h1[k]!.time < t + 72 * H1; k++) {
        const x = h1[k]!;
        if (support ? x.close < z.bottom * 0.99 : x.close > z.top * 1.01) { res = "BROKE"; break; }
        if (support ? x.high >= z.top * 1.05 : x.low <= z.bottom * 0.95) { res = "HELD"; break; }
      }
      out.push({ variant: v, symbol, time_utc: new Date(t).toISOString(), half: half(t, from, now), side: support ? "support" : "resistance", zone_bottom: z.bottom, zone_top: z.top, zone_width_pct: pct(z.top, z.bottom), zone_pivots: z.count, result: res, short_bingx: coin.bingxDays < 200 ? 1 : 0 });
    }
  }
  return out;
}

// ─── Summary helpers ─────────────────────────────────────────────────────────
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const f2 = (x: number | null) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);
function stats(rs: Row[]): string {
  const done = rs.filter((r) => r.out72 !== "OPEN");
  const share = (k: string) => (done.length ? Math.round((100 * done.filter((r) => r.out72 === k).length) / done.length) : 0);
  const col = (k: string) => rs.map((r) => r[k]).filter((x): x is number => typeof x === "number");
  const trk = col("x_s8_trk"), be = col("x_s8_be5trk"), st = col("x_struct_trk");
  const range = (xs: number[]) => (xs.length ? `${f2(Math.min(...xs))} … ${f2(Math.max(...xs))}` : "—");
  return `${rs.length} сигналов: GOOD ${share("GOOD")}%, STOP ${share("STOP")}% (72ч) · сделка −8%/трекер: среднее ${f2(mean(trk))}, сумма ${f2(trk.reduce((a, b) => a + b, 0))}, разброс ${range(trk)} · −8%/Б.У.+5: ${f2(mean(be))} · стоп под зоной/трекер: ${f2(mean(st))}`;
}
function block(name: string, rs: Row[]): string {
  const lines = [`  ${name}: ${stats(rs)}`];
  for (const h of [1, 2]) lines.push(`    половина ${h}: ${stats(rs.filter((r) => r.half === h))}`);
  const short = rs.filter((r) => r.short_bingx === 1);
  if (short.length) lines.push(`    монеты с историей BingX < 200 дней: ${stats(short)}`);
  return lines.join("\n");
}
function truthBlock(rs: Row[]): string {
  const line = (xs: Row[]) => {
    const done = xs.filter((r) => r.result !== "NONE");
    const held = done.filter((r) => r.result === "HELD").length;
    return `${xs.length} касаний, итог за 72ч у ${done.length}: удержались ${done.length ? Math.round((100 * held) / done.length) : 0}%, пробиты ${done.length ? Math.round((100 * (done.length - held)) / done.length) : 0}%`;
  };
  return ["support", "resistance"].map((s) => `  истинность (${s === "support" ? "поддержка" : "сопротивление"}): ${line(rs.filter((r) => r.side === s))}` +
    `\n    половина 1: ${line(rs.filter((r) => r.side === s && r.half === 1))}\n    половина 2: ${line(rs.filter((r) => r.side === s && r.half === 2))}`).join("\n");
}

type Live = { symbol: string; key: string; at: number; pnl: number | null; status: string };
function readLiveCsv(file: string | undefined): Live[] {
  if (!file || !existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift()!.split(",");
  const c = (n: string) => head.indexOf(n);
  return lines.map((l) => l.split(",")).map((v) => ({ symbol: v[c("symbol")] ?? "", key: v[c("sentiment_key")] ?? "", at: Date.parse(v[c("detected_at")] ?? ""), pnl: v[c("pnl_percent")] ? Number(v[c("pnl_percent")]) : null, status: v[c("status")] ?? "" }))
    .filter((x) => x.symbol && Number.isFinite(x.at) && /neon|stealth/i.test(x.key));
}

async function main() {
  const now = Math.floor(Date.now() / M15) * M15;
  const from = now - DAYS * D1;
  ensureDir(OUT);
  ensureDir(CACHE);
  const symbols = ONLY ?? (await usdtSymbols(CACHE)).slice(0, LIMIT);
  const B: Record<string, Row[]> = {}, S: Record<string, Row[]> = {}, T: Record<string, Row[]> = {};
  for (const v of VARIANTS) { B[v] = []; S[v] = []; T[v] = []; }
  const errors: Record<string, string> = {};
  let done = 0, shortCoins = 0;
  for (const s of symbols) {
    try {
      const h4 = await klines(CACHE, s, "4h", from - H4_BACK * H4, now);
      const h1 = await klines(CACHE, s, "1h", from - H1_BACK * H1, now);
      const m15 = await klines(CACHE, s, "15m", from - 8 * M15, now);
      if (h4.length < 100 || h1.length < 200 || m15.length < 100) { errors[s] = "short_history"; continue; }
      const d1 = await klines(CACHE, s, "1d", from - D1_BACK * D1, now).catch(() => [] as C[]);
      const bin = VARIANTS.includes("Z1L") ? await binanceSpot1d(s, from - D1_BACK * D1, now) : [];
      // Lucy's VSA on the touch needs 120 4H bars before it: aggregated volume from 25 days before the period.
      const fut = await cgHistory(CACHE, s, "aggfut", from - 25 * D1, now);
      const spot = await cgHistory(CACHE, s, "aggspot", from - 25 * D1, now).catch(() => null);
      const aggF4 = agg4h(fut), aggS4 = agg4h(spot);
      const aggFS4 = new Map(aggS4);
      const bingxDays = d1.length;
      if (bingxDays < 200) shortCoins++;
      for (const v of VARIANTS) {
        const zc = v === "Z4" ? h4 : v === "Z1B" ? d1 : longDaily(d1, bin);
        const coin: Coin = { h4, h1, m15, zc, aggF4, aggFS4, bingxDays };
        B[v]!.push(...bounces(v, s, coin, from, now));
        S[v]!.push(...stealth(v, s, coin, from, now));
        T[v]!.push(...truth(v, s, coin, from, now));
      }
    } catch (e) {
      errors[s] = String(e).slice(0, 160);
    }
    if (++done % 25 === 0) console.error(`${done}/${symbols.length} · ` + VARIANTS.map((v) => `${v} B${B[v]!.length} S${S[v]!.length}`).join(", "));
  }
  // The live signals by name: which variant would have had a signal within ±4 h of it.
  const live = readLiveCsv(LIVE);
  const near = (rows: Row[], l: Live) => rows.find((r) => r.symbol === l.symbol && Math.abs(Number(r.entry_time_ms) - l.at) <= 4 * H1);
  const liveRows: Row[] = live.map((l) => {
    const r: Row = { symbol: l.symbol, key: l.key, detected_at: new Date(l.at).toISOString(), status: l.status, pnl_pct: l.pnl };
    for (const v of VARIANTS) r[`${v}_signal`] = near([...B[v]!, ...S[v]!], l) ? 1 : 0;
    return r;
  });
  for (const v of VARIANTS) {
    writeCsv(join(OUT, `bounce_${v}.csv`), B[v]!);
    writeCsv(join(OUT, `stealth_${v}.csv`), S[v]!);
    writeCsv(join(OUT, `truth_${v}.csv`), T[v]!);
  }
  if (liveRows.length) writeCsv(join(OUT, "live_compare.csv"), liveRows);
  const text = [
    `ABNeon: зоны 4H против 1D · ${new Date(from).toISOString()} .. ${new Date(now).toISOString()} · монет ${symbols.length}, ошибок ${Object.keys(errors).length}, с историей BingX < 200 дней: ${shortCoins}`,
    ...VARIANTS.map((v) => [
      `== ${v} (${v === "Z4" ? "как сейчас: BingX 4H" : v === "Z1B" ? "BingX 1D" : "1D: Binance до листинга на BingX + BingX"})`,
      block("отскок (все)", B[v]!),
      block("отскок (прошёл объём Люси)", B[v]!.filter((r) => r.gate_ok === 1)),
      block("Stealth", S[v]!),
      truthBlock(T[v]!),
    ].join("\n")),
    liveRows.length ? `живые сигналы КАБ (${liveRows.length}): ` + VARIANTS.map((v) => `${v} нашёл ${liveRows.filter((r) => r[`${v}_signal`] === 1).length}`).join(", ") : "живые сигналы: файл не задан",
  ].join("\n\n");
  writeFileSync(join(OUT, "summary.txt"), text);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 1));
  console.log(text);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
