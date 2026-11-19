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
import {
  LUCY_LONG_BARS,
  lucyColour,
} from "../../artifacts/api-server/src/lib/abneon-volume-gate.js";
import { klines } from "../../artifacts/api-server/scripts/study-v2/lib.js";

type Obj = Record<string, any>;
type PriceBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};
type FlowBar = {
  time: number;
  buy: number | null;
  sell: number | null;
  cvd?: number | null;
};
type OiBar = { time: number; value: number | null; raw?: Obj };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EVENTS = join(ROOT, "reports/abneon-snap-1119/events.csv");
const CACHE = join(ROOT, "reports/.cache");
const OUT = dirname(fileURLToPath(import.meta.url));
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const TARGET_PCT = 10;
const STOP_PCT = -6;
const RPM = 15;
const MIN_GAP_MS = 4_100;
const FLOW_ENDPOINTS = {
  fut15: "/api/futures/aggregated-taker-buy-sell-volume/history",
  spot15: "/api/spot/aggregated-cvd/history",
  oi15: "/api/futures/open-interest/aggregated-history",
  fut1h: "/api/futures/aggregated-taker-buy-sell-volume/history",
  spot1h: "/api/spot/aggregated-cvd/history",
} as const;
type Kind = keyof typeof FLOW_ENDPOINTS;

// This is a one-off study process, not the development API server.
process.env.NODE_ENV = "production";
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const requestCounts: Record<string, number> = {};
const errors: Obj[] = [];
let callsMade = 0;
let callsPlanned = 0;
let lastStarted = 0;
let api429 = 0;
let pauses = 0;
let startedAt = Date.now();

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"' && quoted && line[i + 1] === '"') {
      value += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  cells.push(value);
  return cells;
}

function readAEvents(): Obj[] {
  if (!existsSync(EVENTS)) throw new Error(`Missing required input: ${EVENTS}`);
  const lines = readFileSync(EVENTS, "utf8").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0] ?? "");
  const result: Obj[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ""]));
    if (row.cohort !== "A_signal") continue;
    const entryAt = Date.parse(row.event_at);
    const entry = Number(row.entry_price);
    if (!Number.isFinite(entryAt) || !Number.isFinite(entry) || entry <= 0) {
      throw new Error(`Invalid A event in events.csv: id=${row.id}`);
    }
    result.push({
      ...row,
      entryAt,
      entryPrice: entry,
    });
  }
  if (result.length !== 145) {
    throw new Error(`Expected 145 A events in events.csv; found ${result.length}`);
  }
  return result.sort((a, b) => a.entryAt - b.entryAt);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || value === "") return null;
  const x = Date.parse(value);
  return Number.isFinite(x) ? x : null;
}

function iso(value: number | null | undefined): string {
  return value == null ? "" : new Date(value).toISOString();
}

function r(value: number | null, digits = 6): number | "" {
  return value == null || !Number.isFinite(value) ? "" : Number(value.toFixed(digits));
}

function changePct(current: number | null, prior: number | null): number | null {
  return current == null || prior == null || prior === 0
    ? null
    : (current / prior - 1) * 100;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(path: string, rows: Obj[]): void {
  const columns = Object.keys(rows[0] ?? {});
  writeFileSync(
    path,
    `${[columns.join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\n")}\n`,
  );
}

function readJson(path: string): Obj | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Obj : null;
  } catch {
    return null;
  }
}

function cacheFile(symbol: string, kind: Kind): string {
  if (kind === "fut15") return join(CACHE, `${symbol}_cg15m_aggfut.json`);
  if (kind === "spot15") return join(CACHE, `${symbol}_cg15m_aggspot.json`);
  if (kind === "fut1h") return join(CACHE, `${symbol}_cg_aggfut.json`);
  if (kind === "spot1h") return join(CACHE, `${symbol}_cg_aggspot.json`);
  return join(CACHE, `${symbol}_cg15m_oi.json`);
}

function intervalFor(kind: Kind): number {
  return kind === "fut1h" || kind === "spot1h" ? H1 : M15;
}

