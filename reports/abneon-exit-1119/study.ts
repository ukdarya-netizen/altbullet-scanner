import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cgTimedFetch } from "../../artifacts/api-server/src/lib/cg_latency.js";
import { getNextCgKey } from "../../artifacts/api-server/src/lib/coinglass_keys.js";
import {
  getAllFuturesExchanges,
  getAllSpotExchanges,
} from "../../artifacts/api-server/src/lib/coinglass-exchanges.js";
import { applyCgAlias } from "../../artifacts/api-server/src/lib/cg-symbol-alias.js";
import { LUCY_LONG_BARS, lucyColour } from "../../artifacts/api-server/src/lib/abneon-volume-gate.js";
import { klines } from "../../artifacts/api-server/scripts/study-v2/lib.js";

type Obj = Record<string, any>;
type PriceBar = { time: number; open: number; high: number; low: number; close: number };
type FlowBar = { time: number; buy: number | null; sell: number | null; cvd?: number | null };
type OiBar = { time: number; value: number | null };
type Kind = "fut15" | "spot15" | "oi15" | "fut1h" | "spot1h";
type Range = { start: number; end: number };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, "reports/.cache");
const RATE_FILE = join(CACHE, ".abneon-exit-rate.json");
const SOURCE_EVENTS = join(ROOT, "reports/abneon-hist-1119/events.csv");
const SOURCE_PATHS = join(ROOT, "reports/abneon-hist-1119/events.csv");
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const EXIT_HORIZON = 72 * H1;
const GOOD_HORIZON = 96 * H1;
const RPM = 15;
const MIN_GAP_MS = 4_100;
const ENDPOINTS: Record<Kind, string> = {
  fut15: "/api/futures/aggregated-taker-buy-sell-volume/history",
  spot15: "/api/spot/aggregated-cvd/history",
  oi15: "/api/futures/open-interest/aggregated-history",
  fut1h: "/api/futures/aggregated-taker-buy-sell-volume/history",
  spot1h: "/api/spot/aggregated-cvd/history",
};

process.env.NODE_ENV = "production";
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const runLog: string[] = [];
const errors: Obj[] = [];
const rateState = readJson(RATE_FILE) ?? {};
const requestCounts: Record<string, number> = { ...(rateState.counts ?? {}) };
let requestsSent = Number(rateState.requestsSent ?? 0);
let rangesDone = 0;
let rangesPlanned = 0;
let api429 = Number(rateState.api429 ?? 0);
let pauses429 = Number(rateState.pauses429 ?? 0);
let recentRequests = (() => {
  return Array.isArray(rateState.times) ? rateState.times.map(Number).filter(Number.isFinite) : [];
})();
let lastRequestAt = recentRequests.at(-1) ?? 0;
let startedAt = Date.now();

const log = (message: string) => {
  const line = `${new Date().toISOString()} ${message}`;
  runLog.push(line);
  console.log(line);
};

function parseCsv(text: string): Obj[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"' && quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(value);
        value = "";
      } else {
        value += ch;
      }
    }
    out.push(value);
    return out;
  };
  const headers = cells(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = cells(line);
    return Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ""]));
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(path: string, rows: Obj[], fallbackColumns: string[] = []): void {
  const columns = [...new Set(
    rows.length
      ? rows.flatMap((row) => Object.keys(row))
      : fallbackColumns,
  )];
  const text = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
  ].join("\n");
  writeFileSync(path, `${text}\n`);
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || !value) return null;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: number | null | undefined): string {
  return value == null ? "" : new Date(value).toISOString();
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value: number | null, digits = 6): number | "" {
  return value == null || !Number.isFinite(value) ? "" : Number(value.toFixed(digits));
}

function pctChange(current: number | null, prior: number | null): number | null {
  return current == null || prior == null || prior === 0 ? null : (current / prior - 1) * 100;
}

function readJson(path: string): Obj | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Obj : null;
  } catch {
    return null;
  }
}

function rowTime(row: Obj): number {
  return timeMs(row.time) ?? 0;
}

function parseEvents(): Obj[] {
  if (!existsSync(join(OUT, "events.csv"))) throw new Error("Missing production events.csv");
  const rows = parseCsv(readFileSync(join(OUT, "events.csv"), "utf8"));
  if (!rows.length) throw new Error("Production events.csv is empty");
  return rows.map((row) => {
    const entryAt = timeMs(row.detected_at);
    const entryPrice = numberOrNull(row.entry_price);
    if (entryAt == null || entryPrice == null || entryPrice <= 0) {
      throw new Error(`Invalid event id=${row.id}: entry time or price is missing`);
    }
    return {
      ...row,
      id: String(row.id),
      signal_id: numberOrNull(row.signal_id),
      entryAt,
      closeAt: timeMs(row.closed_at),
      entryPrice,
      exitPrice: numberOrNull(row.exit_price),
      zoneTop: numberOrNull(row.zone_top),
      zoneBottom: numberOrNull(row.zone_bottom),
    };
  });
}

function readGoodIds(): Set<string> {
  const source = parseCsv(readFileSync(SOURCE_PATHS, "utf8"));
  return new Set(source.filter((row) => row.outcome === "good").map((row) => String(row.id)));
}

function cacheFile(symbol: string, kind: Kind): string {
  if (kind === "fut15") return join(CACHE, `${symbol}_cg15m_aggfut.json`);
  if (kind === "spot15") return join(CACHE, `${symbol}_cg15m_aggspot.json`);
  if (kind === "oi15") return join(CACHE, `${symbol}_cg15m_oi.json`);
  if (kind === "fut1h") return join(CACHE, `${symbol}_cg_aggfut.json`);
  return join(CACHE, `${symbol}_cg_aggspot.json`);
}

function intervalFor(kind: Kind): number {
  return kind === "fut1h" || kind === "spot1h" ? H1 : M15;
}

