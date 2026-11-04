const TRADINGVIEW_URL_RE =
  /tradingview\.com\/chart\/\?symbol=(?:BINGX|BYBIT):([A-Za-z0-9]+)(?:\.P)?/gi;
const HASHTAG_RE = /#([A-Za-z0-9]{1,20})\b/g;
const PAIR_RE = /\b([A-Z][A-Z0-9]{0,19})-USDT\b/g;
const NO_CHART_LINKS_MARKER = "\u2063altbullet-no-chart-links\u2063";

function normalizeSymbol(raw: string): string | null {
  const value = raw.trim().toUpperCase();
  const base = value.endsWith("-USDT")
    ? value.slice(0, -5)
    : value.endsWith("USDT")
      ? value.slice(0, -4)
      : value;
  if (!/^[A-Z0-9]{1,20}$/.test(base)) return null;

  // USDT itself and purely numeric tags are not tradable ticker symbols.
  if (!base || base === "USDT" || !/[A-Z]/.test(base)) return null;
  return base;
}

function collectSymbols(text: string): {
  symbols: string[];
  linkedSymbols: Set<string>;
} {
  const symbols: string[] = [];
  const linkedSymbols = new Set<string>();
  const add = (raw: string, linked = false) => {
    const symbol = normalizeSymbol(raw);
    if (!symbol) return;
    if (!symbols.includes(symbol)) symbols.push(symbol);
    if (linked) linkedSymbols.add(symbol);
  };

  for (const match of text.matchAll(TRADINGVIEW_URL_RE)) {
    add(match[1] ?? "", true);
  }
  for (const match of text.matchAll(HASHTAG_RE)) {
    const tag = match[1] ?? "";
    // Pattern/status hashtags are intentionally lowercase. Ticker tags are
    // emitted in uppercase by tickerTag(), so this avoids linking #STOP_LOSS
    // or other operational labels.
    if (tag === tag.toUpperCase()) add(tag);
  }
  for (const match of text.matchAll(PAIR_RE)) {
    add(match[1] ?? "");
  }

  return { symbols, linkedSymbols };
}

export function tradingViewUrl(symbol: string): string {
  const base = normalizeSymbol(symbol);
  if (!base) {
    throw new Error(`Invalid TradingView symbol: ${symbol}`);
  }
  return `https://www.tradingview.com/chart/?symbol=BINGX:${base}USDT.P`;
}

export function bingXMarketUrl(symbol: string): string {
  const base = normalizeSymbol(symbol);
  if (!base) throw new Error(`Invalid BingX symbol: ${symbol}`);
  return `https://bingx.com/en-us/perpetual/${base}-USDT/`;
}

export function openInterestUrl(symbol: string): string {
  const base = normalizeSymbol(symbol);
  if (!base) throw new Error(`Invalid OI symbol: ${symbol}`);
  return `https://www.coinglass.com/tv/${encodeURIComponent(base)}`;
}

function escapeHref(url: string): string {
  return url.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

export function formatMarketLinks(
  symbol: string,
  urls: {
    chart?: string;
    bingX?: string;
    oi?: string;
  } = {},
): string {
  return (
    `🔗 <a href="${escapeHref(urls.chart ?? tradingViewUrl(symbol))}">Chart</a> · ` +
    `<a href="${escapeHref(urls.bingX ?? bingXMarketUrl(symbol))}">BingX</a> · ` +
    `<a href="${escapeHref(urls.oi ?? openInterestUrl(symbol))}">OI</a>`
  );
}

/**
 * Adds the canonical market-link row for every ticker in a Telegram message.
 * Existing TradingView links are recognized by symbol, so retries and messages
 * that already contain the row are not modified twice.
 */
export function appendTradingViewLinks(
  text: string,
  maxLength?: number,
): string {
  if (text.includes(NO_CHART_LINKS_MARKER)) {
    return text.split(NO_CHART_LINKS_MARKER).join("");
  }
  const { symbols, linkedSymbols } = collectSymbols(text);
  const missing = symbols.filter((symbol) => !linkedSymbols.has(symbol));
  if (missing.length === 0) return text;

  const suffix = [
    "",
    ...missing.map((symbol) => formatMarketLinks(symbol)),
  ].join("\n");
  const enriched = `${text}${suffix}`;
  if (maxLength == null || enriched.length <= maxLength) return enriched;

  // Keep the chart link even when a caller passes a message close to
  // Telegram's limit. The normal outbox splits before delivery, so this is
  // only a defensive boundary for direct sends and photo captions.
  const availableTextLength = Math.max(0, maxLength - suffix.length);
  const truncated = text.slice(0, availableTextLength).trimEnd();
  return `${truncated}${suffix}`;
}

/**
 * Marks every report line so the marker survives caption/continuation
 * splitting in the durable Telegram photo outbox. The marker is removed just
 * before delivery; ordinary messages keep the default auto-link behavior.
 */
export function withoutTradingViewLinks(text: string): string {
  return text
    .split("\n")
    .map((line) => `${NO_CHART_LINKS_MARKER}${line}`)
    .join("\n");
}
