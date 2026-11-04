export type NeonUniverseOrchestrationInput<T> = {
  genericSymbols: readonly T[];
  neonSymbols: readonly T[];
  qualifiedDeliverySymbols?: readonly T[];
  evaluateNeon: (symbol: T) => Promise<T | null>;
  runGeneric: (symbol: T) => Promise<void>;
  signal?: AbortSignal;
  deadlineAt?: number;
  concurrency?: number;
};

/**
 * Runs the Neon-only pass over the deduplicated union, then exposes only the
 * original generic universe plus explicitly queued qualified deliveries to
 * the generic callback. This boundary prevents supplemental symbols from
 * accidentally acquiring 30m/CG/generic strategy work.
 */
export async function runNeonUniverseOrchestration<T>(
  input: NeonUniverseOrchestrationInput<T>,
): Promise<{ qualifiedDeliverySymbols: T[] }> {
  const neon = [...new Set(input.neonSymbols)];
  const qualifiedDeliverySymbols: T[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      if (input.signal?.aborted) return;
      if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt)
        return;
      const index = nextIndex++;
      if (index >= neon.length) return;
      try {
        const qualified = await input.evaluateNeon(neon[index]!);
        if (qualified !== null) qualifiedDeliverySymbols.push(qualified);
      } catch {
        // One symbol's DB/API failure must not lose the remaining universe.
      }
    }
  };
  const workerCount = Math.max(
    1,
    Math.min(input.concurrency ?? 8, neon.length || 1),
  );
  await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));

  const generic = new Set(input.genericSymbols);
  for (const symbol of input.qualifiedDeliverySymbols ?? [])
    generic.add(symbol);
  for (const symbol of generic) await input.runGeneric(symbol);
  return { qualifiedDeliverySymbols };
}

export function buildNeonUniverse<T>(
  genericSymbols: readonly T[],
  prescanSymbols: readonly T[],
  oiWatchSymbols: readonly T[],
  qualifiedDeliverySymbols: readonly T[],
): { neonSymbols: T[]; genericSymbols: T[]; deliverySymbols: T[] } {
  const generic = [...new Set(genericSymbols)];
  const neon = new Set(generic);
  for (const symbol of prescanSymbols) neon.add(symbol);
  for (const symbol of oiWatchSymbols) neon.add(symbol);
  for (const symbol of qualifiedDeliverySymbols) neon.add(symbol);
  const delivery = [...new Set(qualifiedDeliverySymbols)];
  return {
    neonSymbols: [...neon],
    genericSymbols: generic,
    deliverySymbols: delivery,
  };
}

/** Preserve the oldest durable event already selected for each symbol. */
export function mergeQualifiedNeonEventsOldestFirst<T>(
  target: Map<string, T>,
  incoming: ReadonlyMap<string, T>,
): void {
  for (const [symbol, event] of incoming) {
    if (!target.has(symbol)) target.set(symbol, event);
  }
}
