// ── Cross-exchange market data aggregator ────────────────────────────────────
// Order book: BingX (primary) + Binance Futures + OKX
//   bid/ask wall cross-confirmed when BingX AND (Binance OR OKX) both see it.
// Volume:     Binance Futures + Bybit + OKX + Bitget (30m klines, last 6 candles)
//   cross-confirmed when ≥ 2 out of 4 external exchanges show volMult ≥ 1.5x.

import { logger } from "./logger.js";
import { getOrderBookAnalysis, type OrderBookAnalysis } from "./bingx.js";
import { marketFetch } from "./marketRequestBudget.js";

// ── Symbol converters ─────────────────────────────────────────────────────────

function toBinanceSymbol(s: string): string {
  return s.replace("-", ""); // BTC-USDT → BTCUSDT
}

function toBybitSymbol(s: string): string {
  return s.replace("-", ""); // BTC-USDT → BTCUSDT (linear perpetual)
}

function toOKXSymbol(s: string): string {
  return s.replace("-USDT", "-USDT-SWAP"); // BTC-USDT → BTC-USDT-SWAP
}

function toBitgetSymbol(s: string): string {
  return s.replace("-", ""); // BTC-USDT → BTCUSDT
}

// ── Per-exchange result ───────────────────────────────────────────────────────

interface ExchangeOBResult {
  largestBidWallUsd: number;
  largestAskWallUsd: number;
  bidVolumeUsd: number;
  askVolumeUsd: number;
  bidAskRatio: number;
}

// ── Public type ───────────────────────────────────────────────────────────────

export interface CrossExchangeOrderBook extends OrderBookAnalysis {
  /** Bid wall confirmed by BingX AND (Binance OR OKX) */
  bidWallCrossConfirmed: boolean;
  /** Ask wall confirmed by BingX AND (Binance OR OKX) */
  askWallCrossConfirmed: boolean;
  /** How many exchanges see a significant bid wall (max 3) */
  bidWallExchangeCount: number;
  /** Exchanges that responded */
  exchanges: string[];
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function getBinanceOrderBook(
  symbol: string,
  limit: number,
): Promise<ExchangeOBResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await marketFetch(
      `https://fapi.binance.com/fapi/v1/depth?symbol=${toBinanceSymbol(symbol)}&limit=${limit}`,
      { signal: controller.signal },
      { label: "binance:orderbook" },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    const rawBids = data.bids ?? [];
    const rawAsks = data.asks ?? [];
    if (!rawBids.length && !rawAsks.length) return null;

    const bids = rawBids.map(([p, q]) => parseFloat(p) * parseFloat(q));
    const asks = rawAsks.map(([p, q]) => parseFloat(p) * parseFloat(q));

    const bidVolumeUsd = bids.reduce((s, v) => s + v, 0);
    const askVolumeUsd = asks.reduce((s, v) => s + v, 0);
    const bidAskRatio = askVolumeUsd > 0 ? bidVolumeUsd / askVolumeUsd : 0;
    const largestBidWallUsd = bids.length ? Math.max(...bids) : 0;
    const largestAskWallUsd = asks.length ? Math.max(...asks) : 0;

    return {
      largestBidWallUsd,
      largestAskWallUsd,
      bidVolumeUsd,
      askVolumeUsd,
      bidAskRatio,
    };
  } catch {
    return null;
  }
}

async function getOKXOrderBook(
  symbol: string,
  limit: number,
): Promise<ExchangeOBResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await marketFetch(
      `https://www.okx.com/api/v5/market/books?instId=${toOKXSymbol(symbol)}&sz=${limit}`,
      { signal: controller.signal },
      { label: "okx:orderbook" },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      data?: Array<{
        bids?: [string, string, string, string][];
        asks?: [string, string, string, string][];
      }>;
    };
    const entry = data.data?.[0];
    if (!entry) return null;

    const rawBids = entry.bids ?? [];
    const rawAsks = entry.asks ?? [];
    if (!rawBids.length && !rawAsks.length) return null;

    const bids = rawBids.map(([p, q]) => parseFloat(p) * parseFloat(q));
    const asks = rawAsks.map(([p, q]) => parseFloat(p) * parseFloat(q));

    const bidVolumeUsd = bids.reduce((s, v) => s + v, 0);
    const askVolumeUsd = asks.reduce((s, v) => s + v, 0);
    const bidAskRatio = askVolumeUsd > 0 ? bidVolumeUsd / askVolumeUsd : 0;
    const largestBidWallUsd = bids.length ? Math.max(...bids) : 0;
    const largestAskWallUsd = asks.length ? Math.max(...asks) : 0;

    return {
      largestBidWallUsd,
      largestAskWallUsd,
      bidVolumeUsd,
      askVolumeUsd,
      bidAskRatio,
    };
  } catch {
    return null;
  }
}

// ── Wall significance ─────────────────────────────────────────────────────────
// If volumeUsd24h is provided: use bidWallUsd / volumeUsd24h (relative threshold).
// Fallback: use bidAskRatio when 24h volume is not available.

