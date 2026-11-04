/**
 * A trailing stop can only rise while a long position is open. Its configured
 * gap is measured in PnL percentage points from entry: peak +24.1% with a
 * 10-point gap protects +14.1%. A newer persisted level always wins.
 */
export function resolveTrailingStopLevel(input: {
  entryPrice: number;
  peakPrice: number;
  trailingGapPercent: number;
  persistedTrailingStopLevel: number | null | undefined;
}): number {
  const peakPnlPercent =
    ((input.peakPrice - input.entryPrice) / input.entryPrice) * 100;
  const protectedPnlPercent = peakPnlPercent - input.trailingGapPercent;
  const calculatedLevel = input.entryPrice * (1 + protectedPnlPercent / 100);
  return Math.max(calculatedLevel, input.persistedTrailingStopLevel ?? 0);
}

/**
 * Resolve a usable trailing boundary only after the configured peak threshold
 * was genuinely reached. A persisted level by itself is not activation proof:
 * older watcher paths used to write a provisional level at the first target.
 */
export function resolveActivatedTrailingStopLevel(input: {
  peakPnlPercent: number;
  trailingActivationPercent: number;
  entryPrice: number;
  peakPrice: number;
  trailingGapPercent: number;
  persistedTrailingStopLevel: number | null | undefined;
}): number | null {
  if (input.peakPnlPercent < input.trailingActivationPercent) return null;
  return resolveTrailingStopLevel({
    entryPrice: input.entryPrice,
    peakPrice: input.peakPrice,
    trailingGapPercent: input.trailingGapPercent,
    persistedTrailingStopLevel: input.persistedTrailingStopLevel,
  });
}

export function isTrailingStopHit(
  currentPrice: number,
  trailingStopLevel: number,
): boolean {
  return currentPrice <= trailingStopLevel;
}

export function isStartupTrailingStopHit(input: {
  currentPrice: number;
  trailingStopLevel: number;
  trailingActive: boolean;
  trailingStopArmedAt: Date | null;
  observedAt: Date;
  boundaryArmedByStartupObservation: boolean;
  startupPeakIncreased: boolean;
}): boolean {
  if (
    !input.trailingActive ||
    input.trailingStopArmedAt === null ||
    input.trailingStopArmedAt.getTime() > input.observedAt.getTime() ||
    !isTrailingStopHit(input.currentPrice, input.trailingStopLevel)
  ) {
    return false;
  }

  // A boundary raised from a genuinely new startup price observation must not
  // close on that same observation. A boundary raised only because the formula
  // was corrected against an already durable peak must close immediately.
  return (
    !input.boundaryArmedByStartupObservation || !input.startupPeakIncreased
  );
}

/**
 * Realtime protection only accepts a price tick that occurred after the level
 * was armed. When BingX supplies an exchange event time it is the stronger
 * fence; otherwise the synchronous WebSocket receipt time is used. This
 * prevents a newly active stop from being closed by an older buffered message
 * or a candle low from before activation.
 */
export function isRealtimeTrailingStopHit(input: {
  currentPrice: number;
  trailingStopLevel: number;
  armedAt: Date;
  observedAt: Date;
  exchangeAt?: Date | null;
}): boolean {
  const crossingAt = input.exchangeAt ?? input.observedAt;
  return (
    crossingAt.getTime() >= input.armedAt.getTime() &&
    isTrailingStopHit(input.currentPrice, input.trailingStopLevel)
  );
}

export function isRealtimeTrailingEventNewer(input: {
  observedAt: Date;
  exchangeAt?: Date | null;
  lastEventAt?: Date | null;
}): boolean {
  if (!input.lastEventAt) return true;
  return (
    (input.exchangeAt ?? input.observedAt).getTime() >
    input.lastEventAt.getTime()
  );
}

export function isFreshDurableTrailingStopHit(input: {
  currentPrice: number;
  trailingStopLevel: number | null;
  armedAt: Date | null;
  observedAt: Date;
  exchangeAt?: Date | null;
}): boolean {
  return (
    input.trailingStopLevel !== null &&
    input.armedAt !== null &&
    isRealtimeTrailingStopHit({
      currentPrice: input.currentPrice,
      trailingStopLevel: input.trailingStopLevel,
      armedAt: input.armedAt,
      observedAt: input.observedAt,
      exchangeAt: input.exchangeAt,
    })
  );
}

export function resolveLongTrailingHighWater(input: {
  entryPrice: number;
  durablePeakPrice: number | null;
  currentPrice: number;
  trailingActivationPercent: number;
  trailingGapPercent: number;
}): {
  peakPrice: number;
  trailingStopLevel: number | null;
} {
  const peakPrice = Math.max(
    input.durablePeakPrice ?? input.entryPrice,
    input.currentPrice,
  );
  const peakPnlPercent =
    ((peakPrice - input.entryPrice) / input.entryPrice) * 100;
  return {
    peakPrice,
    trailingStopLevel:
      peakPnlPercent >= input.trailingActivationPercent
        ? input.entryPrice *
          (1 + (peakPnlPercent - input.trailingGapPercent) / 100)
        : null,
  };
}

