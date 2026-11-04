import { marketFetch } from "./marketRequestBudget.js";
import {
  detectLuxAlgoDemandZones,
  detectLuxAlgoSwingDemandZones,
  type LcWaitingObCandle,
} from "./lc-waiting-ob.js";

/**
 * Owner decision: the order-block wait is no longer an LC entry requirement;
 * the lower-wick reaction filter replaced it. New candidates are never moved to
 * OB waiting. Waits created earlier keep draining under their existing rules
 * until they release or expire (history is preserved).
 */
export const LC_OB_WAIT_ENABLED = false;
export const LC_OB_WAIT_WINDOW_MS = 96 * 60 * 60 * 1000;
export const LC_OB_WAIT_RELEASE_LEASE_MS = 5 * 60 * 1000;
/** Zero tolerance means the ticker must actually enter/touch the frozen zone. */
export const LC_OB_WAIT_TRIGGER_TOLERANCE_PCT = 0;

export type LcObVenue =
  | "bingx"
  | "binance"
  | "okx"
  | "bybit"
  | "gate"
  | "kucoin"
  | "mexc"
  | "bitget"
  | "htx"
  | "kraken";
export type LcObTimeframe = "1h" | "4h";
export type LcObDetector = "LuxAlgo" | "IMB";
export const LC_OB_SPOT_VENUES: readonly LcObVenue[] = [
  "bingx",
  "binance",
  "okx",
  "bybit",
  "gate",
  "kucoin",
  "mexc",
  "bitget",
  "htx",
  "kraken",
];

export interface LcObZone {
  venue: LcObVenue;
  instrumentId: string;
  timeframe: LcObTimeframe;
  detector: LcObDetector;
  low: number;
  high: number;
  /** Confirmation candle close, not its open time. */
  confirmedAt: number;
  fetchedAt: number;
  detectorVersion: string;
}

export interface LcObVenueCandles {
  venue: LcObVenue;
  instrumentId: string;
  timeframe: LcObTimeframe;
  candles: LcWaitingObCandle[];
  fetchedAt: number;
}

export type LcObFetchResult =
  | { usable: true; series: LcObVenueCandles }
  | {
      usable: false;
      venue: LcObVenue;
      instrumentId: string;
      timeframe: LcObTimeframe;
      reason: string;
    };

export interface LcAutoRangeVenueHistory {
  venue: LcObVenue;
  instrumentId: string;
  fourHour: LcAutoRangeHistoryCandle[];
  oneHour: LcAutoRangeHistoryCandle[];
  fetchedAt: number;
}

export interface LcAutoRangeHistoryCandle extends LcWaitingObCandle {
  volume: number;
}

export type LcAutoRangeVenueHistoryResult =
  | { usable: true; history: LcAutoRangeVenueHistory }
  | {
      usable: false;
      venue: LcObVenue;
      instrumentId: string;
      reason: string;
    };

const TF_MS: Record<LcObTimeframe, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};
const cache = new Map<
  string,
  { fetchedAt: number; candles: LcWaitingObCandle[] }
>();
const cacheTtlMs: Record<LcObTimeframe, number> = {
  "1h": 5 * 60_000,
  "4h": 15 * 60_000,
};
const LC_OB_VENUE_BATCH_SIZE = 4;
const LC_OB_VENUE_CIRCUIT_BREAKER_MS = 10 * 60_000;
const LC_OB_VENUE_FAILURE_THRESHOLD = 2;
const venueFailures = new Map<
  LcObVenue,
  { failures: number; openUntil: number }
>();
const autoRangeHistoryCache = new Map<
  string,
  { fetchedAt: number; candles: LcWaitingObCandle[] }
>();
const AUTO_RANGE_HISTORY_MIN_BARS = 900;
const AUTO_RANGE_HISTORY_PAGE_LIMIT = 2;
const AUTO_RANGE_HISTORY_CACHE_TTL_MS = 15 * 60_000;

const VENUE_BASE_ALIAS: Record<string, string> = { DARKSWAP: "DARK" };

export function lcObInstrumentId(
  venue: LcObVenue,
  symbol: string,
): string | null {
  const match = /^([A-Z0-9]+)-USDT$/.exec(symbol.toUpperCase());
  if (!match) return null;
  // BingX ticker -> ticker used by other exchanges (same asset, verified by
  // matching price: BingX 0.003147 vs MEXC 0.003088).
  const base = VENUE_BASE_ALIAS[match[1]!] ?? match[1]!;
  switch (venue) {
    case "gate":
      return `${base}_USDT`;
    case "htx":
      return `${base.toLowerCase()}usdt`;
    case "kraken":
      return `${base === "BTC" ? "XBT" : base}USDT`;
    case "kucoin":
    case "bingx":
    case "okx":
      return `${base}-USDT`;
    case "binance":
    case "bybit":
    case "bitget":
    case "mexc":
      return `${base}USDT`;
  }
}

function toNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeLcObRows(
  rows: unknown[],
  venue: LcObVenue,
  timeframe: LcObTimeframe,
  now: number,
): LcWaitingObCandle[] {
  const interval = TF_MS[timeframe];
  const candles: LcWaitingObCandle[] = [];
  for (const raw of rows) {
    let time: number | null = null;
    let open: number | null = null;
    let high: number | null = null;
    let low: number | null = null;
    let close: number | null = null;
    let volume: number | null = null;
    if (venue === "binance" && Array.isArray(raw)) {
      time = toNumber(raw[0]);
      open = toNumber(raw[1]);
      high = toNumber(raw[2]);
      low = toNumber(raw[3]);
      close = toNumber(raw[4]);
      volume = toNumber(raw[5]);
    } else if (venue === "bingx" && Array.isArray(raw)) {
      time = toNumber(raw[0]);
      open = toNumber(raw[1]);
      high = toNumber(raw[2]);
      low = toNumber(raw[3]);
      close = toNumber(raw[4]);
      volume = toNumber(raw[5]);
    } else if (venue === "okx" && Array.isArray(raw)) {
      time = toNumber(raw[0]);
      open = toNumber(raw[1]);
      high = toNumber(raw[2]);
      low = toNumber(raw[3]);
      close = toNumber(raw[4]);
      volume = toNumber(raw[6]);
    } else if (
      venue === "bybit" ||
      venue === "mexc" ||
      venue === "bitget" ||
      venue === "kraken"
    ) {
      if (!Array.isArray(raw)) continue;
      // Bybit kline rows are [startTime, open, high, low, close, ...].
      time = toNumber(raw[0]);
      open = toNumber(raw[1]);
      high = toNumber(raw[2]);
      low = toNumber(raw[3]);
      close = toNumber(raw[4]);
      volume = venue === "kraken" ? toNumber(raw[6]) : toNumber(raw[5]);
      if (venue === "kraken") time = time === null ? null : time * 1000;
    } else if (venue === "gate" && Array.isArray(raw)) {
      // Gate rows are [time, quoteVolume, close, high, low, open, ...].
      time = toNumber(raw[0]);
      open = toNumber(raw[5]);
      high = toNumber(raw[3]);
      low = toNumber(raw[4]);
      close = toNumber(raw[2]);
      volume = toNumber(raw[6]);
      if (time !== null) time *= 1000;
    } else if (venue === "kucoin" && Array.isArray(raw)) {
      // KuCoin rows are [time, open, close, high, low, baseVolume, ...].
      time = toNumber(raw[0]);
      open = toNumber(raw[1]);
      close = toNumber(raw[2]);
      high = toNumber(raw[3]);
      low = toNumber(raw[4]);
      volume = toNumber(raw[5]);
      if (time !== null) time *= 1000;
    } else if (venue === "htx") {
      const row = raw as {
        id?: unknown;
        open?: unknown;
        high?: unknown;
        low?: unknown;
        close?: unknown;
        amount?: unknown;
      };
      time = toNumber(row.id);
      open = toNumber(row.open);
      high = toNumber(row.high);
      low = toNumber(row.low);
      close = toNumber(row.close);
      volume = toNumber(row.amount);
      if (time !== null) time *= 1000;
    }
    if (
      time === null ||
      open === null ||
      high === null ||
      low === null ||
      close === null ||
      time + interval > now ||
      low > high ||
      low > Math.min(open, close) ||
      high < Math.max(open, close)
    ) {
      continue;
    }
    candles.push({
      time,
      open,
      high,
      low,
      close,
      ...(volume !== null && volume >= 0 ? { volume } : {}),
    });
  }
  const byTime = new Map<number, LcWaitingObCandle>();
  for (const candle of candles) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Merge independently fetched pages, replacing duplicate candle timestamps. */
export function mergeLcAutoRangeHistoryPages(
  cached: readonly LcWaitingObCandle[],
  pages: readonly (readonly LcWaitingObCandle[])[],
  limit: number,
): LcWaitingObCandle[] {
  const byTime = new Map<number, LcWaitingObCandle>();
  for (const candle of cached) byTime.set(candle.time, candle);
  for (const page of pages) {
    for (const candle of page) byTime.set(candle.time, candle);
  }
  return [...byTime.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-limit);
}

/**
 * The order-block state machines are path-dependent: a zone drawn weeks ago
 * stays live until superseded. Replay needs deep history (BingX MELANIA 4H
 * matched TradingView only with ~1000 bars, not 300).
 */
const LC_OB_HISTORY_BARS = 1000;

function urlFor(
  venue: LcObVenue,
  instrumentId: string,
  timeframe: LcObTimeframe,
  cursor?: number,
  limit = 300,
): string {
  switch (venue) {
    case "bingx": {
      const interval = timeframe === "1h" ? "1h" : "4h";
      const endTime = cursor === undefined ? "" : `&endTime=${cursor}`;
      return `https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=${encodeURIComponent(instrumentId)}&interval=${interval}&limit=${limit}${endTime}`;
    }
    case "binance": {
      const interval = timeframe === "1h" ? "1h" : "4h";
      const endTime = cursor === undefined ? "" : `&endTime=${cursor}`;
      return `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(instrumentId)}&interval=${interval}&limit=${limit}${endTime}`;
    }
    case "okx": {
      const bar = timeframe === "1h" ? "1H" : "4H";
      const after = cursor === undefined ? "" : `&after=${cursor}`;
      return `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instrumentId)}&bar=${bar}&limit=${Math.min(limit, 100)}${after}`;
    }
    case "bybit": {
      const interval = timeframe === "1h" ? "60" : "240";
      const end = cursor === undefined ? "" : `&end=${cursor}`;
      return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(instrumentId)}&interval=${interval}&limit=${Math.min(limit, 1000)}${end}`;
    }
    case "gate": {
      const interval = timeframe === "1h" ? "1h" : "4h";
      const before =
        cursor === undefined ? "" : `&to=${Math.floor(cursor / 1000)}`;
      return `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${encodeURIComponent(instrumentId)}&interval=${interval}&limit=${Math.min(limit, 1000)}${before}`;
    }
    case "kucoin": {
      const type = timeframe === "1h" ? "1hour" : "4hour";
      const intervalSeconds = TF_MS[timeframe] / 1000;
      const endAt = cursor ?? Math.floor(Date.now() / 1000);
      const startAt = endAt - intervalSeconds * 150;
      return `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${encodeURIComponent(instrumentId)}&startAt=${startAt}&endAt=${endAt}`;
    }
    case "mexc": {
      const interval = timeframe === "1h" ? "60m" : "4h";
      const endTime = cursor === undefined ? "" : `&endTime=${cursor}`;
      return `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(instrumentId)}&interval=${interval}&limit=${Math.min(limit, 1000)}${endTime}`;
    }
    case "bitget": {
      const granularity = timeframe === "1h" ? "1h" : "4h";
      const endTime = cursor === undefined ? "" : `&endTime=${cursor}`;
      return `https://api.bitget.com/api/v2/spot/market/candles?symbol=${encodeURIComponent(instrumentId)}&granularity=${granularity}&limit=${Math.min(limit, 1000)}${endTime}`;
    }
    case "htx": {
      const period = timeframe === "1h" ? "60min" : "4hour";
      return `https://api.huobi.pro/market/history/kline?period=${period}&size=${Math.min(limit, 2000)}&symbol=${encodeURIComponent(instrumentId)}`;
    }
    case "kraken": {
      const interval = timeframe === "1h" ? 60 : 240;
      const since =
        cursor === undefined ? "" : `&since=${Math.floor(cursor / 1000)}`;
      return `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(instrumentId)}&interval=${interval}${since}`;
    }
  }
}

