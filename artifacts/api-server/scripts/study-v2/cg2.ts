/**
 * Breakout study helpers (owner 2026-11-06): CoinGlass history the breakout needs on top of volume —
 * aggregated open interest, aggregated liquidations (longs / shorts), Binance global long/short accounts —
 * 1H, disk-cached, slow pacing (shared key with the live bot); OI / liquidation / ratio readings around
 * a breakout; Auto Range readings for an UP move (range top, upside breaks, failed breaks).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCgAlias } from "../../src/lib/cg-symbol-alias.js";
import { type C, type Row, H1, D1, OFFLINE, pct, sleep } from "./lib.js";
import { rangeAt } from "./cg.js";

const CG = "https://open-api-v4.coinglass.com";
const FUT_LIST =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
const RPM = Number(process.env.STUDY_CG_RPM ?? 40);
let lastReq = 0;
export const cg2Stats = { requests: 0, ok: 0, empty: 0, errors: 0, r429: 0 };

async function get(path: string, params: Record<string, string>): Promise<any[] | null> {
  const key = process.env.CoinGlassAPI?.trim();
  if (!key || OFFLINE) return null;
  const url = new URL(CG + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastReq + 60_000 / RPM - Date.now();
    if (wait > 0) await sleep(wait);
    lastReq = Date.now();
    cg2Stats.requests++;
    try {
      const res = await fetch(url, { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429) { cg2Stats.r429++; await sleep(60_000); continue; }
      if (!res.ok) { cg2Stats.errors++; return null; }
      const body = (await res.json()) as { code?: string; data?: any[] };
      if (String(body.code) !== "0") { cg2Stats.empty++; return []; }
      if (!body.data?.length) { cg2Stats.empty++; return []; }
      cg2Stats.ok++;
      return body.data;
    } catch {
      cg2Stats.errors++;
      await sleep(3_000);
    }
  }
  return null;
}

/** A 1H series of numeric fields by time (raw CoinGlass field names kept). */
export type NSeries = Map<number, Record<string, number>>;
export type Kind = "oi" | "liq" | "ls";

export async function cgSeries(cacheDir: string, symbol: string, kind: Kind, start: number, now: number): Promise<NSeries | null> {
  const file = join(cacheDir, `${symbol}_cg2_${kind}.json`);
  const maxAge = Number(process.env.STUDY_CG_MAXAGE_H ?? 6) * H1;
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { from: number; to: number; items: Array<Record<string, number>> | null };
      if (c.from <= start && (OFFLINE || now - c.to < maxAge)) return c.items ? new Map(c.items.map((x) => [x.time!, x])) : null;
    } catch { /* refetch */ }
  }
  if (OFFLINE) return null;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const limit = String(Math.min(4500, Math.ceil((now - start) / H1) + 4));
  const common = { interval: "1h", start_time: String(start), end_time: String(now), limit };
  const rows =
    kind === "oi" ? await get("/api/futures/open-interest/aggregated-history", { ...common, symbol: base })
    : kind === "liq" ? await get("/api/futures/liquidation/aggregated-history", { ...common, symbol: base, exchange_list: FUT_LIST })
    : await get("/api/futures/global-long-short-account-ratio/history", { ...common, exchange: "Binance", symbol: `${base}USDT` });
  if (rows === null) return null; // network: not cached, a later run retries
  const items = rows.map((r) => {
    const o: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) { const n = Number(v); if (Number.isFinite(n)) o[k] = n; }
    if (o.time != null && o.time < 1e12) o.time *= 1000;
    return o;
  }).filter((o) => Number.isFinite(o.time));
  writeFileSync(file, JSON.stringify({ from: start, to: now, items }));
  return new Map(items.map((x) => [x.time!, x]));
}

/** Value of `field` on the last 1H bar that closed at or before t. */
function at(s: NSeries | null, field: string, t: number): number | null {
  if (!s) return null;
  for (let k = Math.floor(t / H1) * H1 - H1, n = 0; n < 6; k -= H1, n++) { const x = s.get(k)?.[field]; if (x != null) return x; }
  return null;
}
function sum(s: NSeries | null, field: string, from: number, to: number): number | null {
  if (!s) return null;
  let v = 0, n = 0;
  for (let k = Math.floor(from / H1) * H1; k < to; k += H1) { const x = s.get(k)?.[field]; if (x != null) { v += x; n++; } }
  return n ? v : null;
}
const firstField = (s: NSeries | null, re: RegExp): string | null => {
  if (!s) return null;
  for (const x of s.values()) { const k = Object.keys(x).find((f) => re.test(f)); if (k) return k; }
  return null;
};

/**
 * Open interest, liquidations, long/short accounts around a breakout. boStart = open of the breakout
 * candle, t = its close (entry). post_* = after the entry (management only, never a filter).
 */
