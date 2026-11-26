import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
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
  welkinColour,
} from "../../artifacts/api-server/src/lib/abneon-volume-gate.js";

type Obj = Record<string, any>;
type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};
type Flow = {
  time: number;
  buy: number | null;
  sell: number | null;
  cvd?: number | null;
};
type Scalar = {
  time: number;
  value: number | null;
  longUsd?: number | null;
  shortUsd?: number | null;
  funding?: number | null;
};
type Span = { from: number; to: number; reason?: string };

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const SOURCE = join(HERE, ".source");
const CACHE = join(ROOT, "reports/.cache");
const OUT = HERE;
const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;
const D1 = 24 * H1;
// 48×1H Wyckoff window + 20×1H VSA baseline; also covers Lucy's 120×15m baseline.
const PRE_BARS = 272;
const POST = 5 * D1;
// Shared CoinGlass key: use a conservative six requests per minute.
const RATE_GAP_MS = 10_000;
const LIMIT = 4_500;
const OFFLINE_RECALC = process.env.STUDY_OFFLINE === "1";
const TARGET_PCT = 10;
const STOP_PCT = -10;
const ENDPOINTS = {
  aggfut: "/api/futures/aggregated-taker-buy-sell-volume/history",
  aggspot: "/api/spot/aggregated-cvd/history",
  oi: "/api/futures/open-interest/aggregated-history",
  liq: "/api/futures/liquidation/aggregated-history",
  funding: "/api/futures/funding-rate/aggregated-history",
} as const;
type Kind = keyof typeof ENDPOINTS;

const requestedAsOf = process.env.STUDY_AS_OF
  ? Date.parse(process.env.STUDY_AS_OF)
  : NaN;
const now = Number.isFinite(requestedAsOf) ? requestedAsOf : Date.now();
const latestClosed = Math.floor(now / M15) * M15 - M15;
process.env.NODE_ENV = "production";
mkdirSync(OUT, { recursive: true });
mkdirSync(CACHE, { recursive: true });

const runLines: string[] = [];
const errors: Obj[] = [];
const callsByKind: Record<string, number> = {};
const FETCH_RUN = join(OUT, "run-fetch.txt");
const FETCH_ERRORS = join(OUT, "errors-fetch.json");
const PRIOR_REQUESTS = Number(process.env.STUDY_PRIOR_REQUESTS ?? "0");
const PRIOR_FAILURES = Number(process.env.STUDY_PRIOR_FAILURES ?? "0");
const PRIOR_RETRIES_429 = Number(process.env.STUDY_PRIOR_RETRIES_429 ?? "0");
const pendingByKind: Record<Kind, number> = {
  aggfut: 0,
  aggspot: 0,
  oi: 0,
  liq: 0,
  funding: 0,
};
const disabledKinds = new Set<Kind>();
let requestCount = PRIOR_REQUESTS;
let failedCalls = PRIOR_FAILURES;
let retry429 = PRIOR_RETRIES_429;
let plannedRanges = 0;
let completedRanges = 0;
let lastRequestAt = 0;
let lastProgressBucket = 0;
let unsupportedFunding = false;
let priorFetchStatsLoaded = false;
if (OFFLINE_RECALC) {
  if (existsSync(FETCH_ERRORS)) {
    const priorErrors = JSON.parse(readFileSync(FETCH_ERRORS, "utf8")) as Obj[];
    if (Array.isArray(priorErrors)) errors.push(...priorErrors);
  }
  if (existsSync(FETCH_RUN)) {
    const completion = readFileSync(FETCH_RUN, "utf8")
      .split(/\r?\n/)
      .find((line) => line.includes("Study complete: requests=")
        || line.includes("Study fetch complete: requests="));
    const match = completion?.match(
      /(?:Study complete|Study fetch complete): requests=(\d+) failures=(\d+) retry429=(\d+) elapsed_seconds=\d+ by_kind=(\{[^}]*\}) funding_unsupported=(true|false)/,
    );
    if (match) {
      requestCount = Number(match[1]);
      failedCalls = Number(match[2]);
      retry429 = Number(match[3]);
      Object.assign(callsByKind, JSON.parse(match[4]!));
      unsupportedFunding = match[5] === "true";
      if (OFFLINE_RECALC && unsupportedFunding) disabledKinds.add("funding");
      priorFetchStatsLoaded = true;
    }
  }
  if (!priorFetchStatsLoaded)
    throw new Error("STUDY_OFFLINE requires run-fetch.txt with the completed CoinGlass fetch summary");
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  runLines.push(line);
  console.log(message);
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 1e12 ? value * 1000 : value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const valueNum = Number(value);
  return Number.isFinite(valueNum) ? valueNum : null;
}

function iso(value: number | null | undefined): string {
  return value == null ? "" : new Date(value).toISOString();
}

function round(value: number | null | undefined, digits = 6): number | "" {
  return value == null || !Number.isFinite(value)
    ? ""
    : Number(value.toFixed(digits));
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

function readJsonl(path: string): Obj[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Obj);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text =
    typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(path: string, rows: Obj[], columns: string[]): void {
  writeFileSync(
    path,
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
    ].join("\n") + "\n",
  );
}

function readBars(file: string): Bar[] {
  const cache = readJson(join(CACHE, file));
  const items = Array.isArray(cache?.items) ? cache.items : [];
  return items
    .map((row: any) =>
      Array.isArray(row)
        ? {
            time: timeMs(row[0]) ?? 0,
            open: num(row[1]) ?? NaN,
            high: num(row[2]) ?? NaN,
            low: num(row[3]) ?? NaN,
            close: num(row[4]) ?? NaN,
            volume: num(row[5]) ?? undefined,
          }
        : {
            time: timeMs(row.time) ?? 0,
            open: num(row.open) ?? NaN,
            high: num(row.high) ?? NaN,
            low: num(row.low) ?? NaN,
            close: num(row.close) ?? NaN,
            volume: num(row.volume) ?? undefined,
          },
    )
    .filter(
      (bar: Bar) =>
        bar.time > 0 &&
        [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) &&
        bar.low > 0,
    )
    .sort((a: Bar, b: Bar) => a.time - b.time);
}

function readSeries(path: string): {
  from: number | null;
  to: number | null;
  items: any[];
  coverage: Span[];
} {
  const cache = readJson(path);
  const items = Array.isArray(cache?.items)
    ? [...cache.items].sort(
        (a: any, b: any) => (timeMs(a.time) ?? 0) - (timeMs(b.time) ?? 0),
      )
    : [];
  const coverage = Array.isArray(cache?.coverage)
    ? cache.coverage
        .map((span: any) => ({
          from: timeMs(span.from),
          to: timeMs(span.to),
          reason: typeof span.reason === "string" ? span.reason : undefined,
        }))
        .filter(
          (span: any): span is Span =>
            span.from != null && span.to != null && span.to >= span.from,
        )
    : [];
  const from = timeMs(cache?.from);
  const to = timeMs(cache?.to);
  if (coverage.length === 0 && from != null && to != null && to >= from) {
    coverage.push({ from, to, reason: "legacy_cache_range" });
  }
  return { from, to, items, coverage };
}

function normalizeRows(kind: Kind, rows: Obj[]): any[] {
  return rows
    .map((row) => {
      const time = timeMs(row.time);
      if (time == null) return null;
      if (kind === "aggfut") {
        return {
          time,
          buy: num(row.aggregated_buy_volume_usd),
          sell: num(row.aggregated_sell_volume_usd),
        };
      }
      if (kind === "aggspot") {
        return {
          time,
          buy: num(row.agg_taker_buy_vol),
          sell: num(row.agg_taker_sell_vol),
          cvd: num(row.cum_vol_delta),
        };
      }
      if (kind === "oi") return { time, value: num(row.close) };
      if (kind === "liq") {
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
        };
      }
      return {
        time,
        value: null,
        funding:
          firstNumeric(row, [
            "aggregated_funding_rate",
            "funding_rate",
            "rate",
          ]) ?? null,
      };
    })
    .filter(Boolean);
}

function firstNumeric(row: Obj, keys: string[]): number | null {
  for (const key of keys) {
    const value = num(row[key]);
    if (value != null) return value;
  }
  return null;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.from <= last.to + M15) {
      last.to = Math.max(last.to, span.to);
      if (last.reason !== span.reason) last.reason = "mixed";
    } else merged.push({ ...span });
  }
  return merged;
}

function missingSpans(requiredFrom: number, requiredTo: number, coverage: Span[]): Span[] {
  const covered = mergeSpans(coverage);
  const missing: Span[] = [];
  let cursor = requiredFrom;
  for (const span of covered) {
    if (span.to < cursor) continue;
    if (span.from > requiredTo) break;
    if (span.from > cursor) missing.push({ from: cursor, to: Math.min(requiredTo, span.from - M15) });
    cursor = Math.max(cursor, span.to + M15);
    if (cursor > requiredTo) break;
  }
  if (cursor <= requiredTo) missing.push({ from: cursor, to: requiredTo });
  return missing
    .filter((span) => span.to >= span.from)
    .map((span) => ({
      from: Math.floor(span.from / M15) * M15,
      to: Math.floor(span.to / M15) * M15,
    }));
}

function saveSeries(path: string, state: { coverage: Span[]; items: any[] }): void {
  const coverage = mergeSpans(state.coverage);
  writeFileSync(
    path,
    JSON.stringify({
      from: coverage.length ? Math.min(...coverage.map((x) => x.from)) : null,
      to: coverage.length ? Math.max(...coverage.map((x) => x.to)) : null,
      coverage,
      items: [...new Map(state.items.map((row) => [row.time, row])).values()].sort(
        (a, b) => a.time - b.time,
      ),
    }),
  );
}

