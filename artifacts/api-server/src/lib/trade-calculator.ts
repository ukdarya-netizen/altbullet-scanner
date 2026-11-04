import {
  getEstimatedBuStopPnlPercent,
  isActualMonetaryPnlStatus,
  normalizeClosedPnlPercent,
} from "./raw-pnl.js";

export const CALCULATOR_MONTH_TIME_ZONE = "Asia/Dubai";
export const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

export const CALCULATOR_CLOSED_STATUSES = [
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
  "cancelled",
] as const;

export type CalculatorSettingsInput = {
  depositUsdt: number;
  leverage: number;
  allocationPercent: number;
  commissionPercent: number;
};

export type CalculatorTradeRow = {
  status: string;
  pnlPercent: number | null;
  lastMilestone?: number | string | null;
  closedAt: Date;
};

export type CalculatorMonthlyCounts = {
  closedTrades: number;
  profitTrades: number;
  lossTrades: number;
  buStopTrades: number;
  breakevenTrades: number;
  expiredTrades: number;
  cancelledSignals: number;
};

export function getCalculatorMonthlyCounts(
  summary: CalculatorMonthlyCounts,
): CalculatorMonthlyCounts {
  return {
    closedTrades: summary.closedTrades,
    profitTrades: summary.profitTrades,
    lossTrades: summary.lossTrades,
    buStopTrades: summary.buStopTrades,
    breakevenTrades: summary.breakevenTrades,
    expiredTrades: summary.expiredTrades,
    cancelledSignals: summary.cancelledSignals,
  };
}

export function getDubaiMonthKey(date: Date): string {
  const shifted = new Date(date.getTime() + DUBAI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
}

/**
 * Return the UTC instant at which a Dubai calendar month starts.
 * Dubai has no DST, so this fixed offset is intentional and testable.
 */
export function getDubaiMonthStartUtc(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, (monthNumber ?? 1) - 1, 1) - DUBAI_OFFSET_MS);
}

export function getNextDubaiMonthBoundary(date: Date): Date {
  const [year, monthNumber] = getDubaiMonthKey(date).split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber ?? 1, 1) - DUBAI_OFFSET_MS);
}

export function getPreviousDubaiMonthKey(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const previous = new Date(
    Date.UTC(year, (monthNumber ?? 1) - 1, 1) - 24 * 60 * 60 * 1000,
  );
  return `${previous.getUTCFullYear()}-${String(
    previous.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
}

export function getCalculatorMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, (monthNumber ?? 1) - 1, 1)).toLocaleDateString(
    "ru-RU",
    {
      month: "long",
      year: "numeric",
      timeZone: CALCULATOR_MONTH_TIME_ZONE,
    },
  );
}

export function calculateCalculatorSummary(
  month: string,
  rows: CalculatorTradeRow[],
  settings: CalculatorSettingsInput,
) {
  const margin = settings.depositUsdt * (settings.allocationPercent / 100);
  const notional = margin * settings.leverage;
  const fee = notional * (settings.commissionPercent / 100);
  let grossPnlUsdt = 0;
  let netPnlUsdt = 0;
  let estimatedBuStopPnlUsdt = 0;
  let estimatedBuStopTrades = 0;
  let unavailableBuStopEstimateTrades = 0;
  let profitTrades = 0;
  let lossTrades = 0;
  let buStopTrades = 0;
  let breakevenTrades = 0;
  let expiredTrades = 0;
  let cancelledSignals = 0;

  for (const row of rows) {
    if (row.status === "cancelled") {
      cancelledSignals += 1;
      continue;
    }

    const pnlPercent = normalizeClosedPnlPercent(row.status, row.pnlPercent);
    if (isActualMonetaryPnlStatus(row.status) && pnlPercent != null) {
      const grossTradePnl = notional * (pnlPercent / 100);
      grossPnlUsdt += grossTradePnl;
      netPnlUsdt += grossTradePnl - fee;
    }
    if (row.status === "bu_stop") {
      const estimate = getEstimatedBuStopPnlPercent(
        row.status,
        row.lastMilestone,
      );
      if (estimate == null) {
        unavailableBuStopEstimateTrades += 1;
      } else {
        estimatedBuStopPnlUsdt += notional * (estimate / 100);
        estimatedBuStopTrades += 1;
      }
    }

    if (row.status === "bu_stop") buStopTrades += 1;
    else if (row.status === "stop_loss" || (pnlPercent ?? 0) < 0)
      lossTrades += 1;
    else if (row.status === "breakeven") breakevenTrades += 1;
    else if (row.status === "expired") expiredTrades += 1;
    else profitTrades += 1;
  }

  const closedTrades =
    profitTrades + lossTrades + buStopTrades + breakevenTrades + expiredTrades;
  const pnlWithEstimatedBuStopUsdt = netPnlUsdt + estimatedBuStopPnlUsdt;
  return {
    month,
    label: getCalculatorMonthLabel(month),
    marginPerTradeUsdt: margin,
    notionalPerTradeUsdt: notional,
    grossPnlUsdt,
    netPnlUsdt,
    netPnlPercent:
      settings.depositUsdt > 0 ? (netPnlUsdt / settings.depositUsdt) * 100 : 0,
    estimatedBuStopPnlUsdt,
    estimatedBuStopPnlPercent:
      settings.depositUsdt > 0
        ? (estimatedBuStopPnlUsdt / settings.depositUsdt) * 100
        : 0,
    pnlWithEstimatedBuStopUsdt,
    pnlWithEstimatedBuStopPercent:
      settings.depositUsdt > 0
        ? (pnlWithEstimatedBuStopUsdt / settings.depositUsdt) * 100
        : 0,
    estimatedBuStopTrades,
    unavailableBuStopEstimateTrades,
    closedTrades,
    profitTrades,
    lossTrades,
    buStopTrades,
    breakevenTrades,
    expiredTrades,
    cancelledSignals,
  };
}