function normalize(kind: Kind, row: Obj): any[] {
  const time = timeMs(row.time);
  if (time == null) return [];
  if (kind === "fut15" || kind === "fut1h") {
    return [{
      time,
      buy: numberOrNull(row.aggregated_buy_volume_usd),
      sell: numberOrNull(row.aggregated_sell_volume_usd),
    }];
  }
  if (kind === "spot15" || kind === "spot1h") {
    return [{
      time,
      buy: numberOrNull(row.agg_taker_buy_vol),
      sell: numberOrNull(row.agg_taker_sell_vol),
      cvd: numberOrNull(row.cum_vol_delta),
    }];
  }
  return [{ time, value: numberOrNull(row.close) }];
}

function cacheItems(cache: Obj | null): any[] {
  return Array.isArray(cache?.items) ? cache.items.filter((row: Obj) => rowTime(row) > 0) : [];
}

function missingRanges(existing: any[], start: number, end: number, step: number): Range[] {
  const rows = [...existing].sort((a, b) => rowTime(a) - rowTime(b));
  const first = rows.length ? rowTime(rows[0]!) : null;
  const last = rows.length ? rowTime(rows.at(-1)!) : null;
  if (first == null || last == null) return [{ start, end }];
  const gaps: Range[] = [];
  if (first > start + step) gaps.push({ start, end: first });
  if (last + step < end) gaps.push({ start: last + step, end });
  return gaps;
}

function buildUrl(kind: Kind, symbol: string, start: number, end: number): string {
  const step = intervalFor(kind);
  const from = Math.floor(start / step) * step;
  const to = Math.ceil(end / step) * step;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL(`https://open-api-v4.coinglass.com${ENDPOINTS[kind]}`);
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", step === H1 ? "1h" : "15m");
  url.searchParams.set("start_time", String(from));
  url.searchParams.set("end_time", String(to));
  url.searchParams.set("limit", String(Math.min(4500, Math.ceil((to - from) / step) + 4)));
  if (kind === "fut15" || kind === "fut1h") {
    url.searchParams.set("exchange_list", getAllFuturesExchanges());
  } else if (kind === "spot15" || kind === "spot1h") {
    url.searchParams.set("exchange_list", getAllSpotExchanges());
  }
  return url.toString();
}

function progressLine(): void {
  const remaining = Math.max(0, rangesPlanned - rangesDone);
  const elapsed = Math.max(1, Date.now() - startedAt);
  const avgMs = requestsSent ? elapsed / requestsSent : MIN_GAP_MS;
  const etaMs = remaining * Math.max(avgMs, MIN_GAP_MS);
  const etaDubai = new Date(Date.now() + etaMs).toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour12: false,
  });
  log(`CG progress: ${requestsSent} requests made / ${remaining} ranges remaining / ETA ${etaDubai} Dubai`);
}

async function waitForCgAdmission(): Promise<void> {
  while (true) {
    const now = Date.now();
    recentRequests = recentRequests.filter((time) => time > now - 60_000);
    const gapWait = Math.max(0, lastRequestAt + MIN_GAP_MS - now);
    const windowWait = recentRequests.length >= RPM
      ? Math.max(0, recentRequests[0]! + 60_000 - now)
      : 0;
    const wait = Math.max(gapWait, windowWait);
    if (wait <= 0) break;
    await sleep(wait);
  }
  const admittedAt = Date.now();
  recentRequests.push(admittedAt);
  lastRequestAt = admittedAt;
  persistRateState();
}

function persistRateState(): void {
  writeFileSync(RATE_FILE, JSON.stringify({
    times: recentRequests,
    requestsSent,
    counts: requestCounts,
    api429,
    pauses429,
  }));
}

async function fetchRange(
  symbol: string,
  kind: Kind,
  range: Range,
): Promise<{ items: any[]; reason?: string }> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const key = getNextCgKey();
    if (!key) return { items: [], reason: "coinglass_key_unavailable" };
    await waitForCgAdmission();
    requestsSent++;
    requestCounts[kind] = (requestCounts[kind] ?? 0) + 1;
    persistRateState();
    if (requestsSent % 50 === 0) progressLine();
    try {
      const response = await cgTimedFetch(
        buildUrl(kind, symbol, range.start, range.end),
        {
          headers: { "CG-API-KEY": key, Accept: "application/json" },
          signal: AbortSignal.timeout(25_000),
        },
        { priority: "low", endpoint: ENDPOINTS[kind].replace(/^\/api\//, "") },
      );
      if (response.status === 429) {
        api429++;
        pauses429++;
        log(`CoinGlass HTTP 429 ${kind} ${symbol}; pausing 5 minutes, retry ${attempt}/5`);
        await sleep(300_000);
        continue;
      }
      if (!response.ok) return { items: [], reason: `http_${response.status}` };
      const body = (await response.json()) as { code?: unknown; msg?: unknown; data?: Obj[] };
      if (String(body.code) === "429") {
        api429++;
        pauses429++;
        log(`CoinGlass code 429 ${kind} ${symbol}; pausing 5 minutes, retry ${attempt}/5`);
        await sleep(300_000);
        continue;
      }
      if (String(body.code) !== "0") {
        return { items: [], reason: `api_code_${String(body.code)}:${String(body.msg ?? "").slice(0, 120)}` };
      }
      const items = Array.isArray(body.data) ? body.data.flatMap((row) => normalize(kind, row)) : [];
      log(`CoinGlass range loaded ${kind} ${symbol}: ${items.length} rows`);
      return items.length ? { items } : { items: [], reason: "no_data" };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "request_error";
      if (attempt === 5) return { items: [], reason };
      await sleep(2_000);
    }
  }
  return { items: [], reason: "retry_limit" };
}