function urlFor(kind: Kind, symbol: string, from: number, to: number): string {
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const start = Math.floor(from / M15) * M15;
  const end = Math.floor(to / M15) * M15;
  const url = new URL(`https://open-api-v4.coinglass.com${ENDPOINTS[kind]}`);
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", "15m");
  url.searchParams.set("start_time", String(start));
  url.searchParams.set("end_time", String(end));
  url.searchParams.set(
    "limit",
    String(Math.min(LIMIT, Math.ceil((end - start) / M15) + 4)),
  );
  if (kind === "aggfut" || kind === "liq")
    url.searchParams.set("exchange_list", getAllFuturesExchanges());
  if (kind === "aggspot")
    url.searchParams.set("exchange_list", getAllSpotExchanges());
  return url.toString();
}

function dubai(value: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function progress(): void {
  const remaining = Math.max(0, plannedRanges - completedRanges);
  const eta = Date.now() + remaining * RATE_GAP_MS + retry429 * 300_000;
  const line = `CG_PROGRESS requests=${requestCount} done=${completedRanges}/${plannedRanges} remaining=${remaining} ETA_Dubai=${dubai(eta)} errors=${failedCalls}`;
  log(line);
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
}

async function pace(): Promise<void> {
  const wait = lastRequestAt + RATE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolveSleep) => setTimeout(resolveSleep, wait));
  lastRequestAt = Date.now();
}