export function derivReadings(oi: NSeries | null, liq: NSeries | null, ls: NSeries | null, boStart: number, t: number, priceAt: (time: number) => number | null): Row {
  const oiF = "close";
  const oiAt = (time: number) => at(oi, oiF, time);
  const oiNow = oiAt(t);
  const ch = (a: number | null, b: number | null) => pct(a, b);
  const pNow = priceAt(t), pBo = priceAt(boStart), p24 = priceAt(boStart - D1);
  const longF = firstField(liq, /long/i), shortF = firstField(liq, /short/i);
  const sl = (f: string | null, a: number, b: number) => (f ? sum(liq, f, a, b) : null);
  const shortBo = sl(shortF, boStart, t), short24 = sl(shortF, boStart - D1, boStart), short7d = sl(shortF, t - 7 * D1, boStart);
  const longBo = sl(longF, boStart, t), long24 = sl(longF, boStart - D1, boStart), long7d = sl(longF, t - 7 * D1, boStart);
  const hours = (t - boStart) / H1;
  const hours7 = (boStart - (t - 7 * D1)) / H1; // the 7-day window before the breakout candle
  const lsF = firstField(ls, /long_short_ratio|ratio/i), lpF = firstField(ls, /long_percent|long_account/i);
  return {
    oi_usd: oiNow,
    oi_ch_bo_pct: ch(oiNow, oiAt(boStart)),
    oi_ch_4h_before_pct: ch(oiAt(boStart), oiAt(boStart - 4 * H1)),
    oi_ch_24h_before_pct: ch(oiAt(boStart), oiAt(boStart - D1)),
    oi_ch_72h_before_pct: ch(oiAt(boStart), oiAt(boStart - 3 * D1)),
    // OI growing with price on the breakout = new longs; OI falling = shorts closing (squeeze).
    oi_vs_price_bo: (() => { const a = ch(oiNow, oiAt(boStart)), b = ch(pNow, pBo); return a != null && b != null && b !== 0 ? a / b : null; })(),
    price_ch_24h_before_pct: ch(pBo, p24),
    liq_short_bo_usd: shortBo,
    liq_short_bo_vs_7d_hourly: shortBo != null && short7d && hours > 0 && hours7 > 0 ? shortBo / hours / (short7d / hours7) : null,
    liq_short_24h_before_usd: short24,
    liq_long_bo_usd: longBo,
    liq_long_24h_before_usd: long24,
    liq_long_24h_vs_7d: long24 != null && long7d && hours7 > 0 ? long24 / (long7d / (hours7 / 24)) : null,
    ls_ratio: lsF ? at(ls, lsF, t) : null,
    ls_long_pct: lpF ? at(ls, lpF, t) : null,
    ls_ratio_ch_24h: lsF ? ch(at(ls, lsF, t), at(ls, lsF, t - D1)) : null,
    post_oi_ch_4h_pct: ch(oiAt(t + 4 * H1), oiNow),
    post_oi_ch_24h_pct: ch(oiAt(t + D1), oiNow),
  };
}

/** Auto Range readings for an UP move: range top vs the broken level, upside breaks, failed breaks. */
export function rangeUpReadings(tf: "15m" | "1h" | "4h" | "1d", cs: C[], t: number, levelBottom: number, levelTop: number, recentMs: number, bars: number): Row {
  const p = `rng${tf}`;
  const { res, lastClose } = rangeAt(tf, cs, t, bars);
  if (!res || res.status !== "ready" || lastClose == null) return { [`${p}_state`]: "none" };
  const active = res.activeConfirmedRange;
  const up = res.latestUpsideBreakout ?? null, down = res.latestDownsideBreakout ?? null;
  const r = active ?? (up && down ? (up.breakoutCloseTime >= down.breakoutCloseTime ? up : down) : (up ?? down));
  const near = (x: number) => x >= levelBottom * 0.99 && x <= levelTop * 1.01;
  const devs = (res.deviations ?? []).filter((d) => d.reentryCloseTime <= t);
  const devUp = devs.filter((d) => d.direction === "up"), devDown = devs.filter((d) => d.direction === "down");
  const lastUp = devUp.at(-1) ?? null, lastDown = devDown.at(-1) ?? null;
  return {
    [`${p}_state`]: active ? "active" : r ? (r === up ? "broken_up" : "broken_down") : "none",
    [`${p}_pos`]: r ? (lastClose < r.lower ? "below" : lastClose > r.upper ? "above" : "inside") : null,
    [`${p}_height_pct`]: r ? pct(r.upper, r.lower) : null,
    [`${p}_dist_to_upper_pct`]: r ? pct(lastClose, r.upper) : null,
    [`${p}_upper_on_level`]: r ? (near(r.upper) ? 1 : 0) : null,
    [`${p}_up_break_recent`]: up && t - up.breakoutCloseTime <= recentMs && up.breakoutCloseTime <= t ? 1 : 0,
    [`${p}_up_break_hours_ago`]: up && up.breakoutCloseTime <= t ? (t - up.breakoutCloseTime) / H1 : null,
    [`${p}_up_break_on_level`]: up ? (near(up.upper) ? 1 : 0) : null,
    // A failed upside break (closed above, came back) = the level already rejected price.
    [`${p}_dev_up_recent`]: devUp.filter((d) => t - d.reentryCloseTime <= recentMs).length,
    [`${p}_dev_up_hours_ago`]: lastUp ? (t - lastUp.reentryCloseTime) / H1 : null,
    // A downside deviation shortly before (spring) = sellers trapped under the range.
    [`${p}_dev_down_recent`]: devDown.filter((d) => t - d.reentryCloseTime <= recentMs).length,
    [`${p}_dev_down_hours_ago`]: lastDown ? (t - lastDown.reentryCloseTime) / H1 : null,
  };
}
