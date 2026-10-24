import { applyCgAlias } from "./cg-symbol-alias.js";
import { cgTimedFetch } from "./cg_latency.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { getKlinesRange } from "./bingx.js";

/**
 * Stealth Breakout live-fire volume gate (owner decision 2026-10-03; raised
 * to 3x on 2026-10-07).
 *
 * The BREAKOUT candle itself (1H for 1H Range, 4H for 4H Range) must satisfy
 * ALL of: (AGGREGATED multi-exchange futures volume >= 3x the mean of the 20
 * prior candles OR AGGREGATED spot volume >= 3x the same baseline - owner
 * change 2026-10-05, either leg is enough) and a bullish (close > open) candle. Volume = CoinGlass aggregated taker buy + sell, USD.
 * Thresholds are the owner's choice; they are not a proven edge (they pass 4 of
 * her 8 reviewed winners). Missing data for either leg (or the
 * candle) BLOCKS entry (owner decision 2026-10-03), with an explicit reason.
 */
export const STEALTH_MIN_FUTURES_VOLUME_RATIO = 3;
export const STEALTH_MIN_SPOT_VOLUME_RATIO = 3;
export const STEALTH_VOLUME_GATE_VERSION = "stealth_volume_gate:v8" as const;

import { readBingxKlines } from "./bingx-bars-store.js";
import {
  getAllFuturesExchanges,
  getAllSpotExchanges,
} from "./coinglass-exchanges.js";

const HOUR_MS = 60 * 60 * 1000;
export type CandleInterval = "15m" | "30m" | "1h" | "4h";
const INTERVAL_MS: Record<CandleInterval, number> = {
  "15m": HOUR_MS / 4,
  "30m": HOUR_MS / 2,
  "1h": HOUR_MS,
  "4h": 4 * HOUR_MS,
};
const LOOKBACK = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;

export interface VolumeBar {
  time: number;
  /** Aggregated futures volume, USD (undefined = unavailable). */
  futuresVolumeUsd?: number;
  /** Aggregated spot volume, USD (undefined = unavailable). */
  spotVolumeUsd?: number;
  open?: number;
  close?: number;
  low?: number;
}

export interface StealthVolumeDecision {
  version: typeof STEALTH_VOLUME_GATE_VERSION;
  pass: boolean;
  reason:
    | "ok"
    | "momentum_filter_pass"
    | "volume_unconfirmed"
    | "futures_volume_below_threshold"
    | "spot_volume_below_threshold"
    | "candle_not_bullish"
    | "candle_body_below_threshold"
    | "range_width_below_threshold"
    | "both_volumes_below_threshold"
    | "futures_volume_unavailable"
    | "spot_volume_unavailable"
    | "stealth_spot_volume_unavailable"
    | "unavailable";
  futuresThreshold: number;
  spotThreshold: number;
  /** Candle futures volume / mean of the 20 prior candles (aggregated). */
  futuresRatio: number | null;
  /** Candle spot volume / mean of the 20 prior candles (aggregated). */
  spotRatio: number | null;
  bodyPct: number | null;
  triggerTime: number | null;
  barMs: number;
  source: string | null;
  /** CoinGlass fetch trail (per venue / aggregate), kept for calibration. */
  diagnostics?: string[];
}

function ratioAt(
  sorted: readonly VolumeBar[],
  index: number,
  field: "futuresVolumeUsd" | "spotVolumeUsd",
): number | null {
  if (index < LOOKBACK) return null;
  const value = sorted[index]![field];
  if (value === undefined || !Number.isFinite(value)) return null;
  let sum = 0;
  for (const bar of sorted.slice(index - LOOKBACK, index)) {
    const v = bar[field];
    if (v === undefined || !Number.isFinite(v)) return null;
    sum += v;
  }
  const mean = sum / LOOKBACK;
  return mean > 0 ? value / mean : null;
}

