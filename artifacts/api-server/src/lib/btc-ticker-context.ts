export type BtcTickerContext = {
  change24h: number | null;
  price: number | null;
};

export function parseCloseBtc24h(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBtcPrice(value: unknown): number | null {
  const parsed = parseCloseBtc24h(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

/** Null fields mean the ticker was unavailable; nothing is invented. */
export function buildBtcTickerContext(
  ticker:
    | { priceChangePercent?: unknown; lastPrice?: unknown }
    | null
    | undefined,
): BtcTickerContext {
  return {
    change24h: parseCloseBtc24h(ticker?.priceChangePercent),
    price: parseBtcPrice(ticker?.lastPrice),
  };
}
