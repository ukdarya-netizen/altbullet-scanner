import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateLcDetectionCandleGate } from "../../artifacts/api-server/src/lib/lc-detection-candle-gate.js";
import { computeSupportZones } from "../../artifacts/api-server/src/lib/stealth-abneon-detectors.js";
import { computeWyckoff } from "../../artifacts/api-server/src/lib/wyckoff-metrics.js";
import { applyCgAlias } from "../../artifacts/api-server/src/lib/cg-symbol-alias.js";
import { cgTimedFetch } from "../../artifacts/api-server/src/lib/cg_latency.js";
import { getNextCgKey } from "../../artifacts/api-server/src/lib/coinglass_keys.js";
import {
  D1,
  H1,
  H4,
  M15,
  klines,
  sleep,
  type C,
} from "../../artifacts/api-server/scripts/study-v2/lib.js";

type Obj = Record<string, any>;
type Metric = number | string | boolean | null;
type Candidate = {
  source: "A_signal" | "B_watch";
  eventId: string;
  watchId: number | null;
  signalId: number | null;
  symbol: string;
  detectedAt: number;
  entryAt: number | null;
  entryPrice: number | null;
  marketCap: number | null;
  watch: Obj | null;
  signal: Obj | null;
  priorEvent: Obj | null;
  botMeta: Obj | null;
  gate: Obj | null;
  period: string;
  key: string;
  metrics: Record<string, Metric>;
  missing: Map<string, string>;
};

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ROOT = resolve(HERE, "../..");
const SOURCE = join(ROOT, "reports/lc-final-1126/.source");
const PRIOR = join(ROOT, "reports/lc-final-1126");
const CACHE = join(ROOT, "reports/.cache");
const WORK = join(CACHE, "lc-indicators-1127");
const OUT = HERE;
const HIST_EXTRA = join(WORK, "history");
const BINANCE_CACHE = join(WORK, "binance");
const BINANCE_UNAVAILABLE_CACHE = join(BINANCE_CACHE, "unavailable.json");
const CG_TOP_CACHE = join(WORK, "coinglass-top-ratio");
const M15_MS = M15;
const H1_MS = H1;
const H4_MS = H4;
const D1_MS = D1;
const D7_MS = 7 * D1_MS;
const M30D = 30 * D1_MS;
const STEP: Record<string, number> = {
  "15m": M15_MS,
  "1h": H1_MS,
  "4h": H4_MS,
  "1d": D1_MS,
};
const RAW_SQL = [
  "SELECT status,count(*) FROM liq_cascade_watch WHERE detected_at >= '2026-11-01' AND symbol <> 'BTC-USDT' GROUP BY status;",
  "SELECT status,count(*) FROM tracked_signals WHERE sentiment_key='liquidation_cascade' AND detected_at >= '2026-11-01' AND symbol <> 'BTC-USDT' GROUP BY status;",
  "SELECT row_to_json(w) FROM liq_cascade_watch w WHERE detected_at >= '2026-11-26 09:43:12.391' AND detected_at < '2026-11-28 00:00:00' AND symbol <> 'BTC-USDT' ORDER BY detected_at,id;",
  "SELECT row_to_json(t) FROM tracked_signals t WHERE sentiment_key='liquidation_cascade' AND detected_at >= '2026-11-26 08:43:08.542' AND detected_at < '2026-11-28 00:00:00' AND symbol <> 'BTC-USDT' ORDER BY detected_at,id;",
  "SELECT row_to_json(x) FROM (SELECT symbol,count(*) AS watch_count,count(*) FILTER (WHERE signal_id IS NOT NULL) AS fired_watch_count FROM liq_cascade_watch WHERE detected_at >= '2026-07-14' AND symbol <> 'BTC-USDT' GROUP BY symbol) x;",
  "SELECT row_to_json(x) FROM (SELECT id,symbol,detected_at,entry_price,peak_price,stop_loss_price,exit_price,pnl_percent,status,closed_at FROM tracked_signals WHERE sentiment_key='liquidation_cascade' AND detected_at >= '2026-07-14' AND symbol <> 'BTC-USDT') x;",
  "SELECT row_to_json(x) FROM (SELECT o.* FROM lc_stop_bid_observations o JOIN tracked_signals t ON t.id=o.tracked_signal_id WHERE t.sentiment_key='liquidation_cascade' AND t.detected_at >= '2026-11-01' AND t.symbol <> 'BTC-USDT') x;",
  "SELECT count(*),min(snapshot_at),max(snapshot_at) FROM cg_liq_heatmap_snapshot;",
];

const previousRunLog = existsSync(join(OUT, "run.txt")) ? readFileSync(join(OUT, "run.txt"), "utf8") : "";
function previousProgress(pattern: RegExp): { requests: number; errors: number } {
  const rows = [...previousRunLog.matchAll(pattern)];
  const last = rows.at(-1);
  return {
    requests: Number(last?.[1] ?? 0),
    errors: Number(last?.[2] ?? 0),
  };
}
const progressRequests = {
  bingx: previousProgress(/BINGX_[A-Z_]+_PROGRESS[^\n]*requests=(\d+) errors=(\d+)/g),
  binance: previousProgress(/BINANCE_PROGRESS[^\n]*requests=(\d+) errors=(\d+)/g),
  coinglass: previousProgress(/COINGLASS_PROGRESS[^\n]*requests=(\d+) errors=(\d+)/g),
  coingecko: previousProgress(/COINGECKO_PROGRESS[^\n]*requests=(\d+) errors=(\d+)/g),
};
const finalRequestCounts = [...previousRunLog.matchAll(/http_attempts bingx=(\d+) binance=(\d+) coinglass=(\d+)/g)].at(-1);
const finalRequestErrors = [...previousRunLog.matchAll(/http_errors bingx=(\d+) binance=(\d+) coinglass=(\d+) coingecko=(\d+)/g)].at(-1);
const previousCoingeckoTotal = [...previousRunLog.matchAll(/http_attempts coingecko=(\d+)/g)].at(-1);
const previousRequests = {
  bingx: {
    requests: Math.max(Number(finalRequestCounts?.[1] ?? 0), progressRequests.bingx.requests),
    errors: Math.max(Number(finalRequestErrors?.[1] ?? 0), progressRequests.bingx.errors),
  },
  binance: {
    requests: Math.max(Number(finalRequestCounts?.[2] ?? 0), progressRequests.binance.requests),
    errors: Math.max(Number(finalRequestErrors?.[2] ?? 0), progressRequests.binance.errors),
  },
  coinglass: {
    requests: Math.max(Number(finalRequestCounts?.[3] ?? 0), progressRequests.coinglass.requests),
    errors: Math.max(Number(finalRequestErrors?.[3] ?? 0), progressRequests.coinglass.errors),
  },
  coingecko: {
    requests: Math.max(Number(previousCoingeckoTotal?.[1] ?? 0), progressRequests.coingecko.requests),
    errors: Math.max(Number(finalRequestErrors?.[4] ?? 0), progressRequests.coingecko.errors),
  },
};
const requestCounts: Record<string, number> = {
  bingx: previousRequests.bingx.requests,
  binance: previousRequests.binance.requests,
  coinglass: previousRequests.coinglass.requests,
  coingecko: previousRequests.coingecko.requests,
};
const requestErrors: Record<string, number> = {
  bingx: previousRequests.bingx.errors,
  binance: previousRequests.binance.errors,
  coinglass: previousRequests.coinglass.errors,
  coingecko: previousRequests.coingecko.errors,
};
const errorNotes: string[] = [
  ...new Set(
    previousRunLog
      .split(/\r?\n/)
      .filter((line) => line.startsWith("ERROR "))
      .map((line) => line.slice("ERROR ".length)),
  ),
];
const cgCache = new Map<string, Obj[]>();
const cgIndex = new Map<string, Map<number, Obj>>();
const CG_DISABLED_CACHE = join(CG_TOP_CACHE, "top-ratio-disabled.json");
let coinglassTopDisabled = readJson(CG_DISABLED_CACHE)?.disabled === true;
let binanceHttp451Unavailable = readJson(BINANCE_UNAVAILABLE_CACHE)?.unavailable === true;
let coingeckoCoinListError: string | null = null;
const coingeckoErrorsBySymbol = new Map<string, string>();
const rawFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (process.env.STUDY_OFFLINE === "1") throw new Error("STUDY_OFFLINE blocked an external request");
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const host = new URL(url).hostname.toLowerCase();
  const kind = host.includes("bingx")
    ? "bingx"
    : host.includes("binance")
      ? "binance"
      : host.includes("coinglass")
        ? "coinglass"
        : host.includes("coingecko")
          ? "coingecko"
        : null;
  if (kind) requestCounts[kind]++;
  try {
    const response = await rawFetch(input, init);
    if (kind && !response.ok) requestErrors[kind]++;
    return response;
  } catch (error) {
    if (kind) requestErrors[kind]++;
    throw error;
  }
};

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function readJson(path: string): any | null {
  try {
    return existsSync(path) ? JSON.parse(text(path)) : null;
  } catch {
    return null;
  }
}

function jsonl(path: string): Obj[] {
  if (!existsSync(path)) return [];
  return text(path)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function readCsv(path: string): Obj[] {
  if (!existsSync(path)) return [];
  const source = text(path);
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (row.length || value) {
    row.push(value.replace(/\r$/, ""));
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows
    .filter((cells) => cells.some((cell) => cell !== ""))
    .map((cells) => Object.fromEntries(headers.map((key, i) => [key, cells[i] ?? ""])));
}

function parseCsvRecord(source: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(value);
      value = "";
    } else value += char;
  }
  cells.push(value.replace(/\r$/, ""));
  return cells;
}

async function readRelevantMetrics(path: string, targetEvents: Set<string>): Promise<Map<string, Obj[]>> {
  const selected = new Set([
    "cohort", "event_id", "anchor", "offset_15m", "time", "open", "high", "low", "close",
    "cg_futures_taker_net_pct_15m", "cg_spot_taker_net_pct_15m",
    "cg_futures_volume_mcap_pct_15m", "cg_spot_volume_mcap_pct_15m",
    "cg_oi_change_30m_pct", "cg_oi_change_1h_pct", "cg_oi_change_4h_pct",
    "cg_liq_long_mcap_pct_24h", "cg_funding_rate_15m", "cg_lucy_vsa_120",
    "cg_welkin_20", "cg_mfi_14", "cg_cmf_20", "cg_spot_cvd_delta_1h",
    "cg_spot_cvd_delta_4h", "cg_obv_120",
  ]);
  const stream = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers: string[] | null = null;
  const output = new Map<string, Obj[]>();
  for await (const line of stream) {
    if (!headers) {
      headers = parseCsvRecord(line);
      continue;
    }
    const cells = parseCsvRecord(line);
    const index = (key: string) => headers!.indexOf(key);
    const cohort = cells[index("cohort")] ?? "";
    const eventId = cells[index("event_id")] ?? "";
    if (!targetEvents.has(`${cohort}|${eventId}`)) continue;
    if ((cells[index("anchor")] ?? "") !== "detection") continue;
    const row: Obj = {};
    for (const key of selected) {
      const i = index(key);
      if (i >= 0) row[key] = cells[i] ?? "";
    }
    const group = output.get(`${cohort}|${eventId}`) ?? [];
    group.push(row);
    output.set(`${cohort}|${eventId}`, group);
  }
  return output;
}

function writeCsv(path: string, headers: string[], rows: Obj[]): void {
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "string" ? v : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  writeFileSync(
    path,
    `${[headers, ...rows.map((r) => headers.map((h) => r[h] ?? ""))]
      .map((cells) => cells.map(esc).join(","))
      .join("\n")}\n`,
  );
}

function n(value: unknown): number | null {
  if (value == null || value === "") return null;
  const x = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(x) ? x : null;
}

function timeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value))
    return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(t: number | null): string {
  return t == null ? "" : new Date(t).toISOString();
}

