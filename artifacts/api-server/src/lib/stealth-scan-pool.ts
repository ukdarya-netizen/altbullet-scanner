import type { BingXTicker } from "./bingx.js";

export function findSupplementalSymbols(
  normalTickers: readonly BingXTicker[],
  currentTickers: readonly BingXTicker[],
): Set<string> {
  const normalSymbols = new Set(normalTickers.map((ticker) => ticker.symbol));
  return new Set(
    currentTickers
      .map((ticker) => ticker.symbol)
      .filter((symbol) => !normalSymbols.has(symbol)),
  );
}

export function getCircularPageWindow(
  totalCount: number,
  cursor: number,
  limit: number,
): {
  offset: number;
  firstPageLimit: number;
  wrappedPageLimit: number;
  nextCursor: number;
} {
  if (
    !Number.isFinite(totalCount) ||
    !Number.isFinite(cursor) ||
    !Number.isFinite(limit) ||
    totalCount <= 0 ||
    limit <= 0
  ) {
    return {
      offset: 0,
      firstPageLimit: 0,
      wrappedPageLimit: 0,
      nextCursor: 0,
    };
  }
  const count = Math.trunc(totalCount);
  const pageLimit = Math.min(Math.trunc(limit), count);
  const offset = ((Math.trunc(cursor) % count) + count) % count;
  const firstPageLimit = Math.min(pageLimit, count - offset);
  return {
    offset,
    firstPageLimit,
    wrappedPageLimit: pageLimit - firstPageLimit,
    nextCursor: (offset + pageLimit) % count,
  };
}

/**
 * Builds the Stealth universe from the already fetched BingX ticker map.
 * Symbols which do not have a current ticker are intentionally omitted.
 */
export function buildStealthScanPool(input: {
  normalTickers: readonly BingXTicker[];
  tickerBySymbol: ReadonlyMap<string, BingXTicker>;
  rangeArmSymbols?: Iterable<string>;
  prescanSymbols: Iterable<string>;
  oiWatchSymbols: Iterable<string>;
}): { tickers: BingXTicker[]; supplementalSymbols: Set<string> } {
  const normalSymbols = new Set(
    input.normalTickers.map((ticker) => ticker.symbol),
  );
  const symbols = new Set(normalSymbols);
  for (const symbol of input.rangeArmSymbols ?? []) symbols.add(symbol);
  for (const symbol of input.prescanSymbols) symbols.add(symbol);
  for (const symbol of input.oiWatchSymbols) symbols.add(symbol);

  const tickers: BingXTicker[] = [];
  const supplementalSymbols = new Set<string>();
  for (const symbol of symbols) {
    const ticker = input.tickerBySymbol.get(symbol);
    if (!ticker) continue;
    tickers.push(ticker);
    if (!normalSymbols.has(symbol)) supplementalSymbols.add(symbol);
  }
  return { tickers, supplementalSymbols };
}

export function selectStealthRangeScanCandidates<
  T extends { symbol: string },
>(input: {
  activeRangeSymbols: readonly string[];
  supplementalSymbols: readonly string[];
  tickerBySymbol: ReadonlyMap<string, T>;
  normalSymbols: readonly string[];
  reviewedWatchSymbols?: readonly string[];
  persistedDeliverySymbols?: readonly string[];
  rangeCursor?: number;
  supplementalCursor?: number;
  rangeLimit?: number;
  supplementalLimit?: number;
}): {
  tickers: T[];
  selectedRangeSymbols: Set<string>;
  rangeOnlySymbols: Set<string>;
  nextRangeCursor: number;
  nextSupplementalCursor: number;
} {
  const normalSymbols = new Set(input.normalSymbols);
  const select = (
    symbols: readonly string[],
    cursor: number,
    limit: number,
  ): { tickers: T[]; nextCursor: number } => {
    const available = [...new Set(symbols)].filter(
      (symbol) =>
        !normalSymbols.has(symbol) && input.tickerBySymbol.has(symbol),
    );
    if (available.length === 0 || limit <= 0) {
      return { tickers: [], nextCursor: 0 };
    }
    const start =
      ((Math.trunc(cursor) % available.length) + available.length) %
      available.length;
    const count = Math.min(Math.max(0, Math.trunc(limit)), available.length);
    const selected = Array.from(
      { length: count },
      (_, index) => available[(start + index) % available.length]!,
    );
    return {
      tickers: selected.map((symbol) => input.tickerBySymbol.get(symbol)!),
      nextCursor: (start + count) % available.length,
    };
  };

  const activeRange = select(
    input.activeRangeSymbols,
    input.rangeCursor ?? 0,
    input.rangeLimit ?? 50,
  );
  const selectedRangeSymbols = new Set(
    activeRange.tickers.map((ticker) => ticker.symbol),
  );
  const supplemental = select(
    input.supplementalSymbols.filter(
      (symbol) => !selectedRangeSymbols.has(symbol),
    ),
    input.supplementalCursor ?? 0,
    input.supplementalLimit ?? 50,
  );
  const existingDeliverySymbols = new Set([
    ...(input.reviewedWatchSymbols ?? []),
    ...(input.persistedDeliverySymbols ?? []),
  ]);
  const rangeOnlySymbols = new Set(
    [...activeRange.tickers, ...supplemental.tickers]
      .map((ticker) => ticker.symbol)
      .filter(
        (symbol) =>
          !normalSymbols.has(symbol) && !existingDeliverySymbols.has(symbol),
      ),
  );
  return {
    tickers: [...activeRange.tickers, ...supplemental.tickers],
    selectedRangeSymbols,
    rangeOnlySymbols,
    nextRangeCursor: activeRange.nextCursor,
    nextSupplementalCursor: supplemental.nextCursor,
  };
}

