/**
 * CoinGlass — агрегированный стакан фьючерсов.
 *
 * Endpoint: GET /api/futures/orderbook/ask-bids-history
 *   ?symbol=BTCUSDT&exchange=Binance&interval=1h&limit=1
 * Header: CG-API-KEY
 *
 * Возвращает суммарный объём bid/ask за последний 1h бар на Binance —
 * крупнейшей фьючерсной бирже, задающей ценовой ориентир.
 * Если Binance возвращает null или объём слишком мал (< $50K) → пробуем Bybit.
 *
 * bidAskRatio = bids_usd / asks_usd
 *   ≥ 1.3 → strong_bull (+2 к alpha score)
 *   ≥ 1.1 → bull        (+1)
 *   < 0.9 → bear        (0)
 *   иначе → neutral     (0)
 */

import { logger } from "./logger.js";
import { getNextCgKey, logCg429 } from "./coinglass_keys.js";
import {
  minTurnoverUsd,
  ORDERBOOK_MIN_LIQUIDITY_PCT_OF_MCAP,
} from "./turnover-threshold.js";
import { cgTimedFetch } from "./cg_latency.js";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { getAggFuturesTakerExchanges } from "./coinglass_taker.js";

export interface CgAskBidsResult {
  bidAskRatio: number;
  bidsUsd: number;
  asksUsd: number;
  bias: "strong_bull" | "bull" | "neutral" | "bear";
  scoreBonus: number;
  exchange?: "aggregated";
}

const CG_BASE = "https://open-api-v4.coinglass.com";

/**
 * Bid/ask ratio thresholds recalibrated by percentile from 7 to 28 exchanges
 * (573-symbol universe, 14 days of 1h bars): 1.3 (p78.1) → 1.285,
 * 1.1 (p50.9) → 1.092, 0.9 (p16.6) → 0.894.
 */
export const OB_STRONG_BULL_RATIO = 1.285;
export const OB_BULL_RATIO = 1.092;
export const OB_BEAR_RATIO = 0.894;

function deriveBias(ratio: number): CgAskBidsResult["bias"] {
  if (ratio >= OB_STRONG_BULL_RATIO) return "strong_bull";
  if (ratio >= OB_BULL_RATIO) return "bull";
  if (ratio < OB_BEAR_RATIO) return "bear";
  return "neutral";
}

function deriveBonus(bias: CgAskBidsResult["bias"]): number {
  if (bias === "strong_bull") return 2;
  if (bias === "bull") return 1;
  return 0;
}

/**
 * Aggregated (multi-exchange) futures order book depth from CoinGlass.
 * Returns null if unavailable or liquidity too low; no single-exchange fallback.
 */
async function fetchAggregatedOrderbook(
  base: string,
  key: string,
  minLiquidityUsd: number | null,
): Promise<CgAskBidsResult | null> {
  try {
    const url = `${CG_BASE}/api/futures/orderbook/aggregated-ask-bids-history?exchange_list=${encodeURIComponent(getAggFuturesTakerExchanges())}&symbol=${base}&interval=1h&limit=1`;
    const res = await cgTimedFetch(url, {
      headers: { "CG-API-KEY": key },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 429) {
      logCg429(key, { symbol: base });
      return null;
    }
    if (!res.ok) return null;

    const json = (await res.json()) as {
      code: string;
      data?: Array<{
        aggregated_bids_usd: number;
        aggregated_asks_usd: number;
        time: number;
      }>;
    };

    if (json.code !== "0" || !json.data?.length) return null;

    const row = json.data[json.data.length - 1]!;
    const bidsUsd = row.aggregated_bids_usd ?? 0;
    const asksUsd = row.aggregated_asks_usd ?? 0;
    if (!(asksUsd > 0)) return null;
    if (minLiquidityUsd != null && bidsUsd + asksUsd < minLiquidityUsd)
      return null;

    const bidAskRatio = bidsUsd / asksUsd;
    const bias = deriveBias(bidAskRatio);
    const scoreBonus = deriveBonus(bias);

    return {
      bidAskRatio,
      bidsUsd,
      asksUsd,
      bias,
      scoreBonus,
      exchange: "aggregated",
    };
  } catch {
    return null;
  }
}

/**
 * @param bingxSymbol — формат BingX: "BTC-USDT", "SOL-USDT" и т.д.
 */
export async function getCgAskBids(
  bingxSymbol: string,
): Promise<CgAskBidsResult | null> {
  const key = getNextCgKey();
  if (!key) return null;

  const base = applyCgAlias(bingxSymbol.replace(/-?USDT$/i, "")).toUpperCase();
  const { fetchMarketCap } = await import("./whale_watch_v2.js");
  const minLiquidityUsd = minTurnoverUsd(
    (await fetchMarketCap(bingxSymbol).catch(() => null))?.mcap,
    ORDERBOOK_MIN_LIQUIDITY_PCT_OF_MCAP,
  );

  const aggregated = await fetchAggregatedOrderbook(base, key, minLiquidityUsd);
  if (aggregated) return aggregated;

  logger.warn(
    { symbol: bingxSymbol },
    "getCgAskBids: нет агрегированных данных стакана",
  );
  return null;
}
