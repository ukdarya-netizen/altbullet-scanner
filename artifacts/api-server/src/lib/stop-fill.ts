/**
 * Every stop-loss closure books EXACTLY the stop level (−stop%), not the polled
 * price that overshot it. `sentimentKey` is kept for call-site symmetry.
 */
export function exactStopFill(
  _sentimentKey: string | null | undefined,
  entryPrice: number,
  stopPct: number,
  observedPrice: number,
  observedPnl: number,
): { exitPrice: number; pnl: number } {
  if (!(entryPrice > 0) || !(stopPct > 0)) {
    return { exitPrice: observedPrice, pnl: observedPnl };
  }
  return { exitPrice: entryPrice * (1 - stopPct / 100), pnl: -stopPct };
}