function historyRange(events: Obj[], symbol: string): { start15: number; end: number; start1h: number } {
  const matching = events.filter((event) => event.symbol === symbol);
  const now = Date.now();
  const firstEntry = Math.min(...matching.map((event) => event.entryAt as number));
  const lastEntry = Math.max(...matching.map((event) => event.entryAt as number));
  return {
    start15: Math.floor((firstEntry - D1) / M15) * M15,
    end: Math.min(lastEntry + 96 * H1, now),
    // 120 four-hour candles before entry are 480 one-hour candles.
    start1h: Math.floor((firstEntry - 120 * H4) / H4) * H4,
  };
}

function normalize(kind: Kind, rows: Obj[]): any[] {
  return rows.flatMap((row) => {
    const time = timeMs(row.time);
    if (time == null) return [];
    if (kind === "fut15" || kind === "fut1h") {
      return [{
        time,
        buy: num(row.aggregated_buy_volume_usd),
        sell: num(row.aggregated_sell_volume_usd),
      }];
    }
    if (kind === "spot15" || kind === "spot1h") {
      return [{
        time,
        buy: num(row.agg_taker_buy_vol),
        sell: num(row.agg_taker_sell_vol),
        cvd: num(row.cum_vol_delta),
      }];
    }
    return [{ time, value: num(row.close), raw: row }];
  });
}

function cacheItems(cache: Obj | null): any[] {
  return Array.isArray(cache?.items) ? cache.items.filter((row: any) => timeMs(row.time) != null) : [];
}

function itemTime(row: any): number {
  return timeMs(row.time) ?? 0;
}

function rangesNeeded(
  existing: any[],
  start: number,
  end: number,
  step: number,
): Array<{ start: number; end: number }> {
  const rows = [...existing].sort((a, b) => itemTime(a) - itemTime(b));
  const first = rows.length ? itemTime(rows[0]) : null;
  const last = rows.length ? itemTime(rows.at(-1)) : null;
  if (first == null || last == null) return [{ start, end }];
  const ranges: Array<{ start: number; end: number }> = [];
  if (first > start + step) ranges.push({ start, end: first });
  if (last + step < end) ranges.push({ start: last + step, end });
  return ranges;
}

function buildUrl(kind: Kind, symbol: string, start: number, end: number): string {
  const step = intervalFor(kind);
  const interval = step === H1 ? "1h" : "15m";
  const from = Math.floor(start / step) * step;
  const to = Math.ceil(end / step) * step;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL(`https://open-api-v4.coinglass.com${FLOW_ENDPOINTS[kind]}`);
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", interval);
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
  const remaining = Math.max(0, callsPlanned - callsMade);
  const elapsed = Math.max(1, Date.now() - startedAt);
  const rate = callsMade ? callsMade / elapsed : 0;
  const etaMs = rate > 0 ? remaining / rate : 0;
  const endDubai = new Date(Date.now() + etaMs).toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    hour12: false,
  });
  console.log(`CG progress: ${callsMade} done / ${remaining} remaining / ETA ${endDubai} Dubai`);
}

async function fetchMissing(
  symbol: string,
  kind: Kind,
  start: number,
  end: number,
): Promise<{ items: any[]; reason?: string }> {
  const step = intervalFor(kind);
  const endpoint = FLOW_ENDPOINTS[kind].replace(/^\/api\//, "");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const key = getNextCgKey();
    if (!key) return { items: [], reason: "coinglass_key_unavailable" };
    const wait = lastStarted + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStarted = Date.now();
    callsMade++;
    requestCounts[kind] = (requestCounts[kind] ?? 0) + 1;
    if (callsMade % 50 === 0) progressLine();
    try {
      const response = await cgTimedFetch(
        buildUrl(kind, symbol, start, end),
        {
          headers: { "CG-API-KEY": key, Accept: "application/json" },
          signal: AbortSignal.timeout(25_000),
        },
        { priority: "low", endpoint },
      );
      if (response.status === 429) {
        api429++;
        pauses++;
        console.log(`CoinGlass 429 ${kind} ${symbol}; pause 5 min, retry ${attempt}/5`);
        await sleep(300_000);
        continue;
      }
      if (!response.ok) return { items: [], reason: `http_${response.status}` };
      const body = (await response.json()) as { code?: unknown; msg?: unknown; data?: Obj[] };
      if (String(body.code) === "429") {
        api429++;
        pauses++;
        console.log(`CoinGlass code 429 ${kind} ${symbol}; pause 5 min, retry ${attempt}/5`);
        await sleep(300_000);
        continue;
      }
      if (String(body.code) !== "0") {
        return { items: [], reason: `api_code_${String(body.code)}:${String(body.msg ?? "").slice(0, 120)}` };
      }
      const items = normalize(kind, Array.isArray(body.data) ? body.data : []);
      return items.length ? { items, reason: undefined } : { items: [], reason: "no_data" };
    } catch (error) {
      if (attempt === 5) {
        return { items: [], reason: error instanceof Error ? error.name : "request_error" };
      }
      await sleep(2_000);
    }
  }
  return { items: [], reason: "retry_limit" };
}