function symbolRanges(events: Obj[], goodIds: Set<string>, now: number) {
  const grouped = new Map<string, Obj[]>();
  for (const event of events) {
    const list = grouped.get(event.symbol) ?? [];
    list.push(event);
    grouped.set(event.symbol, list);
  }
  const ranges = new Map<string, Obj>();
  for (const [symbol, rows] of grouped) {
    const firstEntry = Math.min(...rows.map((row) => row.entryAt));
    const firstClose = Math.min(...rows.filter((row) => row.closeAt != null).map((row) => row.closeAt as number));
    const firstAnchor = Number.isFinite(firstClose) ? Math.min(firstEntry, firstClose) : firstEntry;
    const requiredEnds = rows.flatMap((row) => [
      row.entryAt,
      row.closeAt == null ? null : Math.min(row.closeAt + EXIT_HORIZON, now),
      goodIds.has(row.id) ? Math.min(row.entryAt + GOOD_HORIZON, now) : null,
    ]).filter((x): x is number => x != null);
    ranges.set(symbol, {
      events: rows,
      start15: Math.floor((firstAnchor - 30 * H1) / M15) * M15,
      start1h: Math.floor((firstAnchor - 120 * H4) / H4) * H4,
      priceStart: Math.floor((firstEntry - D1) / M15) * M15,
      end: Math.min(now, Math.max(...requiredEnds, firstEntry)),
    });
  }
  return { grouped, ranges };
}

async function loadCoinGlass(
  grouped: Map<string, Obj[]>,
  ranges: Map<string, Obj>,
): Promise<Map<string, Map<Kind, any[]>>> {
  const kinds: Kind[] = ["fut15", "spot15", "oi15", "fut1h", "spot1h"];
  const cacheState = new Map<string, { items: any[]; from: number; to: number; changed: boolean }>();
  const work: Array<{ symbol: string; kind: Kind; range: Range }> = [];
  for (const symbol of [...grouped.keys()].sort()) {
    const range = ranges.get(symbol)!;
    for (const kind of kinds) {
      const path = cacheFile(symbol, kind);
      const old = readJson(path);
      const items = cacheItems(old);
      cacheState.set(`${symbol}:${kind}`, {
        items,
        from: timeMs(old?.from) ?? (kind.endsWith("1h") ? range.start1h : range.start15),
        to: timeMs(old?.to) ?? range.end,
        changed: false,
      });
      const start = kind.endsWith("1h") ? range.start1h : range.start15;
      for (const missing of missingRanges(items, start, range.end, intervalFor(kind))) {
        work.push({ symbol, kind, range: missing });
      }
    }
  }
  rangesPlanned = work.length;
  startedAt = Date.now();
  log(`Exit A: production closed cohort=${[...grouped.values()].reduce((n, x) => n + x.length, 0)} rows; symbols=${grouped.size}; missing CG ranges=${work.length}; max=${RPM}/min`);
  if (work.length && !getNextCgKey()) throw new Error("CoinGlass credential unavailable; no request was sent");
  for (const [index, item] of work.entries()) {
    const result = await fetchRange(item.symbol, item.kind, item.range);
    const key = `${item.symbol}:${item.kind}`;
    const state = cacheState.get(key)!;
    for (const row of result.items) state.items.push(row);
    state.items = [...new Map(state.items.map((row) => [rowTime(row), row])).values()]
      .sort((a, b) => rowTime(a) - rowTime(b));
    state.from = Math.min(state.from, item.range.start);
    state.to = Math.max(state.to, item.range.end);
    state.changed = true;
    rangesDone++;
    if (result.reason) {
      errors.push({ symbol: item.symbol, kind: item.kind, from: iso(item.range.start), to: iso(item.range.end), reason: result.reason });
      log(`CoinGlass range unavailable ${item.kind} ${item.symbol}: ${result.reason}`);
    }
    if (state.changed) {
      writeFileSync(cacheFile(item.symbol, item.kind), JSON.stringify({
        from: state.from,
        to: state.to,
        items: state.items,
        ...(result.reason ? { reason: result.reason } : {}),
      }));
    }
    if ((index + 1) % 25 === 0) log(`CG ranges stored ${index + 1}/${work.length}`);
  }
  const bySymbol = new Map<string, Map<Kind, any[]>>();
  for (const symbol of grouped.keys()) {
    const map = new Map<Kind, any[]>();
    for (const kind of kinds) map.set(kind, cacheState.get(`${symbol}:${kind}`)?.items ?? []);
    bySymbol.set(symbol, map);
  }
  return bySymbol;
}

function mapByTime<T extends { time: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((row) => [row.time, row]));
}

function flowWindow(map: Map<number, FlowBar>, time: number, windowMs: number) {
  let buy = 0;
  let sell = 0;
  let count = 0;
  for (let t = time - windowMs + M15; t <= time; t += M15) {
    const row = map.get(t);
    if (row?.buy == null || row.sell == null) continue;
    buy += row.buy;
    sell += row.sell;
    count++;
  }
  return count === windowMs / M15 ? { buy, sell } : { buy: null, sell: null };
}

function bucket1hVolumes(fut: Map<number, FlowBar>, spot: Map<number, FlowBar>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [time, row] of fut) {
    if (row.buy == null || row.sell == null) continue;
    const s = spot.get(time);
    out.set(time, row.buy + row.sell + (s?.buy ?? 0) + (s?.sell ?? 0));
  }
  return out;
}

function bucket4hVolumes(oneHour: Map<number, number>): Map<number, number> {
  const times = [...oneHour.keys()].sort((a, b) => a - b);
  const out = new Map<number, number>();
  if (!times.length) return out;
  const first = Math.ceil(times[0]! / H4) * H4;
  const last = times.at(-1)!;
  for (let open = first; open + H4 <= last + H1; open += H4) {
    let sum = 0;
    let count = 0;
    for (let t = open; t < open + H4; t += H1) {
      const value = oneHour.get(t);
      if (value == null) continue;
      sum += value;
      count++;
    }
    if (count === 4) out.set(open, sum);
  }
  return out;
}