async function fetchJson(
  url: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  const timeoutSignal = AbortSignal.timeout(4_000);
  const response = await marketFetch(
    url,
    {
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    },
    { label, priority: "background" },
  );
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // The caller records an explicit malformed/HTTP error below.
  }
  return {
    status: response.status,
    data,
  };
}

function parseResponse(
  venue: LcObVenue,
  value: unknown,
  instrumentId: string,
): unknown[] {
  if (venue === "bingx") {
    const response = value as { code?: number; data?: unknown[] };
    if (response.code !== 0 || !Array.isArray(response.data)) return [];
    return response.data;
  }
  if (venue === "binance") return Array.isArray(value) ? value : [];
  if (venue === "okx") {
    const response = value as { code?: string; data?: unknown[] };
    return response.code === "0" && Array.isArray(response.data)
      ? response.data
      : [];
  }
  if (venue === "bybit") {
    const response = value as {
      retCode?: number;
      result?: { list?: unknown[] };
    };
    return response.retCode === 0 && Array.isArray(response.result?.list)
      ? response.result.list
      : [];
  }
  if (venue === "gate" || venue === "mexc") {
    return Array.isArray(value) ? value : [];
  }
  if (venue === "kucoin") {
    const response = value as { code?: string; data?: unknown[] };
    return response.code === "200000" && Array.isArray(response.data)
      ? response.data
      : [];
  }
  if (venue === "bitget") {
    const response = value as { code?: string; data?: unknown[] };
    return response.code === "00000" && Array.isArray(response.data)
      ? response.data
      : [];
  }
  if (venue === "htx") {
    const response = value as { status?: string; data?: unknown[] };
    return response.status === "ok" && Array.isArray(response.data)
      ? response.data
      : [];
  }
  const response = value as {
    error?: unknown[];
    result?: Record<string, unknown>;
  };
  const candles = response.result?.[instrumentId];
  return Array.isArray(candles) &&
    (!response.error || response.error.length === 0)
    ? candles
    : [];
}

