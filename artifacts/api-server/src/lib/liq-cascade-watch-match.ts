export type LiqCascadeWatchSignal = {
  id: number;
  symbol: string;
  sentimentKey: string | null | undefined;
  detectedAt: Date | number;
};

export type LiqCascadeWatchWindow = {
  symbol: string;
  detectedAt: Date | number;
  expiresAt: Date | number;
  /** Extended temporal eligibility only for a durable OB-wait release. */
  waitExpiresAt?: Date | number;
};

function toTimestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value;
}

/**
 * A tracked signal belongs to a Layer 10 watch only when it is an LC signal
 * created strictly after that watch and no later than the watch expiry.
 *
 * The production watcher enforces the same rule in SQL so the check remains
 * atomic across workers. Keeping this predicate separate makes the boundary
 * explicit and testable without importing the database-backed watcher.
 */
export function isLiqCascadeWatchSignalMatch(
  watch: LiqCascadeWatchWindow,
  signal: LiqCascadeWatchSignal,
): boolean {
  const watchDetectedAt = toTimestamp(watch.detectedAt);
  const signalDetectedAt = toTimestamp(signal.detectedAt);
  const expiresAt = Math.max(
    toTimestamp(watch.expiresAt),
    watch.waitExpiresAt === undefined
      ? -Infinity
      : toTimestamp(watch.waitExpiresAt),
  );

  return (
    signal.symbol === watch.symbol &&
    signal.sentimentKey === "liquidation_cascade" &&
    signalDetectedAt > watchDetectedAt &&
    signalDetectedAt <= expiresAt
  );
}

/**
 * When more than one eligible signal is visible, use the first signal created
 * in the watch window. The DB claim still decides which worker wins.
 */
export function selectLiqCascadeWatchSignal(
  watch: LiqCascadeWatchWindow,
  signals: readonly LiqCascadeWatchSignal[],
): LiqCascadeWatchSignal | null {
  return (
    signals
      .filter((signal) => isLiqCascadeWatchSignalMatch(watch, signal))
      .sort(
        (left, right) =>
          toTimestamp(left.detectedAt) - toTimestamp(right.detectedAt) ||
          left.id - right.id,
      )[0] ?? null
  );
}
