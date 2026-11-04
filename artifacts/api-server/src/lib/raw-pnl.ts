export type RawPnlRow = {
  status: string | null | undefined;
  pnlPercent: number | string | null | undefined;
  exitPrice?: number | string | null | undefined;
  lastMilestone?: number | string | null | undefined;
  sentimentKey?: string | null | undefined;
};

export type ClosedTradeOutcomeRow = RawPnlRow & {
  cancelReason?: string | null | undefined;
};

export type RawPnlSummary = {
  profitPercent: number;
  lossPercent: number;
  netPercent: number;
  rowsWithPnl: number;
};

export type EstimatedBuStopPnlSummary = RawPnlSummary & {
  estimatedBuStopPnlPercent: number;
  /** Observational only; never use as actual/settled PnL. */
  pnlWithEstimatedBuStopPercent: number;
  estimatedBuStopTrades: number;
  unavailableBuStopEstimateTrades: number;
};

export type BuStopMilestone = number | string | null | undefined;

export type ProtectedBuStopExit = {
  exitPrice: number | null;
  pnlPercent: number;
};

export const CLOSED_TRADE_OUTCOME_STATUSES = [
  "profit",
  "stop_loss",
  "bu_stop",
  "breakeven",
  "expired",
  "cancelled",
] as const;
const CLOSED_PNL_STATUSES = new Set<string>(CLOSED_TRADE_OUTCOME_STATUSES);
const ACTUAL_MONETARY_PNL_STATUSES = new Set<string>([
  "profit",
  "stop_loss",
  "expired",
  "cancelled",
]);

/**
 * BE outcomes remain outcome and win-rate observations, but do not represent
 * realized monetary PnL. Keep this check at every actual-PnL aggregation
 * boundary rather than repurposing the recorded/display PnL value.
 */
export function isActualMonetaryPnlStatus(
  status: RawPnlRow["status"],
): boolean {
  return ACTUAL_MONETARY_PNL_STATUSES.has(status ?? "");
}

/**
 * Determines whether a tracker row has a usable position outcome. A
 * cancellation must have a recorded close price and finite PnL; this excludes
 * no-entry, administrative, and otherwise unmeasurable cancellations.
 */
export function isClosedTradeOutcome(row: ClosedTradeOutcomeRow): boolean {
  const status = row.status ?? "";
  if (!CLOSED_PNL_STATUSES.has(status)) return false;
  if (status !== "cancelled") return true;

  const exitPrice = Number(row.exitPrice);
  const pnl = Number(row.pnlPercent);
  return (
    Number.isFinite(exitPrice) &&
    exitPrice > 0 &&
    row.pnlPercent != null &&
    Number.isFinite(pnl)
  );
}

/**
 * A protected stop cannot become a loss after a price gap. Most patterns close
 * the remainder at entry; patterns with an explicit positive lock preserve it.
 */
export function normalizeClosedPnlPercent(
  status: RawPnlRow["status"],
  pnlPercent: RawPnlRow["pnlPercent"],
  _sentimentKey?: RawPnlRow["sentimentKey"],
): number | null {
  if (status === "bu_stop") {
    if (_sentimentKey !== "impulse_buy") return 0;
    if (pnlPercent == null) return 0;
    const pnl = Number(pnlPercent);
    return Number.isFinite(pnl) ? Math.max(0, pnl) : 0;
  }
  if (pnlPercent == null) return null;
  const pnl = Number(pnlPercent);
  if (!Number.isFinite(pnl)) return null;
  return pnl;
}

/**
 * Returns the highest target recorded before a protected BE close.
 * A missing milestone is intentionally kept unknown instead of being
 * converted into an assumed +5% partial take.
 */
export function getBuStopTakePct(
  status: RawPnlRow["status"],
  lastMilestone: BuStopMilestone,
): number | null {
  if (status !== "bu_stop" || lastMilestone == null) return null;
  const milestone = Number(lastMilestone);
  if (!Number.isFinite(milestone) || milestone < 5) return null;
  return milestone;
}

/**
 * Estimates only the realized partial take for a protected BE close:
 * 20% of the position at the highest recorded target, 80% at breakeven.
 */