export function evaluateStealthVolumeGate(
  bars: readonly VolumeBar[] | null,
  triggerTime: number | null,
  barMs: number,
  source: string | null,
): StealthVolumeDecision {
  const base = {
    version: STEALTH_VOLUME_GATE_VERSION,
    futuresThreshold: STEALTH_MIN_FUTURES_VOLUME_RATIO,
    spotThreshold: STEALTH_MIN_SPOT_VOLUME_RATIO,
    triggerTime,
    barMs,
    source,
  };
  const unavailable: StealthVolumeDecision = {
    ...base,
    pass: false,
    reason: "unavailable",
    futuresRatio: null,
    spotRatio: null,
    bodyPct: null,
  };
  // Journal requirement: say exactly which data is missing.
  const missing = (code: string): StealthVolumeDecision => ({
    ...unavailable,
    diagnostics: [`missing:${code}`],
  });
  if (triggerTime === null) return missing("trigger_time");
  if (!bars || bars.length === 0) return missing("no_aggregate_bars_loaded");
  const sorted = bars
    .filter((bar) => Number.isFinite(bar.time))
    .sort((a, b) => a.time - b.time);
  const index = sorted.findIndex((bar) => bar.time === triggerTime);
  if (index < 0) return missing("trigger_bar_not_in_loaded_bars");
  if (index < LOOKBACK)
    return missing(`fewer_than_${LOOKBACK}_prior_candles:${index}`);
  const trigger = sorted[index]!;
  if (
    !Number.isFinite(trigger.open) ||
    !Number.isFinite(trigger.close) ||
    !((trigger.open ?? 0) > 0)
  ) {
    return missing("trigger_candle_open_close");
  }
  const futuresRatio = ratioAt(sorted, index, "futuresVolumeUsd");
  const spotRatio = ratioAt(sorted, index, "spotVolumeUsd");
  if (futuresRatio === null && spotRatio === null)
    return missing("both_volume_series_empty_or_incomplete");
  const bodyPct = (trigger.close! / trigger.open! - 1) * 100;
  const bullish = trigger.close! > trigger.open!;
  const futuresOk =
    futuresRatio !== null && futuresRatio >= STEALTH_MIN_FUTURES_VOLUME_RATIO;
  const spotOk =
    spotRatio !== null && spotRatio >= STEALTH_MIN_SPOT_VOLUME_RATIO;
  const volumeOk = futuresOk || spotOk;
  return {
    ...base,
    pass: volumeOk && bullish,
    reason: volumeOk
      ? bullish
        ? "ok"
        : "candle_not_bullish"
      : futuresRatio === null
        ? "futures_volume_unavailable"
        : spotRatio === null
          ? "spot_volume_unavailable"
          : "both_volumes_below_threshold",
    futuresRatio,
    spotRatio,
    bodyPct,
  };
}

type Loaded = {
  bars: VolumeBar[] | null;
  source: string | null;
  diag: string[];
};
const cache = new Map<string, { at: number; ttl: number; value: Loaded }>();

/**
 * Aggregated (all-exchange) futures candle volume in USD = aggregated taker buy +
 * sell volume. No spot leg and no other source.
 */
