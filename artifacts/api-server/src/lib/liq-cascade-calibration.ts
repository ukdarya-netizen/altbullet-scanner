/**
 * Pure Liquidation Cascade calibration rules.
 *
 * Keep these independent from watcher/database imports so the data-backed
 * decisions can be tested without booting the scanner runtime.
 */

export interface LiqCascadeSpotTakerSnapshot {
  available: boolean;
  netBuyPct: number | null;
}

/**
 * A confirmed negative spot taker flow means aggressive sellers are still in
 * control after the liquidation wave. Missing CoinGlass data must stay
 * fail-open: unavailable is not bearish evidence.
 */
export function shouldBlockLiqCascadeSpotTaker(
  spotTaker: LiqCascadeSpotTakerSnapshot | null,
): boolean {
  return (
    spotTaker?.available === true &&
    spotTaker.netBuyPct !== null &&
    spotTaker.netBuyPct < 0
  );
}

/**
 * A weaker liquidation wave is not an entry while the token is still falling.
 * Only the ordinary liq_spike path is affected. Unknown measurements are not
 * evidence of a continued decline and leave the watch eligible for a recheck.
 */
export function shouldHoldLiqCascadeForRecovery(
  entryReason: string | null,
  liqRatio: number | null,
  price1hPct: number | null,
): boolean {
  return (
    entryReason === "liq_spike" &&
    liqRatio !== null &&
    Number.isFinite(liqRatio) &&
    liqRatio < 0.75 &&
    price1hPct !== null &&
    Number.isFinite(price1hPct) &&
    price1hPct < -0.5
  );
}

/** Percentage movement from the price at the missed-candidate expiry. */
export function calculateForwardPricePct(
  priceAtLog: number | null,
  currentPrice: number | null,
): number | null {
  if (
    priceAtLog === null ||
    currentPrice === null ||
    !Number.isFinite(priceAtLog) ||
    !Number.isFinite(currentPrice) ||
    priceAtLog <= 0 ||
    currentPrice <= 0
  ) {
    return null;
  }

  return ((currentPrice - priceAtLog) / priceAtLog) * 100;
}
