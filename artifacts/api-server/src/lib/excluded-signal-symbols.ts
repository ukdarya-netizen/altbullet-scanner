/**
 * Symbols that remain available as market context and historical data but may
 * not create new trading signals or open positions.
 */
export const EXCLUDED_SIGNAL_SYMBOLS = [
  "ETH-USDT",
  "BNB-USDT",
  "SOL-USDT",
  "DOGE-USDT",
  "ETC-USDT",
  "BCH-USDT",
  "NCSKECHO2USD-USDT",
] as const;

/** Symbols the scanner must not analyse at all (owner blacklist). */
export const ANALYSIS_BLOCKED_SYMBOLS = [
  "NCSKECHO2USD-USDT",
  "ETH-USDT",
  "SOL-USDT",
  "DOGE-USDT",
] as const;

const ANALYSIS_BLOCKED_SET = new Set<string>(ANALYSIS_BLOCKED_SYMBOLS);

/**
 * Non-crypto BingX contract families, blocked by prefix: NCSK (stocks/ETF),
 * NCCO (commodities), NCSI (indices), NCFX (currency pairs).
 */
export const ANALYSIS_BLOCKED_PREFIXES = [
  "NCSK",
  "NCCO",
  "NCSI",
  "NCFX",
] as const;

export function isAnalysisBlockedSymbol(symbol: string): boolean {
  const normalized = symbol.trim().toUpperCase();
  const base = normalized.split("-")[0] ?? normalized;
  return (
    ANALYSIS_BLOCKED_SET.has(normalized) ||
    // Owner rule: no USD/USDC-denominated tickers or USDC-quoted contracts.
    normalized.endsWith("-USDC") ||
    base.includes("USD") ||
    ANALYSIS_BLOCKED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export const EXCLUDED_SIGNAL_REASON = "symbol_excluded_by_policy";

const EXCLUDED_SIGNAL_SYMBOL_SET = new Set<string>(EXCLUDED_SIGNAL_SYMBOLS);

export function normalizeSignalSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.endsWith("-USDT")) return normalized;
  if (normalized.endsWith("USDT")) {
    return `${normalized.slice(0, -4)}-USDT`;
  }
  return normalized;
}

export function isSignalSymbolExcluded(symbol: string): boolean {
  return (
    EXCLUDED_SIGNAL_SYMBOL_SET.has(normalizeSignalSymbol(symbol)) ||
    isAnalysisBlockedSymbol(symbol)
  );
}