async function fetchAggregatedVolume(
  kind: "futures" | "spot",
  base: string,
  interval: CandleInterval,
  barMs: number,
  triggerTime: number,
  apiKey: string,
  diag: string[],
): Promise<Map<number, number> | null> {
  const url = new URL(
    `https://open-api-v4.coinglass.com/api/${kind}/aggregated-taker-buy-sell-volume/history`,
  );
  url.searchParams.set(
    "exchange_list",
    kind === "futures" ? getAllFuturesExchanges() : getAllSpotExchanges(),
  );
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", "100");
  url.searchParams.set("start_time", String(triggerTime - 30 * barMs));
  url.searchParams.set("end_time", String(triggerTime + barMs));
  try {
    const res = await cgTimedFetch(
      url.toString(),
      {
        headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      },
      {
        priority: "high",
        endpoint: `${kind}/aggregated-taker-buy-sell-volume/history`,
      },
    );
    if (!res.ok) {
      diag.push(`agg_${kind}:http_${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: {
        time: unknown;
        aggregated_buy_volume_usd: unknown;
        aggregated_sell_volume_usd: unknown;
      }[];
    };
    if (body.code !== "0" || !body.data) {
      diag.push(
        `agg_${kind}:code_${body.code ?? "none"}${body.msg ? `:${body.msg.slice(0, 60)}` : ""}`,
      );
      return null;
    }
    const volumes = new Map<number, number>();
    for (const row of body.data) {
      const v =
        Number(row.aggregated_buy_volume_usd) +
        Number(row.aggregated_sell_volume_usd);
      if (Number.isFinite(v)) volumes.set(Number(row.time), v);
    }
    if (volumes.size < LOOKBACK + 1) {
      diag.push(`agg_${kind}:short_${volumes.size}`);
      return null;
    }
    return volumes;
  } catch (error) {
    diag.push(
      `agg_${kind}:error_${error instanceof Error ? error.name : "unknown"}`,
    );
    return null;
  }
}

/** BingX "ABC-USDT" -> CoinGlass pair "ABCUSDT". */
export function toCoinglassPair(bingxSymbol: string): string {
  const [base = "", quote = ""] = bingxSymbol.toUpperCase().split("-");
  return `${applyCgAlias(base)}${quote}`;
}

async function loadBarsCached(
  bingxSymbol: string,
  triggerTime: number,
  interval: CandleInterval,
  now: number = Date.now(),
  withSpot = false,
): Promise<Loaded> {
  const barMs = INTERVAL_MS[interval];
  const key = `${bingxSymbol}:${interval}:${triggerTime}:${withSpot ? "fs" : "f"}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.value;
  const diag: string[] = [];
  let loaded: Loaded = { bars: null, source: null, diag };
  const apiKey = getNextCgKey();
  if (!apiKey) diag.push("no_coinglass_key");
  // Open/close/low come from BingX candles (price of the traded contract):
  // first from the candles the scanner already loaded (no request), otherwise
  // one BingX range request. No CoinGlass price venues, no fallback chain.
  if (apiKey) {
    const stored = readBingxKlines(
      bingxSymbol,
      interval,
      triggerTime - 30 * barMs,
      triggerTime + barMs,
      triggerTime,
      LOOKBACK + 1,
    );
    if (stored) {
      loaded = {
        bars: stored.map((k) => ({
          time: k.time,
          open: Number(k.open),
          close: Number(k.close),
          low: Number(k.low),
        })),
        source: "bingx_price_scanner_candles",
        diag,
      };
    }
  }
  // Scanner candles absent for this symbol/interval: one BingX range request.
  // Volume below is still the CoinGlass multi-exchange aggregate, never BingX volume.
  if (!loaded.bars && apiKey) {
    try {
      const klines = await getKlinesRange(
        bingxSymbol,
        interval,
        triggerTime - (LOOKBACK + 2) * barMs,
        triggerTime + barMs,
        { strictPayload: true },
      );
      const bars: VolumeBar[] = klines.map((k) => ({
        time: k.time,
        open: Number(k.open),
        close: Number(k.close),
        low: Number(k.low),
      }));
      if (bars.length >= LOOKBACK + 1) {
        loaded = { bars, source: "bingx_price", diag };
      } else diag.push(`price:bingx:short_${bars.length}`);
    } catch (error) {
      diag.push(
        `price:bingx:error_${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
  // Volume is always the multi-exchange aggregate (futures and spot are kept
  // separately); the single-venue bars only supply open/close/low.
  if (loaded.bars && apiKey) {
    const base = applyCgAlias(bingxSymbol.split("-")[0]!.toUpperCase());
    const futures = await fetchAggregatedVolume(
      "futures",
      base,
      interval,
      barMs,
      triggerTime,
      apiKey,
      diag,
    );
    if (futures) {
      const priceSource = loaded.source;
      // The live fire rule needs the aggregated SPOT leg too (owner
      // 2026-10-19). A failed spot fetch leaves spotVolumeUsd undefined and
      // the rule rejects with stealth_spot_volume_unavailable.
      const spot = withSpot
        ? await fetchAggregatedVolume(
            "spot",
            base,
            interval,
            barMs,
            triggerTime,
            apiKey,
            diag,
          )
        : null;
      loaded = {
        bars: loaded.bars.map((bar) => ({
          ...bar,
          futuresVolumeUsd: futures?.get(bar.time),
          ...(spot ? { spotVolumeUsd: spot.get(bar.time) } : {}),
        })),
        source: `aggregated_futures+price:${priceSource}`,
        diag,
      };
    } else {
      loaded = { bars: null, source: null, diag };
    }
  }
  cache.set(key, {
    at: now,
    ttl: loaded.bars ? CACHE_TTL_MS : NEGATIVE_TTL_MS,
    value: loaded,
  });
  return loaded;
}

export async function checkStealthVolumeGate(
  bingxSymbol: string,
  triggerTime: number | null,
  interval: CandleInterval,
  now: number = Date.now(),
  withSpot = false,
): Promise<StealthVolumeDecision> {
  const barMs = INTERVAL_MS[interval];
  if (triggerTime === null) {
    return evaluateStealthVolumeGate(null, null, barMs, null);
  }
  const loaded = await loadBarsCached(
    bingxSymbol,
    triggerTime,
    interval,
    now,
    withSpot,
  );
  const decision = evaluateStealthVolumeGate(
    loaded.bars,
    triggerTime,
    barMs,
    loaded.source,
  );
  return loaded.diag.length > 0
    ? {
        ...decision,
        diagnostics: [...(decision.diagnostics ?? []), ...loaded.diag],
      }
    : decision;
}

/**
 * Stealth live-fire candle gate (owner decision 2026-10-07, replaces the 3x
 * volume gate). Calibrated on 959 BingX perps / 41 days of independent
 * breakouts of a 100-bar high: breakout-candle body and range width separate
 * +15%/48h winners; taker/delta/volume ratio/OI did not. Uses BingX price
 * candles only (no CoinGlass dependency). Not a proven edge.
 */
export const STEALTH_CANDLE_GATE = {
  // Owner decision 2026-10-08: no range-height gate; only candle body.
  // 2026-10-11: body threshold removed by owner (blocked winners, 0 stops among
  // blocked in a 1-day sample); only a bullish trigger candle is required.
  // History: 2026-10-10 1H body raised 3 -> 5 after a 4-day BingX 15m replay of 294
  // closed-1H crossings (body>=5: +5% before -8% in 14/23 vs 23/48 at >=3).
  "1h": { minBodyPct: 0, minRangeWidthPct: 0 },
  "4h": { minBodyPct: 0, minRangeWidthPct: 0 },
} as const;

/**
 * Owner decision 2026-10-15 (revised): the live breakout candle needs AGGREGATED
 * futures volume OR AGGREGATED spot volume >= 3x the mean of the 20 prior
 * candles (CoinGlass only, no fallback). One leg is enough; if both legs are
 * unavailable the entry is blocked. 3x is the owner's level, not a proven edge.
 */
// Owner criterion 2026-10-19 (14d, 395 symbols, 409 closed 1H Range breakouts, exit rules SL8/BE+8/trail15-10/96h):
// max total PnL at good share >= the 2.9 variant -> 0.8 (total +87.8 vs +49.0; good 25.6% vs 25.6%). 1.0-2.9 all lower; weak evidence.
export const STEALTH_LIVE_MIN_VOLUME_RATIO = 0.8; // was 2.9 (was 3)

export function applyStealthLiveVolumeRule(
  candle: StealthVolumeDecision,
  volume: StealthVolumeDecision,
): StealthVolumeDecision {
  const futuresRatio = volume.futuresRatio;
  const spotRatio = volume.spotRatio;
  const base = {
    ...candle,
    futuresRatio,
    spotRatio,
    futuresThreshold: STEALTH_LIVE_MIN_VOLUME_RATIO,
    spotThreshold: STEALTH_LIVE_MIN_VOLUME_RATIO,
    source: `${candle.source ?? "candle"}+coinglass_aggregated_volume`,
  };
  if (!candle.pass) return { ...base, pass: false };
  // Owner rules 2026-10-18/19: no aggregate, no signal. Both aggregated legs
  // must be measured; one leg at/above the threshold is enough.
  if (futuresRatio === null) {
    return { ...base, pass: false, reason: "futures_volume_unavailable" };
  }
  if (spotRatio === null) {
    return {
      ...base,
      pass: false,
      reason: "stealth_spot_volume_unavailable",
    };
  }
  const volumeOk =
    futuresRatio >= STEALTH_LIVE_MIN_VOLUME_RATIO ||
    spotRatio >= STEALTH_LIVE_MIN_VOLUME_RATIO;
  return volumeOk
    ? { ...base, pass: true, reason: candle.reason }
    : { ...base, pass: false, reason: "both_volumes_below_threshold" };
}

export async function checkStealthCandleGate(
  bingxSymbol: string,
  triggerTime: number | null,
  interval: "1h" | "4h",
  range: { upper: number; lower: number } | null,
): Promise<StealthVolumeDecision> {
  const barMs = INTERVAL_MS[interval];
  const th = STEALTH_CANDLE_GATE[interval];
  const base = {
    version: STEALTH_VOLUME_GATE_VERSION,
    futuresThreshold: th.minBodyPct,
    spotThreshold: th.minRangeWidthPct,
    futuresRatio: null,
    spotRatio: null,
    triggerTime,
    barMs,
    source: "bingx_price_candle_gate",
  };
  const unavailable: StealthVolumeDecision = {
    ...base,
    pass: false,
    reason: "unavailable",
    bodyPct: null,
  };
  if (
    triggerTime === null ||
    !range ||
    !(range.lower > 0) ||
    !(range.upper > range.lower)
  ) {
    return {
      ...unavailable,
      diagnostics: [
        triggerTime === null
          ? "missing:trigger_time"
          : "missing:range_identity_or_invalid_bounds",
      ],
    };
  }
  try {
    // BingX candle requests fail transiently; a blocked entry would wait for
    // the next scan cycle, so retry briefly before reporting "unavailable".
    let klines: Awaited<ReturnType<typeof getKlinesRange>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3 && klines === null; attempt++) {
      try {
        klines = await getKlinesRange(
          bingxSymbol,
          interval,
          triggerTime,
          triggerTime + barMs,
          { strictPayload: true },
        );
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (klines === null) throw lastError;
    const bar = klines.find((k) => k.time === triggerTime);
    const open = Number(bar?.open);
    const close = Number(bar?.close);
    if (!bar || !(open > 0) || !Number.isFinite(close)) {
      return { ...unavailable, diagnostics: ["bingx_trigger_candle_missing"] };
    }
    const bodyPct = (close / open - 1) * 100;
    const widthPct = (range.upper / range.lower - 1) * 100;
    const diagnostics = [`range_width_pct:${widthPct.toFixed(2)}`];
    const reason: StealthVolumeDecision["reason"] =
      close <= open
        ? "candle_not_bullish"
        : bodyPct < th.minBodyPct
          ? "candle_body_below_threshold"
          : widthPct < th.minRangeWidthPct
            ? "range_width_below_threshold"
            : "ok";
    return { ...base, pass: reason === "ok", reason, bodyPct, diagnostics };
  } catch (error) {
    return {
      ...unavailable,
      diagnostics: [
        `bingx_error_${error instanceof Error ? error.name : "unknown"}`,
      ],
    };
  }
}

export interface CandleVolumeObservation {
  version: "candle_real_volume:v1";
  interval: CandleInterval;
  candleOpenTime: number;
  /** Aggregated futures volume / mean of the 20 prior candles. */
  futuresRatio: number | null;
  /** Aggregated spot volume / mean of the 20 prior candles. */
  spotRatio: number | null;
  bodyPct: number | null;
  source: string | null;
  status: "ok" | "unavailable";
}

/**
 * Observation only (never a gate): real CoinGlass volume of the candle that
 * produced a signal, stored with the decision. Bounded wait; any failure is an
 * explicit "unavailable", never a guess.
 */
export async function observeSignalCandleVolume(
  bingxSymbol: string,
  candleOpenTime: number | null,
  interval: CandleInterval,
  timeoutMs = 8000,
): Promise<CandleVolumeObservation> {
  const unavailable: CandleVolumeObservation = {
    version: "candle_real_volume:v1",
    interval,
    candleOpenTime: candleOpenTime ?? 0,
    futuresRatio: null,
    spotRatio: null,
    bodyPct: null,
    source: null,
    status: "unavailable",
  };
  if (candleOpenTime === null) return unavailable;
  try {
    const decision = await Promise.race([
      checkStealthVolumeGate(bingxSymbol, candleOpenTime, interval),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs).unref?.(),
      ),
    ]);
    if (!decision || decision.reason === "unavailable") return unavailable;
    return {
      ...unavailable,
      futuresRatio: decision.futuresRatio,
      spotRatio: decision.spotRatio,
      bodyPct: decision.bodyPct,
      source: decision.source,
      status: "ok",
    };
  } catch {
    return unavailable;
  }
}

export interface LiquidationCandleObservation {
  version: "liq_candle_real_volume:v1";
  interval: "15m";
  /** Highest volume-ratio candle among the last four closed 15m candles. */
  peak: {
    candleOpenTime: number;
    ratio: number;
    spotRatio: number | null;
    bodyPct: number;
    lowerWickPct: number;
  } | null;
  /** Most recent closed 15m candle before the entry. */
  last: {
    candleOpenTime: number;
    ratio: number | null;
    spotRatio: number | null;
    bodyPct: number | null;
  } | null;
  source: string | null;
  status: "ok" | "unavailable";
}

/** Observation only (never a gate) for Liquidation Cascade entries. */
export async function observeLiquidationCandleVolume(
  bingxSymbol: string,
  entryTime: number,
  timeoutMs = 8000,
): Promise<LiquidationCandleObservation> {
  const barMs = INTERVAL_MS["15m"];
  const unavailable: LiquidationCandleObservation = {
    version: "liq_candle_real_volume:v1",
    interval: "15m",
    peak: null,
    last: null,
    source: null,
    status: "unavailable",
  };
  const lastOpen = Math.floor(entryTime / barMs) * barMs - barMs;
  try {
    const loaded = await Promise.race([
      loadBarsCached(bingxSymbol, lastOpen, "15m"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs).unref?.(),
      ),
    ]);
    if (!loaded?.bars) return unavailable;
    let peak: LiquidationCandleObservation["peak"] = null;
    let last: LiquidationCandleObservation["last"] = null;
    for (let i = 3; i >= 0; i--) {
      const open = lastOpen - i * barMs;
      const d = evaluateStealthVolumeGate(
        loaded.bars,
        open,
        barMs,
        loaded.source,
      );
      if (d.reason === "unavailable" || d.futuresRatio === null) continue;
      if (i === 0) {
        last = {
          candleOpenTime: open,
          ratio: d.futuresRatio,
          spotRatio: d.spotRatio,
          bodyPct: d.bodyPct,
        };
      }
      if (peak === null || d.futuresRatio > peak.ratio) {
        const bar = loaded.bars.find((b) => b.time === open);
        const lo = bar?.low;
        const o = bar?.open;
        const c = bar?.close;
        peak = {
          candleOpenTime: open,
          ratio: d.futuresRatio,
          spotRatio: d.spotRatio,
          bodyPct: d.bodyPct ?? 0,
          lowerWickPct:
            lo !== undefined && o && c && Number.isFinite(lo)
              ? ((Math.min(o, c) - lo) / o) * 100
              : 0,
        };
      }
    }
    if (peak === null && last === null) return unavailable;
    return { ...unavailable, peak, last, source: loaded.source, status: "ok" };
  } catch {
    return unavailable;
  }
}

/** Liquidation Cascade entry filter: aggregated futures volume x on detection candle. */
export const LC_MIN_DETECTION_FUTURES_VOLUME_RATIO = 5;

export type LcDetectionVolume =
  | {
      status: "ok";
      ratio: number;
      spotRatio: number | null;
      candleOpen: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * Multi-exchange aggregated FUTURES volume of the single closed 15m candle
 * containing the liquidation detection time, relative to the prior 20 candles
 * (spot is reported separately and does not count). Missing data = unavailable.
 */
export async function loadLcDetectionVolume(
  bingxSymbol: string,
  detectedAt: number,
  now: number = Date.now(),
  timeoutMs = 8000,
): Promise<LcDetectionVolume> {
  const barMs = INTERVAL_MS["15m"];
  const candleOpen = Math.floor(detectedAt / barMs) * barMs;
  if (candleOpen + barMs > now)
    return { status: "unavailable", reason: "candle_not_closed" };
  try {
    const loaded = await Promise.race([
      loadBarsCached(bingxSymbol, candleOpen, "15m"),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), timeoutMs).unref?.(),
      ),
    ]);
    if (!loaded?.bars) return { status: "unavailable", reason: "no_bars" };
    const d = evaluateStealthVolumeGate(
      loaded.bars,
      candleOpen,
      barMs,
      loaded.source,
    );
    if (d.futuresRatio === null)
      return { status: "unavailable", reason: "futures_volume_unavailable" };
    return {
      status: "ok",
      ratio: d.futuresRatio,
      spotRatio: d.spotRatio,
      candleOpen,
    };
  } catch {
    return { status: "unavailable", reason: "error" };
  }
}