async function ensureSeries(
  symbol: string,
  kind: Kind,
  start: number,
  end: number,
): Promise<any[]> {
  const path = cacheFile(symbol, kind);
  const previous = readJson(path);
  const old = cacheItems(previous).sort((a, b) => itemTime(a) - itemTime(b));
  const step = intervalFor(kind);
  const ranges = rangesNeeded(old, start, end, step);
  if (ranges.length === 1 && old.length === 0 && previous?.reason === "no_data") return [];
  const merged = new Map<number, any>(old.map((row) => [itemTime(row), row]));
  const gapReasons: string[] = [];
  for (const range of ranges) {
    const fetched = await fetchMissing(symbol, kind, range.start, range.end);
    for (const row of fetched.items) merged.set(itemTime(row), row);
    if (fetched.reason) {
      gapReasons.push(fetched.reason);
      errors.push({ symbol, kind, from: iso(range.start), to: iso(range.end), reason: fetched.reason });
    }
  }
  const items = [...merged.values()].sort((a, b) => itemTime(a) - itemTime(b));
  if (ranges.length || !previous) {
    writeFileSync(
      path,
      JSON.stringify({
        from: Math.min(timeMs(previous?.from) ?? start, start),
        to: Math.max(timeMs(previous?.to) ?? end, end),
        items,
        ...(gapReasons.length ? { reason: gapReasons.join(";") } : {}),
      }),
    );
  }
  return items;
}

function readPriceBars(symbol: string): PriceBar[] {
  const cache = readJson(join(CACHE, `${symbol}_15m.json`));
  const items = Array.isArray(cache?.items) ? cache.items : [];
  return items.map((row: any) => Array.isArray(row)
    ? { time: timeMs(row[0]) ?? 0, open: num(row[1]) ?? NaN, high: num(row[2]) ?? NaN, low: num(row[3]) ?? NaN, close: num(row[4]) ?? NaN }
    : { time: timeMs(row.time) ?? 0, open: num(row.open) ?? NaN, high: num(row.high) ?? NaN, low: num(row.low) ?? NaN, close: num(row.close) ?? NaN })
    .filter((bar: PriceBar) => bar.time > 0 && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite))
    .sort((a: PriceBar, b: PriceBar) => a.time - b.time);
}

