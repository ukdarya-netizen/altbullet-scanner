import {
  isActualMonetaryPnlStatus,
  normalizeClosedPnlPercent,
} from "./raw-pnl.js";
import { ACTIVE_PATTERN_KEYS } from "./dead-patterns.js";
import { isIncludedInCurrentPatternStats } from "./impulse-buy-stats-cohort.js";

export const DAILY_STATS_INCLUDED_STATUSES = [
  "profit",
  "stop_loss",
  "cancelled",
  "breakeven",
  "expired",
  "bu_stop",
] as const;

export type DailyStatsBasis = "entry" | "close";

export type DailyStatsSourceRow = {
  status: string | null | undefined;
  sentimentKey: string | null | undefined;
  /** Legacy provenance retained for input compatibility; never split in output. */
  stealthDetectionMethod?: string | null | undefined;
  pnlPercent: number | string | null | undefined;
  entryPrice: number | string | null | undefined;
  peakPrice: number | string | null | undefined;
  entryBtc24h: number | string | null | undefined;
  closeBtc24h: number | string | null | undefined;
  detectedAt: Date | string | null | undefined;
  closedAt: Date | string | null | undefined;
};

export type DailyPatternStats = {
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
};

export type DailyProfitabilityRow = {
  day: string;
  label: string;
  total: number;
  profit: number;
  stopLoss: number;
  cancelled: number;
  breakeven: number;
  expired: number;
  buStop: number;
  winRate: number | null;
  netPnlPercent: number;
  avgPnl: number | null;
  btc24hMedian: number | null;
  btc24hMin: number | null;
  btc24hMax: number | null;
  btc24hSamples: number;
  byPattern: DailyPatternStats[];
};

type MutableStats = {
  total: number;
  profit: number;
  stopLoss: number;
  cancelled: number;
  breakeven: number;
  expired: number;
  buStop: number;
  pnlValues: number[];
  peakValues: number[];
  btcValues: number[];
  bestDeal: number | null;
  lastSignalAt: string | null;
};