/** Schedule Stealth-only work without duplicating normal or delivery rows. */
export function buildStealthScanWorklist<T extends { symbol: string }>(input: {
  normalTickers: readonly T[];
  persistedDeliveryTickers: readonly T[];
  reviewedWatchTickers: readonly T[];
  selectedSupplementalTickers: readonly T[];
  prioritySymbols?: ReadonlySet<string>;
}): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const ticker of [
    ...input.normalTickers,
    ...input.persistedDeliveryTickers,
    ...input.reviewedWatchTickers,
    ...input.selectedSupplementalTickers,
  ]) {
    if (seen.has(ticker.symbol)) continue;
    seen.add(ticker.symbol);
    result.push(ticker);
  }
  if (!input.prioritySymbols?.size) return result;
  // Active arms must not repeatedly lose their turn to the parent's cycle
  // deadline. Only ordering changes; the ordinary universe stays intact.
  return [
    ...result.filter((ticker) => input.prioritySymbols!.has(ticker.symbol)),
    ...result.filter((ticker) => !input.prioritySymbols!.has(ticker.symbol)),
  ];
}

export function shouldContinueAfterStealthEvaluation(input: {
  supplemental: boolean;
  detectedPattern: string | null;
  rangeOnly?: boolean;
}): boolean {
  if (input.detectedPattern === null) return false;
  if (input.rangeOnly) {
    // Owner 2026-10-22: Impulse Buy evaluates every scanned symbol, including
    // Range-only ones.
    return (
      input.detectedPattern === "stealth_breakout" ||
      input.detectedPattern === "impulse_buy"
    );
  }
  return (
    !input.supplemental ||
    input.detectedPattern === "stealth_breakout" ||
    input.detectedPattern === "neon_support_bounce"
  );
}

/** Evaluate a selected persisted Range arm early, then reuse that exact result. */
export async function evaluateRangeLifecycleOnce<T>(input: {
  selected: boolean;
  priorResult: T | null;
  evaluate: () => Promise<T>;
}): Promise<T | null> {
  if (input.priorResult !== null) return input.priorResult;
  return input.selected ? input.evaluate() : null;
}

/** CoinGlass-without-24h OI hard stop retained for selected Range arms. */
export function shouldSkipForNegativeShortOiWithout24h(input: {
  coinglassAvailable: boolean;
  oi24h: number | null;
  oi30m: number | null;
  oi1h: number | null;
}): boolean {
  return (
    input.coinglassAvailable &&
    input.oi24h === null &&
    input.oi30m !== null &&
    input.oi1h !== null &&
    input.oi30m < -2 &&
    input.oi1h < -2
  );
}

/** Lifecycle evaluation is not permission to bypass any downstream fire gate. */
export function canDeliverQualifiedRangeArm(
  result: { status: string },
  deliveryRiskGatesPassed: boolean,
): boolean {
  return result.status === "qualified" && deliveryRiskGatesPassed;
}

/**
 * Neon shadow evaluation is intentionally independent of generic candidate
 * gates. Keeping this predicate explicit makes the scanner ordering contract
 * testable instead of relying on a comment beside the call site.
 */
export function shouldEvaluateNeonSupportShadow(input: {
  inStealthUniverse: boolean;
  rangeOnly?: boolean;
}): boolean {
  return input.inStealthUniverse && !input.rangeOnly;
}