function lucyAt(volume: Map<number, number>, interval: number, time: number): string | null {
  const candle = Math.floor((time - 1) / interval) * interval;
  const values = [...volume.entries()].sort((a, b) => a[0] - b[0]);
  const index = values.findIndex(([open]) => open === candle);
  if (index < LUCY_LONG_BARS - 1) return null;
  return lucyColour(values.slice(0, index + 1).map(([, value]) => value), index);
}

function makeData(series: Map<Kind, any[]>, bars: PriceBar[]): Obj {
  const fut15 = mapByTime(series.get("fut15") as FlowBar[]);
  const spot15 = mapByTime(series.get("spot15") as FlowBar[]);
  const oi15 = mapByTime(series.get("oi15") as OiBar[]);
  const fut1h = mapByTime(series.get("fut1h") as FlowBar[]);
  const spot1h = mapByTime(series.get("spot1h") as FlowBar[]);
  const oneHourVolumes = bucket1hVolumes(fut1h, spot1h);
  return {
    fut15,
    spot15,
    oi15,
    fut1h,
    spot1h,
    lucy1h: oneHourVolumes,
    lucy4h: bucket4hVolumes(oneHourVolumes),
    price: mapByTime(bars),
  };
}

function metricsAt(time: number, data: Obj): Obj {
  const t = Math.floor(time / M15) * M15;
  const price = data.price.get(t) as PriceBar | undefined;
  const fut = data.fut15.get(t) as FlowBar | undefined;
  const spot = data.spot15.get(t) as FlowBar | undefined;
  const oi = data.oi15.get(t) as OiBar | undefined;
  const fut1h = flowWindow(data.fut15, t, H1);
  const spot1h = flowWindow(data.spot15, t, H1);
  const oiAt = (back: number) => (data.oi15.get(t - back) as OiBar | undefined)?.value ?? null;
  const cvd = spot?.cvd ?? null;
  const cvdAt = (back: number) => (data.spot15.get(t - back) as FlowBar | undefined)?.cvd ?? null;
  const totalVolume = fut?.buy == null || fut.sell == null
    ? null
    : fut.buy + fut.sell + (spot?.buy ?? 0) + (spot?.sell ?? 0);
  const avgPrior = (count: number) => {
    if (totalVolume == null) return null;
    let sum = 0;
    for (let i = 1; i <= count; i++) {
      const f = data.fut15.get(t - i * M15) as FlowBar | undefined;
      if (f?.buy == null || f.sell == null) return null;
      const s = data.spot15.get(t - i * M15) as FlowBar | undefined;
      sum += f.buy + f.sell + (s?.buy ?? 0) + (s?.sell ?? 0);
    }
    return sum / count;
  };
  const netBuy = (buy: number | null, sell: number | null) =>
    buy == null || sell == null || buy + sell === 0 ? null : ((buy - sell) / (buy + sell)) * 100;
  return {
    metric_time: iso(time),
    metric_bar_at: iso(t),
    price_open: round(price?.open ?? null),
    price_high: round(price?.high ?? null),
    price_low: round(price?.low ?? null),
    price_close: round(price?.close ?? null),
    oi15m_usd: round(oi?.value ?? null, 2),
    oi_change_15m_pct: round(pctChange(oi?.value ?? null, oiAt(M15))),
    oi_change_1h_pct: round(pctChange(oi?.value ?? null, oiAt(H1))),
    oi_change_4h_pct: round(pctChange(oi?.value ?? null, oiAt(H4))),
    fut_buy_15m_usd: round(fut?.buy ?? null, 2),
    fut_sell_15m_usd: round(fut?.sell ?? null, 2),
    fut_net_buy_15m_pct: round(netBuy(fut?.buy ?? null, fut?.sell ?? null)),
    fut_buy_1h_usd: round(fut1h.buy, 2),
    fut_sell_1h_usd: round(fut1h.sell, 2),
    fut_net_buy_1h_pct: round(netBuy(fut1h.buy, fut1h.sell)),
    spot_buy_15m_usd: round(spot?.buy ?? null, 2),
    spot_sell_15m_usd: round(spot?.sell ?? null, 2),
    spot_cvd_level: round(cvd, 2),
    spot_cvd_change_15m: round(cvd == null || cvdAt(M15) == null ? null : cvd - cvdAt(M15)!, 2),
    spot_cvd_change_1h: round(cvd == null || cvdAt(H1) == null ? null : cvd - cvdAt(H1)!, 2),
    spot_cvd_change_4h: round(cvd == null || cvdAt(H4) == null ? null : cvd - cvdAt(H4)!, 2),
    spot_buy_1h_usd: round(spot1h.buy, 2),
    spot_sell_1h_usd: round(spot1h.sell, 2),
    fut_volume_15m_usd: round(fut?.buy == null || fut.sell == null ? null : fut.buy + fut.sell, 2),
    spot_volume_15m_usd: round(spot?.buy == null || spot.sell == null ? null : spot.buy + spot.sell, 2),
    total_volume_15m_usd: round(totalVolume, 2),
    total_vs_avg20_pct: round(totalVolume == null || avgPrior(20) == null || avgPrior(20) === 0 ? null : totalVolume / avgPrior(20)! * 100),
    total_vs_avg120_pct: round(totalVolume == null || avgPrior(120) == null || avgPrior(120) === 0 ? null : totalVolume / avgPrior(120)! * 100),
    lucy_1h: lucyAt(data.lucy1h, H1, time),
    lucy_4h: lucyAt(data.lucy4h, H4, time),
    data_missing: {
      price: price == null,
      fut15: fut == null,
      spot15: spot == null,
      oi15: oi == null,
    },
  };
}