function pctChange(a: number | null, b: number | null): number | null {
  return a == null || b == null || b === 0 ? null : ((a / b) - 1) * 100;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function periodOf(t: number): string {
  const d = new Date(t);
  if (d.getUTCMonth() !== 10) return "outside_november";
  if (d.getUTCDate() <= 11) return "2026-11-01..11";
  if (d.getUTCDate() <= 26) return "2026-11-12..26";
  return "2026-11-27+_partial";
}

async function loadSourceFiles(): Promise<{
  oldEvents: Obj[];
  oldSignals: Obj[];
  oldWatches: Obj[];
  watchMeta: Map<number, Obj>;
  metricRows: Map<string, Obj[]>;
}> {
  const oldEvents = readCsv(join(PRIOR, "events.csv"));
  const targetEvents = new Set(
    oldEvents
      .filter((row) => row.cohort === "A_signal" || row.cohort === "B_watch")
      .map((row) => `${row.cohort}|${row.event_id}`),
  );
  const oldSignals = jsonl(join(SOURCE, "signals.jsonl"));
  const watchFiles = readdirSync(SOURCE).filter((x) => /^watches-.*\.jsonl$/.test(x));
  const oldWatches = watchFiles.flatMap((name) => jsonl(join(SOURCE, name)));
  const watchMeta = new Map<number, Obj>();
  for (const name of readdirSync(SOURCE).filter((x) => /^watch-meta-.*\.jsonl$/.test(x))) {
    for (const row of jsonl(join(SOURCE, name))) {
      const id = Number(row.watch_id ?? row.id);
      if (Number.isFinite(id)) watchMeta.set(id, row);
    }
  }
  const metricRows = await readRelevantMetrics(join(PRIOR, "metrics-compare.csv"), targetEvents);
  return { oldEvents, oldSignals, oldWatches, watchMeta, metricRows };
}

function makeCandidate(args: {
  source: "A_signal" | "B_watch";
  eventId: string;
  watch: Obj | null;
  signal: Obj | null;
  priorEvent: Obj | null;
  botMeta: Obj | null;
}): Candidate | null {
  const { source, eventId, watch, signal, priorEvent, botMeta } = args;
  const symbol = String(signal?.symbol ?? watch?.symbol ?? priorEvent?.symbol ?? "").toUpperCase();
  if (!symbol || symbol.startsWith("BTC-")) return null;
  const detectedAt =
    timeMs(watch?.detected_at) ??
    timeMs(signal?.detected_at) ??
    timeMs(priorEvent?.detected_at);
  if (detectedAt == null) return null;
  const signalId = n(signal?.id ?? priorEvent?.id);
  const watchId =
    n(watch?.id) ??
    n(priorEvent?.bot_nearest_watch_id) ??
    (source === "B_watch" ? n(priorEvent?.id) : null);
  const entryAt = signal ? timeMs(signal.detected_at) : null;
  const entryPrice = n(signal?.entry_price ?? priorEvent?.entry_price);
  const marketCap =
    n(signal?.market_cap_usd) ??
    n(priorEvent?.market_cap_usd) ??
    n(botMeta?.nearest_snapshot?.entry_metrics?.marketCapUsd) ??
    null;
  const candidate: Candidate = {
    source,
    eventId,
    watchId: watchId == null ? null : Number(watchId),
    signalId: signalId == null ? null : Number(signalId),
    symbol,
    detectedAt,
    entryAt,
    entryPrice,
    marketCap,
    watch,
    signal,
    priorEvent,
    botMeta,
    gate: null,
    period: periodOf(detectedAt),
    key: `${symbol}@${iso(detectedAt)}#${source === "A_signal" ? `signal-${signalId ?? eventId}` : `watch-${watchId ?? eventId}`}`,
    metrics: {},
    missing: new Map(),
  };
  return candidate;
}

async function collectCandidates(): Promise<{
  candidates: Candidate[];
  signalById: Map<number, Obj>;
  watchById: Map<number, Obj>;
  metaById: Map<number, Obj>;
  oldRows: Obj[];
  oldSignals: Obj[];
  oldWatches: Obj[];
  metricRows: Map<string, Obj[]>;
  rawDeltaWatches: Obj[];
  rawDeltaSignals: Obj[];
  historicalSignals: Obj[];
  historicalWatches: Obj[];
  bidObservations: Obj[];
}> {
  const { oldEvents, oldSignals, oldWatches, watchMeta, metricRows } = await loadSourceFiles();
  const deltaWatches = jsonl(join(WORK, "watch-delta.jsonl"));
  const deltaSignals = jsonl(join(WORK, "signal-delta.jsonl"));
  const historicalSignals = jsonl(join(WORK, "history-signals.jsonl"));
  const historicalWatches = jsonl(join(WORK, "history-watches.jsonl"));
  const bidObservations = jsonl(join(WORK, "bid-observations.jsonl"));
  const allSignals = [...oldSignals, ...deltaSignals];
  const allWatches = [...oldWatches, ...deltaWatches];
  const signalById = new Map<number, Obj>();
  const watchById = new Map<number, Obj>();
  for (const s of allSignals) if (n(s.id) != null) signalById.set(Number(s.id), s);
  for (const w of allWatches) if (n(w.id) != null) watchById.set(Number(w.id), w);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const row of oldEvents) {
    const source = row.cohort === "A_signal" ? "A_signal" : row.cohort === "B_watch" ? "B_watch" : null;
    if (!source) continue;
    const signalId = source === "A_signal" ? n(row.id) : null;
    const signal = signalId == null ? null : signalById.get(Number(signalId)) ?? null;
    const watchId = n(row.bot_nearest_watch_id) ?? (source === "B_watch" ? n(row.id) : null);
    const watch = watchId == null ? null : watchById.get(Number(watchId)) ?? null;
    const meta = watchId == null ? null : watchMeta.get(Number(watchId)) ?? null;
    const eventId = String(row.event_id || row.id);
    const c = makeCandidate({ source, eventId, watch, signal, priorEvent: row, botMeta: meta });
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    candidates.push(c);
  }

  const linkedSignals = new Map<number, Obj>();
  for (const w of deltaWatches) {
    const sid = n(w.signal_id);
    if (sid != null) linkedSignals.set(Number(sid), w);
  }
  for (const w of deltaWatches) {
    if (n(w.signal_id) != null) continue;
    const c = makeCandidate({
      source: "B_watch",
      eventId: `watch-${w.id}`,
      watch: w,
      signal: null,
      priorEvent: null,
      botMeta: null,
    });
    if (c && !seen.has(c.key)) {
      seen.add(c.key);
      candidates.push(c);
    }
  }
  for (const s of deltaSignals) {
    const w = linkedSignals.get(Number(s.id)) ?? null;
    const c = makeCandidate({
      source: "A_signal",
      eventId: `signal-${s.id}`,
      watch: w,
      signal: s,
      priorEvent: null,
      botMeta: null,
    });
    if (c && !seen.has(c.key)) {
      seen.add(c.key);
      candidates.push(c);
    }
  }
  candidates.sort((a, b) => a.detectedAt - b.detectedAt || a.key.localeCompare(b.key));
  return {
    candidates,
    signalById,
    watchById,
    metaById: watchMeta,
    oldRows: oldEvents,
    oldSignals,
    oldWatches,
    metricRows,
    rawDeltaWatches: deltaWatches,
    rawDeltaSignals: deltaSignals,
    historicalSignals,
    historicalWatches,
    bidObservations,
  };
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      out[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function sortedBars(rows: C[]): C[] {
  return [...new Map(rows.filter((x) => x.time > 0).map((x) => [x.time, x])).values()].sort(
    (a, b) => a.time - b.time,
  );
}

function cacheBars(symbol: string, interval: string): C[] {
  const path = join(CACHE, `${symbol}_${interval}.json`);
  const extraPath = join(HIST_EXTRA, `${symbol}_${interval}.json`);
  const parse = (file: string): C[] => {
    const obj = readJson(file);
    const arr = Array.isArray(obj?.items) ? obj.items : [];
    return arr
      .map((v: any) => {
        if (Array.isArray(v))
          return {
            time: timeMs(v[0]) ?? 0,
            open: n(v[1]) ?? 0,
            high: n(v[2]) ?? 0,
            low: n(v[3]) ?? 0,
            close: n(v[4]) ?? 0,
            volume: n(v[5]) ?? 0,
          };
        return {
          time: timeMs(v.time) ?? 0,
          open: n(v.open) ?? 0,
          high: n(v.high) ?? 0,
          low: n(v.low) ?? 0,
          close: n(v.close) ?? 0,
          volume: n(v.volume) ?? 0,
        };
      })
      .filter((x: C) => x.time > 0 && x.open > 0 && x.low > 0 && x.high >= x.low);
  };
  return sortedBars([...parse(path), ...parse(extraPath)]);
}

function avgTrueRange(bars: C[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const tr = bars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - bars[i]!.close), Math.abs(b.low - bars[i]!.close)),
  );
  let atr = mean(tr.slice(0, period));
  if (atr == null) return null;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]!) / period;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

function rsi14(bars: C[]): number | null {
  if (bars.length < 15) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= 14; i++) {
    const delta = bars[i]!.close - bars[i - 1]!.close;
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let i = 15; i < bars.length; i++) {
    const delta = bars[i]!.close - bars[i - 1]!.close;
    avgGain = (avgGain * 13 + Math.max(0, delta)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(0, -delta)) / 14;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function adx14(bars: C[]): { adx: number | null; plus: number | null; minus: number | null } {
  if (bars.length < 29) return { adx: null, plus: null, minus: null };
  const tr: number[] = [];
  const pdm: number[] = [];
  const mdm: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    tr.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)));
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
  }
  const p = 14;
  let smoothTr = tr.slice(0, p).reduce((a, b) => a + b, 0);
  let smoothP = pdm.slice(0, p).reduce((a, b) => a + b, 0);
  let smoothM = mdm.slice(0, p).reduce((a, b) => a + b, 0);
  const dx: number[] = [];
  for (let i = p; i <= tr.length; i++) {
    if (i > p) {
      smoothTr = smoothTr - smoothTr / p + tr[i - 1]!;
      smoothP = smoothP - smoothP / p + pdm[i - 1]!;
      smoothM = smoothM - smoothM / p + mdm[i - 1]!;
    }
    if (smoothTr <= 0) continue;
    const plus = (smoothP / smoothTr) * 100;
    const minus = (smoothM / smoothTr) * 100;
    const sum = plus + minus;
    dx.push(sum > 0 ? (Math.abs(plus - minus) / sum) * 100 : 0);
  }
  if (dx.length < p) return { adx: null, plus: null, minus: null };
  let adx = mean(dx.slice(0, p)) ?? 0;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]!) / p;
  const latestPlus = (smoothP / smoothTr) * 100;
  const latestMinus = (smoothM / smoothTr) * 100;
  return { adx, plus: latestPlus, minus: latestMinus };
}

function bullishRsiDivergence(bars: C[]): boolean | null {
  if (bars.length < 30) return null;
  const points: number[] = [];
  const start = Math.max(3, bars.length - 120);
  for (let i = start; i < bars.length - 3; i++) {
    let pivot = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j !== i && bars[j]!.low < bars[i]!.low) pivot = false;
    }
    if (pivot) points.push(i);
  }
  if (points.length < 2) return null;
  const [prevIdx, lastIdx] = points.slice(-2);
  const prevRsi = rsi14(bars.slice(0, prevIdx + 1));
  const lastRsi = rsi14(bars.slice(0, lastIdx + 1));
  if (prevRsi == null || lastRsi == null) return null;
  return bars[lastIdx]!.low < bars[prevIdx]!.low && lastRsi > prevRsi;
}

function indicatorSet(bars: C[], time: number, step: number, prefix: string): Obj {
  const closed = bars.filter((b) => b.time + step <= time);
  const slice = closed.slice(-240);
  if (slice.length < 15) {
    return {
      [`${prefix}_rsi14`]: null,
      [`${prefix}_rsi14_bull_divergence`]: null,
      [`${prefix}_atr14_pct`]: null,
      [`${prefix}_adx14`]: null,
      [`${prefix}_di_plus14`]: null,
      [`${prefix}_di_minus14`]: null,
    };
  }
  const last = slice.at(-1)!;
  const atr = avgTrueRange(slice);
  const adx = adx14(slice);
  return {
    [`${prefix}_rsi14`]: rsi14(slice),
    [`${prefix}_rsi14_bull_divergence`]: bullishRsiDivergence(slice),
    [`${prefix}_atr14_pct`]: atr == null ? null : (atr / last.close) * 100,
    [`${prefix}_adx14`]: adx.adx,
    [`${prefix}_di_plus14`]: adx.plus,
    [`${prefix}_di_minus14`]: adx.minus,
  };
}

function downWaves(bars: C[], from: number, to: number, pct: number): number | null {
  const subset = bars.filter((b) => b.time >= from && b.time <= to);
  if (subset.length < 3) return null;
  let direction: "up" | "down" | null = null;
  let pivot = subset[0]!.close;
  let swings = 0;
  for (const bar of subset.slice(1)) {
    if (direction === null) {
      if (bar.close >= pivot * (1 + pct / 100)) {
        direction = "up";
        pivot = bar.close;
      } else if (bar.close <= pivot * (1 - pct / 100)) {
        direction = "down";
        pivot = bar.close;
        swings++;
      }
    } else if (direction === "up") {
      pivot = Math.max(pivot, bar.close);
      if (bar.close <= pivot * (1 - pct / 100)) {
        direction = "down";
        pivot = bar.close;
        swings++;
      }
    } else {
      pivot = Math.min(pivot, bar.close);
      if (bar.close >= pivot * (1 + pct / 100)) {
        direction = "up";
        pivot = bar.close;
      }
    }
  }
  return swings;
}

function outcome72(bars: C[], entryAt: number, entryPrice: number | null, now: number): Obj {
  if (entryPrice == null || entryPrice <= 0)
    return { outcome: "open", complete: false, peakPct: null, ddPct: null, targetAt: null, stopAt: null };
  const horizon = entryAt + 72 * H1_MS;
  const observationEnd = Math.min(horizon, now + M15_MS);
  const subset = bars.filter((b) => b.time >= entryAt && b.time < observationEnd);
  if (!subset.length)
    return { outcome: "open", complete: now >= horizon, peakPct: null, ddPct: null, targetAt: null, stopAt: null };
  let targetAt: number | null = null;
  let stopAt: number | null = null;
  let outcome = "open";
  for (const b of subset) {
    const target = b.high >= entryPrice * 1.1;
    const stop = b.low <= entryPrice * 0.9;
    if (target && stop) {
      targetAt = b.time;
      stopAt = b.time;
      outcome = "ambiguous";
      break;
    }
    if (target) {
      targetAt = b.time;
      outcome = "champion";
      break;
    }
    if (stop) {
      stopAt = b.time;
      outcome = "bad";
      break;
    }
  }
  const peak = Math.max(...subset.map((b) => b.high));
  const trough = Math.min(...subset.map((b) => b.low));
  const expectedBars = Math.max(0, Math.floor((observationEnd - entryAt) / M15_MS));
  const enoughCoverage = subset.length >= Math.floor(expectedBars * 0.9);
  const mature = now >= horizon;
  return {
    outcome: outcome === "open" && mature && !enoughCoverage ? "censored" : outcome,
    complete: mature && enoughCoverage,
    peakPct: ((peak / entryPrice) - 1) * 100,
    ddPct: ((trough / entryPrice) - 1) * 100,
    targetAt,
    stopAt,
  };
}

function simulateFourDays(bars: C[], entryAt: number, entryPrice: number | null, now: number): Obj {
  if (entryPrice == null || entryPrice <= 0) return { pnlPct: null, pnlUsd: null, exitAt: null, exitReason: "missing_entry" };
  const end = entryAt + 4 * D1_MS;
  const subset = bars.filter((b) => b.time >= entryAt && b.time < Math.min(end, now + M15_MS));
  if (!subset.length) return { pnlPct: null, pnlUsd: null, exitAt: null, exitReason: "missing_path" };
  let peak = entryPrice;
  let stop = entryPrice * 0.9;
  let beActive = false;
  let trailActive = false;
  let exit: number | null = null;
  let exitAt: number | null = null;
  let exitReason = "four_day_close";
  for (const b of subset) {
    const gapOpen = b.open < stop;
    if (gapOpen || b.low <= stop) {
      exit = gapOpen ? b.open : stop;
      exitAt = b.time;
      exitReason = trailActive ? "trailing_stop" : beActive ? "breakeven_stop" : "stop_loss";
      break;
    }
    if (b.high >= entryPrice * 1.08) {
      beActive = true;
      stop = Math.max(stop, entryPrice);
    }
    if (b.high >= entryPrice * 1.15) trailActive = true;
    peak = Math.max(peak, b.high);
    if (trailActive) stop = Math.max(stop, peak - entryPrice * 0.10);
  }
  const last = subset.at(-1)!;
  if (exit == null) {
    if (now < end) return { pnlPct: null, pnlUsd: null, exitAt: null, exitReason: "open_before_4d" };
    exit = last.close;
    exitAt = last.time + M15_MS;
  }
  const pnlPct = ((exit / entryPrice) - 1) * 100 - 0.1;
  return {
    pnlPct,
    pnlUsd: pnlPct * 10,
    exitAt,
    exitReason,
    depositEndUsd: 1000 + pnlPct * 10,
  };
}