const WALL_VOL_RATIO = 0.005; // 0.5% of 24h volume → significant wall

function seenBidWall(r: ExchangeOBResult, volumeUsd24h?: number): boolean {
  if (volumeUsd24h && volumeUsd24h > 0)
    return r.largestBidWallUsd / volumeUsd24h >= WALL_VOL_RATIO;
  return r.bidAskRatio >= 1.8;
}

function seenAskWall(r: ExchangeOBResult, volumeUsd24h?: number): boolean {
  if (volumeUsd24h && volumeUsd24h > 0)
    return r.largestAskWallUsd / volumeUsd24h >= WALL_VOL_RATIO;
  return r.bidAskRatio <= 0.6;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetches order book depth from BingX, Binance Futures, and OKX simultaneously.
 * BingX is the primary source (returns null if BingX fails).
 * Cross-confirmation: bid/ask wall confirmed when BingX AND (Binance OR OKX) agree.
 *
 * @param symbol      BingX format: "BTC-USDT"
 * @param limit       Depth levels per exchange (default 20)
 * @param volumeUsd24h Optional 24h USDT volume for relative wall threshold
 */
export async function getCrossExchangeOrderBook(
  symbol: string,
  limit = 20,
  volumeUsd24h?: number,
): Promise<CrossExchangeOrderBook | null> {
  const [bingxRes, binanceRes, okxRes] = await Promise.allSettled([
    getOrderBookAnalysis(symbol, limit),
    getBinanceOrderBook(symbol, limit),
    getOKXOrderBook(symbol, limit),
  ]);

  const bingx = bingxRes.status === "fulfilled" ? bingxRes.value : null;
  const binance = binanceRes.status === "fulfilled" ? binanceRes.value : null;
  const okx = okxRes.status === "fulfilled" ? okxRes.value : null;

  if (!bingx) {
    logger.warn({ symbol }, "CrossOB: BingX unavailable — skipping");
    return null;
  }

  const exchanges: string[] = ["bingx"];
  if (binance) exchanges.push("binance");
  if (okx) exchanges.push("okx");

  const binanceBid = binance ? seenBidWall(binance, volumeUsd24h) : false;
  const okxBid = okx ? seenBidWall(okx, volumeUsd24h) : false;
  const binanceAsk = binance ? seenAskWall(binance, volumeUsd24h) : false;
  const okxAsk = okx ? seenAskWall(okx, volumeUsd24h) : false;

  const bidWallCrossConfirmed = binanceBid || okxBid;
  const askWallCrossConfirmed = binanceAsk || okxAsk;
  const bidWallExchangeCount = 1 + (binanceBid ? 1 : 0) + (okxBid ? 1 : 0);

  logger.debug(
    {
      symbol,
      exchanges,
      bingxBias: bingx.bias,
      bidWallCrossConfirmed,
      askWallCrossConfirmed,
      bidWallExchangeCount,
      volRelative: volumeUsd24h
        ? `${((bingx.largestBidWallUsd / volumeUsd24h) * 100).toFixed(3)}%`
        : "n/a",
    },
    "CrossOB: aggregated",
  );

  return {
    ...bingx,
    bidWallCrossConfirmed,
    askWallCrossConfirmed,
    bidWallExchangeCount,
    exchanges,
  };
}

// ── Cross-exchange volume confirmation ────────────────────────────────────────
// Fetches 30m klines from 4 external exchanges (Binance Futures, Bybit, OKX, Bitget).
// Each computes volMult = currentCandle / avg(last 6 closed candles).
// cross-confirmed if ≥ 2 exchanges report volMult ≥ 1.5x.
// finalVolMult = max(bingxVolMult, avg of confirming externals).

const KLINES_TIMEOUT_MS = 3000;
const CROSS_VOL_SPIKE_THRESHOLD = 1.5; // external exchange volMult threshold to count as "confirmed"
const CROSS_VOL_MIN_CONFIRMATIONS = 2; // need ≥ 2 of 4 external exchanges

export interface ExchangeVolResult {
  exchange: string;
  volMult: number;
}

export interface CrossExchangeVolConfirmation {
  /** External exchanges that confirmed the spike (volMult ≥ CROSS_VOL_SPIKE_THRESHOLD) */
  confirming: ExchangeVolResult[];
  /** All external exchanges that responded */
  all: ExchangeVolResult[];
  /** true if ≥ 2 out of 4 external exchanges confirmed */
  crossConfirmed: boolean;
  /** max(bingxVolMult, avg of confirming externals) — bingxVolMult if not confirmed */
  finalVolMult: number;
}

async function getBinanceVolMult(symbol: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KLINES_TIMEOUT_MS);
    const res = await marketFetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${toBinanceSymbol(symbol)}&interval=30m&limit=7`,
      { signal: controller.signal },
      { label: "binance:klines" },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const rows = (await res.json()) as unknown[][];
    if (rows.length < 7) return null;
    // Row: [openTime, o, h, l, c, baseVol, closeTime, quoteVol, ...]
    // quoteVol (index 7) is in USDT — newest is last
    const current = parseFloat(rows[rows.length - 1][7] as string);
    const hist = rows.slice(0, 6).map((r) => parseFloat(r[7] as string));
    const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
    return avg > 0 ? current / avg : null;
  } catch {
    return null;
  }
}

async function getBybitVolMult(symbol: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KLINES_TIMEOUT_MS);
    const res = await marketFetch(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${toBybitSymbol(symbol)}&interval=30&limit=7`,
      { signal: controller.signal },
      { label: "bybit:klines" },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { list?: string[][] } };
    const list = data.result?.list;
    if (!list || list.length < 7) return null;
    // Bybit returns newest-first. Row: [startTime, o, h, l, c, volume, turnover]
    // turnover (index 6) = USDT volume
    const current = parseFloat(list[0][6]);
    const hist = list.slice(1, 7).map((r) => parseFloat(r[6]));
    const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
    return avg > 0 ? current / avg : null;
  } catch {
    return null;
  }
}

