/**
 * Owner 2026-10-13: turnover thresholds are never absolute dollar amounts; they
 * are a share of the token's market capitalisation. Reference calibration: the
 * former absolute values correspond to a $500M market cap.
 */
export const NEON_MIN_TURNOVER_PCT_OF_MCAP = 0.1; // was $500k
export const STEALTH_MIN_TURNOVER_PCT_OF_MCAP = 0.01; // was $50k

export function minTurnoverUsd(
  marketCapUsd: number | null | undefined,
  pctOfMcap: number,
): number | null {
  if (
    marketCapUsd == null ||
    !Number.isFinite(marketCapUsd) ||
    marketCapUsd <= 0
  )
    return null;
  return (marketCapUsd * pctOfMcap) / 100;
}

/** Unknown market cap cannot be judged: the turnover gate is skipped and the
 *  caller records `market_cap_unavailable` in the decision evidence. */
export function meetsTurnover(
  turnoverUsd: number,
  marketCapUsd: number | null | undefined,
  pctOfMcap: number,
): boolean {
  const min = minTurnoverUsd(marketCapUsd, pctOfMcap);
  return min == null || turnoverUsd >= min;
}

// Liquidation Cascade (reference: former absolute values at a $500M market cap).
export const LC_MIN_QUOTE_VOL_PCT_OF_MCAP = 0.06; // was $300k
export const LC_LIQ_SPIKE_MIN_PCT_OF_MCAP = 0.01; // was $50k
export const LC_ORDER_STREAM_MIN_PCT_OF_MCAP = 0.02; // was $100k
export const LC_MAX_LONG_LIQ_4H_PCT_OF_MCAP = 0.066; // was $330k

/** True when `amountUsd` is below the share-of-market-cap minimum. Unknown
 *  market cap cannot be judged, so it never rejects. */
export function belowPctOfMcap(
  amountUsd: number,
  marketCapUsd: number | null | undefined,
  pctOfMcap: number,
): boolean {
  return !meetsTurnover(amountUsd, marketCapUsd, pctOfMcap);
}

/** True when `amountUsd` exceeds the share-of-market-cap maximum. */
export function abovePctOfMcap(
  amountUsd: number,
  marketCapUsd: number | null | undefined,
  pctOfMcap: number,
): boolean {
  const max = minTurnoverUsd(marketCapUsd, pctOfMcap);
  return max != null && amountUsd > max;
}

// Other former absolute filters (reference: $500M market cap).
export const ORDERBOOK_MIN_LIQUIDITY_PCT_OF_MCAP = 0.01; // was $50k
export const INFLOW_OUTFLOW_MIN_PCT_OF_MCAP = 0.4; // was $2M
export const LC_SMALL_LIQ_1H_PCT_OF_MCAP = 0.012; // was $60k
