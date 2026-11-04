/**
 * Current market metrics for open positions.
 *
 * This is deliberately separate from the scanner's prescan pool: an open
 * position must continue receiving current market context even after it falls
 * out of prescan. The outer cache coalesces dashboard polls; the individual
 * providers retain their own longer API-safe caches and circuit breakers.
 */
const DASHBOARD_REFRESH_MS = 60_000;
const COLD_REFRESH_WAIT_MS = 1_500;

export type CurrentMetricSource = "live" | "fallback" | "unavailable";

export interface OpenPositionLiveMetrics {
  fetchedAt: number;
  oi30m: number | null;
  oi1h: number | null;
  oi4h: number | null;
  oi24h: number | null;
  cvd15m: boolean | null;
  cvd30m: boolean | null;
  cvd1h: boolean | null;
  cvd4h: boolean | null;
  futuresTakerNetBuy: number | null;
  spotTakerNetBuy: number | null;
  spotTakerDominance: "buy" | "sell" | "neutral" | null;
  snf1h: number | null;
  snf4h: number | null;
  snf24h: number | null;
  whaleIndex: number | null;
  obRatio: number | null;
}

export type LiveMetricMap = Map<string, OpenPositionLiveMetrics>;

export interface PositionMetricProvider {
  refresh(
    symbols: string[],
    priceMap: Map<string, number>,
  ): Promise<LiveMetricMap>;
}

function hasLiveValue(metrics: OpenPositionLiveMetrics): boolean {
  return Object.entries(metrics).some(
    ([key, value]) => key !== "fetchedAt" && value != null,
  );
}

/**
 * A request-level view over a process-local, position-only cache. It also
 * coalesces concurrent requests, which is important because production runs
 * more than one dashboard request at a time.
 */
export class OpenPositionMetricsCache {
  private readonly entries = new Map<string, OpenPositionLiveMetrics>();
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly provider: PositionMetricProvider,
    private readonly ttlMs = DASHBOARD_REFRESH_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private refreshOrJoin(
    symbols: string[],
    priceMap: Map<string, number>,
  ): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.provider
        .refresh(symbols, priceMap)
        .then((fresh) => {
          for (const [symbol, metrics] of fresh)
            this.entries.set(symbol, metrics);
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  async get(
    symbols: string[],
    priceMap: Map<string, number>,
  ): Promise<LiveMetricMap> {
    const uniqueSymbols = [...new Set(symbols)];
    const now = this.now();
    const staleSymbols = uniqueSymbols.filter((symbol) => {
      const cached = this.entries.get(symbol);
      return !cached || now - cached.fetchedAt >= this.ttlMs;
    });

    if (staleSymbols.length > 0) {
      const refresh = this.refreshOrJoin(staleSymbols, priceMap);
      const hasColdSymbol = staleSymbols.some(
        (symbol) => !this.entries.has(symbol),
      );
      if (hasColdSymbol) {
        // Nothing to show yet: wait, but only briefly. The route falls back to
        // scanner/persisted values for symbols still missing afterwards.
        await Promise.race([
          refresh,
          new Promise<void>((resolve) =>
            setTimeout(resolve, COLD_REFRESH_WAIT_MS),
          ),
        ]).catch(() => undefined);
      } else {
        // Stale-while-revalidate: serve the previous values now and refresh in
        // the background so one poll per minute never blocks on providers.
        refresh.catch(() => undefined);
      }
    }
    return new Map(
      uniqueSymbols.flatMap((symbol) => {
        const metrics = this.entries.get(symbol);
        return metrics ? [[symbol, metrics] as const] : [];
      }),
    );
  }
}

class LazyProductionPositionMetricProvider implements PositionMetricProvider {
  private provider: PositionMetricProvider | null = null;
  private loading: Promise<PositionMetricProvider> | null = null;

  private async getProvider(): Promise<PositionMetricProvider> {
    if (this.provider) return this.provider;
    if (!this.loading) {
      this.loading = import("./open-position-metrics-provider.js").then(
        ({ ProductionPositionMetricProvider }) => {
          this.provider = new ProductionPositionMetricProvider();
          return this.provider;
        },
      );
    }
    return this.loading;
  }

  async refresh(
    symbols: string[],
    priceMap: Map<string, number>,
  ): Promise<LiveMetricMap> {
    return (await this.getProvider()).refresh(symbols, priceMap);
  }
}

const livePositionMetricsCache = new OpenPositionMetricsCache(
  new LazyProductionPositionMetricProvider(),
);

export function getOpenPositionLiveMetrics(
  symbols: string[],
  priceMap: Map<string, number>,
): Promise<LiveMetricMap> {
  return livePositionMetricsCache.get(symbols, priceMap);
}

/**
 * Select a current value only. Entry snapshots intentionally do not belong in
 * this function: a caller must label and render them separately.
 */
export function resolveCurrentMetric<T>(
  live: T | null | undefined,
  scanner: T | null | undefined,
  persistedPrescan: T | null | undefined,
): { value: T | null; source: CurrentMetricSource } {
  if (live != null) return { value: live, source: "live" };
  if (scanner != null || persistedPrescan != null) {
    return { value: scanner ?? persistedPrescan ?? null, source: "fallback" };
  }
  return { value: null, source: "unavailable" };
}

export function calculateLivePnl(
  entryPrice: number,
  currentPrice: number | null,
  isShort: boolean,
): number | null {
  if (!currentPrice || entryPrice <= 0) return null;
  const raw = isShort
    ? ((entryPrice - currentPrice) / entryPrice) * 100
    : ((currentPrice - entryPrice) / entryPrice) * 100;
  return Math.round(raw * 100) / 100;
}

export function liveMetricSource(
  live: OpenPositionLiveMetrics | undefined,
  scannerHasData: boolean,
  persistedHasData: boolean,
): CurrentMetricSource {
  if (live && hasLiveValue(live)) return "live";
  if (scannerHasData || persistedHasData) return "fallback";
  return "unavailable";
}
