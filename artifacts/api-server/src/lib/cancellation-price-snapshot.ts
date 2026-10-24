import { calculatePrice72hAfterExitPct } from "./cancellation-policy.js";

export interface CancellationPriceTicker {
  symbol: string;
  lastPrice: string;
}

export interface PendingCancellationPriceSnapshot {
  id: number;
  symbol: string;
  isShort: boolean;
  exitPrice: number | null;
}

export interface CancellationPriceSnapshotStore {
  findPending(
    pricedSymbols: string[],
  ): Promise<PendingCancellationPriceSnapshot[]>;
  persist(snapshot: {
    id: number;
    pct: number;
    observedAt: Date;
  }): Promise<boolean>;
}

interface CancellationPriceSnapshotDeps {
  getTickers: () => Promise<CancellationPriceTicker[]>;
  store: CancellationPriceSnapshotStore;
  now?: () => Date;
}

export interface CancellationPriceSnapshotResult {
  pending: number;
  written: number;
}

/**
 * Captures the timestamp immediately after the ticker fetch and uses that same
 * observation time for every price snapshot derived from the fetched payload.
 */
export async function writeCancellationPrice72hSnapshots({
  getTickers,
  store,
  now = () => new Date(),
}: CancellationPriceSnapshotDeps): Promise<CancellationPriceSnapshotResult> {
  const tickers = await getTickers();
  const observedAt = now();
  const prices = new Map(
    tickers.map((ticker) => [
      ticker.symbol,
      Number.parseFloat(ticker.lastPrice),
    ]),
  );
  const pricedSymbols = [...prices.entries()]
    .filter(([, price]) => Number.isFinite(price) && price > 0)
    .map(([symbol]) => symbol);
  if (pricedSymbols.length === 0) return { pending: 0, written: 0 };

  const pending = await store.findPending(pricedSymbols);
  let written = 0;

  for (const row of pending) {
    const pct = calculatePrice72hAfterExitPct(
      row.exitPrice ?? Number.NaN,
      prices.get(row.symbol) ?? Number.NaN,
      row.isShort,
    );
    if (pct === null) continue;
    if (await store.persist({ id: row.id, pct, observedAt })) written++;
  }

  return { pending: pending.length, written };
}