async function fetchRange(
  symbol: string,
  kind: Kind,
  from: number,
  to: number,
): Promise<{ items: any[]; reason?: string }> {
  const label = `${kind}:${symbol}:${iso(from)}..${iso(to)}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const key = getNextCgKey();
    if (!key) return { items: [], reason: "coinglass_key_unavailable" };
    await pace();
    requestCount++;
    callsByKind[kind] = (callsByKind[kind] ?? 0) + 1;
    try {
      const response = await cgTimedFetch(
        urlFor(kind, symbol, from, to),
        {
          headers: { "CG-API-KEY": key, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
        { priority: "low", endpoint: ENDPOINTS[kind].replace(/^\/api\//, "") },
      );
      if (response.status === 429) {
        retry429++;
        log(`HTTP 429; pausing five minutes before retry (${label})`);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 300_000));
        continue;
      }
      if (!response.ok) {
        if (kind === "funding" && [400, 404, 422].includes(response.status)) {
          unsupportedFunding = true;
          disabledKinds.add(kind);
        }
        return { items: [], reason: `http_${response.status}` };
      }
      const body = (await response.json()) as {
        code?: unknown;
        msg?: unknown;
        data?: Obj[];
      };
      if (String(body.code) === "429") {
        retry429++;
        log(`CoinGlass code 429; pausing five minutes before retry (${label})`);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 300_000));
        continue;
      }
      if (String(body.code) !== "0") {
        const reason = `api_code_${String(body.code)}:${String(body.msg ?? "").slice(0, 120)}`;
        if (kind === "funding") {
          unsupportedFunding = true;
          disabledKinds.add(kind);
        }
        return { items: [], reason };
      }
      const rows = normalizeRows(kind, Array.isArray(body.data) ? body.data : []);
      return rows.length ? { items: rows } : { items: [], reason: "no_data" };
    } catch (error) {
      const reason = error instanceof Error ? error.name : "request_error";
      if (attempt === 5) return { items: [], reason };
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000));
    }
  }
  return { items: [], reason: "retry_limit" };
}

async function ensureHistory(
  symbol: string,
  kind: Kind,
  from: number,
  to: number,
): Promise<any[]> {
  const path = join(CACHE, `${symbol}_cg15m_${kind}.json`);
  const initial = readSeries(path);
  const state = { coverage: initial.coverage, items: initial.items };
  const gaps = missingSpans(from, to, state.coverage).flatMap((gap) => {
    const chunks: Span[] = [];
    for (
      let start = gap.from;
      start <= gap.to;
      start += (LIMIT - 4) * M15
    ) {
      chunks.push({
        from: start,
        to: Math.min(gap.to, start + (LIMIT - 4) * M15),
      });
    }
    return chunks;
  });
  if (OFFLINE_RECALC) {
    if (gaps.length)
      log(`STUDY_OFFLINE: skipped ${gaps.length} uncached range(s) for ${kind}:${symbol}`);
    return state.items;
  }
  for (const gap of gaps) {
    if (disabledKinds.has(kind)) break;
    const result = await fetchRange(symbol, kind, gap.from, gap.to);
    state.items.push(...result.items);
    if (result.reason === "no_data") {
      state.coverage.push({ ...gap, reason: "no_data" });
    } else if (result.reason) {
      failedCalls++;
      errors.push({ symbol, kind, from: iso(gap.from), to: iso(gap.to), reason: result.reason });
    } else {
      state.coverage.push(gap);
    }
    completedRanges++;
    pendingByKind[kind] = Math.max(0, pendingByKind[kind] - 1);
    if (disabledKinds.has(kind) && pendingByKind[kind] > 0) {
      plannedRanges -= pendingByKind[kind];
      pendingByKind[kind] = 0;
    }
    saveSeries(path, state);
    const bucket = Math.floor(requestCount / 50);
    if (bucket > lastProgressBucket) {
      lastProgressBucket = bucket;
      progress();
    }
  }
  saveSeries(path, state);
  return state.items;
}

function loadEvents(): Obj[] {
  const signals = readJsonl(join(SOURCE, "signals.jsonl"));
  const watchFiles = readdirSync(SOURCE).filter((name) =>
    /^watches-(?:\d{3}|rest-\d{4})\.jsonl$/.test(name),
  );
  const watches = watchFiles.flatMap((name) => readJsonl(join(SOURCE, name)));
  const chains = new Map<number, Obj>();
  for (const name of readdirSync(SOURCE).filter((file) =>
    /^chain-summary-\d{4}\.jsonl$/.test(file),
  )) {
    for (const row of readJsonl(join(SOURCE, name)))
      chains.set(Number(row.watch_id), row);
  }
  const candidateMeta = new Map<string, Obj>();
  for (const name of readdirSync(SOURCE).filter((file) =>
    /^candidate-meta-\d{3}\.jsonl$/.test(file),
  )) {
    for (const row of readJsonl(join(SOURCE, name)))
      candidateMeta.set(String(row.candidate_id), row);
  }
  const candidates = readJsonl(join(SOURCE, "candidates.jsonl")).filter(
    (candidate) => candidate.outcome === "champion",
  );
  const result: Obj[] = [];
  for (const signal of signals) {
    const detectedAt = timeMs(signal.detected_at);
    if (detectedAt == null || num(signal.entry_price) == null) continue;
    result.push({
      cohort: "A_signal",
      event_id: `signal-${signal.id}`,
      id: signal.id,
      symbol: signal.symbol,
      eventAt: detectedAt,
      priceStartAt: Math.ceil(detectedAt / M15) * M15,
      entry: num(signal.entry_price),
      marketCap: num(signal.market_cap_usd),
      source: signal,
    });
  }
  for (const watch of watches) {
    if (watch.signal_id != null) continue;
    const detectedAt = timeMs(watch.detected_at);
    if (detectedAt == null || num(watch.price_at_detect) == null) continue;
    result.push({
      cohort: "B_watch",
      event_id: `watch-${watch.id}`,
      id: watch.id,
      symbol: watch.symbol,
      eventAt: detectedAt,
      priceStartAt: Math.ceil(detectedAt / M15) * M15,
      entry: num(watch.price_at_detect),
      marketCap:
        num(watch.market_cap_usd) ??
        (() => {
          const spotVolume = num(watch.spot_vol24h_at_detect);
          const spotPct = num(watch.spot_vol_mcap_pct);
          return spotVolume != null && spotPct != null && spotPct > 0
            ? spotVolume / (spotPct / 100)
            : null;
        })(),
      source: watch,
      chain: chains.get(Number(watch.id)) ?? null,
    });
  }
  for (const candidate of candidates) {
    const eventAt = timeMs(candidate.lowAt ?? candidate.detectedAt);
    if (eventAt == null || num(candidate.low) == null) continue;
    const candidateId = `${candidate.symbol}:${candidate.lowAt}`;
    const meta = candidateMeta.get(candidateId) ?? null;
    const botSignal = meta?.signal ?? null;
    const botSnapshot = meta?.decision ?? null;
    const snapshotMetrics =
      botSnapshot?.entry_metrics && typeof botSnapshot.entry_metrics === "object"
        ? botSnapshot.entry_metrics
        : {};
    result.push({
      cohort: "C_champion",
      event_id: `champion-${candidateId}`,
      id: candidateId,
      symbol: candidate.symbol,
      eventAt,
      priceStartAt: eventAt + M15,
      entry: num(candidate.low),
      marketCap:
        num(botSignal?.market_cap_usd) ??
        firstNumeric(snapshotMetrics, ["marketCapUsd", "market_cap_usd", "marketCap"]) ??
        firstNumeric(botSignal?.decision_metrics ?? {}, [
          "marketCapUsd",
          "market_cap_usd",
          "marketCap",
        ]),
      source: candidate,
      botMeta: meta,
    });
  }
  return result.sort((a, b) => a.eventAt - b.eventAt);
}

function toMap<T extends { time: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((row) => [row.time, row]));
}

function lowerBoundTime<T extends { time: number }>(rows: T[], time: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]!.time < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundTime<T extends { time: number }>(rows: T[], time: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid]!.time <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function exactIndex<T extends { time: number }>(rows: T[], time: number): number {
  const target = Math.floor(time / M15) * M15;
  const index = lowerBoundTime(rows, target);
  return rows[index]?.time === target ? index : -1;
}

function barsWindow<T extends { time: number }>(
  rows: T[],
  start: number,
  end: number,
): T[] {
  return rows.slice(lowerBoundTime(rows, start), upperBoundTime(rows, end));
}

function sumFlow(rows: Flow[], start: number, end: number): {
  buy: number | null;
  sell: number | null;
  count: number;
} {
  const inRange = barsWindow(rows, start, end).filter(
    (row) => row.buy != null && row.sell != null,
  );
  if (!inRange.length) return { buy: null, sell: null, count: 0 };
  return {
    buy: inRange.reduce((sum, row) => sum + row.buy!, 0),
    sell: inRange.reduce((sum, row) => sum + row.sell!, 0),
    count: inRange.length,
  };
}

function sumScalar(rows: Scalar[], start: number, end: number, key: "longUsd" | "shortUsd"): number | null {
  const inRange = barsWindow(rows, start, end).filter((row) => row[key] != null);
  return inRange.length ? inRange.reduce((sum, row) => sum + row[key]!, 0) : null;
}

const sampleIndexes = new WeakMap<object, Map<number, unknown>>();

function sampleAt<T extends { time: number }>(rows: T[], time: number): T | null {
  const target = Math.floor(time / M15) * M15;
  let index = sampleIndexes.get(rows);
  if (!index) {
    index = new Map<number, unknown>();
    for (const row of rows) {
      if (!index.has(row.time)) index.set(row.time, row);
    }
    sampleIndexes.set(rows, index);
  }
  return (index.get(target) as T | undefined) ?? null;
}

function candleAt(rows: Bar[], time: number): Bar | null {
  return sampleAt(rows, time);
}

function pctChange(value: number | null, prior: number | null): number | null {
  return value == null || prior == null || prior === 0
    ? null
    : ((value / prior) - 1) * 100;
}

function aggregateVolumeAt(
  fut: Flow[],
  spot: Flow[],
  time: number,
): number | null {
  const f = sampleAt(fut, time);
  if (!f || f.buy == null || f.sell == null) return null;
  const s = sampleAt(spot, time);
  return f.buy + f.sell + (s?.buy ?? 0) + (s?.sell ?? 0);
}

function mapVolumes(
  priceBars: Bar[],
  fut: Flow[],
  spot: Flow[],
  useBingx: boolean,
): Map<number, number> {
  const result = new Map<number, number>();
  for (const candle of priceBars) {
    if (candle.time > latestClosed) continue;
    if (useBingx) {
      if (candle.volume != null && candle.volume >= 0)
        result.set(candle.time, candle.volume * candle.close);
      continue;
    }
    const volume = aggregateVolumeAt(fut, spot, candle.time);
    if (volume != null) result.set(candle.time, volume);
  }
  return result;
}

function calculateIndicators(
  priceBars: Bar[],
  volumeByTime: Map<number, number>,
  time: number,
  welkinVolumeByTime: Map<number, number> = volumeByTime,
): Obj {
  const idx = exactIndex(priceBars, time);
  if (idx < 0) return {};
  // Only the preceding 120 bars (plus one prior close) affect these indicators.
  const tail = priceBars.slice(Math.max(0, idx - 120), idx + 1);
  const v = tail.map((bar) => volumeByTime.get(bar.time) ?? NaN);
  const welkinV = tail.map((bar) => welkinVolumeByTime.get(bar.time) ?? NaN);
  const valid120 = tail.length >= 120 && v.slice(-120).every(Number.isFinite);
  const valid20 =
    tail.length >= 20 && welkinV.slice(-20).every(Number.isFinite);
  const mfiN = 14;
  let positive = 0;
  let negative = 0;
  const mfiStart = tail.length - mfiN;
  const mfiVolumeComplete =
    tail.length >= mfiN + 1 &&
    v.slice(mfiStart).every(Number.isFinite);
  if (mfiVolumeComplete) {
    for (let i = tail.length - mfiN; i < tail.length; i++) {
      const prev = tail[i - 1]!;
      const bar = tail[i]!;
      const prevTp = (prev.high + prev.low + prev.close) / 3;
      const tp = (bar.high + bar.low + bar.close) / 3;
      const flow = tp * (v[i] || 0);
      if (tp > prevTp) positive += flow;
      else if (tp < prevTp) negative += flow;
    }
  }
  const mfi =
    mfiVolumeComplete
      ? negative === 0
        ? 100
        : 100 - 100 / (1 + positive / negative)
      : null;
  const cmfN = 20;
  const cmfRows = tail.slice(-cmfN);
  let mfv = 0;
  let volSum = 0;
  if (
    cmfRows.length === cmfN &&
    cmfRows.every((bar) => Number.isFinite(volumeByTime.get(bar.time)))
  ) {
    for (const bar of cmfRows) {
      const volume = volumeByTime.get(bar.time)!;
      const multiplier =
        bar.high === bar.low
          ? 0
          : ((bar.close - bar.low) - (bar.high - bar.close)) /
            (bar.high - bar.low);
      mfv += multiplier * volume;
      volSum += volume;
    }
  }
  const cmf = volSum > 0 ? mfv / volSum : null;
  let obv = 0;
  let obvCount = 0;
  const obvStart = tail.length - 120;
  const obvComplete =
    tail.length >= 121 &&
    tail.slice(-120).every((bar) => Number.isFinite(volumeByTime.get(bar.time)));
  if (obvComplete) {
    for (let i = Math.max(1, obvStart); i < tail.length; i++) {
      const curr = tail[i]!;
      const prev = tail[i - 1]!;
      const vol = volumeByTime.get(curr.time)!;
      obv += curr.close > prev.close ? vol : curr.close < prev.close ? -vol : 0;
      obvCount++;
    }
  }
  const lucy = valid120
    ? lucyColour(v.slice(-120), 119)
    : null;
  const welkin = valid20
    ? welkinColour(welkinV.slice(-20), 19)
    : null;
  return {
    mfi14: mfi,
    cmf20: cmf,
    obv120: obvCount ? obv : null,
    lucy120: lucy,
    welkin20: welkin,
    volumeBars120: valid120 ? 120 : v.slice(-120).filter(Number.isFinite).length,
    volumeBars20: valid20 ? 20 : welkinV.slice(-20).filter(Number.isFinite).length,
  };
}

function resample1h(priceBars: Bar[], volByTime: Map<number, number>): {
  bars: Bar[];
  volumes: Map<number, number>;
} {
  const groups = new Map<number, Bar[]>();
  for (const bar of priceBars) {
    const t = Math.floor(bar.time / H1) * H1;
    const list = groups.get(t) ?? [];
    list.push(bar);
    groups.set(t, list);
  }
  const bars: Bar[] = [];
  const volumes = new Map<number, number>();
  for (const [time, group] of groups) {
    if (
      group.length !== 4 ||
      group.some((bar, i) => bar.time !== time + i * M15)
    )
      continue;
    bars.push({
      time,
      open: group[0]!.open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group.at(-1)!.close,
    });
    const vals = group.map((bar) => volByTime.get(bar.time));
    if (vals.every((value) => value != null)) volumes.set(time, vals.reduce((sum, value) => sum + value!, 0));
  }
  return { bars: bars.sort((a, b) => a.time - b.time), volumes };
}

const resampledByVolumeMap = new WeakMap<
  Map<number, number>,
  { bars: Bar[]; volumes: Map<number, number> }
>();

function wyckoffAt(
  priceBars: Bar[],
  volByTime: Map<number, number>,
  time: number,
): Obj {
  let h1 = resampledByVolumeMap.get(volByTime);
  if (!h1) {
    h1 = resample1h(priceBars, volByTime);
    resampledByVolumeMap.set(volByTime, h1);
  }
  const target = Math.floor(time / H1) * H1;
  const foundIndex = lowerBoundTime(h1.bars, target);
  const idx = h1.bars[foundIndex]?.time === target ? foundIndex : -1;
  if (idx < 40) return { status: "insufficient_history" };
  const start = Math.max(0, idx - 48);
  const win = h1.bars.slice(start, idx + 1);
  const top = Math.max(...win.map((bar) => bar.high));
  const bottom = Math.min(...win.map((bar) => bar.low));
  const height = top - bottom;
  const events: Array<{ type: string; time: string; level: number | null }> = [];
  const vsa = new Map<number, Obj>();
  const classifyVsa = (i: number): Obj | null => {
    const candle = h1.bars[i]!;
    const prior = h1.bars.slice(Math.max(0, i - 20), i);
    if (prior.length < 20) return null;
    const currentVol = h1.volumes.get(candle.time);
    const priorVols = prior.map((bar) => h1.volumes.get(bar.time));
    if (currentVol == null || priorVols.some((value) => value == null)) return null;
    const spread = candle.high - candle.low;
    const avgSpread =
      prior.reduce((sum, bar) => sum + bar.high - bar.low, 0) / 20;
    const avgVol = (priorVols as number[]).reduce((sum, value) => sum + value, 0) / 20;
    const spreadRatio = avgSpread > 0 ? spread / avgSpread : null;
    const volumeRatio = avgVol > 0 ? currentVol / avgVol : null;
    const closePosition = spread > 0 ? (candle.close - candle.low) / spread : null;
    const direction =
      candle.close > candle.open
        ? "up"
        : candle.close < candle.open
          ? "down"
          : "flat";
    let label = "neutral";
    if (spreadRatio == null || volumeRatio == null || closePosition == null)
      return null;
    if (spreadRatio >= 1.5 && volumeRatio >= 2) label = "climax";
    else if (volumeRatio >= 1.5 && spreadRatio < 0.8)
      label = "effort_no_result";
    else if (direction === "up" && spreadRatio < 0.8 && volumeRatio < 0.8)
      label = "no_demand";
    else if (direction === "down" && spreadRatio < 0.8 && volumeRatio < 0.8)
      label = "test";
    else if (direction === "up" && closePosition >= 0.7 && volumeRatio >= 1.5)
      label = "demand_strong_close";
    return {
      spreadRatio,
      volumeRatio,
      closePosition,
      direction,
      label,
    };
  };
  for (let i = start; i <= idx; i++) {
    const metric = classifyVsa(i);
    if (metric) vsa.set(h1.bars[i]!.time, metric);
  }
  for (let i = start; i <= idx; i++) {
    const candle = h1.bars[i]!;
    const metric = vsa.get(candle.time);
    const prior = h1.bars.slice(Math.max(0, i - 20), i);
    if (prior.length < 20) continue;
    const support = Math.min(...prior.map((bar) => bar.low));
    const resistance = Math.max(...prior.map((bar) => bar.high));
    if (
      metric?.label === "climax" &&
      (metric.closePosition ?? 0) >= 0.5 &&
      candle.low <= bottom + 0.1 * height
    )
      events.push({
        type: "selling_climax",
        time: iso(candle.time),
        level: candle.low,
      });
    if (candle.low < support) {
      const recovered = h1.bars
        .slice(i, i + 4)
        .filter((bar) => bar.time <= h1.bars[idx]!.time)
        .some((bar) => bar.close > support);
      if (recovered)
        events.push({ type: "spring", time: iso(candle.time), level: support });
    }
    if (
      candle.close > resistance &&
      (metric?.spreadRatio ?? 0) >= 1.5 &&
      (metric?.volumeRatio ?? 0) >= 1.5
    )
      events.push({
        type: "sign_of_strength",
        time: iso(candle.time),
        level: resistance,
      });
  }
  const firstSos = events.find((event) => event.type === "sign_of_strength");
  if (firstSos) {
    const level = firstSos.level ?? 0;
    for (let i = 0; i <= idx; i++) {
      const candle = h1.bars[i]!;
      if (candle.time <= Date.parse(firstSos.time)) continue;
      const metric = vsa.get(candle.time);
      if (
        metric?.direction === "down" &&
        (metric.volumeRatio ?? 99) < 0.8 &&
        candle.low >= level
      )
        events.push({
          type: "last_point_of_support",
          time: iso(candle.time),
          level,
        });
    }
  }
  const early = events.filter(
    (event) =>
      event.type === "selling_climax" || event.type === "spring",
  );
  const phase = firstSos
    ? early.some((event) => event.time < firstSos.time)
      ? "accumulation_then_markup"
      : "breakout_without_base"
    : early.length
      ? "accumulation"
      : "none";
  return {
    status: "computed",
    windowBars: win.length,
    rangeTop: top,
    rangeBottom: bottom,
    rangeHeightPct: bottom > 0 ? (height / bottom) * 100 : null,
    entryPositionInRange: height > 0 ? (h1.bars[idx]!.close - bottom) / height : null,
    events,
    phase,
  };
}

function classify(
  event: Obj,
  priceBars: Bar[],
): Obj {
  const entry = num(event.entry);
  if (entry == null || entry <= 0)
    return { outcome: "uncalculable", reason: "missing_entry_price" };
  const horizons = [4 * H1, D1, 72 * H1, 5 * D1];
  const result: Obj = {};
  const priceStartAt = Number(event.priceStartAt ?? event.eventAt);
  const barsAfter = priceBars.filter(
    (bar) => bar.time + M15 > priceStartAt && bar.time <= latestClosed,
  );
  for (const horizon of horizons) {
    const end = Math.min(priceStartAt + horizon, latestClosed + M15);
    const bars = barsAfter.filter((bar) => bar.time < end);
    let high = entry;
    let low = entry;
    let hitTargetAt: number | null = null;
    let hitStopAt: number | null = null;
    let ambiguousAt: number | null = null;
    let firstBarrierSeen = false;
    for (const bar of bars) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      const targetHit = bar.high >= entry * (1 + TARGET_PCT / 100);
      const stopHit = bar.low <= entry * (1 + STOP_PCT / 100);
      if (!firstBarrierSeen && targetHit && stopHit) {
        ambiguousAt = bar.time;
        firstBarrierSeen = true;
      } else if (!firstBarrierSeen && targetHit) {
        hitTargetAt = bar.time;
        firstBarrierSeen = true;
      } else if (!firstBarrierSeen && stopHit) {
        hitStopAt = bar.time;
        firstBarrierSeen = true;
      }
    }
    const complete = latestClosed + M15 >= priceStartAt + horizon;
    result[`peak_${horizon / H1}h_pct`] = pctChange(high, entry);
    result[`dd_${horizon / H1}h_pct`] = pctChange(low, entry);
    result[`target_${horizon / H1}h_at`] = iso(hitTargetAt);
    result[`stop_${horizon / H1}h_at`] = iso(hitStopAt);
    result[`ambiguous_${horizon / H1}h_at`] = iso(ambiguousAt);
    result[`horizon_${horizon / H1}h_complete`] = complete;
    if (horizon === 5 * D1) {
      result.outcome =
        ambiguousAt != null
          ? "ambiguous"
          : hitTargetAt != null
            ? "champion"
            : hitStopAt != null
              ? "bad"
              : complete
                ? "open"
                : "censored";
      result.outcome_reason =
        ambiguousAt != null
          ? "both_thresholds_same_15m_candle"
          : hitTargetAt != null
            ? "target_before_stop"
            : hitStopAt != null
              ? "stop_before_target"
              : complete
                ? "five_days_no_threshold"
                : "five_day_window_incomplete";
    }
  }
  const targetAt = timeMs(result.target_120h_at);
  let t0: Bar | null = null;
  if (targetAt != null) {
    for (const bar of barsAfter) {
      if (bar.time > targetAt) break;
      if (!t0 || bar.low < t0.low) t0 = bar;
    }
  }
  result.t0_at = iso(t0?.time ?? null);
  result.t0_price = t0?.low ?? "";
  result.t0_return_pct = t0 && entry ? round(((t0.low / entry) - 1) * 100, 3) : "";
  return result;
}

function currentMetrics(
  event: Obj,
  at: number,
  bars: Bar[],
  fut: Flow[],
  spot: Flow[],
  oi: Scalar[],
  liq: Scalar[],
  funding: Scalar[],
  aggVolumes: Map<number, number>,
  futuresVolumes: Map<number, number>,
  bingxVolumes: Map<number, number>,
): Obj {
  const time = Math.floor(at / M15) * M15;
  const candle = candleAt(bars, time);
  const f = sampleAt(fut, time);
  const s = sampleAt(spot, time);
  const o = sampleAt(oi, time);
  const fu = sampleAt(funding, time);
  const marketCap = num(event.marketCap);
  const fut24 = sumFlow(fut, time - D1 + M15, time);
  const spot24 = sumFlow(spot, time - D1 + M15, time);
  const liq24Long = sumScalar(liq, time - D1 + M15, time, "longUsd");
  const liq24Short = sumScalar(liq, time - D1 + M15, time, "shortUsd");
  const oiAt = (offset: number): number | null => {
    const found = sampleAt(oi, time - offset);
    return num(found?.value);
  };
  const cvdAt = (offset: number): number | null => {
    const found = sampleAt(spot, time - offset);
    return num(found?.cvd);
  };
  const eventIndex = exactIndex(bars, time);
  const last120 =
    eventIndex < 0
      ? []
      : bars.slice(Math.max(0, eventIndex - 119), eventIndex + 1);
  const aggIndicators = calculateIndicators(
    bars,
    aggVolumes,
    time,
    futuresVolumes,
  );
  const bingxIndicators = calculateIndicators(bars, bingxVolumes, time);
  const windowTakers = (flow: { buy: number | null; sell: number | null }) =>
    flow.buy == null || flow.sell == null || flow.buy + flow.sell === 0
      ? null
      : ((flow.buy - flow.sell) / (flow.buy + flow.sell)) * 100;
  const fVolume = f?.buy != null && f?.sell != null ? f.buy + f.sell : null;
  const sVolume = s?.buy != null && s?.sell != null ? s.buy + s.sell : null;
  const totalLiq = (long: number | null, short: number | null) =>
    long == null || short == null ? null : long + short;
  const mcapPct = (value: number | null) =>
    value == null || marketCap == null || marketCap <= 0
      ? null
      : (value / marketCap) * 100;
  return {
    time: iso(time),
    open: candle?.open ?? "",
    high: candle?.high ?? "",
    low: candle?.low ?? "",
    close: candle?.close ?? "",
    bot_market_cap_usd: marketCap ?? "",
    cg_futures_volume_usd_15m: fVolume ?? "",
    cg_spot_volume_usd_15m: sVolume ?? "",
    cg_futures_taker_net_pct_15m: round(windowTakers(f ?? { buy: null, sell: null })),
    cg_spot_taker_net_pct_15m: round(windowTakers(s ?? { buy: null, sell: null })),
    cg_futures_volume_usd_24h: fut24.buy == null ? "" : fut24.buy + fut24.sell!,
    cg_spot_volume_usd_24h: spot24.buy == null ? "" : spot24.buy + spot24.sell!,
    cg_futures_taker_net_pct_24h: round(windowTakers(fut24)),
    cg_spot_taker_net_pct_24h: round(windowTakers(spot24)),
    cg_spot_cvd_15m: s?.cvd ?? "",
    cg_spot_cvd_delta_1h: (() => {
      const a = cvdAt(0);
      const b = cvdAt(H1);
      return a == null || b == null ? "" : a - b;
    })(),
    cg_spot_cvd_delta_4h: (() => {
      const a = cvdAt(0);
      const b = cvdAt(H4);
      return a == null || b == null ? "" : a - b;
    })(),
    cg_oi_usd_15m: o?.value ?? "",
    cg_oi_change_30m_pct: round(pctChange(oiAt(0), oiAt(30 * 60_000))),
    cg_oi_change_1h_pct: round(pctChange(oiAt(0), oiAt(H1))),
    cg_oi_change_4h_pct: round(pctChange(oiAt(0), oiAt(H4))),
    cg_oi_change_24h_pct: round(pctChange(oiAt(0), oiAt(D1))),
    cg_liq_long_usd_15m: sampleAt(liq, time)?.longUsd ?? "",
    cg_liq_short_usd_15m: sampleAt(liq, time)?.shortUsd ?? "",
    cg_liq_long_usd_24h: liq24Long ?? "",
    cg_liq_short_usd_24h: liq24Short ?? "",
    cg_funding_rate_15m: fu?.funding ?? "",
    cg_futures_volume_mcap_pct_15m: round(mcapPct(fVolume)),
    cg_spot_volume_mcap_pct_15m: round(mcapPct(sVolume)),
    cg_liq_long_mcap_pct_24h: round(mcapPct(liq24Long)),
    cg_liq_short_mcap_pct_24h: round(mcapPct(liq24Short)),
    cg_lucy_vsa_120: aggIndicators.lucy120 ?? "",
    cg_welkin_20: aggIndicators.welkin20 ?? "",
    cg_mfi_14: round(aggIndicators.mfi14),
    cg_cmf_20: round(aggIndicators.cmf20),
    cg_obv_120: round(aggIndicators.obv120),
    cg_volume_bars_120: aggIndicators.volumeBars120 ?? "",
    cg_volume_bars_20: aggIndicators.volumeBars20 ?? "",
    bingx_quote_volume_15m_approx:
      candle?.volume == null ? "" : round(candle.volume * candle.close, 3),
    bingx_lucy_vsa_120: bingxIndicators.lucy120 ?? "",
    bingx_welkin_20: bingxIndicators.welkin20 ?? "",
    bingx_mfi_14: round(bingxIndicators.mfi14),
    bingx_cmf_20: round(bingxIndicators.cmf20),
    bingx_obv_120: round(bingxIndicators.obv120),
    agg_wyckoff_1h: JSON.stringify(wyckoffAt(bars, futuresVolumes, time)),
    bingx_wyckoff_1h: JSON.stringify(wyckoffAt(bars, bingxVolumes, time)),
    lucy_source:
      aggIndicators.lucy120 == null
        ? "insufficient_aggregated_history"
        : "CoinGlass_aggregate_futures_plus_spot",
    welkin_source: "CoinGlass_aggregate_futures",
    bingx_source: candle?.volume == null ? "bingx_candle_volume_missing" : "BingX_candles_volume_times_close_approx",
    event_bar_index: eventIndex,
    prior_120_available: last120.length,
  };
}

function allMetricsRows(
  event: Obj,
  bars: Bar[],
  fut: Flow[],
  spot: Flow[],
  oi: Scalar[],
  liq: Scalar[],
  funding: Scalar[],
  aggVol: Map<number, number>,
  futuresVol: Map<number, number>,
  bingxVol: Map<number, number>,
  outcome: Obj,
): Obj[] {
  const anchors = [
    { label: "detection", time: event.eventAt },
    ...(timeMs(outcome.t0_at) != null
      ? [{ label: "capitulation_T0", time: timeMs(outcome.t0_at)! }]
      : []),
  ];
  const seen = new Set<string>();
  const rows: Obj[] = [];
  for (const anchor of anchors) {
    for (let offset = -3; offset <= 3; offset++) {
      const at = Math.floor(anchor.time / M15) * M15 + offset * M15;
      const key = `${anchor.label}:${at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const metrics = currentMetrics(
        event,
        at,
        bars,
        fut,
        spot,
        oi,
        liq,
        funding,
        aggVol,
        futuresVol,
        bingxVol,
      );
      rows.push({
        cohort: event.cohort,
        event_id: event.event_id,
        symbol: event.symbol,
        anchor: anchor.label,
        offset_15m: offset,
        ...metrics,
      });
    }
  }
  return rows;
}