function prefixed(prefix: string, value: Obj): Obj {
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [`${prefix}_${key}`, val]));
}

function closedBars(bars: PriceBar[], now: number): PriceBar[] {
  return bars.filter((bar) => bar.time + M15 <= now);
}

function reasonGroup(event: Obj): string {
  if (event.status === "cancelled" && event.cancel_reason === "neon_level_lost_4h") return "cancel_4h_below_zone";
  if (event.status === "stop_loss") return "stop_loss";
  if (event.status === "expired") return "expired_4d";
  return String(event.cancel_reason || event.closed_by || event.status || "unknown");
}

function afterClose(
  event: Obj,
  bars: PriceBar[],
  data: Obj,
  now: number,
): Obj {
  const base: Obj = {
    ...event,
    detected_at: iso(event.entryAt),
    closed_at: event.closeAt == null ? "" : iso(event.closeAt),
    era: event.era,
    reason_group: reasonGroup(event),
    classification: "",
  };
  const entryMetrics = metricsAt(event.entryAt, data);
  Object.assign(base, prefixed("entry_calc", entryMetrics));
  if (event.closeAt == null) {
    base.classification = "no_actual_closed_at";
    base.close_metric_bar_at = "";
    return base;
  }
  const closeSampleAt = event.closeAt - M15;
  const closeMetrics = metricsAt(closeSampleAt, data);
  base.close_metric_sample_at = iso(closeSampleAt);
  base.close_metric_bar_at = closeMetrics.metric_bar_at;
  Object.assign(base, prefixed("close_calc", closeMetrics));
  const horizonEnd = Math.min(event.closeAt + EXIT_HORIZON, now);
  const firstBar = Math.ceil(event.closeAt / M15) * M15;
  const post = closedBars(bars, now).filter((bar) => bar.time >= firstBar && bar.time < horizonEnd);
  base.observed_from = iso(firstBar);
  base.observed_until = post.length ? iso(post.at(-1)!.time + M15) : "";
  base.horizon_complete = now >= event.closeAt + EXIT_HORIZON;
  base.post_close_bar_count = post.length;
  base.zone_top = event.zoneTop ?? "";
  base.zone_bottom = event.zoneBottom ?? "";
  if (!post.length) {
    base.classification = "no_post_close_price_bars";
    return base;
  }
  const entry = event.entryPrice as number;
  const exit = event.exitPrice as number | null;
  const highBar = post.reduce((best, bar) => bar.high > best.high ? bar : best, post[0]!);
  const lowBar = post.reduce((best, bar) => bar.low < best.low ? bar : best, post[0]!);
  const targetIndex = post.findIndex((bar) => bar.high >= entry * 1.1);
  const targetBar = targetIndex >= 0 ? post[targetIndex]! : null;
  base.max_high = round(highBar.high, 10);
  base.max_high_at = iso(highBar.time);
  base.min_low = round(lowBar.low, 10);
  base.min_low_at = iso(lowBar.time);
  base.max_from_entry_pct = round((highBar.high / entry - 1) * 100);
  base.min_from_entry_pct = round((lowBar.low / entry - 1) * 100);
  base.max_from_exit_pct = exit == null || exit <= 0 ? "" : round((highBar.high / exit - 1) * 100);
  base.min_from_exit_pct = exit == null || exit <= 0 ? "" : round((lowBar.low / exit - 1) * 100);
  base.plus10_hit = targetIndex >= 0;
  base.plus10_candle_at = targetBar ? iso(targetBar.time) : "";
  base.hours_to_plus10_candle = targetBar ? round((targetBar.time - event.closeAt) / H1, 3) : "";
  base.returned_to_zone = event.zoneTop == null || event.zoneBottom == null
    ? ""
    : post.some((bar) => bar.high >= event.zoneBottom && bar.low <= event.zoneTop);
  base.classification = targetBar
    ? "wrong_exit_plus10_within_observed_window"
    : base.horizon_complete
      ? "right_exit_no_plus10_in_72h"
      : "pending_72h_not_mature";
  if (targetBar) {
    const turnSlice = post.slice(0, targetIndex + 1);
    const turn = turnSlice.reduce((best, bar) => bar.low < best.low ? bar : best, turnSlice[0]!);
    base.turn_candle_at = iso(turn.time);
    base.turn_low = round(turn.low, 10);
    base.turn_low_from_entry_pct = round((turn.low / entry - 1) * 100);
    base.turn_low_from_exit_pct = exit == null || exit <= 0 ? "" : round((turn.low / exit - 1) * 100);
    const points = [
      ["turn_m60", turn.time - 60 * 60_000],
      ["turn_m45", turn.time - 45 * 60_000],
      ["turn_m30", turn.time - 30 * 60_000],
      ["turn_m15", turn.time - 15 * 60_000],
      ["turn", turn.time],
    ] as const;
    for (const [label, sampleAt] of points) {
      Object.assign(base, prefixed(label, metricsAt(sampleAt, data)));
    }
  } else {
    base.turn_candle_at = "";
    base.turn_low = "";
    base.turn_low_from_entry_pct = "";
    base.turn_low_from_exit_pct = "";
  }
  return base;
}

