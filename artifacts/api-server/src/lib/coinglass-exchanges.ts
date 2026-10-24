/**
 * Full CoinGlass exchange sets (GET /api/{spot,futures}/supported-exchange-pairs).
 * Owner rule: every metric that needs `exchange_list` uses ALL supported
 * exchanges. The lists are refreshed daily; if a refresh fails the last
 * successfully loaded list stays in use (this is a list of exchanges, not
 * market data) and a warning is logged.
 */
import { logger } from "./logger.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";

const INITIAL_SPOT =
  "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";
const INITIAL_FUTURES =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";

let spotList = INITIAL_SPOT;
let futuresList = INITIAL_FUTURES;

/** Comma list of all supported spot exchanges (current). */
export function getAllSpotExchanges(): string {
  return spotList;
}
/** Comma list of all supported futures exchanges (current). */
export function getAllFuturesExchanges(): string {
  return futuresList;
}

const REFRESH_MS = 24 * 60 * 60 * 1000;

async function loadList(
  kind: "spot" | "futures",
  current: string,
): Promise<string> {
  const apiKey = getNextCgKey();
  if (!apiKey) throw new Error("no CoinGlass key");
  const res = await cgTimedFetch(
    `https://open-api-v4.coinglass.com/api/${kind}/supported-exchange-pairs`,
    {
      headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    code?: string;
    data?: Record<string, unknown>;
  };
  const names = Object.keys(body.data ?? {});
  if (body.code !== "0" || names.length === 0)
    throw new Error(`code=${String(body.code)} exchanges=${names.length}`);
  names.sort((a, b) => a.localeCompare(b));
  const next = names.join(",");
  if (next !== current) {
    const before = new Set(current.split(","));
    const after = new Set(names);
    logger.info(
      {
        kind,
        added: names.filter((n) => !before.has(n)),
        removed: [...before].filter((n) => !after.has(n)),
        total: names.length,
      },
      "CoinGlass exchange list changed",
    );
  }
  return next;
}

export async function refreshExchangeLists(): Promise<void> {
  for (const kind of ["spot", "futures"] as const) {
    try {
      const next = await loadList(
        kind,
        kind === "spot" ? spotList : futuresList,
      );
      if (kind === "spot") spotList = next;
      else futuresList = next;
    } catch (err) {
      logger.warn(
        { err, kind },
        "CoinGlass exchange list refresh failed — keeping last loaded list",
      );
    }
  }
}

let started = false;
export function startExchangeListRefresher(): void {
  if (started) return;
  started = true;
  void refreshExchangeLists();
  setInterval(() => void refreshExchangeLists(), REFRESH_MS).unref();
}