function getCgItems(symbol: string, kind: string): Obj[] {
  const key = `${symbol}|${kind}`;
  const cached = cgCache.get(key);
  if (cached) return cached;
  const data = readJson(join(CACHE, `${symbol}_cg15m_${kind}.json`));
  const items = Array.isArray(data?.items) ? data.items : [];
  cgCache.set(key, items);
  return items;
}

function cgCoverage(symbol: string, kind: string, from: number, to: number): boolean {
  const data = readJson(join(CACHE, `${symbol}_cg15m_${kind}.json`));
  const spans = Array.isArray(data?.coverage)
    ? data.coverage
    : n(data?.from) != null && n(data?.to) != null
      ? [{ from: data.from, to: data.to }]
      : [];
  return spans.some((span: Obj) => {
    const a = timeMs(span.from);
    const b = timeMs(span.to);
    return a != null && b != null && a <= from && b >= to;
  });
}

function cgTime(item: Obj): number | null {
  return timeMs(item.time);
}

function totalAggVolume(item: Obj): number | null {
  const fut = n(item.buy) == null && n(item.sell) == null ? null : (n(item.buy) ?? 0) + (n(item.sell) ?? 0);
  return fut;
}

function aggVolumeAt(symbol: string, time: number): number | null {
  const index = (kind: string) => {
    const key = `${symbol}|${kind}`;
    let map = cgIndex.get(key);
    if (!map) {
      map = new Map(getCgItems(symbol, kind).flatMap((x) => {
        const t = cgTime(x);
        return t == null ? [] : [[t, x] as [number, Obj]];
      }));
      cgIndex.set(key, map);
    }
    return map;
  };
  const fut = index("aggfut").get(time);
  const spot = index("aggspot").get(time);
  const a = fut ? totalAggVolume(fut) : null;
  const b =
    spot == null
      ? null
      : (n(spot.buy) ?? 0) + (n(spot.sell) ?? 0);
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

function cgValues(symbol: string, kind: string): Obj[] {
  return getCgItems(symbol, kind)
    .map((x) => ({ ...x, _time: cgTime(x) }))
    .filter((x) => x._time != null)
    .sort((a, b) => a._time - b._time);
}

function latestBefore(rows: Obj[], at: number): Obj | null {
  const list = rows.filter((x) => x._time <= at);
  return list.at(-1) ?? null;
}

function calculateLiquidityMetrics(c: Candidate, lowAt: number, entryAt: number): Obj {
  const out: Obj = {};
  const oi = cgValues(c.symbol, "oi");
  const liq = cgValues(c.symbol, "liq");
  const oiAt = (t: number) => latestBefore(oi, t);
  const marketCap = c.marketCap;
  for (const hours of [1, 4]) {
    const from = entryAt - hours * H1_MS;
    const window = liq.filter((x) => x._time >= from && x._time < entryAt);
    const expectedBars = hours * 4;
    const enoughLiq = window.length >= Math.ceil(expectedBars * 0.75);
    const longUsd = window.map((x) => n(x.longUsd)).filter((x): x is number => x != null).reduce((a, b) => a + b, 0);
    const oiBase = oiAt(from);
    const oiValue = n(oiBase?.value);
    const freshOi = oiBase && from - Number(oiBase._time) <= M15_MS * 2;
    const complete = cgCoverage(c.symbol, "liq", from, entryAt - M15_MS) && cgCoverage(c.symbol, "oi", from, entryAt - M15_MS);
    out[`long_liq_${hours}h_pct_oi`] =
      complete && enoughLiq && freshOi && oiValue && oiValue > 0 ? (longUsd / oiValue) * 100 : null;
    out[`long_liq_${hours}h_pct_mcap`] =
      complete && enoughLiq && marketCap && marketCap > 0 ? (longUsd / marketCap) * 100 : null;
  }
  const oiBefore = n(oiAt(lowAt - 15 * 60_000)?.value);
  const oiAfter = n(oiAt(entryAt)?.value);
  const oiStartRow = oiAt(lowAt - 15 * 60_000);
  const oiEndRow = oiAt(entryAt);
  const oiCovered = oiStartRow && oiEndRow &&
    (lowAt - 15 * 60_000 - Number(oiStartRow._time) <= M15_MS * 2) &&
    (entryAt - Number(oiEndRow._time) <= M15_MS * 2);
  out.oi_burn_cascade_pct =
    oiCovered && oiBefore && oiAfter != null ? ((oiBefore - oiAfter) / oiBefore) * 100 : null;
  const funding = cgValues(c.symbol, "funding");
  const fundingBefore = latestBefore(funding, lowAt);
  const fundingAfter = latestBefore(funding, entryAt + H1_MS);
  out.funding_before_cascade_pct =
    fundingBefore && lowAt - Number(fundingBefore._time) <= 8 * H1_MS ? n(fundingBefore.funding) : null;
  out.funding_after_entry_pct =
    fundingAfter && entryAt + H1_MS - Number(fundingAfter._time) <= 8 * H1_MS ? n(fundingAfter.funding) : null;
  return out;
}

function aggregateVolumeProfile(c: Candidate, lowAt: number): Obj {
  const fut = cgValues(c.symbol, "aggfut");
  const spot = cgValues(c.symbol, "aggspot");
  const byTime = new Map<number, number>();
  for (const x of fut) byTime.set(x._time, (n(x.buy) ?? 0) + (n(x.sell) ?? 0));
  for (const x of spot) byTime.set(x._time, (byTime.get(x._time) ?? 0) + (n(x.buy) ?? 0) + (n(x.sell) ?? 0));
  const from = lowAt - M30D;
  const coverageFrom = from;
  const coverageTo = lowAt - M15_MS;
  const fullCoverage =
    cgCoverage(c.symbol, "aggfut", coverageFrom, coverageTo) &&
    cgCoverage(c.symbol, "aggspot", coverageFrom, coverageTo);
  const candles = cacheBars(c.symbol, "15m").filter((x) => x.time >= from && x.time < lowAt);
  const volumeRows = candles.flatMap((b) => {
    const vol = byTime.get(b.time);
    return vol == null ? [] : [{ price: (b.high + b.low + b.close) / 3, vol }];
  });
  if (!fullCoverage || volumeRows.length < 500)
    return { vp_type: null, vp_distance_poc_pct: null, vp_bars: volumeRows.length };
  const low = Math.min(...volumeRows.map((x) => x.price));
  const high = Math.max(...volumeRows.map((x) => x.price));
  if (!(high > low)) return { vp_type: null, vp_distance_poc_pct: null, vp_bars: volumeRows.length };
  const bins = Array.from({ length: 24 }, () => 0);
  for (const x of volumeRows) {
    const i = Math.min(bins.length - 1, Math.floor(((x.price - low) / (high - low)) * bins.length));
    bins[i] += x.vol;
  }
  const sorted = bins.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const poc = low + ((sorted[0]!.i + 0.5) / bins.length) * (high - low);
  const priceBin = Math.min(bins.length - 1, Math.max(0, Math.floor(((n(c.gate?.cascadeLow) ?? low) - low) / (high - low) * bins.length)));
  const rank = sorted.findIndex((x) => x.i === priceBin) / bins.length;
  return {
    vp_type: rank <= 0.25 ? "high_volume_node_or_poc" : rank >= 0.75 ? "vacuum" : "normal",
    vp_distance_poc_pct: poc > 0 ? (((n(c.gate?.cascadeLow) ?? low) / poc) - 1) * 100 : null,
    vp_bars: volumeRows.length,
  };
}

function detectSession(t: number): string {
  const hour = new Date(t).getUTCHours();
  const sessions = [
    hour >= 0 && hour < 9 ? "Asia" : "",
    hour >= 7 && hour < 17 ? "Europe" : "",
    hour >= 13 && hour < 22 ? "US" : "",
  ].filter(Boolean);
  return sessions.join("/") || "quiet";
}

function allCandlesForEntry(c: Candidate, cache: Map<string, Map<string, C[]>>): Obj {
  const byTf = cache.get(c.symbol);
  const entryAt = c.entryAt ?? c.detectedAt;
  const detectAt = c.detectedAt;
  const c15 = byTf?.get("15m") ?? [];
  const c1 = byTf?.get("1h") ?? [];
  const c4 = byTf?.get("4h") ?? [];
  const cD = byTf?.get("1d") ?? [];
  const cascade = c15.find((b) => b.time === c.gate?.cascadeCandleTime) ?? null;
  const metrics: Obj = {};

  Object.assign(metrics, indicatorSet(c15, entryAt, M15_MS, "15m"));
  Object.assign(metrics, indicatorSet(c1, entryAt, H1_MS, "1h"));
  Object.assign(metrics, indicatorSet(c4, entryAt, H4_MS, "4h"));
  Object.assign(metrics, indicatorSet(cD, entryAt, D1_MS, "1d"));
  const atr = avgTrueRange(c15.filter((b) => b.time <= (cascade?.time ?? detectAt)).slice(-240));
  metrics.cascade_range_atr_15m =
    cascade && atr && atr > 0 ? ((cascade.high - cascade.low) / atr) : null;

  for (const tf of ["15m", "1h"] as const) {
    const bars = byTf?.get(tf) ?? [];
    const step = STEP[tf];
    for (const hours of [24, 72]) {
      const from = detectAt - hours * H1_MS;
      for (const pct of [3, 5]) {
        metrics[`down_waves_${pct}_${tf}_${hours}h`] = downWaves(bars, from, detectAt, pct);
      }
    }
    void step;
  }

  const dailyClosed = cD.filter((b) => b.time + D1_MS <= detectAt);
  const zones = computeSupportZones(
    dailyClosed.map((b) => ({ ...b, volumeUsd: undefined })),
    30,
  );
  const cascadeLow = cascade?.low ?? null;
  const zone = cascadeLow == null
    ? null
    : zones
        .map((z) => ({ ...z, distance: cascadeLow < z.bottom ? z.bottom - cascadeLow : cascadeLow > z.top ? cascadeLow - z.top : 0 }))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
  metrics.daily_support_status =
    zone == null || cascadeLow == null
      ? null
      : cascadeLow >= zone.bottom && cascadeLow <= zone.top
        ? "inside"
        : cascadeLow < zone.bottom
          ? "below"
          : "above";
  metrics.daily_support_distance_pct =
    zone == null || cascadeLow == null || cascadeLow === 0 ? null : (zone.distance / cascadeLow) * 100;
  const dailyAt = (t: number) => dailyClosed.filter((b) => b.time <= t).at(-1) ?? null;
  const close7 = dailyAt(detectAt - 7 * D1_MS)?.close ?? null;
  const close30 = dailyAt(detectAt - 30 * D1_MS)?.close ?? null;
  metrics.rise_7d_before_cascade_pct = pctChange(cascadeLow, close7);
  metrics.rise_30d_before_cascade_pct = pctChange(cascadeLow, close30);

  const before = c15.filter((b) => b.time < (cascade?.time ?? detectAt));
  const recent120 = before.slice(-120);
  const volumes = recent120.map((b) => aggVolumeAt(c.symbol, b.time)).filter((x): x is number => x != null);
  const volumeAvg = mean(volumes);
  for (const delta of [0, 2]) {
    const bar = cascade ? c15.find((x) => x.time === cascade.time + delta * M15_MS) : null;
    const volume = bar ? aggVolumeAt(c.symbol, bar.time) : null;
    metrics[`absorption_plus${delta}_volume_vs_avg120`] =
      volume != null && volumeAvg != null && volumeAvg > 0 ? volume / volumeAvg : null;
    metrics[`absorption_plus${delta}_range_pct`] =
      bar && bar.open > 0 ? ((bar.high - bar.low) / bar.open) * 100 : null;
  }
  const y = c1.filter((b) => b.time + H1_MS <= detectAt).slice(-300);
  const aggVolumes = new Map<number, number>();
  for (const b of y) {
    const hourStart = Math.floor(b.time / H1_MS) * H1_MS;
    let v = 0;
    let found = false;
    for (let q = 0; q < 4; q++) {
      const x = aggVolumeAt(c.symbol, hourStart + q * 15 * 60_000);
      if (x != null) {
        v += x;
        found = true;
      }
    }
    if (found) aggVolumes.set(b.time, v);
  }
  if (y.length >= 60 && aggVolumes.size >= 30) {
    const wy = computeWyckoff(
      y.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })),
      aggVolumes,
      y.at(-1)!.time,
    );
    metrics.wyckoff_phase = wy.phase;
    metrics.wyckoff_selling_climax = wy.events.some((x) => x.type === "selling_climax");
    metrics.wyckoff_automatic_rally = wy.events.some((x) => x.type === "automatic_rally");
    metrics.wyckoff_spring = wy.events.some((x) => x.type === "spring");
  } else {
    metrics.wyckoff_phase = null;
    metrics.wyckoff_selling_climax = null;
    metrics.wyckoff_automatic_rally = null;
    metrics.wyckoff_spring = null;
  }

  metrics.first_hour_rebound_pct = (() => {
    if (!cascade) return null;
    const priorHigh = c15
      .filter((b) => b.time >= cascade.time - D1_MS && b.time < cascade.time)
      .reduce((m, b) => Math.max(m, b.high), 0);
    const laterHigh = c15
      .filter((b) => b.time >= cascade.time && b.time < cascade.time + H1_MS)
      .reduce((m, b) => Math.max(m, b.high), 0);
    const fall = priorHigh - cascade.low;
    return fall > 0 && laterHigh > 0 ? ((laterHigh - cascade.low) / fall) * 100 : null;
  })();
  for (const p of [38, 50, 62]) {
    metrics[`first_hour_recovered_${p}`] =
      metrics.first_hour_rebound_pct == null ? null : Number(metrics.first_hour_rebound_pct) >= p;
  }

  const date = new Date(detectAt);
  metrics.utc_hour = date.getUTCHours();
  metrics.utc_weekday = date.getUTCDay();
  metrics.weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
  metrics.utc_session = detectSession(detectAt);
  return metrics;
}

