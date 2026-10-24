import { batchGetCoinglassOI, type CoinglassOIResult } from "./coinglass_oi.js";
import { getSpotCvdMtf, type SpotCvdResult } from "./coinglass_spot_cvd.js";
import {
  getSpotTakerFlow,
  type SpotTakerResult,
} from "./coinglass_spot_taker.js";
import {
  getTakerFlowCached,
  prefetchNetflowBatch,
  type TakerFlowResult,
} from "./coinglass_taker.js";
import { getOrderBookAnalysis } from "./bingx.js";
import {
  ensureSpotNetflowForSymbols,
  getSpotNetflowEntry,
  type SpotNetflowEntry,
} from "./spot-netflow-cache.js";
import { getTokenWhaleIndex } from "./whale_index.js";
import { logger } from "./logger.js";
import type {
  LiveMetricMap,
  OpenPositionLiveMetrics,
  PositionMetricProvider,
} from "./open-position-metrics.js";

const PER_SYMBOL_CONCURRENCY = 3;

function emptyMetrics(fetchedAt: number): OpenPositionLiveMetrics {
  return {
    fetchedAt,
    oi30m: null,
    oi1h: null,
    oi4h: null,
    oi24h: null,
    cvd15m: null,
    cvd30m: null,
    cvd1h: null,
    cvd4h: null,
    futuresTakerNetBuy: null,
    spotTakerNetBuy: null,
    spotTakerDominance: null,
    snf1h: null,
    snf4h: null,
    snf24h: null,
    whaleIndex: null,
    obRatio: null,
  };
}

async function runBounded<T>(
  values: string[],
  work: (value: string) => Promise<T>,
  concurrency = PER_SYMBOL_CONCURRENCY,
): Promise<Map<string, T | null>> {
  const results = new Map<string, T | null>();
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const symbol = values[next++]!;
      try {
        results.set(symbol, await work(symbol));
      } catch (err) {
        logger.debug(
          { symbol, err: String(err) },
          "Open position live metric unavailable",
        );
        results.set(symbol, null);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

function nullable<T extends { available: boolean }>(
  result: T | null | undefined,
): T | null {
  return result?.available ? result : null;
}

export class ProductionPositionMetricProvider implements PositionMetricProvider {
  async refresh(
    symbols: string[],
    priceMap: Map<string, number>,
  ): Promise<LiveMetricMap> {
    const fetchedAt = Date.now();
    const uniqueSymbols = [...new Set(symbols)];
    const result: LiveMetricMap = new Map(
      uniqueSymbols.map((symbol) => [symbol, emptyMetrics(fetchedAt)]),
    );

    // The batch providers are shared with the scanner. Their own TTLs prevent
    // repeated external calls even when this route is called from both workers.
    const [oiSettled] = await Promise.all([
      batchGetCoinglassOI(uniqueSymbols, priceMap).catch((err) => {
        logger.warn({ err }, "Open position OI batch unavailable");
        return new Map<string, CoinglassOIResult>();
      }),
      prefetchNetflowBatch().catch((err) => {
        logger.warn({ err }, "Open position futures taker batch unavailable");
      }),
      ensureSpotNetflowForSymbols(uniqueSymbols).catch((err) => {
        logger.warn({ err }, "Open position SNF batch unavailable");
      }),
    ]);

    const [cvd, futuresTaker, spotTaker, whaleIndex, orderBook] =
      await Promise.all([
        runBounded(uniqueSymbols, (symbol) => getSpotCvdMtf(symbol)),
        runBounded(uniqueSymbols, (symbol) => getTakerFlowCached(symbol)),
        runBounded(uniqueSymbols, (symbol) => getSpotTakerFlow(symbol, 4)),
        runBounded(uniqueSymbols, (symbol) => getTokenWhaleIndex(symbol)),
        runBounded(uniqueSymbols, (symbol) => getOrderBookAnalysis(symbol)),
      ]);

    for (const symbol of uniqueSymbols) {
      const metrics = result.get(symbol)!;
      const oi = nullable(oiSettled.get(symbol));
      const cvdEntry = nullable(cvd.get(symbol) as SpotCvdResult | null);
      const futuresTakerEntry = nullable(
        futuresTaker.get(symbol) as TakerFlowResult | null,
      );
      const spotTakerEntry = nullable(
        spotTaker.get(symbol) as SpotTakerResult | null,
      );
      const snfEntry = getSpotNetflowEntry(symbol) as SpotNetflowEntry | null;
      const wi = whaleIndex.get(symbol);
      const ob = orderBook.get(symbol);

      metrics.oi30m = oi?.oiChange30m ?? null;
      metrics.oi1h = oi?.oiChange1h ?? null;
      metrics.oi4h = oi?.oiChange4h ?? null;
      metrics.oi24h = oi?.oiChange24h ?? null;
      metrics.cvd15m = cvdEntry?.cvd15m ?? null;
      metrics.cvd30m = cvdEntry?.cvd30m ?? null;
      metrics.cvd1h = cvdEntry?.cvd1h ?? null;
      metrics.cvd4h = cvdEntry?.cvd4h ?? null;
      metrics.futuresTakerNetBuy = futuresTakerEntry?.netBuyPct ?? null;
      metrics.spotTakerNetBuy = spotTakerEntry?.takerNetBuy1h ?? null;
      metrics.spotTakerDominance = spotTakerEntry?.dominance ?? null;
      metrics.snf1h = snfEntry?.netPct1h ?? null;
      metrics.snf4h = snfEntry?.netPct4h ?? null;
      metrics.snf24h = snfEntry?.netPct24h ?? null;
      metrics.whaleIndex = wi ?? null;
      metrics.obRatio = ob?.bidAskRatio ?? null;
    }
    return result;
  }
}
