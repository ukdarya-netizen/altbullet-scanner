import { AsyncLocalStorage } from "node:async_hooks";

export type MarketCycleLeaseContext = {
  readonly job: string;
  readonly ownerToken: string;
  readonly signal: AbortSignal;
  throwIfLost(action?: string): void;
};

/**
 * Kept separate from the DB-backed lease implementation so HTTP clients can
 * observe a cycle cancellation without importing the database at module load.
 */
export const marketCycleLeaseContext = new AsyncLocalStorage<
  MarketCycleLeaseContext | undefined
>();