function addMissing(candidate: Candidate, metric: string, reason: string): void {
  if (candidate.metrics[metric] == null) candidate.missing.set(metric, reason);
}

function currentBotMetrics(c: Candidate): Obj {
  const w = c.watch ?? {};
  const s = c.signal ?? {};
  const cap = c.marketCap;
  const pctOfCap = (value: unknown, alreadyPct: unknown) => {
    const pct = n(alreadyPct);
    if (pct != null) return pct;
    const absolute = n(value);
    return absolute != null && cap != null && cap > 0 ? (absolute / cap) * 100 : null;
  };
  return {
    bot_oi30m_pct: n(s.entry_oi30m ?? s.entry_oi_30m ?? w.oi30m_at_detect),
    bot_oi1h_pct: n(s.entry_oi1h ?? s.entry_oi_1h ?? w.oi1h_at_detect),
    bot_oi4h_pct: n(s.entry_oi4h ?? s.entry_oi_4h ?? w.oi4h_at_detect),
    bot_long_liq1h_pct_mcap: pctOfCap(
      s.entry_liq_long1h ?? s.entry_long_liq1h ?? w.long_liq1h_at_detect,
      s.entry_liq_long1h_pct_mcap ?? s.entry_long_liq1h_pct_mcap,
    ),
    bot_long_liq4h_pct_mcap: pctOfCap(
      s.entry_liq_long4h ?? s.entry_long_liq4h ?? w.long_liq4h_at_detect,
      s.entry_liq_long4h_pct_mcap ?? s.entry_long_liq4h_pct_mcap,
    ),
    bot_long_liq24h_pct_mcap: pctOfCap(
      s.entry_liq_long24h ?? s.entry_long_liq24h ?? w.long_liq24h_at_detect,
      s.entry_liq_long24h_pct_mcap ?? s.entry_long_liq24h_pct_mcap,
    ),
    bot_funding_pct: n(s.entry_funding_rate ?? s.entry_funding ?? null),
    bot_global_long_pct: n(s.entry_global_long_pct ?? w.global_long_pct),
    bot_cvd30m_pct: n(s.entry_cvd30m_pct ?? s.entry_cvd_30m_pct),
    bot_cvd1h_pct: n(s.entry_cvd1h_pct ?? s.entry_cvd_1h_pct),
    bot_cvd4h_pct: n(s.entry_cvd4h_pct ?? s.entry_cvd_4h_pct),
    bot_reason: String(w.miss_reason ?? w.entry_reason ?? s.cancel_reason ?? ""),
    bot_decision_reason: String(
      c.botMeta?.nearest_snapshot?.decision_reason ??
      c.botMeta?.nearest_reject?.reason ??
      c.priorEvent?.bot_nearest_decision_reason ??
      c.priorEvent?.bot_nearest_missed_reason ??
      "",
    ),
  };
}

function addBidObservationMetrics(c: Candidate, rows: Obj[]): void {
  const observations = rows
    .filter((x) => n(x.tracked_signal_id) === c.signalId)
    .sort((a, b) => (n(a.slot_minutes) ?? 0) - (n(b.slot_minutes) ?? 0) || (timeMs(a.observed_at) ?? 0) - (timeMs(b.observed_at) ?? 0));
  const first = observations[0];
  if (!first || !Array.isArray(first.bids)) {
    c.metrics.bid_depth_below_5_pct_mcap = null;
    c.metrics.bid_depth_below_5_pct_oi = null;
    c.metrics.bid_depth_levels_5pct = null;
    c.missing.set("bid_depth_below_5_pct_mcap", "не записано ботом");
    c.missing.set("bid_depth_below_5_pct_oi", "не записано ботом");
    c.missing.set("bid_depth_levels_5pct", "не записано ботом");
    return;
  }
  const reference = n(first.reference_price);
  if (reference == null || reference <= 0) return;
  const levels = first.bids
    .map((x: Obj) => ({ price: n(x.price), usd: n(x.usd) }))
    .filter((x: Obj) => x.price != null && x.usd != null && x.price <= reference && x.price >= reference * 0.95);
  const sum = levels.reduce((total: number, x: Obj) => total + Number(x.usd), 0);
  const mcap = c.marketCap;
  const observedAt = timeMs(first.observed_at) ?? c.detectedAt;
  const oi = n(latestBefore(cgValues(c.symbol, "oi"), observedAt)?.value);
  c.metrics.bid_depth_below_5_pct_mcap = mcap && mcap > 0 ? (sum / mcap) * 100 : null;
  c.metrics.bid_depth_below_5_pct_oi = oi && oi > 0 ? (sum / oi) * 100 : null;
  c.metrics.bid_depth_levels_5pct = levels.length;
}

function addBaseMetrics(c: Candidate, allCandles: Map<string, Map<string, C[]>>, now: number): void {
  const bars = allCandles.get(c.symbol)?.get("15m") ?? [];
  const cascade = bars.find((b) => b.time === c.gate?.cascadeCandleTime) ?? null;
  if (cascade && c.gate) c.gate.cascadeLow = cascade.low;
  const entryAt = c.entryAt ?? c.detectedAt;
  const entryPrice = c.entryPrice ?? null;
  const path = outcome72(bars, entryAt, entryPrice, now);
  c.metrics = {
    ...c.metrics,
    source: c.source,
    event_id: c.eventId,
    watch_id: c.watchId,
    signal_id: c.signalId,
    symbol: c.symbol,
    detected_at: iso(c.detectedAt),
    entry_at: iso(entryAt),
    entry_price: entryPrice,
    period: c.period,
    gate_range_pct: n(c.gate?.rangePct),
    gate_rebound_body_pct: n(c.gate?.reboundBodyPct),
    gate_cascade_at: iso(c.gate?.cascadeCandleTime ?? null),
    gate_reason: c.gate?.pass ? "pass" : String(c.gate?.reason ?? "unavailable"),
    outcome_72h: path.outcome,
    outcome_complete_72h: path.complete,
    peak_pct_72h: path.peakPct,
    drawdown_pct_72h: path.ddPct,
    target_at_72h: iso(path.targetAt),
    stop_at_72h: iso(path.stopAt),
    ...allCandlesForEntry(c, allCandles),
    ...calculateLiquidityMetrics(c, c.gate?.cascadeCandleTime ?? c.detectedAt, entryAt),
    ...aggregateVolumeProfile(c, c.gate?.cascadeCandleTime ?? c.detectedAt),
    ...currentBotMetrics(c),
  };
  const four = simulateFourDays(bars, entryAt, entryPrice, now);
  Object.assign(c.metrics, {
    bot_policy_4d_pnl_pct: four.pnlPct,
    bot_policy_4d_pnl_usd: four.pnlUsd,
    bot_policy_4d_deposit_end_usd: four.depositEndUsd,
    bot_policy_4d_exit_at: iso(four.exitAt),
    bot_policy_4d_exit_reason: four.exitReason,
  });
  const marketCap = c.marketCap;
  c.metrics.market_cap_source = marketCap == null ? "" : c.signal ? "tracked_signals" : c.priorEvent?.market_cap_usd ? "prior_report_bot_snapshot" : "bot_entry_metrics";

  const botFields = [
    "bot_oi30m_pct",
    "bot_oi1h_pct",
    "bot_oi4h_pct",
    "bot_long_liq1h_pct_mcap",
    "bot_long_liq4h_pct_mcap",
    "bot_long_liq24h_pct_mcap",
    "bot_funding_pct",
    "bot_global_long_pct",
    "bot_cvd30m_pct",
    "bot_cvd1h_pct",
    "bot_cvd4h_pct",
  ];
  for (const f of botFields) addMissing(c, f, "не записано ботом");
  for (const f of [
    "15m_rsi14",
    "15m_rsi14_bull_divergence",
    "15m_atr14_pct",
    "15m_adx14",
    "1h_rsi14",
    "1h_atr14_pct",
    "1h_adx14",
    "4h_rsi14",
    "4h_atr14_pct",
    "4h_adx14",
    "1d_rsi14",
    "1d_atr14_pct",
    "1d_adx14",
    "daily_support_status",
    "rise_7d_before_cascade_pct",
    "rise_30d_before_cascade_pct",
  ]) addMissing(c, f, "нет свечей BingX");
  for (const f of [
    "long_liq_1h_pct_oi",
    "long_liq_4h_pct_oi",
    "long_liq_1h_pct_mcap",
    "long_liq_4h_pct_mcap",
    "oi_burn_cascade_pct",
    "funding_before_cascade_pct",
    "funding_after_entry_pct",
  ]) addMissing(c, f, "нет источника в reports/.cache");
  for (const f of ["liq_map_long_below_5_pct_oi", "liq_map_long_below_10_pct_oi", "liq_map_short_above_5_pct_oi", "liq_map_short_above_10_pct_oi", "liq_map_dominant_side"]) {
    c.metrics[f] = null;
    addMissing(c, f, "исторических снимков карты нет");
  }
  for (const f of ["coin_category", "coin_vs_sector_pct", "sector_coins_down5_count"]) {
    c.metrics[f] = null;
    addMissing(c, f, "нет полного исторического состава и свечей сектора");
  }
  c.metrics.unlock_7d_pct_supply = null;
  addMissing(c, "unlock_7d_pct_supply", "нет источника");
  for (const f of ["bingx_trough_drop_pct", "binance_trough_drop_pct", "bingx_entry_close_drop_pct", "binance_entry_close_drop_pct", "wick_only_one_venue"]) addMissing(c, f, "нет параллельных Binance-свечей");
  for (const f of ["basis_at_trough_pct", "basis_at_entry_pct"]) addMissing(c, f, "нет параллельных Binance spot/futures свечей");
  for (const f of ["top_trader_ls_before", "top_trader_ls_after", "global_ls_before", "global_ls_after"]) addMissing(c, f, "нет источника CoinGlass");
  for (const f of ["vp_type", "vp_distance_poc_pct"]) addMissing(c, f, "нет 30-дневного объёмного кэша");
}

function binanceFile(symbol: string, market: "spot" | "futures"): string {
  return join(BINANCE_CACHE, `${symbol}_${market}.json`);
}

function parseBinanceRows(rows: any[]): C[] {
  return rows
    .map((x) => ({
      time: timeMs(Array.isArray(x) ? x[0] : x?.time) ?? 0,
      open: n(Array.isArray(x) ? x[1] : x?.open) ?? 0,
      high: n(Array.isArray(x) ? x[2] : x?.high) ?? 0,
      low: n(Array.isArray(x) ? x[3] : x?.low) ?? 0,
      close: n(Array.isArray(x) ? x[4] : x?.close) ?? 0,
      volume: n(Array.isArray(x) ? x[7] : x?.volume) ?? n(Array.isArray(x) ? x[5] : x?.volume) ?? 0,
    }))
    .filter((x) => x.time > 0 && x.open > 0 && x.low > 0 && x.high >= x.low)
    .sort((a, b) => a.time - b.time);
}

async function fetchBinanceWindow(symbol: string, market: "spot" | "futures", from: number, to: number): Promise<C[]> {
  const pair = symbol.replace(/-USDT$/i, "USDT");
  const host = market === "spot" ? "https://api.binance.com/api/v3/klines" : "https://fapi.binance.com/fapi/v1/klines";
  const existing = readJson(binanceFile(symbol, market));
  const items = parseBinanceRows(existing?.items ?? []);
  const coveredFrom = n(existing?.from);
  const coveredTo = n(existing?.to);
  if (String(existing?.error ?? "").includes("HTTP 451")) binanceHttp451Unavailable = true;
  if (coveredFrom != null && coveredFrom <= from && coveredTo != null && coveredTo >= to) return items;
  if (binanceHttp451Unavailable) return items;
  const out = new Map(items.map((x) => [x.time, x]));
  let cursor = Math.floor(from / M15_MS) * M15_MS;
  let lastError = "";
  while (cursor <= to && cursor <= Date.now()) {
    const pageEnd = Math.min(to, cursor + 999 * M15_MS);
    const url = `${host}?symbol=${encodeURIComponent(pair)}&interval=15m&startTime=${cursor}&endTime=${pageEnd}&limit=1000`;
    let response: Response | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (response.status === 451) {
        lastError = "HTTP 451";
        binanceHttp451Unavailable = true;
        writeFileSync(BINANCE_UNAVAILABLE_CACHE, JSON.stringify({ unavailable: true, status: 451 }));
        break;
      }
      if (response.status === 429 || response.status === 418) {
        await sleep(30_000 * attempt);
        continue;
      }
      if (response.ok || response.status === 400 || response.status === 404) break;
      lastError = `HTTP ${response.status}`;
      await sleep(1000 * attempt);
    }
    if (!response || !response.ok) {
      lastError ||= `HTTP ${response?.status ?? "network"}`;
      break;
    }
    const body = await response.json();
    if (!Array.isArray(body)) {
      requestErrors.binance++;
      lastError = "unexpected_response";
      break;
    }
    for (const bar of parseBinanceRows(body)) out.set(bar.time, bar);
    if (body.length < 1000) break;
    cursor = pageEnd + M15_MS;
    await sleep(150);
  }
  const merged = sortedBars([...out.values()]);
  writeFileSync(
    binanceFile(symbol, market),
    JSON.stringify({
      from: Math.min(coveredFrom ?? from, from),
      to: Math.max(coveredTo ?? to, to),
      items: merged,
      error: lastError || null,
    }),
  );
  if (lastError) errorNotes.push(`Binance ${market} ${symbol}: ${lastError}`);
  return merged;
}

function readTopRatioCache(symbol: string): Obj[] {
  const x = readJson(join(CG_TOP_CACHE, `${symbol}.json`));
  return Array.isArray(x?.items) ? x.items : [];
}

