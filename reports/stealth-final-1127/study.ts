/**
 * Read-only final Stealth study. Runs from artifacts/api-server with tsx.
 * Inputs from production are SELECT-only JSONL exports; external market data is
 * requested only from BingX prices and from CoinGlass for rejected champions
 * and the explicitly selected sample coins.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  computeSupportZones,
  wilderAtr,
} from "../../artifacts/api-server/src/lib/stealth-abneon-detectors.js";
import {
  LUCY_LONG_BARS,
  lucyColour,
  welkinColour,
} from "../../artifacts/api-server/src/lib/abneon-volume-gate.js";
import { computeWyckoff } from "../../artifacts/api-server/src/lib/wyckoff-metrics.js";
import { klines, H1, H4, D1, sleep } from "../../artifacts/api-server/scripts/study-v2/lib.js";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
type Obj = Record<string, any>;
type Event = Obj & {
  key: string;
  cohort: string;
  symbol: string;
  at: number;
  closeAt: number;
  entry: number | null;
  close?: number | null;
  zones_crossed?: number | null;
  bars15m?: Candle[];
  bars1h?: Candle[];
  bars4h?: Candle[];
  bars1d?: Candle[];
  outcome: string;
};

const START = Date.parse("2026-11-01T00:00:00Z");
const PREVIOUS_REPORT_END = Date.parse("2026-11-18T12:00:00Z");
const H5 = 5 * 24 * H1;
const M15 = 15 * 60_000;
const CACHE = resolve(process.cwd(), "../../reports/.cache");
const INPUT = resolve(
  process.cwd(),
  "../../reports/.cache/stealth-final-1127-input",
);
const OUT = resolve(process.cwd(), "../../reports/stealth-final-1127");
const PREVIOUS_EVENTS = resolve(
  process.cwd(),
  "../../reports/stealth-tf-1118/events.csv",
);
const PRIOR_UNIVERSE_FILES = [
  PREVIOUS_EVENTS,
  resolve(process.cwd(), "../../reports/stealth-study-v2/trades.csv"),
  resolve(process.cwd(), "../../reports/stealth-vsa/trades.csv"),
  resolve(process.cwd(), "../../reports/abneon-zone-tf/truth_Z4.csv"),
];
const HER_COINS = resolve(
  process.cwd(),
  "../../reports/stealth-her-check/her-coins.txt",
);
const DEPLOY_LOG = resolve(
  process.cwd(),
  "../../reports/.cache/stealth-final-1127-production-logs.txt",
);
const MANIFEST = JSON.parse(
  readFileSync(join(INPUT, "manifest.json"), "utf8"),
) as Obj;
const PRODUCTION_LOG_LINES = existsSync(DEPLOY_LOG)
  ? readFileSync(DEPLOY_LOG, "utf8").split(/\r?\n/).filter(Boolean)
  : [];
const RUN_AT = Date.now();
const RUN_AT_ISO = new Date(RUN_AT).toISOString();
const DB_CUTOFF = Date.parse(MANIFEST.runAt);
const DUBAI = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    hour12: false,
  }).format(ms);
const stats = {
  bingxRequests: 0,
  bingxErrors: 0,
  bingxActive: 0,
  bingxMaxConcurrent: 0,
  cgRequests: 0,
  cgErrors: 0,
  cg429: 0,
  cgOk: 0,
  cgEmpty: 0,
  cgTasksPlanned: 0,
  cgTasksDone: 0,
  cgRequestsPlanned: 0,
  cgProgressLines: [] as string[],
  errors: [] as string[],
  cgLastAt: 0,
};

function installRequestAccounting() {
  const original = globalThis.fetch.bind(globalThis);
  const bingxWaiters: Array<() => void> = [];
  let bingxCooldownUntil = 0;
  async function acquireBingXSlot() {
    while (true) {
      const cooldown = bingxCooldownUntil - Date.now();
      if (cooldown > 0) {
        await sleep(cooldown);
        continue;
      }
      if (stats.bingxActive < 4) {
        stats.bingxActive++;
        stats.bingxMaxConcurrent = Math.max(
          stats.bingxMaxConcurrent,
          stats.bingxActive,
        );
        return;
      }
      await new Promise<void>((resolve) => bingxWaiters.push(resolve));
    }
  }
  function releaseBingXSlot() {
    stats.bingxActive--;
    const next = bingxWaiters.shift();
    next?.();
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    const isBingX = url.startsWith("https://open-api.bingx.com/");
    const isCg = url.startsWith("https://open-api-v4.coinglass.com/");
    if (isBingX) {
      await acquireBingXSlot();
      stats.bingxRequests++;
    }
    if (isCg) stats.cgRequests++;
    try {
      const response = await original(input, init);
      if (isBingX && !response.ok) stats.bingxErrors++;
      if (isBingX && response.ok) {
        const body = (await response.clone().json().catch(() => null)) as
          | { code?: string | number; msg?: string }
          | null;
        if (String(body?.code ?? "") === "109429") {
          stats.bingxErrors++;
          const retryAt = Number(
            body?.msg?.match(/retry after time:\s*(\d+)/i)?.[1],
          );
          const cooldownUntil =
            Number.isFinite(retryAt) && retryAt > Date.now()
              ? retryAt
              : Date.now() + 15 * 60_000;
          if (cooldownUntil > bingxCooldownUntil) {
            bingxCooldownUntil = cooldownUntil;
            console.error(
              `BingX code 109429; новые запросы остановлены до ${new Date(bingxCooldownUntil).toISOString()}`,
            );
          }
        }
      }
      return response;
    } catch (error) {
      if (isBingX) stats.bingxErrors++;
      throw error;
    } finally {
      if (isBingX) releaseBingXSlot();
    }
  }) as typeof fetch;
}

function filesWithPrefix(prefix: string, directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => join(directory, name));
}

function readJsonLines(prefix: string, directory = INPUT): Obj[] {
  return filesWithPrefix(prefix, directory).flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Obj),
  );
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function readCsv(file: string): Obj[] {
  if (!existsSync(file)) return [];
  const [header = [], ...rows] = csvRows(readFileSync(file, "utf8"));
  return rows
    .filter((row) => row.length > 1 || (row[0] ?? "").length > 0)
    .map((row) =>
      Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])),
    );
}

function writeCsv(file: string, rows: Obj[]) {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cell = (value: unknown) => {
    let text =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
    if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  writeFileSync(
    file,
    `${headers.map(cell).join(",")}\n${rows
      .map((row) => headers.map((header) => cell(row[header])).join(","))
      .join("\n")}\n`,
  );
}

const asTime = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const normalized =
    !/[zZ]|[+-]\d\d:?\d\d$/.test(value) && value.includes("T")
      ? `${value}Z`
      : value.includes(" ") && !/[zZ]|[+-]\d\d:?\d\d$/.test(value)
        ? `${value.replace(" ", "T")}Z`
        : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
const sym = (value: unknown) =>
  String(value ?? "")
    .replace(/[-\s]*USDT$/i, "-USDT")
    .toUpperCase();
const pct = (a: number | null, b: number | null) =>
  a != null && b != null && b !== 0 ? ((a / b) - 1) * 100 : null;
const round = (n: number | null, places = 4) =>
  n == null || !Number.isFinite(n)
    ? null
    : Number(n.toFixed(places));
const floorTime = (t: number, step: number) => Math.floor(t / step) * step;
const ceilTime = (t: number, step: number) => Math.ceil(t / step) * step;

function safeBotValue(value: any, key = ""): any {
  if (value == null || typeof value !== "object") {
    const k = key.toLowerCase();
    if (
      k === "volume" ||
      k.includes("usd") ||
      k.includes("turnover") ||
      k.includes("marketcap")
    )
      return undefined;
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => safeBotValue(item, key))
      .filter((item) => item !== undefined);
  }
  const out: Obj = {};
  for (const [childKey, child] of Object.entries(value)) {
    const lower = childKey.toLowerCase();
    if (
      lower === "rangedeviation" ||
      lower === "rangedeviationafter" ||
      lower === "stealthrange4h" ||
      lower.startsWith("autorange") ||
      lower === "volume" ||
      lower.includes("usd") ||
      lower.includes("turnover") ||
      lower.includes("marketcap")
    )
      continue;
    const cleaned = safeBotValue(child, childKey);
    if (cleaned !== undefined) out[childKey] = cleaned;
  }
  return out;
}

function flattenBotMetrics(value: any, prefix = "", out: Obj = {}) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) return out;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const lower = path.toLowerCase();
    if (
      lower.includes("usd") ||
      lower.includes("marketcap") ||
      lower.includes("turnover") ||
      lower.includes("autorange") ||
      lower.includes("rangedeviation") ||
      lower.includes("stealthrange") ||
      lower.endsWith(".volume")
    )
      continue;
    if (child && typeof child === "object" && !Array.isArray(child))
      flattenBotMetrics(child, path, out);
    else if (
      (typeof child === "number" && Number.isFinite(child)) ||
      typeof child === "string" ||
      typeof child === "boolean"
    )
      out[path] = child;
  }
  return out;
}

function flattenReportMetrics(value: any, prefix = "", out: Obj = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      flattenReportMetrics(item, `${prefix}[${index}]`, out),
    );
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value))
      flattenReportMetrics(child, prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  const lower = prefix.toLowerCase();
  if (
    lower.includes("usd") ||
    lower.includes("marketcap") ||
    lower.includes("turnover") ||
    lower.includes("autorange") ||
    lower.includes("rangedeviation") ||
    lower.includes("stealthrange") ||
    lower.endsWith(".volume")
  )
    return out;
  if (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    out[prefix] = value;
  return out;
}

function reportEvent(event: Obj) {
  const rest = { ...event };
  delete rest.bars15m;
  delete rest.bars1h;
  delete rest.bars4h;
  delete rest.bars1d;
  return safeBotValue(rest);
}

function getAEventZone(signal: Obj): Obj | null {
  const dm = signal.decision_metrics ?? {};
  const neon = dm.stealthNeonLevel;
  return neon && typeof neon === "object" ? neon : null;
}

function ruleVersion(signal: Obj, at: number): string {
  if (getAEventZone(signal)) {
    if (at >= Date.parse("2026-11-21T00:00:00Z"))
      return "daily-zone + Lucy M/W + durable-24h + resistance";
    if (at >= Date.parse("2026-11-19T00:00:00Z"))
      return "daily-zone + Lucy M/W + durable-24h";
    if (at >= Date.parse("2026-11-15T00:00:00Z"))
      return "daily-zone + Lucy M/W";
    return "daily-zone breakout";
  }
  const reason = String(signal.cancel_reason ?? "");
  if (reason.includes("fresh") || reason.includes("24h_high"))
    return "legacy high-breakout (metrics not replayed)";
  if (at < Date.parse("2026-11-06T00:00:00Z"))
    return "legacy pre-Neon (metrics not replayed)";
  return "legacy Stealth (detector fields excluded)";
}

function parseHerSymbols(): string[] {
  if (!existsSync(HER_COINS)) return [];
  return [...readFileSync(HER_COINS, "utf8").matchAll(/^===\s+([^:\r\n]+)/gm)]
    .map((match) => sym(match[1]))
    .filter(Boolean);
}

const HER = new Set(["ERA-USDT", "MAGMA-USDT", ...parseHerSymbols()]);

function aggregate15mTo1h(bars: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const bar of bars) {
    const start = floorTime(bar.time, H1);
    const group = groups.get(start) ?? [];
    group.push(bar);
    groups.set(start, group);
  }
  return [...groups.entries()]
    .map(([time, group]) => {
      const sorted = group.sort((a, b) => a.time - b.time);
      return {
        time,
        open: sorted[0]!.open,
        high: Math.max(...sorted.map((bar) => bar.high)),
        low: Math.min(...sorted.map((bar) => bar.low)),
        close: sorted.at(-1)!.close,
        volume: sorted.reduce((sum, bar) => sum + bar.volume * bar.close, 0),
      };
    })
    .filter((bar) => groups.get(bar.time)?.length === 4)
    .sort((a, b) => a.time - b.time);
}

function groupCandles(bars: Candle[], step: number): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const bar of bars) {
    const start = floorTime(bar.time, step);
    const group = groups.get(start) ?? [];
    group.push(bar);
    groups.set(start, group);
  }
  return [...groups.entries()]
    .map(([time, group]) => {
      const sorted = group.sort((a, b) => a.time - b.time);
      return {
        time,
        open: sorted[0]!.open,
        high: Math.max(...sorted.map((bar) => bar.high)),
        low: Math.min(...sorted.map((bar) => bar.low)),
        close: sorted.at(-1)!.close,
        volume: sorted.reduce((sum, bar) => sum + bar.volume * bar.close, 0),
      };
    })
    .filter((bar) => groups.get(bar.time)?.length === step / M15)
    .sort((a, b) => a.time - b.time);
}

function firstPassage(
  bars: Candle[],
  at: number,
  entry: number,
  maxHours: number,
  upPct: number,
  downPct: number,
) {
  const start = ceilTime(at, M15);
  const until = Math.min(RUN_AT, at + maxHours * H1);
  let mfe = -Infinity;
  let mae = Infinity;
  let upAt: number | null = null;
  let downAt: number | null = null;
  let ambiguous = false;
  for (const bar of bars) {
    if (bar.time < start || bar.time >= until) continue;
    const highPct = pct(bar.high, entry)!;
    const lowPct = pct(bar.low, entry)!;
    mfe = Math.max(mfe, highPct);
    mae = Math.min(mae, lowPct);
    const up = highPct >= upPct;
    const down = lowPct <= downPct;
    if (up && upAt == null) upAt = bar.time;
    if (down && downAt == null) downAt = bar.time;
    if (up && down) {
      ambiguous = true;
      break;
    }
    if (upAt != null || downAt != null) break;
  }
  const elapsed = Math.max(0, Math.min(until, RUN_AT) - at);
  const complete = elapsed >= maxHours * H1;
  let outcome = "open";
  if (ambiguous) outcome = "ambiguous";
  else if (upAt != null && (downAt == null || upAt < downAt))
    outcome = "champion";
  else if (downAt != null && (upAt == null || downAt < upAt))
    outcome = "bad";
  else if (!complete) outcome = "open";
  return {
    outcome,
    complete,
    mfe: Number.isFinite(mfe) ? round(mfe) : null,
    mae: Number.isFinite(mae) ? round(mae) : null,
    hoursToPlus10: upAt == null ? null : round((upAt - at) / H1, 2),
    hoursToMinus8: downAt == null ? null : round((downAt - at) / H1, 2),
    ambiguous,
  };
}

function pathStats(
  bars: Candle[],
  at: number,
  entry: number,
  horizon: number,
) {
  const start = ceilTime(at, M15);
  const end = Math.min(RUN_AT, at + horizon * H1);
  let max = -Infinity;
  let min = Infinity;
  let last: number | null = null;
  let hit10 = false;
  let hitMinus8 = false;
  for (const bar of bars) {
    if (bar.time < start || bar.time >= end) continue;
    max = Math.max(max, bar.high);
    min = Math.min(min, bar.low);
    last = bar.close;
    if (bar.high >= entry * 1.1) hit10 = true;
    if (bar.low <= entry * 0.92) hitMinus8 = true;
  }
  return {
    maxPct: Number.isFinite(max) ? round(pct(max, entry)) : null,
    minPct: Number.isFinite(min) ? round(pct(min, entry)) : null,
    closePct: last == null ? null : round(pct(last, entry)),
    hit10,
    hitMinus8,
    complete: end >= at + horizon * H1,
  };
}

function ema(values: number[], length: number): number | null {
  if (values.length < length) return null;
  const k = 2 / (length + 1);
  let result =
    values.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  for (let i = length; i < values.length; i++)
    result = values[i]! * k + result * (1 - k);
  return result;
}

function priceIndicators(bars: Candle[], index: number, step: number): Obj {
  const c = bars[index];
  if (!c || index < 2) return {};
  const out: Obj = {};
  const closes = bars.slice(0, index + 1).map((bar) => bar.close);
  const rsi = (length: number) => {
    if (closes.length < length + 1) return null;
    let gain = 0;
    let loss = 0;
    for (let i = closes.length - length; i < closes.length; i++) {
      const delta = closes[i]! - closes[i - 1]!;
      if (delta > 0) gain += delta;
      else loss -= delta;
    }
    if (loss === 0) return 100;
    const rs = gain / loss;
    return 100 - 100 / (1 + rs);
  };
  out.rsi14 = round(rsi(14), 3);
  const tr: number[] = [];
  for (let i = 1; i <= index; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!;
    tr.push(
      Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - prev.close),
        Math.abs(bar.low - prev.close),
      ),
    );
  }
  const atr = tr.length >= 14 ? tr.slice(-14).reduce((a, b) => a + b, 0) / 14 : null;
  out.atr14Pct = atr == null ? null : round((atr / c.close) * 100, 3);
  const dmiAt = (endIndex: number) => {
    if (endIndex < 14) return null;
    let trSum = 0;
    let plusSum = 0;
    let minusSum = 0;
    for (let i = endIndex - 13; i <= endIndex; i++) {
      const current = bars[i]!;
      const previous = bars[i - 1]!;
      trSum += Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      );
      const up = current.high - previous.high;
      const down = previous.low - current.low;
      if (up > down && up > 0) plusSum += up;
      if (down > up && down > 0) minusSum += down;
    }
    if (!trSum) return null;
    const plus = (plusSum / trSum) * 100;
    const minus = (minusSum / trSum) * 100;
    return { plus, minus, dx: plus + minus ? (Math.abs(plus - minus) / (plus + minus)) * 100 : 0 };
  };
  const dmi = dmiAt(index);
  const dxWindow = Array.from({ length: 14 }, (_, offset) => dmiAt(index - 13 + offset)?.dx)
    .filter((value): value is number => value != null);
  out.diPlus14 = dmi ? round(dmi.plus, 3) : null;
  out.diMinus14 = dmi ? round(dmi.minus, 3) : null;
  out.adx14 = dxWindow.length === 14
    ? round(dxWindow.reduce((sum, value) => sum + value, 0) / dxWindow.length, 3)
    : null;
  for (const length of [20, 50, 200]) {
    const e = ema(closes, length);
    const prior = ema(closes.slice(0, -5), length);
    out[`ema${length}DistancePct`] = e == null ? null : round(pct(c.close, e), 3);
    out[`ema${length}Slope5Pct`] =
      e == null || prior == null ? null : round(pct(e, prior), 3);
  }
  if (closes.length >= 20) {
    const last = closes.slice(-20);
    const mean = last.reduce((a, b) => a + b, 0) / last.length;
    const sd = Math.sqrt(last.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    out.bbPercentB = sd ? round((c.close - (mean - 2 * sd)) / (4 * sd), 4) : null;
    out.bbWidthPct = mean ? round((4 * sd / mean) * 100, 4) : null;
  } else {
    out.bbPercentB = null;
    out.bbWidthPct = null;
  }
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  out.macdPct =
    e12 == null || e26 == null || c.close === 0
      ? null
      : round(((e12 - e26) / c.close) * 100, 4);
  // VWAP requires an approved aggregate-volume series; BingX turnover is kept
  // in its own comparison field and is not used for this indicator.
  out.vwap24hDistancePct = null;
  return out;
}

function volumeIndicators(
  bars: Candle[],
  volumes: Map<number, number> | null,
  index: number,
): Obj {
  if (!volumes || index < 20) return {};
  const out: Obj = {};
  const start = Math.max(0, index - 19);
  const win = bars.slice(start, index + 1);
  const mv = win.map((bar) => volumes.get(bar.time));
  if (mv.some((value) => value == null || !Number.isFinite(value))) {
    out.mfi14 = null;
    out.cmf20 = null;
    out.obvSlope20 = null;
    return out;
  }
  let positive = 0;
  let negative = 0;
  for (let i = Math.max(1, index - 13); i <= index; i++) {
    const typical = (bars[i]!.high + bars[i]!.low + bars[i]!.close) / 3;
    const prev = bars[i - 1]!;
    const prevTypical = (prev.high + prev.low + prev.close) / 3;
    const flow = typical * (volumes.get(bars[i]!.time) ?? 0);
    if (typical > prevTypical) positive += flow;
    else if (typical < prevTypical) negative += flow;
  }
  out.mfi14 = negative === 0 ? 100 : round(100 - 100 / (1 + positive / negative), 3);
  let mfv = 0;
  let sumVol = 0;
  for (let i = start; i <= index; i++) {
    const bar = bars[i]!;
    const v = volumes.get(bar.time) ?? 0;
    const mult =
      bar.high === bar.low
        ? 0
        : ((bar.close - bar.low) - (bar.high - bar.close)) / (bar.high - bar.low);
    mfv += mult * v;
    sumVol += v;
  }
  out.cmf20 = sumVol ? round(mfv / sumVol, 5) : null;
  let obv = 0;
  const obvValues: number[] = [];
  for (let i = Math.max(1, index - 19); i <= index; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!;
    const v = volumes.get(bar.time) ?? 0;
    obv += bar.close > prev.close ? v : bar.close < prev.close ? -v : 0;
    obvValues.push(obv);
  }
  out.obvSlope20 =
    obvValues.length > 1 && obvValues[0] !== 0
      ? round(((obvValues.at(-1)! - obvValues[0]!) / Math.abs(obvValues[0]!)) * 100, 4)
      : null;
  return out;
}

function cacheFileFor(symbol: string, suffix: string) {
  return join(CACHE, `${symbol}_${suffix}.json`);
}

function readCache<T>(file: string): { from: number; to: number; items: T[] | null } | null {
  try {
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as {
          from: number;
          to: number;
          items: T[] | null;
        })
      : null;
  } catch {
    return null;
  }
}

const FUT_LIST =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
const SPOT_LIST =
  "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const CG_ROOT = "https://open-api-v4.coinglass.com";
let cgStartCooldownChecked = false;
let cgProgressLast = 0;

function production429InWindow(): boolean {
  if (!existsSync(DEPLOY_LOG)) return false;
  const cutoff = Date.now() - 10 * 60_000;
  const specific429 =
    /\b(?:status|statusCode|httpStatus)\s*[=:]?\s*429\b|\bHTTP\s+429\b|429\s+Too Many Requests/i;
  return readFileSync(DEPLOY_LOG, "utf8")
    .split(/\r?\n/)
    .some((line) => {
      if (!specific429.test(line)) return false;
      const match = line.match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/);
      return match ? Date.parse(match[0]) >= cutoff : false;
    });
}

function missingCacheSegments(
  symbol: string,
  suffix: string,
  start: number,
  end: number,
) {
  const cached = readCache<Obj>(cacheFileFor(symbol, suffix));
  if (cached?.items && cached.from <= start && cached.to >= end) return 0;
  if (!cached?.items) return 1;
  return Number(cached.from > start) + Number(cached.to < end);
}

function reportCgProgress() {
  if (stats.cgRequests < cgProgressLast + 50) return;
  cgProgressLast = Math.floor(stats.cgRequests / 50) * 50;
  const remaining = Math.max(0, stats.cgRequestsPlanned - stats.cgRequests);
  const eta = Date.now() + remaining * 4_200;
  const line =
    `CoinGlass: ${stats.cgRequests}/${stats.cgRequestsPlanned} запросов · ` +
    `осталось примерно ${remaining} · конец около ${DUBAI(eta)} Dubai`;
  stats.cgProgressLines.push(line);
  console.error(line);
}

async function cgRequest(
  path: string,
  params: Record<string, string>,
): Promise<Obj[] | null> {
  const key = process.env.CoinGlassAPI?.trim();
  if (!key) {
    stats.cgErrors++;
    stats.errors.push("CoinGlass key unavailable to the study process");
    return null;
  }
  if (!cgStartCooldownChecked) {
    cgStartCooldownChecked = true;
    if (production429InWindow()) {
      console.error("CoinGlass production 429 in last 10m; waiting 5 minutes");
      await sleep(5 * 60_000);
    }
  }
  const url = new URL(`${CG_ROOT}${path}`);
  for (const [name, value] of Object.entries(params))
    url.searchParams.set(name, value);
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = stats.cgLastAt + 4_200 - Date.now();
    if (wait > 0) await sleep(wait);
    stats.cgLastAt = Date.now();
    try {
      const response = await fetch(url, {
        headers: { "CG-API-KEY": key, accept: "application/json" },
        signal: AbortSignal.timeout(25_000),
      });
      reportCgProgress();
      if (response.status === 429) {
        stats.cg429++;
        stats.cgErrors++;
        const retryAfter = response.headers.get("retry-after");
        const seconds = retryAfter ? Number(retryAfter) : NaN;
        const delay =
          Number.isFinite(seconds) && seconds > 0
            ? seconds * 1000
            : 60_000;
        await sleep(Math.max(60_000, delay));
        continue;
      }
      if (!response.ok) {
        stats.cgErrors++;
        return null;
      }
      const body = (await response.json()) as {
        code?: string;
        data?: Obj[];
      };
      if (String(body.code) !== "0") {
        stats.cgErrors++;
        return null;
      }
      stats.cgOk++;
      if (!body.data?.length) stats.cgEmpty++;
      return body.data ?? [];
    } catch (error) {
      stats.cgErrors++;
      if (attempt === 4) {
        stats.errors.push(`CoinGlass ${path}: ${String(error).slice(0, 160)}`);
        return null;
      }
      await sleep(5_000);
    }
  }
  return null;
}

function cgRowsForCache(
  symbol: string,
  source: string,
  raw: Obj[],
): Obj[] {
  const secondsToMs = (t: unknown) => {
    const n = Number(t);
    return n < 1e12 ? n * 1000 : n;
  };
  return raw
    .map((row) => {
      const time = secondsToMs(row.time);
      if (source === "aggfut")
        return {
          time,
          buy: Number(row.aggregated_buy_volume_usd),
          sell: Number(row.aggregated_sell_volume_usd),
        };
      if (source === "aggspot")
        return {
          time,
          buy: Number(row.agg_taker_buy_vol),
          sell: Number(row.agg_taker_sell_vol),
          cvd: Number(row.cum_vol_delta),
        };
      return { ...row, time };
    })
    .filter((row) => Number.isFinite(row.time));
}

async function ensureCoinGlassSeries(
  symbol: string,
  source: string,
  start: number,
  end: number,
): Promise<Obj[] | null> {
  const cacheSuffix =
    source === "oi" || source === "liq" ? `cg2_${source}` : `cg_${source}`;
  const file = cacheFileFor(symbol, cacheSuffix);
  const cached = readCache<Obj>(file);
  if (cached?.items && cached.from <= start && cached.to >= end)
    return cached.items;
  const base = symbol.replace(/-?USDT$/i, "").toUpperCase();
  const segments: Array<[number, number]> = [];
  if (!cached?.items) segments.push([start, end]);
  else {
    if (cached.from > start) segments.push([start, Math.min(end, cached.from)]);
    if (cached.to < end) segments.push([Math.max(start, cached.to), end]);
  }
  const all = new Map<number, Obj>();
  for (const row of cached?.items ?? []) {
    const t = num(row.time);
    if (t != null) all.set(t, row);
  }
  for (const [from, to] of segments) {
    if (from >= to) continue;
    const common = {
      interval: "1h",
      start_time: String(from),
      end_time: String(to),
      limit: String(Math.min(4500, Math.ceil((to - from) / H1) + 4)),
    };
    const result =
      source === "aggfut"
        ? await cgRequest(
            "/api/futures/aggregated-taker-buy-sell-volume/history",
            { ...common, symbol: base, exchange_list: FUT_LIST },
          )
        : source === "aggspot"
          ? await cgRequest("/api/spot/aggregated-cvd/history", {
              ...common,
              symbol: base,
              exchange_list: SPOT_LIST,
            })
          : await cgRequest(
              source === "oi"
                ? "/api/futures/open-interest/aggregated-history"
                : "/api/futures/liquidation/aggregated-history",
              { ...common, symbol: base, ...(source === "liq" ? { exchange_list: FUT_LIST } : {}) },
            );
    if (result == null) return cached?.items ?? null;
    for (const row of cgRowsForCache(symbol, source, result)) {
      const t = num(row.time);
      if (t != null) all.set(t, row);
    }
    stats.cgTasksDone++;
  }
  const items = [...all.values()].sort(
    (a, b) => Number(a.time) - Number(b.time),
  );
  writeFileSync(
    file,
    JSON.stringify({
      from: cached?.items ? Math.min(cached.from, start) : start,
      to: cached?.items ? Math.max(cached.to, end) : end,
      items,
    }),
  );
  return items;
}

async function ensureFunding(
  symbol: string,
  start: number,
  end: number,
): Promise<Obj[] | null> {
  const file = cacheFileFor(symbol, "cg_oi_weight_funding");
  const cached = readCache<Obj>(file);
  if (cached?.items && cached.from <= start && cached.to >= end)
    return cached.items;
  const base = symbol.replace(/-?USDT$/i, "").toUpperCase();
  const segments: Array<[number, number]> = [];
  if (!cached?.items) segments.push([start, end]);
  else {
    if (cached.from > start) segments.push([start, Math.min(end, cached.from)]);
    if (cached.to < end) segments.push([Math.max(start, cached.to), end]);
  }
  const all = new Map<number, Obj>();
  for (const row of cached?.items ?? []) all.set(Number(row.time), row);
  for (const [from, to] of segments) {
    if (from >= to) continue;
    const raw = await cgRequest("/api/futures/funding-rate/oi-weight-history", {
      symbol: base,
      interval: "1h",
      start_time: String(from),
      end_time: String(to),
      limit: String(Math.min(4500, Math.ceil((to - from) / H1) + 4)),
    });
    if (raw == null) return cached?.items ?? null;
    for (const row of raw) {
      const time = Number(row.time) < 1e12 ? Number(row.time) * 1000 : Number(row.time);
      all.set(time, { time, rate: num(row.close ?? row.funding_rate ?? row.rate) });
    }
    stats.cgTasksDone++;
  }
  const items = [...all.values()].sort((a, b) => Number(a.time) - Number(b.time));
  writeFileSync(
    file,
    JSON.stringify({
      from: cached?.items ? Math.min(cached.from, start) : start,
      to: cached?.items ? Math.max(cached.to, end) : end,
      items,
    }),
  );
  return items;
}

function useCachedCg(
  symbol: string,
  source: "aggfut" | "aggspot",
  at: number,
  barsBack = 480,
): Obj[] | null {
  const cached = readCache<Obj>(cacheFileFor(symbol, `cg_${source}`));
  if (
    !cached?.items ||
    cached.from > at - barsBack * H1 ||
    cached.to < at + H1
  )
    return null;
  return cached.items;
}

function mapItems(items: Obj[] | null) {
  return new Map(
    (items ?? [])
      .map((row) => [Number(row.time), row] as const)
      .filter((entry) => Number.isFinite(entry[0])),
  );
}

function getH1Aggregate(
  fut: Map<number, Obj>,
  spot: Map<number, Obj>,
  time: number,
) {
  const f = fut.get(time);
  const s = spot.get(time);
  if (
    !f ||
    !s ||
    num(f.buy) == null ||
    num(f.sell) == null ||
    num(s.buy) == null ||
    num(s.sell) == null
  )
    return null;
  const futVol = Number(f.buy) + Number(f.sell);
  const spotVol = Number(s.buy) + Number(s.sell);
  return {
    total: futVol + spotVol,
    futVol,
    spotVol,
    futNetPct: futVol ? ((Number(f.buy) - Number(f.sell)) / futVol) * 100 : null,
    spotNetPct:
      spotVol && s
        ? ((Number(s.buy) - Number(s.sell)) / spotVol) * 100
        : null,
    spotCvdPct:
      spotVol && s && num(s.cvd) != null
        ? (Number(s.cvd) / spotVol) * 100
        : null,
  };
}

function aggregateVolumeMap(
  candles: Candle[],
  fut: Map<number, Obj>,
  spot: Map<number, Obj>,
  step: number,
) {
  const out = new Map<number, number>();
  for (const bar of candles) {
    const count = step / H1;
    let total = 0;
    let complete = true;
    for (let hour = 0; hour < count; hour++) {
      const item = getH1Aggregate(fut, spot, bar.time + hour * H1);
      if (!item) {
        complete = false;
        break;
      }
      total += item.total;
    }
    if (complete) out.set(bar.time, total);
  }
  return out;
}

function aggregateReading(event: Event, fut: Map<number, Obj>, spot: Map<number, Obj>) {
  const h1 = event.bars1h ?? [];
  const h4 = event.bars4h ?? [];
  const d1 = event.bars1d ?? [];
  const vol1h = aggregateVolumeMap(h1, fut, spot, H1);
  const vol4h = aggregateVolumeMap(h4, fut, spot, H4);
  const vol1d = aggregateVolumeMap(d1, fut, spot, D1);
  const i1 = h1.findIndex((bar) => bar.time === floorTime(event.closeAt - H1, H1));
  const i4 = h4.findIndex((bar) => bar.time === event.candle_open_ms);
  const iD = d1.findLastIndex((bar) => bar.time + D1 <= event.closeAt);
  const lucy = (bars: Candle[], volumes: Map<number, number>, index: number) => {
    if (index < LUCY_LONG_BARS - 1) return { colour: null, welkin: null, ratio: null };
    const win = bars
      .slice(index - LUCY_LONG_BARS + 1, index + 1)
      .map((bar) => volumes.get(bar.time) ?? Number.NaN);
    if (win.some((value) => !Number.isFinite(value)))
      return { colour: null, welkin: null, ratio: null };
    const average = win.reduce((a, b) => a + b, 0) / win.length;
    return {
      colour: lucyColour(win, win.length - 1),
      welkin: welkinColour(win, win.length - 1),
      ratio: average > 0 ? round(win.at(-1)! / average, 5) : null,
    };
  };
  const colorWindow = (bars: Candle[], volumes: Map<number, number>, index: number, before: number, after: number) =>
    Array.from({ length: before + after + 1 }, (_, j) => {
      const offset = j - before;
      const idx = index + offset;
      const bar = bars[idx];
      if (!bar) return { offset, time: null, lucy_colour: null, welkin_colour: null, volume_vs_avg120: null };
      const reading = lucy(bars, volumes, idx);
      return {
        offset,
        time: new Date(bar.time).toISOString(),
        lucy_colour: reading.colour,
        welkin_colour: reading.welkin,
        volume_vs_avg120: reading.ratio,
      };
    });
  const sellingClimax48 = (
    bars: Candle[],
    volumes: Map<number, number>,
    index: number,
  ) => {
    if (
      index < 48 ||
      bars
        .slice(index - 48, index)
        .some((bar) => !Number.isFinite(volumes.get(bar.time)))
    )
      return {
        bars_ago: null,
        lucy_colour: null,
        welkin_colour: null,
        volume_vs_avg120: null,
        down: null,
        close_pos: null,
      };
    let climaxIndex = index - 48;
    for (let i = index - 47; i < index; i++) {
      if ((volumes.get(bars[i]!.time) ?? -Infinity) >
          (volumes.get(bars[climaxIndex]!.time) ?? -Infinity))
        climaxIndex = i;
    }
    const bar = bars[climaxIndex]!;
    const volumeReading = lucy(bars, volumes, climaxIndex);
    return {
      bars_ago: index - climaxIndex,
      lucy_colour: volumeReading.colour,
      welkin_colour: volumeReading.welkin,
      volume_vs_avg120: volumeReading.ratio,
      down: bar.close < bar.open,
      close_pos:
        bar.high > bar.low
          ? round(((bar.close - bar.low) / (bar.high - bar.low)) * 100, 4)
          : null,
    };
  };
  const h1Reading = i1 < 0 ? { colour: null, welkin: null, ratio: null } : lucy(h1, vol1h, i1);
  const h4Reading = i4 < 0 ? { colour: null, welkin: null, ratio: null } : lucy(h4, vol4h, i4);
  const at1h = i1 < 0 ? {} : volumeIndicators(h1, vol1h, i1);
  const at4h = i4 < 0 ? {} : volumeIndicators(h4, vol4h, i4);
  const at1d = iD < 0 ? {} : volumeIndicators(d1, vol1d, iD);
  const eventHour = floorTime(event.closeAt - H1, H1);
  const aggregateAt = (time: number) => getH1Aggregate(fut, spot, time);
  const eventH4Hours = Array.from({ length: 4 }, (_, hour) =>
    aggregateAt(event.candle_open_ms + hour * H1),
  );
  const completeEventH4 = eventH4Hours.every((row) => row != null);
  const h4FuturesBuy = completeEventH4
    ? eventH4Hours.reduce(
        (sum, _, hour) =>
          sum + Number(fut.get(event.candle_open_ms + hour * H1)?.buy ?? 0),
        0,
      )
    : null;
  const h4FuturesSell = completeEventH4
    ? eventH4Hours.reduce(
        (sum, _, hour) =>
          sum + Number(fut.get(event.candle_open_ms + hour * H1)?.sell ?? 0),
        0,
      )
    : null;
  const h4SpotBuy = completeEventH4
    ? eventH4Hours.reduce(
        (sum, _, hour) =>
          sum + Number(spot.get(event.candle_open_ms + hour * H1)?.buy ?? 0),
        0,
      )
    : null;
  const h4SpotSell = completeEventH4
    ? eventH4Hours.reduce(
        (sum, _, hour) =>
          sum + Number(spot.get(event.candle_open_ms + hour * H1)?.sell ?? 0),
        0,
      )
    : null;
  const h4SpotCvd = completeEventH4
    ? eventH4Hours.reduce(
        (sum, _, hour) =>
          sum + Number(spot.get(event.candle_open_ms + hour * H1)?.cvd ?? 0),
        0,
      )
    : null;
  const spotCvdPct = (hours: number) => {
    let delta = 0;
    let total = 0;
    for (let i = 0; i < hours; i++) {
      const row = aggregateAt(eventHour - (hours - 1 - i) * H1);
      if (!row) return null;
      const source = spot.get(eventHour - (hours - 1 - i) * H1);
      if (!source || num(source.cvd) == null) return null;
      delta += Number(source.cvd);
      total += row.spotVol;
    }
    return total > 0 ? round((delta / total) * 100, 5) : null;
  };
  const oi = mapItems(readCache<Obj>(cacheFileFor(event.symbol, "cg2_oi"))?.items ?? null);
  const funding = mapItems(readCache<Obj>(cacheFileFor(event.symbol, "cg_oi_weight_funding"))?.items ?? null);
  const oiValue = (time: number) => num(oi.get(time)?.close);
  const oiNow = oiValue(eventHour);
  const price1h = i1 < 0 ? {} : priceIndicators(h1, i1, H1);
  const price4h = i4 < 0 ? {} : priceIndicators(h4, i4, H4);
  const price1d = iD < 0 ? {} : priceIndicators(d1, iD, D1);
  const aggregatedVwapDistance = (
    bars: Candle[],
    volumes: Map<number, number>,
    index: number,
    count: number,
  ) => {
    if (index < count - 1) return null;
    const window = bars.slice(index - count + 1, index + 1);
    let numerator = 0;
    let denominator = 0;
    for (const bar of window) {
      const volume = volumes.get(bar.time);
      if (volume == null || !Number.isFinite(volume)) return null;
      numerator += ((bar.high + bar.low + bar.close) / 3) * volume;
      denominator += volume;
    }
    return denominator
      ? round(pct(window.at(-1)!.close, numerator / denominator), 5)
      : null;
  };
  if (i1 >= 0) price1h.vwap24hDistancePct = aggregatedVwapDistance(h1, vol1h, i1, 24);
  if (i4 >= 0) price4h.vwap24hDistancePct = aggregatedVwapDistance(h4, vol4h, i4, 6);
  if (iD >= 0) price1d.vwap24hDistancePct = aggregatedVwapDistance(d1, vol1d, iD, 1);
  const wyckoff = i1 < 0
    ? null
    : computeWyckoff(h1, vol1h, h1[i1]!.time);
  const priceAtEvent = i4 >= 0 ? h4[i4]!.close : Number(event.close);
  const zoneTop = Number(event.zone_top);
  const retestIndex = h4.findIndex(
    (bar) =>
      bar.time >= event.closeAt &&
      bar.time <= event.closeAt + H5 &&
      bar.low <= zoneTop,
  );
  const retestBar = retestIndex >= 0 ? h4[retestIndex]! : null;
  const retestReading =
    retestBar && retestIndex >= LUCY_LONG_BARS - 1
      ? lucy(h4, vol4h, retestIndex)
      : null;
  const atr4h =
    i4 >= 14
      ? h4.slice(i4 - 13, i4 + 1).reduce((sum, bar, index) => {
          const previous = h4[i4 - 14 + index]!;
          return sum + Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close));
        }, 0) / 14
      : null;
  const colorsBefore = (bars: Candle[], volumes: Map<number, number>, index: number, count: number) =>
    bars.slice(Math.max(0, index - count), index).filter((_, idx) => {
      const originalIndex = Math.max(0, index - count) + idx;
      return lucy(bars, volumes, originalIndex).colour !== null &&
        lucy(bars, volumes, originalIndex).colour !== "G";
    }).length;
  const futureTakerAt = aggregateAt(eventHour);
  const beforeHour = aggregateAt(event.candle_open_ms - H1);
  const afterHour = aggregateAt(event.closeAt);
  const previousH1Volume = i1 > 0 ? vol1h.get(h1[i1 - 1]!.time) : null;
  const eventH1Volume = i1 >= 0 ? vol1h.get(h1[i1]!.time) : null;
  const postH4 = i4 >= 0 ? vol4h.get(h4[i4]!.time + H4) : null;
  const totalEvent4h = i4 >= 0 ? vol4h.get(h4[i4]!.time) : null;
  return {
    lucy_colour_1h: h1Reading.colour,
    lucy_colour_4h: h4Reading.colour,
    welkin_colour_1h: h1Reading.welkin,
    welkin_colour_4h: h4Reading.welkin,
    lucy_volume_vs_avg120_1h: h1Reading.ratio,
    lucy_volume_vs_avg120_4h: h4Reading.ratio,
    mfi14_1h: at1h.mfi14 ?? null,
    cmf20_1h: at1h.cmf20 ?? null,
    obv_slope20_1h: at1h.obvSlope20 ?? null,
    mfi14_4h: at4h.mfi14 ?? null,
    cmf20_4h: at4h.cmf20 ?? null,
    obv_slope20_4h: at4h.obvSlope20 ?? null,
    mfi14_1d: at1d.mfi14 ?? null,
    cmf20_1d: at1d.cmf20 ?? null,
    obv_slope20_1d: at1d.obvSlope20 ?? null,
    price_indicators_1h: price1h,
    price_indicators_4h: price4h,
    price_indicators_1d: price1d,
    wyckoff_phase: wyckoff?.phase ?? null,
    wyckoff_events: wyckoff?.events ?? [],
    zone_close_above_top_pct: zoneTop > 0 ? round(pct(priceAtEvent, zoneTop), 5) : null,
    zone_close_above_top_atr: atr4h && zoneTop > 0 ? round((priceAtEvent - zoneTop) / atr4h, 5) : null,
    spot_cvd_1h_pct: spotCvdPct(1),
    spot_cvd_4h_pct: spotCvdPct(4),
    spot_cvd_1h_before_pct: (() => {
      const item = spot.get(event.candle_open_ms - H1);
      const total = item ? Number(item.buy) + Number(item.sell) : 0;
      return total > 0 && item && num(item.cvd) != null
        ? round((Number(item.cvd) / total) * 100, 5)
        : null;
    })(),
    spot_cvd_1h_after_pct: (() => {
      const item = spot.get(event.closeAt);
      const total = item ? Number(item.buy) + Number(item.sell) : 0;
      return total > 0 && item && num(item.cvd) != null
        ? round((Number(item.cvd) / total) * 100, 5)
        : null;
    })(),
    futures_taker_net_1h_before_pct: beforeHour?.futNetPct ?? null,
    futures_taker_net_1h_after_pct: afterHour?.futNetPct ?? null,
    spot_taker_net_1h_before_pct: beforeHour?.spotNetPct ?? null,
    spot_taker_net_1h_after_pct: afterHour?.spotNetPct ?? null,
    futures_taker_net_4h_event_pct:
      h4FuturesBuy != null && h4FuturesSell != null && h4FuturesBuy + h4FuturesSell > 0
        ? round(((h4FuturesBuy - h4FuturesSell) / (h4FuturesBuy + h4FuturesSell)) * 100, 5)
        : null,
    spot_taker_net_4h_event_pct:
      h4SpotBuy != null && h4SpotSell != null && h4SpotBuy + h4SpotSell > 0
        ? round(((h4SpotBuy - h4SpotSell) / (h4SpotBuy + h4SpotSell)) * 100, 5)
        : null,
    spot_share_4h_event_pct:
      h4SpotBuy != null &&
      h4SpotSell != null &&
      h4FuturesBuy != null &&
      h4FuturesSell != null &&
      h4SpotBuy + h4SpotSell + h4FuturesBuy + h4FuturesSell > 0
        ? round(
            ((h4SpotBuy + h4SpotSell) /
              (h4SpotBuy + h4SpotSell + h4FuturesBuy + h4FuturesSell)) *
              100,
            5,
          )
        : null,
    spot_cvd_4h_event_pct:
      h4SpotCvd != null && h4SpotBuy != null && h4SpotSell != null && h4SpotBuy + h4SpotSell > 0
        ? round((h4SpotCvd / (h4SpotBuy + h4SpotSell)) * 100, 5)
        : null,
    futures_taker_net_1h_pct: futureTakerAt?.futNetPct ?? null,
    spot_taker_net_1h_pct: futureTakerAt?.spotNetPct ?? null,
    volume_context_1h: colorWindow(h1, vol1h, i1, 6, 3),
    volume_context_4h: colorWindow(h4, vol4h, i4, 6, 3),
    selling_climax48_1h: sellingClimax48(h1, vol1h, i1),
    selling_climax48_4h: sellingClimax48(h4, vol4h, i4),
    retest_found: retestBar != null,
    retest_depth_pct: retestBar
      ? round(pct(zoneTop, retestBar.low), 4)
      : null,
    retest_close_above_zone: retestBar
      ? retestBar.close > zoneTop
      : null,
    retest_lucy_colour: retestReading?.colour ?? null,
    retest_volume_vs_avg120: retestReading?.ratio ?? null,
    bright_12h_count: i4 < 0 ? null : colorsBefore(h4, vol4h, i4, 3),
    bright_24h_count: i4 < 0 ? null : colorsBefore(h4, vol4h, i4, 6),
    bright_48h_count: i4 < 0 ? null : colorsBefore(h4, vol4h, i4, 12),
    h1_volume_vs_previous: previousH1Volume && eventH1Volume ? round(eventH1Volume / previousH1Volume, 5) : null,
    first_h1_volume_after_vs_avg120:
      i1 < 0 ? null : lucy(h1, vol1h, i1 + 1).ratio,
    h4_volume_vs_avg120: h4Reading.ratio,
    first_h4_volume_after_vs_avg120:
      i4 < 0 ? null : lucy(h4, vol4h, i4 + 1).ratio,
    h4_volume_first_after_vs_event:
      postH4 == null || totalEvent4h == null || totalEvent4h === 0
        ? null
        : round(postH4 / totalEvent4h, 5),
    oi_change_1h_pct: oiNow == null ? null : round(pct(oiNow, oiValue(eventHour - H1)), 5),
    oi_change_4h_pct: oiNow == null ? null : round(pct(oiNow, oiValue(eventHour - 4 * H1)), 5),
    oi_change_24h_pct: oiNow == null ? null : round(pct(oiNow, oiValue(eventHour - D1)), 5),
    funding_rate_pct: num(funding.get(eventHour)?.rate),
    liq_long_mcap_pct: null,
    liq_short_mcap_pct: null,
    bingx_volume_compare_only: true,
  };
}

function priceAtOrBefore(bars: Candle[], time: number): Candle | null {
  let answer: Candle | null = null;
  for (const bar of bars) {
    if (bar.time > time) break;
    answer = bar;
  }
  return answer;
}

function outcomeLabel(bars: Candle[], at: number, entry: number) {
  return firstPassage(bars, at, entry, 120, 10, -8);
}

function adverseMoveBeforePlus10(bars: Candle[], at: number, entry: number) {
  let minimum = Infinity;
  let found = false;
  for (const bar of bars) {
    if (bar.time < ceilTime(at, M15) || bar.time >= Math.min(RUN_AT, at + 120 * H1))
      continue;
    minimum = Math.min(minimum, bar.low);
    if (bar.high >= entry * 1.1) {
      found = true;
      break;
    }
  }
  return {
    adverse_before_plus10_pct:
      found && Number.isFinite(minimum) ? round(pct(minimum, entry)) : null,
    reached_plus10: found,
  };
}

function simulateStop(
  bars: Candle[],
  at: number,
  entry: number,
  stopPct: number,
) {
  const stop = entry * (1 + stopPct / 100);
  const end = Math.min(RUN_AT, at + 120 * H1);
  for (const bar of bars) {
    if (bar.time < ceilTime(at, M15) || bar.time >= end) continue;
    if (bar.low <= stop)
      return {
        status: "stop",
        exitPct: round(pct(stop, entry)),
        exitAt: new Date(bar.time).toISOString(),
      };
  }
  const last = [...bars].reverse().find((bar) => bar.time < end && bar.time >= at);
  return {
    status: end >= at + 120 * H1 ? "5d_close" : "open",
    exitPct: last ? round(pct(last.close, entry)) : null,
    exitAt: last ? new Date(last.time + M15).toISOString() : null,
  };
}

function simulateExit(
  bars: Candle[],
  at: number,
  entry: number,
  options: {
    key: string;
    beAt: number | null;
    trailAt: number;
    gap: number;
    days: number;
    initialStopPct?: number;
    runner?: boolean;
    zoneBottom?: number | null;
    h4?: Candle[];
    h4Bright?: Map<number, string>;
    requireBright?: boolean;
  },
) {
  const deadline = at + options.days * D1;
  const end = Math.min(RUN_AT, deadline);
  let stopPct = options.initialStopPct ?? -8;
  let peak = 0;
  let coreTaken = false;
  const zoneFailure =
    options.zoneBottom != null && options.h4
      ? options.h4.find(
          (bar) =>
            bar.time >= at &&
            bar.time + H4 <= end &&
            bar.close < options.zoneBottom! &&
            (!options.requireBright ||
              (options.h4Bright?.get(bar.time) != null &&
                options.h4Bright.get(bar.time) !== "G")),
        )
      : undefined;
  const zoneFailureAt = zoneFailure ? zoneFailure.time + H4 : Infinity;
  for (const bar of bars) {
    if (
      bar.time < ceilTime(at, M15) ||
      bar.time >= end ||
      bar.time >= zoneFailureAt
    )
      continue;
    const high = pct(bar.high, entry)!;
    const low = pct(bar.low, entry)!;
    if (options.runner && !coreTaken && high >= 10 && low <= -8) {
      return {
        variant: options.key,
        exit_pct: null,
        closed_at: new Date(bar.time).toISOString(),
        close_reason: "ambiguous_same_15m_bar_core_and_stop",
        core_taken: false,
      };
    }
    if (options.runner && !coreTaken && high >= 10) {
      coreTaken = true;
      stopPct = 0;
    }
    if (options.beAt != null && high >= options.beAt)
      stopPct = Math.max(stopPct, 0);
    peak = Math.max(peak, high);
    if (peak >= options.trailAt)
      stopPct = Math.max(stopPct, peak - options.gap, 0);
    if (low <= stopPct) {
      const runnerReturn = stopPct;
      return {
        variant: options.key,
        exit_pct: round(
          coreTaken ? 0.8 * 10 + 0.2 * runnerReturn : runnerReturn,
        ),
        closed_at: new Date(bar.time).toISOString(),
        close_reason: "stop_or_trailing",
        core_taken: coreTaken,
      };
    }
  }
  if (zoneFailure && zoneFailureAt <= end) {
    const zoneReturn = pct(zoneFailure.close, entry)!;
    return {
      variant: options.key,
      exit_pct: round(
        coreTaken ? 0.8 * 10 + 0.2 * zoneReturn : zoneReturn,
      ),
      closed_at: new Date(zoneFailureAt).toISOString(),
      close_reason: "4h_close_below_zone",
      core_taken: coreTaken,
    };
  }
  const last = [...bars].reverse().find((bar) => bar.time < end && bar.time >= at);
  const runnerReturn =
    last == null ? null : round(pct(last.close, entry));
  return {
    variant: options.key,
    exit_pct:
      runnerReturn == null
        ? null
        : round(coreTaken ? 0.8 * 10 + 0.2 * runnerReturn : runnerReturn),
    closed_at: last ? new Date(last.time + M15).toISOString() : null,
    close_reason: end < deadline ? "open_at_cutoff" : "time_window_end",
    core_taken: coreTaken,
  };
}

function zoneMetrics(
  zones: Obj[],
  zone: Obj,
  d1: Candle[],
  h4: Candle[],
  at: number,
  eventClose: number,
  zonesCrossed: number,
): Obj {
  const prevDaily = d1.filter((bar) => bar.time + D1 <= at);
  const width = Number(zone.top) - Number(zone.bottom);
  const atrBars = prevDaily.slice(-15);
  const atr =
    atrBars.length < 15
      ? null
      : atrBars.slice(1).reduce((sum, bar, index) => {
          const previous = atrBars[index]!;
          return sum + Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - previous.close),
            Math.abs(bar.low - previous.close),
          );
        }, 0) / 14;
  const interactions = prevDaily.filter(
    (bar) => bar.low <= Number(zone.top) && bar.high >= Number(zone.bottom),
  );
  const priorPivot = interactions[0]?.time ?? null;
  const next = zones
    .filter((candidate) => Number(candidate.bottom) > Number(zone.top))
    .sort((a, b) => Number(a.bottom) - Number(b.bottom))[0];
  return {
    zoneWidthPct:
      Number(zone.bottom) > 0
        ? round((width / Number(zone.bottom)) * 100, 5)
        : null,
    zonePivotCount: zone.count ?? null,
    zoneAgeDays:
      priorPivot == null ? null : round((at - priorPivot) / D1, 1),
    zoneTouchDays: interactions.length,
    distanceToNextResistancePct: next
      ? round(pct(Number(next.bottom), Number(zone.top)), 5)
      : null,
    zonesCrossedSameCandle: zonesCrossed,
    closeAboveTopPct:
      eventClose > Number(zone.top)
        ? round(pct(eventClose, Number(zone.top)), 5)
        : null,
    closeAboveTopAtr: null,
    previousDailyClose: prevDaily.at(-1)?.close ?? null,
    zoneWasResistance:
      prevDaily.length && Number(prevDaily.at(-1)!.close) < Number(zone.bottom),
  };
}

function breakoutReadings(
  event: Event,
  bars4h: Candle[],
  bars1h: Candle[],
  bars1d: Candle[],
) {
  const i4 = bars4h.findIndex((bar) => bar.time === event.candle_open_ms);
  const i1 = bars1h.findIndex(
    (bar) => bar.time === floorTime(event.closeAt - H1, H1),
  );
  const iD = bars1d.findIndex(
    (bar) => bar.time === floorTime(event.closeAt - D1, D1),
  );
  const c4 = i4 >= 0 ? bars4h[i4]! : null;
  const prev4 = i4 > 0 ? bars4h[i4 - 1]! : null;
  const c1 = i1 >= 0 ? bars1h[i1]! : null;
  const prev1 = i1 > 0 ? bars1h[i1 - 1]! : null;
  const cD = iD >= 0 ? bars1d[iD]! : null;
  const prior24hBars = i4 < 0 ? [] : bars4h.slice(Math.max(0, i4 - 6), i4);
  const prior7dBars = i4 < 0 ? [] : bars4h.slice(Math.max(0, i4 - 42), i4);
  const prior24hLow = prior24hBars.length
    ? Math.min(...prior24hBars.map((bar) => bar.low))
    : null;
  const prior7dLow = prior7dBars.length
    ? Math.min(...prior7dBars.map((bar) => bar.low))
    : null;
  const atr4h = i4 >= 0 ? wilderAtr(bars4h.slice(0, i4 + 1)) : null;
  const dayBars = bars1d.filter((bar) => bar.time + D1 <= event.closeAt);
  const zone = { top: event.zone_top, bottom: event.zone_bottom, count: event.zone_pivots };
  const r: Obj = {
    candleRangePct:
      c4 && c4.open ? round(((c4.high - c4.low) / c4.open) * 100, 5) : null,
    candleBodyPct: c4?.open ? round(pct(c4.close, c4.open), 5) : null,
    upperWickPct:
      c4?.open
        ? round(
            ((c4.high - Math.max(c4.open, c4.close)) / c4.open) * 100,
            5,
          )
        : null,
    closePosition:
      c4 && c4.high > c4.low
        ? round((c4.close - c4.low) / (c4.high - c4.low), 5)
        : null,
    preMove1hPct: c1 && prev1 ? round(pct(c1.close, prev1.close), 5) : null,
    preMove4hPct: c4 && prev4 ? round(pct(c4.close, prev4.close), 5) : null,
    preMove24hPct:
      dayBars.length > 1
        ? round(pct(dayBars.at(-1)!.close, dayBars.at(-2)!.close), 5)
        : null,
    fromLow24hPct:
      prior24hLow == null ? null : round(pct(event.close ?? null, prior24hLow), 5),
    fromLow7dPct:
      prior7dLow == null ? null : round(pct(event.close ?? null, prior7dLow), 5),
    closeAboveTopAtr:
      atr4h && Number(event.zone_top) > 0
        ? round((Number(event.close) - Number(event.zone_top)) / atr4h, 5)
        : null,
    utcHour: new Date(event.closeAt).getUTCHours(),
    eventWeekday: new Date(event.closeAt).getUTCDay(),
    breakoutClose: event.close,
    breakoutOpen: event.open,
    breakoutLow: event.low,
    breakoutHigh: event.high,
    prev4hClose: event.prev_close,
    nextResistancePct: event.next_res_pct,
    zonesCrossed: event.zones_crossed,
    growthFrom24hLowPct: event.from_low24_pct,
    growthFrom7dLowPct: null,
    d1Bars: dayBars.length,
    zoneBottom: zone.bottom,
    zoneTop: zone.top,
    zonePivots: zone.count,
  };
  return r;
}

function findStoredReasons(
  event: Event,
  decisions: Obj[],
  rejects: Obj[],
  queue: Obj[],
  productionLogs: string[],
) {
  const exactQueue = queue.filter((row) => {
    const trigger = asTime(row.trigger_candle_at);
    return (
      sym(row.symbol) === event.symbol &&
      trigger != null &&
      Math.abs(trigger - Number(event.candle_open_ms)) <= 1
    );
  });
  const records: Obj[] = [
    ...decisions
      .filter((row) => {
        const time = asTime(row.decision_at);
        return (
          row.decision_kind !== "fired" &&
          sym(row.symbol) === event.symbol &&
          time != null &&
          Math.abs(time - event.closeAt) <= 4 * H1
        );
      })
      .map((row) => ({
        at: asTime(row.decision_at),
        source: "pattern_decision_snapshots",
        reason: row.decision_reason || row.decision_kind,
      })),
    ...rejects
      .filter((row) => {
        const time = asTime(row.cycle_at);
        const zMatch =
          num(row.zone_top) == null ||
          Math.abs(Number(row.zone_top) - Number(event.zone_top)) /
            Math.max(1e-12, Number(event.zone_top)) <
            0.02;
        return (
          sym(row.symbol) === event.symbol &&
          time != null &&
          Math.abs(time - event.closeAt) <= 24 * H1 &&
          zMatch
        );
      })
      .map((row) => ({
        at: asTime(row.cycle_at),
        source: "scan_reject_log",
        reason: row.reason,
      })),
  ];
  for (const row of exactQueue) {
    const evidence = row.volume_evidence ?? {};
    const eventData = evidence.stealthNeonLevelEvent ?? {};
    const check = evidence.volumeCheckState ?? {};
    records.push({
      at: asTime(row.updated_at) ?? asTime(row.created_at),
      source: "stealth_abneon_shadow_candidates",
      reason:
        row.terminal_reason ||
        (check.lastVolumeColour ? `volume=${check.lastVolumeColour}` : row.status),
      status: row.status,
      candidate_key: row.candidate_key,
      volume_colour: eventData.volumeColour ?? check.lastVolumeColour ?? null,
    });
  }
  const candleOpen =
    num(event.candle_open_ms) ??
    asTime(getAEventZone((event.recorded_signal ?? event) as Obj)?.candleOpenAt);
  const candleIso =
    candleOpen == null ? null : new Date(candleOpen).toISOString();
  const logEvidence = productionLogs.filter((line) => {
    const mentionsSymbol = line.includes(event.symbol);
    const sameCandle = candleIso != null && line.includes(candleIso);
    const scanDone =
      line.includes("Stealth ABNeon level breakout scan done") && sameCandle;
    const perSymbol =
      (line.includes("Stealth ABNeon level") ||
        line.includes("STEALTH ABNeon level")) &&
      mentionsSymbol &&
      (sameCandle || candleOpen == null);
    return scanDone || perSymbol;
  });
  for (const line of logEvidence)
    records.push({
      at: null,
      source: "production_logs",
      reason: line,
    });
  return records
    .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
    .map((row) => `${row.source}:${row.reason}`)
    .join(" | ");
}

function checkFilters(
  event: Event,
  reasons: string,
  cachedColour: string | null,
  guardPositions: Obj[],
  allSignals: Obj[],
) {
  const at = event.closeAt;
  const resistanceActive = at >= Date.parse("2026-11-21T00:00:00Z");
  const lucyActive = at >= Date.parse("2026-11-15T00:00:00Z");
  const queueActive = at >= Date.parse("2026-11-19T00:00:00Z");
  const isOpenAt = (row: Obj) => {
    const detected = asTime(row.detected_at);
    const closed = asTime(row.closed_at);
    if (detected == null || detected > at) return false;
    return (
      (["active", "in_run"].includes(String(row.status)) && closed == null) ||
      (closed != null && closed > at)
    );
  };
  const openSameCoin = guardPositions.some(
    (row) => sym(row.symbol) === event.symbol && isOpenAt(row),
  );
  const openStealth = allSignals.some(
    (row) =>
      sym(row.symbol) === event.symbol &&
      row.sentiment_key === "stealth_breakout" &&
      isOpenAt(row),
  );
  const resistance =
    !resistanceActive ||
    (event.previous_daily_close != null &&
      Number(event.zone_bottom) > Number(event.previous_daily_close));
  const bright =
    !lucyActive ||
    (cachedColour != null && ["M", "W"].includes(cachedColour));
  const expired =
    queueActive &&
    (event.queue_status === "blocked" ||
      String(event.recorded_reason_chain ?? "").includes("event_expired"));
  const actualFilters = {
    dailyZone: true,
    closed4hCross: Number(event.prev_close) <= Number(event.zone_top) &&
      Number(event.close) > Number(event.zone_top),
    resistance,
    lucyMW: bright,
    lucyColour: cachedColour,
    queue24h: !expired,
    openSameSymbolGuard: !openSameCoin,
    activeStealthDuplicate: !openStealth,
  };
  const firstFailure = Object.entries(actualFilters).find(
    ([key, value]) =>
      key !== "lucyColour" && key !== "queue24h" ? value === false : false,
  )?.[0] ?? (expired ? "queue24h" : null);
  const reason = String(reasons).toLowerCase();
  const recordedCategory =
    /zone_was_support|resistance/.test(reason)
      ? "resistance"
      : /volume_not_bright|volume_read_error|aggregated_futures_volume/.test(reason)
        ? "lucyMW"
        : /event_expired/.test(reason)
          ? "queue24h"
          : /active_stealth_duplicate|duplicate/.test(reason)
            ? "activeStealthDuplicate"
            : /same.symbol|open.position/.test(reason)
              ? "openSameSymbolGuard"
              : reason
                ? "other"
                : null;
  const mismatch =
    firstFailure != null &&
    recordedCategory != null &&
    firstFailure !== recordedCategory;
  return {
    ...actualFilters,
    firstFailure,
    recordedCategory,
    mismatch,
    unloggedFailure: firstFailure != null && recordedCategory == null,
  };
}

function makeMissingRows(event: Event, metricValues: Obj, reasonOverrides: Obj = {}) {
  const metrics = [
    "zoneWidthPct",
    "zoneAgeDays",
    "zoneTouchDays",
    "zonePivots",
    "distanceToNextResistancePct",
    "zonesCrossedSameCandle",
    "closeAboveTopPct",
    "closeAboveTopAtr",
    "candleRangePct",
    "candleBodyPct",
    "upperWickPct",
    "closePosition",
    "preMove1hPct",
    "preMove4hPct",
    "preMove24hPct",
    "fromLow24hPct",
    "fromLow7dPct",
    "utcHour",
    "eventWeekday",
    "lucy_colour_1h",
    "lucy_colour_4h",
    "welkin_colour_1h",
    "lucy_volume_vs_avg120",
    "lucy_volume_vs_avg120_1h",
    "lucy_volume_vs_avg120_4h",
    "welkin_colour_4h",
    "spot_share_pct",
    "futures_taker_net_pct",
    "spot_taker_net_pct",
    "spot_cvd_pct",
    "spot_cvd_1h_pct",
    "spot_cvd_4h_pct",
    "oi_change_1h_pct",
    "oi_change_4h_pct",
    "oi_change_24h_pct",
    "funding_rate_pct",
    "liq_long_mcap_pct",
    "liq_short_mcap_pct",
    "mfi14_1h",
    "cmf20_1h",
    "obv_slope20_1h",
    "mfi14_4h",
    "cmf20_4h",
    "obv_slope20_4h",
    "mfi14_1d",
    "cmf20_1d",
    "obv_slope20_1d",
    "wyckoff_phase",
    "futures_taker_net_1h_before_pct",
    "futures_taker_net_1h_after_pct",
    "spot_taker_net_1h_before_pct",
    "spot_taker_net_1h_after_pct",
    "futures_taker_net_4h_event_pct",
    "spot_taker_net_4h_event_pct",
    "spot_share_4h_event_pct",
    "spot_cvd_4h_event_pct",
    "first_h1_volume_after_vs_avg120",
    "first_h4_volume_after_vs_avg120",
    "selling_climax48_1h.bars_ago",
    "selling_climax48_1h.lucy_colour",
    "selling_climax48_1h.welkin_colour",
    "selling_climax48_1h.volume_vs_avg120",
    "selling_climax48_1h.down",
    "selling_climax48_1h.close_pos",
    "selling_climax48_4h.bars_ago",
    "selling_climax48_4h.lucy_colour",
    "selling_climax48_4h.welkin_colour",
    "selling_climax48_4h.volume_vs_avg120",
    "selling_climax48_4h.down",
    "selling_climax48_4h.close_pos",
    "retest_found",
    "retest_depth_pct",
    "retest_close_above_zone",
    "retest_lucy_colour",
    "retest_volume_vs_avg120",
    "price_indicators_1h.rsi14",
    "price_indicators_1h.atr14Pct",
    "price_indicators_1h.adx14",
    "price_indicators_1h.diPlus14",
    "price_indicators_1h.diMinus14",
    "price_indicators_1h.ema20DistancePct",
    "price_indicators_1h.ema20Slope5Pct",
    "price_indicators_1h.ema50DistancePct",
    "price_indicators_1h.ema50Slope5Pct",
    "price_indicators_1h.ema200DistancePct",
    "price_indicators_1h.ema200Slope5Pct",
    "price_indicators_1h.bbPercentB",
    "price_indicators_1h.bbWidthPct",
    "price_indicators_1h.macdPct",
    "price_indicators_1h.vwap24hDistancePct",
    "price_indicators_4h.rsi14",
    "price_indicators_4h.atr14Pct",
    "price_indicators_4h.adx14",
    "price_indicators_4h.diPlus14",
    "price_indicators_4h.diMinus14",
    "price_indicators_4h.ema20DistancePct",
    "price_indicators_4h.ema20Slope5Pct",
    "price_indicators_4h.ema50DistancePct",
    "price_indicators_4h.ema50Slope5Pct",
    "price_indicators_4h.ema200DistancePct",
    "price_indicators_4h.ema200Slope5Pct",
    "price_indicators_4h.bbPercentB",
    "price_indicators_4h.bbWidthPct",
    "price_indicators_4h.macdPct",
    "price_indicators_4h.vwap24hDistancePct",
    "price_indicators_1d.rsi14",
    "price_indicators_1d.atr14Pct",
    "price_indicators_1d.adx14",
    "price_indicators_1d.diPlus14",
    "price_indicators_1d.diMinus14",
    "price_indicators_1d.ema20DistancePct",
    "price_indicators_1d.ema20Slope5Pct",
    "price_indicators_1d.ema50DistancePct",
    "price_indicators_1d.ema50Slope5Pct",
    "price_indicators_1d.ema200DistancePct",
    "price_indicators_1d.ema200Slope5Pct",
    "price_indicators_1d.bbPercentB",
    "price_indicators_1d.bbWidthPct",
    "price_indicators_1d.macdPct",
    "price_indicators_1d.vwap24hDistancePct",
    "market_btc.change1h",
    "market_btc.change4h",
    "market_btc.change24h",
    "market_btc_1h.change1h",
    "market_btc_1h.change24h",
    "market_eth.change1h",
    "market_eth.change4h",
    "market_eth.change24h",
    "market_eth_1h.change1h",
    "market_eth_1h.change24h",
    "market_btc_ema50_4h_distance_pct",
    "market_breakouts_same_day",
  ];
  const checkedValues = { ...metricValues };
  for (const key of [
    "retest_found",
    "retest_depth_pct",
    "retest_close_above_zone",
    "retest_lucy_colour",
    "retest_volume_vs_avg120",
  ]) {
    const value = (event as Obj)[key];
    if (value != null) checkedValues[key] = value;
  }
  for (const timeframe of ["1h", "4h"]) {
    const windowKey = `volume_context_${timeframe}`;
    Object.assign(
      checkedValues,
      flattenReportMetrics({
        [windowKey]: (event as Obj)[windowKey] ?? null,
      }),
    );
    for (let index = 0; index < 10; index++) {
      metrics.push(
        `${windowKey}[${index}].lucy_colour`,
        `${windowKey}[${index}].welkin_colour`,
        `${windowKey}[${index}].volume_vs_avg120`,
      );
    }
  }
  if (event.cohort === "B") {
    Object.assign(
      checkedValues,
      breakoutReadings(
        event,
        event.bars4h ?? [],
        event.bars1h ?? [],
        event.bars1d ?? [],
      ),
      {
        zoneWidthPct: event.zoneHistory?.zoneWidthPct ?? null,
        zoneAgeDays: event.zoneHistory?.zoneAgeDays ?? null,
        zoneTouchDays: event.zoneHistory?.zoneTouchDays ?? null,
        zonePivots: event.zone_pivots ?? null,
        distanceToNextResistancePct:
          event.zoneHistory?.distanceToNextResistancePct ?? null,
        zonesCrossedSameCandle: event.zones_crossed ?? null,
        closeAboveTopPct: event.zoneHistory?.closeAboveTopPct ?? null,
        closeAboveTopAtr: event.zoneHistory?.closeAboveTopAtr ?? null,
        ...flattenReportMetrics({
          price_indicators_1h: priceIndicators(
            event.bars1h ?? [],
            (event.bars1h ?? []).findIndex(
              (bar) => bar.time === floorTime(event.closeAt - H1, H1),
            ),
            H1,
          ),
          price_indicators_4h: priceIndicators(
            event.bars4h ?? [],
            (event.bars4h ?? []).findIndex(
              (bar) => bar.time === event.candle_open_ms,
            ),
            H4,
          ),
          price_indicators_1d: priceIndicators(
            event.bars1d ?? [],
            (event.bars1d ?? []).findLastIndex(
              (bar) => bar.time + D1 <= event.closeAt,
            ),
            D1,
          ),
        }),
      },
    );
  }
  return metrics
    .filter(
      (metric) =>
        checkedValues[metric] == null &&
        !(
          metric.startsWith("retest_") &&
          (event as Obj).retest_found === false
        ),
    )
    .map((metric) => ({
      event_key: event.key,
      cohort: event.cohort,
      symbol: event.symbol,
      event_at: new Date(event.closeAt).toISOString(),
      metric,
      missing_reason:
        reasonOverrides[metric] ??
        (["A"].includes(event.cohort)
          ? "не записано ботом"
          : event.cohort === "B"
            ? "не записано ботом"
            : "CoinGlass/market-cap series unavailable"),
    }));
}

function bestMetricThreshold(rows: Obj[]) {
  const labeled = rows.filter(
    (row) =>
      ["champion", "bad"].includes(String(row.outcome)) &&
      typeof row.value === "number" &&
      Number.isFinite(row.value),
  );
  const values = [...new Set(labeled.map((row) => Number(row.value)))].sort(
    (a, b) => a - b,
  );
  if (!values.length || !labeled.some((row) => row.outcome === "champion") ||
      !labeled.some((row) => row.outcome === "bad"))
    return null;
  const thresholds = [
    values[0]! - Math.abs(values[0]!) - 1,
    ...values.slice(1).map((value, index) => (value + values[index]!) / 2),
    values.at(-1)! + Math.abs(values.at(-1)!) + 1,
  ];
  let best: Obj | null = null;
  for (const direction of ["higher", "lower"]) {
    for (const threshold of thresholds) {
      let tp = 0;
      let fn = 0;
      let tn = 0;
      let fp = 0;
      for (const row of labeled) {
        const predicted =
          direction === "higher"
            ? Number(row.value) >= threshold
            : Number(row.value) <= threshold;
        const actual = row.outcome === "champion";
        if (predicted && actual) tp++;
        else if (!predicted && actual) fn++;
        else if (!predicted && !actual) tn++;
        else fp++;
      }
      const sensitivity = tp / (tp + fn);
      const specificity = tn / (tn + fp);
      const score = (sensitivity + specificity) / 2;
      if (!best || score > best.score)
        best = { direction, threshold, score, tp, fn, tn, fp };
    }
  }
  return best;
}

function simulatePortfolio(scenario: string, trades: Obj[]) {
  let balance = 1_000;
  let reserved = 0;
  const active: Array<{ symbol: string; closeAt: number; pnl: number; row: Obj }> = [];
  const rows: Obj[] = [];
  const releaseUntil = (time: number) => {
    active.sort((a, b) => a.closeAt - b.closeAt);
    while (active[0] && active[0].closeAt <= time) {
      const closed = active.shift()!;
      reserved -= 100;
      balance += closed.pnl;
      closed.row.balance_after_close_usd = round(balance, 2);
    }
  };
  for (const trade of [...trades].sort(
    (a, b) => Number(a.entryAt) - Number(b.entryAt),
  )) {
    const entryAt = Number(trade.entryAt);
    releaseUntil(entryAt);
    const existing = active.some((position) => position.symbol === trade.symbol);
    const free = balance - reserved;
    let skipped: string | null = null;
    if (trade.skip_reason) skipped = String(trade.skip_reason);
    else if (trade.exitPct == null || !Number.isFinite(Number(trade.exitPct)))
      skipped = "no_exit_price_or_return";
    else if (existing) skipped = "same_symbol_position_open";
    else if (free < 100) skipped = "insufficient_free_margin";
    const row: Obj = {
      scenario,
      event_key: trade.event_key,
      symbol: trade.symbol,
      event_at: trade.event_at,
      variant: trade.variant,
      entry_time: trade.entry_time ?? trade.event_at,
      entry_price: trade.entry_price ?? null,
      exit_time: trade.exit_time ?? null,
      exit_price_pct: trade.exitPct ?? null,
      close_reason: trade.close_reason ?? null,
      margin_usd: 100,
      leverage: 10,
      starting_balance_usd: 1_000,
      balance_before_entry_usd: round(balance, 2),
      reserved_margin_before_usd: round(reserved, 2),
      free_margin_before_usd: round(free, 2),
      status: skipped ? "skipped" : "opened",
      skip_reason: skipped,
    };
    rows.push(row);
    if (skipped) continue;
    const closeAt =
      trade.close_reason === "open_at_cutoff" || trade.exit_time == null
        ? RUN_AT
        : asTime(trade.exit_time) ?? RUN_AT;
    const pnl = Number(trade.exitPct) * 10;
    reserved += 100;
    active.push({ symbol: String(trade.symbol), closeAt, pnl, row });
    row.pnl_usd = round(pnl, 2);
    row.equity_after_close_usd = round(balance + pnl, 2);
    row.simulated_closed_at = new Date(closeAt).toISOString();
  }
  releaseUntil(Infinity);
  for (const row of rows) {
    row.final_balance_usd = round(balance, 2);
    row.final_balance_pct = round(((balance / 1_000) - 1) * 100, 3);
  }
  return rows;
}

function simulateEntryVariants(
  event: Event,
  bars1h: Candle[],
  h4Colours?: Map<number, string>,
) {
  const at = event.closeAt;
  const top = Number(event.zone_top);
  const out: Obj[] = [
    {
      variant: "current_4h_close",
      entry_time: new Date(at).toISOString(),
      entry_price: event.close,
    },
  ];
  const current4 = event.bars4h ?? [];
  const next4 = current4.find((bar) => bar.time === at);
  if (next4 && next4.close > top)
    out.push({
      variant: "next_4h_close_hold_above",
      entry_time: new Date(at + H4).toISOString(),
      entry_price: next4.close,
    });
  const retest = current4.find(
    (bar) => bar.time >= at && bar.low <= top && bar.close >= top,
  );
  if (retest)
    out.push(
      ["M", "W"].includes(h4Colours?.get(retest.time) ?? "")
        ? {
            variant: "retest_zone_top_with_lucy_mw_volume",
            entry_time: new Date(retest.time + H4).toISOString(),
            entry_price: top,
            entry_status: "entered",
          }
        : {
            variant: "retest_zone_top_with_lucy_mw_volume",
            entry_time: new Date(retest.time + H4).toISOString(),
            entry_price: null,
            entry_status: h4Colours?.has(retest.time)
              ? `filtered_by_lucy_${h4Colours.get(retest.time)}`
              : "не записано ботом",
          },
    );
  const firstH1 = bars1h.find((bar) => bar.time >= at && bar.close > top);
  if (firstH1)
    out.push({
      variant: "first_1h_close_above_zone",
      entry_time: new Date(firstH1.time + H1).toISOString(),
      entry_price: firstH1.close,
    });
  return out;
}

function relevantARecord(signal: Obj) {
  const percentKeys = [
    "entry_oi_15m",
    "entry_oi_30m",
    "entry_oi_1h",
    "entry_oi_4h",
    "entry_oi_24h",
    "entry_fut_vol_mult",
    "entry_spot_vol_mult",
    "entry_spot_mcap_pct",
    "entry_spot_net_buy_1h",
    "entry_fut_taker_net_buy",
    "entry_rsi_1h",
    "entry_atr_14_percent",
    "entry_bollinger_bandwidth",
    "entry_btc_24h",
    "entry_btc_dominance",
    "entry_btc_price",
    "entry_btc_dominance_source",
    "entry_indicator_source",
    "entry_anchored_vwap_distance_percent",
    "entry_macd",
    "entry_adx_14",
  ];
  return Object.fromEntries(
    percentKeys.map((key) => [key, signal[key] ?? null]),
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  installRequestAccounting();

  const signals = readJsonLines("signals")
    .filter(
      (row) =>
        row.sentiment_key === "stealth_breakout" &&
        (asTime(row.detected_at) ?? 0) >= START &&
        (asTime(row.detected_at) ?? Infinity) <= DB_CUTOFF,
    )
    .sort((a, b) => Number(a.id) - Number(b.id));
  const extras = readJsonLines("extras");
  const vsaRows = readJsonLines("vsa");
  const wyckoffRows = readJsonLines("wyckoff");
  const colors = readJsonLines("colors");
  const queue = readJsonLines("queue");
  const decisionsFull = readJsonLines("decisions_full");
  const hasDecisionEntryMetrics = decisionsFull.length > 0;
  const decisions = hasDecisionEntryMetrics
    ? decisionsFull
    : readJsonLines("decisions");
  const rejects = readJsonLines("rejects");
  const hourlyRows = readJsonLines("hourly_scalar");
  const trajectories = readJsonLines("trajectory");
  const drawdowns = readJsonLines("drawdown");
  const trailingEvents = readJsonLines("trailing");
  const closeFollowups = readJsonLines("followup");
  const cancelOutcomes = readJsonLines("cancel");
  const guardPositions = readJsonLines("guard_positions");
  const previousSymbols = [
    ...new Set(
      PRIOR_UNIVERSE_FILES.flatMap((file) =>
        readCsv(file).map((row) => sym(row.symbol)).filter(Boolean),
      ),
    ),
  ];
  const symbols = [
    ...new Set([
      ...previousSymbols,
      ...signals.map((r) => sym(r.symbol)),
      ...HER,
    ]),
  ].sort();
  const signalById = new Map(signals.map((row) => [Number(row.id), row]));
  const extrasBySignal = new Map(extras.map((row) => [Number(row.tracked_signal_id), row]));
  const vsaBySignal = new Map(vsaRows.map((row) => [Number(row.tracked_signal_id), row]));
  const wyckoffBySignal = new Map(wyckoffRows.map((row) => [Number(row.tracked_signal_id), row]));
  const colorBySignal = new Map(colors.map((row) => [Number(row.tracked_signal_id), row]));
  const hourlyBySignal = new Map(hourlyRows.map((row) => [Number(row.tracked_signal_id), row.snapshots ?? []]));
  const drawdownBySignal = new Map(drawdowns.map((row) => [Number(row.signal_id), row]));
  const trailingBySignal = new Map<number, Obj[]>();
  for (const row of trailingEvents) {
    const list = trailingBySignal.get(Number(row.signal_id)) ?? [];
    list.push(row);
    trailingBySignal.set(Number(row.signal_id), list);
  }
  const followupBySignal = new Map<number, Obj[]>();
  for (const row of closeFollowups) {
    const list = followupBySignal.get(Number(row.tracked_signal_id)) ?? [];
    list.push(row);
    followupBySignal.set(Number(row.tracked_signal_id), list);
  }
  const cancelOutcomeBySignal = new Map<number, Obj[]>();
  for (const row of cancelOutcomes) {
    const id = Number(row.tracked_signal_id ?? row.signal_id);
    const list = cancelOutcomeBySignal.get(id) ?? [];
    list.push(row);
    cancelOutcomeBySignal.set(id, list);
  }
  const h4BySymbol = new Map<string, Candle[]>();
  const d1BySymbol = new Map<string, Candle[]>();
  const rawCandidates: Event[] = [];
  const symbolErrors: Obj[] = [];
  let scanned = 0;
  const zoneStart = START - 740 * D1;
  const priorReportEnd = PREVIOUS_REPORT_END;
  console.error(`BingX: ${symbols.length} монет, зона 1D + скан 4H`);
  let nextScanSymbol = 0;
  const scanWorker = async () => {
    while (true) {
      const symbol = symbols[nextScanSymbol++];
      if (!symbol) return;
    try {
      const [d1, h4] = await Promise.all([
        klines(CACHE, symbol, "1d", zoneStart, RUN_AT),
        klines(CACHE, symbol, "4h", START - 22 * D1, RUN_AT),
      ]);
      if (d1.length < 30 || h4.length < 60) {
        symbolErrors.push({ symbol, reason: "insufficient_daily_or_4h_history" });
        continue;
      }
      h4BySymbol.set(symbol, h4);
      d1BySymbol.set(symbol, d1);
      for (let i = 1; i < h4.length; i++) {
        const current = h4[i]!;
        const previousBar = h4[i - 1]!;
        const closeAt = current.time + H4;
        if (
          closeAt < START ||
          closeAt > RUN_AT ||
          current.time - previousBar.time !== H4
        )
          continue;
        const d1Index = d1.findLastIndex((bar) => bar.time + D1 <= closeAt);
        if (d1Index < 0) continue;
        const dayZones = computeSupportZones(
          d1.slice(Math.max(0, d1Index - 699), d1Index + 1),
        );
        const crossed = dayZones
          .filter(
            (zone) =>
              previousBar.close <= zone.top && current.close > zone.top,
          )
          .sort((a, b) => b.top - a.top);
        if (!crossed.length) continue;
        const zone = crossed[0]!;
        const next = dayZones
          .filter((item) => item.top > current.close)
          .sort((a, b) => a.bottom - b.bottom)[0];
        const prevDay = d1
          .filter((bar) => bar.time + D1 <= current.time)
          .at(-1);
        const zoneHistory = zoneMetrics(
          dayZones as unknown as Obj[],
          zone as unknown as Obj,
          d1.slice(0, d1Index + 1),
          h4,
          closeAt,
          current.close,
          crossed.length,
        );
        rawCandidates.push({
          key: `B:${symbol}:${current.time}`,
          cohort: "B",
          symbol,
          at: closeAt,
          closeAt,
          entry: current.close,
          candle_open_ms: current.time,
          candle_open: new Date(current.time).toISOString(),
          close_at: new Date(closeAt).toISOString(),
          close_ms: closeAt,
          open: current.open,
          high: current.high,
          low: current.low,
          close: current.close,
          prev_close: previousBar.close,
          zone_top: zone.top,
          zone_bottom: zone.bottom,
          zone_pivots: zone.count,
          zones_crossed: crossed.length,
          next_res_pct: next ? pct(next.bottom, current.close) : null,
          from_low24_pct: null,
          previous_daily_close: prevDay?.close ?? null,
          zoneHistory,
          previousReportEnd: priorReportEnd,
          bars4h: h4,
          bars1d: d1,
          outcome: "open",
        });
      }
    } catch (error) {
      stats.bingxErrors++;
      symbolErrors.push({ symbol, reason: String(error).slice(0, 180) });
    }
    if (++scanned % 50 === 0) {
      const lastFailures = symbolErrors
        .slice(-2)
        .map((row) => `${row.symbol}:${row.reason}`)
        .join(" | ");
      console.error(
        `BingX: проверено ${scanned}/${symbols.length} монет · ` +
          `HTTP-запросов=${stats.bingxRequests} · ошибок=${stats.bingxErrors} · ` +
          `ошибок символов=${symbolErrors.length} · пик параллельности=${stats.bingxMaxConcurrent}` +
          (lastFailures ? ` · последние ошибки: ${lastFailures}` : ""),
      );
    }
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => scanWorker()));
  const matchedAKeys = new Set<string>();
  for (const signal of signals) {
    const neon = getAEventZone(signal);
    const symbol = sym(signal.symbol);
    const candleAt = asTime(neon?.candleOpenAt);
    if (candleAt != null) matchedAKeys.add(`${symbol}:${candleAt}`);
  }
  const bEvents = rawCandidates.filter(
    (event) => !matchedAKeys.has(`${event.symbol}:${event.candle_open_ms}`),
  );
  const priceSymbols = [
    ...new Set([
      ...rawCandidates.map((event) => event.symbol),
      ...signals.map((signal) => sym(signal.symbol)),
      ...HER,
    ]),
  ];
  const m15BySymbol = new Map<string, Candle[]>();
  const h1BySymbol = new Map<string, Candle[]>();
  let priceDone = 0;
  console.error(`BingX: загрузка свечей 15m для ${priceSymbols.length} монет`);
  let nextPriceSymbol = 0;
  const priceWorker = async () => {
    while (true) {
      const symbol = priceSymbols[nextPriceSymbol++];
      if (!symbol) return;
      try {
        const m15 = await klines(CACHE, symbol, "15m", START - 10 * D1, RUN_AT);
        m15BySymbol.set(symbol, m15);
        h1BySymbol.set(symbol, aggregate15mTo1h(m15));
      } catch (error) {
        stats.bingxErrors++;
        symbolErrors.push({ symbol, reason: String(error).slice(0, 180) });
        m15BySymbol.set(symbol, []);
        h1BySymbol.set(symbol, []);
      }
      if (++priceDone % 50 === 0)
        console.error(`BingX 15m: ${priceDone}/${priceSymbols.length} монет`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => priceWorker()));

  const actualA: Event[] = [];
  for (const signal of signals) {
    const at = asTime(signal.detected_at);
    if (at == null) continue;
    const symbol = sym(signal.symbol);
    const bars = m15BySymbol.get(symbol) ?? [];
    const entry = num(signal.entry_price);
    const outcome =
      entry == null
        ? {
            outcome: "no_entry_price",
            mfe: null,
            mae: null,
            hoursToPlus10: null,
            hoursToMinus8: null,
            complete: false,
          }
        : outcomeLabel(bars, at, entry);
    const zone = getAEventZone(signal);
    const extra = extrasBySignal.get(Number(signal.id));
    const vsa = vsaBySignal.get(Number(signal.id));
    const wyckoff = wyckoffBySignal.get(Number(signal.id));
    const color = colorBySignal.get(Number(signal.id));
    const hourly = hourlyBySignal.get(Number(signal.id)) ?? [];
    const trajectory = trajectories.filter(
      (row) => Number(row.signal_id) === Number(signal.id),
    );
    const closeReason = String(signal.cancel_reason ?? "");
    const actualCloseKind =
      /neutral|reclass/i.test(closeReason)
        ? "neutral"
        : signal.status === "stop_loss" ||
            (/cancel/i.test(String(signal.cancel_reason ?? "")) &&
              Number(signal.pnl_percent) < 0)
          ? "stop_loss"
          : signal.status === "bu_stop" || signal.status === "breakeven"
            ? "breakeven"
            : signal.status === "profit"
              ? "trailing_or_profit"
              : signal.status === "expired"
                ? "4d_expiry"
                : signal.status;
    actualA.push({
      key: `A:${signal.id}`,
      cohort: "A",
      symbol,
      signal_id: signal.id,
      signal_type: signal.signal_type,
      rule_version: ruleVersion(signal, at),
      at,
      closeAt: at,
      event_at: signal.detected_at,
      event_close_at: zone?.candleOpenAt
        ? new Date(Number(asTime(zone.candleOpenAt)) + H4).toISOString()
        : signal.detected_at,
      entry: entry,
      entry_price: entry,
      actual_status: signal.status,
      actual_close_at: signal.closed_at,
      actual_exit_price: signal.exit_price,
      actual_pnl_pct: signal.pnl_percent,
      actual_close_kind: actualCloseKind,
      actual_cancel_reason: signal.cancel_reason,
      stop_loss_price: signal.stop_loss_price,
      stop_loss_pct: signal.stop_loss_pct,
      recorded_peak_price: signal.peak_price,
      recorded_rule_event: safeBotValue(zone),
      recorded_signal: safeBotValue(signal),
      entry_metrics: safeBotValue(relevantARecord(signal)),
      entry_extras: safeBotValue(extra?.metrics ?? null),
      vsa_entry: safeBotValue(vsa?.metrics ?? null),
      wyckoff_entry: safeBotValue(wyckoff?.metrics ?? null),
      signal_volume_color: safeBotValue(color?.metrics ?? null),
      hourly_snapshots: safeBotValue(hourly),
      price_outcome_5d: outcome.outcome,
      price_mfe_5d_pct: outcome.mfe,
      price_mae_5d_pct: outcome.mae,
       outcome_24h: entry == null ? null : pathStats(bars, at, entry, 24),
       outcome_72h: entry == null ? null : pathStats(bars, at, entry, 72),
      hours_to_plus10: outcome.hoursToPlus10,
      hours_to_minus8: outcome.hoursToMinus8,
      price_data_complete_5d: outcome.complete,
      recorded_drawdown: safeBotValue(
        drawdownBySignal.get(Number(signal.id)) ?? null,
      ),
      recorded_trailing_events: safeBotValue(
        trailingBySignal.get(Number(signal.id)) ?? [],
      ),
      recorded_trajectory_rows: trajectory.length,
      recorded_followup_rows: (followupBySignal.get(Number(signal.id)) ?? [])
        .length,
      bot_metrics_source: "tracked_signals + linked production tables",
      bars15m: bars,
      bars1h: h1BySymbol.get(symbol) ?? [],
      bars4h: h4BySymbol.get(symbol) ?? [],
      bars1d: d1BySymbol.get(symbol) ?? [],
      outcome: outcome.outcome,
    });
  }

  for (const event of bEvents) {
    event.bars15m = m15BySymbol.get(event.symbol) ?? [];
    event.bars1h = h1BySymbol.get(event.symbol) ?? [];
    event.bars4h = h4BySymbol.get(event.symbol) ?? [];
    event.bars1d = d1BySymbol.get(event.symbol) ?? [];
    const price = outcomeLabel(event.bars15m, event.closeAt, Number(event.close));
    Object.assign(event, {
      entry: Number(event.close),
      entry_price: Number(event.close),
      price_outcome_5d: price.outcome,
      price_mfe_5d_pct: price.mfe,
      price_mae_5d_pct: price.mae,
      hours_to_plus10: price.hoursToPlus10,
      hours_to_minus8: price.hoursToMinus8,
      price_data_complete_5d: price.complete,
      outcome: price.outcome,
      first_6h: pathStats(event.bars15m, event.closeAt, Number(event.close), 6),
      outcome_24h: pathStats(event.bars15m, event.closeAt, Number(event.close), 24),
      outcome_72h: pathStats(event.bars15m, event.closeAt, Number(event.close), 72),
      outcome_5d: pathStats(event.bars15m, event.closeAt, Number(event.close), 120),
      filter_event_at: new Date(event.closeAt).toISOString(),
      rule_version:
        event.closeAt >= Date.parse("2026-11-21T00:00:00Z")
          ? "1D zones + Lucy M/W + durable-24h + resistance"
          : event.closeAt >= Date.parse("2026-11-19T00:00:00Z")
            ? "1D zones + Lucy M/W + durable-24h"
            : event.closeAt >= Date.parse("2026-11-15T00:00:00Z")
              ? "1D zones + Lucy M/W"
              : event.closeAt >= Date.parse("2026-11-14T00:00:00Z")
                ? "1D zones"
                : "1D reference replay; legacy live version",
    });
    const recordReasons = findStoredReasons(
      event,
      decisions,
      rejects,
      queue,
      PRODUCTION_LOG_LINES,
    );
    event.recorded_reason_chain = recordReasons;
    const exactQueue = queue.find((row) => {
      const trigger = asTime(row.trigger_candle_at);
      return (
        sym(row.symbol) === event.symbol &&
        trigger != null &&
        Math.abs(trigger - Number(event.candle_open_ms)) <= 1
      );
    });
    event.queue_status = exactQueue?.status ?? null;
    event.queue_terminal_reason = exactQueue?.terminal_reason ?? null;
    const beforeClose = (h1BySymbol.get(event.symbol) ?? []).filter(
      (bar) => bar.time + H1 <= event.closeAt,
    );
    const low24 = Math.min(
      ...beforeClose
        .filter((bar) => bar.time + H1 > event.closeAt - D1)
        .map((bar) => bar.low),
    );
    const low7d = Math.min(
      ...beforeClose
        .filter((bar) => bar.time + H1 > event.closeAt - 7 * D1)
        .map((bar) => bar.low),
    );
    event.from_low24_pct = Number.isFinite(low24)
      ? round(pct(Number(event.close), low24), 5)
      : null;
    event.from_low7d_pct = Number.isFinite(low7d)
      ? round(pct(Number(event.close), low7d), 5)
      : null;
    event.growthFrom7dLowPct = event.from_low7d_pct;
    event.growthFrom24hLowPct = event.from_low24_pct;
    const shape = breakoutReadings(
      event,
      event.bars4h,
      event.bars1h,
      event.bars1d,
    );
    Object.assign(event, shape);
    const previousDaily = event.previous_daily_close;
    const resPassed =
      event.closeAt < Date.parse("2026-11-21T00:00:00Z") ||
      (previousDaily != null &&
        Number(event.zone_bottom) > Number(previousDaily));
    event.resistance_filter_pass = resPassed;
    event.coin_source_cache_only = true;
    event.cached_agg_status = "pending_cache_check";
  }

  const bVolumeMap = new Map<string, { fut: Obj[] | null; spot: Obj[] | null }>();
  for (const symbol of [...new Set(bEvents.map((event) => event.symbol))]) {
    bVolumeMap.set(symbol, {
      fut: useCachedCg(symbol, "aggfut", Math.min(...bEvents.filter((e) => e.symbol === symbol).map((e) => e.closeAt))),
      spot: useCachedCg(symbol, "aggspot", Math.min(...bEvents.filter((e) => e.symbol === symbol).map((e) => e.closeAt))),
    });
  }

  const detailed = new Map<string, Obj>();
  const missingRows: Obj[] = [];
  const filterRows: Obj[] = [];
  const brightBySymbol = new Map<string, Map<number, string>>();
  for (const event of actualA) {
    const colors = (event.signal_volume_color ?? {}) as Obj;
    const aggColors = colors.agg ?? {};
    const recorded = {
      lucy_colour_4h: aggColors.entryColor ?? null,
      lucy_volume_vs_avg120: aggColors.entryRatio ?? null,
      welkin_colour_4h: aggColors.welkinEntry ?? null,
      futures_taker_net_pct: (event.recorded_signal as Obj)?.entry_fut_taker_net_buy ?? null,
      spot_taker_net_pct: (event.recorded_signal as Obj)?.entry_spot_taker_net_buy ?? null,
      funding_rate_pct: (event.recorded_signal as Obj)?.entry_funding_rate ?? null,
      wyckoff_phase: (event.wyckoff_entry as Obj)?.phase ?? null,
    };
    missingRows.push(...makeMissingRows(event, recorded));
  }
  for (const event of bEvents) {
    const cached = bVolumeMap.get(event.symbol);
    const futItems = cached?.fut ?? null;
    const spotItems = cached?.spot ?? null;
    const fut = mapItems(futItems);
    const spot = mapItems(spotItems);
    const h4 = event.bars4h ?? [];
    const eventIndex = h4.findIndex((bar) => bar.time === event.candle_open_ms);
    const retestIndex = h4.findIndex(
      (bar) =>
        bar.time >= event.closeAt &&
        bar.time <= event.closeAt + H5 &&
        bar.low <= Number(event.zone_top),
    );
    const retestBar = retestIndex >= 0 ? h4[retestIndex]! : null;
    event.retest_found = retestBar != null;
    event.retest_depth_pct = retestBar
      ? round(pct(Number(event.zone_top), retestBar.low), 4)
      : null;
    event.retest_close_above_zone = retestBar
      ? retestBar.close > Number(event.zone_top)
      : null;
    let colour: string | null = null;
    let colour1h: string | null = null;
    let volRatio120_1h: number | null = null;
    let volRatio120: number | null = null;
    let spotShare: number | null = null;
    let futureTaker: number | null = null;
    let spotTaker: number | null = null;
    let spotCvdPct: number | null = null;
    const volumeSeries: number[] = [];
    const colors4h = new Map<number, string>();
    const lucyColors4h = new Map<number, string>();
    if (futItems && spotItems) {
      for (const bar of h4) {
        let volume = 0;
        let complete = true;
        for (let hour = 0; hour < 4; hour++) {
          const aggregate = getH1Aggregate(fut, spot, bar.time + hour * H1);
          if (!aggregate) {
            complete = false;
            break;
          }
          volume += aggregate.total;
        }
        volumeSeries.push(complete ? volume : Number.NaN);
      }
      for (let i = LUCY_LONG_BARS - 1; i < volumeSeries.length; i++) {
        const window = volumeSeries.slice(i - LUCY_LONG_BARS + 1, i + 1);
        if (!window.every(Number.isFinite)) continue;
        const candleColour = lucyColour(window, window.length - 1);
        colors4h.set(h4[i]!.time, candleColour);
        lucyColors4h.set(h4[i]!.time, candleColour);
        if (i === eventIndex) {
          colour = candleColour;
          const avg = window.reduce((a, b) => a + b, 0) / window.length;
          volRatio120 = avg > 0 ? window.at(-1)! / avg : null;
        }
      }
      if (retestIndex >= LUCY_LONG_BARS - 1) {
        const retestWindow = volumeSeries.slice(
          retestIndex - LUCY_LONG_BARS + 1,
          retestIndex + 1,
        );
        if (retestWindow.length === LUCY_LONG_BARS &&
            retestWindow.every(Number.isFinite)) {
          const average =
            retestWindow.reduce((sum, value) => sum + value, 0) /
            retestWindow.length;
          event.retest_volume_vs_avg120 =
            average > 0
              ? round(retestWindow.at(-1)! / average, 5)
              : null;
          event.retest_lucy_colour = lucyColour(
            retestWindow,
            retestWindow.length - 1,
          );
        }
      }
      if (!brightBySymbol.has(event.symbol))
        brightBySymbol.set(event.symbol, colors4h);
      const bars1h = event.bars1h ?? [];
      const volumeSeries1h = bars1h.map(
        (item) => getH1Aggregate(fut, spot, item.time)?.total ?? Number.NaN,
      );
      const colors1h = new Map<number, string>();
      for (let i = LUCY_LONG_BARS - 1; i < volumeSeries1h.length; i++) {
        const window = volumeSeries1h.slice(i - LUCY_LONG_BARS + 1, i + 1);
        if (window.every(Number.isFinite)) {
          colors1h.set(bars1h[i]!.time, lucyColour(window, window.length - 1));
        }
      }
      const h1Index = bars1h.findIndex(
        (item) => item.time === floorTime(event.closeAt - H1, H1),
      );
      if (h1Index >= LUCY_LONG_BARS - 1) {
        const volumes = bars1h
          .slice(h1Index - LUCY_LONG_BARS + 1, h1Index + 1)
          .map((item) => getH1Aggregate(fut, spot, item.time)?.total ?? Number.NaN);
        if (volumes.every(Number.isFinite)) {
          colour1h = lucyColour(volumes, volumes.length - 1);
          const avg = volumes.reduce((a, b) => a + b, 0) / volumes.length;
          volRatio120_1h = avg > 0 ? volumes.at(-1)! / avg : null;
        }
      }
      const cachedClimax48 = (
        bars: Candle[],
        volumes: number[],
        index: number,
      ) => {
        if (
          index < 48 ||
          index - 48 < LUCY_LONG_BARS - 1 ||
          volumes.slice(index - 48, index).some((value) => !Number.isFinite(value))
        )
          return {
            bars_ago: null,
            lucy_colour: null,
            welkin_colour: null,
            volume_vs_avg120: null,
            down: null,
            close_pos: null,
          };
        let climaxIndex = index - 48;
        for (let i = index - 47; i < index; i++)
          if (volumes[i]! > volumes[climaxIndex]!) climaxIndex = i;
        const bar = bars[climaxIndex]!;
        const baseline = volumes.slice(
          climaxIndex - LUCY_LONG_BARS + 1,
          climaxIndex + 1,
        );
        const ratio =
          baseline.length === LUCY_LONG_BARS &&
          baseline.every(Number.isFinite) &&
          baseline.reduce((a, b) => a + b, 0) > 0
            ? round(
                volumes[climaxIndex]! /
                  (baseline.reduce((a, b) => a + b, 0) / baseline.length),
                5,
              )
            : null;
        const reading =
          baseline.length === LUCY_LONG_BARS &&
          baseline.every(Number.isFinite)
            ? lucyColour(baseline, baseline.length - 1)
            : null;
        return {
          bars_ago: index - climaxIndex,
          lucy_colour: reading,
          welkin_colour: null,
          volume_vs_avg120: ratio,
          down: bar.close < bar.open,
          close_pos:
            bar.high > bar.low
              ? round(((bar.close - bar.low) / (bar.high - bar.low)) * 100, 4)
              : null,
        };
      };
      event.selling_climax48_4h = cachedClimax48(
        h4,
        volumeSeries,
        eventIndex,
      );
      event.selling_climax48_1h = cachedClimax48(
        bars1h,
        volumeSeries1h,
        h1Index,
      );
      const colorWindow = (
        bars: Candle[],
        colors: Map<number, string>,
        center: number,
        before: number,
        after: number,
      ) =>
        Array.from({ length: before + after + 1 }, (_, offset) => {
          const delta = offset - before;
          const index = center + delta;
          const candle = bars[index];
          return {
            offset: delta,
            time: candle ? new Date(candle.time).toISOString() : null,
            lucy_colour: candle ? colors.get(candle.time) ?? null : null,
            welkin_colour: null,
          };
        });
      event.volume_context_1h = colorWindow(
        bars1h,
        colors1h,
        h1Index,
        6,
        3,
      );
      event.volume_context_4h = colorWindow(
        h4,
        lucyColors4h,
        eventIndex,
        6,
        3,
      );
      const countBright = (colors: Map<number, string>, bars: Candle[], index: number, count: number) =>
        bars.slice(Math.max(0, index - count), index).filter((bar) => {
          const color = colors.get(bar.time);
          return color != null && color !== "G";
        }).length;
      event.bright_12h_count = countBright(colors4h, h4, eventIndex, 3);
      event.bright_24h_count = countBright(colors4h, h4, eventIndex, 6);
      event.bright_48h_count = countBright(colors4h, h4, eventIndex, 12);
      const h4Baseline = volumeSeries
        .slice(Math.max(0, eventIndex - LUCY_LONG_BARS + 1), eventIndex + 1)
        .filter(Number.isFinite);
      const h1IndexForPost = h1Index;
      const h1Baseline = volumeSeries1h
        .slice(Math.max(0, h1IndexForPost - LUCY_LONG_BARS + 1), h1IndexForPost + 1)
        .filter(Number.isFinite);
      event.first_h4_volume_after_vs_avg120 =
        h4Baseline.length === LUCY_LONG_BARS &&
        Number.isFinite(volumeSeries[eventIndex + 1])
          ? round(volumeSeries[eventIndex + 1]! / (h4Baseline.reduce((a, b) => a + b, 0) / h4Baseline.length), 5)
          : null;
      event.first_h1_volume_after_vs_avg120 =
        h1Baseline.length === LUCY_LONG_BARS &&
        Number.isFinite(volumeSeries1h[h1IndexForPost + 1])
          ? round(volumeSeries1h[h1IndexForPost + 1]! / (h1Baseline.reduce((a, b) => a + b, 0) / h1Baseline.length), 5)
          : null;
    }
    const cachedUsable = colour != null;
    event.lucy_colour_4h = colour;
    event.lucy_colour_1h = colour1h;
    event.welkin_colour_1h = null;
    event.welkin_colour_4h = null;
    event.lucy_volume_vs_avg120 = round(volRatio120, 5);
    event.lucy_volume_vs_avg120_1h = round(volRatio120_1h, 5);
    event.spot_share_pct = round(spotShare, 4);
    event.futures_taker_net_pct = round(futureTaker, 4);
    event.spot_taker_net_pct = round(spotTaker, 4);
    event.spot_cvd_pct = round(spotCvdPct, 4);
    event.cached_agg_status = cachedUsable
      ? "cached_aggregate_available"
      : "не записано ботом";
    event.filter_lucy_mw_pass =
      event.closeAt < Date.parse("2026-11-15T00:00:00Z") ||
      (colour != null && ["M", "W"].includes(colour));
    event.bingx_volume_ratio20 =
      eventIndex >= 20
        ? round(
            event.bars4h![eventIndex]!.volume /
              (event.bars4h!
                .slice(eventIndex - 20, eventIndex)
                .reduce((sum, bar) => sum + bar.volume, 0) /
                20),
            5,
          )
        : null;
    event.bingx_volume_source = "BingX comparison only";
    const reasons = String(event.recorded_reason_chain ?? "");
    const filters = checkFilters(
      event,
      reasons,
      colour,
      guardPositions,
      signals,
    );
    Object.assign(event, filters);
    event.data_classification =
      cachedUsable ? "cached aggregate for Lucy only" : "no aggregate cache";
    const stored = {
      lucy_colour_1h: colour1h,
      "lucy_colour_4h": colour,
      welkin_colour_1h: null,
      "lucy_volume_vs_avg120": event.lucy_volume_vs_avg120,
      "lucy_volume_vs_avg120_1h": event.lucy_volume_vs_avg120_1h,
      "lucy_volume_vs_avg120_4h": event.lucy_volume_vs_avg120,
      "welkin_colour_4h": null,
      "spot_share_pct": event.spot_share_pct,
      "futures_taker_net_pct": event.futures_taker_net_pct,
      "spot_taker_net_pct": event.spot_taker_net_pct,
      "spot_cvd_pct": event.spot_cvd_pct,
    };
    const decisionMetricsUnavailable = hasDecisionEntryMetrics
      ? {}
      : Object.fromEntries(
          [
            "spot_share_pct",
            "futures_taker_net_pct",
            "spot_taker_net_pct",
            "spot_cvd_pct",
            "oi_change_1h_pct",
            "oi_change_4h_pct",
            "oi_change_24h_pct",
            "funding_rate_pct",
            "liq_long_mcap_pct",
            "liq_short_mcap_pct",
            "mfi14_1h",
            "cmf20_1h",
            "obv_slope20_1h",
            "wyckoff_phase",
          ].map((metric) => [
            metric,
            "not verifiable: production export of pattern_decision_snapshots.entry_metrics is unavailable",
          ]),
        );
    missingRows.push(...makeMissingRows(event, stored, {
      ...decisionMetricsUnavailable,
      lucy_colour_1h: colour1h != null ? undefined : "не записано ботом",
      lucy_colour_4h: cachedUsable ? undefined : "не записано ботом",
      welkin_colour_1h: "not calculated per requested B scope",
      lucy_volume_vs_avg120: cachedUsable ? undefined : "не записано ботом",
      welkin_colour_4h: "not calculated per requested B scope",
    }));
    const firstFailure = filters.firstFailure;
    const champion = event.outcome === "champion";
    const rejectedChampion = champion;
    event.rejected_champion = rejectedChampion;
    event.cohort = "B";
    event.key = `${event.cohort}:${event.symbol}:${event.candle_open_ms}`;
    const filterRow = {
      event_key: event.key,
      symbol: event.symbol,
      event_at: new Date(event.closeAt).toISOString(),
      outcome: event.outcome,
      rule_version: event.rule_version,
      recorded_reason_chain: reasons,
      recorded_reason_source:
        reasons || event.queue_status ? "production DB snapshot/log/queue" : "no matching production record",
      replay_first_failure: firstFailure,
      recorded_reason_category: filters.recordedCategory,
      mismatch: filters.mismatch,
      unlogged_failure: filters.unloggedFailure,
      daily_zone_pass: filters.dailyZone,
      "4h_cross_pass": filters.closed4hCross,
      resistance_pass: filters.resistance,
      cached_lucy_colour: colour,
      lucy_mw_pass: filters.lucyMW,
      queue24h_pass: filters.queue24h,
      same_symbol_guard_pass: filters.openSameSymbolGuard,
      active_stealth_duplicate_pass: filters.activeStealthDuplicate,
      volume_data_state: event.cached_agg_status,
    };
    filterRows.push(filterRow);
    detailed.set(event.key, event);
  }

  const champions = bEvents.filter((event) => event.outcome === "champion");
  const cSymbols = new Set(champions.map((event) => event.symbol));
  const dEvents = rawCandidates.filter((event) => HER.has(event.symbol));
  const cgAllowedSymbols = new Set([...cSymbols, ...dEvents.map((e) => e.symbol)]);
  const cgEventTimes = new Map<string, number[]>();
  for (const event of [...champions, ...dEvents]) {
    const list = cgEventTimes.get(event.symbol) ?? [];
    list.push(event.closeAt);
    cgEventTimes.set(event.symbol, list);
  }
  for (const times of cgEventTimes.values()) times.sort((a, b) => a - b);
  const cgSeriesBySymbol = new Map<string, Obj>();
  const plannedBySymbol = new Map<string, Obj>();
  for (const symbol of cgAllowedSymbols) {
    const times = cgEventTimes.get(symbol) ?? [];
    const start = Math.max(
      0,
      Math.min(...times) - 25 * D1,
    );
    const end = Math.min(RUN_AT, Math.max(...times) + 5 * D1);
    const needs = {
      aggfut: (() => {
        const c = readCache<Obj>(cacheFileFor(symbol, "cg_aggfut"));
        return !c?.items || c.from > start || c.to < end;
      })(),
      aggspot: (() => {
        const c = readCache<Obj>(cacheFileFor(symbol, "cg_aggspot"));
        return !c?.items || c.from > start || c.to < end;
      })(),
      oi: (() => {
        const c = readCache<Obj>(cacheFileFor(symbol, "cg2_oi"));
        return !c?.items || c.from > start || c.to < end;
      })(),
      liq: (() => {
        const c = readCache<Obj>(cacheFileFor(symbol, "cg2_liq"));
        return !c?.items || c.from > start || c.to < end;
      })(),
      funding: (() => {
        const c = readCache<Obj>(cacheFileFor(symbol, "cg_oi_weight_funding"));
        return !c?.items || c.from > start || c.to < end;
      })(),
    };
    plannedBySymbol.set(symbol, { start, end, needs });
    stats.cgTasksPlanned += Object.values(needs).filter(Boolean).length;
    stats.cgRequestsPlanned +=
      missingCacheSegments(symbol, "cg_aggfut", start, end) +
      missingCacheSegments(symbol, "cg_aggspot", start, end) +
      missingCacheSegments(symbol, "cg2_oi", start, end) +
      missingCacheSegments(symbol, "cg2_liq", start, end) +
      missingCacheSegments(symbol, "cg_oi_weight_funding", start, end);
  }
  console.error(
    `CoinGlass: разрешено только C+D · ${cgAllowedSymbols.size} монет · ` +
      `ожидается до ${stats.cgTasksPlanned} отсутствующих серий`,
  );
  for (const [symbol, plan] of plannedBySymbol) {
    const { start, end, needs } = plan as {
      start: number;
      end: number;
      needs: Record<string, boolean>;
    };
    const aggfut = await ensureCoinGlassSeries(symbol, "aggfut", start, end);
    const aggspot = await ensureCoinGlassSeries(symbol, "aggspot", start, end);
    const oi = await ensureCoinGlassSeries(symbol, "oi", start, end);
    const liq = await ensureCoinGlassSeries(symbol, "liq", start, end);
    const funding = await ensureFunding(symbol, start, end);
    cgSeriesBySymbol.set(symbol, {
      start,
      end,
      aggfut,
      aggspot,
      oi,
      liq,
      funding,
      needs,
    });
  }

  const btc = await klines(CACHE, "BTC-USDT", "4h", START - 60 * H4, RUN_AT).catch(
    () => [] as Candle[],
  );
  const eth = await klines(CACHE, "ETH-USDT", "4h", START - 5 * D1, RUN_AT).catch(
    () => [] as Candle[],
  );
  const btc1h = await klines(CACHE, "BTC-USDT", "1h", START - 60 * H4, RUN_AT).catch(
    () => [] as Candle[],
  );
  const eth1h = await klines(CACHE, "ETH-USDT", "1h", START - 5 * D1, RUN_AT).catch(
    () => [] as Candle[],
  );
  const allPriceRows: Event[] = [...actualA, ...bEvents];
  const eventRows: Obj[] = [];
  const dRows: Obj[] = [];
  const championRows: Obj[] = [];
  const entryRows: Obj[] = [];
  const stopRows: Obj[] = [];
  const exitRows: Obj[] = [];
  const metricLongRows: Obj[] = [];
  const filterCounts = new Map<string, { champion: string[]; bad: string[]; open: string[] }>();

  const addMetricsLong = (event: Event, metrics: Obj) => {
    for (const [metric, value] of Object.entries(metrics)) {
      if (
        value == null ||
        typeof value === "object" ||
        /usd|marketcap|absolute/i.test(metric)
      )
        continue;
      if (typeof value === "number" && !Number.isFinite(value)) continue;
      metricLongRows.push({
        row_type: "value",
        event_key: event.key,
        cohort: event.cohort,
        symbol: event.symbol,
        event_at: new Date(event.closeAt).toISOString(),
        half: event.closeAt < Date.parse("2026-11-15T00:00:00Z") ? "first_half" : "second_half",
        outcome: event.outcome,
        metric,
        value,
      });
    }
  };

  const market = (series: Candle[], t: number, step: number) => {
    const last = priceAtOrBefore(series, t - step);
    const priorStep = priceAtOrBefore(series, t - 2 * step);
    const prior24 = priceAtOrBefore(series, t - D1 - step);
    const close = last?.close ?? null;
    return {
      change1h: step === H1 ? pct(close, priorStep?.close ?? null) : null,
      change4h: step === H4 ? pct(close, priorStep?.close ?? null) : null,
      change24h: pct(close, prior24?.close ?? null),
    };
  };
  const btcEma50Distance = (t: number) => {
    const index = btc.findLastIndex((bar) => bar.time + H4 <= t);
    return index < 0
      ? null
      : priceIndicators(btc, index, H4).ema50DistancePct ?? null;
  };
  const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
  const breakoutsPerDay = new Map<string, number>();
  for (const event of allPriceRows) {
    const day = dayOf(event.closeAt);
    breakoutsPerDay.set(day, (breakoutsPerDay.get(day) ?? 0) + 1);
  }
  const marketContext = (event: Event) => ({
    market_btc_ema50_4h_distance_pct: btcEma50Distance(event.closeAt),
    market_breakouts_same_day: breakoutsPerDay.get(dayOf(event.closeAt)) ?? 0,
  });

  for (const event of allPriceRows) {
    const isA = event.cohort === "A";
    const bars15m = event.bars15m ?? [];
    const bars1h = event.bars1h ?? [];
    const bars4h = event.bars4h ?? [];
    const bars1d = event.bars1d ?? [];
    let metric: Obj = {};
    if (isA) {
      metric = {
        ...(event.entry_metrics as Obj),
        bot_entry_extras: event.entry_extras,
        bot_vsa_entry: event.vsa_entry,
        bot_wyckoff_entry: event.wyckoff_entry,
        bot_volume_color: event.signal_volume_color,
      };
    } else {
      const i4 = bars4h.findIndex((bar) => bar.time === event.candle_open_ms);
      const i1 = bars1h.findIndex(
        (bar) => bar.time === floorTime(event.closeAt - H1, H1),
      );
      const iD = bars1d.findLastIndex(
        (bar) => bar.time + D1 <= event.closeAt,
      );
      const cachedColor = event.lucy_colour_4h;
      const cachedLines = event.cached_agg_status === "cached_aggregate_available";
      metric = {
        ...breakoutReadings(event, bars4h, bars1h, bars1d),
        zoneWidthPct:
          event.zoneHistory?.zoneWidthPct ??
          round(((Number(event.zone_top) - Number(event.zone_bottom)) / Number(event.zone_bottom)) * 100, 5),
        zoneAgeDays: event.zoneHistory?.zoneAgeDays ?? null,
        zoneTouchDays: event.zoneHistory?.zoneTouchDays ?? null,
        zonePivots: event.zone_pivots,
        zoneWasResistance: event.resistance_filter_pass,
        lucy_colour_4h: cachedColor,
        lucy_colour_1h: event.lucy_colour_1h,
        welkin_colour_1h: event.welkin_colour_1h,
        lucy_volume_vs_avg120: event.lucy_volume_vs_avg120,
        lucy_volume_vs_avg120_1h: event.lucy_volume_vs_avg120_1h,
        volume_context_1h: event.volume_context_1h,
        volume_context_4h: event.volume_context_4h,
        bright_12h_count: event.bright_12h_count,
        bright_24h_count: event.bright_24h_count,
        bright_48h_count: event.bright_48h_count,
        selling_climax48_1h: event.selling_climax48_1h,
        selling_climax48_4h: event.selling_climax48_4h,
        first_h1_volume_after_vs_avg120: event.first_h1_volume_after_vs_avg120,
        first_h4_volume_after_vs_avg120: event.first_h4_volume_after_vs_avg120,
        retest_found: event.retest_found,
        retest_depth_pct: event.retest_depth_pct,
        retest_close_above_zone: event.retest_close_above_zone,
        retest_lucy_colour: event.retest_lucy_colour,
        retest_volume_vs_avg120: event.retest_volume_vs_avg120,
        welkin_colour_4h: event.welkin_colour_4h,
        spot_share_pct: event.spot_share_pct,
        futures_taker_net_pct: event.futures_taker_net_pct,
        spot_taker_net_pct: event.spot_taker_net_pct,
        spot_cvd_pct: event.spot_cvd_pct,
        bingx_volume_ratio20: event.bingx_volume_ratio20,
        rsi1h: i1 >= 0 ? priceIndicators(bars1h, i1, H1).rsi14 : null,
        rsi4h: i4 >= 0 ? priceIndicators(bars4h, i4, H4).rsi14 : null,
        rsi1d: iD >= 0 ? priceIndicators(bars1d, iD, D1).rsi14 : null,
        price_indicators_1h: i1 >= 0 ? priceIndicators(bars1h, i1, H1) : {},
        price_indicators_4h: i4 >= 0 ? priceIndicators(bars4h, i4, H4) : {},
        price_indicators_1d: iD >= 0 ? priceIndicators(bars1d, iD, D1) : {},
        market_btc: market(btc, event.closeAt, H4),
        market_eth: market(eth, event.closeAt, H4),
        market_btc_1h: market(btc1h, event.closeAt, H1),
        market_eth_1h: market(eth1h, event.closeAt, H1),
        retest_after_breakout: (() => {
          const retest = bars4h.find(
            (bar) =>
              bar.time >= event.closeAt &&
              bar.time <= event.closeAt + H5 &&
              bar.low <= Number(event.zone_top),
          );
          return retest
            ? {
                at: new Date(retest.time).toISOString(),
                depthPct: round(pct(Number(event.zone_top), retest.low), 4),
                closedAboveZone: retest.close > Number(event.zone_top),
                volumeVsAvg120: event.retest_volume_vs_avg120 ?? null,
                lucyColour: event.retest_lucy_colour ?? null,
              }
            : null;
        })(),
        aggregate_state: cachedLines
          ? "cached_only; no request for B"
          : "не записано ботом",
      };
      for (const [metricName, value] of [
        ["market_btc.change1h", metric.market_btc_1h?.change1h],
        ["market_btc.change4h", metric.market_btc?.change4h],
        ["market_btc.change24h", metric.market_btc?.change24h],
        ["market_eth.change1h", metric.market_eth_1h?.change1h],
        ["market_eth.change4h", metric.market_eth?.change4h],
        ["market_eth.change24h", metric.market_eth?.change24h],
      ]) {
        if (value == null)
          missingRows.push({
            event_key: event.key,
            cohort: event.cohort,
            symbol: event.symbol,
            event_at: new Date(event.closeAt).toISOString(),
            metric: metricName,
            missing_reason: "BingX BTC/ETH candle unavailable",
          });
      }
    }
    Object.assign(metric, marketContext(event));
    if (isA || event.cohort === "B") {
      const marketMissing = Object.fromEntries(
        [
          "market_btc.change1h",
          "market_btc.change4h",
          "market_btc.change24h",
          "market_btc_1h.change1h",
          "market_btc_1h.change24h",
          "market_eth.change1h",
          "market_eth.change4h",
          "market_eth.change24h",
          "market_eth_1h.change1h",
          "market_eth_1h.change24h",
          "market_btc_ema50_4h_distance_pct",
        ].map((name) => [name, "BingX BTC/ETH candle unavailable"]),
      );
      missingRows.push(
        ...makeMissingRows(event, flattenReportMetrics(metric), marketMissing),
      );
    }
    const reasons = isA
      ? findStoredReasons(
          event,
          decisions,
          rejects,
          queue,
          PRODUCTION_LOG_LINES,
        )
      : String(event.recorded_reason_chain ?? "");
    const currentRow: Obj = {
      event_key: event.key,
      cohort: event.cohort,
      source: isA ? "production tracked signal" : "BingX 1D zone replay",
      symbol: event.symbol,
      tracked_signal_id: isA ? event.signal_id : null,
      tf: isA ? (getAEventZone(signalById.get(Number(event.signal_id)) ?? {})?.tf ?? "recorded") : "4h",
      event_at: isA ? event.event_at : new Date(event.closeAt).toISOString(),
      candle_open: isA ? event.event_close_at : event.candle_open,
      rule_version: event.rule_version,
      entry_price: event.entry,
      stop_loss_price: isA ? event.stop_loss_price : Number(event.close) * 0.92,
      zone_bottom: isA ? getAEventZone(signalById.get(Number(event.signal_id)) ?? {})?.levelBottom : event.zone_bottom,
      zone_top: isA ? getAEventZone(signalById.get(Number(event.signal_id)) ?? {})?.levelTop : event.zone_top,
      close_price: isA ? event.entry : event.close,
      status: isA ? event.actual_status : null,
      actual_close_kind: isA ? event.actual_close_kind : null,
      actual_pnl_pct: isA ? event.actual_pnl_pct : null,
      outcome_5d: event.outcome,
      mfe_5d_pct: isA ? event.price_mfe_5d_pct : event.price_mfe_5d_pct,
      mae_5d_pct: isA ? event.price_mae_5d_pct : event.price_mae_5d_pct,
      mfe_24h_pct: event.outcome_24h?.maxPct ?? null,
      mae_24h_pct: event.outcome_24h?.minPct ?? null,
      mfe_72h_pct: event.outcome_72h?.maxPct ?? null,
      mae_72h_pct: event.outcome_72h?.minPct ?? null,
      hours_to_plus10: event.hours_to_plus10,
      hours_to_minus8: event.hours_to_minus8,
      reason_chain: reasons,
      filter_first_failure: isA ? null : event.firstFailure,
      filter_mismatch: isA ? null : event.mismatch,
      data_source_rule: isA ? "bot-recorded values only" : event.data_classification,
      bot_metrics_json: safeBotValue(metric),
      recorded_snapshot_count: isA ? (event.hourly_snapshots as any[])?.length ?? 0 : null,
    };
    eventRows.push(currentRow);
    addMetricsLong(event, flattenReportMetrics(metric));
    if (isA) {
      const signal = (event.recorded_signal ?? {}) as Obj;
      const entryFields = Object.fromEntries(
        Object.entries(signal).filter(([key]) => key.startsWith("entry_")),
      );
      addMetricsLong(
        event,
        flattenBotMetrics({
          entry_fields: entryFields,
          decision_metrics: signal.decision_metrics,
          entry_extras: event.entry_extras,
          vsa_entry: event.vsa_entry,
          wyckoff_entry: event.wyckoff_entry,
          signal_volume_color: event.signal_volume_color,
        }),
      );
    }

    if (!isA) {
      const filters = [
        ["resistance", event.resistance_filter_pass],
        ["lucyMW", event.filter_lucy_mw_pass],
        ["queue24h", event.queue24h],
        ["sameSymbolGuard", event.openSameSymbolGuard],
        ["duplicate", event.activeStealthDuplicate],
      ];
      for (const [filter, passed] of filters) {
        const counts =
          filterCounts.get(String(filter)) ??
          { champion: [], bad: [], open: [] };
        if (passed === false) {
          const bucket =
            event.outcome === "champion"
              ? "champion"
              : event.outcome === "bad"
                ? "bad"
                : "open";
          counts[bucket].push(
            `${event.symbol}@${new Date(event.closeAt).toISOString()}`,
          );
        }
        filterCounts.set(String(filter), counts);
      }
      for (const entryVariant of simulateEntryVariants(
        event,
        bars1h,
        brightBySymbol.get(event.symbol),
      )) {
        const entTime = asTime(entryVariant.entry_time) ?? event.closeAt;
        const entPrice = num(entryVariant.entry_price);
        const passage =
          entPrice == null
            ? { outcome: null, mfe: null, mae: null }
            : outcomeLabel(bars15m, entTime, entPrice);
        entryRows.push({
          event_key: event.key,
          symbol: event.symbol,
          event_at: new Date(event.closeAt).toISOString(),
          variant: entryVariant.variant,
          entry_time: entryVariant.entry_time,
          entry_price: entryVariant.entry_price,
          entry_status: entryVariant.entry_status ?? "entered",
          missing_reason:
            entryVariant.entry_status === "не записано ботом"
              ? "не записано ботом"
              : null,
          outcome_5d: passage.outcome,
          mfe_5d_pct: passage.mfe,
          mae_5d_pct: passage.mae,
        });
      }
      const stopVariants: Array<[string, number]> = [
        ["fixed_6pct", -6],
        ["fixed_8pct_current", -8],
        ["fixed_10pct", -10],
      ];
      if (Number(event.zone_bottom) > 0)
        stopVariants.push([
          "under_zone_bottom",
          round(pct(Number(event.zone_bottom), Number(event.close)) - 0.1) ?? -8,
        ]);
      if (Number(event.low) > 0)
        stopVariants.push([
          "under_breakout_low",
          round(pct(Number(event.low), Number(event.close)) - 0.1) ?? -8,
        ]);
      for (const [variant, stop] of stopVariants) {
        stopRows.push({
          event_key: event.key,
          symbol: event.symbol,
          event_at: new Date(event.closeAt).toISOString(),
          outcome: event.outcome,
          variant,
          stop_pct: stop,
          ...adverseMoveBeforePlus10(bars15m, event.closeAt, Number(event.close)),
          ...simulateStop(bars15m, event.closeAt, Number(event.close), stop),
        });
      }
      const exitVariants = [
        { key: "current_BE8_trail15_10_4d", beAt: 8, trailAt: 15, gap: 10, days: 4 },
        { key: "current_BE8_trail15_10_7d", beAt: 8, trailAt: 15, gap: 10, days: 7 },
        { key: "BE5_trail15_10_4d", beAt: 5, trailAt: 15, gap: 10, days: 4 },
        { key: "BE10_trail15_10_4d", beAt: 10, trailAt: 15, gap: 10, days: 4 },
        { key: "runner80_take10_trail30_30_5d", beAt: 0, trailAt: 30, gap: 30, days: 5, runner: true },
        { key: "ABNeon_BE10_trail20_20_4d", beAt: 10, trailAt: 20, gap: 20, days: 4 },
      ];
      for (const variant of exitVariants) {
        exitRows.push({
          event_key: event.key,
          symbol: event.symbol,
          event_at: new Date(event.closeAt).toISOString(),
          outcome: event.outcome,
          ...simulateExit(bars15m, event.closeAt, Number(event.close), {
            ...variant,
          }),
        });
      }
      for (const variant of [
        { key: "cancel_below_zone_without_volume", requireBright: false },
        { key: "cancel_below_zone_with_non_grey_volume", requireBright: true },
      ]) {
        exitRows.push({
          event_key: event.key,
          symbol: event.symbol,
          event_at: new Date(event.closeAt).toISOString(),
          outcome: event.outcome,
          ...simulateExit(bars15m, event.closeAt, Number(event.close), {
            key: variant.key,
            beAt: null,
            trailAt: 999,
            gap: 999,
            days: 4,
            zoneBottom: Number(event.zone_bottom),
            h4: bars4h,
            h4Bright: brightBySymbol.get(event.symbol),
            requireBright: variant.requireBright,
          }),
        });
      }
    }
  }

  const sampleRows: Obj[] = [];
  for (const baseEvent of dEvents) {
    const event =
      detailed.get(`C:${baseEvent.symbol}:${baseEvent.candle_open_ms}`) ??
      detailed.get(`B:${baseEvent.symbol}:${baseEvent.candle_open_ms}`) ??
      baseEvent;
    const series = cgSeriesBySymbol.get(baseEvent.symbol) ?? {};
    const fut = mapItems(series.aggfut ?? null);
    const spot = mapItems(series.aggspot ?? null);
    const start = Number(series.start ?? baseEvent.closeAt - 25 * D1);
    const iAt = (time: number) => getH1Aggregate(fut, spot, time);
    const p1h = iAt(floorTime(baseEvent.closeAt - H1, H1));
    const p0 = iAt(floorTime(baseEvent.closeAt, H1));
    const pAfter = iAt(floorTime(baseEvent.closeAt + H1, H1));
    const oi = mapItems(series.oi ?? null);
    const liq = mapItems(series.liq ?? null);
    const funding = mapItems(series.funding ?? null);
    const oiValue = (t: number) => num(oi.get(floorTime(t, H1))?.close);
    const oiNow = oiValue(baseEvent.closeAt);
    const oi1h = oiValue(baseEvent.closeAt - H1);
    const oi4h = oiValue(baseEvent.closeAt - 4 * H1);
    const oi24h = oiValue(baseEvent.closeAt - D1);
    const fund = num(funding.get(floorTime(baseEvent.closeAt, H1))?.rate);
    const liquidations = [...liq.values()].filter(
      (row) => Number(row.time) >= baseEvent.closeAt - H1 &&
        Number(row.time) < baseEvent.closeAt + H4,
    );
    const price = outcomeLabel(
      m15BySymbol.get(baseEvent.symbol) ?? [],
      baseEvent.closeAt,
      Number(baseEvent.close),
    );
    const sample: Obj = {
      ...event,
      bars15m: m15BySymbol.get(baseEvent.symbol) ?? [],
      bars1h: h1BySymbol.get(baseEvent.symbol) ?? [],
      bars4h: h4BySymbol.get(baseEvent.symbol) ?? baseEvent.bars4h ?? [],
      bars1d: d1BySymbol.get(baseEvent.symbol) ?? baseEvent.bars1d ?? [],
      key: `D:${baseEvent.symbol}:${baseEvent.candle_open_ms}`,
      cohort: "D",
      sample_coin: baseEvent.symbol,
      outcome: price.outcome,
      price_outcome_5d: price.outcome,
      price_mfe_5d_pct: price.mfe,
      price_mae_5d_pct: price.mae,
      coinGlassAggFutCacheOrFetch: series.aggfut ? "available" : null,
      coinGlassAggSpotCacheOrFetch: series.aggspot ? "available" : null,
      cg_futures_taker_net_1h_before_pct: round(p1h?.futNetPct ?? null, 4),
      cg_futures_taker_net_event_pct: round(p0?.futNetPct ?? null, 4),
      cg_futures_taker_net_1h_after_pct: round(pAfter?.futNetPct ?? null, 4),
      cg_spot_taker_net_1h_before_pct: round(p1h?.spotNetPct ?? null, 4),
      cg_spot_taker_net_event_pct: round(p0?.spotNetPct ?? null, 4),
      cg_spot_taker_net_1h_after_pct: round(pAfter?.spotNetPct ?? null, 4),
      cg_spot_cvd_event_pct: round(p0?.spotCvdPct ?? null, 4),
      cg_oi_change_1h_pct: round(pct(oiNow, oi1h), 4),
      cg_oi_change_4h_pct: round(pct(oiNow, oi4h), 4),
      cg_oi_change_24h_pct: round(pct(oiNow, oi24h), 4),
      cg_funding_rate_pct: round(fund, 6),
      cg_liq_long_mcap_pct: null,
      cg_liq_short_mcap_pct: null,
      cg_liquidation_fields: safeBotValue(liquidations),
      market_cap_source: "not available in approved bot/cache exports",
      cg_data_from: new Date(start).toISOString(),
      cg_data_to: new Date(Number(series.end ?? RUN_AT)).toISOString(),
    };
    const aggregateMetrics = aggregateReading(
      sample as Event,
      fut,
      spot,
    );
    Object.assign(aggregateMetrics, {
      market_btc: market(btc, sample.closeAt, H4),
      market_btc_1h: market(btc1h, sample.closeAt, H1),
      market_eth: market(eth, sample.closeAt, H4),
      market_eth_1h: market(eth1h, sample.closeAt, H1),
      ...marketContext(sample as Event),
    });
    Object.assign(sample, aggregateMetrics);
    const firedSignal = signals.find((signal) => {
      const neon = getAEventZone(signal);
      return (
        sym(signal.symbol) === baseEvent.symbol &&
        asTime(neon?.candleOpenAt) === Number(baseEvent.candle_open_ms)
      );
    });
    const exactQueue = queue.find(
      (row) =>
        sym(row.symbol) === baseEvent.symbol &&
        asTime(row.trigger_candle_at) === Number(baseEvent.candle_open_ms),
    );
    const dReasons = firedSignal
      ? `tracked_signal_id=${firedSignal.id}; status=${firedSignal.status}; cancel_reason=${firedSignal.cancel_reason ?? ""}`
      : findStoredReasons(
          baseEvent,
          decisions,
          rejects,
          queue,
          PRODUCTION_LOG_LINES,
        );
    Object.assign(sample, {
      recorded_reason_chain: dReasons,
      recorded_reason_source: firedSignal
        ? "tracked_signals"
        : dReasons
          ? "decision snapshot / scan reject / durable queue"
          : "no matching production record",
      queue_status: exactQueue?.status ?? null,
      queue_terminal_reason: exactQueue?.terminal_reason ?? null,
      fired_signal_id: firedSignal?.id ?? null,
    });
    const dFilter = checkFilters(
      { ...baseEvent, ...sample, closeAt: baseEvent.closeAt } as Event,
      dReasons,
      aggregateMetrics.lucy_colour_4h ?? null,
      guardPositions,
      firedSignal
        ? signals.filter((signal) => Number(signal.id) !== Number(firedSignal.id))
        : signals,
    );
    filterRows.push({
      event_key: sample.key,
      cohort: "D",
      symbol: sample.symbol,
      event_at: new Date(sample.closeAt).toISOString(),
      outcome: sample.outcome,
      recorded_reason_chain: dReasons,
      recorded_reason_source: sample.recorded_reason_source,
      replay_first_failure: dFilter.firstFailure,
      recorded_reason_category: dFilter.recordedCategory,
      mismatch: dFilter.mismatch,
      unlogged_failure: dFilter.unloggedFailure,
      daily_zone_pass: dFilter.dailyZone,
      "4h_cross_pass": dFilter.closed4hCross,
      resistance_pass: dFilter.resistance,
      cached_lucy_colour: aggregateMetrics.lucy_colour_4h,
      lucy_mw_pass: dFilter.lucyMW,
      queue24h_pass: dFilter.queue24h,
      same_symbol_guard_pass: dFilter.openSameSymbolGuard,
      active_stealth_duplicate_pass: dFilter.activeStealthDuplicate,
      volume_data_state: "CoinGlass allowed C+D",
      fired_signal_id: firedSignal?.id ?? null,
    });
    sampleRows.push(sample);
    addMetricsLong(sample as Event, flattenReportMetrics(aggregateMetrics));
    const vals = {
      ...flattenReportMetrics(aggregateMetrics),
      liq_long_mcap_pct: null,
      liq_short_mcap_pct: null,
    };
    missingRows.push(
      ...makeMissingRows(sample as Event, vals, {
        liq_long_mcap_pct: "market cap not present in permitted production/cache sources",
        liq_short_mcap_pct: "market cap not present in permitted production/cache sources",
      }),
    );
  }

  const cRows = bEvents.filter((event) => event.outcome === "champion");
  for (const event of cRows) {
    const details = cgSeriesBySymbol.get(event.symbol);
    const baseFut = mapItems(details?.aggfut ?? null);
    const baseSpot = mapItems(details?.aggspot ?? null);
    const aggregateMetrics = aggregateReading(event, baseFut, baseSpot);
    Object.assign(aggregateMetrics, {
      market_btc: market(btc, event.closeAt, H4),
      market_btc_1h: market(btc1h, event.closeAt, H1),
      market_eth: market(eth, event.closeAt, H4),
      market_eth_1h: market(eth1h, event.closeAt, H1),
      ...marketContext(event),
    });
    const h4 = event.bars4h ?? [];
    const index = h4.findIndex((bar) => bar.time === event.candle_open_ms);
    const vol4h: number[] = [];
    if (index >= 0) {
      for (const bar of h4.slice(0, index + 1)) {
        let volume = 0;
        let complete = true;
        for (let j = 0; j < 4; j++) {
          const agg = getH1Aggregate(baseFut, baseSpot, bar.time + j * H1);
          if (!agg) {
            complete = false;
            break;
          }
          volume += agg.total;
        }
        vol4h.push(complete ? volume : Number.NaN);
      }
    }
    const win = vol4h.slice(Math.max(0, index - 119), index + 1);
    const c = win.length === 120 && win.every(Number.isFinite)
      ? lucyColour(win, win.length - 1)
      : null;
    const avg = win.length === 120 && win.every(Number.isFinite)
      ? win.reduce((a, b) => a + b, 0) / win.length
      : null;
    event.cg_lucy_colour_4h = c;
    event.cg_lucy_volume_vs_avg120 = avg ? round(win.at(-1)! / avg, 5) : null;
    event.cg_futures_taker_net_pct =
      getH1Aggregate(baseFut, baseSpot, floorTime(event.closeAt, H1))?.futNetPct ?? null;
    event.cg_spot_taker_net_pct =
      getH1Aggregate(baseFut, baseSpot, floorTime(event.closeAt, H1))?.spotNetPct ?? null;
    const cRow = {
      ...reportEvent(event),
      ...aggregateMetrics,
      key: `C:${event.symbol}:${event.candle_open_ms}`,
      cohort: "C",
      aggregate_scope: "CoinGlass used only for rejected champion cohort",
      cg_cache_window: details
        ? `${new Date(details.start).toISOString()}..${new Date(details.end).toISOString()}`
        : "",
      cg_lucy_colour_4h: c,
      cg_lucy_volume_vs_avg120: event.cg_lucy_volume_vs_avg120,
      cg_futures_taker_net_pct: event.cg_futures_taker_net_pct,
      cg_spot_taker_net_pct: event.cg_spot_taker_net_pct,
      market_cap_source: "not available in permitted production/cache exports",
    };
    championRows.push(cRow);
    addMetricsLong(cRow as Event, flattenReportMetrics(aggregateMetrics));
    missingRows.push(
      ...makeMissingRows(cRow as Event, flattenReportMetrics(aggregateMetrics), {
        liq_long_mcap_pct: "market cap not present in permitted production/cache sources",
        liq_short_mcap_pct: "market cap not present in permitted production/cache sources",
      }),
    );
  }

  for (const event of cRows) {
    const key = `C:${event.symbol}:${event.candle_open_ms}`;
    const sample = championRows.find((row) => row.key === key);
    if (sample) {
      eventRows.push({
        event_key: key,
        cohort: "C",
        source: "rejected champion; CoinGlass permitted",
        symbol: event.symbol,
        tracked_signal_id: null,
        tf: "4h",
        event_at: new Date(event.closeAt).toISOString(),
        candle_open: event.candle_open,
        rule_version: event.rule_version,
        entry_price: event.close,
        stop_loss_price: Number(event.close) * 0.92,
        zone_bottom: event.zone_bottom,
        zone_top: event.zone_top,
        close_price: event.close,
        outcome_5d: event.outcome,
        mfe_5d_pct: event.price_mfe_5d_pct,
        mae_5d_pct: event.price_mae_5d_pct,
        mfe_24h_pct: event.outcome_24h?.maxPct ?? null,
        mae_24h_pct: event.outcome_24h?.minPct ?? null,
        mfe_72h_pct: event.outcome_72h?.maxPct ?? null,
        mae_72h_pct: event.outcome_72h?.minPct ?? null,
        hours_to_plus10: event.hours_to_plus10,
        hours_to_minus8: event.hours_to_minus8,
        reason_chain: event.recorded_reason_chain,
        filter_first_failure: event.firstFailure,
        bot_metrics_json: {
          ...reportEvent(event),
          ...reportEvent(sample),
        },
      });
      const reasons = event.recorded_reason_chain || "no matching production record";
      filterRows.push({
        event_key: key,
        symbol: event.symbol,
        event_at: new Date(event.closeAt).toISOString(),
        outcome: event.outcome,
        rejected_champion: true,
        recorded_reason_chain: reasons,
        replay_first_failure: event.firstFailure,
        recorded_reason_category: event.recordedCategory,
        mismatch: event.mismatch,
        unlogged_failure: event.unloggedFailure,
        current_filters: {
          resistance: event.resistance_filter_pass,
          lucyMW: event.filter_lucy_mw_pass,
          queue24h: event.queue24h,
          sameSymbol: event.openSameSymbolGuard,
          duplicate: event.activeStealthDuplicate,
        },
      });
    }
  }

  for (const sample of sampleRows) {
    eventRows.push({
      event_key: sample.key,
      cohort: "D",
      source: "sample breakout; CoinGlass permitted",
      symbol: sample.symbol,
      tracked_signal_id: null,
      tf: "4h",
      event_at: new Date(sample.closeAt).toISOString(),
      candle_open: sample.candle_open,
      rule_version: sample.rule_version,
      entry_price: sample.close,
      stop_loss_price: Number(sample.close) * 0.92,
      zone_bottom: sample.zone_bottom,
      zone_top: sample.zone_top,
      close_price: sample.close,
      outcome_5d: sample.outcome,
      mfe_5d_pct: sample.price_mfe_5d_pct,
      mae_5d_pct: sample.price_mae_5d_pct,
      mfe_24h_pct: sample.outcome_24h?.maxPct ?? null,
      mae_24h_pct: sample.outcome_24h?.minPct ?? null,
      mfe_72h_pct: sample.outcome_72h?.maxPct ?? null,
      mae_72h_pct: sample.outcome_72h?.minPct ?? null,
      hours_to_plus10: sample.hours_to_plus10,
      hours_to_minus8: sample.hours_to_minus8,
      reason_chain: sample.recorded_reason_chain ?? "",
      bot_metrics_json: reportEvent(sample),
    });
    dRows.push(reportEvent(sample));
  }
  const sampleEventSymbols = new Set(sampleRows.map((sample) => sym(sample.symbol)));
  for (const symbol of HER) {
    if (sampleEventSymbols.has(symbol)) continue;
    const error = symbolErrors.find((row) => row.symbol === symbol);
    dRows.push({
      cohort: "D",
      symbol,
      event_at: null,
      outcome: "no_breakout_in_period",
      sample_status: error ? "price_data_unavailable" : "no_natural_breakout_found",
      missing_reason: error ? String(error.reason) : "no closed 4H breakout above a 1D zone during the study period",
      coin_glass_scope: "not requested: no D breakout event",
    });
  }

  const splitAt = Date.parse("2026-11-15T00:00:00Z");
  const firstHalfEntryRows = entryRows.filter(
    (row) => asTime(row.event_at) != null && Number(asTime(row.event_at)) < splitAt,
  );
  const bestEntryVariant =
    [...new Set(firstHalfEntryRows.map((row) => String(row.variant)))]
      .map((variant) => {
        const group = firstHalfEntryRows.filter(
          (row) => row.variant === variant && row.entry_price != null,
        );
        const resolved = group.filter((row) =>
          ["champion", "bad"].includes(String(row.outcome_5d)),
        );
        return {
          variant,
          count: group.length,
          championRate: resolved.length
            ? resolved.filter((row) => row.outcome_5d === "champion").length / resolved.length
            : -1,
        };
      })
      .filter((row) => row.count >= 10)
      .sort((a, b) => b.championRate - a.championRate || b.count - a.count)[0]
      ?.variant ?? "current_4h_close";
  const bestStopVariant =
    [...new Set(
      stopRows
        .filter((row) => (asTime(row.event_at) ?? Infinity) < splitAt)
        .map((row) => String(row.variant)),
    )]
      .map((variant) => {
        const group = stopRows.filter(
          (row) =>
            row.variant === variant &&
            (asTime(row.event_at) ?? Infinity) < splitAt &&
            num(row.exitPct) != null,
        );
        return {
          variant,
          count: group.length,
          meanExit: group.length
            ? group.reduce((sum, row) => sum + Number(row.exitPct), 0) / group.length
            : -Infinity,
        };
      })
      .filter((row) => row.count >= 10)
      .sort((a, b) => b.meanExit - a.meanExit || b.count - a.count)[0]
      ?.variant ?? "fixed_8pct_current";
  const bestExitVariant =
    [...new Set(
      exitRows
        .filter(
          (row) => (asTime(row.event_at) ?? Infinity) < splitAt,
        )
        .map((row) => String(row.variant)),
    )]
      .map((variant) => {
        const group = exitRows.filter(
          (row) =>
            row.variant === variant &&
            (asTime(row.event_at) ?? Infinity) < splitAt &&
            num(row.exit_pct) != null,
        );
        return {
          variant,
          count: group.length,
          meanExit: group.length
            ? group.reduce((sum, row) => sum + Number(row.exit_pct), 0) / group.length
            : -Infinity,
        };
      })
      .filter((row) => row.count >= 10)
      .sort((a, b) => b.meanExit - a.meanExit || b.count - a.count)[0]
      ?.variant ?? "current_BE8_trail15_10_4d";
  const chosenExitConfigs: Record<
    string,
    {
      beAt: number | null;
      trailAt: number;
      gap: number;
      days: number;
      runner?: boolean;
      zoneBottom?: number | null;
      h4?: Candle[];
      h4Bright?: Map<number, string>;
      requireBright?: boolean;
    }
  > = {
    current_BE8_trail15_10_4d: { beAt: 8, trailAt: 15, gap: 10, days: 4 },
    current_BE8_trail15_10_7d: { beAt: 8, trailAt: 15, gap: 10, days: 7 },
    BE5_trail15_10_4d: { beAt: 5, trailAt: 15, gap: 10, days: 4 },
    BE10_trail15_10_4d: { beAt: 10, trailAt: 15, gap: 10, days: 4 },
    runner80_take10_trail30_30_5d: { beAt: 0, trailAt: 30, gap: 30, days: 5, runner: true },
    ABNeon_BE10_trail20_20_4d: { beAt: 10, trailAt: 20, gap: 20, days: 4 },
  };
  const bestComboLabel = `${bestEntryVariant}__${bestStopVariant}__${bestExitVariant}`;
  for (const event of bEvents.filter((row) => row.closeAt >= splitAt)) {
    const eventKey = event.key;
    const selectedEntry = entryRows.find(
      (row) => row.event_key === eventKey && row.variant === bestEntryVariant,
    );
    const selectedStop = stopRows.find(
      (row) => row.event_key === eventKey && row.variant === bestStopVariant,
    );
    const entryAt = asTime(selectedEntry?.entry_time) ?? event.closeAt;
    const entryPrice = num(selectedEntry?.entry_price);
    let selectedStopPct = num(selectedStop?.stop_pct) ?? -8;
    if (entryPrice != null && bestStopVariant === "under_zone_bottom")
      selectedStopPct = round(pct(Number(event.zone_bottom), entryPrice) - 0.1) ?? -8;
    if (entryPrice != null && bestStopVariant === "under_breakout_low")
      selectedStopPct = round(pct(Number(event.low), entryPrice) - 0.1) ?? -8;
    let sim: Obj = {
      variant: `train_selected:${bestComboLabel}`,
      exit_pct: null,
      closed_at: null,
      close_reason:
        selectedEntry?.entry_status ?? "entry_variant_unavailable",
    };
    if (entryPrice != null) {
      const config =
        chosenExitConfigs[bestExitVariant] ??
        {
          beAt: null,
          trailAt: 999,
          gap: 999,
          days: 4,
          zoneBottom: Number(event.zone_bottom),
          h4: event.bars4h,
          h4Bright: brightBySymbol.get(event.symbol),
          requireBright: bestExitVariant === "cancel_below_zone_with_non_grey_volume",
        };
      sim = simulateExit(
        event.bars15m ?? [],
        entryAt,
        entryPrice,
        {
          key: `train_selected:${bestComboLabel}`,
          ...config,
          initialStopPct: selectedStopPct,
        },
      );
    }
    const row = {
      event_key: eventKey,
      symbol: event.symbol,
      event_at: new Date(event.closeAt).toISOString(),
      outcome: event.outcome,
      selected_entry_variant: bestEntryVariant,
      selected_stop_variant: bestStopVariant,
      selected_exit_variant: bestExitVariant,
      entry_time: selectedEntry?.entry_time ?? null,
      entry_price: selectedEntry?.entry_price ?? null,
      stop_pct: entryPrice == null ? null : selectedStopPct,
      ...sim,
      training_period: "2026-11-01..2026-11-15",
      evaluation_period: "2026-11-15..run",
    };
    exitRows.push(row);
  }

  const metricValues = metricLongRows.filter(
    (row) => row.row_type === "value" && row.metric != null,
  );
  for (const metric of [...new Set(metricValues.map((row) => String(row.metric)))]) {
    const values = metricValues.filter((row) => row.metric === metric);
    const named = (cohort: string) =>
      values
        .filter((row) => row.outcome === cohort)
        .map((row) => `${row.symbol}@${row.event_at}=${row.value}`)
        .join("; ");
    const train = values.filter((row) => row.cohort === "B" && row.half === "first_half");
    const holdout = values.filter((row) => row.cohort === "B" && row.half === "second_half");
    const threshold = bestMetricThreshold(train);
    const trainDirection = threshold?.direction;
    const thresholdValue = threshold?.threshold;
    const holdoutNames = (outcome: string, passed: boolean) =>
      holdout
        .filter((row) => {
          if (row.outcome !== outcome || typeof row.value !== "number" || threshold == null)
            return false;
          const rule =
            threshold.direction === "higher"
              ? Number(row.value) >= Number(threshold.threshold)
              : Number(row.value) <= Number(threshold.threshold);
          return rule === passed;
        })
        .map((row) => `${row.symbol}@${row.event_at}=${row.value}`)
        .join("; ");
    metricLongRows.push({
      row_type: "full_named_distribution",
      cohort: "A+B+C+D",
      metric,
      champion_values: named("champion"),
      bad_values: named("bad"),
      open_values: named("open"),
      ambiguous_values: named("ambiguous"),
      pairwise_champion_vs_bad: `champion: ${named("champion")} || bad: ${named("bad")}`,
    });
    if (threshold) {
      metricLongRows.push({
        row_type: "exploratory_threshold_train_first_half",
        cohort: "B",
        metric,
        first_half_threshold: thresholdValue,
        first_half_direction: trainDirection,
        balanced_accuracy: round(Number(threshold.score), 4),
        tp: threshold.tp,
        fn: threshold.fn,
        tn: threshold.tn,
        fp: threshold.fp,
        second_half_champions_pass: holdoutNames("champion", true),
        second_half_champions_cut: holdoutNames("champion", false),
        second_half_bad_pass: holdoutNames("bad", true),
        second_half_bad_cut: holdoutNames("bad", false),
      });
    }
  }
  const filtersCsv = [...filterCounts.entries()].map(([filter, counts]) => ({
    filter,
    champion_failed_count: counts.champion.length,
    champion_failed_names: counts.champion.join("; "),
    bad_failed_count: counts.bad.length,
    bad_failed_names: counts.bad.join("; "),
    open_failed_count: counts.open.length,
    open_failed_names: counts.open.join("; "),
  }));

  const actualCloses: Obj[] = [];
  for (const signal of signals) {
    const id = Number(signal.id);
    const symbol = sym(signal.symbol);
    const closeAt = asTime(signal.closed_at);
    const entryAt = asTime(signal.detected_at);
    const entry = num(signal.entry_price);
    const exit = num(signal.exit_price);
    if (closeAt == null || entryAt == null || entry == null || exit == null) {
      actualCloses.push({
        tracked_signal_id: id,
        symbol,
        detected_at: signal.detected_at,
        actual_status: signal.status,
        actual_close_kind:
          /neutral|reclass/i.test(String(signal.cancel_reason ?? ""))
            ? "neutral"
            : signal.status === "stop_loss" ||
                (/cancel/i.test(String(signal.cancel_reason ?? "")) &&
                  Number(signal.pnl_percent) < 0)
              ? "stop_loss"
              : signal.cancel_reason
                ? `cancellation:${signal.cancel_reason}`
                : signal.status,
        closed_at: signal.closed_at,
        entry_price: entry,
        exit_price: exit,
        pnl_pct: signal.pnl_percent,
        data_note: "no close price/time in tracked_signals",
      });
      continue;
    }
    const bars = m15BySymbol.get(symbol) ?? [];
    const horizons = [1, 4, 24, 72, 120];
    const row: Obj = {
      tracked_signal_id: id,
      symbol,
      detected_at: signal.detected_at,
      rule_version: ruleVersion(signal, entryAt),
      actual_status: signal.status,
      actual_close_kind:
        /neutral|reclass/i.test(String(signal.cancel_reason ?? ""))
          ? "neutral"
        : signal.status === "stop_loss" ||
            (/cancel/i.test(String(signal.cancel_reason ?? "")) &&
              Number(signal.pnl_percent) < 0)
            ? "stop_loss"
            : signal.status === "bu_stop" || signal.status === "breakeven"
              ? "breakeven"
              : signal.status === "profit"
                ? "trailing"
                : signal.status === "expired"
                  ? "4d_expiry"
                  : signal.cancel_reason
                    ? `cancellation:${signal.cancel_reason}`
                    : signal.status,
      closed_at: signal.closed_at,
      entry_price: entry,
      exit_price: exit,
      actual_pnl_pct: signal.pnl_percent,
      cancel_reason: signal.cancel_reason,
      recorded_trajectory_rows: trajectories.filter((r) => Number(r.signal_id) === id).length,
      recorded_followup_rows: (followupBySignal.get(id) ?? []).length,
      recorded_followup_snapshots: safeBotValue(followupBySignal.get(id) ?? []),
      recorded_cancel_outcomes: safeBotValue(cancelOutcomeBySignal.get(id) ?? []),
      recorded_trailing_events: safeBotValue(trailingBySignal.get(id) ?? []),
      recorded_drawdown: safeBotValue(drawdownBySignal.get(id) ?? null),
    };
    for (const hours of horizons) {
      const fromClose = pathStats(bars, closeAt, exit, hours);
      const fromEntry = pathStats(bars, closeAt, entry, hours);
      row[`after_${hours}h_max_from_close_pct`] = fromClose.maxPct;
      row[`after_${hours}h_min_from_close_pct`] = fromClose.minPct;
      row[`after_${hours}h_max_from_entry_pct`] = fromEntry.maxPct;
      row[`after_${hours}h_min_from_entry_pct`] = fromEntry.minPct;
      row[`after_${hours}h_hit_plus10_from_entry`] = fromEntry.hit10;
      row[`after_${hours}h_hit_minus8_from_entry`] = fromEntry.hitMinus8;
      row[`after_${hours}h_complete`] = fromClose.complete;
    }
    actualCloses.push(row);
  }

  for (const row of actualCloses) {
    if (row.after_72h_max_from_entry_pct == null) {
      row.close_verdict = "insufficient_post-close_price_coverage";
      continue;
    }
    const reachedPlus10 = [1, 4, 24, 72, 120].some(
      (hours) => row[`after_${hours}h_hit_plus10_from_entry`] === true,
    );
    const fellFurther = [1, 4, 24, 72, 120].some(
      (hours) => row[`after_${hours}h_hit_minus8_from_entry`] === true,
    );
    const closePnl = num(row.actual_pnl_pct);
    row.close_verdict =
      reachedPlus10 && (closePnl == null || closePnl < 10)
        ? "likely_early_close_later_plus10"
        : fellFurther && !reachedPlus10
          ? "close_avoided_further_minus8"
          : "no_clear_early_close_evidence";
  }

  const currentExitByKey = new Map(
    exitRows
      .filter((row) => row.variant === "current_BE8_trail15_10_4d")
      .map((row) => [row.event_key, row]),
  );
  const currentBTrades = bEvents.map((event) => {
    const exit = currentExitByKey.get(event.key);
    const failedFilter =
      event.resistance_filter_pass === false
        ? "current_filter_resistance"
        : event.filter_lucy_mw_pass === false
          ? "current_filter_lucy_mw"
          : event.queue24h === false
            ? "current_filter_queue24h"
            : event.openSameSymbolGuard === false
              ? "current_filter_same_symbol_guard"
              : event.activeStealthDuplicate === false
                ? "current_filter_duplicate"
                : null;
    return {
      event_key: event.key,
      symbol: event.symbol,
      event_at: new Date(event.closeAt).toISOString(),
      entryAt: event.closeAt,
      entry_time: new Date(event.closeAt).toISOString(),
      entry_price: event.close,
      exit_time: exit?.closed_at ?? null,
      exitPct: exit?.exit_pct ?? null,
      close_reason: exit?.close_reason ?? null,
      variant: "current_4h_entry_fixed_8_stop_BE8_trail15_10_4d",
      skip_reason: failedFilter,
    };
  });
  const selectedBestTrades = bEvents
    .filter((event) => event.closeAt >= splitAt)
    .map((event) => {
      const exit = exitRows.find(
        (row) =>
          row.event_key === event.key &&
          String(row.variant).startsWith("train_selected:"),
      );
      return {
        event_key: event.key,
        symbol: event.symbol,
        event_at: new Date(event.closeAt).toISOString(),
        entryAt: asTime(exit?.entry_time) ?? event.closeAt,
        entry_time: exit?.entry_time ?? null,
        entry_price: exit?.entry_price ?? null,
        exit_time: exit?.closed_at ?? null,
        exitPct: exit?.exit_pct ?? null,
        close_reason: exit?.close_reason ?? null,
        variant: exit?.variant ?? `train_selected:${bestComboLabel}`,
        skip_reason:
          event.firstFailure ??
          (String(exit?.close_reason ?? "").startsWith("entry_variant_unavailable") ||
          String(exit?.close_reason ?? "").startsWith("filtered_by") ||
          exit?.close_reason === "не записано ботом"
            ? String(exit.close_reason)
            : null),
      };
    });
  const observedATrades = signals.map((signal) => {
    const entryAt = asTime(signal.detected_at) ?? RUN_AT;
    const entryPrice = num(signal.entry_price);
    const closedAt = asTime(signal.closed_at);
    const exitPrice = num(signal.exit_price);
    const currentBars = m15BySymbol.get(sym(signal.symbol)) ?? [];
    const last = [...currentBars].reverse().find((bar) => bar.time < RUN_AT);
    const returnPct =
      num(signal.pnl_percent) ??
      (entryPrice != null && (closedAt == null ? last?.close : exitPrice) != null
        ? pct(closedAt == null ? last!.close : exitPrice!, entryPrice)
        : null);
    return {
      event_key: `A:${signal.id}`,
      symbol: sym(signal.symbol),
      event_at: signal.detected_at,
      entryAt,
      entry_time: signal.detected_at,
      entry_price: entryPrice,
      exit_time: signal.closed_at ?? (last ? new Date(last.time + M15).toISOString() : null),
      exitPct: returnPct,
      close_reason: signal.status,
      variant: "observed_A_actual_bot_result",
      skip_reason: null,
    };
  });
  const depositRows = [
    ...simulatePortfolio("B_current_filtered_full_period", currentBTrades),
    ...simulatePortfolio(
      "B_current_filtered_second_half",
      currentBTrades.filter((trade) => (asTime(trade.event_at) ?? 0) >= splitAt),
    ),
    ...simulatePortfolio(
      `B_first_half_selected_out_of_sample:${bestComboLabel}`,
      selectedBestTrades,
    ),
    ...simulatePortfolio("A_actual_bot_positions", observedATrades),
  ];
  const bestVariantSelection = {
    entry: bestEntryVariant,
    stop: bestStopVariant,
    exit: bestExitVariant,
    training_period: "2026-11-01 through 2026-11-15 UTC",
    evaluation_period: "2026-11-15 through run UTC",
  };

  const championCount = bEvents.filter((event) => event.outcome === "champion").length;
  const badCount = bEvents.filter((event) => event.outcome === "bad").length;
  const ambiguousCount = bEvents.filter((event) => event.outcome === "ambiguous").length;
  const openCount = bEvents.filter((event) => event.outcome === "open").length;
  const firedA = actualA.length;
  const mismatchRows = filterRows.filter((row) => row.mismatch === true);
  const unloggedRows = filterRows.filter((row) => row.unlogged_failure === true);
  const halfSplit = bEvents.filter((event) => event.closeAt < Date.parse("2026-11-15T00:00:00Z"));
  const productionLogTimes = PRODUCTION_LOG_LINES.flatMap((line) => {
    const match = line.match(/20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/);
    return match ? [match[0]] : [];
  }).sort();
  const depositSummary = [...new Set(depositRows.map((row) => String(row.scenario)))]
    .map((scenario) => {
      const group = depositRows.filter((row) => row.scenario === scenario);
      return {
        scenario,
        trades_opened: group.filter((row) => row.status === "opened").length,
        trades_skipped: group.filter((row) => row.status === "skipped").length,
        final_balance_usd: group.at(-1)?.final_balance_usd ?? 1_000,
        final_balance_pct: group.at(-1)?.final_balance_pct ?? 0,
      };
    });
  const missingByKey = new Map<string, Obj>();
  for (const row of missingRows) {
    const key = `${row.event_key}:${row.metric}`;
    const previous = missingByKey.get(key);
    if (
      previous?.missing_reason?.includes("not verifiable") &&
      row.missing_reason === "не записано ботом"
    )
      continue;
    missingByKey.set(key, row);
  }
  const uniqueMissingRows = [...missingByKey.values()];
  const summary = [
    "# Stealth final study — 2026-11-01 to 2026-11-27",
    "",
    `Run timestamp UTC: ${RUN_AT_ISO}. Production export cutoff: ${MANIFEST.runAt}.`,
    "",
    "## Scope and data boundaries",
    "- A: all Stealth tracked signals in the export window; all signal metrics are from production bot tables only.",
    "- B: every reconstructed 4H close above a computed 1D zone with the preceding 4H close at/below the zone; B metrics use BingX prices, production reasons, and Lucy volume only when already cached.",
    `- Scan universe: ${symbols.length} symbols from prior Stealth/ABNeon reports, production signal symbols, and D examples; unrelated cache symbols are excluded.`,
    "- C: B events reaching +10% before −8% within five days; CoinGlass was permitted only for these rejected champions.",
    `- D: ERA, MAGMA, and symbols in her-coins.txt (${[...HER].join(", ")}); CoinGlass permitted only for these samples.`,
    "- No Auto Range calculations or fields were used. Absolute USD volume, liquidation, and market-cap values are omitted; derived metrics are percentages/ratios.",
    "- Same-candle +10% and −8% touches are classified ambiguous. Events with less than five days of observed history remain open unless a threshold was reached.",
    "",
    "## Production rows and coverage",
    `- tracked_signals A: ${MANIFEST.counts.tracked_signals_stealth}; signal_entry_extras: ${MANIFEST.counts.signal_entry_extras}; vsa_entry_metrics: ${MANIFEST.counts.vsa_entry_metrics}; wyckoff_entry_metrics: ${MANIFEST.counts.wyckoff_entry_metrics}; signal_volume_colors: ${MANIFEST.counts.signal_volume_colors}.`,
    `- stealth_abneon_shadow_candidates (neon-level): ${MANIFEST.counts.stealth_abneon_shadow_candidates_neon_level}; selected pattern_decision_snapshots: ${MANIFEST.counts.pattern_decision_snapshots_selected}.`,
    `- scan_reject_log Stealth neon-level: ${MANIFEST.counts.scan_reject_log_stealth_neon_level} rows, coverage ${MANIFEST.counts.scan_reject_log_coverage_from} to ${MANIFEST.counts.scan_reject_log_coverage_to}; this is not complete for Nov 1–23.`,
    `- Production logs: ${PRODUCTION_LOG_LINES.length} lines, timestamp span ${productionLogTimes[0] ?? "none"} to ${productionLogTimes.at(-1) ?? "none"}; matching symbol/candle evidence is included in reason_chain.`,
    hasDecisionEntryMetrics
      ? `- pattern_decision_snapshots: ${decisions.length} full rows including entry_metrics.`
      : `- pattern_decision_snapshots.entry_metrics: not available in the existing export; a repeat read-only SELECT was canceled by the production replica ("canceling statement due to conflict with recovery"). Existing decision rows still include IDs, kinds, reasons, symbols and timestamps.`,
    `- stealth_hourly_snapshots: ${MANIFEST.counts.stealth_hourly_snapshots_total} total, ${MANIFEST.counts.stealth_hourly_snapshots_selected} selected checkpoints; signal_trajectory_log ${MANIFEST.counts.signal_trajectory_log}; signal_drawdown_extrema ${MANIFEST.counts.signal_drawdown_extrema}; signal_trailing_events ${MANIFEST.counts.signal_trailing_events}; bu_stop_followup_snapshots ${MANIFEST.counts.bu_stop_followup_snapshots}; signal_cancel_outcomes ${MANIFEST.counts.signal_cancel_outcomes}; missed_signals_log ${MANIFEST.counts.missed_signals_log_stealth}.`,
    "- Production export is fixed at the timestamp above; records written after that cutoff are not included.",
    "",
    "## Cohorts",
    `- A fired records: ${firedA}.`,
    `- B reconstructed events with no exact Neon-Level fired match: ${bEvents.length} (pre-Nov15 ${halfSplit.length}; Nov15 onward ${bEvents.length - halfSplit.length}).`,
    `- B outcome over five days: champion ${championCount}, bad ${badCount}, ambiguous ${ambiguousCount}, open ${openCount}.`,
    `- C rejected champions: ${championCount}. D breakout events: ${sampleRows.length}; examples.csv includes ${dRows.length} rows including samples with no breakout.`,
    "",
    "## Data request counts",
    `- BingX HTTP requests: ${stats.bingxRequests}; HTTP/logical errors: ${stats.bingxErrors}; symbol-history failures: ${symbolErrors.length}.`,
    `- BingX concurrency: peak ${stats.bingxMaxConcurrent}, configured limit 4; klines reads reports/.cache first and requests only missing tails.`,
    `- CoinGlass HTTP attempts (including retries/429): ${stats.cgRequests}; errors: ${stats.cgErrors}; 429 responses: ${stats.cg429}; successful responses: ${stats.cgOk}; empty responses: ${stats.cgEmpty}.`,
    `- CoinGlass scope: C + D only; ${cgAllowedSymbols.size} unique symbols considered; ${stats.cgTasksDone} missing series completed; ${stats.cgTasksPlanned} series were initially missing.`,
    "",
    "## Filter replay",
    `- Recorded-vs-replayed mismatches: ${mismatchRows.length}; unlogged rejections from replayed filters: ${unloggedRows.length}. Full named rows are in filter_check.csv.`,
    "- Reason source window in production: scan_reject_log exists only from Nov24 07:34 UTC in this export; earlier rejection attribution relies on decision snapshots and durable queue records, and otherwise remains unrecorded.",
    "- The detector was daily-zone based from Nov14; M/W Lucy gating from Nov15; durable 24h queue from Nov19; resistance-only zones from Nov21. Events before each date are not retroactively assigned that live filter.",
    "",
    "## Samples and limitations",
    "- D examples are in examples.csv. Any unsupported/missing BingX symbol is listed in errors.json and has no inferred candle outcome.",
    "- Liq-%-of-market-cap remains blank when market cap is not present in the permitted bot/cache sources; missing_metrics.csv gives a row per metric and event.",
    "- Zone age/touch readings are computed from daily price interaction with the selected zone; the bot does not persist a separate per-zone age counter.",
    "- Selling-climax context uses the highest-volume bar in the 48 bars before the event; retest rows include depth and Lucy ratio/color when permitted aggregate data exists.",
    "- BTC 4H EMA50 distance and same-UTC-day reconstructed breakout count are included in market context.",
    "- 15m candles are used for passage and simulated exits; when both thresholds occur in one bar, passage is ambiguous. Exit variants are bar-based simulations, not a claim about exchange fill order.",
    `- Deposit: ${JSON.stringify(depositSummary)}.`,
    `- First-half selected entry/stop/exit combo for second-half evaluation: ${JSON.stringify(bestVariantSelection)}; components were selected independently, not as a joint optimization.`,
    "- Deposit uses $1,000 start, $100 isolated margin, 10x leverage, same-symbol exclusivity and available-margin accounting; fees/slippage are not modeled and this is not a signal-count limit.",
    "",
    "## Recommendations supported by this run",
    `- Review ${mismatchRows.length} mismatches and ${unloggedRows.length} unlogged replay failures by name in filter_check.csv before changing a live gate.`,
    `- The largest observed replayed failed-filter cohorts are listed in filters.csv; champion/bad/open membership is explicit there. No signal cap or time-based trade exit is proposed.`,
    "",
    "## Code references",
    "- 1D zone implementation: artifacts/api-server/src/lib/stealth-abneon-detectors.ts:291–360.",
    "- 4H crossing: artifacts/api-server/src/lib/stealth-neon-level-breakout.ts:215–247.",
    "- Resistance requirement: artifacts/api-server/src/lib/scanner.ts:1106–1112.",
    "- Lucy/Welkin M/W and 120-bar grey rule: artifacts/api-server/src/lib/abneon-volume-gate.ts:87–125; breakout colour: artifacts/api-server/src/lib/stealth-neon-level-breakout.ts:251–260.",
    "- Durable queue, 24h TTL and volume rechecks: artifacts/api-server/src/lib/scanner.ts:611, 823–885, 1030–1073, 15682–15743.",
    "- Entry window: the queue remains eligible until 24h after the breakout candle close (scanner.ts:611, 15720–15743); the 5/10/15-minute reads are separate.",
    "- Same-symbol open-position guard: artifacts/api-server/src/lib/watcher.ts:2466–2481.",
    "- Stealth stop −8%: artifacts/api-server/src/lib/watcher-config.ts:176–178.",
    "- BE +8%, trailing profile and max watch: artifacts/api-server/src/lib/watcher-config.ts:232–249, 33; watcher.ts:8950–8952.",
    "",
  ].join("\n");
  writeFileSync(join(OUT, "summary.md"), summary);

  writeCsv(join(OUT, "events.csv"), eventRows);
  writeCsv(join(OUT, "filter_check.csv"), filterRows);
  writeCsv(join(OUT, "filters.csv"), filtersCsv);
  writeCsv(join(OUT, "metrics_compare.csv"), metricLongRows);
  writeCsv(join(OUT, "entries.csv"), entryRows);
  writeCsv(join(OUT, "stops.csv"), stopRows);
  writeCsv(join(OUT, "exits.csv"), exitRows);
  writeCsv(join(OUT, "closes_after.csv"), actualCloses);
  writeCsv(join(OUT, "champions_missed.csv"), championRows);
  writeCsv(join(OUT, "examples.csv"), dRows);
  writeCsv(join(OUT, "deposit.csv"), depositRows);
  writeCsv(join(OUT, "missing_metrics.csv"), uniqueMissingRows);
  writeFileSync(
    join(OUT, "errors.json"),
    JSON.stringify(
      {
        productionExportCutoff: MANIFEST.runAt,
        symbolErrors,
        requestErrors: stats.errors,
        rejectedChampions: champions.length,
        coinGlassAllowedSymbols: [...cgAllowedSymbols],
        coinGlassStats: {
          requests: stats.cgRequests,
          errors: stats.cgErrors,
          rateLimited429: stats.cg429,
          successful: stats.cgOk,
          empty: stats.cgEmpty,
        },
      },
      null,
      2,
    ),
  );
  const runLines = [
    "attempt_1=stopped at 50/1093 before CoinGlass; initial cache glob included unrelated symbols",
    "attempt_1_coinGlass_requests=0",
    "attempt_2=stopped before CoinGlass after audit found the prior-event file omitted symbols from other named study universes; no 50-symbol progress line was reached",
    "attempt_2_coinGlass_requests=0",
    "attempt_3=stopped at 50/549 before CoinGlass after request to use four concurrent BingX requests; BingX counters were not flushed; CoinGlass requests=0",
    "attempt_4=stopped at 200/549 before CoinGlass; no candle-cache files had refreshed; no CoinGlass requests",
    "attempt_5=stopped at 50/549 after BingX returned code 109429; 522 HTTP attempts and 50 symbol failures; no candle-cache refresh; CoinGlass requests=0",
    `attempt_6=scan universe is the same union of prior Stealth/ABNeon reports + production signals + D examples (${symbols.length} symbols); idempotent USDT symbol normalization; four workers, max four concurrent BingX HTTP requests, cache-first; honors BingX 109429 retry timestamp`,
    `run_utc=${RUN_AT_ISO}`,
    `production_export_cutoff=${MANIFEST.runAt}`,
    `study_period=${new Date(START).toISOString()}..${RUN_AT_ISO}`,
    `input_rows: A=${signals.length}, extras=${extras.length}, vsa=${vsaRows.length}, wyckoff=${wyckoffRows.length}, colors=${colors.length}, queue=${queue.length}, decisions=${decisions.length}, rejects=${rejects.length}, hourlyGroups=${hourlyRows.length}, selectedHourlySnapshots=${MANIFEST.counts.stealth_hourly_snapshots_selected}, trajectory=${trajectories.length}, drawdown=${drawdowns.length}, trailing=${trailingEvents.length}, followup=${closeFollowups.length}, guard=${guardPositions.length}`,
    `cohorts: A=${actualA.length}, B=${bEvents.length}, C=${championCount}, D=${dRows.length}`,
    `outcomes_B_5d: champion=${championCount}, bad=${badCount}, ambiguous=${ambiguousCount}, open=${openCount}`,
    `scan_reject_log_coverage=${MANIFEST.counts.scan_reject_log_coverage_from}..${MANIFEST.counts.scan_reject_log_coverage_to} (${MANIFEST.counts.scan_reject_log_stealth_neon_level} rows)`,
    `bingx_requests=${stats.bingxRequests} bingx_errors=${stats.bingxErrors} bingx_peak_concurrent=${stats.bingxMaxConcurrent} bingx_limit=4 symbol_failures=${symbolErrors.length}`,
    `coinglass_requests=${stats.cgRequests} coinglass_errors=${stats.cgErrors} coinglass_429=${stats.cg429} coinglass_ok=${stats.cgOk} coinglass_empty=${stats.cgEmpty}`,
    ...stats.cgProgressLines,
    `coinglass_scope=C+D only; unique_symbols=${cgAllowedSymbols.size}; requested_series=${stats.cgTasksDone}; initially_missing_series=${stats.cgTasksPlanned}`,
    `coinglass_requests_planned=${stats.cgRequestsPlanned}`,
    `deposit_best_first_half=${bestComboLabel}`,
    `filter_mismatches=${mismatchRows.length}; unlogged_filter_failures=${unloggedRows.length}`,
    `outputs: events=${eventRows.length}, filter_check=${filterRows.length}, filters=${filtersCsv.length}, metrics_compare=${metricLongRows.length}, entries=${entryRows.length}, stops=${stopRows.length}, exits=${exitRows.length}, closes_after=${actualCloses.length}, champions_missed=${championRows.length}, examples=${dRows.length}, missing_metrics=${uniqueMissingRows.length}`,
    `errors=${symbolErrors.length + stats.errors.length}`,
  ];
  writeFileSync(join(OUT, "run.txt"), `${runLines.join("\n")}\n`);
  console.log(runLines.join("\n"));
}

void main().catch((error) => {
  const message = `${new Date().toISOString()} FATAL ${String(error)}\n`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "run.txt"), message);
  console.error(message);
  process.exitCode = 1;
});
