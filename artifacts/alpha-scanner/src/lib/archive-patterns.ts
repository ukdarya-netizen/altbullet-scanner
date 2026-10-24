import { ACTIVE_PATTERN_KEYS } from "./pattern-labels";

type ArchivePatternRow = {
  sentimentKey: string;
  total: number;
  profit: number;
  breakeven: number;
  expired: number;
  buStop: number;
  stopLoss: number;
  cancelled: number;
  netPnlPercent: number;
  winRate: number | null;
  avgPnl: number | null;
  avgPeak: number | null;
  bestDeal: number | null;
  lastSignalAt: string | null;
  avgDurationMs?: number | null;
};

function emptyPatternRow(sentimentKey: string): ArchivePatternRow {
  return {
    sentimentKey,
    total: 0,
    profit: 0,
    breakeven: 0,
    expired: 0,
    buStop: 0,
    stopLoss: 0,
    cancelled: 0,
    netPnlPercent: 0,
    winRate: null,
    avgPnl: null,
    avgPeak: null,
    bestDeal: null,
    lastSignalAt: null,
    avgDurationMs: null,
  };
}

/**
 * Archive rows have a display baseline for every current active pattern.
 * Retired rows are never synthesized and remain in their actual-data cohort.
 */
export function ensureActiveArchivePatternRows<T extends ArchivePatternRow>(
  rows: readonly T[] | null | undefined,
): T[] {
  const byPattern = new Map<string, T>();
  for (const row of rows ?? []) byPattern.set(row.sentimentKey, row);

  for (const pattern of ACTIVE_PATTERN_KEYS) {
    if (!byPattern.has(pattern)) {
      byPattern.set(pattern, emptyPatternRow(pattern) as T);
    }
  }

  return [...byPattern.values()].sort(
    (left, right) =>
      (ACTIVE_PATTERN_KEYS.indexOf(left.sentimentKey) >= 0
        ? ACTIVE_PATTERN_KEYS.indexOf(left.sentimentKey)
        : Number.MAX_SAFE_INTEGER) -
        (ACTIVE_PATTERN_KEYS.indexOf(right.sentimentKey) >= 0
          ? ACTIVE_PATTERN_KEYS.indexOf(right.sentimentKey)
          : Number.MAX_SAFE_INTEGER) ||
      left.sentimentKey.localeCompare(right.sentimentKey),
  );
}
