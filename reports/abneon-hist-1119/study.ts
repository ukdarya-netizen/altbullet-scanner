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
type Candle = {
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
type ScalarBar = { time: number; value: number | null; raw?: Obj };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INPUT = join(ROOT, "reports/abneon-snap-1119");
const CACHE = join(ROOT, "reports/.cache");
const OUT = dirname(fileURLToPath(import.meta.url));
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
const HORIZON = 96 * H1;
const TARGET = 0.10;
const STOP = -0.06;
const RPM = 15;
const MIN_REQUEST_GAP_MS = 4_100;
const ENDPOINTS = {
  fut: "/api/futures/aggregated-taker-buy-sell-volume/history",
  spot: "/api/spot/aggregated-cvd/history",
  oi: "/api/futures/open-interest/aggregated-history",
  liq: "/api/futures/liquidation/aggregated-history",
} as const;

process.env.NODE_ENV = "production";
mkdirSync(OUT, { recursive: true });

function readJsonl(path: string): Obj[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Obj);
}

function readJson(path: string): Obj | null {
  try {
    return existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Obj)
      : null;
  } catch {
    return null;
  }
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function n(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function iso(value: number | null | undefined): string {
  return value == null ? "" : new Date(value).toISOString();
}

function round(value: number | null, digits = 6): number | "" {
  return value == null || !Number.isFinite(value)
    ? ""
    : Number(value.toFixed(digits));
}

function pct(a: number | null, b: number | null): number | null {
  return a == null || b == null || b === 0 ? null : ((a / b) - 1) * 100;
}

function readPriceBars(symbol: string): Candle[] {
  const cache = readJson(join(CACHE, `${symbol}_15m.json`));
  const items = Array.isArray(cache?.items) ? cache.items : [];
  return items
    .map((row: any) =>
      Array.isArray(row)
        ? {
            time: timeMs(row[0]) ?? 0,
            open: n(row[1]) ?? NaN,
            high: n(row[2]) ?? NaN,
            low: n(row[3]) ?? NaN,
            close: n(row[4]) ?? NaN,
          }
        : {
            time: timeMs(row.time) ?? 0,
            open: n(row.open) ?? NaN,
            high: n(row.high) ?? NaN,
            low: n(row.low) ?? NaN,
            close: n(row.close) ?? NaN,
          },
    )
    .filter(
      (bar: Candle) =>
        bar.time > 0 &&
        [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
    )
    .sort((a: Candle, b: Candle) => a.time - b.time);
}

function loadEvents(): Obj[] {
  const signals = [
    ...readJsonl(join(INPUT, "source/signals_1.jsonl")),
    ...readJsonl(join(INPUT, "source/signals_2.jsonl")),
  ];
  const prior = new Map<string, Obj>();
  const eventsPath = join(INPUT, "events.csv");
  if (existsSync(eventsPath)) {
    const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/);
    const headers = parseCsvLine(lines[0] ?? "");
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const cells = parseCsvLine(line);
      const row = Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ""]));
      if (row.cohort === "A_signal") prior.set(String(row.id), row);
    }
  }
  return signals
    .map((signal) => {
      const old = prior.get(String(signal.id)) ?? {};
      const entryAt = timeMs(signal.detected_at);
      const priorArm = timeMs(old.arm_at);
      const proxyArm = old.arm_time_proxy || "";
      const armAt = priorArm ?? (entryAt == null ? null : entryAt - 48 * H1);
      return {
        ...signal,
        entryAt,
        armAt,
        armTimeProxy: proxyArm || (priorArm == null ? "detected_at_minus_48h" : ""),
        zoneTop: n(old.zone_top),
        zoneBottom: n(old.zone_bottom),
      };
    })
    .filter((row) => row.entryAt != null && n(row.entry_price) != null)
    .sort((a, b) => a.entryAt - b.entryAt);
}

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

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(path: string, rows: Obj[], columns: string[]): void {
  const text = [
    columns.join(","),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
  ].join("\n");
  writeFileSync(path, `${text}\n`);
}