async function fetchTopTraderRatio(symbol: string, from: number, to: number): Promise<Obj[]> {
  const path = join(CG_TOP_CACHE, `${symbol}.json`);
  const cache = readJson(path);
  if (cache && n(cache.from) != null && n(cache.from)! <= from && n(cache.to) != null && n(cache.to)! >= to)
    return cache.items ?? [];
  if (coinglassTopDisabled || process.env.STUDY_OFFLINE === "1") return cache?.items ?? [];
  const key = getNextCgKey();
  if (!key) {
    errorNotes.push(`CoinGlass top ratio ${symbol}: secret-backed key unavailable`);
    return [];
  }
  const cgSymbol = `${applyCgAlias(symbol.replace(/-USDT$/i, "").toUpperCase())}USDT`;
  const url = new URL("https://open-api-v4.coinglass.com/api/futures/top-long-short-position-ratio/history");
  url.searchParams.set("exchange", "Binance");
  url.searchParams.set("symbol", cgSymbol);
  url.searchParams.set("interval", "1h");
  url.searchParams.set("start_time", String(Math.floor(from / H1_MS) * H1_MS));
  url.searchParams.set("end_time", String(Math.floor(to / H1_MS) * H1_MS));
  url.searchParams.set("limit", "1000");
  const lastRequest = (globalThis as any).__lcCgLastRequest ?? 0;
  const wait = 10_000 - (Date.now() - lastRequest);
  if (wait > 0) await sleep(wait);
  (globalThis as any).__lcCgLastRequest = Date.now();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await cgTimedFetch(
      url.toString(),
      { headers: { "CG-API-KEY": key, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
      { priority: "low", endpoint: "top-long-short-position-ratio" },
    );
    if (response.status === 429) {
      errorNotes.push(`CoinGlass HTTP 429 ${symbol}; pause 5m before retry`);
      await sleep(300_000);
      continue;
    }
    if (!response.ok) {
      errorNotes.push(`CoinGlass top ratio ${symbol}: HTTP ${response.status}`);
      if ([400, 404, 422].includes(response.status)) {
        coinglassTopDisabled = true;
        writeFileSync(CG_DISABLED_CACHE, JSON.stringify({ disabled: true, status: response.status, symbol }));
      }
      return [];
    }
    const body = await response.json() as Obj;
    if (String(body?.code) === "429") {
      requestErrors.coinglass++;
      errorNotes.push(`CoinGlass API 429 ${symbol}; pause 5m before retry`);
      await sleep(300_000);
      continue;
    }
    if (String(body?.code) !== "0" || !Array.isArray(body.data)) {
      requestErrors.coinglass++;
      errorNotes.push(`CoinGlass top ratio ${symbol}: code ${String(body?.code)} ${String(body?.msg ?? "")}`);
      if (["400", "404", "422"].includes(String(body?.code))) {
        coinglassTopDisabled = true;
        writeFileSync(CG_DISABLED_CACHE, JSON.stringify({ disabled: true, code: String(body?.code), symbol }));
      }
      return [];
    }
    const items = body.data
      .map((x: Obj) => ({ ...x, time: timeMs(x.time ?? x.timestamp) }))
      .filter((x: Obj) => x.time != null)
      .sort((a: Obj, b: Obj) => a.time - b.time);
    writeFileSync(path, JSON.stringify({ from, to, items }));
    return items;
  }
  errorNotes.push(`CoinGlass top ratio ${symbol}: retry limit`);
  return [];
}

function ratioValue(row: Obj | null, side: "top" | "global"): number | null {
  if (!row) return null;
  const keys = side === "top"
    ? ["top_position_long_short_ratio", "long_short_position_ratio", "top_long_short_position_ratio", "long_short_ratio", "longShortRatio"]
    : ["global_account_long_short_ratio", "long_short_ratio", "ratio"];
  for (const key of keys) {
    const x = n(row[key]);
    if (x != null) return x;
  }
  return null;
}

function setVenueMetrics(
  c: Candidate,
  binance: Map<string, Map<"spot" | "futures", C[]>>,
): void {
  const bars = binance.get(c.symbol);
  if (!bars) return;
  const spot = bars.get("spot") ?? [];
  const futures = bars.get("futures") ?? [];
  const eventAt = c.gate?.cascadeCandleTime ?? c.detectedAt;
  const entryAt = c.entryAt ?? c.detectedAt;
  const basis = (at: number) => {
    const s = spot.filter((x) => x.time + M15_MS <= at).at(-1);
    const f = futures.filter((x) => x.time + M15_MS <= at).at(-1);
    return s && f && s.close > 0 ? ((f.close / s.close) - 1) * 100 : null;
  };
  c.metrics.basis_at_trough_pct = basis(eventAt + M15_MS);
  c.metrics.basis_at_entry_pct = basis(entryAt);

  const bingx = cacheBars(c.symbol, "15m");
  const compare = (list: C[], at: number) => {
    const ref = list.filter((x) => x.time >= at - D1_MS && x.time < at).reduce((m, x) => Math.max(m, x.high), 0);
    const trough = list.filter((x) => x.time >= at - M15_MS && x.time <= at + 2 * H1_MS).reduce((m, x) => Math.min(m, x.low), Infinity);
    const close = list.filter((x) => x.time + M15_MS <= entryAt).at(-1)?.close ?? null;
    return {
      drop: ref > 0 && Number.isFinite(trough) ? ((trough / ref) - 1) * 100 : null,
      closeDrop: ref > 0 && close != null ? ((close / ref) - 1) * 100 : null,
    };
  };
  const bx = compare(bingx, eventAt);
  const bn = compare(futures, eventAt);
  c.metrics.bingx_trough_drop_pct = bx.drop;
  c.metrics.binance_trough_drop_pct = bn.drop;
  c.metrics.bingx_entry_close_drop_pct = bx.closeDrop;
  c.metrics.binance_entry_close_drop_pct = bn.closeDrop;
  if (bingx.length && futures.length) {
    const start = Math.floor(c.detectedAt / M15_MS) * M15_MS;
    const decision = evaluateLcDetectionCandleGate(futures, c.detectedAt, start + 45 * 60_000);
    c.metrics.wick_only_one_venue = c.gate?.pass && !decision.pass ? "BingX_only" : !c.gate?.pass && decision.pass ? "Binance_only" : c.gate?.pass && decision.pass ? "both" : "neither";
  }
}

function setTraderRatios(c: Candidate, topItems: Obj[]): void {
  const eventAt = c.gate?.cascadeCandleTime ?? c.detectedAt;
  const top = topItems
    .map((x) => ({ ...x, _time: timeMs(x.time) }))
    .filter((x) => x._time != null);
  const global = readJson(join(CACHE, `${c.symbol}_cg2_ls.json`))?.items ?? [];
  const normalize = (rows: Obj[]) => rows
    .map((x) => ({ ...x, _time: timeMs(x.time) }))
    .filter((x: Obj) => x._time != null)
    .sort((a: Obj, b: Obj) => a._time - b._time);
  const topRows = normalize(top);
  const globalRows = normalize(global);
  const freshRatio = (rows: Obj[], at: number, side: "top" | "global") => {
    const row = latestBefore(rows, at);
    return row && at - Number(row._time) <= 2 * H1_MS ? ratioValue(row, side) : null;
  };
  c.metrics.top_trader_ls_before = freshRatio(topRows, eventAt, "top");
  c.metrics.top_trader_ls_after = freshRatio(topRows, eventAt + H1_MS, "top");
  c.metrics.global_ls_before = freshRatio(globalRows, eventAt, "global");
  c.metrics.global_ls_after = freshRatio(globalRows, eventAt + H1_MS, "global");
}

function meaningfulMetrics(): string[] {
  return [
    "bid_depth_below_5_pct_mcap", "bid_depth_below_5_pct_oi", "bid_depth_levels_5pct",
    "cg_futures_taker_net_pct_15m", "cg_spot_taker_net_pct_15m",
    "cg_spot_cvd_delta_1h_pct_mcap", "cg_spot_cvd_delta_4h_pct_mcap",
    "cg_futures_volume_mcap_pct_15m", "cg_spot_volume_mcap_pct_15m",
    "cg_oi_change_30m_pct", "cg_oi_change_1h_pct", "cg_oi_change_4h_pct",
    "cg_liq_long_mcap_pct_24h", "cg_funding_rate_15m",
    "cg_lucy_vsa_120", "cg_welkin_20", "cg_mfi_14", "cg_cmf_20", "cg_obv_120_pct_mcap",
    "15m_rsi14", "15m_rsi14_bull_divergence", "15m_atr14_pct", "15m_adx14", "15m_di_plus14", "15m_di_minus14",
    "1h_rsi14", "1h_rsi14_bull_divergence", "1h_atr14_pct", "1h_adx14", "1h_di_plus14", "1h_di_minus14",
    "4h_rsi14", "4h_rsi14_bull_divergence", "4h_atr14_pct", "4h_adx14", "4h_di_plus14", "4h_di_minus14",
    "1d_rsi14", "1d_rsi14_bull_divergence", "1d_atr14_pct", "1d_adx14", "1d_di_plus14", "1d_di_minus14",
    "cascade_range_atr_15m", "long_liq_1h_pct_mcap", "long_liq_4h_pct_mcap", "long_liq_1h_pct_oi", "long_liq_4h_pct_oi",
    "oi_burn_cascade_pct", "funding_before_cascade_pct", "funding_after_entry_pct", "wyckoff_phase",
    "wyckoff_selling_climax", "wyckoff_automatic_rally", "wyckoff_spring",
    "down_waves_3_15m_24h", "down_waves_5_15m_24h", "down_waves_3_15m_72h", "down_waves_5_15m_72h",
    "down_waves_3_1h_24h", "down_waves_5_1h_24h", "down_waves_3_1h_72h", "down_waves_5_1h_72h",
    "daily_support_status", "daily_support_distance_pct", "rise_7d_before_cascade_pct", "rise_30d_before_cascade_pct",
    "liq_map_long_below_5_pct_oi", "liq_map_long_below_10_pct_oi", "liq_map_short_above_5_pct_oi", "liq_map_short_above_10_pct_oi", "liq_map_dominant_side",
    "basis_at_trough_pct", "basis_at_entry_pct", "bingx_trough_drop_pct", "binance_trough_drop_pct",
    "bingx_entry_close_drop_pct", "binance_entry_close_drop_pct", "wick_only_one_venue",
    "coin_category", "coin_vs_sector_pct", "sector_coins_down5_count", "unlock_7d_pct_supply",
    "vp_type", "vp_distance_poc_pct", "absorption_plus0_volume_vs_avg120", "absorption_plus0_range_pct",
    "absorption_plus2_volume_vs_avg120", "absorption_plus2_range_pct",
    "prior_lc_watches_since_0714", "prior_lc_signals_since_0714", "prior_lc_champions_since_0714", "prior_lc_bad_since_0714",
    "top_trader_ls_before", "top_trader_ls_after", "global_ls_before", "global_ls_after",
    "first_hour_rebound_pct", "first_hour_recovered_38", "first_hour_recovered_50", "first_hour_recovered_62",
    "utc_hour", "utc_weekday", "weekend", "utc_session",
  ];
}

function attachPriorReportMetrics(c: Candidate, rows: Obj[] | undefined): void {
  const start = Math.floor(c.detectedAt / M15_MS) * M15_MS;
  const offset = c.gate?.cascadeCandleTime == null
    ? 0
    : Math.round((Number(c.gate.cascadeCandleTime) - start) / M15_MS);
  const row = rows?.find((x) => Number(x.offset_15m) === offset);
  if (!row) {
    for (const key of meaningfulMetrics().filter((x) => x.startsWith("cg_"))) {
      c.metrics[key] = null;
      c.missing.set(key, "нет записи в reports/lc-final-1126");
    }
    return;
  }
  const map: Record<string, string> = {
    cg_futures_taker_net_pct_15m: "cg_futures_taker_net_pct_15m",
    cg_spot_taker_net_pct_15m: "cg_spot_taker_net_pct_15m",
    cg_futures_volume_mcap_pct_15m: "cg_futures_volume_mcap_pct_15m",
    cg_spot_volume_mcap_pct_15m: "cg_spot_volume_mcap_pct_15m",
    cg_oi_change_30m_pct: "cg_oi_change_30m_pct",
    cg_oi_change_1h_pct: "cg_oi_change_1h_pct",
    cg_oi_change_4h_pct: "cg_oi_change_4h_pct",
    cg_liq_long_mcap_pct_24h: "cg_liq_long_mcap_pct_24h",
    cg_funding_rate_15m: "cg_funding_rate_15m",
    cg_lucy_vsa_120: "cg_lucy_vsa_120",
    cg_welkin_20: "cg_welkin_20",
    cg_mfi_14: "cg_mfi_14",
    cg_cmf_20: "cg_cmf_20",
  };
  for (const [target, source] of Object.entries(map)) {
    const value = row[source];
    c.metrics[target] = n(value) ?? (value === "" ? null : value);
  }
  const cap = c.marketCap;
  const cvd1h = n(row.cg_spot_cvd_delta_1h);
  const cvd4h = n(row.cg_spot_cvd_delta_4h);
  const obv = n(row.cg_obv_120);
  c.metrics.cg_spot_cvd_delta_1h_pct_mcap = cap && cvd1h != null ? (cvd1h / cap) * 100 : null;
  c.metrics.cg_spot_cvd_delta_4h_pct_mcap = cap && cvd4h != null ? (cvd4h / cap) * 100 : null;
  c.metrics.cg_obv_120_pct_mcap = cap && obv != null ? (obv / cap) * 100 : null;
  c.metrics.prior_report_metric_source = "reports/lc-final-1126/metrics-compare.csv";
}

function classifyHistoricalSignals(
  rows: Obj[],
  allCandles: Map<string, Map<string, C[]>>,
  now: number,
): Map<string, Obj> {
  const bySymbol = new Map<string, { watches: number; signals: number; champions: number; bad: number; open: number }>();
  const watchCounts = jsonl(join(WORK, "history-watches.jsonl"));
  for (const w of watchCounts) {
    bySymbol.set(String(w.symbol), {
      watches: n(w.watch_count) ?? 0,
      signals: n(w.fired_watch_count) ?? 0,
      champions: 0,
      bad: 0,
      open: 0,
    });
  }
  const signalCounts = new Map<string, number>();
  for (const s of rows) signalCounts.set(String(s.symbol), (signalCounts.get(String(s.symbol)) ?? 0) + 1);
  for (const s of rows) {
    const symbol = String(s.symbol);
    const cur = bySymbol.get(symbol) ?? { watches: 0, signals: 0, champions: 0, bad: 0, open: 0 };
    const candles = allCandles.get(symbol)?.get("15m") ?? [];
    const result = outcome72(candles, timeMs(s.detected_at) ?? 0, n(s.entry_price), now);
    if (result.outcome === "champion") cur.champions++;
    else if (result.outcome === "bad") cur.bad++;
    else cur.open++;
    cur.signals = signalCounts.get(symbol) ?? cur.signals;
    bySymbol.set(symbol, cur);
  }
  return bySymbol;
}

function evaluateRanges(events: Obj[], metrics: string[]): Obj[] {
  const rows: Obj[] = [];
  const periods = ["2026-11-01..11", "2026-11-12..26"];
  const outcomes = ["champion", "bad", "open"];
  for (const period of periods) {
    const group = events.filter((e) => e.period === period);
    for (const metric of metrics) {
      for (const outcome of outcomes) {
        const values = group
          .filter((e) => e.outcome_72h === outcome)
          .map((e) => ({ value: n(e[metric]), name: e.event_key }))
          .filter((x): x is { value: number; name: string } => x.value != null)
          .sort((a, b) => a.value - b.value);
        if (!values.length) {
          rows.push({ analysis: "full_range", period, metric, outcome, count: 0 });
          continue;
        }
        const min = values[0]!;
        const max = values.at(-1)!;
        rows.push({
          analysis: "full_range",
          period,
          metric,
          outcome,
          count: values.length,
          min_value: min.value,
          min_names: min.name,
          max_value: max.value,
          max_names: max.name,
          all_values_by_name: values.map((x) => `${x.name}=${x.value}`).join(";"),
        });
      }
    }
  }
  for (const period of periods) {
    const group = events.filter((e) => e.period === period && ["champion", "bad"].includes(e.outcome_72h));
    const champions = group.filter((e) => e.outcome_72h === "champion").length;
    const baseline = group.length ? champions / group.length : 0;
    for (const metric of metrics) {
      const present = group.filter((e) => n(e[metric]) != null);
      if (present.length < 15) continue;
      const values = present.map((e) => n(e[metric])!).sort((a, b) => a - b);
      const cuts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((q) => values[Math.floor((values.length - 1) * q)]!);
      const candidates: Obj[] = [];
      for (const threshold of [...new Set(cuts)]) {
        for (const rule of ["<=", ">="]) {
          const retained = present.filter((e) => rule === "<=" ? n(e[metric])! <= threshold : n(e[metric])! >= threshold);
          const champNames = retained.filter((e) => e.outcome_72h === "champion").map((e) => e.event_key);
          const badNames = retained.filter((e) => e.outcome_72h === "bad").map((e) => e.event_key);
          const known = champNames.length + badNames.length;
          const share = known ? champNames.length / known : 0;
          candidates.push({
            analysis: "best_threshold",
            period,
            metric,
            rule: `${rule}${threshold}`,
            threshold,
            tested_count: present.length,
            retained_count: retained.length,
            retained_champions: champNames.length,
            retained_bad: badNames.length,
            retained_open: events.filter((e) => e.period === period && e.outcome_72h === "open" && n(e[metric]) != null && (rule === "<=" ? n(e[metric])! <= threshold : n(e[metric])! >= threshold)).length,
            baseline_champion_share_pct: baseline * 100,
            retained_champion_share_pct: share * 100,
            delta_pp: (share - baseline) * 100,
            champion_names: champNames.join(";"),
            bad_names: badNames.join(";"),
            removed_names: present.filter((e) => !(rule === "<=" ? n(e[metric])! <= threshold : n(e[metric])! >= threshold)).map((e) => e.event_key).join(";"),
          });
        }
      }
      candidates.sort((a, b) => b.delta_pp - a.delta_pp || b.retained_count - a.retained_count);
      if (candidates[0]) rows.push(candidates[0]);
    }
  }
  return rows;
}

type Rule = { metric: string; op: "<=" | ">="; threshold: number };
function bestRulesByMetric(events: Obj[], metrics: string[], periods: string[]): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  for (const metric of metrics) {
    const candidates: { rule: Rule; deltas: number[]; scores: number[] }[] = [];
    const pool = events.flatMap((e) => n(e[metric]) == null ? [] : [n(e[metric]!)!]).sort((a, b) => a - b);
    if (pool.length < 15) continue;
    const thresholds = [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => pool[Math.floor((pool.length - 1) * q)]!))];
    for (const threshold of thresholds) for (const op of ["<=", ">="] as const) {
      const deltas: number[] = [];
      const scores: number[] = [];
      for (const period of periods) {
        const known = events.filter((e) => e.period === period && ["champion", "bad"].includes(e.outcome_72h));
        const baseline = known.length ? known.filter((e) => e.outcome_72h === "champion").length / known.length : 0;
        const retained = known.filter((e) => n(e[metric]) != null && (op === "<=" ? n(e[metric])! <= threshold : n(e[metric])! >= threshold));
        const share = retained.length ? retained.filter((e) => e.outcome_72h === "champion").length / retained.length : 0;
        deltas.push((share - baseline) * 100);
        scores.push(retained.length);
      }
      if (deltas.every((x) => x > 0) && scores.every((x) => x >= 10))
        candidates.push({ rule: { metric, op, threshold }, deltas, scores });
    }
    candidates.sort((a, b) => (b.deltas[0] + b.deltas[1]) - (a.deltas[0] + a.deltas[1]));
    out.set(metric, candidates.slice(0, 2).map((x) => x.rule));
  }
  return out;
}

