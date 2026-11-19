import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getNextCgKey } from "../../artifacts/api-server/src/lib/coinglass_keys.js";
import { cgTimedFetch } from "../../artifacts/api-server/src/lib/cg_latency.js";
import { applyCgAlias } from "../../artifacts/api-server/src/lib/cg-symbol-alias.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cacheDir = resolve(rootDir, "reports/.cache");
const symbols = ["FTR-USDT", "IRYS-USDT", "LUNC-USDT", "PIPPIN-USDT", "SENT-USDT", "VELVET-USDT"];
const start = Date.parse("2026-11-13T00:00:00Z");
const end = Date.parse("2026-11-19T12:00:00Z");
const minGapMs = 4_100;
const retryPauseMs = 5 * 60_000;
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let lastStartedAt = 0;
let requests = 0;
let retries429 = 0;

async function cached(symbol: string) {
  const path = resolve(cacheDir, `${symbol}_cg15m_oi.json`);
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    const complete =
      value.from <= start &&
      value.to >= end &&
      Array.isArray(value.items) &&
      value.items.some((item: any) => item.time <= start) &&
      value.items.some((item: any) => item.time >= end - 15 * 60_000);
    return { path, value, complete };
  } catch {
    // Missing or partial cache is fetched below.
  }
  return { path, value: null, complete: false };
}

async function main() {
  const key = getNextCgKey();
  if (!key) throw new Error("CoinGlass key unavailable to the standalone study process");
  await mkdir(cacheDir, { recursive: true });
  const manifest: Array<{ symbol: string; result: string; points?: number; first?: string; last?: string }> = [];

  for (const symbol of symbols) {
    const existing = await cached(symbol);
    if (existing.complete && existing.value) {
      const items = existing.value.items;
      manifest.push({
        symbol,
        result: "cache_hit",
        points: items.length,
        first: new Date(items[0].time).toISOString(),
        last: new Date(items[items.length - 1].time).toISOString(),
      });
      continue;
    }

    const base = applyCgAlias(symbol.replace(/-?USDT$/i, "").toUpperCase());
    const url = new URL("https://open-api-v4.coinglass.com/api/futures/open-interest/aggregated-history");
    url.searchParams.set("symbol", base);
    url.searchParams.set("interval", "15m");
    url.searchParams.set("limit", "600");
    let body: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = lastStartedAt + minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStartedAt = Date.now();
      requests++;
      const response = await cgTimedFetch(
        url.toString(),
        { headers: { "CG-API-KEY": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) },
        { priority: "low", endpoint: "futures/open-interest/aggregated-history" },
      );
      body = await response.json().catch(() => null);
      const limited = response.status === 429 || String(body?.code ?? "") === "429";
      if (limited) {
        retries429++;
        if (attempt === 2) throw new Error(`CoinGlass rate limited ${symbol} after 3 attempts`);
        await sleep(retryPauseMs);
        continue;
      }
      if (!response.ok || String(body?.code) !== "0") {
        throw new Error(`CoinGlass request failed for ${symbol}: HTTP ${response.status}, API code ${String(body?.code ?? "missing")}`);
      }
      break;
    }

    const rows = Array.isArray(body?.data) ? body.data : [];
    const fetchedItems = rows
      .map((row: any) => {
        const rawTime = Number(row.time);
        return { time: rawTime < 1e12 ? rawTime * 1000 : rawTime, value: Number(row.close) };
      })
      .filter((row: { time: number; value: number }) => Number.isFinite(row.time) && Number.isFinite(row.value) && row.value > 0)
      .sort((a: { time: number }, b: { time: number }) => a.time - b.time);
    const path = resolve(cacheDir, `${symbol}_cg15m_oi.json`);
    const merged = new Map<number, number>();
    for (const item of existing.value?.items ?? []) {
      if (Number.isFinite(item.time) && Number.isFinite(item.value) && item.value > 0) merged.set(item.time, item.value);
    }
    for (const item of fetchedItems) merged.set(item.time, item.value);
    const items = [...merged.entries()]
      .map(([time, value]) => ({ time, value }))
      .sort((a, b) => a.time - b.time);
    const payload = {
      from: Math.min(existing.value?.from ?? start, start),
      to: Math.max(existing.value?.to ?? end, end),
      items,
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload));
    manifest.push({
      symbol,
      result: items.length ? "fetched" : "empty",
      points: items.length,
      first: items.length ? new Date(items[0].time).toISOString() : undefined,
      last: items.length ? new Date(items[items.length - 1].time).toISOString() : undefined,
    });
  }

  await writeFile(resolve(rootDir, "reports/miss-1119/oi15m-fetch-manifest.json"), JSON.stringify({ requests, retries429, manifest }, null, 2) + "\n");
  console.log(JSON.stringify({ requests, retries429, manifest }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