function classify(event: Obj, bars: PriceBar[], now: number): Obj {
  const end = Math.min(event.entryAt + 96 * H1, now);
  const observed = bars.filter((bar) => bar.time + M15 > event.entryAt && bar.time < end);
  if (!observed.length) return { ...event, outcome: "censored", reason: "no_price_bars_after_entry", targetAt: null, stopAt: null, t0At: null, t0Low: null, observedUntil: null };
  let targetAt: number | null = null;
  let stopAt: number | null = null;
  let ambiguousAt: number | null = null;
  for (const bar of observed) {
    const target = bar.high >= event.entryPrice * (1 + TARGET_PCT / 100);
    const stop = bar.low <= event.entryPrice * (1 + STOP_PCT / 100);
    if (target && stop) { ambiguousAt = bar.time; break; }
    if (target) { targetAt = bar.time; break; }
    if (stop) { stopAt = bar.time; break; }
  }
  const horizonComplete = now >= event.entryAt + 96 * H1;
  const outcome = ambiguousAt != null ? "ambiguous"
    : targetAt != null ? "good"
      : stopAt != null ? "bad"
        : horizonComplete ? "open" : "censored";
  let t0At: number | null = null;
  let t0Low: number | null = null;
  if (outcome === "good" && targetAt != null) {
    for (const bar of observed) {
      if (bar.time > targetAt) break;
      if (t0Low == null || bar.low < t0Low) { t0At = bar.time; t0Low = bar.low; }
    }
  }
  return {
    ...event,
    outcome,
    reason: ambiguousAt != null ? "both_thresholds_same_15m_bar"
      : outcome === "open" ? "96h_complete_no_threshold"
        : outcome === "censored" ? `96h_not_elapsed; observed_until=${iso(observed.at(-1)!.time + M15)}`
          : "",
    targetAt,
    stopAt,
    ambiguousAt,
    t0At,
    t0Low,
    horizonComplete,
    observedUntil: observed.at(-1)!.time + M15,
  };
}

function mapTime<T extends { time: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((row) => [row.time, row]));
}

function volumeBuckets(fut: Map<number, FlowBar>, spot: Map<number, FlowBar>, tf: number): Map<number, number> {
  const times = [...fut.keys()].sort((a, b) => a - b);
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? 0;
  const result = new Map<number, number>();
  for (let open = Math.ceil(first / tf) * tf; open + tf <= last + H1; open += tf) {
    let sum = 0;
    let valid = 0;
    for (let time = open; time < open + tf; time += H1) {
      const f = fut.get(time);
      if (f?.buy == null || f.sell == null) continue;
      const s = spot.get(time);
      sum += f.buy + f.sell + (s?.buy ?? 0) + (s?.sell ?? 0);
      valid++;
    }
    if (valid === tf / H1) result.set(open, sum);
  }
  return result;
}