function outcomeAtEntry(
  bars: Bar[],
  startAt: number,
  entry: number,
  stopPct: number,
  horizon = 4 * D1,
): Obj {
  const until = Math.min(startAt + horizon, latestClosed + M15);
  for (const bar of bars) {
    if (bar.time + M15 <= startAt || bar.time >= until) continue;
    const targetHit = bar.high >= entry * 1.1;
    const stopHit = bar.low <= entry * (1 + stopPct / 100);
    if (targetHit && stopHit)
      return { result: "ambiguous", exitAt: iso(bar.time), exitPct: "" };
    if (targetHit)
      return { result: "target_10", exitAt: iso(bar.time), exitPct: 10 };
    if (stopHit)
      return { result: "stop", exitAt: iso(bar.time), exitPct: stopPct };
  }
  return {
    result: latestClosed + M15 >= startAt + horizon ? "open" : "censored",
    exitAt: "",
    exitPct: "",
  };
}

function simulateStops(event: Obj, bars: Bar[], outcome: Obj): Obj[] {
  const entry = num(event.entry);
  if (entry == null) return [];
  const results: Obj[] = [];
  for (const stopPct of [-8, -10, -12]) {
    results.push({
      event_id: event.event_id,
      cohort: event.cohort,
      symbol: event.symbol,
      policy: `fixed_stop_${stopPct}`,
      ...outcomeAtEntry(
        bars,
        Number(event.priceStartAt ?? event.eventAt),
        entry,
        stopPct,
      ),
    });
  }
  const horizonEnd = Math.min(event.eventAt + 4 * D1, latestClosed + M15);
  const runBars = bars.filter(
    (bar) =>
      bar.time + M15 > Number(event.priceStartAt ?? event.eventAt) &&
      bar.time < horizonEnd,
  );
  const policies = [
    { name: "BE_after_8", arm: 8, gap: null, first: -10 },
    { name: "trail_15_gap_10", arm: 15, gap: 10, first: -10 },
    { name: "trail_20_gap_20", arm: 20, gap: 20, first: -10 },
    { name: "trail_30_gap_30", arm: 30, gap: 30, first: -10 },
  ];
  for (const policy of policies) {
    let peak = entry;
    let stop = entry * (1 + policy.first / 100);
    let exitPrice: number | null = null;
    let exitAt: number | null = null;
    let ambiguous = false;
    for (const bar of runBars) {
      const armedBefore = peak >= entry * (1 + policy.arm / 100);
      if (policy.gap != null && armedBefore) {
        stop = Math.max(stop, peak - (entry * policy.gap) / 100);
      } else if (policy.gap == null && peak >= entry * (1 + policy.arm / 100)) {
        stop = Math.max(stop, entry);
      }
      const targetHit = bar.high >= entry * 1.1;
      const stopHit = bar.low <= stop;
      if (targetHit && stopHit) {
        ambiguous = true;
        exitAt = bar.time;
        break;
      }
      if (stopHit) {
        exitPrice = stop;
        exitAt = bar.time;
        break;
      }
      peak = Math.max(peak, bar.high);
    }
    results.push({
      event_id: event.event_id,
      cohort: event.cohort,
      symbol: event.symbol,
      policy: policy.name,
      result: ambiguous ? "ambiguous" : exitPrice == null ? "open" : "stop",
      exitAt: iso(exitAt),
      exitPct: exitPrice == null ? "" : round(((exitPrice / entry) - 1) * 100, 3),
      path_peak_pct: round(pctChange(Math.max(entry, ...runBars.map((b) => b.high)), entry), 3),
    });
  }
  return results;
}

