/**
 * Observational alternatives. These values never participate in the real
 * trailing decision; they only create rows in signal_trailing_shadow_events.
 */
export const SHADOW_TRAILING_ACTIVATIONS = [12, 15, 20] as const;
export const SHADOW_TRAILING_GAPS = [5, 7, 8, 10, 12, 15] as const;
export const SHADOW_FOLLOW_UPS = [
  { eventType: "6h", elapsedMs: 6 * 60 * 60_000 },
  { eventType: "24h", elapsedMs: 24 * 60 * 60_000 },
  { eventType: "72h", elapsedMs: 72 * 60 * 60_000 },
] as const;

export function directionAwarePnl(
  entryPrice: number,
  currentPrice: number,
  isShort: boolean,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  return (
    ((isShort ? entryPrice - currentPrice : currentPrice - entryPrice) /
      entryPrice) *
    100
  );
}

export function directionAwarePeak(
  previousPeak: number | null | undefined,
  currentPrice: number,
  entryPrice: number,
  isShort: boolean,
): number {
  const baseline =
    previousPeak != null && previousPeak > 0 ? previousPeak : entryPrice;
  return isShort
    ? Math.min(baseline, currentPrice)
    : Math.max(baseline, currentPrice);
}

export function resolveDirectionAwareTrailingLevel(
  entryPrice: number,
  peakPrice: number,
  trailingGapPct: number,
  isShort: boolean,
): number {
  const peakPnlPct = directionAwarePnl(entryPrice, peakPrice, isShort);
  const protectedPnlPct = peakPnlPct - trailingGapPct;
  return isShort
    ? entryPrice * (1 - protectedPnlPct / 100)
    : entryPrice * (1 + protectedPnlPct / 100);
}

export function isDirectionAwareTrailingHit(
  currentPrice: number,
  trailingLevel: number,
  isShort: boolean,
): boolean {
  return isShort
    ? currentPrice >= trailingLevel
    : currentPrice <= trailingLevel;
}