function providerFailureReason(
  venue: LcObVenue,
  status: number,
  value: unknown,
): string | null {
  if (status === 403 || status === 451) return "geo-blocked";
  const response =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const error = response.error;
  const message = [
    response.msg,
    response.message,
    response.retMsg,
    response["err-msg"],
    response.err_msg,
    ...(Array.isArray(error) ? error : [error]),
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const code = String(
    response.code ??
      response.retCode ??
      response["err-code"] ??
      response.err_code ??
      "",
  ).toLowerCase();
  if (
    /country|region|restricted location|geoblock|geo.?block|cloudfront distribution.*block|access denied/.test(
      message,
    )
  ) {
    return "geo-blocked";
  }
  if (
    /invalid symbol|unknown (asset )?pair|instrument.{0,20}(does not exist|not found)|symbol.{0,20}(does not exist|not found)|currency.?pair.{0,20}(invalid|not found)|parameter.{0,20}does not exist|market.{0,20}(unknown|not found)|unlisted/.test(
      message,
    ) ||
    ["-1121", "40034", "51001"].includes(code) ||
    code === "invalid-symbol"
  ) {
    return "unlisted-instrument";
  }
  if (status < 200 || status >= 300) return `http-${status}`;
  const expectedShape =
    (venue === "bingx" && response.code === 0) ||
    (venue === "binance" && Array.isArray(value)) ||
    (venue === "okx" && response.code === "0") ||
    (venue === "bybit" && response.retCode === 0) ||
    ((venue === "gate" || venue === "mexc") && Array.isArray(value)) ||
    (venue === "kucoin" && response.code === "200000") ||
    (venue === "bitget" && response.code === "00000") ||
    (venue === "htx" && response.status === "ok") ||
    (venue === "kraken" &&
      Array.isArray(response.error) &&
      response.error.length === 0);
  if (expectedShape) return null;
  return message ? "provider-error" : "malformed-response";
}

function circuitOpenReason(venue: LcObVenue, now: number): string | null {
  const circuit = venueFailures.get(venue);
  if (!circuit) return null;
  if (circuit.openUntil > now) {
    return `circuit-open-until-${new Date(circuit.openUntil).toISOString()}`;
  }
  if (circuit.openUntil > 0) venueFailures.delete(venue);
  return null;
}

function recordVenueFailure(
  venue: LcObVenue,
  status: number,
  reason: string,
  now: number,
): void {
  if (reason.includes("cycle ended")) return;
  if (reason === "geo-blocked" || status === 403 || status === 451) {
    venueFailures.set(venue, {
      failures: LC_OB_VENUE_FAILURE_THRESHOLD,
      openUntil: now + LC_OB_VENUE_CIRCUIT_BREAKER_MS,
    });
    return;
  }
  if (
    (status >= 200 && status < 400) ||
    (status >= 400 && status < 500 && status !== 429)
  ) {
    venueFailures.delete(venue);
    return;
  }
  if (!(status === 0 || status === 429 || status >= 500)) return;
  const failures = (venueFailures.get(venue)?.failures ?? 0) + 1;
  venueFailures.set(venue, {
    failures,
    openUntil:
      failures >= LC_OB_VENUE_FAILURE_THRESHOLD
        ? now + LC_OB_VENUE_CIRCUIT_BREAKER_MS
        : 0,
  });
}

export async function fetchLcObCandles(
  venue: LcObVenue,
  symbol: string,
  timeframe: LcObTimeframe,
  now = Date.now(),
): Promise<LcObFetchResult> {
  const instrumentId = lcObInstrumentId(venue, symbol);
  if (!instrumentId) {
    return {
      usable: false,
      venue,
      instrumentId: symbol,
      timeframe,
      reason: "unsupported-symbol-format",
    };
  }
  const key = `${venue}:${instrumentId}:${timeframe}`;
  const cached = cache.get(key);
  if (cached && now - cached.fetchedAt < cacheTtlMs[timeframe]) {
    return {
      usable: true,
      series: {
        venue,
        instrumentId,
        timeframe,
        candles: cached.candles,
        fetchedAt: cached.fetchedAt,
      },
    };
  }
  const circuitReason = circuitOpenReason(venue, now);
  if (circuitReason) {
    return {
      usable: false,
      venue,
      instrumentId,
      timeframe,
      reason: circuitReason,
    };
  }
  try {
    let rows: unknown[] = [];
    if (venue === "okx" || venue === "kucoin") {
      let cursor = venue === "kucoin" ? Math.floor(now / 1000) : undefined;
      for (
        let page = 0;
        page < (venue === "okx" ? 10 : 7) && rows.length < LC_OB_HISTORY_BARS;
        page += 1
      ) {
        const response = await fetchJson(
          urlFor(venue, instrumentId, timeframe, cursor),
          `lc-ob:${venue}:${timeframe}:page-${page + 1}`,
        );
        const failure = providerFailureReason(
          venue,
          response.status,
          response.data,
        );
        if (failure) {
          if (rows.length > 0) break;
          recordVenueFailure(venue, response.status, failure, now);
          return {
            usable: false,
            venue,
            instrumentId,
            timeframe,
            reason: failure,
          };
        }
        const pageRows = parseResponse(venue, response.data, instrumentId);
        if (pageRows.length === 0) break;
        rows.push(...pageRows);
        const oldest = pageRows.reduce<number>((minimum, row) => {
          if (!Array.isArray(row)) return minimum;
          const start = toNumber(row[0]);
          return start === null ? minimum : Math.min(minimum, start);
        }, Infinity);
        if (!Number.isFinite(oldest) || oldest <= 0) break;
        if (venue === "okx") {
          cursor = oldest;
        } else {
          cursor = oldest - 1;
        }
      }
    } else {
      const response = await fetchJson(
        urlFor(venue, instrumentId, timeframe, undefined, LC_OB_HISTORY_BARS),
        `lc-ob:${venue}:${timeframe}`,
      );
      const failure = providerFailureReason(
        venue,
        response.status,
        response.data,
      );
      if (failure) {
        recordVenueFailure(venue, response.status, failure, now);
        return {
          usable: false,
          venue,
          instrumentId,
          timeframe,
          reason: failure,
        };
      }
      rows = parseResponse(venue, response.data, instrumentId);
    }
    const candles = normalizeLcObRows(rows, venue, timeframe, now);
    if (candles.length < 200) {
      venueFailures.delete(venue);
      return {
        usable: false,
        venue,
        instrumentId,
        timeframe,
        reason: `insufficient-closed-bars-${candles.length}`,
      };
    }
    venueFailures.delete(venue);
    cache.set(key, { fetchedAt: now, candles });
    return {
      usable: true,
      series: { venue, instrumentId, timeframe, candles, fetchedAt: now },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "fetch-failed";
    recordVenueFailure(venue, 0, reason, Date.now());
    return {
      usable: false,
      venue,
      instrumentId,
      timeframe,
      reason,
    };
  }
}

function rowTimestampMs(raw: unknown, venue: LcObVenue): number | null {
  const value =
    Array.isArray(raw) && raw.length > 0
      ? toNumber(raw[0])
      : venue === "htx" && typeof raw === "object" && raw !== null
        ? toNumber((raw as { id?: unknown }).id)
        : null;
  if (value === null) return null;
  return venue === "gate" ||
    venue === "kucoin" ||
    venue === "htx" ||
    venue === "kraken"
    ? value * 1000
    : value;
}

async function fetchAutoRangeTimeframe(
  venue: LcObVenue,
  instrumentId: string,
  timeframe: LcObTimeframe,
  requiredBars: number,
  now: number,
  signal: AbortSignal,
): Promise<LcAutoRangeHistoryCandle[]> {
  const cacheKey = `${venue}:${instrumentId}:${timeframe}`;
  const cached = autoRangeHistoryCache.get(cacheKey);
  const cachedHistory = cached?.candles.filter(
    (candle): candle is LcAutoRangeHistoryCandle =>
      typeof candle.volume === "number" && Number.isFinite(candle.volume),
  );
  const cacheTtl =
    timeframe === "1h" ? 5 * 60_000 : AUTO_RANGE_HISTORY_CACHE_TTL_MS;
  const isCachedHistoryReady = (cachedHistory?.length ?? 0) >= requiredBars;
  if (cached && isCachedHistoryReady && now - cached.fetchedAt < cacheTtl) {
    return cachedHistory!;
  }

  let candlesByTime = new Map<number, LcWaitingObCandle>(
    (cachedHistory ?? []).map((candle) => [candle.time, candle]),
  );
  const receivedPages: LcWaitingObCandle[][] = [];
  const minimum = isCachedHistoryReady ? cachedHistory!.length : requiredBars;
  const pageLimit =
    venue === "bingx"
      ? 300
      : venue === "okx"
        ? 100
        : venue === "kucoin"
          ? 150
          : venue === "kraken"
            ? 720
            : venue === "htx"
              ? 2_000
              : 1_000;
  const limit = isCachedHistoryReady
    ? Math.min(pageLimit, timeframe === "1h" ? 12 : 24)
    : Math.min(pageLimit, requiredBars + 1);
  let cursor: number | undefined;
  if (venue === "kraken") {
    cursor = cached
      ? (cached.candles.at(-1)?.time ?? now) + TF_MS[timeframe]
      : now - (requiredBars + 2) * TF_MS[timeframe];
  } else if (cached && !isCachedHistoryReady) {
    const oldest = cached.candles[0]?.time;
    if (oldest !== undefined) {
      cursor =
        venue === "okx"
          ? oldest
          : venue === "kucoin"
            ? Math.floor(oldest / 1000) - 1
            : oldest - 1;
    }
  }
  const maxPages = isCachedHistoryReady ? 1 : AUTO_RANGE_HISTORY_PAGE_LIMIT;
  let reachedHistoryBoundary = false;
  for (let page = 0; page < maxPages && !signal.aborted; page += 1) {
    const response = await fetchJson(
      urlFor(venue, instrumentId, timeframe, cursor, limit),
      `auto-range-history:${venue}:${timeframe}:page-${page + 1}`,
      signal,
    );
    const failure = providerFailureReason(
      venue,
      response.status,
      response.data,
    );
    if (failure) {
      throw new Error(failure);
    }
    const pageRows = parseResponse(venue, response.data, instrumentId);
    if (pageRows.length === 0) {
      reachedHistoryBoundary = true;
      break;
    }
    const pageCandles = normalizeLcObRows(
      pageRows,
      venue,
      timeframe,
      now,
    ).filter(
      (candle): candle is LcAutoRangeHistoryCandle =>
        typeof candle.volume === "number" && Number.isFinite(candle.volume),
    );
    receivedPages.push(pageCandles);
    const previousSize = candlesByTime.size;
    for (const candle of pageCandles) candlesByTime.set(candle.time, candle);
    const candles = [...candlesByTime.values()].sort(
      (left, right) => left.time - right.time,
    );
    candlesByTime = new Map(
      candles
        .slice(-Math.max(requiredBars + 100, minimum))
        .map((candle) => [candle.time, candle]),
    );
    if (candlesByTime.size === previousSize && page > 0) {
      reachedHistoryBoundary = true;
      break;
    }
    if (isCachedHistoryReady || candlesByTime.size >= requiredBars) break;
    if (venue === "htx") break;

    const pageTimestamps = pageRows
      .map((row) => rowTimestampMs(row, venue))
      .filter((time): time is number => time !== null && Number.isFinite(time));
    if (pageTimestamps.length === 0) break;
    if (venue === "kraken") {
      const newest = Math.max(...pageTimestamps);
      cursor = newest + TF_MS[timeframe];
    } else {
      const oldest = Math.min(...pageTimestamps);
      cursor =
        venue === "okx"
          ? oldest
          : venue === "kucoin"
            ? Math.floor(oldest / 1000) - 1
            : oldest - 1;
    }
  }
  if (signal.aborted)
    throw signal.reason ?? new Error("History fetch cancelled");

  const candles = mergeLcAutoRangeHistoryPages(
    cachedHistory ?? [],
    receivedPages,
    Math.max(requiredBars + 100, minimum),
  );
  const historyCandles = candles.filter(
    (candle): candle is LcAutoRangeHistoryCandle =>
      typeof candle.volume === "number" && Number.isFinite(candle.volume),
  );
  if (historyCandles.length < requiredBars) {
    autoRangeHistoryCache.set(cacheKey, {
      fetchedAt: now,
      candles: historyCandles,
    });
    throw new Error(
      reachedHistoryBoundary
        ? `insufficient-closed-bars-${historyCandles.length}`
        : `history-pages-pending-bars-${historyCandles.length}`,
    );
  }
  autoRangeHistoryCache.set(cacheKey, {
    fetchedAt: now,
    candles: historyCandles,
  });
  while (autoRangeHistoryCache.size > 2_000) {
    const oldest = autoRangeHistoryCache.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    autoRangeHistoryCache.delete(oldest);
  }
  return historyCandles;
}

/**
 * Deep, bounded, paginated OHLC history for independent Auto Range evaluation.
 * A venue's own 4H and 1H candles remain separate; BingX's production Range
 * history is supplied by the scanner's existing futures queue.
 */
export async function fetchLcAutoRangeVenueHistory(
  symbol: string,
  venue: LcObVenue,
  now = Date.now(),
  signal: AbortSignal = AbortSignal.timeout(60_000),
): Promise<LcAutoRangeVenueHistoryResult> {
  const instrumentId = lcObInstrumentId(venue, symbol);
  if (!instrumentId) {
    return {
      usable: false,
      venue,
      instrumentId: symbol,
      reason: "unsupported-symbol-format",
    };
  }
  try {
    const fourHour = await fetchAutoRangeTimeframe(
      venue,
      instrumentId,
      "4h",
      AUTO_RANGE_HISTORY_MIN_BARS,
      now,
      signal,
    );
    const oneHour = await fetchAutoRangeTimeframe(
      venue,
      instrumentId,
      "1h",
      26,
      now,
      signal,
    );
    venueFailures.delete(venue);
    return {
      usable: true,
      history: {
        venue,
        instrumentId,
        fourHour,
        oneHour,
        fetchedAt: now,
      },
    };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "history-fetch-failed";
    if (!signal.aborted) {
      recordVenueFailure(venue, 0, reason, now);
    }
    return { usable: false, venue, instrumentId, reason };
  }
}

/** Evaluate no more than four venues at a time, with both TFs per venue. */
export async function fetchLcObVenueCandles(
  symbol: string,
  timeframes: readonly LcObTimeframe[] = ["1h", "4h"],
  venues: readonly LcObVenue[] = LC_OB_SPOT_VENUES,
  now = Date.now(),
): Promise<LcObFetchResult[]> {
  const results: LcObFetchResult[] = [];
  for (let start = 0; start < venues.length; start += LC_OB_VENUE_BATCH_SIZE) {
    const venueBatch = venues.slice(start, start + LC_OB_VENUE_BATCH_SIZE);
    const batchResults = await Promise.all(
      venueBatch.flatMap((venue) =>
        timeframes.map((timeframe) =>
          fetchLcObCandles(venue, symbol, timeframe, now),
        ),
      ),
    );
    results.push(...batchResults);
  }
  return results;
}

const LC_IMB_MIN_GAP_PCT = 0.4;
const LC_IMB_MAX_PER_SERIES = 3;

/**
 * Bullish imbalance (fair value gap): candle i low above candle i-2 high.
 * Kept only while fresh (no later low reached the gap midpoint). Entry is
 * allowed from the midpoint, see lcObZoneTrigger. Not an order block.
 */
export function detectLcImbalanceZones(series: LcObVenueCandles): LcObZone[] {
  const c = series.candles;
  const zones: LcObZone[] = [];
  for (let i = 2; i < c.length; i++) {
    const low = c[i - 2]!.high;
    const high = c[i]!.low;
    if (!(high > low) || (high - low) / high < LC_IMB_MIN_GAP_PCT / 100) {
      continue;
    }
    const mid = (low + high) / 2;
    let fresh = true;
    for (let j = i + 1; j < c.length; j++) {
      if (c[j]!.low <= mid) {
        fresh = false;
        break;
      }
    }
    if (!fresh) continue;
    zones.push({
      venue: series.venue,
      instrumentId: series.instrumentId,
      timeframe: series.timeframe,
      detector: "IMB",
      low,
      high,
      confirmedAt: c[i]!.time + TF_MS[series.timeframe],
      fetchedAt: series.fetchedAt,
      detectorVersion: "bullish FVG v1: gap>=0.4%, fresh, entry from midpoint",
    });
  }
  return zones.slice(-LC_IMB_MAX_PER_SERIES);
}

/** Price level that releases a wait: OB top, or the midpoint of an imbalance. */
export function lcObZoneTrigger(zone: {
  detector: LcObDetector;
  low: number;
  high: number;
}): number {
  return zone.detector === "IMB" ? (zone.low + zone.high) / 2 : zone.high;
}

export function detectLcObZones(
  series: LcObVenueCandles,
  entryPrice: number,
): LcObZone[] {
  const lux = detectLuxAlgoDemandZones(series.candles, entryPrice)
    .zones.filter((zone) => zone.bias === "bullish")
    .map(
      (zone): LcObZone => ({
        venue: series.venue,
        instrumentId: series.instrumentId,
        timeframe: series.timeframe,
        detector: "LuxAlgo",
        low: zone.low,
        high: zone.high,
        confirmedAt: zone.detectedAt + TF_MS[series.timeframe],
        fetchedAt: series.fetchedAt,
        detectorVersion:
          "LuxAlgo internal default causal replay; approximation not Pine-verified",
      }),
    );
  const luxSwing = detectLuxAlgoSwingDemandZones(series.candles).map(
    (zone): LcObZone => ({
      venue: series.venue,
      instrumentId: series.instrumentId,
      timeframe: series.timeframe,
      detector: "LuxAlgo",
      low: Math.min(zone.low, zone.high),
      high: Math.max(zone.low, zone.high),
      confirmedAt: zone.detectedAt + TF_MS[series.timeframe],
      fetchedAt: series.fetchedAt,
      detectorVersion:
        "LuxAlgo swing(50) order block causal replay; approximation not Pine-verified",
    }),
  );
  const imb = detectLcImbalanceZones(series);
  return strictlyLowerLcObZones([...lux, ...luxSwing, ...imb], entryPrice);
}

export function strictlyLowerLcObZones(
  zones: readonly LcObZone[],
  entryPrice: number,
): LcObZone[] {
  return zones.filter((zone) => zone.high < entryPrice);
}

export function unionLcObSeriesZones(
  results: readonly LcObFetchResult[],
  entryPrice: number,
  detect: (series: LcObVenueCandles) => LcObZone[],
): LcObZone[] {
  return results
    .filter(
      (result): result is Extract<LcObFetchResult, { usable: true }> =>
        result.usable,
    )
    .flatMap(({ series }) =>
      strictlyLowerLcObZones(detect(series), entryPrice),
    );
}

export function selectWaitingZones(
  seriesResults: readonly LcObFetchResult[],
  entryPrice: number,
  options: { requireUntouched?: boolean } = {},
): { zones: LcObZone[]; usableSeries: number; unavailable: string[] } {
  const usable = seriesResults.filter(
    (result): result is Extract<LcObFetchResult, { usable: true }> =>
      result.usable,
  );
  const detected = unionLcObSeriesZones(seriesResults, entryPrice, (series) =>
    detectLcObZones(series, entryPrice),
  );
  // Re-detection after a wait began must not adopt a zone that price already
  // reached (and left) since it was confirmed: that touch is behind us.
  const zones = options.requireUntouched
    ? detected.filter((zone) => {
        const oneHour = usable.find(
          ({ series }) =>
            series.venue === zone.venue && series.timeframe === "1h",
        )?.series;
        if (!oneHour) return false;
        const trigger = lcObZoneTrigger(zone);
        return !oneHour.candles.some(
          (candle) =>
            candle.time + TF_MS["1h"] > zone.confirmedAt &&
            candle.low <= trigger,
        );
      })
    : detected;
  return {
    zones,
    usableSeries: usable.length,
    unavailable: seriesResults
      .filter((result) => !result.usable)
      .map(
        (result) =>
          `${result.venue}/${result.instrumentId}/${result.timeframe}:${result.reason}`,
      ),
  };
}

export function shouldReleaseLcObWait(
  price: number,
  zoneHigh: number,
): boolean {
  const threshold = zoneHigh * (1 + LC_OB_WAIT_TRIGGER_TOLERANCE_PCT / 100);
  return Number.isFinite(price) && price <= threshold;
}

export function isLcObZoneMitigated(
  zone: LcObZone,
  closedOneHourCandles: readonly LcWaitingObCandle[],
): boolean {
  return closedOneHourCandles.some(
    (candle) =>
      candle.time + TF_MS["1h"] > zone.confirmedAt && candle.close < zone.low,
  );
}

export function lcObWaitDeadline(detectedAt: number): number {
  return detectedAt + LC_OB_WAIT_WINDOW_MS;
}

export function lcObWaitLeaseReturnStatus(
  expiresAt: number,
  now: number,
): "waiting" | "expired" {
  return expiresAt <= now ? "expired" : "waiting";
}

/** Guard plus injected atomic lease update, shared by production and CAS tests. */
export async function claimLcObWaitRelease(input: {
  status: string;
  expiresAt: number;
  leaseUntil: number | null;
  now: number;
  compareAndSet: () => Promise<boolean>;
}): Promise<boolean> {
  if (
    input.expiresAt <= input.now ||
    (input.status === "releasing" &&
      input.leaseUntil !== null &&
      input.leaseUntil > input.now) ||
    (input.status !== "waiting" &&
      input.status !== "invalidated" &&
      input.status !== "releasing")
  ) {
    return false;
  }
  return input.compareAndSet();
}