function findVariants(event: Obj, bars: Bar[], outcome: Obj): Obj[] {
  if (event.cohort !== "A_signal") return [];
  const entry = num(event.entry);
  if (entry == null) return [];
  const t0 = timeMs(outcome.t0_at);
  const after = bars.filter((bar) => bar.time + M15 > event.eventAt);
  const lowAfter = t0 == null ? null : bars.find((bar) => bar.time === t0);
  const result: Obj[] = [];
  const add = (name: string, time: number | null, price: number | null) => {
    if (time == null || price == null || price <= 0) {
      result.push({
        event_id: event.event_id,
        symbol: event.symbol,
        variant: name,
        entry_at: "",
        entry_price: "",
        result: "not_available",
      });
      return;
    }
    result.push({
      event_id: event.event_id,
      symbol: event.symbol,
      variant: name,
      entry_at: iso(time),
      entry_price: price,
      ...outcomeAtEntry(bars, time, price, -10),
    });
  };
  add("actual_detection_entry", Number(event.priceStartAt ?? event.eventAt), entry);
  add("T0_low", t0, lowAfter?.low ?? null);
  for (const offset of [-3, -5]) {
    const price = entry * (1 + offset / 100);
    const hit = after.find((bar) => bar.low <= price);
    add(`limit_${offset}`, hit?.time ?? null, hit ? price : null);
  }
  if (t0 != null) {
    const afterLow = after.filter((bar) => bar.time >= t0);
    const firstGreen = afterLow.find((bar) => bar.close > bar.open);
    add("first_green_after_T0", firstGreen?.time ?? null, firstGreen?.close ?? null);
    const midpointBreak = afterLow.find(
      (bar) => bar.close > (bar.high + bar.low) / 2,
    );
    add("first_close_over_mid_after_T0", midpointBreak?.time ?? null, midpointBreak?.close ?? null);
    const choch = afterLow.find((bar, idx) => {
      const prev = afterLow.slice(Math.max(0, idx - 4), idx);
      return prev.length === 4 && bar.close > Math.max(...prev.map((x) => x.high));
    });
    add("15m_close_above_prior_4_high", choch?.time ?? null, choch?.close ?? null);
  }
  return result;
}

function eventMissingMetrics(event: Obj, metrics: Obj, botMetrics: Obj): Obj[] {
  const out: Obj[] = [];
  const fields = [
    "cg_futures_volume_usd_15m",
    "cg_spot_volume_usd_15m",
    "cg_futures_taker_net_pct_15m",
    "cg_spot_taker_net_pct_15m",
    "cg_futures_volume_usd_24h",
    "cg_spot_volume_usd_24h",
    "cg_futures_taker_net_pct_24h",
    "cg_spot_taker_net_pct_24h",
    "cg_spot_cvd_15m",
    "cg_spot_cvd_delta_1h",
    "cg_spot_cvd_delta_4h",
    "cg_oi_usd_15m",
    "cg_oi_change_30m_pct",
    "cg_oi_change_1h_pct",
    "cg_oi_change_4h_pct",
    "cg_oi_change_24h_pct",
    "cg_liq_long_usd_15m",
    "cg_liq_short_usd_15m",
    "cg_liq_long_usd_24h",
    "cg_liq_short_usd_24h",
    "cg_funding_rate_15m",
    "cg_futures_volume_mcap_pct_15m",
    "cg_spot_volume_mcap_pct_15m",
    "cg_liq_long_mcap_pct_24h",
    "cg_liq_short_mcap_pct_24h",
    "cg_lucy_vsa_120",
    "cg_welkin_20",
    "cg_mfi_14",
    "cg_cmf_20",
    "cg_obv_120",
    "bot_market_cap_usd",
    "bot_oi30m",
    "bot_oi1h",
    "bot_oi4h",
    "bot_long_liq1h",
    "bot_long_liq4h",
    "bot_long_liq24h",
    "bot_funding",
    "bot_cvd30m",
    "bot_cvd1h",
    "bot_cvd4h",
  ];
  for (const metric of fields) {
    const value =
      metric === "bot_market_cap_usd"
        ? metrics[metric]
        : metric.startsWith("bot_")
          ? botMetrics[metric]
          : metrics[metric];
    if (value !== "" && value != null) continue;
    let reason = "not_recorded_by_bot";
    if (metric.startsWith("cg_") && metric !== "bot_market_cap_usd") {
      const kind = kindForMetric(metric);
      if (
        errors.some((e) => e.symbol === event.symbol && e.kind === kind) ||
        (kind !== "" && disabledKinds.has(kind))
      )
        reason = "CoinGlass_request_failed";
      else if (metric.includes("lucy") || metric.includes("welkin") || metric.includes("mfi") || metric.includes("cmf") || metric.includes("obv"))
        reason = "insufficient_15m_history";
      else reason = "CoinGlass_no_aggregated_row_or_history_gap";
    }
    out.push({
      cohort: event.cohort,
      event_id: event.event_id,
      symbol: event.symbol,
      metric,
      reason,
    });
  }
  return out;
}

