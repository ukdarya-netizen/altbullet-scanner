import { marketCycleLeaseContext } from "./marketCycleContext.js";

/**
 * Process-wide budget for outbound market-data HTTP requests.
 *
 * Individual modules already have their own per-endpoint limits.  Those limits
 * used to add up, however: a scanner prefetch, CoinGlass OI batch, and watcher
 * job could all open requests at once.  This gate is the final shared ceiling.
 * Fast-cycle work has priority so stop/target tracking is never queued behind
 * scan enrichment.
 */
export type MarketRequestPriority = "critical" | "scan" | "background";

type Waiter = {
  priority: MarketRequestPriority;
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const MAX_IN_FLIGHT_MARKET_REQUESTS = 10;
let inFlight = 0;
const queues: Record<MarketRequestPriority, Waiter[]> = {
  critical: [],
  scan: [],
  background: [],
};

function abortError(): Error {
  return new Error("Market request cancelled because its cycle ended");
}

function currentPriority(): MarketRequestPriority {
  const job = marketCycleLeaseContext.getStore()?.job;
  if (job === "scanner") return "scan";
  if (job) return "background";
  // FastCycle deliberately runs outside the scanner lease: it protects open
  // positions, so it must be allowed to overtake scan enrichment in the queue.
  return "critical";
}

function removeWaiter(waiter: Waiter) {
  const queue = queues[waiter.priority];
  const index = queue.indexOf(waiter);
  if (index >= 0) queue.splice(index, 1);
}

function dequeueNext(): Waiter | undefined {
  return (
    queues.critical.shift() ?? queues.scan.shift() ?? queues.background.shift()
  );
}

function drain(): void {
  while (inFlight < MAX_IN_FLIGHT_MARKET_REQUESTS) {
    const waiter = dequeueNext();
    if (!waiter) return;
    if (waiter.signal?.aborted) {
      waiter.onAbort?.();
      waiter.reject(abortError());
      continue;
    }
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    inFlight++;
    waiter.resolve();
  }
}

async function acquire(
  priority: MarketRequestPriority,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (
    inFlight < MAX_IN_FLIGHT_MARKET_REQUESTS &&
    queues.critical.length === 0
  ) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { priority, resolve, reject, signal };
    waiter.onAbort = () => {
      removeWaiter(waiter);
      reject(abortError());
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    queues[priority].push(waiter);
  });
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  drain();
}

export function getMarketRequestSignal(timeoutMs: number): AbortSignal {
  const cycleSignal = marketCycleLeaseContext.getStore()?.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return cycleSignal
    ? AbortSignal.any([cycleSignal, timeoutSignal])
    : timeoutSignal;
}

/** Compose an endpoint's own signal with the current cycle cancellation. */
export function composeMarketRequestSignal(
  signal?: AbortSignal | null,
): AbortSignal | undefined {
  const cycleSignal = marketCycleLeaseContext.getStore()?.signal;
  if (!signal) return cycleSignal;
  if (!cycleSignal) return signal;
  return AbortSignal.any([signal, cycleSignal]);
}

export async function runMarketRequest<T>(
  label: string,
  work: () => Promise<T>,
  options: {
    priority?: MarketRequestPriority;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const signal = options.signal ?? marketCycleLeaseContext.getStore()?.signal;
  await acquire(options.priority ?? currentPriority(), signal);
  try {
    if (signal?.aborted) throw abortError();
    return await work();
  } finally {
    release();
  }
}

/** Shared, abort-aware transport for non-CoinGlass market endpoints. */
export async function marketFetch(
  input: string | URL,
  init: RequestInit,
  options: { label: string; priority?: MarketRequestPriority },
): Promise<Response> {
  const signal = composeMarketRequestSignal(init.signal);
  return runMarketRequest(
    options.label,
    () => fetch(input, { ...init, signal }),
    { priority: options.priority, signal },
  );
}

export function getMarketRequestBudgetSnapshot() {
  return {
    inFlight,
    limit: MAX_IN_FLIGHT_MARKET_REQUESTS,
    queuedCritical: queues.critical.length,
    queuedScan: queues.scan.length,
    queuedBackground: queues.background.length,
  };
}
