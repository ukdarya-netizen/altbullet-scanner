import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getNextCgKey } from "../../artifacts/api-server/src/lib/coinglass_keys.js";
import { cgTimedFetch } from "../../artifacts/api-server/src/lib/cg_latency.js";
import { applyCgAlias } from "../../artifacts/api-server/src/lib/cg-symbol-alias.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = resolve(rootDir, "reports/.cache");
const progressPath = resolve(rootDir, "reports/miss-1119/volume-tail-progress.jsonl");
const symbols = ["FTR-USDT", "IRYS-USDT", "LUNC-USDT", "PIPPIN-USDT", "SENT-USDT", "VELVET-USDT"];
const end = Date.parse("2026-11-19T12:00:00Z");
const hour = 60 * 60_000;
const minGapMs = 4_100;
const retryPauseMs = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let lastStartedAt = 0;
let requests = 0;
let retries429 = 0;

const FUT_LIST =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
const SPOT_LIST = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";

type Item = { time: number; buy: number; sell: number; cvd?: number };

async function readCache(symbol: string, source: "aggfut" | "aggspot") {
  const path = resolve(cacheDir, `${symbol}_cg_${source}.json`);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { path, value: { ...value, items: Array.isArray(value.items) ? value.items as Item[] : [] } };
  } catch {
    return { path, value: { from: end - 24 * hour, to: end, items: [] as Item[] } };
  }
}

async function fetchTail(symbol: string, source: "aggfut" | "aggspot") {
  const cache = await readCache(symbol, source);
  const items = cache.value.items as Item[];
  if (items.length === 0 && cache.value.to >= end) {
    return { symbol, source, result: "empty_cache", fetched: 0 };
  }
  const last = items.reduce((m, item) => Math.max(m, item.time), 0);
  if (last >= end - hour) return { symbol, source, result: "cache_hit", fetched: 0, last: new Date(last).toISOString() };
  const from = last > 0 ? last + hour : end - 24 * hour;
  const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
  const url = new URL(
    source === "aggfut"
      ? "https://open-api-v4.coinglass.com/api/futures/aggregated-taker-buy-sell-volume/history"
      : "https://open-api-v4.coinglass.com/api/spot/aggregated-cvd/history",
  );
  url.searchParams.set("symbol", base);
  url.searchParams.set("interval", "1h");
  url.searchParams.set("start_time", String(from));
  url.searchParams.set("end_time", String(end));
  url.searchParams.set("limit", String(Math.ceil((end - from) / hour) + 4));
  url.searchParams.set("exchange_list", source === "aggfut" ? FUT_LIST : SPOT_LIST);

  let body: any;
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastStartedAt + minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartedAt = Date.now();
    requests++;
    await appendFile(progressPath, JSON.stringify({
      symbol,
      source,
      event: "request_start",
      attempt: attempt + 1,
      at: new Date(lastStartedAt).toISOString(),
      requests,
    }) + "\n");
    const key = getNextCgKey();
    if (!key) throw new Error("CoinGlass key unavailable to the standalone study process");
    const response = await cgTimedFetch(
      url.toString(),
      { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
      { priority: "low", endpoint: source === "aggfut" ? "futures/aggregated-taker-buy-sell-volume/history" : "spot/aggregated-cvd/history" },
    );
    status = response.status;
    body = await response.json().catch(() => null);
    if (status === 429 || String(body?.code ?? "") === "429") {
      retries429++;
      await appendFile(progressPath, JSON.stringify({
        symbol,
        source,
        event: "rate_limited_pause",
        attempt: attempt + 1,
        at: new Date().toISOString(),
        pause_ms: retryPauseMs,
      }) + "\n");
      if (attempt === 2) throw new Error(`CoinGlass rate limited ${symbol}/${source} after 3 attempts`);
      await sleep(retryPauseMs);
      continue;
    }
    if (!response.ok || String(body?.code) !== "0") {
      throw new Error(`CoinGlass request failed for ${symbol}/${source}: HTTP ${status}, API code ${String(body?.code ?? "missing")}`);
    }
    break;
  }

  const rows = Array.isArray(body?.data) ? body.data : [];
  const fetched: Item[] = rows.map((row: any) => {
    const rawTime = Number(row.time);
    return source === "aggfut"
      ? {
          time: rawTime < 1e12 ? rawTime * 1000 : rawTime,
          buy: Number(row.aggregated_buy_volume_usd),
          sell: Number(row.aggregated_sell_volume_usd),
        }
      : {
          time: rawTime < 1e12 ? rawTime * 1000 : rawTime,
          buy: Number(row.agg_taker_buy_vol),
          sell: Number(row.agg_taker_sell_vol),
          cvd: Number(row.cum_vol_delta),
        };
  }).filter((item: Item) => Number.isFinite(item.time) && Number.isFinite(item.buy) && Number.isFinite(item.sell));
  const merged = new Map<number, Item>();
  for (const item of items) merged.set(item.time, item);
  for (const item of fetched) merged.set(item.time, item);
  const allItems = [...merged.values()].sort((a, b) => a.time - b.time);
  await mkdir(dirname(cache.path), { recursive: true });
  await writeFile(cache.path, JSON.stringify({
    from: Math.min(Number(cache.value.from) || from, from),
    to: Math.max(Number(cache.value.to) || end, end),
    items: allItems,
  }));
  const result = {
    symbol,
    source,
    result: fetched.length ? "fetched" : "empty_response",
    fetched: fetched.length,
    first: fetched.length ? new Date(fetched[0].time).toISOString() : null,
    last: fetched.length ? new Date(fetched[fetched.length - 1].time).toISOString() : null,
  };
  await appendFile(progressPath, JSON.stringify({ ...result, event: "request_complete", requests }) + "\n");
  return result;
}

async function main() {
  const manifest = [];
  await mkdir(dirname(progressPath), { recursive: true });
  await writeFile(progressPath, "");
  for (const symbol of symbols) {
    const result = await fetchTail(symbol, "aggfut");
    manifest.push(result);
    console.log(JSON.stringify(result));
  }
  for (const symbol of symbols) {
    const cache = await readCache(symbol, "aggspot");
    if (cache.value.items.length === 0) {
      const result = { symbol, source: "aggspot", result: "no_cached_spot_data", fetched: 0 };
      manifest.push(result);
      console.log(JSON.stringify(result));
      continue;
    }
    const result = await fetchTail(symbol, "aggspot");
    manifest.push(result);
    console.log(JSON.stringify(result));
  }
  await writeFile(
    resolve(rootDir, "reports/miss-1119/volume-tail-fetch-manifest.json"),
    JSON.stringify({ requests, retries429, manifest }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ requests, retries429, manifest }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