function comboResults(events: Obj[], metrics: string[]): Obj[] {
  const periods = ["2026-11-01..11", "2026-11-12..26"];
  const rulesByMetric = bestRulesByMetric(events, metrics, periods);
  const metricRank = [...rulesByMetric.entries()]
    .map(([metric, rules]) => {
      const rows = events.filter((e) => e.outcome_72h === "champion" || e.outcome_72h === "bad");
      const scores = periods.map((period) => {
        const periodRows = rows.filter((e) => e.period === period);
        const base = periodRows.length ? periodRows.filter((e) => e.outcome_72h === "champion").length / periodRows.length : 0;
        const best = (rules.map((rule) => {
          const retained = periodRows.filter((e) => n(e[metric]) != null && (rule.op === "<=" ? n(e[metric])! <= rule.threshold : n(e[metric])! >= rule.threshold));
          return retained.length ? retained.filter((e) => e.outcome_72h === "champion").length / retained.length - base : -1;
        }).sort((a, b) => b - a)[0] ?? -1);
        return best;
      });
      return { metric, score: Math.min(...scores) };
    })
    .filter((x) => Number.isFinite(x.score) && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => x.metric);
  const ruleOptions = metricRank.map((m) => rulesByMetric.get(m) ?? []);
  const ruleGroups: Rule[][] = [];
  const collect = (start: number, chosen: Rule[], target: number) => {
    if (chosen.length === target) {
      ruleGroups.push([...chosen]);
      return;
    }
    for (let i = start; i < metricRank.length; i++) {
      for (const rule of ruleOptions[i] ?? []) collect(i + 1, [...chosen, rule], target);
    }
  };
  collect(0, [], 2);
  collect(0, [], 3);
  const output: Obj[] = [];
  for (const rules of ruleGroups) {
    const per: Obj[] = [];
    let passesBoth = true;
    for (const period of periods) {
      const all = events.filter((e) => e.period === period);
      const known = all.filter((e) => e.outcome_72h === "champion" || e.outcome_72h === "bad");
      const baseChamp = known.filter((e) => e.outcome_72h === "champion").length;
      const baseline = known.length ? baseChamp / known.length : 0;
      const passed = all.filter((e) => rules.every((r) => n(e[r.metric]) != null && (r.op === "<=" ? n(e[r.metric])! <= r.threshold : n(e[r.metric])! >= r.threshold)));
      const passedKnown = passed.filter((e) => e.outcome_72h === "champion" || e.outcome_72h === "bad");
      const champ = passedKnown.filter((e) => e.outcome_72h === "champion").length;
      const bad = passedKnown.filter((e) => e.outcome_72h === "bad").length;
      const share = passedKnown.length ? champ / passedKnown.length : 0;
      const delta = (share - baseline) * 100;
      if (!(delta > 0 && champ >= 3 && bad >= 3)) passesBoth = false;
      const money = passed.map((e) => n(e.bot_policy_4d_pnl_usd)).filter((x): x is number => x != null);
      per.push({
        period,
        baseline_champions: baseChamp,
        baseline_bad: known.length - baseChamp,
        retained_champions: champ,
        retained_bad: bad,
        retained_open: passed.filter((e) => e.outcome_72h === "open").length,
        retained_total: passed.length,
        removed_total: all.length - passed.length,
        champion_share_delta_pp: delta,
        simulated_pnl_usd_sum: money.reduce((a, b) => a + b, 0),
        retained_names: passed.map((e) => e.event_key).join(";"),
        removed_names: all.filter((e) => !passed.includes(e)).map((e) => e.event_key).join(";"),
      });
    }
    if (!passesBoth) continue;
    output.push({
      rules: rules.map((r) => `${r.metric}${r.op}${r.threshold}`).join(" AND "),
      rule_count: rules.length,
      ...Object.fromEntries(per.flatMap((x, i) => Object.entries(x).map(([k, v]) => [`p${i + 1}_${k}`, v]))),
      min_delta_pp: Math.min(...per.map((x) => x.champion_share_delta_pp)),
    });
  }
  return output.sort((a, b) => b.min_delta_pp - a.min_delta_pp).slice(0, 10);
}

function compileMissing(events: Obj[], metrics: string[]): Obj[] {
  const rows: Obj[] = [];
  for (const e of events) {
    for (const metric of new Set(metrics)) {
      if (e[metric] == null || e[metric] === "") {
        let reason = "нет источника";
        if (metric.startsWith("bot_") || metric.startsWith("bid_depth_")) reason = "не записано ботом";
        else if (metric.startsWith("liq_map_")) reason = "исторических снимков карты нет";
        else if (metric === "coin_category") {
          reason = coingeckoErrorsBySymbol.has(String(e.symbol))
            ? `CoinGecko запрос не прошёл: ${coingeckoErrorsBySymbol.get(String(e.symbol))}`
            : coingeckoCoinListError
              ? `CoinGecko список монет недоступен: ${coingeckoCoinListError}`
              : "нет однозначной CoinGecko-категории";
        }
        else if (metric.startsWith("coin_") || metric.startsWith("sector_")) reason = "нет полного исторического состава и свечей сектора";
        else if (metric.startsWith("unlock_")) reason = "нет источника";
        else if (metric.includes("bingx") || metric.includes("binance") || metric.includes("basis")) {
          reason = binanceHttp451Unavailable
            ? "Binance API недоступен: HTTP 451; биржевое сравнение не записано"
            : "нет параллельных Binance-свечей";
        }
        else if (metric.includes("trader")) {
          reason = coinglassTopDisabled
            ? "CoinGlass top-ratio endpoint stopped after unsupported-pair API 400; remaining symbols were not queried"
            : "нет источника CoinGlass";
        }
        else if (metric.includes("global_ls")) reason = "нет источника CoinGlass";
        else if (metric.startsWith("vp_")) reason = "нет 30-дневного объёмного кэша";
        else if (metric.startsWith("long_liq") || metric.startsWith("oi_burn") || metric.startsWith("funding")) reason = "нет источника в reports/.cache";
        else if (metric.startsWith("absorption") && metric.endsWith("_range_pct")) reason = "нет свечей BingX";
        else if (metric.includes("wyckoff") || metric.startsWith("absorption")) reason = "нет агрегированного объёма в кэше";
        else if (metric.includes("support") || metric.startsWith("rise_") || metric.includes("rsi") || metric.includes("atr") || metric.includes("adx") || metric.includes("di_") || metric.startsWith("down_waves")) reason = "нет свечей BingX";
        rows.push({ event_key: e.event_key, symbol: e.symbol, metric, reason });
      }
    }
  }
  return rows;
}