function lucyAt(volume: Map<number, number>, tf: number, time: number): string | null {
  const candle = Math.floor((time - 1) / tf) * tf;
  const values = [...volume.entries()].sort((a, b) => a[0] - b[0]);
  const index = values.findIndex(([open]) => open === candle);
  if (index < LUCY_LONG_BARS - 1) return null;
  return lucyColour(values.slice(0, index + 1).map(([, value]) => value), index);
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
  return count ? { buy, sell } : { buy: null, sell: null };
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
  const cvdDelta = (back: number) => cvd == null || cvdAt(back) == null ? null : cvd - cvdAt(back)!;
  return {
    sample_at: iso(time),
    sample_bar_at: iso(t),
    price_open: r(price?.open ?? null),
    price_high: r(price?.high ?? null),
    price_low: r(price?.low ?? null),
    price_close: r(price?.close ?? null),
    oi15m_usd: r(oi?.value ?? null, 2),
    oi_change_15m_pct: r(changePct(oi?.value ?? null, oiAt(M15))),
    oi_change_1h_pct: r(changePct(oi?.value ?? null, oiAt(H1))),
    oi_change_4h_pct: r(changePct(oi?.value ?? null, oiAt(H4))),
    fut_buy_15m_usd: r(fut?.buy ?? null, 2),
    fut_sell_15m_usd: r(fut?.sell ?? null, 2),
    fut_net_buy_15m_pct: r(fut?.buy == null || fut.sell == null || fut.buy + fut.sell === 0 ? null : (fut.buy - fut.sell) / (fut.buy + fut.sell) * 100),
    fut_buy_1h_usd: r(fut1h.buy, 2),
    fut_sell_1h_usd: r(fut1h.sell, 2),
    fut_net_buy_1h_pct: r(fut1h.buy == null || fut1h.sell == null || fut1h.buy + fut1h.sell === 0 ? null : (fut1h.buy - fut1h.sell) / (fut1h.buy + fut1h.sell) * 100),
    spot_buy_15m_usd: r(spot?.buy ?? null, 2),
    spot_sell_15m_usd: r(spot?.sell ?? null, 2),
    spot_cvd_level: r(cvd, 2),
    spot_cvd_change_15m: r(cvdDelta(M15), 2),
    spot_cvd_change_1h: r(cvdDelta(H1), 2),
    spot_cvd_change_4h: r(cvdDelta(H4), 2),
    spot_buy_1h_usd: r(spot1h.buy, 2),
    spot_sell_1h_usd: r(spot1h.sell, 2),
    fut_volume_15m_usd: r(fut?.buy == null || fut.sell == null ? null : fut.buy + fut.sell, 2),
    spot_volume_15m_usd: r(spot?.buy == null || spot.sell == null ? null : spot.buy + spot.sell, 2),
    total_volume_15m_usd: r(totalVolume, 2),
    total_vs_avg20_pct: r(totalVolume == null || avgPrior(20) == null || avgPrior(20) === 0 ? null : totalVolume / avgPrior(20)! * 100),
    total_vs_avg120_pct: r(totalVolume == null || avgPrior(120) == null || avgPrior(120) === 0 ? null : totalVolume / avgPrior(120)! * 100),
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

async function runA(): Promise<void> {
  const events = readAEvents();
  const symbols = [...new Set(events.map((event) => String(event.symbol)))].sort();
  const now = Date.now();
  const ranges = new Map<string, ReturnType<typeof historyRange>>();
  for (const symbol of symbols) ranges.set(symbol, historyRange(events, symbol));
  const plan: Array<{ symbol: string; kind: Kind; start: number; end: number }> = [];
  const kinds: Kind[] = ["fut15", "spot15", "oi15", "fut1h", "spot1h"];
  for (const symbol of symbols) {
    const range = ranges.get(symbol)!;
    for (const kind of kinds) {
      const path = cacheFile(symbol, kind);
      const cache = readJson(path);
      const existing = cacheItems(cache);
      const step = intervalFor(kind);
      const start = kind === "fut1h" || kind === "spot1h" ? range.start1h : range.start15;
      for (const gap of rangesNeeded(existing, start, range.end, step)) {
        plan.push({ symbol, kind, start: gap.start, end: gap.end });
      }
    }
  }
  callsPlanned = plan.length;
  startedAt = Date.now();
  console.log(`A start: 145 signals / ${symbols.length} symbols; missing CoinGlass ranges=${callsPlanned}; cap=${RPM}/min.`);
  if (callsPlanned && !process.env.CoinGlassAPI?.trim()) {
    throw new Error("CoinGlass key unavailable; no request was sent.");
  }

  // Refresh missing BingX tail only for the A period; the helper reuses cache and calls only missing tails.
  for (const symbol of symbols) {
    const range = ranges.get(symbol)!;
    const earliest = Math.min(...events.filter((event) => event.symbol === symbol).map((event) => event.entryAt));
    await klines(CACHE, symbol, "15m", earliest - D1, range.end);
  }

  const mergedSeries = new Map<string, Map<Kind, any[]>>();
  for (const symbol of symbols) {
    const range = ranges.get(symbol)!;
    const series = new Map<Kind, any[]>();
    for (const kind of kinds) {
      const start = kind === "fut1h" || kind === "spot1h" ? range.start1h : range.start15;
      const end = range.end;
      const path = cacheFile(symbol, kind);
      const previous = readJson(path);
      const old = cacheItems(previous).sort((a, b) => itemTime(a) - itemTime(b));
      const step = intervalFor(kind);
      const gaps = rangesNeeded(old, start, end, step);
      const merged = new Map<number, any>(old.map((row) => [itemTime(row), row]));
      for (const gap of gaps) {
        const result = await fetchMissing(symbol, kind, gap.start, gap.end);
        for (const row of result.items) merged.set(itemTime(row), row);
        if (result.reason) {
          errors.push({ symbol, kind, from: iso(gap.start), to: iso(gap.end), reason: result.reason });
        }
      }
      const items = [...merged.values()].sort((a, b) => itemTime(a) - itemTime(b));
      if (gaps.length || !previous) {
        writeFileSync(path, JSON.stringify({
          from: Math.min(timeMs(previous?.from) ?? start, start),
          to: Math.max(timeMs(previous?.to) ?? end, end),
          items,
          ...(errors.some((x) => x.symbol === symbol && x.kind === kind) ? { reason: "partial_or_unavailable_range" } : {}),
        }));
      }
      series.set(kind, items);
    }
    mergedSeries.set(symbol, series);
  }

  const priceBySymbol = new Map<string, PriceBar[]>();
  for (const symbol of symbols) priceBySymbol.set(symbol, readPriceBars(symbol));
  const classified = events.map((event) =>
    classify(event, priceBySymbol.get(String(event.symbol)) ?? [], now),
  );
  const outcomes = Object.fromEntries(["good", "bad", "open", "censored", "ambiguous"].map((key) => [
    key,
    classified.filter((event) => event.outcome === key).length,
  ]));
  const metricData = new Map<string, Obj>();
  for (const symbol of symbols) {
    const series = mergedSeries.get(symbol)!;
    const fut15 = mapTime(series.get("fut15") as FlowBar[]);
    const spot15 = mapTime(series.get("spot15") as FlowBar[]);
    const oi15 = mapTime(series.get("oi15") as OiBar[]);
    const fut1h = mapTime(series.get("fut1h") as FlowBar[]);
    const spot1h = mapTime(series.get("spot1h") as FlowBar[]);
    const oneHourVolumes = new Map<number, number>();
    for (const [time, fut] of fut1h) {
      if (fut.buy == null || fut.sell == null) continue;
      const spot = spot1h.get(time);
      oneHourVolumes.set(time, fut.buy + fut.sell + (spot?.buy ?? 0) + (spot?.sell ?? 0));
    }
    const fourHourVolumes = new Map<number, number>();
    const first1h = Math.min(...oneHourVolumes.keys());
    const last1h = Math.max(...oneHourVolumes.keys());
    for (let open = Math.ceil(first1h / H4) * H4; open + H4 <= last1h + H1; open += H4) {
      let sum = 0;
      let count = 0;
      for (let t = open; t < open + H4; t += H1) {
        const v = oneHourVolumes.get(t);
        if (v == null) continue;
        sum += v;
        count++;
      }
      if (count === 4) fourHourVolumes.set(open, sum);
    }
    metricData.set(symbol, {
      fut15,
      spot15,
      oi15,
      fut1h,
      spot1h,
      lucy1h: oneHourVolumes,
      lucy4h: fourHourVolumes,
      price: new Map((priceBySymbol.get(symbol) ?? []).map((bar) => [bar.time, bar])),
    });
  }

  const t0Rows: Obj[] = [];
  const paths: Obj[] = [];
  const points = [
    ["entry", null],
    ["T0-60m", -60],
    ["T0-45m", -45],
    ["T0-30m", -30],
    ["T0-15m", -15],
    ["T0", 0],
    ["T0+15m", 15],
    ["T0+30m", 30],
  ] as const;
  for (const event of classified) {
    const symbol = String(event.symbol);
    const data = metricData.get(symbol)!;
    const bars = priceBySymbol.get(symbol) ?? [];
    if (event.outcome === "good" && event.t0At != null) {
      for (const [point, minutes] of points) {
        const sampleAt = minutes == null ? event.entryAt : event.t0At + minutes * 60_000;
        t0Rows.push({
          id: event.id,
          signal_id: event.signal_id,
          symbol,
          detected_at: iso(event.entryAt),
          status: event.status,
          outcome: event.outcome,
          point,
          t0_candle_open: iso(event.t0At),
          t0_candle_close: iso(event.t0At + M15),
          t0_low: r(event.t0Low),
          first_plus10_at: iso(event.targetAt),
          ...metricsAt(sampleAt, data),
        });
      }
    }
    if (["bad", "open", "censored", "ambiguous"].includes(event.outcome)) {
      const end = Math.min(event.entryAt + 96 * H1, now);
      for (const bar of bars) {
        if (bar.time + M15 <= event.entryAt || bar.time >= end) continue;
        paths.push({
          id: event.id,
          symbol,
          detected_at: iso(event.entryAt),
          status: event.status,
          outcome: event.outcome,
          outcome_reason: event.reason,
          price_bar_at: iso(bar.time),
          ...metricsAt(bar.time, data),
        });
      }
    }
  }
  const eventRows = classified.map((event) => ({
    id: event.id,
    signal_id: event.signal_id,
    symbol: event.symbol,
    detected_at: iso(event.entryAt),
    status: event.status,
    entry_price: event.entryPrice,
    outcome: event.outcome,
    outcome_reason: event.reason,
    horizon_complete: event.horizonComplete,
    observed_until: iso(event.observedUntil),
    target10_at: iso(event.targetAt),
    stop6_at: iso(event.stopAt),
    ambiguous_at: iso(event.ambiguousAt),
    t0_candle_open: iso(event.t0At),
    t0_candle_low: r(event.t0Low),
    required_15m_from: iso(ranges.get(String(event.symbol))!.start15),
    required_1h_from: iso(ranges.get(String(event.symbol))!.start1h),
    required_to: iso(ranges.get(String(event.symbol))!.end),
  }));
  writeCsv(join(OUT, "events.csv"), eventRows);
  writeCsv(join(OUT, "t0.csv"), t0Rows);
  writeCsv(join(OUT, "path15m.csv"), paths);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2) + "\n");
  const byOutcome = Object.fromEntries(
    ["good", "bad", "open", "censored", "ambiguous"].map((key) => [
      key,
      classified.filter((event) => event.outcome === key),
    ]),
  );
  const t0List = byOutcome.good
    .map((event: Obj) => `${event.id} ${event.symbol} T0=${iso(event.t0At)} low=${event.t0Low} +10=${iso(event.targetAt)}`)
    .join("\n");
  const logTail = [
    `A start: 145 signals / ${symbols.length} symbols.`,
    `CoinGlass requests=${callsMade}; requests by endpoint=${JSON.stringify(requestCounts)}; 429=${api429}; five-minute pauses=${pauses}.`,
    `Outcomes=${JSON.stringify(outcomes)}; t0.csv rows=${t0Rows.length}; path15m.csv rows=${paths.length}.`,
    ...runLogs.slice(-27),
  ];
  writeFileSync(join(OUT, "run.txt"), `${logTail.join("\n")}\n`);
  writeFileSync(join(OUT, "summary.md"), [
    "# ABNeon historical study — A only",
    "",
    `A signals: ${classified.length}; unique symbols: ${symbols.length}.`,
    `Price outcomes on 15m OHLC within 96h: ${JSON.stringify(outcomes)}.`,
    `CoinGlass HTTP requests: ${callsMade}; by endpoint: ${JSON.stringify(requestCounts)}; 429: ${api429}; five-minute pauses: ${pauses}.`,
    "Inputs: reports/abneon-snap-1119/events.csv, cached BingX 15m price bars, and cached/fetched CoinGlass history. 15m starts 24 hours before the earliest entry per symbol; series extend to 96 hours after the latest entry, capped at the present because future candles do not exist yet. 1H starts 120×4H before the earliest entry so both the 120-bar 1H and 120-bar 4H Lucy windows are available, and continues to the same end.",
    "T0: lowest-low 15m candle from entry through the first +10% candle for a good outcome. If +10% and −6% occur inside the same 15m candle, the result is marked ambiguous.",
    `Signals not yet at 96h without either threshold: ${byOutcome.censored.length}; their observed history ends at the present and is not labeled as a completed open outcome.`,
    "",
    "## T0 by good signal",
    "",
    t0List || "(none)",
    "",
    `Detailed entry/T0 readings: t0.csv (${t0Rows.length} rows). Full post-entry 15m paths for bad/open/censored/ambiguous: path15m.csv (${paths.length} rows). Missing API values are blank; errors.json contains explicit unavailable reasons.`,
  ].join("\n") + "\n");
  console.log(`A complete: ${callsMade} CoinGlass requests; outcomes=${JSON.stringify(outcomes)}; T0 rows=${t0Rows.length}.`);
}

const runLogs: string[] = [];
const originalLog = console.log.bind(console);
console.log = (...args: any[]) => {
  const text = args.map(String).join(" ");
  runLogs.push(`${new Date().toISOString()} ${text}`);
  originalLog(...args);
};

void runA().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  writeFileSync(join(OUT, "fatal.txt"), `${message}\n`);
  process.exitCode = 1;
});