export function shouldSubscribeRealtimeTrailingPosition(input: {
  status: string;
  isShort: boolean | null | undefined;
  symbol?: string | null;
}): boolean {
  const isBitcoin = input.symbol === "BTC-USDT" || input.symbol === "BTCUSDT";
  return (
    input.isShort !== true &&
    (input.status === "in_run" || (input.status === "active" && isBitcoin))
  );
}

export function isRealtimeBitcoinBreakevenHit(input: {
  peakPnlPercent: number;
  currentPrice: number;
  entryPrice: number;
  breakevenActivationPercent: number;
  trailingActivationPercent: number;
}): boolean {
  return (
    input.peakPnlPercent >= input.breakevenActivationPercent &&
    input.peakPnlPercent < input.trailingActivationPercent &&
    input.currentPrice <= input.entryPrice
  );
}

export async function retryRealtimeTrailingOperation<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    retryDelayMs?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
  const wait =
    options.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await wait(retryDelayMs * attempt);
    }
  }
  throw lastError;
}

export function resolveRealtimeTrailingBoundaryState(input: {
  calculatedTrailingStop: number | null;
  existing?: { trailingStopLevel: number | null; armedAt: Date | null } | null;
  remembered?: {
    trailingStopLevel: number | null;
    armedAt: Date | null;
  } | null;
  durable?: {
    trailingStopLevel: number | null;
    armedAt: Date | null;
  } | null;
  observedAt: Date;
}): { trailingStopLevel: number | null; armedAt: Date | null } {
  const priorLevel =
    input.existing?.trailingStopLevel ??
    input.remembered?.trailingStopLevel ??
    null;
  const trailingStopLevel =
    input.calculatedTrailingStop === null
      ? priorLevel
      : Math.max(priorLevel ?? 0, input.calculatedTrailingStop);
  const matchingPrior =
    input.durable?.trailingStopLevel === trailingStopLevel &&
    input.durable.armedAt !== null
      ? input.durable
      : input.existing?.trailingStopLevel === trailingStopLevel
        ? input.existing
        : input.remembered?.trailingStopLevel === trailingStopLevel
          ? input.remembered
          : null;
  return {
    trailingStopLevel,
    armedAt:
      trailingStopLevel === null
        ? null
        : (matchingPrior?.armedAt ?? input.observedAt),
  };
}

/**
 * A live tick that hit an already-armed boundary remains a valid close signal
 * even when the durable row now contains a higher boundary from a newer peak.
 * The higher boundary strengthens the protected exit; it must never re-arm the
 * position and require a second tick after the first valid crossing.
 */
export function resolveRealtimeTrailingClose(input: {
  currentPrice: number;
  candidateTrailingStopLevel: number;
  freshTrailingStopLevel: number | null;
  armedAt: Date;
  observedAt: Date;
  exchangeAt?: Date | null;
}): { shouldClose: boolean; trailingStopLevel: number | null } {
  if (
    input.freshTrailingStopLevel === null ||
    !isRealtimeTrailingStopHit({
      currentPrice: input.currentPrice,
      trailingStopLevel: input.candidateTrailingStopLevel,
      armedAt: input.armedAt,
      observedAt: input.observedAt,
      exchangeAt: input.exchangeAt,
    })
  ) {
    return {
      shouldClose: false,
      trailingStopLevel: input.freshTrailingStopLevel,
    };
  }

  return {
    shouldClose: true,
    trailingStopLevel: Math.max(
      input.candidateTrailingStopLevel,
      input.freshTrailingStopLevel,
    ),
  };
}

/**
 * Invalidates asynchronous realtime callbacks across a watcher stop/start.
 * A replacement monitor always receives a distinct generation, so work
 * captured by a previous WebSocket cannot resume into the new lifecycle.
 */
export class RealtimeTrailingMonitorFence {
  private generation = 0;

  start(): number {
    this.generation++;
    return this.generation;
  }

  stop(): void {
    this.generation++;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  current(): number {
    return this.generation;
  }
}

/**
 * Activation is a market fact: the durable peak must have reached the configured
 * threshold. A persisted stop is only a monotonic boundary after that fact.
 */
export function isTrailingProtectionActive(input: {
  peakPnlPercent: number;
  trailingActivationPercent: number;
  persistedTrailingStopLevel: number | null | undefined;
}): boolean {
  return input.peakPnlPercent >= input.trailingActivationPercent;
}
