import crypto from "crypto";
import { rememberBingxKlines } from "./bingx-bars-store.js";
import { gunzipSync } from "node:zlib";
import {
  getMarketRequestSignal,
  runMarketRequest,
} from "./marketRequestBudget.js";

const BINGX_BASE_URL = "https://open-api.bingx.com";
const BINGX_SWAP_MARKET_WS_URL = "wss://open-api-swap.bingx.com/swap-market";

function sign(params: Record<string, string | number>, secret: string): string {
  const queryString = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

function buildSignedParams(
  params: Record<string, string | number>,
  secret: string,
): string {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  const signature = sign(allParams, secret);
  const queryString = Object.entries(allParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${queryString}&signature=${signature}`;
}

async function bingxGet(
  path: string,
  params: Record<string, string | number> = {},
  signed = false,
): Promise<unknown> {
  const apiKey = process.env.BINGX_API_KEY;
  const apiSecret = process.env.BINGX_API_SECRET;

  let qs: string;
  const headers: Record<string, string> = {
    "X-SOURCE-KEY": "AlphaScanner",
  };

  if (signed) {
    if (!apiKey || !apiSecret)
      throw new Error("BINGX_API_KEY and BINGX_API_SECRET are required");
    headers["X-BX-APIKEY"] = apiKey;
    qs = buildSignedParams(params, apiSecret);
  } else {
    qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
  }

  const url = `${BINGX_BASE_URL}${path}${qs ? "?" + qs : ""}`;

  async function attempt(): Promise<unknown> {
    return runMarketRequest(`bingx:${path}`, async () => {
      const res = await fetch(url, {
        headers,
        // The cycle abort signal is composed with this endpoint-level timeout.
        signal: getMarketRequestSignal(15_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`BingX API error ${res.status}: ${text}`);
      }
      return res.json();
    });
  }

  try {
    return await attempt();
  } catch (err) {
    const isNetworkErr =
      err instanceof TypeError &&
      (err.message.includes("other side closed") ||
        err.message.includes("ECONNRESET") ||
        err.message.includes("fetch failed"));
    if (isNetworkErr) {
      await new Promise<void>((r) => setTimeout(r, 200));
      return attempt();
    }
    throw err;
  }
}

export interface BingXTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  volume: string;
  quoteVolume: string;
  // Available on some BingX endpoints
  bidPrice?: string;
  askPrice?: string;
  openInterestSize?: string; // OI in base asset (if returned by ticker)
}

export interface BingXKline {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  time: number;
}

export interface BingXOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface BingXFundingRate {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
  markPrice: string;
  indexPrice?: string;
}

export async function getFutureTickers(): Promise<BingXTicker[]> {
  const data = (await bingxGet("/openApi/swap/v2/quote/ticker")) as {
    code?: number;
    msg?: string;
    data: BingXTicker[];
  };
  // BingX may return HTTP 200 with a non-zero error code (e.g. rate-limit, temporary outage).
  // Treat any non-zero code as a hard error so callers can retry or abort safely.
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(
      `BingX ticker API non-zero code: ${data.code} — ${data.msg ?? ""}`,
    );
  }
  return data.data ?? [];
}

export async function getFutureTicker(
  symbol: string,
): Promise<BingXTicker | null> {
  try {
    const data = (await bingxGet("/openApi/swap/v2/quote/ticker", {
      symbol,
    })) as {
      data: BingXTicker | BingXTicker[];
    };
    const result = data.data;
    if (!result) return null;
    return Array.isArray(result) ? (result[0] ?? null) : result;
  } catch {
    return null;
  }
}

export type BingXLastPriceUpdate = {
  symbol: string;
  price: number;
  /** Captured synchronously when the WebSocket emits the frame. */
  observedAt: Date;
  /** Exchange event time when supplied; used as an additional stale-frame fence. */
  exchangeAt: Date | null;
};

type BingXLastPriceStreamOptions = {
  onPrice: (update: BingXLastPriceUpdate) => void | Promise<void>;
  onStatus?: (
    status: "connected" | "disconnected" | "reconnecting",
    detail?: string,
  ) => void;
};

export type BingXLastPriceStream = {
  setSymbols: (symbols: Iterable<string>) => void;
  stop: () => void;
};

function readPrice(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readTimestamp(value: unknown): Date | null {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const millis = raw < 100_000_000_000 ? raw * 1000 : raw;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Normalizes BingX's public `symbol@lastPrice` payload. The exchange has used
 * both `price` and compact ticker field names in stream payloads, so accept
 * either without treating a malformed update as a position price.
 */
export function parseBingXLastPriceMessage(
  message: unknown,
  observedAt = new Date(),
): BingXLastPriceUpdate | null {
  if (!message || typeof message !== "object") return null;
  const envelope = message as {
    dataType?: unknown;
    data?: unknown;
  };
  if (
    typeof envelope.dataType !== "string" ||
    !envelope.dataType.endsWith("@lastPrice")
  ) {
    return null;
  }
  const symbol = envelope.dataType.slice(0, -"@lastPrice".length);
  if (!symbol) return null;

  const data =
    envelope.data && typeof envelope.data === "object"
      ? (envelope.data as Record<string, unknown>)
      : {};
  const price = readPrice(
    data.price ?? data.lastPrice ?? data.p ?? data.c ?? envelope.data,
  );
  if (price == null) return null;

  return {
    symbol,
    price,
    observedAt,
    exchangeAt: readTimestamp(
      data.eventTime ?? data.timestamp ?? data.time ?? data.E ?? data.T,
    ),
  };
}

async function decodeBingXWebSocketPayload(
  data: unknown,
): Promise<string | null> {
  if (typeof data === "string") return data;
  const bytes =
    data instanceof ArrayBuffer
      ? Buffer.from(data)
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : typeof Blob !== "undefined" && data instanceof Blob
          ? Buffer.from(await data.arrayBuffer())
          : null;
  if (!bytes) return null;
  try {
    return (
      bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes
    ).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Public realtime last-price stream for a small, changing symbol set.
 *
 * It deliberately handles only market transport. The watcher owns lifecycle
 * state and makes the atomic close decision, so a reconnect can never replay
 * an old candle low as a new trailing-stop crossing.
 */
export function createBingXLastPriceStream(
  options: BingXLastPriceStreamOptions,
): BingXLastPriceStream {
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1_000;
  const desiredSymbols = new Set<string>();
  const subscribedSymbols = new Set<string>();

  const send = (reqType: "sub" | "unsub", symbol: string) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        id: `trailing-last-price:${symbol}:${Date.now()}`,
        reqType,
        dataType: `${symbol}@lastPrice`,
      }),
    );
  };

  const syncSubscriptions = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    for (const symbol of subscribedSymbols) {
      if (!desiredSymbols.has(symbol)) {
        send("unsub", symbol);
        subscribedSymbols.delete(symbol);
      }
    }
    for (const symbol of desiredSymbols) {
      if (!subscribedSymbols.has(symbol)) {
        send("sub", symbol);
        subscribedSymbols.add(symbol);
      }
    }
  };

  const scheduleReconnect = (detail?: string) => {
    if (stopped || desiredSymbols.size === 0 || reconnectTimer) return;
    const delayMs = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    options.onStatus?.("reconnecting", detail);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
  };

  const connect = () => {
    if (
      stopped ||
      desiredSymbols.size === 0 ||
      (socket &&
        (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }
    try {
      const nextSocket = new WebSocket(BINGX_SWAP_MARKET_WS_URL);
      nextSocket.binaryType = "arraybuffer";
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (socket !== nextSocket || stopped) return;
        reconnectDelayMs = 1_000;
        subscribedSymbols.clear();
        syncSubscriptions();
        options.onStatus?.("connected");
      });
      nextSocket.addEventListener("message", (event) => {
        // Capture this before Blob conversion or GZIP decompression. Otherwise a
        // frame queued before a new trailing level was armed could be labelled
        // with the later decode time and incorrectly pass the arming fence.
        const receivedAt = new Date();
        void (async () => {
          if (socket !== nextSocket || stopped) return;
          const raw = await decodeBingXWebSocketPayload(event.data);
          if (!raw || socket !== nextSocket || stopped) return;
          if (raw === "Ping") {
            if (nextSocket.readyState === WebSocket.OPEN) {
              nextSocket.send("Pong");
            }
            return;
          }
          try {
            const update = parseBingXLastPriceMessage(
              JSON.parse(raw),
              receivedAt,
            );
            if (update && desiredSymbols.has(update.symbol)) {
              await options.onPrice(update);
            }
          } catch {
            // A malformed public market message must not tear down protection.
          }
        })();
      });
      nextSocket.addEventListener("close", (event) => {
        if (socket !== nextSocket) return;
        socket = null;
        subscribedSymbols.clear();
        options.onStatus?.("disconnected", `${event.code}:${event.reason}`);
        scheduleReconnect(`${event.code}:${event.reason}`);
      });
      nextSocket.addEventListener("error", () => {
        // The close event owns reconnect scheduling. Browser-compatible
        // WebSocket errors intentionally do not expose a useful Error object.
      });
    } catch (err) {
      scheduleReconnect(err instanceof Error ? err.message : "connect failed");
    }
  };

  return {
    setSymbols(symbols) {
      desiredSymbols.clear();
      for (const symbol of symbols) {
        if (typeof symbol === "string" && symbol.length > 0) {
          desiredSymbols.add(symbol);
        }
      }
      if (desiredSymbols.size === 0) {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        for (const symbol of subscribedSymbols) send("unsub", symbol);
        subscribedSymbols.clear();
        return;
      }
      if (socket?.readyState === WebSocket.OPEN) {
        syncSubscriptions();
      } else {
        connect();
      }
    },
    stop() {
      stopped = true;
      desiredSymbols.clear();
      subscribedSymbols.clear();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
  };
}

export async function getKlines(
  symbol: string,
  interval = "15m",
  limit = 288,
  startTime?: number,
  endTime?: number,
  options: { strictPayload?: boolean } = {},
): Promise<BingXKline[]> {
  const params: Record<string, string | number> = { symbol, interval, limit };
  if (startTime !== undefined) params.startTime = startTime;
  if (endTime !== undefined) params.endTime = endTime;
  const data = (await bingxGet("/openApi/swap/v3/quote/klines", params)) as {
    data?: unknown;
  };
  // BingX v3 klines API returns candles newest-first (descending by time).
  // All downstream code assumes ascending order (oldest → newest, current = last element),
  // so we normalize here once instead of fixing every call site.
  // Guard: API occasionally returns non-array (error object, null) — Array.isArray prevents
  // "klines.slice is not a function" crash that skips the token for the whole cycle.
  const klines = parseBingxKlinesPayload(data, options.strictPayload);
  const sorted = klines.slice().sort((a, b) => a.time - b.time);
  // Share the scanner's own latest-window loads with other consumers.
  if (startTime === undefined && endTime === undefined) {
    rememberBingxKlines(symbol, interval, sorted);
  }
  return sorted;
}

export function parseBingxKlinesPayload(
  payload: { data?: unknown } | null | undefined,
  strictPayload = false,
): BingXKline[] {
  if (!Array.isArray(payload?.data)) {
    if (strictPayload) {
      throw new Error("BingX klines response did not contain a candle array");
    }
    return [];
  }
  return payload.data as BingXKline[];
}

const KLINE_INTERVAL_MS: Record<string, number> = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
};

/**
 * Fetches a bounded historical range in BingX's 1000-candle pages.
 * The caller still decides which candles are closed; this helper only handles
 * pagination and removes duplicate timestamps at page boundaries.
 */
export async function getKlinesRange(
  symbol: string,
  interval: keyof typeof KLINE_INTERVAL_MS,
  startTime: number,
  endTime: number,
  options: { strictPayload?: boolean } = {},
): Promise<BingXKline[]> {
  const step = KLINE_INTERVAL_MS[interval];
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    startTime >= endTime ||
    !step
  ) {
    return [];
  }

  const rows = new Map<number, BingXKline>();
  let cursor = Math.floor(startTime / step) * step;
  const alignedEnd = Math.ceil(endTime / step) * step;
  for (let page = 0; page < 8 && cursor <= alignedEnd; page += 1) {
    const pageEnd = Math.min(alignedEnd, cursor + step * 999);
    const result = await getKlines(
      symbol,
      interval,
      1000,
      cursor,
      pageEnd,
      options,
    );
    for (const row of result) {
      if (row.time >= startTime && row.time <= endTime) rows.set(row.time, row);
    }
    if (result.length === 0) break;
    const lastTime = result[result.length - 1]!.time;
    if (lastTime < cursor) break;
    cursor = lastTime + step;
    if (result.length < 1000 && cursor > pageEnd) break;
  }

  return [...rows.values()].sort((left, right) => left.time - right.time);
}

export async function getOpenInterest(
  symbol: string,
): Promise<BingXOpenInterest | null> {
  try {
    const data = (await bingxGet("/openApi/swap/v2/quote/openInterest", {
      symbol,
    })) as {
      data: BingXOpenInterest;
    };
    return data.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Батч BingX direct OI для списка символов (per-symbol, с семафором).
 * Используется для BingX-exclusive токенов где тикер возвращает openInterest: null.
 * Лимит: BINGX_OI_SEMAPHORE параллельных запросов.
 */
const BINGX_OI_SEMAPHORE = 5;

export async function batchGetBingxDirectOI(
  symbols: string[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (symbols.length === 0) return result;

  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += BINGX_OI_SEMAPHORE) {
    chunks.push(symbols.slice(i, i + BINGX_OI_SEMAPHORE));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (symbol) => {
        try {
          const data = (await bingxGet("/openApi/swap/v2/quote/openInterest", {
            symbol,
          })) as {
            data?: { openInterest: string; symbol: string };
          };
          const raw = data?.data?.openInterest;
          const oi = raw != null ? parseFloat(raw) : NaN;
          result.set(symbol, isFinite(oi) && oi > 0 ? oi : null);
        } catch {
          result.set(symbol, null);
        }
      }),
    );
  }

  return result;
}

export async function getFundingRate(
  symbol: string,
): Promise<BingXFundingRate | null> {
  try {
    const data = (await bingxGet("/openApi/swap/v2/quote/premiumIndex", {
      symbol,
    })) as {
      data: BingXFundingRate;
    };
    return data.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch funding rates for ALL BingX futures symbols in one API call.
 * Omitting the symbol param returns data for every contract.
 * Returns Map<symbol, rawDecimalRate> (e.g. 0.0001 = 0.01%). Empty Map on error.
 */
export async function getAllFundingRates(): Promise<Map<string, number>> {
  try {
    const data = (await bingxGet("/openApi/swap/v2/quote/premiumIndex")) as {
      data: BingXFundingRate | BingXFundingRate[];
    };
    const arr = Array.isArray(data.data)
      ? data.data
      : data.data
        ? [data.data]
        : [];
    const map = new Map<string, number>();
    for (const r of arr) {
      const fr = parseFloat(r.lastFundingRate);
      if (Number.isFinite(fr)) map.set(r.symbol, fr);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function testConnection(): Promise<boolean> {
  try {
    await bingxGet("/openApi/swap/v2/quote/ticker");
    return true;
  } catch {
    return false;
  }
}

// ── Order Book Analysis ───────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;
  qty: number;
  usd: number; // price × qty
}

/** Raw, bounded BingX perpetual depth; not a liquidation map or proof of resting orders between samples. */
export async function getBingXBidSnapshot(symbol: string): Promise<{
  observedAt: string;
  referencePrice: number;
  bids: OrderBookLevel[];
} | null> {
  const url = `${BINGX_BASE_URL}/openApi/swap/v2/quote/depth?symbol=${encodeURIComponent(symbol)}&limit=50`;
  const res = await runMarketRequest(`bingx:depth:${symbol}`, () =>
    fetch(url, {
      headers: { "X-SOURCE-KEY": "AlphaScanner" },
      signal: getMarketRequestSignal(4000),
    }),
  );
  if (!res.ok) return null;
  const observedAt = new Date().toISOString();
  const data = (await res.json()) as {
    code?: number | string;
    data?: { bids?: [string, string][]; asks?: [string, string][] };
  };
  if (data.code != null && Number(data.code) !== 0) return null;
  const asks =
    data.data?.asks
      ?.map(([p]) => Number(p))
      .filter((p) => Number.isFinite(p) && p > 0) ?? [];
  const referencePrice = Math.min(...asks);
  if (!Number.isFinite(referencePrice)) return null;
  const bids = (data.data?.bids ?? [])
    .map(([p, q]) => ({
      price: Number(p),
      qty: Number(q),
      usd: Number(p) * Number(q),
    }))
    .filter(
      (level) =>
        Number.isFinite(level.price) &&
        level.price > 0 &&
        level.price < referencePrice &&
        Number.isFinite(level.qty) &&
        level.qty > 0,
    )
    .sort((a, b) => b.price - a.price)
    .slice(0, 20);
  return { observedAt, referencePrice, bids };
}

export interface OrderBookAnalysis {
  /** Суммарный объём бидов (USD) в топ-N уровнях */
  bidVolumeUsd: number;
  /** Суммарный объём асков (USD) в топ-N уровнях */
  askVolumeUsd: number;
  /** bidVolumeUsd / askVolumeUsd */
  bidAskRatio: number;
  /** Самая крупная стена на биде (USD) */
  largestBidWallUsd: number;
  /** Цена самой крупной bid-стены */
  largestBidWallPrice: number;
  /** Самая крупная bid-стена как % от суммарных бидов */
  largestBidWallPct: number;
  /** Количество уровней с bid > 3× среднего — "кластер стен" */
  bidWallCount: number;
  /** Степень давления: "strong_bull" > 3:1 | "bull" > 1.8:1 | "neutral" | "bear" < 0.6:1 */
  bias: "strong_bull" | "bull" | "neutral" | "bear";
  /** +0..+2 бонус к alpha score */
  scoreBonus: number;
}

/**
 * Fetches order book depth from BingX and computes imbalance metrics.
 * limit=20: достаточно для детекции стен и имбаланса, минимальная нагрузка на API.
 */
export async function getOrderBookAnalysis(
  symbol: string,
  limit = 20,
): Promise<OrderBookAnalysis | null> {
  try {
    const url = `${BINGX_BASE_URL}/openApi/swap/v2/quote/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
    const res = await runMarketRequest(`bingx:depth:${symbol}`, () =>
      fetch(url, {
        headers: { "X-SOURCE-KEY": "AlphaScanner" },
        signal: getMarketRequestSignal(4000),
      }),
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      data?: {
        bids?: [string, string][];
        asks?: [string, string][];
      };
    };

    const rawBids = data.data?.bids ?? [];
    const rawAsks = data.data?.asks ?? [];
    if (rawBids.length === 0 && rawAsks.length === 0) return null;

    // Parse levels
    const bids: OrderBookLevel[] = rawBids.map(([p, q]) => {
      const price = parseFloat(p);
      const qty = parseFloat(q);
      return { price, qty, usd: price * qty };
    });
    const asks: OrderBookLevel[] = rawAsks.map(([p, q]) => {
      const price = parseFloat(p);
      const qty = parseFloat(q);
      return { price, qty, usd: price * qty };
    });

    const bidVolumeUsd = bids.reduce((s, l) => s + l.usd, 0);
    const askVolumeUsd = asks.reduce((s, l) => s + l.usd, 0);
    const bidAskRatio = askVolumeUsd > 0 ? bidVolumeUsd / askVolumeUsd : 0;

    // Bid wall detection: уровни где объём > 3× среднего
    const avgBidUsd = bids.length > 0 ? bidVolumeUsd / bids.length : 0;
    const wallThreshold = avgBidUsd * 3;
    const bidWalls = bids.filter((l) => l.usd >= wallThreshold);

    const largestWall = bids.reduce(
      (best, l) => (l.usd > best.usd ? l : best),
      {
        price: 0,
        qty: 0,
        usd: 0,
      },
    );
    const largestBidWallUsd = largestWall.usd;
    const largestBidWallPrice = largestWall.price;
    const largestBidWallPct =
      bidVolumeUsd > 0 ? (largestBidWallUsd / bidVolumeUsd) * 100 : 0;
    const bidWallCount = bidWalls.length;

    // Bias classification
    const bias: OrderBookAnalysis["bias"] =
      bidAskRatio >= 3.0
        ? "strong_bull"
        : bidAskRatio >= 1.8
          ? "bull"
          : bidAskRatio <= 0.6
            ? "bear"
            : "neutral";

    // Score bonus: только для bullish bias с реальной глубиной стакана (>$5k)
    const scoreBonus =
      bias === "strong_bull" && bidWallCount >= 1 && bidVolumeUsd >= 5000
        ? 2
        : bias === "bull" && bidVolumeUsd >= 3000
          ? 1
          : 0;

    return {
      bidVolumeUsd,
      askVolumeUsd,
      bidAskRatio,
      largestBidWallUsd,
      largestBidWallPrice,
      largestBidWallPct,
      bidWallCount,
      bias,
      scoreBonus,
    };
  } catch {
    return null;
  }
}

export interface CVDResult {
  buyPct: number;
  sellPct: number;
  cvd: number;
  positive: boolean;
  trades: number;
}

export async function fetchCVD(
  symbol: string,
  limit = 2000,
): Promise<CVDResult | null> {
  try {
    const url = `${BINGX_BASE_URL}/openApi/swap/v2/quote/trades?symbol=${encodeURIComponent(symbol)}&limit=${limit}`;
    const res = await runMarketRequest(`bingx:trades:${symbol}`, () =>
      fetch(url, {
        headers: { "X-SOURCE-KEY": "AlphaScanner" },
        signal: getMarketRequestSignal(5000),
      }),
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: Array<{ qty: string; isBuyerMaker: boolean }>;
    };
    const trades = data.data;
    if (!trades || trades.length === 0) return null;

    let buyVol = 0,
      sellVol = 0;
    for (const t of trades) {
      const qty = parseFloat(t.qty);
      if (isNaN(qty)) continue;
      if (t.isBuyerMaker) {
        sellVol += qty;
      } else {
        buyVol += qty;
      }
    }

    const total = buyVol + sellVol;
    if (total === 0) return null;

    const buyPct = (buyVol / total) * 100;
    return {
      buyPct,
      sellPct: 100 - buyPct,
      cvd: buyVol - sellVol,
      positive: buyPct >= 50,
      trades: trades.length,
    };
  } catch {
    return null;
  }
}