const INCLUDED_STATUS_SET = new Set<string>(DAILY_STATS_INCLUDED_STATUSES);
const DUBAI_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Dubai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const DUBAI_LABEL_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Dubai",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export function parseDailyStatsBasis(value: unknown): DailyStatsBasis {
  return value === "close" ? "close" : "entry";
}

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value: DailyStatsSourceRow["detectedAt"]): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getDubaiCalendarDay(
  value: DailyStatsSourceRow["detectedAt"],
): string | null {
  const date = validDate(value);
  if (!date) return null;
  const parts = DUBAI_DAY_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function dayLabel(day: string): string {
  return DUBAI_LABEL_FORMATTER.format(new Date(`${day}T12:00:00+04:00`));
}

function emptyStats(): MutableStats {
  return {
    total: 0,
    profit: 0,
    stopLoss: 0,
    cancelled: 0,
    breakeven: 0,
    expired: 0,
    buStop: 0,
    pnlValues: [],
    peakValues: [],
    btcValues: [],
    bestDeal: null,
    lastSignalAt: null,
  };
}

function addRow(
  stats: MutableStats,
  row: DailyStatsSourceRow,
  basis: DailyStatsBasis,
): void {
  const status = String(row.status ?? "");
  stats.total += 1;
  if (status === "profit") stats.profit += 1;
  if (status === "stop_loss") stats.stopLoss += 1;
  if (status === "cancelled") stats.cancelled += 1;
  if (status === "breakeven") stats.breakeven += 1;
  if (status === "expired") stats.expired += 1;
  if (status === "bu_stop") stats.buStop += 1;

  const pnl = isActualMonetaryPnlStatus(status)
    ? normalizeClosedPnlPercent(status, row.pnlPercent, row.sentimentKey)
    : null;
  if (pnl != null) {
    stats.pnlValues.push(pnl);
    if (status === "profit") {
      stats.bestDeal =
        stats.bestDeal == null ? pnl : Math.max(stats.bestDeal, pnl);
    }
  }

  const entryPrice = finiteNumber(row.entryPrice);
  const peakPrice = finiteNumber(row.peakPrice);
  if (
    status !== "cancelled" &&
    entryPrice != null &&
    entryPrice > 0 &&
    peakPrice != null
  ) {
    stats.peakValues.push(((peakPrice - entryPrice) / entryPrice) * 100);
  }

  const btc24h = finiteNumber(
    basis === "close" ? row.closeBtc24h : row.entryBtc24h,
  );
  if (btc24h != null) stats.btcValues.push(btc24h);

  const detectedAt = validDate(row.detectedAt)?.toISOString() ?? null;
  if (
    detectedAt != null &&
    (stats.lastSignalAt == null || detectedAt > stats.lastSignalAt)
  ) {
    stats.lastSignalAt = detectedAt;
  }
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

const ACTIVE_PATTERN_ORDER = new Map<string, number>(
  ACTIVE_PATTERN_KEYS.map((pattern, index) => [pattern, index]),
);
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  return round(value);
}

function winRate(stats: MutableStats): number | null {
  const denominator = stats.profit + stats.buStop + stats.stopLoss;
  return denominator > 0
    ? Math.round(((stats.profit + stats.buStop) / denominator) * 100)
    : null;
}

function netPnl(stats: MutableStats): number {
  return round(stats.pnlValues.reduce((sum, value) => sum + value, 0));
}

function toPatternStats(
  sentimentKey: string,
  stats: MutableStats,
): DailyPatternStats {
  return {
    sentimentKey,
    total: stats.total,
    profit: stats.profit,
    breakeven: stats.breakeven,
    expired: stats.expired,
    buStop: stats.buStop,
    stopLoss: stats.stopLoss,
    cancelled: stats.cancelled,
    netPnlPercent: netPnl(stats),
    winRate: winRate(stats),
    avgPnl: average(stats.pnlValues),
    avgPeak: average(stats.peakValues),
    bestDeal: stats.bestDeal == null ? null : round(stats.bestDeal),
    lastSignalAt: stats.lastSignalAt,
  };
}

export function aggregateDailyProfitability(
  rows: DailyStatsSourceRow[],
  basis: DailyStatsBasis,
): DailyProfitabilityRow[] {
  const days = new Map<
    string,
    {
      totals: MutableStats;
      patterns: Map<string, MutableStats>;
    }
  >();

  for (const row of rows) {
    const status = String(row.status ?? "");
    const sentimentKey = String(row.sentimentKey ?? "");
    if (
      !INCLUDED_STATUS_SET.has(status) ||
      !sentimentKey ||
      !isIncludedInCurrentPatternStats(row)
    ) {
      continue;
    }

    const day = getDubaiCalendarDay(
      basis === "close" ? row.closedAt : row.detectedAt,
    );
    if (!day) continue;

    const bucket = days.get(day) ?? {
      totals: emptyStats(),
      patterns: new Map<string, MutableStats>(),
    };
    addRow(bucket.totals, row, basis);

    const patternStats = bucket.patterns.get(sentimentKey) ?? emptyStats();
    addRow(patternStats, row, basis);
    bucket.patterns.set(sentimentKey, patternStats);
    days.set(day, bucket);
  }

  return [...days.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([day, bucket]) => {
      const btcValues = bucket.totals.btcValues;
      const patternEntries = new Map<string, MutableStats>();
      for (const pattern of ACTIVE_PATTERN_KEYS) {
        patternEntries.set(
          pattern,
          bucket.patterns.get(pattern) ?? emptyStats(),
        );
      }
      for (const [sentimentKey, stats] of bucket.patterns) {
        if (!patternEntries.has(sentimentKey)) {
          patternEntries.set(sentimentKey, stats);
        }
      }
      const byPattern = [...patternEntries.entries()]
        .map(([sentimentKey, stats]) => {
          const pattern = toPatternStats(sentimentKey, stats);
          return pattern;
        })
        .sort(
          (left, right) =>
            (ACTIVE_PATTERN_ORDER.get(left.sentimentKey) ??
              Number.MAX_SAFE_INTEGER) -
              (ACTIVE_PATTERN_ORDER.get(right.sentimentKey) ??
                Number.MAX_SAFE_INTEGER) ||
            left.sentimentKey.localeCompare(right.sentimentKey),
        );
      return {
        day,
        label: dayLabel(day),
        total: bucket.totals.total,
        profit: bucket.totals.profit,
        stopLoss: bucket.totals.stopLoss,
        cancelled: bucket.totals.cancelled,
        breakeven: bucket.totals.breakeven,
        expired: bucket.totals.expired,
        buStop: bucket.totals.buStop,
        winRate: winRate(bucket.totals),
        netPnlPercent: netPnl(bucket.totals),
        avgPnl: average(bucket.totals.pnlValues),
        btc24hMedian: median(btcValues),
        btc24hMin: btcValues.length > 0 ? round(Math.min(...btcValues)) : null,
        btc24hMax: btcValues.length > 0 ? round(Math.max(...btcValues)) : null,
        btc24hSamples: btcValues.length,
        byPattern,
      };
    });
}