function makeGoodPaths(
  events: Obj[],
  goodIds: Set<string>,
  barsBySymbol: Map<string, PriceBar[]>,
  dataBySymbol: Map<string, Obj>,
  now: number,
): Obj[] {
  const rows: Obj[] = [];
  for (const event of events.filter((item) => goodIds.has(item.id))) {
    const bars = closedBars(barsBySymbol.get(event.symbol) ?? [], now);
    const start = event.entryAt - D1;
    const end = Math.min(event.entryAt + GOOD_HORIZON, now);
    const horizonComplete = now >= event.entryAt + GOOD_HORIZON;
    for (const bar of bars) {
      if (bar.time < start || bar.time >= end) continue;
      rows.push({
        id: event.id,
        symbol: event.symbol,
        detected_at: iso(event.entryAt),
        entry_price: event.entryPrice,
        status: event.status,
        price_bar_at: iso(bar.time),
        relative_high_pct: round((bar.high / event.entryPrice - 1) * 100),
        relative_low_pct: round((bar.low / event.entryPrice - 1) * 100),
        relative_close_pct: round((bar.close / event.entryPrice - 1) * 100),
        horizon_complete: horizonComplete,
        observed_until: iso(Math.min(end, now)),
        ...metricsAt(bar.time, dataBySymbol.get(event.symbol)!),
      });
    }
  }
  return rows;
}

function formatRange(values: Array<{ value: number; id: string; symbol: string }>): string {
  if (!values.length) return "n=0";
  const min = values.reduce((a, b) => a.value <= b.value ? a : b);
  const max = values.reduce((a, b) => a.value >= b.value ? a : b);
  return `n=${values.length}, min=${round(min.value, 6)} (${min.id} ${min.symbol}), max=${round(max.value, 6)} (${max.id} ${max.symbol})`;
}

