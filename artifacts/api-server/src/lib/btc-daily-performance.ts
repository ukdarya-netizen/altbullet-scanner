import { ACTIVE_PATTERN_KEYS } from "./dead-patterns.js";
import { isIncludedInCurrentPatternStats } from "./impulse-buy-stats-cohort.js";
import {
  isActualMonetaryPnlStatus,
  isClosedTradeOutcome,
  summarizeRawPnlPercent,
} from "./raw-pnl.js";

const DUBAI_TIME_ZONE = "Asia/Dubai";
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_PERFORMANCE_DAYS = 30;
const ACTIVE_PATTERN_SET = new Set<string>(ACTIVE_PATTERN_KEYS);

export type BtcDailyPerformanceSourceRow = {
  signalId?: number | null;
  sentimentKey: string | null | undefined;
  status: string | null | undefined;
  detectedAt: Date | string | null | undefined;
  closedAt: Date | string | null | undefined;
  pnlPercent: number | string | null | undefined;
  exitPrice?: number | string | null | undefined;
  entryBtc24h?: number | null;
  entryBtcDominance?: number | null;
};

export type BtcDailyPerformanceRow = {
  day: string;
  signals: number;
  closedTrades: number;
  completedTrades: number;
  stopLosses: number;
  stopLossRate: number | null;
  netPnlPercent: number | null;
};

export type BtcDailyPerformanceWindow = {
  days: string[];
  start: Date;
  end: Date;
};

function validDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function getDubaiDay(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DUBAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Unable to resolve Dubai day");
  return `${year}-${month}-${day}`;
}

function dayString(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dubaiMidnight(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date!) - DUBAI_OFFSET_MS);
}

export function getBtcDailyPerformanceWindow(
  now = new Date(),
): BtcDailyPerformanceWindow {
  const today = getDubaiDay(now);
  const todayUtcMidnight = Date.parse(`${today}T00:00:00.000Z`);
  const firstDay = dayString(
    todayUtcMidnight - (DAILY_PERFORMANCE_DAYS - 1) * DAY_MS,
  );
  const tomorrowUtcMidnight = todayUtcMidnight + DAY_MS;
  const endDay = dayString(tomorrowUtcMidnight);
  const days = Array.from({ length: DAILY_PERFORMANCE_DAYS }, (_, index) =>
    dayString(todayUtcMidnight - (DAILY_PERFORMANCE_DAYS - index - 1) * DAY_MS),
  );
  return {
    days,
    start: dubaiMidnight(firstDay),
    end: dubaiMidnight(endDay),
  };
}

export function buildBtcDailyPerformance(
  rows: readonly BtcDailyPerformanceSourceRow[],
  now = new Date(),
): BtcDailyPerformanceRow[] {
  const window = getBtcDailyPerformanceWindow(now);
  const byDay = new Map<
    string,
    {
      signals: number;
      completedTrades: number;
      stopLosses: number;
      monetaryRows: BtcDailyPerformanceSourceRow[];
    }
  >(
    window.days.map((day) => [
      day,
      { signals: 0, completedTrades: 0, stopLosses: 0, monetaryRows: [] },
    ]),
  );

  for (const row of rows) {
    if (
      row.signalId == null ||
      !row.sentimentKey ||
      !ACTIVE_PATTERN_SET.has(row.sentimentKey)
    ) {
      continue;
    }

    const detectedAt = validDate(row.detectedAt);
    const detectedDay = detectedAt ? getDubaiDay(detectedAt) : null;
    if (
      row.signalId != null &&
      row.status !== "reclassified" &&
      detectedDay != null
    ) {
      const day = byDay.get(detectedDay);
      if (day) day.signals += 1;
    }

    if (!isIncludedInCurrentPatternStats(row) || !isClosedTradeOutcome(row)) {
      continue;
    }
    const closedAt = validDate(row.closedAt);
    const closedDay = closedAt ? getDubaiDay(closedAt) : null;
    const day = closedDay ? byDay.get(closedDay) : undefined;
    if (day) {
      day.completedTrades += 1;
      if (row.status === "stop_loss") day.stopLosses += 1;
      if (isActualMonetaryPnlStatus(row.status)) day.monetaryRows.push(row);
    }
  }

  return window.days.map((day) => {
    const bucket = byDay.get(day)!;
    const summary = summarizeRawPnlPercent(bucket.monetaryRows);
    return {
      day,
      signals: bucket.signals,
      closedTrades: summary.rowsWithPnl,
      completedTrades: bucket.completedTrades,
      stopLosses: bucket.stopLosses,
      stopLossRate:
        bucket.completedTrades === 0
          ? null
          : Number(
              ((bucket.stopLosses / bucket.completedTrades) * 100).toFixed(1),
            ),
      netPnlPercent: summary.rowsWithPnl === 0 ? null : summary.netPercent,
    };
  });
}