export function getEstimatedBuStopPnlPercent(
  status: RawPnlRow["status"],
  lastMilestone: BuStopMilestone,
): number | null {
  const takePct = getBuStopTakePct(status, lastMilestone);
  return takePct == null ? null : Math.round(takePct * 20) / 100;
}

/**
 * Returns the configured protected close for the remaining position.
 * A sampled market price after a gap is diagnostic only and must never become
 * the user-facing exit price or a loss in strategy accounting.
 */
export function getProtectedBuStopExit(
  entryPrice: number | string | null | undefined,
  protectedProfitPct = 0,
): ProtectedBuStopExit {
  const numericEntryPrice = Number(entryPrice);
  const safeProtectedProfitPct =
    Number.isFinite(protectedProfitPct) && protectedProfitPct > 0
      ? protectedProfitPct
      : 0;
  return {
    exitPrice:
      Number.isFinite(numericEntryPrice) && numericEntryPrice > 0
        ? numericEntryPrice * (1 + safeProtectedProfitPct / 100)
        : null,
    pnlPercent: safeProtectedProfitPct,
  };
}

/**
 * Sums the recorded percentage PnL of every monetarily settled position.
 * breakeven and bu_stop are deliberately excluded from actual PnL.
 * Cancelled positions are included because they already had an entry.
 */
export function sumRawNetPnlPercent(rows: readonly RawPnlRow[]): number {
  return summarizeRawPnlPercent(rows).netPercent;
}

export function formatDailyPnlLine(rows: readonly RawPnlRow[]): string {
  const { netPercent } = summarizeRawPnlPercent(rows);
  return `💰 <b>PnL за день: ${netPercent >= 0 ? "+" : ""}${netPercent.toFixed(1)}%</b>`;
}

/**
 * Splits raw closed-position PnL into gross profit and loss magnitude.
 * The displayed net value is deliberately calculated from the displayed
 * rounded components so the report's `profit - loss = net` equation is exact.
 */
export function summarizeRawPnlPercent(
  rows: readonly RawPnlRow[],
): RawPnlSummary {
  let profitPercent = 0;
  let lossPercent = 0;
  let rowsWithPnl = 0;

  for (const row of rows) {
    if (!isActualMonetaryPnlStatus(row.status)) continue;
    const pnl = normalizeClosedPnlPercent(
      row.status,
      row.pnlPercent,
      row.sentimentKey,
    );
    if (pnl == null) continue;
    rowsWithPnl++;
    if (pnl >= 0) {
      profitPercent += pnl;
    } else {
      lossPercent += Math.abs(pnl);
    }
  }

  const roundedProfit = Math.round(profitPercent * 100) / 100;
  const roundedLoss = Math.round(lossPercent * 100) / 100;
  return {
    profitPercent: roundedProfit,
    lossPercent: roundedLoss,
    netPercent: Math.round((roundedProfit - roundedLoss) * 100) / 100,
    rowsWithPnl,
  };
}

export function summarizePnlWithEstimatedBuStop(
  rows: readonly RawPnlRow[],
): EstimatedBuStopPnlSummary {
  const raw = summarizeRawPnlPercent(rows);
  let estimatedBuStopPnlPercent = 0;
  let estimatedBuStopTrades = 0;
  let unavailableBuStopEstimateTrades = 0;

  for (const row of rows) {
    if (row.status !== "bu_stop") continue;
    const estimate = getEstimatedBuStopPnlPercent(
      row.status,
      row.lastMilestone,
    );
    if (estimate == null) {
      unavailableBuStopEstimateTrades += 1;
      continue;
    }
    estimatedBuStopPnlPercent += estimate;
    estimatedBuStopTrades += 1;
  }

  const roundedEstimate = Math.round(estimatedBuStopPnlPercent * 100) / 100;
  return {
    ...raw,
    estimatedBuStopPnlPercent: roundedEstimate,
    pnlWithEstimatedBuStopPercent:
      Math.round((raw.netPercent + roundedEstimate) * 100) / 100,
    estimatedBuStopTrades,
    unavailableBuStopEstimateTrades,
  };
}