function kindForMetric(metric: string): Kind | "" {
  if (metric.includes("futures") || metric.includes("lucy") || metric.includes("welkin") || metric.includes("mfi") || metric.includes("cmf") || metric.includes("obv"))
    return "aggfut";
  if (metric.includes("spot") || metric.includes("cvd")) return "aggspot";
  if (metric.includes("oi")) return "oi";
  if (metric.includes("liq")) return "liq";
  if (metric.includes("funding")) return "funding";
  return "";
}

function tally(rows: Obj[], field: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = String(row[field] ?? "missing");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function dubaiDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function buildMassDays(rows: Obj[]): Obj[] {
  const days = new Map<string, Obj>();
  for (const row of rows) {
    const date = dubaiDate(String(row.detected_at));
    const day = days.get(date) ?? {
      dubai_date: date,
      A_signals: 0,
      B_watches: 0,
      C_champions: 0,
      price_champions: 0,
      price_bad: 0,
      price_open: 0,
    };
    if (row.cohort === "A_signal") day.A_signals++;
    if (row.cohort === "B_watch") day.B_watches++;
    if (row.cohort === "C_champion") day.C_champions++;
    if (row.outcome === "champion") day.price_champions++;
    if (row.outcome === "bad") day.price_bad++;
    if (row.outcome === "open") day.price_open++;
    days.set(date, day);
  }
  return [...days.values()].sort((a, b) =>
    a.dubai_date.localeCompare(b.dubai_date),
  );
}

function buildGateAttribution(events: Obj[]): Obj[] {
  const groups = new Map<string, Obj>();
  for (const event of events.filter((row) => row.cohort === "B_watch")) {
    for (const stage of event.chain?.chain ?? []) {
      const key = `${stage.stage}:${stage.reason}`;
      const group = groups.get(key) ?? {
        stage: stage.stage,
        reason: stage.reason,
        watch_rows: 0,
        repeated_observations: 0,
      };
      group.watch_rows++;
      group.repeated_observations += Number(stage.repeats ?? 1);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.repeated_observations - a.repeated_observations,
  );
}

function buildAccountRows(stopRows: Obj[]): Obj[] {
  return stopRows
    .filter((row) => row.cohort === "A_signal")
    .map((row) => {
      const exitPct = num(row.exitPct);
      const pnlUsd = exitPct == null ? null : exitPct * 10;
      return {
        event_id: row.event_id,
        symbol: row.symbol,
        policy: row.policy,
        result: row.result,
        exit_pct: exitPct ?? "",
        initial_margin_usd: 100,
        leverage: 10,
        notional_usd: 1000,
        pnl_on_1000_notional_usd: pnlUsd ?? "",
        ending_balance_from_1000_usd:
          pnlUsd == null ? "" : round(1000 + pnlUsd, 2),
        top_up_effect:
          "not_simulated; maintenance margin/top-up events were not recorded",
      };
    });
}

function botMetric(event: Obj, keys: string[]): number | string {
  for (const key of keys) {
    const value = num(event.source?.[key]);
    if (value != null) return value;
  }
  const metrics = event.botMeta?.decision?.entry_metrics;
  if (metrics && typeof metrics === "object") {
    for (const key of keys) {
      const value = num(metrics[key]);
      if (value != null) return value;
    }
  }
  return "";
}

function summarize(
  events: Obj[],
  eventRows: Obj[],
  metricRows: Obj[],
  missingRows: Obj[],
  stopRows: Obj[],
  variantRows: Obj[],
  massDays: Obj[],
  rejectedChampions: Obj[],
): string {
  const countsByCohort = new Map<string, Record<string, number>>();
  for (const cohort of ["A_signal", "B_watch", "C_champion"]) {
    countsByCohort.set(
      cohort,
      tally(eventRows.filter((row) => row.cohort === cohort), "outcome"),
    );
  }
  const chainReasons: Record<string, number> = {};
  for (const event of events.filter((row) => row.cohort === "B_watch")) {
    for (const stage of event.chain?.chain ?? []) {
      const key = `${stage.stage}:${stage.reason}`;
      chainReasons[key] = (chainReasons[key] ?? 0) + Number(stage.repeats ?? 1);
    }
  }
  const metricCompare = metricRows.filter((row) => row.anchor === "detection" && row.offset_15m === 0);
  const colorChanges = {
    lucy:
      metricCompare.filter(
        (row) =>
          row.cg_lucy_vsa_120 !== "" &&
          row.bingx_lucy_vsa_120 !== "" &&
          row.cg_lucy_vsa_120 !== row.bingx_lucy_vsa_120,
      ).length,
    welkin:
      metricCompare.filter(
        (row) =>
          row.cg_welkin_20 !== "" &&
          row.bingx_welkin_20 !== "" &&
          row.cg_welkin_20 !== row.bingx_welkin_20,
      ).length,
    comparable: metricCompare.filter(
      (row) => row.cg_lucy_vsa_120 !== "" && row.bingx_lucy_vsa_120 !== "",
    ).length,
  };
  const countByCohort = (cohort: string) =>
    eventRows.filter((row) => row.cohort === cohort).length;
  const busiest = [...massDays].sort(
    (a, b) =>
      Number(b.A_signals) +
      Number(b.B_watches) -
      Number(a.A_signals) -
      Number(a.B_watches),
  )[0];
  const lines = [
    "# Liquidation Cascade final study — 26 Nov 2026",
    "",
    "## Источники и ограничения",
    "",
    `- Production-выгрузка: ${countByCohort("A_signal")} A-сигналов; ${countByCohort("B_watch")} B-watch без связанного сигнала; ${countByCohort("C_champion")} C-champion episodes, найденных по BingX 15m.`,
    `- Прогон на ${iso(latestClosed)} UTC; цены — только сохранённые BingX 15m свечи. Для будущих относительно последней закрытой свечи участков исходы помечены censored.`,
    "- C-champion: падение ≥8% от максимума предыдущих 16×15m свечей, затем +10% до −10% в следующие 72 часа; одинаковая 15m свеча с обоими барьерами помечалась бы ambiguous.",
    "- Агрегаты CoinGlass запрашивались один раз на монету и временное окно, только для непокрытых интервалов; все exchange_list взяты из встроенного списка CAB (futures/spot). Успешно пустые диапазоны сохранены как no_data.",
    `- CoinGlass: ${requestCount} HTTP-попыток, ${failedCalls} неуспешных диапазонов, ${retry429} ответов 429; endpoint funding ${unsupportedFunding ? "не поддержан / вернул ошибку" : "запрошен в этой выборке"}.`,
    ...(PRIOR_REQUESTS
      ? [
          `- Возобновление из кэша: учтены ${PRIOR_REQUESTS} попыток предыдущего процесса, ${PRIOR_FAILURES} неуспешный диапазон и ${PRIOR_RETRIES_429} ответов 429. Подробности предыдущей ошибки не были сохранены; в отчёте учтено только её количество.`,
        ]
      : []),
    "- Отсутствующие показатели вынесены по каждой метрике в missing-metrics.csv; «not_recorded_by_bot» означает, что точное значение не было сохранено ботом, а не нулевое значение.",
    "- В рабочем дереве не найден предыдущий reports/lc-final-1126 и на upstream cab-sync-fixes этой папки нет; поэтому сравнение «с первым прогоном» невозможно. Вместо этого сохранено прямое сравнение агрегата CoinGlass с BingX-объёмом в metrics-compare.csv.",
    "",
    "## A/B/C: исходы 5 дней",
    "",
    "| Cohort | Всего | Champion (+10 до −10) | Bad (−10 до +10) | Open | Ambiguous | Censored |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...["A_signal", "B_watch", "C_champion"].map((cohort) => {
      const c = countsByCohort.get(cohort) ?? {};
      return `| ${cohort} | ${countByCohort(cohort)} | ${c.champion ?? 0} | ${c.bad ?? 0} | ${c.open ?? 0} | ${c.ambiguous ?? 0} | ${c.censored ?? 0} |`;
    }),
    "",
    "## Gate / причины B",
    "",
    `- 4,018 production watches имеют ${Object.keys(chainReasons).length} пар стадия/причина в наблюдаемой истории; полные цепочки лежат в events.csv.`,
    ...Object.entries(chainReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([key, value]) => `- ${key}: ${value}`),
    `- C-champion с ближайшей записью watch/reject и без ближайшего signal: ${rejectedChampions.length}; nearest-match window ±72 ч, причинность не доказана.`,
    `- Наиболее активный Dubai-день: ${busiest?.dubai_date ?? "нет данных"}; полная разбивка в mass-days.csv.`,
    "",
    "## Сравнение агрегата с BingX",
    "",
    `- Lucy 120: разные цвета на ${colorChanges.lucy} из ${colorChanges.comparable} событий, где оба значения доступны.`,
    `- Welkin 20: разные цвета на ${colorChanges.welkin} событиях с обоими значениями.`,
    "- Источники объёма выровнены с CAB: Lucy 120 использует futures+spot aggregate; Welkin 20 и Wyckoff используют агрегированный futures volume.",
    "- MFI/CMF/OBV здесь рассчитаны на 15m OHLC с общим CoinGlass futures+spot volume; это исследовательские 15m значения, отдельно от записанных ботом 1H/4H money-flow метрик.",
    "- BingX quote volume — приближение candle base-volume × close; это не агрегат и показано только для сравнения.",
    `- Неполные метрики отдельно размечены, не трактованы как ноль; всего отсутствующих ячеек detection-anchor: ${missingRows.length}.`,
    "",
    "## Фактические исходы A и модельные стопы/выходы",
    "",
    "- events.csv содержит фактический статус/PnL/пик сигнала и независимые 4h/24h/72h/120h price-path outcomes.",
    "- stop-exits.csv сопоставляет −8%, −10%, −12%, BE после +8% и trailing 15/10, 20/20, 30/30. Внутрисвечные конфликты помечены ambiguous; частичный fill/биржевая ликвидация не моделировались.",
    "- В entry-variants.csv для A показаны вход на детекции, T0, лимиты −3%/−5%, первая зелёная, close выше середины и 15m break предыдущих четырёх максимумов. Цена исполнения в тесте — заданный уровень для limit-варианта.",
    "- account-scenarios.csv: $1,000 notional соответствует $100 initial margin при 10×; dollar PnL = return% × $10. Реальную ликвидацию/top-up не симулировал: исторические maintenance margin и автопополнения не записаны в production-источниках.",
    "",
    "## Данные",
    "",
    `- ${metricRows.length} строк сравнения метрик; ${missingRows.length} пропусков; ${stopRows.length} stop/exit симуляций; ${variantRows.length} вариантов входа.`,
    "- Файлы: events.csv, metrics-compare.csv, path-outcomes.csv, gate-attribution.csv, mass-days.csv, stop-exits.csv, entry-variants.csv, account-scenarios.csv, rejected-champions.csv, missing-metrics.csv, errors.json, run.txt.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const events = loadEvents();
  if (!events.length) throw new Error("No A/B/C events loaded from .source");
  const windows = new Map<string, { from: number; to: number }>();
  for (const event of events) {
    const from = Math.floor((event.eventAt - PRE_BARS * M15) / M15) * M15;
    const to = Math.min(
      latestClosed,
      Math.floor((event.eventAt + POST) / M15) * M15,
    );
    const current = windows.get(event.symbol);
    if (!current) windows.set(event.symbol, { from, to });
    else {
      current.from = Math.min(current.from, from);
      current.to = Math.max(current.to, to);
    }
  }
  const work: Array<{ symbol: string; kind: Kind; from: number; to: number }> = [];
  for (const [symbol, window] of windows) {
    for (const kind of Object.keys(ENDPOINTS) as Kind[]) {
      if (OFFLINE_RECALC && disabledKinds.has(kind)) continue;
      const file = join(CACHE, `${symbol}_cg15m_${kind}.json`);
      const cache = readSeries(file);
      const gaps = missingSpans(window.from, window.to, cache.coverage);
      for (const gap of gaps) work.push({ symbol, kind, ...gap });
    }
  }
  plannedRanges = work.reduce((sum, item) => {
    const bars = Math.ceil((item.to - item.from) / M15) + 1;
    const chunks = Math.max(1, Math.ceil(bars / (LIMIT - 4)));
    pendingByKind[item.kind] += chunks;
    return sum + chunks;
  }, 0);
  const startAt = Date.now();
  log(
    `Study start: events=${events.length} symbols=${windows.size} missing_CG_ranges=${plannedRanges} max_rpm=6`,
  );
  if (PRIOR_REQUESTS || PRIOR_FAILURES || PRIOR_RETRIES_429) {
    log(
      `Resumed from saved cache with prior counters: requests=${PRIOR_REQUESTS} failures=${PRIOR_FAILURES} retry429=${PRIOR_RETRIES_429}; previous error details were not persisted`,
    );
  }
  if (OFFLINE_RECALC)
    log("STUDY_OFFLINE=1: network fetch disabled; using the existing cache only.");
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
  if (process.argv.includes("--plan-only")) {
    log(
      `PLAN_ONLY: approximately ${Math.ceil((plannedRanges * RATE_GAP_MS) / 60_000)} minutes at the configured request pace; no CoinGlass requests sent.`,
    );
    writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    return;
  }

  const eventsBySymbol = new Map<string, Obj[]>();
  for (const event of events) {
    const group = eventsBySymbol.get(event.symbol) ?? [];
    group.push(event);
    eventsBySymbol.set(event.symbol, group);
  }
  const outputs: Obj[] = [];
  const metricRows: Obj[] = [];
  const missingRows: Obj[] = [];
  const stopRows: Obj[] = [];
  const variantRows: Obj[] = [];
  const pathRows: Obj[] = [];
  let processedEvents = 0;
  let processedSymbols = 0;
  for (const [symbol, symbolEvents] of eventsBySymbol) {
    const window = windows.get(symbol);
    if (!window) throw new Error(`Missing cache window for ${symbol}`);
    const series = {} as Record<Kind, any[]>;
    for (const kind of Object.keys(ENDPOINTS) as Kind[]) {
      if (disabledKinds.has(kind)) {
        series[kind] = [];
        continue;
      }
      series[kind] = await ensureHistory(symbol, kind, window.from, window.to);
    }
    const priceBars = readBars(`${symbol}_15m.json`).filter(
      (bar) => bar.time <= latestClosed,
    );
    const fut = (series.aggfut ?? []) as Flow[];
    const spot = (series.aggspot ?? []) as Flow[];
    const oi = (series.oi ?? []) as Scalar[];
    const liq = (series.liq ?? []) as Scalar[];
    const funding = (series.funding ?? []) as Scalar[];
    const aggregateVolumes = new Map<number, number>();
    const futuresVolumes = new Map<number, number>();
    for (const bar of priceBars) {
      const value = aggregateVolumeAt(fut, spot, bar.time);
      if (value != null) aggregateVolumes.set(bar.time, value);
      const future = sampleAt(fut, bar.time);
      if (future?.buy != null && future.sell != null)
        futuresVolumes.set(bar.time, future.buy + future.sell);
    }
    const bingxVolumes = new Map<number, number>();
    for (const bar of priceBars) {
      if (bar.volume != null) bingxVolumes.set(bar.time, bar.volume * bar.close);
    }
    for (const event of symbolEvents) {
    if (OFFLINE_RECALC && processedEvents === 0)
      log(`OFFLINE_ANALYSIS_BEGIN event=${event.event_id} symbol=${event.symbol}`);
    if (OFFLINE_RECALC && processedEvents === 0)
      log(`OFFLINE_EVENT_BARS_READY bars=${priceBars.length}`);
    const outcome = classify(event, priceBars);
    if (OFFLINE_RECALC && processedEvents === 0)
      log(`OFFLINE_EVENT_CLASSIFIED outcome=${outcome.outcome ?? "none"}`);
    const actual = event.source ?? {};
    const eventRow = {
      cohort: event.cohort,
      event_id: event.event_id,
      id: event.id,
      symbol: event.symbol,
      detected_at: iso(event.eventAt),
      entry_price: event.entry ?? "",
      market_cap_usd: event.marketCap ?? "",
      outcome: outcome.outcome ?? "",
      outcome_reason: outcome.outcome_reason ?? "",
      ...outcome,
      actual_status: actual.status ?? "",
      actual_pnl_percent: actual.pnl_percent ?? "",
      actual_exit_price: actual.exit_price ?? "",
      actual_closed_at: actual.closed_at ?? "",
      actual_peak_price: actual.peak_price ?? "",
      actual_last_milestone: actual.last_milestone ?? "",
      actual_cancel_reason: actual.cancel_reason ?? "",
      bot_raw_source: actual,
      bot_reason_chain: event.chain?.chain ?? "",
      c_candidate_outcome: event.cohort === "C_champion" ? actual.outcome : "",
      c_peak_pct_72h:
        event.cohort === "C_champion" ? outcome.peak_72h_pct : "",
      bot_nearest_signal_id: event.botMeta?.signal?.id ?? "",
      bot_nearest_watch_id: event.botMeta?.watch?.id ?? "",
      bot_nearest_watch_status: event.botMeta?.watch?.status ?? "",
      bot_nearest_watch_reason:
        event.botMeta?.watch?.miss_reason ??
        event.botMeta?.watch?.entry_reason ??
        "",
      bot_nearest_decision_kind: event.botMeta?.decision?.decision_kind ?? "",
      bot_nearest_decision_reason: event.botMeta?.decision?.decision_reason ?? "",
      bot_nearest_missed_reason: event.botMeta?.missed?.reason ?? "",
      bot_nearest_scan_reject_reason: event.botMeta?.scan_reject?.reason ?? "",
      nearest_bot_evidence:
        event.cohort === "C_champion"
          ? {
              signal: event.botMeta?.signal ?? null,
              watch: event.botMeta?.watch ?? null,
              decision: event.botMeta?.decision ?? null,
              missed: event.botMeta?.missed ?? null,
              scan_reject: event.botMeta?.scan_reject ?? null,
            }
          : "",
    };
    outputs.push(eventRow);
    const eventMetrics = currentMetrics(
      event,
      event.eventAt,
      priceBars,
      fut,
      spot,
      oi,
      liq,
      funding,
      aggregateVolumes,
      futuresVolumes,
      bingxVolumes,
    );
    if (OFFLINE_RECALC && processedEvents === 0)
      log("OFFLINE_EVENT_METRICS_READY");
    const botMetrics: Obj = {
      bot_oi30m: botMetric(event, ["oi30m_at_detect", "entry_oi_30m", "oi30m"]),
      bot_oi1h: botMetric(event, ["oi1h_at_detect", "entry_oi_1h", "oi1h"]),
      bot_oi4h: botMetric(event, ["oi4h_at_detect", "entry_oi_4h", "oi4h"]),
      bot_long_liq1h: botMetric(event, ["long_liq1h_at_detect", "entry_liq_long1h"]),
      bot_long_liq4h: botMetric(event, ["long_liq4h_at_detect"]),
      bot_long_liq24h: botMetric(event, ["long_liq24h_at_detect", "entry_liq_long24h"]),
      bot_funding: botMetric(event, ["entry_funding_rate", "funding_rate"]),
      bot_cvd30m: botMetric(event, ["cvd30m_at_detect", "entry_cvd_30m"]),
      bot_cvd1h: botMetric(event, ["cvd1h_at_detect", "entry_cvd_1h"]),
      bot_cvd4h: botMetric(event, ["cvd4h_at_detect", "entry_cvd_4h"]),
    };
    Object.assign(eventMetrics, botMetrics);
    for (const row of allMetricsRows(
      event,
      priceBars,
      fut,
      spot,
      oi,
      liq,
      funding,
      aggregateVolumes,
      futuresVolumes,
      bingxVolumes,
      outcome,
    )) {
      if (row.anchor === "detection" && row.offset_15m === 0)
        Object.assign(row, botMetrics);
      metricRows.push(row);
    }
    missingRows.push(...eventMissingMetrics(event, eventMetrics, botMetrics));
    stopRows.push(...simulateStops(event, priceBars, outcome));
    variantRows.push(...findVariants(event, priceBars, outcome));
    for (const horizon of [4, 24, 72, 120]) {
      pathRows.push({
        cohort: event.cohort,
        event_id: event.event_id,
        symbol: event.symbol,
        detected_at: iso(event.eventAt),
        entry_price: event.entry ?? "",
        horizon_hours: horizon,
        peak_pct: outcome[`peak_${horizon}h_pct`] ?? "",
        drawdown_pct: outcome[`dd_${horizon}h_pct`] ?? "",
        target_at: outcome[`target_${horizon}h_at`] ?? "",
        stop_at: outcome[`stop_${horizon}h_at`] ?? "",
        ambiguous_at: outcome[`ambiguous_${horizon}h_at`] ?? "",
        complete: outcome[`horizon_${horizon}h_complete`] ?? false,
      });
    }
    processedEvents += 1;
    if (OFFLINE_RECALC && processedEvents % 100 === 0) {
      log(`OFFLINE_ANALYSIS_PROGRESS events=${processedEvents}/${events.length}`);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  }
    processedSymbols += 1;
    if (OFFLINE_RECALC && processedSymbols % 25 === 0) {
      log(`OFFLINE_SYMBOL_PROGRESS symbols=${processedSymbols}/${eventsBySymbol.size}`);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  }

  writeCsv(join(OUT, "events.csv"), outputs, [
    "cohort",
    "event_id",
    "id",
    "symbol",
    "detected_at",
    "entry_price",
    "market_cap_usd",
    "outcome",
    "outcome_reason",
    "peak_4h_pct",
    "dd_4h_pct",
    "target_4h_at",
    "stop_4h_at",
    "peak_24h_pct",
    "dd_24h_pct",
    "target_24h_at",
    "stop_24h_at",
    "peak_72h_pct",
    "dd_72h_pct",
    "target_72h_at",
    "stop_72h_at",
    "peak_120h_pct",
    "dd_120h_pct",
    "target_120h_at",
    "stop_120h_at",
    "t0_at",
    "t0_price",
    "t0_return_pct",
    "actual_status",
    "actual_pnl_percent",
    "actual_exit_price",
    "actual_closed_at",
    "actual_peak_price",
    "actual_last_milestone",
    "actual_cancel_reason",
    "bot_raw_source",
    "bot_reason_chain",
    "c_candidate_outcome",
    "c_peak_pct_72h",
    "bot_nearest_signal_id",
    "bot_nearest_watch_id",
    "bot_nearest_watch_status",
    "bot_nearest_watch_reason",
    "bot_nearest_decision_kind",
    "bot_nearest_decision_reason",
    "bot_nearest_missed_reason",
    "bot_nearest_scan_reject_reason",
    "nearest_bot_evidence",
  ]);
  writeCsv(join(OUT, "metrics-compare.csv"), metricRows, [
    "cohort",
    "event_id",
    "symbol",
    "anchor",
    "offset_15m",
    "time",
    "open",
    "high",
    "low",
    "close",
    "bot_market_cap_usd",
    "cg_futures_volume_usd_15m",
    "cg_spot_volume_usd_15m",
    "cg_futures_taker_net_pct_15m",
    "cg_spot_taker_net_pct_15m",
    "cg_futures_volume_usd_24h",
    "cg_spot_volume_usd_24h",
    "cg_futures_taker_net_pct_24h",
    "cg_spot_taker_net_pct_24h",
    "cg_spot_cvd_15m",
    "cg_spot_cvd_delta_1h",
    "cg_spot_cvd_delta_4h",
    "cg_oi_usd_15m",
    "cg_oi_change_30m_pct",
    "cg_oi_change_1h_pct",
    "cg_oi_change_4h_pct",
    "cg_oi_change_24h_pct",
    "cg_liq_long_usd_15m",
    "cg_liq_short_usd_15m",
    "cg_liq_long_usd_24h",
    "cg_liq_short_usd_24h",
    "cg_funding_rate_15m",
    "cg_futures_volume_mcap_pct_15m",
    "cg_spot_volume_mcap_pct_15m",
    "cg_liq_long_mcap_pct_24h",
    "cg_liq_short_mcap_pct_24h",
    "cg_lucy_vsa_120",
    "cg_welkin_20",
    "cg_mfi_14",
    "cg_cmf_20",
    "cg_obv_120",
    "cg_volume_bars_120",
    "cg_volume_bars_20",
    "bingx_quote_volume_15m_approx",
    "bingx_lucy_vsa_120",
    "bingx_welkin_20",
    "bingx_mfi_14",
    "bingx_cmf_20",
    "bingx_obv_120",
    "agg_wyckoff_1h",
    "bingx_wyckoff_1h",
    "bot_oi30m",
    "bot_oi1h",
    "bot_oi4h",
    "bot_long_liq1h",
    "bot_long_liq4h",
    "bot_long_liq24h",
    "bot_funding",
    "bot_cvd30m",
    "bot_cvd1h",
    "bot_cvd4h",
    "lucy_source",
    "welkin_source",
    "bingx_source",
  ]);
  writeCsv(join(OUT, "path-outcomes.csv"), pathRows, [
    "cohort",
    "event_id",
    "symbol",
    "detected_at",
    "entry_price",
    "horizon_hours",
    "peak_pct",
    "drawdown_pct",
    "target_at",
    "stop_at",
    "ambiguous_at",
    "complete",
  ]);
  writeCsv(join(OUT, "stop-exits.csv"), stopRows, [
    "event_id",
    "cohort",
    "symbol",
    "policy",
    "result",
    "exitAt",
    "exitPct",
    "path_peak_pct",
  ]);
  writeCsv(join(OUT, "entry-variants.csv"), variantRows, [
    "event_id",
    "symbol",
    "variant",
    "entry_at",
    "entry_price",
    "result",
    "exitAt",
    "exitPct",
  ]);
  const massDays = buildMassDays(outputs);
  const gateAttribution = buildGateAttribution(events);
  const accountRows = buildAccountRows(stopRows);
  const rejectedChampions = outputs.filter(
    (row) =>
      row.cohort === "C_champion" &&
      !row.bot_nearest_signal_id &&
      (row.bot_nearest_watch_id ||
        row.bot_nearest_decision_reason ||
        row.bot_nearest_missed_reason ||
        row.bot_nearest_scan_reject_reason),
  );
  writeCsv(join(OUT, "gate-attribution.csv"), gateAttribution, [
    "stage",
    "reason",
    "watch_rows",
    "repeated_observations",
  ]);
  writeCsv(join(OUT, "mass-days.csv"), massDays, [
    "dubai_date",
    "A_signals",
    "B_watches",
    "C_champions",
    "price_champions",
    "price_bad",
    "price_open",
  ]);
  writeCsv(join(OUT, "account-scenarios.csv"), accountRows, [
    "event_id",
    "symbol",
    "policy",
    "result",
    "exit_pct",
    "initial_margin_usd",
    "leverage",
    "notional_usd",
    "pnl_on_1000_notional_usd",
    "ending_balance_from_1000_usd",
    "top_up_effect",
  ]);
  writeCsv(join(OUT, "rejected-champions.csv"), rejectedChampions, [
    "event_id",
    "symbol",
    "detected_at",
    "entry_price",
    "c_candidate_outcome",
    "c_peak_pct_72h",
    "bot_nearest_signal_id",
    "bot_nearest_watch_id",
    "bot_nearest_watch_status",
    "bot_nearest_watch_reason",
    "bot_nearest_decision_kind",
    "bot_nearest_decision_reason",
    "bot_nearest_missed_reason",
    "bot_nearest_scan_reject_reason",
    "nearest_bot_evidence",
  ]);
  writeCsv(join(OUT, "missing-metrics.csv"), missingRows, [
    "cohort",
    "event_id",
    "symbol",
    "metric",
    "reason",
  ]);
  writeFileSync(join(OUT, "errors.json"), `${JSON.stringify(errors, null, 2)}\n`);
  writeFileSync(
    join(OUT, "summary.md"),
    summarize(
      events,
      outputs,
      metricRows,
      missingRows,
      stopRows,
      variantRows,
      massDays,
      rejectedChampions,
    ),
  );
  const elapsed = Math.round((Date.now() - startAt) / 1000);
  runLines.push(
    OFFLINE_RECALC
      ? `${new Date().toISOString()} Offline recalculation complete (no network); CoinGlass fetch totals are preserved from run-fetch.txt: requests=${requestCount} failures=${failedCalls} retry429=${retry429} by_kind=${JSON.stringify(callsByKind)} funding_unsupported=${unsupportedFunding}`
      : `${new Date().toISOString()} Study complete: requests=${requestCount} failures=${failedCalls} retry429=${retry429} elapsed_seconds=${elapsed} by_kind=${JSON.stringify(callsByKind)} funding_unsupported=${unsupportedFunding}`,
  );
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  runLines.push(`${new Date().toISOString()} FATAL ${message}`);
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
  console.error(message);
  process.exitCode = 1;
});