async function coinGeckoCategories(symbols: string[]): Promise<Map<string, string>> {
  mkdirSync(join(WORK, "coingecko"), { recursive: true });
  const coinListPath = join(CACHE, "coingecko_coinlist.json");
  let list = readJson(coinListPath);
  if (!Array.isArray(list)) {
    try {
      const response = await fetch("https://api.coingecko.com/api/v3/coins/list?include_platform=false", {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      list = await response.json();
      writeFileSync(coinListPath, JSON.stringify(list));
    } catch (error) {
      coingeckoCoinListError = String(error).slice(0, 160);
      errorNotes.push(`CoinGecko coin list: ${coingeckoCoinListError}`);
      return new Map();
    }
  }
  const bySymbol = new Map<string, Obj[]>();
  for (const item of list as Obj[]) {
    const key = String(item.symbol ?? "").toUpperCase();
    const rows = bySymbol.get(key) ?? [];
    rows.push(item);
    bySymbol.set(key, rows);
  }
  const resolved = new Map<string, string>();
  const unique = symbols
    .map((s) => ({
      symbol: s,
      base: s.replace(/-USDT$/i, "").toUpperCase(),
      matches: bySymbol.get(s.replace(/-USDT$/i, "").toUpperCase()) ?? [],
    }))
    .filter((x) => x.matches.length === 1);
  let done = 0;
  for (const item of unique) {
    const id = String(item.matches[0]!.id);
    const detailPath = join(WORK, "coingecko", `${id}.json`);
    let detail = readJson(detailPath);
    const cachedError = detail?.__studyError ? String(detail.__studyError) : null;
    if (cachedError) {
      coingeckoErrorsBySymbol.set(item.symbol, cachedError);
      detail = null;
    }
    if (!detail && (process.env.STUDY_OFFLINE === "1" || cachedError)) {
      if (!cachedError) coingeckoErrorsBySymbol.set(item.symbol, "STUDY_OFFLINE: no cached detail");
    } else if (!detail) {
      const last = (globalThis as any).__lcCgkLast ?? 0;
      const wait = 3_000 - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      (globalThis as any).__lcCgkLast = Date.now();
      try {
        const response = await fetch(
          `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
          { signal: AbortSignal.timeout(30_000) },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        detail = await response.json();
        writeFileSync(detailPath, JSON.stringify(detail));
      } catch (error) {
        const message = String(error).slice(0, 120);
        coingeckoErrorsBySymbol.set(item.symbol, message);
        errorNotes.push(`CoinGecko ${id}: ${message}`);
      }
    }
    const categories = Array.isArray(detail?.categories)
      ? detail.categories.filter((x: any) => typeof x === "string")
      : [];
    if (categories.length) resolved.set(item.symbol, categories.join("|"));
    done++;
    if (done % 25 === 0 || done === unique.length) {
      const line = `COINGECKO_PROGRESS unique_symbols=${done}/${unique.length} requests=${requestCounts.coingecko} errors=${requestErrors.coingecko}`;
      console.log(line);
      runLinesProgress(line);
    }
  }
  for (const symbol of symbols) {
    if (!resolved.has(symbol)) {
      const base = symbol.replace(/-USDT$/i, "").toUpperCase();
      const matches = bySymbol.get(base) ?? [];
      if (matches.length > 1) errorNotes.push(`CoinGecko ${symbol}: ambiguous ticker (${matches.length} matches)`);
    }
  }
  return resolved;
}

function runLinesProgress(line: string): void {
  const path = join(OUT, "run.txt");
  const existing = existsSync(path) ? text(path).trimEnd() : "";
  writeFileSync(path, `${existing}\n${line}\n`);
}

function readTradeRatios(candidates: Candidate[], now: number): Map<string, Obj[]> {
  const symbols = [...new Set(candidates.map((x) => x.symbol))];
  const rows = new Map<string, Obj[]>();
  for (const symbol of symbols) {
    const path = join(CG_TOP_CACHE, `${symbol}.json`);
    const cache = readJson(path);
    if (cache?.items) rows.set(symbol, cache.items);
  }
  void now;
  return rows;
}

async function run(): Promise<void> {
  process.env.NODE_ENV = "production";
  mkdirSync(OUT, { recursive: true });
  mkdirSync(HIST_EXTRA, { recursive: true });
  mkdirSync(BINANCE_CACHE, { recursive: true });
  mkdirSync(CG_TOP_CACHE, { recursive: true });
  const startedAt = Date.now();
  const now = Math.floor(startedAt / M15_MS) * M15_MS - M15_MS;
  const attemptStartRequests = { ...requestCounts };
  const attemptStartErrors = { ...requestErrors };
  const priorRun = existsSync(join(OUT, "run.txt")) ? text(join(OUT, "run.txt")).trimEnd() : "";
  const previousAttempts = (priorRun.match(/^ATTEMPT \d+$/gm) ?? []).length;
  const attemptPrefix = [
    ...(priorRun ? [priorRun, ""] : []),
    `ATTEMPT ${previousAttempts + 1}`,
    `command=STUDY_OFFLINE=${process.env.STUDY_OFFLINE ?? "0"} pnpm dlx tsx reports/lc-indicators-1127/study.ts`,
    `started_utc=${iso(startedAt)}`,
  ];
  writeFileSync(join(OUT, "run.txt"), `${attemptPrefix.join("\n")}\n`);
  const source = await collectCandidates();
  const allCandidates = source.candidates;
  const inputBySymbol = new Map<string, number[]>();
  for (const c of allCandidates) {
    const arr = inputBySymbol.get(c.symbol) ?? [];
    arr.push(c.detectedAt);
    inputBySymbol.set(c.symbol, arr);
  }
  const symbols = [...inputBySymbol.keys()];
  const runLines = [
    ...attemptPrefix,
    `as_of_last_closed_15m=${iso(now)}`,
    `sql_source=${RAW_SQL.join(" | ")}`,
    "production_readonly=true; database_writes=0; schema_changes=0; application_server_started=false",
    "old_report=reports/lc-final-1126; production watch rows from 2026-11-01 non-BTC=4117; fired signals=13",
    `delta_watch_rows=${source.rawDeltaWatches.length}; delta_signal_rows=${source.rawDeltaSignals.length}`,
    `historical_watch_symbols=${source.historicalWatches.length}; historical_lc_signals=${source.historicalSignals.length}; bid_observation_rows=${source.bidObservations.length}`,
    "cg_liq_heatmap_snapshot rows=0; no historical map/levels source available",
    `candidate_rows_before_gate=${allCandidates.length}; unique_symbols=${symbols.length}`,
    "study_candle_gate=exact evaluateLcDetectionCandleGate; retrospective now=start+45m to evaluate at readiness, not at current wall-clock",
    "trade_outcome=+10% before -10% over 72h from actual A entry or simulated B gate-ready close; ambiguous same-candle retained as ambiguous",
    "money_model=$1000 deposit / $100 margin / 10x; 4d stop -10%, BE after +8%, trailing from +15% by 10 percentage points, fee 0.1% round trip; same-candle stop checks precede higher highs",
  ];
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);

  const candlesBySymbol = new Map<string, Map<string, C[]>>();
  const priorGateRows = (c: Candidate) =>
    source.metricRows
      .get(`${c.source}|${c.eventId}`)
      ?.map((r) => ({
        time: timeMs(r.time) ?? 0,
        open: n(r.open) ?? 0,
        high: n(r.high) ?? 0,
        low: n(r.low) ?? 0,
        close: n(r.close) ?? 0,
        volume: 0,
      }))
      .filter((b) => b.time > 0 && b.open > 0 && b.low > 0 && b.high >= b.low) ?? [];
  const needGateSymbols = new Map<string, number>();
  for (const c of allCandidates) {
    if (priorGateRows(c).length >= 3) continue;
    needGateSymbols.set(c.symbol, Math.min(needGateSymbols.get(c.symbol) ?? c.detectedAt, c.detectedAt));
  }
  let gateCandleProgress = 0;
  await mapLimit([...needGateSymbols.entries()], 4, async ([symbol, minAt]) => {
    try {
      const bars = await klines(CACHE, symbol, "15m", minAt - 2 * D1_MS, now);
      const data = candlesBySymbol.get(symbol) ?? new Map<string, C[]>();
      data.set("15m", sortedBars(bars));
      candlesBySymbol.set(symbol, data);
    } catch (error) {
      errorNotes.push(`BingX gate candles ${symbol}: ${String(error).slice(0, 160)}`);
      candlesBySymbol.set(symbol, new Map([["15m", cacheBars(symbol, "15m")]]));
    }
    gateCandleProgress++;
    if (gateCandleProgress % 25 === 0 || gateCandleProgress === needGateSymbols.size) {
      const line = `BINGX_GATE_PROGRESS symbols=${gateCandleProgress}/${needGateSymbols.size} requests=${requestCounts.bingx} errors=${requestErrors.bingx}`;
      console.log(line);
      runLines.push(line);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  });

  const gateCounts = new Map<string, number>();
  const gated: Candidate[] = [];
  let gateUsedPriorReport = 0;
  for (const c of allCandidates) {
    const cached = candlesBySymbol.get(c.symbol)?.get("15m") ?? cacheBars(c.symbol, "15m");
    const existingReportBars = priorGateRows(c);
    const candles = existingReportBars.length >= 3 ? existingReportBars : cached;
    if (existingReportBars.length >= 3) gateUsedPriorReport++;
    const start = Math.floor(c.detectedAt / M15_MS) * M15_MS;
    const decision = evaluateLcDetectionCandleGate(candles, c.detectedAt, start + 45 * 60_000);
    c.gate = decision;
    const reason = decision.pass ? "pass" : String(decision.reason);
    gateCounts.set(reason, (gateCounts.get(reason) ?? 0) + 1);
    if (!decision.pass) continue;
    if (c.source === "B_watch") {
      const readyAt = Math.max(start + 2 * M15_MS, Number(decision.cascadeCandleTime) + 2 * M15_MS);
      const rebound = candles.find((b) => b.time === readyAt - M15_MS);
      if (!rebound) {
        gateCounts.set("passed_gate_no_entry_close", (gateCounts.get("passed_gate_no_entry_close") ?? 0) + 1);
        continue;
      }
      c.entryAt = readyAt;
      c.entryPrice = rebound.close;
    } else {
      c.entryAt = timeMs(c.signal?.detected_at ?? c.priorEvent?.detected_at);
      c.entryPrice = n(c.signal?.entry_price ?? c.priorEvent?.entry_price);
    }
    if (c.entryAt == null || c.entryPrice == null || c.entryPrice <= 0) {
      gateCounts.set("passed_gate_missing_entry", (gateCounts.get("passed_gate_missing_entry") ?? 0) + 1);
      continue;
    }
    gated.push(c);
  }
  const gateSummary = [...gateCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  runLines.push(
    `gate_counts=${gateSummary}`,
    `gate_passed_entry_ready=${gated.length}`,
    `gate_candles_reused_from_prior_report=${gateUsedPriorReport}; missing_rows_fetched_from_bingx_symbols=${needGateSymbols.size}`,
  );
  console.log(`GATE_RESULT passed=${gated.length} ${gateSummary}`);
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);

  const eventWindowBySymbol = new Map<string, { min: number; max: number }>();
  for (const c of gated) {
    const old = eventWindowBySymbol.get(c.symbol);
    eventWindowBySymbol.set(c.symbol, {
      min: Math.min(old?.min ?? c.detectedAt, c.detectedAt),
      max: Math.max(old?.max ?? c.detectedAt, c.detectedAt),
    });
  }
  let candleProgress = 0;
  const candleSymbols = [...eventWindowBySymbol.entries()];
  await mapLimit(candleSymbols, 4, async ([symbol, win]) => {
    const startMap: Record<string, number> = {
      "15m": win.min - M30D,
      "1h": win.min - 7 * D1_MS,
      "4h": win.min - 30 * D1_MS,
      "1d": win.min - 120 * D1_MS,
    };
    const data = candlesBySymbol.get(symbol) ?? new Map<string, C[]>();
    for (const tf of ["15m", "1h", "4h", "1d"] as const) {
      try {
        const loaded = await klines(CACHE, symbol, tf, startMap[tf]!, now);
        data.set(tf, sortedBars([...loaded, ...(data.get(tf) ?? [])]));
      } catch (error) {
        requestErrors.bingx++;
        errorNotes.push(`BingX klines ${symbol} ${tf}: ${String(error).slice(0, 160)}`);
        data.set(tf, cacheBars(symbol, tf));
      }
    }
    candlesBySymbol.set(symbol, data);
    candleProgress++;
    if (candleProgress % 25 === 0 || candleProgress === candleSymbols.length) {
      const line = `BINGX_SAMPLE_PROGRESS symbols=${candleProgress}/${candleSymbols.length} requests=${requestCounts.bingx} errors=${requestErrors.bingx}`;
      console.log(line);
      runLines.push(line);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  });

  const historicalSymbols = [...new Set(source.historicalSignals.map((s) => String(s.symbol)).filter((s) => s && !s.startsWith("BTC-")))];
  const historicalRanges: { symbol: string; from: number; to: number }[] = [];
  for (const s of source.historicalSignals) {
    const symbol = String(s.symbol);
    const at = timeMs(s.detected_at);
    if (!symbol || at == null || symbol.startsWith("BTC-")) continue;
    const bars = candlesBySymbol.get(symbol)?.get("15m") ?? cacheBars(symbol, "15m");
    const from = Math.floor(at / M15_MS) * M15_MS;
    const to = Math.min(from + 72 * H1_MS, now);
    const inRange = bars.filter((b) => b.time >= from && b.time <= to);
    const covered = inRange.length > 0 && inRange[0]!.time <= from + M15_MS && inRange.at(-1)!.time >= to - M15_MS;
    if (!covered && to > from) historicalRanges.push({ symbol, from, to });
  }
  const mergedRanges: typeof historicalRanges = [];
  for (const range of historicalRanges.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.from - b.from)) {
    const last = mergedRanges.at(-1);
    if (last && last.symbol === range.symbol && range.from <= last.to + 24 * H1_MS) last.to = Math.max(last.to, range.to);
    else mergedRanges.push({ ...range });
  }
  const extraBySymbol = new Map<string, C[]>();
  let historicalFetches = 0;
  await mapLimit(mergedRanges, 4, async (range) => {
    const base = cacheBars(range.symbol, "15m");
    const extraFile = join(HIST_EXTRA, `${range.symbol}_15m.json`);
    const stored = readJson(extraFile);
    const extra = parseBinanceRows(stored?.items ?? []);
    const existing = sortedBars([...base, ...extra]);
    const covered = existing.filter((b) => b.time >= range.from && b.time <= range.to);
    if (covered.length && covered[0]!.time <= range.from + M15_MS && covered.at(-1)!.time >= range.to - M15_MS) return;
    const fetched = await fetchBingxRange(range.symbol, "15m", range.from, range.to);
    historicalFetches++;
    const merged = sortedBars([...extra, ...fetched]);
    writeFileSync(extraFile, JSON.stringify({ from: Math.min(range.from, n(stored?.from) ?? range.from), to: Math.max(range.to, n(stored?.to) ?? range.to), items: merged }));
    extraBySymbol.set(range.symbol, merged);
  });
  runLines.push(`historical_signal_symbols=${historicalSymbols.length}; history_windows_missing_before_fetch=${historicalRanges.length}; merged_requests=${mergedRanges.length}; history_fetch_calls=${historicalFetches}`);
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);

  const allMetrics = meaningfulMetrics();
  for (const c of gated) {
    const current = candlesBySymbol.get(c.symbol) ?? new Map<string, C[]>();
    if (extraBySymbol.has(c.symbol)) current.set("15m", sortedBars([...(current.get("15m") ?? []), ...extraBySymbol.get(c.symbol)!]));
    candlesBySymbol.set(c.symbol, current);
    addBaseMetrics(c, candlesBySymbol, now);
    attachPriorReportMetrics(c, source.metricRows.get(`${c.source}|${c.eventId}`));
    addBidObservationMetrics(c, source.bidObservations);
    const hist = jsonl(join(WORK, "history-watches.jsonl")).find((x) => x.symbol === c.symbol);
    const oldStats = hist ?? {};
    c.metrics.prior_lc_watches_since_0714 = n(oldStats.watch_count);
    c.metrics.prior_lc_signals_since_0714 = n(oldStats.fired_watch_count);
  }

  const venueNeeds = new Map<string, { min: number; max: number }>();
  for (const c of gated) {
    const old = venueNeeds.get(c.symbol);
    venueNeeds.set(c.symbol, {
      min: Math.min(old?.min ?? c.detectedAt, c.detectedAt - D1_MS),
      max: Math.max(old?.max ?? c.entryAt! + 72 * H1_MS, c.entryAt! + 72 * H1_MS),
    });
  }
  const binanceData = new Map<string, Map<"spot" | "futures", C[]>>();
  let binanceSymbolsDone = 0;
  await mapLimit([...venueNeeds.entries()], 4, async ([symbol, win]) => {
    const to = Math.min(win.max, now);
    const both = new Map<"spot" | "futures", C[]>();
    for (const market of ["spot", "futures"] as const) {
      try {
        both.set(market, await fetchBinanceWindow(symbol, market, win.min, to));
      } catch (error) {
        requestErrors.binance++;
        errorNotes.push(`Binance ${market} ${symbol}: ${String(error).slice(0, 160)}`);
        both.set(market, []);
      }
    }
    binanceData.set(symbol, both);
    binanceSymbolsDone++;
    if (binanceSymbolsDone % 25 === 0 || binanceSymbolsDone === venueNeeds.size) {
      const line = `BINANCE_PROGRESS symbols=${binanceSymbolsDone}/${venueNeeds.size} requests=${requestCounts.binance} errors=${requestErrors.binance}`;
      console.log(line);
      runLines.push(line);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  });
  for (const c of gated) setVenueMetrics(c, binanceData);
  if (binanceHttp451Unavailable) {
    for (const c of gated) {
      for (const metric of [
        "bingx_trough_drop_pct",
        "binance_trough_drop_pct",
        "bingx_entry_close_drop_pct",
        "binance_entry_close_drop_pct",
        "wick_only_one_venue",
        "basis_at_trough_pct",
        "basis_at_entry_pct",
      ]) {
        if (c.metrics[metric] == null) {
          c.missing.set(metric, "Binance API недоступен: HTTP 451; биржевое сравнение не записано");
        }
      }
    }
    errorNotes.push("Binance API returned HTTP 451; remaining cross-exchange retries were skipped and unavailable metrics are marked in missing_metrics.csv.");
  }

  const categories = await coinGeckoCategories([...new Set(gated.map((x) => x.symbol))]);
  for (const c of gated) {
    c.metrics.coin_category = categories.get(c.symbol) ?? null;
  }

  const topBySymbol = new Map<string, Obj[]>();
  let cgCompleted = 0;
  const cgNeeds = [...new Set(gated.map((x) => x.symbol))].map((symbol) => {
    const events = gated.filter((x) => x.symbol === symbol);
    return {
      symbol,
      from: Math.min(...events.map((x) => x.detectedAt)) - 4 * H1_MS,
      to: Math.min(now, Math.max(...events.map((x) => x.entryAt ?? x.detectedAt)) + 4 * H1_MS),
    };
  });
  for (const need of cgNeeds) {
    try {
      const items = await fetchTopTraderRatio(need.symbol, need.from, need.to);
      topBySymbol.set(need.symbol, items);
    } catch (error) {
      requestErrors.coinglass++;
      errorNotes.push(`CoinGlass top ratio ${need.symbol}: ${String(error).slice(0, 160)}`);
      topBySymbol.set(need.symbol, []);
    }
    cgCompleted++;
    if (cgCompleted % 10 === 0 || cgCompleted === cgNeeds.length) {
      const line = `COINGLASS_PROGRESS symbols=${cgCompleted}/${cgNeeds.length} requests=${requestCounts.coinglass} errors=${requestErrors.coinglass}`;
      console.log(line);
      runLines.push(line);
      writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
    }
  }
  for (const c of gated) setTraderRatios(c, topBySymbol.get(c.symbol) ?? []);

  for (const [symbol, extra] of extraBySymbol) {
    const bucket = candlesBySymbol.get(symbol) ?? new Map<string, C[]>();
    bucket.set("15m", sortedBars([...(bucket.get("15m") ?? cacheBars(symbol, "15m")), ...extra]));
    candlesBySymbol.set(symbol, bucket);
  }
  const historyStats = classifyHistoricalSignals(source.historicalSignals, candlesBySymbol, now);
  for (const c of gated) {
    const stats = historyStats.get(c.symbol);
    c.metrics.prior_lc_champions_since_0714 = stats?.champions ?? null;
    c.metrics.prior_lc_bad_since_0714 = stats?.bad ?? null;
    c.metrics.prior_lc_signals_since_0714 = stats?.signals ?? c.metrics.prior_lc_signals_since_0714;
  }

  const events = gated.map((c) => ({
    event_key: c.key,
    source: c.source,
    event_id: c.eventId,
    watch_id: c.watchId,
    signal_id: c.signalId,
    symbol: c.symbol,
    detected_at: iso(c.detectedAt),
    entry_at: iso(c.entryAt),
    entry_price: c.entryPrice,
    period: c.period,
    outcome_72h: c.metrics.outcome_72h,
    outcome_complete_72h: c.metrics.outcome_complete_72h,
    peak_pct_72h: c.metrics.peak_pct_72h,
    drawdown_pct_72h: c.metrics.drawdown_pct_72h,
    target_at_72h: c.metrics.target_at_72h,
    stop_at_72h: c.metrics.stop_at_72h,
    ...c.metrics,
  }));
  const eventHeaders = [...new Set(events.flatMap((e) => Object.keys(e)))];
  writeCsv(join(OUT, "events.csv"), eventHeaders, events);

  const thresholdRows = evaluateRanges(events, allMetrics);
  const thresholdHeaders = [...new Set(thresholdRows.flatMap((x) => Object.keys(x)))];
  writeCsv(join(OUT, "thresholds.csv"), thresholdHeaders, thresholdRows);
  const combos = comboResults(events, allMetrics.filter((m) => events.some((e) => n(e[m]) != null)));
  const comboHeaders = [...new Set(combos.flatMap((x) => Object.keys(x)))];
  writeCsv(join(OUT, "combos.csv"), comboHeaders.length ? comboHeaders : ["rules", "rule_count", "min_delta_pp"], combos);
  const missing = compileMissing(events, allMetrics);
  writeCsv(join(OUT, "missing_metrics.csv"), ["event_key", "symbol", "metric", "reason"], missing);

  const outcomeCounts = events.reduce((acc: Record<string, number>, e) => {
    acc[e.outcome_72h] = (acc[e.outcome_72h] ?? 0) + 1;
    return acc;
  }, {});
  const byPeriod = ["2026-11-01..11", "2026-11-12..26", "2026-11-27+_partial"].map((period) => {
    const group = events.filter((e) => e.period === period);
    return `${period}: total=${group.length}; champion=${group.filter((e) => e.outcome_72h === "champion").length}; bad=${group.filter((e) => e.outcome_72h === "bad").length}; open=${group.filter((e) => e.outcome_72h === "open").length}; ambiguous=${group.filter((e) => e.outcome_72h === "ambiguous").length}`;
  });
  const groups = ["champion", "bad", "open"].map((outcome) => {
    const names = events.filter((e) => e.outcome_72h === outcome).map((e) => e.event_key);
    return `### ${outcome} (${names.length})\n${names.length ? names.join(", ") : "—"}`;
  });
  const comboMarkdown = combos.slice(0, 10).map((x, i) => `${i + 1}. ${x.rules}; min Δ=${Number(x.min_delta_pp).toFixed(2)} pp`).join("\n");
  const missingByMetric = new Map<string, number>();
  for (const row of missing) missingByMetric.set(row.metric, (missingByMetric.get(row.metric) ?? 0) + 1);
  const coverage = [...missingByMetric.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: missing ${v}/${events.length}`).join("\n");
  const summary = [
    "# LC indicators 2026-11-27",
    "",
    `As of ${iso(now)} (last closed BingX 15m candle). Current candle gate applied retrospectively at readiness.`,
    "",
    "## Source and cohort",
    "- Production access was read-only; no application server started and no schema or database writes were made.",
    "- Cohort: non-BTC `liq_cascade_watch` observations and fired LC signals from 2026-11-01 through the run time; only current-gate passes are in `events.csv`.",
    `- Input candidates: ${allCandidates.length}; gate outcomes: ${gateSummary}; included after gate/entry validation: ${events.length}.`,
    "- A entries use recorded tracked-signal entry; B entries use close after the rebound candle at gate readiness.",
    "- 72h outcome: +10% before −10% = champion; −10% before +10% = bad; neither = open; both in one candle = ambiguous.",
    "",
    "## Production SQL and row counts",
    "See `run.txt` for exact read-only SQL and snapshot counts.",
    `- new watch rows: ${source.rawDeltaWatches.length}; new tracked signals: ${source.rawDeltaSignals.length}; historical signals since 2026-07-14: ${source.historicalSignals.length}; historical watch-count symbols: ${source.historicalWatches.length}; stop-bid observations: ${source.bidObservations.length}.`,
    "- `cg_liq_heatmap_snapshot`: 0 rows, so historical liquidation-map levels cannot be reconstructed.",
    "",
    "## Outcomes by period",
    ...byPeriod,
    `- Overall included outcomes: ${Object.entries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.`,
    "",
    "## Full named outcome spread",
    ...groups,
    "",
    "## Thresholds and combinations",
    "- `thresholds.csv` contains every event-value range by named event, plus the best single threshold for each metric/period; it does not use medians.",
    "- `combos.csv` lists the best 2–3 metric rules that improve champion share in both comparison periods. Empty means none met the minimum-count and positive-delta requirement.",
    comboMarkdown || "No 2–3 metric combination improved champion share in both periods with at least three champions and three bad outcomes retained.",
    "",
    "## Missingness",
    coverage || "No missing metrics.",
    "",
    "## Simulation",
    "- $1,000 deposit / $100 isolated margin / 10x; initial stop −10%; break-even after +8%; trailing begins at +15%, trails by 10 percentage points; 0.1% round-trip fee.",
    "- Each event’s 4-day management result is in `events.csv`; the top-10 combination rows include retained/removed names and simulated outcomes.",
    "",
    "## Network request counts",
    `- BingX: ${requestCounts.bingx} attempts, ${requestErrors.bingx} HTTP/network errors.`,
    `- Binance: ${requestCounts.binance} attempts, ${requestErrors.binance} HTTP/network errors.`,
    `- CoinGlass: ${requestCounts.coinglass} attempts, ${requestErrors.coinglass} HTTP/network errors.`,
    `- CoinGecko: ${requestCounts.coingecko} attempts, ${requestErrors.coingecko} HTTP/network errors.`,
    "- CoinGlass series reused from `reports/.cache`; new queries were limited to missing top-trader ratios for the gate-passing sample. No volume/taker/CVD/MFI/CMF/VSA/Welkin refresh was requested.",
    "- CoinGecko categories are populated only for unambiguous tickers; historical full-sector candles, historical heatmap, and unlock data were unavailable and are blank with per-event reasons.",
    "",
    "## Errors",
    errorNotes.length ? errorNotes.map((x) => `- ${x}`).join("\n") : "- none",
  ].join("\n");
  writeFileSync(join(OUT, "summary.md"), `${summary}\n`);
  runLines.push(
    `completed_utc=${iso(Date.now())}`,
    `included_events=${events.length}; outcomes=${JSON.stringify(outcomeCounts)}`,
    `http_attempts bingx=${requestCounts.bingx} binance=${requestCounts.binance} coinglass=${requestCounts.coinglass}`,
    `http_attempts coingecko=${requestCounts.coingecko}`,
    `http_errors bingx=${requestErrors.bingx} binance=${requestErrors.binance} coinglass=${requestErrors.coinglass} coingecko=${requestErrors.coingecko}`,
    `current_attempt_http_attempts bingx=${requestCounts.bingx - attemptStartRequests.bingx} binance=${requestCounts.binance - attemptStartRequests.binance} coinglass=${requestCounts.coinglass - attemptStartRequests.coinglass} coingecko=${requestCounts.coingecko - attemptStartRequests.coingecko}`,
    `current_attempt_http_errors bingx=${requestErrors.bingx - attemptStartErrors.bingx} binance=${requestErrors.binance - attemptStartErrors.binance} coinglass=${requestErrors.coinglass - attemptStartErrors.coinglass} coingecko=${requestErrors.coingecko - attemptStartErrors.coingecko}`,
    `missing_metric_rows=${missing.length}; threshold_rows=${thresholdRows.length}; combo_rows=${combos.length}`,
    ...errorNotes.map((x) => `ERROR ${x}`),
  );
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
}

async function fetchBingxRange(symbol: string, interval: "15m", from: number, to: number): Promise<C[]> {
  if (process.env.STUDY_OFFLINE === "1") {
    return cacheBars(symbol, interval).filter((bar) => bar.time >= from && bar.time <= to);
  }
  const step = M15_MS;
  const map = new Map<number, C>();
  let cursor = Math.floor(from / step) * step;
  let lastError: unknown = null;
  while (cursor <= to) {
    const end = Math.min(to, cursor + 999 * step);
    let data: any[] | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const response = await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${end}&limit=1000`, { signal: AbortSignal.timeout(30_000) });
        const body = await response.json() as Obj;
        if (body.code === 0 && Array.isArray(body.data)) {
          data = body.data;
          break;
        }
        requestErrors.bingx++;
        lastError = new Error(`BingX code ${String(body.code)} ${String(body.msg ?? "")}`);
        if (body.code === 109415 || body.code === 109400) break;
      } catch (error) {
        lastError = error;
      }
      await sleep(1000 * attempt);
    }
    if (!data) {
      errorNotes.push(`BingX history ${symbol}: ${String(lastError).slice(0, 120)}`);
      break;
    }
    for (const x of data) {
      const t = timeMs(x.time);
      if (t == null) continue;
      map.set(t, { time: t, open: n(x.open) ?? 0, high: n(x.high) ?? 0, low: n(x.low) ?? 0, close: n(x.close) ?? 0, volume: n(x.volume) ?? 0 });
    }
    if (data.length < 1000 || end >= to) break;
    cursor = end + step;
    await sleep(60);
  }
  return sortedBars([...map.values()]);
}

run().catch((error) => {
  const line = `FATAL ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  console.error(line);
  try {
    writeFileSync(join(OUT, "run.txt"), `${existsSync(join(OUT, "run.txt")) ? text(join(OUT, "run.txt")) : ""}\n${line}\n`);
  } catch {
    // Preserve the original failure in stderr if run.txt cannot be updated.
  }
  process.exitCode = 1;
});
