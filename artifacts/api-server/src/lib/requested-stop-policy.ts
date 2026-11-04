export type RequestedStopDecision = {
  exitPrice: number | null;
  pnlPercent: number | null;
};

/** Only a confirmed healthy market snapshot can distinguish a missing quote from an outage. */
export function requestedStopDecision(
  entryPrice: number,
  marketPrice: number | undefined,
): RequestedStopDecision | null {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("Requested stop has an invalid entry price");
  }
  if (
    marketPrice === undefined ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0
  ) {
    return { exitPrice: null, pnlPercent: null };
  }
  const pnlPercent = ((marketPrice - entryPrice) / entryPrice) * 100;
  return pnlPercent < -5 ? { exitPrice: marketPrice, pnlPercent } : null;
}