function readCache<T extends FlowBar | ScalarBar>(
  path: string,
): { from: number | null; to: number | null; items: T[]; reason?: string } {
  const cache = readJson(path);
  const items = Array.isArray(cache?.items) ? (cache.items as T[]) : [];
  return {
    from: timeMs(cache?.from),
    to: timeMs(cache?.to),
    items,
    reason: typeof cache?.reason === "string" ? cache.reason : undefined,
  };
}

function itemTime(item: any): number {
  return timeMs(item.time) ?? 0;
}

let lastRequestAt = 0;
let requestCount = 0;
let api429Count = 0;
let pauses429 = 0;
const requestsByEndpoint: Record<string, number> = {};
const errors: Obj[] = [];
const runLog: string[] = [];

function log(message: string): void {
  runLog.push(`${new Date().toISOString()} ${message}`);
  console.log(message);
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

function requestUrl(endpoint: string, symbol: string, start: number, end: number): string {
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL(`https://open-api-v4.coinglass.com${endpoint}`);
  const intervalMs = M15;
  const alignedStart = Math.floor(start / intervalMs) * intervalMs;
  const alignedEnd = Math.ceil(end / intervalMs) * intervalMs;
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("start_time", String(alignedStart));
  url.searchParams.set("end_time", String(alignedEnd));
  url.searchParams.set(
    "limit",
    String(Math.min(4500, Math.ceil((alignedEnd - alignedStart) / intervalMs) + 4)),
  );
  if (endpoint === ENDPOINTS.fut) {
    url.searchParams.set("exchange_list", getAllFuturesExchanges());
  } else if (endpoint === ENDPOINTS.spot) {
    url.searchParams.set("exchange_list", getAllSpotExchanges());
  } else if (endpoint === ENDPOINTS.liq) {
    url.searchParams.set("exchange_list", getAllFuturesExchanges());
  }
  return url.toString();
}

function normalizeRows(kind: keyof typeof ENDPOINTS, data: Obj[]): any[] {
  return data
    .map((row) => {
      const time = timeMs(row.time);
      if (time == null) return null;
      if (kind === "fut") {
        return {
          time,
          buy: n(row.aggregated_buy_volume_usd),
          sell: n(row.aggregated_sell_volume_usd),
        };
      }
      if (kind === "spot") {
        return {
          time,
          buy: n(row.agg_taker_buy_vol),
          sell: n(row.agg_taker_sell_vol),
          cvd: n(row.cum_vol_delta),
        };
      }
      if (kind === "oi") {
        return { time, value: n(row.close), raw: row };
      }
      return {
        time,
        value: null,
        longUsd: firstNumeric(row, [
          "aggregated_long_liquidation_usd",
          "long_liquidation_usd",
          "aggregated_long_usd",
        ]),
        shortUsd: firstNumeric(row, [
          "aggregated_short_liquidation_usd",
          "short_liquidation_usd",
          "aggregated_short_usd",
        ]),
        raw: row,
      };
    })
    .filter(Boolean);
}

function firstNumeric(row: Obj, keys: string[]): number | null {
  for (const key of keys) {
    const value = n(row[key]);
    if (value != null) return value;
  }
  return null;
}

async function fetchRange(
  symbol: string,
  kind: keyof typeof ENDPOINTS,
  start: number,
  end: number,
): Promise<{ items: any[]; reason?: string }> {
  const endpoint = ENDPOINTS[kind];
  const label = `${kind}:${symbol}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const key = getNextCgKey();
    if (!key) return { items: [], reason: "coinglass_key_unavailable" };
    await pace();
    requestCount++;
    requestsByEndpoint[kind] = (requestsByEndpoint[kind] ?? 0) + 1;
    log(`CG request ${requestCount}: ${label} attempt=${attempt}`);
    try {
      const response = await cgTimedFetch(
        requestUrl(endpoint, symbol, start, end),
        {
          headers: { "CG-API-KEY": key, Accept: "application/json" },
          signal: AbortSignal.timeout(25_000),
        },
        { priority: "low", endpoint: endpoint.replace(/^\/api\//, "") },
      );
      if (response.status === 429) {
        api429Count++;
        pauses429++;
        log(`HTTP 429; pausing five minutes before retry ${label}`);
        await sleep(300_000);
        continue;
      }
      if (!response.ok) {
        return { items: [], reason: `http_${response.status}` };
      }
      const body = (await response.json()) as { code?: unknown; msg?: unknown; data?: Obj[] };
      if (String(body.code) === "429") {
        api429Count++;
        pauses429++;
        log(`CoinGlass code 429; pausing five minutes before retry ${label}`);
        await sleep(300_000);
        continue;
      }
      if (String(body.code) !== "0") {
        return { items: [], reason: `api_code_${String(body.code)}:${String(body.msg ?? "").slice(0, 100)}` };
      }
      const rows = Array.isArray(body.data) ? normalizeRows(kind, body.data) : [];
      return rows.length ? { items: rows } : { items: [], reason: "no_data" };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "request_error";
      if (attempt === 5) return { items: [], reason };
      await sleep(2_000);
    }
  }
  return { items: [], reason: "retry_limit" };
}

async function ensureHistory(
  symbol: string,
  kind: keyof typeof ENDPOINTS,
  requiredStart: number,
  requiredEnd: number,
): Promise<any[]> {
  const file = join(CACHE, `${symbol}_cg15m_${kind}.json`);
  const previous = readCache<any>(file);
  const existing = previous.items
    .filter((row) => itemTime(row) > 0)
    .sort((a, b) => itemTime(a) - itemTime(b));
  const first = existing.length ? itemTime(existing[0]) : null;
  const last = existing.length ? itemTime(existing.at(-1)) : null;
  const gaps: Array<{ from: number; to: number; label: string }> = [];
  if (first == null) {
    gaps.push({ from: requiredStart, to: requiredEnd, label: "full" });
  } else {
    if (first > requiredStart + M15) {
      gaps.push({ from: requiredStart, to: first, label: "head" });
    }
    if (last != null && last + M15 < requiredEnd) {
      gaps.push({ from: last + M15, to: requiredEnd, label: "tail" });
    }
  }
  const merged = new Map<number, any>(existing.map((row) => [itemTime(row), row]));
  const gapReasons: string[] = [];
  for (const gap of gaps) {
    const result = await fetchRange(symbol, kind, gap.from, gap.to);
    for (const row of result.items) merged.set(itemTime(row), row);
    if (result.reason) {
      gapReasons.push(`${gap.label}:${result.reason}`);
      errors.push({ symbol, kind, range: gap.label, reason: result.reason });
    }
  }
  const items = [...merged.values()].sort((a, b) => itemTime(a) - itemTime(b));
  if (gaps.length) {
    writeFileSync(
      file,
      JSON.stringify({
        from: Math.min(first ?? requiredStart, requiredStart),
        to: Math.max(last ?? requiredEnd, requiredEnd),
        items,
        ...(gapReasons.length ? { gaps: gapReasons } : {}),
      }),
    );
  }
  return items;
}

function classify(
  event: Obj,
  priceBars: Candle[],
  now: number,
): Obj {
  const entryAt = event.entryAt as number;
  const entry = n(event.entry_price)!;
  const horizonEnd = entryAt + HORIZON;
  const complete = now >= horizonEnd;
  const eligible = priceBars.filter(
    (bar) => bar.time + M15 > entryAt && bar.time < Math.min(horizonEnd, now),
  );
  if (!eligible.length) {
    return {
      ...event,
      outcome: "censored",
      outcomeReason: "no_price_bars_after_entry",
      targetAt: null,
      stopAt: null,
      t0At: null,
      t0Low: null,
      observedBars: 0,
      horizonComplete: complete,
      horizonEnd,
    };
  }
  let targetAt: number | null = null;
  let stopAt: number | null = null;
  let ambiguousAt: number | null = null;
  for (const bar of eligible) {
    const hitTarget = bar.high >= entry * (1 + TARGET);
    const hitStop = bar.low <= entry * (1 + STOP);
    if (hitTarget && hitStop) {
      ambiguousAt = bar.time;
      break;
    }
    if (hitTarget) {
      targetAt = bar.time;
      break;
    }
    if (hitStop) {
      stopAt = bar.time;
      break;
    }
  }
  let outcome = "censored";
  let outcomeReason = "";
  if (ambiguousAt != null) {
    outcome = "ambiguous";
    outcomeReason = "both_thresholds_in_same_15m_candle";
  } else if (targetAt != null) {
    outcome = "good";
  } else if (stopAt != null) {
    outcome = "bad";
  } else if (complete) {
    outcome = "open";
    outcomeReason = "96h_complete_no_10pct_or_minus6pct";
  } else {
    outcomeReason = `96h_not_elapsed; observed_until=${iso(eligible.at(-1)!.time + M15)}`;
  }
  let t0At: number | null = null;
  let t0Low: number | null = null;
  if (outcome === "good" && targetAt != null) {
    const beforeTarget = eligible.filter((bar) => bar.time <= targetAt!);
    for (const bar of beforeTarget) {
      if (t0Low == null || bar.low < t0Low) {
        t0At = bar.time;
        t0Low = bar.low;
      }
    }
  }
  return {
    ...event,
    outcome,
    outcomeReason,
    targetAt,
    stopAt,
    ambiguousAt,
    t0At,
    t0Low,
    observedBars: eligible.length,
    horizonComplete: complete,
    horizonEnd,
    observedUntil: eligible.at(-1)!.time + M15,
  };
}

function mapByTime<T extends { time: number }>(items: T[]): Map<number, T> {
  return new Map(items.map((row) => [row.time, row]));
}

function valueAt<T extends { time: number }>(
  map: Map<number, T>,
  time: number,
): T | null {
  return map.get(Math.floor(time / M15) * M15) ?? null;
}

function sumWindow(
  map: Map<number, FlowBar>,
  time: number,
  span: number,
): { buy: number | null; sell: number | null; count: number } {
  let buy = 0;
  let sell = 0;
  let count = 0;
  for (let t = time - span + M15; t <= time; t += M15) {
    const row = map.get(t);
    if (row?.buy == null || row.sell == null) continue;
    buy += row.buy;
    sell += row.sell;
    count++;
  }
  return count ? { buy, sell, count } : { buy: null, sell: null, count: 0 };
}

function avgPrior(
  volumes: Map<number, number>,
  time: number,
  bars: number,
): number | null {
  let sum = 0;
  let count = 0;
  for (let t = time - M15; t >= time - bars * M15; t -= M15) {
    const value = volumes.get(t);
    if (value == null || !Number.isFinite(value)) return null;
    sum += value;
    count++;
  }
  return count === bars ? sum / bars : null;
}

function pctNet(buy: number | null, sell: number | null): number | null {
  return buy == null || sell == null || buy + sell === 0
    ? null
    : ((buy - sell) / (buy + sell)) * 100;
}

function pctChange(
  map: Map<number, ScalarBar>,
  time: number,
  back: number,
): number | null {
  const current = valueAt(map, time)?.value ?? null;
  const previous = valueAt(map, time - back)?.value ?? null;
  return pct(current, previous);
}

function bucketVolumes(
  fut: Map<number, FlowBar>,
  spot: Map<number, FlowBar>,
  interval: number,
  from: number,
  to: number,
): Map<number, number> {
  const result = new Map<number, number>();
  for (
    let open = Math.floor(from / interval) * interval;
    open + interval <= to;
    open += interval
  ) {
    let total = 0;
    let count = 0;
    for (let t = open; t < open + interval; t += M15) {
      const f = fut.get(t);
      if (f?.buy == null || f.sell == null) continue;
      const s = spot.get(t);
      total += f.buy + f.sell + (s?.buy ?? 0) + (s?.sell ?? 0);
      count++;
    }
    if (count === interval / M15) result.set(open, total);
  }
  return result;
}

function lucyAt(
  series: Map<number, number>,
  interval: number,
  time: number,
): string | null {
  const candleOpen = Math.floor((time - 1) / interval) * interval;
  const sortedTimes = [...series.keys()].sort((a, b) => a - b);
  const idx = sortedTimes.indexOf(candleOpen);
  if (idx < LUCY_LONG_BARS - 1) return null;
  const values = sortedTimes.slice(0, idx + 1).map((t) => series.get(t)!);
  if (values.length !== idx + 1) return null;
  return lucyColour(values, values.length - 1);
}

function metricsAt(
  time: number,
  priceMap: Map<number, Candle>,
  futMap: Map<number, FlowBar>,
  spotMap: Map<number, FlowBar>,
  oiMap: Map<number, ScalarBar>,
  liqMap: Map<number, any>,
  futVol: Map<number, number>,
  spotVol: Map<number, number>,
  totalVol: Map<number, number>,
  lucy1h: Map<number, number>,
  lucy4h: Map<number, number>,
): Obj {
  const key = Math.floor(time / M15) * M15;
  const p = priceMap.get(key);
  const f = futMap.get(key);
  const s = spotMap.get(key);
  const liq = liqMap.get(key);
  const fut1h = sumWindow(futMap, key, H1);
  const fut4h = sumWindow(futMap, key, H4);
  const spot1h = sumWindow(spotMap, key, H1);
  const spot4h = sumWindow(spotMap, key, H4);
  const cvdNow = s?.cvd ?? null;
  const cvdAt = (back: number) => spotMap.get(key - back)?.cvd ?? null;
  const total = totalVol.get(key) ?? null;
  const avg20 = avgPrior(totalVol, key, 20);
  const avg120 = avgPrior(totalVol, key, 120);
  return {
    price_time: iso(key),
    price_open: round(p?.open ?? null),
    price_high: round(p?.high ?? null),
    price_low: round(p?.low ?? null),
    price_close: round(p?.close ?? null),
    oi_usd: round(valueAt(oiMap, key)?.value ?? null, 2),
    oi_change_15m_pct: round(pctChange(oiMap, key, M15)),
    oi_change_1h_pct: round(pctChange(oiMap, key, H1)),
    oi_change_4h_pct: round(pctChange(oiMap, key, H4)),
    fut_taker_buy_15m_usd: round(f?.buy ?? null, 2),
    fut_taker_sell_15m_usd: round(f?.sell ?? null, 2),
    fut_net_buy_15m_pct: round(pctNet(f?.buy ?? null, f?.sell ?? null)),
    fut_taker_buy_1h_usd: round(fut1h.buy, 2),
    fut_taker_sell_1h_usd: round(fut1h.sell, 2),
    fut_net_buy_1h_pct: round(pctNet(fut1h.buy, fut1h.sell)),
    spot_taker_buy_15m_usd: round(s?.buy ?? null, 2),
    spot_taker_sell_15m_usd: round(s?.sell ?? null, 2),
    spot_cvd_level: round(cvdNow, 2),
    spot_cvd_change_15m: round(cvdNow == null || cvdAt(M15) == null ? null : cvdNow - cvdAt(M15)!, 2),
    spot_cvd_change_1h: round(cvdNow == null || cvdAt(H1) == null ? null : cvdNow - cvdAt(H1)!, 2),
    spot_cvd_change_4h: round(cvdNow == null || cvdAt(H4) == null ? null : cvdNow - cvdAt(H4)!, 2),
    spot_taker_buy_1h_usd: round(spot1h.buy, 2),
    spot_taker_sell_1h_usd: round(spot1h.sell, 2),
    spot_net_buy_1h_pct: round(pctNet(spot1h.buy, spot1h.sell)),
    spot_taker_buy_4h_usd: round(spot4h.buy, 2),
    spot_taker_sell_4h_usd: round(spot4h.sell, 2),
    spot_net_buy_4h_pct: round(pctNet(spot4h.buy, spot4h.sell)),
    fut_volume_15m_usd: round(futVol.get(key) ?? null, 2),
    spot_volume_15m_usd: round(spotVol.get(key) ?? null, 2),
    total_volume_15m_usd: round(total, 2),
    total_volume_vs_prev20_pct: round(total == null || avg20 == null || avg20 === 0 ? null : total / avg20 * 100),
    total_volume_vs_prev120_pct: round(total == null || avg120 == null || avg120 === 0 ? null : total / avg120 * 100),
    lucy_1h: lucyAt(lucy1h, H1, key),
    lucy_4h: lucyAt(lucy4h, H4, key),
    liq_long_15m_usd: round(liq?.longUsd ?? null, 2),
    liq_short_15m_usd: round(liq?.shortUsd ?? null, 2),
    fut_history_missing: f == null,
    spot_history_missing: s == null,
    oi_history_missing: valueAt(oiMap, key)?.value == null,
    liquidation_history_missing: liq == null,
  };
}

async function main(): Promise<void> {
  const events = loadEvents();
  if (events.length !== 145) {
    throw new Error(`Expected exactly 145 A signals from the existing export; found ${events.length}`);
  }
  const now = Date.now();
  const symbols = [...new Set(events.map((event) => String(event.symbol)))].sort();
  const perSymbol = new Map<string, Obj[]>();
  for (const event of events) {
    const rows = perSymbol.get(event.symbol) ?? [];
    rows.push(event);
    perSymbol.set(event.symbol, rows);
  }
  const priceBySymbol = new Map<string, Candle[]>();
  for (const symbol of symbols) {
    const latestEventEnd = Math.max(
      ...perSymbol
        .get(symbol)!
        .map((event) => Math.min((event.entryAt as number) + HORIZON, now)),
    );
    const earliestAnchor = Math.min(
      ...perSymbol
        .get(symbol)!
        .map((event) => (event.armAt as number) - 21 * D1),
    );
    const bars = await klines(CACHE, symbol, "15m", earliestAnchor - D1, latestEventEnd);
    priceBySymbol.set(symbol, bars);
  }
  const classified = events.map((event) =>
    classify(event, priceBySymbol.get(String(event.symbol)) ?? [], now),
  );
  const counts = Object.fromEntries(
    ["good", "bad", "open", "censored", "ambiguous"].map((group) => [
      group,
      classified.filter((event) => event.outcome === group).length,
    ]),
  );
  log(`A loaded: ${classified.length} signals; symbols=${symbols.length}; outcomes=${JSON.stringify(counts)}`);

  const requiredBySymbol = new Map<string, { start: number; end: number }>();
  for (const symbol of symbols) {
    const rows = perSymbol.get(symbol)!;
    requiredBySymbol.set(symbol, {
      start: Math.min(...rows.map((event) => (event.armAt as number) - 21 * D1)),
      end: Math.max(...rows.map((event) => Math.min((event.entryAt as number) + HORIZON, now))),
    });
  }
  const work: Array<{ symbol: string; kind: keyof typeof ENDPOINTS; start: number; end: number }> = [];
  const kinds: Array<keyof typeof ENDPOINTS> = ["fut", "spot", "oi", "liq"];
  for (const symbol of symbols) {
    const range = requiredBySymbol.get(symbol)!;
    for (const kind of kinds) {
      const path = join(CACHE, `${symbol}_cg15m_${kind}.json`);
      const cache = readCache<any>(path);
      const items = cache.items
        .filter((row) => itemTime(row) > 0)
        .sort((a, b) => itemTime(a) - itemTime(b));
      const first = items.length ? itemTime(items[0]) : null;
      const last = items.length ? itemTime(items.at(-1)) : null;
      if (first == null) {
        work.push({ symbol, kind, start: range.start, end: range.end });
      } else {
        if (first > range.start + M15) {
          work.push({ symbol, kind, start: range.start, end: first });
        }
        if (last != null && last + M15 < range.end) {
          work.push({ symbol, kind, start: last + M15, end: range.end });
        }
      }
    }
  }
  log(`Planned CoinGlass requests after cache reuse: ${work.length}; rate=${RPM}/min; no parallel calls.`);
  if (process.env.CoinGlassAPI == null || !process.env.CoinGlassAPI.trim()) {
    throw new Error("CoinGlass key is unavailable in this process; no external call was made.");
  }
  for (const item of work) {
    await ensureHistory(item.symbol, item.kind, item.start, item.end);
  }

  const dataBySymbol = new Map<string, Obj>();
  for (const symbol of symbols) {
    const readItems = (kind: keyof typeof ENDPOINTS) =>
      readCache<any>(join(CACHE, `${symbol}_cg15m_${kind}.json`)).items;
    const futRows = readItems("fut") as FlowBar[];
    const spotRows = readItems("spot") as FlowBar[];
    const oiRows = readItems("oi") as ScalarBar[];
    const liqRows = readItems("liq") as any[];
    const futMap = mapByTime(futRows);
    const spotMap = mapByTime(spotRows);
    const oiMap = mapByTime(oiRows);
    const liqMap = mapByTime(liqRows);
    const futVol = new Map(futRows.map((row) => [row.time, (row.buy ?? 0) + (row.sell ?? 0)]));
    const spotVol = new Map(spotRows.map((row) => [row.time, (row.buy ?? 0) + (row.sell ?? 0)]));
    const totalVol = new Map<number, number>();
    for (const [time, value] of futVol) {
      totalVol.set(time, value + (spotVol.get(time) ?? 0));
    }
    const range = requiredBySymbol.get(symbol)!;
    const lucy1h = bucketVolumes(futMap, spotMap, H1, range.start, range.end);
    const lucy4h = bucketVolumes(futMap, spotMap, H4, range.start, range.end);
    dataBySymbol.set(symbol, {
      futRows,
      spotRows,
      oiRows,
      liqRows,
      futMap,
      spotMap,
      oiMap,
      liqMap,
      futVol,
      spotVol,
      totalVol,
      lucy1h,
      lucy4h,
      priceMap: new Map((priceBySymbol.get(symbol) ?? []).map((row) => [row.time, row])),
    });
  }

  const t0Rows: Obj[] = [];
  const pathRows: Obj[] = [];
  const metricPoints = [
    { point: "entry", delta: null as number | null },
    { point: "T0-60m", delta: -60 },
    { point: "T0-45m", delta: -45 },
    { point: "T0-30m", delta: -30 },
    { point: "T0-15m", delta: -15 },
    { point: "T0", delta: 0 },
    { point: "T0+15m", delta: 15 },
    { point: "T0+30m", delta: 30 },
  ];
  for (const event of classified) {
    const symbol = String(event.symbol);
    const data = dataBySymbol.get(symbol)!;
    const priceBars = priceBySymbol.get(symbol) ?? [];
    const rawMetrics = (time: number) =>
      metricsAt(
        time,
        data.priceMap,
        data.futMap,
        data.spotMap,
        data.oiMap,
        data.liqMap,
        data.futVol,
        data.spotVol,
        data.totalVol,
        data.lucy1h,
        data.lucy4h,
      );
    if (event.outcome === "good" && event.t0At != null) {
      for (const point of metricPoints) {
        const time =
          point.delta == null
            ? (event.entryAt as number)
            : (event.t0At as number) + point.delta * 60_000;
        const metrics = rawMetrics(time);
        t0Rows.push({
          id: event.id,
          symbol,
          detected_at: iso(event.entryAt),
          status: event.status,
          outcome: event.outcome,
          target_at: iso(event.targetAt),
          t0_candle_open: iso(event.t0At),
          t0_candle_close: iso((event.t0At as number) + M15),
          t0_low: round(event.t0Low),
          point: point.point,
          sample_at: iso(time),
          sample_bar_at: metrics.price_time,
          ...metrics,
        });
      }
    }
    if (["bad", "open", "censored", "ambiguous"].includes(event.outcome)) {
      const end = Math.min((event.entryAt as number) + HORIZON, now);
      for (const bar of priceBars) {
        if (bar.time + M15 <= (event.entryAt as number) || bar.time >= end) continue;
        pathRows.push({
          id: event.id,
          symbol,
          detected_at: iso(event.entryAt),
          status: event.status,
          outcome: event.outcome,
          outcome_reason: event.outcomeReason,
          price_bar_at: iso(bar.time),
          ...rawMetrics(bar.time),
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
    entry_price: n(event.entry_price),
    arm_at: iso(event.armAt),
    arm_time_proxy: event.armTimeProxy,
    history_start: iso((event.armAt as number) - 21 * D1),
    price_outcome_96h: event.outcome,
    outcome_reason: event.outcomeReason,
    horizon_complete: event.horizonComplete,
    observed_until: iso(event.observedUntil),
    observed_15m_bars: event.observedBars,
    target10_at: iso(event.targetAt),
    stop6_at: iso(event.stopAt),
    ambiguous_at: iso(event.ambiguousAt),
    t0_candle_open: iso(event.t0At),
    t0_candle_low: round(event.t0Low),
    source_status: event.status,
  }));
  writeCsv(join(OUT, "events.csv"), eventRows, Object.keys(eventRows[0] ?? {}));
  const t0Columns = Object.keys(t0Rows[0] ?? { id: "", symbol: "", point: "" });
  writeCsv(join(OUT, "t0.csv"), t0Rows, t0Columns);
  const pathColumns = Object.keys(pathRows[0] ?? { id: "", symbol: "", price_bar_at: "" });
  writeCsv(join(OUT, "path15m.csv"), pathRows, pathColumns);
  writeFileSync(join(OUT, "errors.json"), JSON.stringify(errors, null, 2) + "\n");
  const good = classified.filter((event) => event.outcome === "good");
  const unresolved = classified.filter((event) => event.outcome === "censored");
  const t0Text = good
    .map((event) => `${event.id} ${event.symbol} ${iso(event.t0At)} low=${event.t0Low} first+10=${iso(event.targetAt)}`)
    .join("\n");
  const summary = [
    "# ABNeon history study — part A (interim)",
    "",
    `Signals: ${classified.length}; unique symbols: ${symbols.length}.`,
    `Outcomes using 15m BingX OHLC, entry-to-96h: ${JSON.stringify(counts)}.`,
    `CoinGlass requests completed: ${requestCount}; by endpoint: ${JSON.stringify(requestsByEndpoint)}; API 429: ${api429Count}; five-minute pauses: ${pauses429}.`,
    `T0 definition: the 15m candle with the lowest low from entry through the first candle reaching +10%; same-candle +10% and -6% is labeled ambiguous, not guessed.`,
    `Censored/not-yet-matured signals: ${unresolved.length}.`,
    "",
    "## Good signals and T0",
    "",
    t0Text || "(none)",
    "",
    "## T0 sampling",
    "",
    `Rows in t0.csv: ${t0Rows.length}; path15m.csv rows for bad/open/censored/ambiguous: ${pathRows.length}.`,
    "Missing CoinGlass values remain blank; errors.json records unavailable histories. Lucy 1H/4H colors use the project lucyColour implementation on aggregate futures+spot USD volume.",
    "",
    `Generated at ${new Date().toISOString()}.`,
  ].join("\n");
  writeFileSync(join(OUT, "summary.md"), `${summary}\n`);
  writeFileSync(join(OUT, "run.txt"), `${runLog.slice(-30).join("\n")}\n`);
  log(`A complete: CG requests=${requestCount}; t0_rows=${t0Rows.length}; path15m_rows=${pathRows.length}; output=${OUT}`);
  writeFileSync(join(OUT, "run.txt"), `${runLog.slice(-30).join("\n")}\n`);
}

void import("./study-a.ts").catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  writeFileSync(join(OUT, "fatal.txt"), `${message}\n`);
  process.exitCode = 1;
});
