import { logger } from "./logger.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { applyCgAlias } from "./cg-symbol-alias.js";
import { runWithoutMemo } from "./coinglass-memo.js";

/**
 * Aggregated (CoinGlass, all exchanges) 24h futures volume in USD per coin.
 * futures/coins-markets has no volume field; volume = open_interest_usd /
 * open_interest_volume_ratio. No BingX volume is ever used or substituted:
 * a coin missing here has unknown volume (0).
 */
const TTL_MS = 5 * 60_000;
const PAGE_SIZE = 200;
// 1200+ coins exist (6+ pages of 200); stop at the first short page.
const MAX_PAGES = 15;

/** One coins-markets row: aggregated (all-exchange) OI and its changes. */
export interface CoinsMarketsOiRow {
  oiUsd: number;
  mcapUsd: number | null;
  oiChange30m: number | null;
  oiChange1h: number | null;
  oiChange4h: number | null;
  oiChange24h: number | null;
}
let oiRows = new Map<string, CoinsMarketsOiRow>();

let cache: { ts: number; data: Map<string, number> } | null = null;
let inflight: Promise<void> | null = null;

export interface SnapshotPageStat {
  page: number;
  ms: number;
  rows: number;
  attempts: number;
}
export interface SnapshotLoadStat {
  trigger: string;
  startedAt: number;
  totalMs: number;
  ok: boolean;
  rows: number;
  pages: SnapshotPageStat[];
  error?: string;
}
let loadStats: SnapshotLoadStat[] = [];
/** Snapshot loads since the last call (one scanner cycle). */
export function drainCoinsMarketsLoadStats(): SnapshotLoadStat[] {
  const out = loadStats;
  loadStats = [];
  return out;
}

type CoinsMarketsPageJson = {
  code: string;
  msg?: string;
  data?: Array<{
    symbol?: string;
    open_interest_usd?: number;
    open_interest_volume_ratio?: number;
    market_cap_usd?: number;
    open_interest_change_percent_30m?: number;
    open_interest_change_percent_1h?: number;
    open_interest_change_percent_4h?: number;
    open_interest_change_percent_24h?: number;
  }>;
};

async function fetchPage(
  page: number,
  fresh: boolean,
): Promise<{ json: CoinsMarketsPageJson; attempts: number }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const apiKey = getNextCgKey();
    if (!apiKey) throw new Error("coins-markets: no CoinGlass key");
    try {
      const doFetch = () =>
        cgTimedFetch(
          `https://open-api-v4.coinglass.com/api/futures/coins-markets?per_page=${PAGE_SIZE}&page=${page}`,
          {
            headers: { "CG-API-KEY": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          },
          { priority: "critical" },
        );
      // The cycle snapshot must be live data, not a memoised response.
      const res = await (fresh ? runWithoutMemo(doFetch) : doFetch());
      if (!res.ok) throw new Error(`coins-markets HTTP ${res.status}`);
      const json = (await res.json()) as CoinsMarketsPageJson;
      if (json.code !== "0" || !json.data) {
        throw new Error(`coins-markets API ${json.code} ${json.msg ?? ""}`);
      }
      return { json, attempts: attempt };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function load(trigger: string, fresh: boolean): Promise<void> {
  const data = new Map<string, number>();
  const rowsByBase = new Map<string, CoinsMarketsOiRow>();
  const stat: SnapshotLoadStat = {
    trigger,
    startedAt: Date.now(),
    totalMs: 0,
    ok: false,
    rows: 0,
    pages: [],
  };
  loadStats.push(stat);
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const t0 = Date.now();
      const { json, attempts } = await fetchPage(page, fresh);
      const rows = json.data!;
      stat.pages.push({
        page,
        ms: Date.now() - t0,
        rows: rows.length,
        attempts,
      });
      for (const row of rows) {
        const oi = Number(row.open_interest_usd);
        const ratio = Number(row.open_interest_volume_ratio);
        if (row.symbol && oi > 0 && ratio > 0) {
          data.set(row.symbol.toUpperCase(), oi / ratio);
        }
        if (row.symbol && oi > 0) {
          const num = (x: unknown): number | null =>
            x == null || !Number.isFinite(Number(x)) ? null : Number(x);
          const mcap = num(row.market_cap_usd);
          rowsByBase.set(row.symbol.toUpperCase(), {
            oiUsd: oi,
            mcapUsd: mcap != null && mcap > 0 ? mcap : null,
            oiChange30m: num(row.open_interest_change_percent_30m),
            oiChange1h: num(row.open_interest_change_percent_1h),
            oiChange4h: num(row.open_interest_change_percent_4h),
            oiChange24h: num(row.open_interest_change_percent_24h),
          });
        }
      }
      stat.rows += rows.length;
      if (rows.length < PAGE_SIZE) break;
    }
    if (data.size > 0) cache = { ts: Date.now(), data };
    if (rowsByBase.size > 0) {
      oiRows = rowsByBase;
      oiRowsAt = Date.now();
    }
    stat.ok = true;
  } catch (err) {
    stat.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    stat.totalMs = Date.now() - stat.startedAt;
  }
}
let oiRowsAt = 0;

