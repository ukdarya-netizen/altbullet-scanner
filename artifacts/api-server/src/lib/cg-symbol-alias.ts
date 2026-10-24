/** BingX base ticker → CoinGlass base ticker (same asset, different ticker). */
export const CG_SYMBOL_ALIAS: Record<string, string> = {
  USELES: "USELESS",
  // Same asset as MIRA on Binance/Bybit/Gate (verified by matching price).
  MIRANETWORK: "MIRA",
};

export function applyCgAlias(base: string): string {
  return CG_SYMBOL_ALIAS[base] ?? base;
}
