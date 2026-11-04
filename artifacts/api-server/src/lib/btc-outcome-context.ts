import { ACTIVE_PATTERN_KEYS } from "./dead-patterns.js";
import { isIncludedInCurrentPatternStats } from "./impulse-buy-stats-cohort.js";
import { isActualMonetaryPnlStatus, isClosedTradeOutcome } from "./raw-pnl.js";
import {
  getBtcDailyPerformanceWindow,
  getDubaiDay,
  type BtcDailyPerformanceSourceRow,
} from "./btc-daily-performance.js";

type Snapshot = {
  observedAt: Date | string | null;
  value: number | null;
  source?: "coinglass" | "coingecko" | "signal_snapshot";
};

export type DailyMarketContext = {
  day: string;
  btcPrice: number | null;
  btcDominance: number | null;
  dominanceObservedAt: string | null;
  dominanceSource: Snapshot["source"] | null;
  btcChangePercent: number | null;
  dominanceChangePoints: number | null;
};

function parsedDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function buildDailyMarketContext(
  priceSnapshots: readonly Snapshot[],
  dominanceSnapshots: readonly Snapshot[],
  now = new Date(),
): DailyMarketContext[] {
  const days = getBtcDailyPerformanceWindow(now).days;
  const market = new Map(
    days.map((day) => [
      day,
      {
        price: null as number | null,
        dominance: null as number | null,
        priceAt: -Infinity,
        dominanceAt: -Infinity,
        dominanceSource: null as Snapshot["source"] | null,
      },
    ]),
  );
  for (const snapshot of priceSnapshots) {
    const date = parsedDate(snapshot.observedAt);
    const value = snapshot.value;
    if (
      !date ||
      date > now ||
      value == null ||
      !Number.isFinite(value) ||
      value <= 0
    )
      continue;
    const bucket = market.get(getDubaiDay(date));
    if (bucket && date.getTime() > bucket.priceAt) {
      bucket.price = value;
      bucket.priceAt = date.getTime();
    }
  }
  for (const snapshot of dominanceSnapshots) {
    const date = parsedDate(snapshot.observedAt);
    const value = snapshot.value;
    if (
      !date ||
      date > now ||
      value == null ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 100
    )
      continue;
    const bucket = market.get(getDubaiDay(date));
    if (bucket && date.getTime() > bucket.dominanceAt) {
      bucket.dominance = value;
      bucket.dominanceAt = date.getTime();
      bucket.dominanceSource = snapshot.source ?? null;
    }
  }
  return days.map((day, index) => {
    const current = market.get(day)!;
    const previous = index ? market.get(days[index - 1]!)! : null;
    return {
      day,
      btcPrice: current.price,
      btcDominance: current.dominance,
      dominanceObservedAt:
        current.dominance == null
          ? null
          : new Date(current.dominanceAt).toISOString(),
      dominanceSource: current.dominanceSource,
      btcChangePercent:
        current.price != null && previous?.price != null
          ? Number(
              (
                ((current.price - previous.price) / previous.price) *
                100
              ).toFixed(2),
            )
          : null,
      dominanceChangePoints:
        current.dominance != null && previous?.dominance != null
          ? Number((current.dominance - previous.dominance).toFixed(2))
          : null,
    };
  });
}

const activePatterns = new Set<string>(ACTIVE_PATTERN_KEYS);

export function buildBtcEntryOutcomeContext(
  rows: readonly BtcDailyPerformanceSourceRow[],
  now = new Date(),
) {
  const window = getBtcDailyPerformanceWindow(now);
  const completed = rows.filter((row) => {
    const detectedAt = parsedDate(row.detectedAt);
    const closedAt = parsedDate(row.closedAt);
    return (
      row.signalId != null &&
      row.sentimentKey != null &&
      activePatterns.has(row.sentimentKey) &&
      isIncludedInCurrentPatternStats(row) &&
      isClosedTradeOutcome(row) &&
      detectedAt != null &&
      detectedAt >= window.start &&
      detectedAt < window.end &&
      closedAt != null &&
      closedAt <= now
    );
  });
  const withBoth = completed.filter(
    (row) =>
      row.entryBtc24h != null &&
      Number.isFinite(row.entryBtc24h) &&
      row.entryBtcDominance != null &&
      Number.isFinite(row.entryBtcDominance) &&
      row.entryBtcDominance > 0 &&
      row.entryBtcDominance <= 100,
  );
  const levels = withBoth
    .map((row) => row.entryBtcDominance!)
    .sort((a, b) => a - b);
  const middle = Math.floor(levels.length / 2);
  const median = levels.length
    ? (levels[middle]! + levels[(levels.length - 1) >> 1]!) / 2
    : null;

  const groups = (["falling", "flat_or_rising"] as const).flatMap(
    (btcDirection) =>
      (["below_median", "at_or_above_median"] as const).map(
        (dominanceLevel) => {
          const matches = withBoth.filter(
            (row) =>
              (btcDirection === "falling"
                ? row.entryBtc24h! < 0
                : row.entryBtc24h! >= 0) &&
              (dominanceLevel === "below_median"
                ? row.entryBtcDominance! < median!
                : row.entryBtcDominance! >= median!),
          );
          const monetary = matches
            .filter((row) => isActualMonetaryPnlStatus(row.status))
            .map((row) => Number(row.pnlPercent))
            .filter(Number.isFinite);
          const stopLosses = matches.filter(
            (row) => row.status === "stop_loss",
          ).length;
          return {
            btcDirection,
            dominanceLevel,
            trades: matches.length,
            stopLosses,
            stopLossRate: matches.length
              ? Number(((stopLosses / matches.length) * 100).toFixed(1))
              : null,
            pnlTrades: monetary.length,
            averagePnlPercent: monetary.length
              ? Number(
                  (
                    monetary.reduce((sum, value) => sum + value, 0) /
                    monetary.length
                  ).toFixed(2),
                )
              : null,
          };
        },
      ),
  );
  return {
    medianDominance: median == null ? null : Number(median.toFixed(2)),
    eligibleClosedTrades: completed.length,
    withBothSnapshots: withBoth.length,
    missingSnapshots: completed.length - withBoth.length,
    groups,
  };
}
