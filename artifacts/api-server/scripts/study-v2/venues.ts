/**
 * Level candles from other venues (owner 2026-11-06), shared by the levels and breakout studies:
 * BingX SPOT 4H (public API) and Binance spot / futures 4H through CoinGlass price history. Disk-cached.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyCgAlias } from "../../src/lib/cg-symbol-alias.js";
import { type C, H1, H4, OFFLINE, sleep } from "./lib.js";

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
export async function bingxSpot4h(CACHE: string, symbol: string, start: number, now: number): Promise<C[]> {
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
export async function cgPrice(CACHE: string, market: "spot" | "futures", symbol: string, start: number, now: number): Promise<C[]> {
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