async function getOKXVolMult(symbol: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KLINES_TIMEOUT_MS);
    const res = await marketFetch(
      `https://www.okx.com/api/v5/market/candles?instId=${toOKXSymbol(symbol)}&bar=30m&limit=7`,
      { signal: controller.signal },
      { label: "okx:klines" },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: string[][] };
    const list = data.data;
    if (!list || list.length < 7) return null;
    // OKX returns newest-first. Row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    // volCcyQuote (index 7) = USDT volume
    const current = parseFloat(list[0][7]);
    const hist = list.slice(1, 7).map((r) => parseFloat(r[7]));
    const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
    return avg > 0 ? current / avg : null;
  } catch {
    return null;
  }
}

async function getBitgetVolMult(symbol: string): Promise<number | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), KLINES_TIMEOUT_MS);
    const res = await marketFetch(
      `https://api.bitget.com/api/v2/mix/market/candles?symbol=${toBitgetSymbol(symbol)}&productType=USDT-FUTURES&granularity=30m&limit=7`,
      { signal: controller.signal },
      { label: "bitget:klines" },
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: string[][] };
    const list = data.data;
    if (!list || list.length < 7) return null;
    // Bitget returns newest-first. Row: [ts, o, h, l, c, baseVol, quoteVol]
    // quoteVol (index 6) = USDT volume
    const current = parseFloat(list[0][6]);
    const hist = list.slice(1, 7).map((r) => parseFloat(r[6]));
    const avg = hist.reduce((s, v) => s + v, 0) / hist.length;
    return avg > 0 ? current / avg : null;
  } catch {
    return null;
  }
}

/**
 * Fetches 30m klines from Binance Futures, Bybit, OKX, and Bitget simultaneously.
 * Only runs if BingX already shows elevated volume (guard: caller should check volMult ≥ 1.3).
 *
 * @param symbol       BingX format: "BTC-USDT"
 * @param bingxVolMult Already-computed BingX volume multiplier
 */
export async function getCrossExchangeVolMult(
  symbol: string,
  bingxVolMult: number,
): Promise<CrossExchangeVolConfirmation> {
  const [binanceRes, bybitRes, okxRes, bitgetRes] = await Promise.allSettled([
    getBinanceVolMult(symbol),
    getBybitVolMult(symbol),
    getOKXVolMult(symbol),
    getBitgetVolMult(symbol),
  ]);

  const raw = [
    { exchange: "binance", res: binanceRes },
    { exchange: "bybit", res: bybitRes },
    { exchange: "okx", res: okxRes },
    { exchange: "bitget", res: bitgetRes },
  ] as const;

  const all: ExchangeVolResult[] = [];
  for (const { exchange, res } of raw) {
    if (res.status === "fulfilled" && res.value !== null) {
      all.push({ exchange, volMult: res.value });
    }
  }

  const confirming = all.filter((r) => r.volMult >= CROSS_VOL_SPIKE_THRESHOLD);
  const crossConfirmed = confirming.length >= CROSS_VOL_MIN_CONFIRMATIONS;

  let finalVolMult = bingxVolMult;
  if (crossConfirmed) {
    const avgExternal =
      confirming.reduce((s, r) => s + r.volMult, 0) / confirming.length;
    finalVolMult = Math.max(bingxVolMult, avgExternal);
  }

  logger.debug(
    {
      symbol,
      bingxVolMult: bingxVolMult.toFixed(2),
      external:
        all.map((r) => `${r.exchange}:${r.volMult.toFixed(2)}`).join(", ") ||
        "none",
      confirming: confirming.length,
      crossConfirmed,
      finalVolMult: finalVolMult.toFixed(2),
    },
    "CrossVol: aggregated",
  );

  return { confirming, all, crossConfirmed, finalVolMult };
}