function buildSummary(
  rows: Obj[],
  goodPathCount: number,
  errors: Obj[],
  now: number,
  goodPathRows: Obj[] = [],
): string {
  const mature = rows.filter((row) => ["wrong_exit_plus10_within_observed_window", "right_exit_no_plus10_in_72h"].includes(row.classification));
  const wrong = mature.filter((row) => row.classification === "wrong_exit_plus10_within_observed_window");
  const right = mature.filter((row) => row.classification === "right_exit_no_plus10_in_72h");
  const counts = Object.fromEntries(
    ["wrong_exit_plus10_within_observed_window", "right_exit_no_plus10_in_72h", "pending_72h_not_mature", "no_actual_closed_at", "no_post_close_price_bars"]
      .map((key) => [key, rows.filter((row) => row.classification === key).length]),
  );
  const groups = [...new Set(rows.map((row) => row.reason_group))].sort();
  const reasonTable = groups.map((group) => {
    const list = rows.filter((row) => row.reason_group === group);
    const wrongRows = list.filter((row) => row.classification === "wrong_exit_plus10_within_observed_window");
    const rightRows = list.filter((row) => row.classification === "right_exit_no_plus10_in_72h");
    const pending = list.filter((row) => row.classification === "pending_72h_not_mature").length;
    const untime = list.filter((row) => row.classification === "no_actual_closed_at").length;
    return `- ${group}: wrong=${wrongRows.length}, right=${rightRows.length}, pending=${pending}, no_closed_at=${untime}; wrong: ${wrongRows.map((r) => `${r.id} ${r.symbol}`).join(", ") || "none"}`;
  });
  const eraTable = ["4H", "1D"].map((era) => {
    const list = rows.filter((row) => row.era === era);
    const w = list.filter((row) => row.classification === "wrong_exit_plus10_within_observed_window");
    const r = list.filter((row) => row.classification === "right_exit_no_plus10_in_72h");
    const p = list.filter((row) => row.classification === "pending_72h_not_mature").length;
    const u = list.filter((row) => row.classification === "no_actual_closed_at").length;
    return `- ${era}: wrong=${w.length}, right=${r.length}, pending=${p}, no_closed_at=${u}; wrong: ${w.map((x) => `${x.id} ${x.symbol}`).join(", ") || "none"}`;
  });
  const metricNames = [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .filter((key) => key.startsWith("entry_calc_") && rows.some((row) => numberOrNull(row[key]) != null))
    .map((key) => key.replace("entry_calc_", ""));
  const compareCohort = (label: string, cohortWrong: Obj[], cohortRight: Obj[]): string[] => {
    const lines = [`### ${label}: wrong=${cohortWrong.length}, right=${cohortRight.length}`];
    if (!cohortWrong.length || !cohortRight.length) {
      lines.push("- No both-outcome comparison is estimable in this subgroup.");
      return lines;
    }
    for (const point of ["entry_calc", "close_calc"]) {
      for (const metric of metricNames) {
        const get = (row: Obj) => numberOrNull(row[`${point}_${metric}`]);
        const wrongVals = cohortWrong.flatMap((row) => {
          const value = get(row);
          return value == null ? [] : [{ value, id: row.id, symbol: row.symbol }];
        });
        const rightVals = cohortRight.flatMap((row) => {
          const value = get(row);
          return value == null ? [] : [{ value, id: row.id, symbol: row.symbol }];
        });
        if (!wrongVals.length || !rightVals.length) {
          lines.push(`- ${point}.${metric}: wrong ${formatRange(wrongVals)}; right ${formatRange(rightVals)}; separator=not estimable.`);
          continue;
        }
        const wMin = Math.min(...wrongVals.map((v) => v.value));
        const wMax = Math.max(...wrongVals.map((v) => v.value));
        const rMin = Math.min(...rightVals.map((v) => v.value));
        const rMax = Math.max(...rightVals.map((v) => v.value));
        const threshold = wMax < rMin ? (wMax + rMin) / 2 : wMin > rMax ? (wMin + rMax) / 2 : null;
        const wrongValues = wrongVals.map((v) => `${v.id} ${v.symbol}=${round(v.value, 6)}`).join("; ");
        const rightValues = rightVals.map((v) => `${v.id} ${v.symbol}=${round(v.value, 6)}`).join("; ");
        const sep = threshold == null
          ? "no full-range separator"
          : `separator ${wMax < rMin ? "≤" : "≥"} ${round(threshold, 6)}`;
        lines.push(`- ${point}.${metric}: ${sep}; wrong range ${formatRange(wrongVals)} [${wrongValues}]; right range ${formatRange(rightVals)} [${rightValues}].`);
      }
      for (const metric of ["lucy_1h", "lucy_4h"]) {
        const distribution = (cohort: Obj[]) => {
          const values = new Map<string, string[]>();
          for (const row of cohort) {
            const value = String(row[`${point}_${metric}`] ?? "").trim();
            if (!value) continue;
            const names = values.get(value) ?? [];
            names.push(`${row.id} ${row.symbol}`);
            values.set(value, names);
          }
          return [...values.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([value, names]) => `${value}=${names.length} [${names.join(", ")}]`).join("; ") || "no values";
        };
        lines.push(`- ${point}.${metric} categories: wrong ${distribution(cohortWrong)}; right ${distribution(cohortRight)}.`);
      }
    }
    return lines;
  };
  const comparisonSections: string[] = [
    ...compareCohort("All mature exits", wrong, right),
    "",
    "## Entry/close comparisons by exit reason",
    "",
  ];
  for (const group of groups) {
    const list = rows.filter((row) => row.reason_group === group && mature.includes(row));
    const wrongRows = list.filter((row) => row.classification === "wrong_exit_plus10_within_observed_window");
    const rightRows = list.filter((row) => row.classification === "right_exit_no_plus10_in_72h");
    comparisonSections.push(...compareCohort(group, wrongRows, rightRows), "");
  }
  comparisonSections.push("## Entry/close comparisons by era", "");
  for (const era of ["4H", "1D"]) {
    const list = rows.filter((row) => row.era === era && mature.includes(row));
    const wrongRows = list.filter((row) => row.classification === "wrong_exit_plus10_within_observed_window");
    const rightRows = list.filter((row) => row.classification === "right_exit_no_plus10_in_72h");
    comparisonSections.push(...compareCohort(era, wrongRows, rightRows), "");
  }
  const metricsAtTurn = wrong.map((row) => `${row.id} ${row.symbol}: turn=${row.turn_candle_at}, low=${row.turn_low_from_entry_pct}%, return=${row.hours_to_plus10_candle}h`);
  const reasonWrong = groups.map((group) => {
    const list = rows.filter((row) => row.reason_group === group && row.classification === "wrong_exit_plus10_within_observed_window");
    const denominator = rows.filter((row) => row.reason_group === group && mature.includes(row)).length;
    return { group, count: list.length, denominator, names: list.map((row) => `${row.id} ${row.symbol}`) };
  }).filter((x) => x.denominator > 0).sort((a, b) => b.count / b.denominator - a.count / a.denominator || b.count - a.count);
  const nonzeroWrong = reasonWrong.filter((row) => row.count > 0);
  const recommendation = nonzeroWrong.length
    ? `Highest observed wrong-exit fraction among mature reason groups: ${nonzeroWrong[0]!.group} ${nonzeroWrong[0]!.count}/${nonzeroWrong[0]!.denominator}; examples=${nonzeroWrong[0]!.names.join(", ")}. This is descriptive, not causal; consider no live policy change unless the subgroup separator table shows an out-of-sample-testable rule.`
    : mature.length
      ? "No +10% wrong exits were observed in mature 72-hour rows; this cohort supports no change to exit rules."
      : "No reason group has a mature 72-hour sample; no exit recommendation can be estimated yet.";
  const cgCounts = JSON.stringify(requestCounts);
  const pathGroups = new Map<string, Obj[]>();
  for (const row of goodPathRows) {
    const key = String(row.id);
    const rowsForSignal = pathGroups.get(key) ?? [];
    rowsForSignal.push(row);
    pathGroups.set(key, rowsForSignal);
  }
  const completePaths = [...pathGroups.entries()]
    .filter(([, path]) => path.some((row) => row.horizon_complete === true || String(row.horizon_complete) === "true"));
  const incompletePaths = [...pathGroups.entries()]
    .filter(([, path]) => !path.some((row) => row.horizon_complete === true || String(row.horizon_complete) === "true"));
  const shortCompletePaths = completePaths
    .filter(([, path]) => path.length !== 480)
    .map(([id, path]) => `${id} ${path[0]?.symbol ?? ""}: ${path.length}/480 observed 15m candles`);
  const incompletePathDetail = incompletePaths
    .map(([id, path]) => `${id} ${path[0]?.symbol ?? ""}: ${path.length} candles, last=${path.at(-1)?.price_bar_at ?? "none"}`);
  const unavailableRanges = errors.map((error) =>
    `${error.symbol ?? "unknown"} ${error.kind ?? "unknown"} ${error.from ?? ""}..${error.to ?? ""}: ${error.reason ?? "unavailable"}`,
  );
  return [
    "# ABNeon 72-hour post-close study",
    "",
    `Production cohort rows: ${rows.length}; actual closed_at rows: ${rows.filter((r) => numberOrNull(r.closeAt) != null).length}; reclassified rows without actual closed_at: ${rows.filter((r) => numberOrNull(r.closeAt) == null).length}.`,
    `Era assignment by detected_at: 4H before 2026-11-14, 1D from 2026-11-14: 4H=${rows.filter((r) => r.era === "4H").length}; 1D=${rows.filter((r) => r.era === "1D").length}.`,
    `After-close classification counts: ${JSON.stringify(counts)}.`,
    `CoinGlass actual requests including retries: ${requestsSent}; by endpoint: ${cgCounts}; 429 responses=${api429}; 5-minute pauses=${pauses429}.`,
    `Good-entry paths: ${goodPathCount} observed rows for ${pathGroups.size}/19 IDs; window entry−24h through min(entry+96h, now). Completed 96h paths=${completePaths.length}; incomplete because 96h has not elapsed=${incompletePaths.length}.`,
    `Completed-path coverage exceptions: ${shortCompletePaths.length ? shortCompletePaths.join("; ") : "none"}; no missing candles were fabricated.`,
    `Still-incomplete paths: ${incompletePathDetail.length ? incompletePathDetail.join("; ") : "none"}.`,
    `Exit price window starts at the first complete 15m candle opening at/after closed_at, ends at min(closed_at+72h, now); threshold checks use candle highs. Samples without a full 72h and no +10 touch are pending, not called right.`,
    "Database timestamps without an explicit zone are treated as UTC and emitted as ISO-8601 Z. No updated_at value is substituted for a missing closed_at.",
    "The exit metrics sample uses the last fully closed 15m candle before closed_at; entry metrics are sampled using the same 15m bar mapping as the prior t0.csv study. `total_vs_avg20/120_pct` means percent of the respective average (100=1.0×).",
    "RECLASSIFIED rows with null closed_at have no verified market-exit timestamp and are retained in events.csv/after72h.csv as unclassifiable; updated_at is not substituted for close time.",
    "",
    "## Outcomes by exit reason",
    "",
    ...reasonTable,
    "",
    "## Outcomes by era",
    "",
    ...eraTable,
    "",
    "## Wrong-exit reversal points",
    "",
    ...(metricsAtTurn.length ? metricsAtTurn.map((x) => `- ${x}`) : ["- none"]),
    "",
    "## Full-range pairwise entry/close metric comparison",
    "",
    "No medians are computed. Each metric includes every eligible signal ID, symbol, and value for wrong and right exits; separators are reported only when the full ranges do not overlap.",
    ...comparisonSections,
    "",
    "## Recommendation grounded in this cohort",
    "",
    recommendation,
    "",
    `Unavailable data ranges: ${errors.length}${unavailableRanges.length ? `; ${unavailableRanges.join("; ")}` : ""}. Generated at ${new Date(now).toISOString()}.`,
  ].join("\n") + "\n";
}

async function main(): Promise<void> {
  const now = Date.now();
  if (process.argv.includes("--summary-only")) {
    const afterPath = join(OUT, "after72h.csv");
    const pathsPath = join(OUT, "path15m_good.csv");
    const errorPath = join(OUT, "errors.json");
    if (!existsSync(afterPath) || !existsSync(pathsPath) || !existsSync(errorPath)) {
      throw new Error("summary-only needs completed after72h.csv, path15m_good.csv, and errors.json");
    }
    const rows = parseCsv(readFileSync(afterPath, "utf8")).map((row) => ({
      ...row,
      closeAt: numberOrNull(row.closeAt),
    }));
    const goodPathRows = parseCsv(readFileSync(pathsPath, "utf8"));
    const goodPathCount = goodPathRows.length;
    const savedErrors = JSON.parse(readFileSync(errorPath, "utf8")) as Obj[];
    writeFileSync(join(OUT, "summary.md"), buildSummary(rows, goodPathCount, savedErrors, now, goodPathRows));
    log(`Summary regenerated locally from ${rows.length} rows; no market or database requests made.`);
    return;
  }
  const events = parseEvents();
  const goodIds = readGoodIds();
  if (events.length !== 144) throw new Error(`Expected 144 current non-open production records; got ${events.length}`);
  if (goodIds.size !== 19) throw new Error(`Expected 19 good signals from prior A study; got ${goodIds.size}`);
  const { grouped, ranges } = symbolRanges(events, goodIds, now);
  log(`Production rows=${events.length}; symbols=${grouped.size}; good IDs=${goodIds.size}; open states excluded.`);
  const seriesBySymbol = await loadCoinGlass(grouped, ranges);
  const barsBySymbol = new Map<string, PriceBar[]>();
  for (const [index, symbol] of [...grouped.keys()].sort().entries()) {
    const range = ranges.get(symbol)!;
    try {
      const bars = await klines(CACHE, symbol, "15m", range.priceStart, range.end);
      barsBySymbol.set(symbol, bars.map((bar: any) => ({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })));
      log(`BingX 15m history loaded ${symbol}: ${bars.length} bars (${index + 1}/${grouped.size})`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({ symbol, kind: "bingx15", reason });
      barsBySymbol.set(symbol, []);
      log(`BingX 15m history unavailable ${symbol}: ${reason}`);
    }
  }
  const dataBySymbol = new Map<string, Obj>();
  for (const symbol of grouped.keys()) {
    dataBySymbol.set(symbol, makeData(seriesBySymbol.get(symbol) ?? new Map(), barsBySymbol.get(symbol) ?? []));
  }
  const afterRows = events.map((event) => afterClose(
    event,
    barsBySymbol.get(event.symbol) ?? [],
    dataBySymbol.get(event.symbol)!,
    now,
  ));
  const goodPaths = makeGoodPaths(events, goodIds, barsBySymbol, dataBySymbol, now);
  writeCsv(join(OUT, "after72h.csv"), afterRows);
  writeCsv(join(OUT, "path15m_good.csv"), goodPaths, ["id", "symbol", "price_bar_at"]);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2) + "\n");
  writeFileSync(join(OUT, "summary.md"), buildSummary(afterRows, goodPaths.length, errors, now, goodPaths));
  log(`Exit study complete: rows=${afterRows.length}; classified=${JSON.stringify(Object.fromEntries([...new Set(afterRows.map((r) => r.classification))].map((key) => [key, afterRows.filter((r) => r.classification === key).length])))}; good_path_rows=${goodPaths.length}; CoinGlass=${requestsSent}; endpoints=${JSON.stringify(requestCounts)}.`);
  writeFileSync(join(OUT, "run.txt"), `${runLog.slice(-30).join("\n")}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  runLog.push(`${new Date().toISOString()} FATAL ${message}`);
  writeFileSync(join(OUT, "fatal.txt"), `${message}\n`);
  writeFileSync(join(OUT, "run.txt"), `${runLog.slice(-30).join("\n")}\n`);
  process.exitCode = 1;
});