/**
 * Refreshes the bulk coins-markets snapshot when older than maxAgeMs. Shared
 * with the 24h volume map: one set of pages serves both. Never throws.
 */
export async function refreshCoinsMarketsOi(maxAgeMs: number): Promise<void> {
  if (Date.now() - oiRowsAt < maxAgeMs) return;
  inflight ??= load("refresh", false)
    .catch((err) =>
      logger.warn({ err }, "CoinGlass coins-markets OI refresh failed"),
    )
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

export type CoinsMarketsSnapshot = {
  rows: ReadonlyMap<string, CoinsMarketsOiRow>;
  loadedAt: number;
};

/**
 * Loads one fresh, complete coins-markets snapshot (all pages, critical
 * priority, memo bypassed) and returns it. The caller keeps the returned map
 * for the whole scan cycle, so later refreshes by other jobs cannot change or
 * age it mid-cycle. Returns null (and logs) when the load fails.
 */
export async function loadCycleCoinsMarketsSnapshot(
  signal?: AbortSignal,
): Promise<CoinsMarketsSnapshot | null> {
  // A 429 / transient failure of the single per-cycle load must not leave the
  // whole cycle without current OI: retry a few times with a pause.
  const MAX_ATTEMPTS = 4;
  const RETRY_PAUSE_MS = 15_000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) return null;
    // A load already running may have started earlier, at a lower priority and
    // from a memoised response: wait for it, then always load a fresh one.
    while (inflight) await inflight;
    const startedAt = Date.now();
    inflight = load("cycle-start", true)
      .catch((err) =>
        logger.warn(
          { err, attempt },
          "CoinGlass cycle coins-markets snapshot failed",
        ),
      )
      .finally(() => {
        inflight = null;
      });
    await inflight;
    if (oiRowsAt >= startedAt) return { rows: oiRows, loadedAt: oiRowsAt };
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
    }
  }
  return null;
}

/** Row lookup in a pinned snapshot map (CoinGlass alias applied). */
export function coinsMarketsRowFrom(
  rows: ReadonlyMap<string, CoinsMarketsOiRow>,
  bingxSymbolOrBase: string,
): CoinsMarketsOiRow | null {
  const base = bingxSymbolOrBase.replace(/-?USDT$/, "").toUpperCase();
  return rows.get(applyCgAlias(base).toUpperCase()) ?? rows.get(base) ?? null;
}

/** Bulk aggregated OI row for a CoinGlass base ticker (alias applied); null if absent. */
export function getCoinsMarketsOiRow(
  bingxSymbolOrBase: string,
  maxAgeMs = 5 * 60_000,
): CoinsMarketsOiRow | null {
  if (Date.now() - oiRowsAt > maxAgeMs) return null;
  const base = bingxSymbolOrBase.replace(/-?USDT$/, "").toUpperCase();
  return (
    oiRows.get(applyCgAlias(base).toUpperCase()) ?? oiRows.get(base) ?? null
  );
}

/** Refreshes the bulk aggregated volume map when stale. Never throws. */
export async function refreshAggregatedVolume24h(): Promise<void> {
  if (cache && Date.now() - cache.ts < TTL_MS) return;
  inflight ??= load("volume24h", false)
    .catch((err) =>
      logger.warn({ err }, "CoinGlass aggregated 24h volume refresh failed"),
    )
    .finally(() => {
      inflight = null;
    });
  await inflight;
}

/** Aggregated 24h futures volume (USD) for a BingX symbol; 0 when unknown. */
export function aggregatedVolume24hUsd(bingxSymbol: string): number {
  if (!cache) return 0;
  const base = bingxSymbol.replace(/-?USDT$/, "").toUpperCase();
  return (
    cache.data.get(applyCgAlias(base).toUpperCase()) ??
    cache.data.get(base) ??
    0
  );
}
