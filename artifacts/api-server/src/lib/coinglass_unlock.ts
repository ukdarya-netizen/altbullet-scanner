/**
 * CoinGlass — Token Unlock Calendar.
 *
 * Fetches upcoming token unlock events from CoinGlass /api/coin/unlock-list.
 * Used to block or warn signals when a large unlock is imminent.
 *
 * Block logic (called from performScan):
 *   daysUntil ≤ 3 AND pctSupply ≥ 1% → block signal (log to missed_signals_log)
 *   daysUntil 4–7 AND pctSupply ≥ 1% → warn in Telegram alert
 *   Watchlist exempt from block (Layer 0) but still gets warning.
 *
 * Cache: 4h (unlock dates change infrequently).
 * No fail-open: returns null on any API error or missing key.
 */

import { logger } from "./logger.js";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import { db } from "@workspace/db";
import { rehydrateUnlocks, type UnlockInfo } from "./unlock-rehydrate.js";
import { sql } from "drizzle-orm";

export type { UnlockInfo };

const CACHE_TTL_MS = 4 * 3600_000; // 4h

// Calendar data: the last successfully loaded list stays usable for 24h when
// CoinGlass is unreachable (owner 2026-10-19). Older than that: unavailable.
const SNAPSHOT_MAX_AGE_MS = 24 * 3600_000;

let _cache: Map<string, UnlockInfo> | null = null;
let _cacheAt = 0;
let _snapshotSchemaReady = false;

async function ensureSnapshotTable(): Promise<void> {
  if (_snapshotSchemaReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS unlock_list_snapshot (
      id integer PRIMARY KEY,
      fetched_at timestamptz NOT NULL,
      payload jsonb NOT NULL
    )
  `);
  _snapshotSchemaReady = true;
}

async function persistSnapshot(
  list: Map<string, UnlockInfo>,
  at: number,
): Promise<void> {
  try {
    await ensureSnapshotTable();
    await db.execute(sql`
      INSERT INTO unlock_list_snapshot (id, fetched_at, payload)
      VALUES (1, to_timestamp(${at / 1000.0}), ${JSON.stringify([...list])}::jsonb)
      ON CONFLICT (id) DO UPDATE
        SET fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload
    `);
  } catch (err) {
    logger.warn({ err }, "Unlock list snapshot not persisted");
  }
}

async function loadSnapshot(
  now: number,
): Promise<Map<string, UnlockInfo> | null> {
  try {
    await ensureSnapshotTable();
    const res = await db.execute(sql`
      SELECT (EXTRACT(EPOCH FROM fetched_at) * 1000)::bigint AS at, payload
      FROM unlock_list_snapshot WHERE id = 1
    `);
    const row = res.rows[0] as
      | { at: string | number; payload: Array<[string, UnlockInfo]> }
      | undefined;
    if (!row) return null;
    const at = Number(row.at);
    if (!Number.isFinite(at) || now - at > SNAPSHOT_MAX_AGE_MS) return null;
    const list = rehydrateUnlocks(row.payload, now);
    _cache = list;
    _cacheAt = at;
    logger.info(
      { ageMin: Math.round((now - at) / 60_000), symbols: list.size },
      "Unlock list restored from stored snapshot",
    );
    return list;
  } catch (err) {
    logger.warn({ err }, "Unlock list snapshot unavailable");
    return null;
  }
}

// CoinGlass unlock row — field names may vary between API versions
interface CgUnlockRow {
  token?: string;
  symbol?: string;
  tokenSymbol?: string;
  unlockTime?: number;
  unlockTimestamp?: number;
  unlockDate?: string;
  percentage?: number;
  unlockPercent?: number;
  ratio?: number;
  supplyRatio?: number;
  amount?: number;
  unlockAmount?: number;
  type?: string;
  name?: string;
  // /api/coin/unlock-list (v4) fields
  next_unlock_date?: number;
  next_unlock_of_circulating?: number;
}

function parseRow(
  row: CgUnlockRow,
  now: number,
): { baseSymbol: string; info: UnlockInfo } | null {
  const rawSym = row.token ?? row.symbol ?? row.tokenSymbol;
  if (!rawSym || typeof rawSym !== "string") return null;
  // CoinGlass unlock API returns base symbols (e.g. "SUI", "OP", "ARB").
  // BingX symbols are "SUI-USDT" — we strip the suffix to get the base.
  // This is identical to toCgSymbol() in coinglass_spot_cvd.ts.
  // No separate alias table exists in the codebase; if a non-standard
  // CG ticker is discovered, add the token to watchlist (Layer 0 exempt) as a workaround.
  const baseSymbol = rawSym
    .toUpperCase()
    .trim()
    .replace(/USDT$/, "")
    .replace(/-$/, "");
  if (!baseSymbol) return null;

  // Parse unlock timestamp (CoinGlass may return seconds or ms)
  let tsMs: number | null = null;
  if (
    row.next_unlock_date != null &&
    typeof row.next_unlock_date === "number"
  ) {
    tsMs =
      row.next_unlock_date > 1e12
        ? row.next_unlock_date
        : row.next_unlock_date * 1000;
  } else if (row.unlockTime != null && typeof row.unlockTime === "number") {
    tsMs = row.unlockTime > 1e12 ? row.unlockTime : row.unlockTime * 1000;
  } else if (
    row.unlockTimestamp != null &&
    typeof row.unlockTimestamp === "number"
  ) {
    tsMs =
      row.unlockTimestamp > 1e12
        ? row.unlockTimestamp
        : row.unlockTimestamp * 1000;
  } else if (row.unlockDate && typeof row.unlockDate === "string") {
    const d = Date.parse(row.unlockDate);
    if (!isNaN(d)) tsMs = d;
  }
  if (tsMs == null) return null;

  // Skip already-passed events (allow up to 1h grace)
  if (tsMs < now - 3_600_000) return null;

  // Parse percentage of circulating supply
  const pct =
    row.next_unlock_of_circulating ??
    row.percentage ??
    row.unlockPercent ??
    row.ratio ??
    row.supplyRatio;
  if (pct == null || typeof pct !== "number" || pct <= 0) return null;

  const daysUntil = Math.max(0, Math.floor((tsMs - now) / 86_400_000));

  return {
    baseSymbol,
    info: { daysUntil, pctSupply: pct, unlockTime: tsMs },
  };
}

/**
 * Returns a Map<baseSymbol, UnlockInfo> for all tokens with upcoming unlocks.
 * baseSymbol matches BingX symbol without the "-USDT" suffix (e.g. "SUI", "OP").
 * Cached for 4h (fresh cache only). Returns null when the list is unavailable:
 * callers must refuse to signal (owner rule 2026-10-18, no fail-open).
 */
export async function getUpcomingUnlocks(): Promise<Map<
  string,
  UnlockInfo
> | null> {
  // A restart empties the cache; one failed request then refuses every
  // symbol for the whole cycle (2026-10-19 11:09: 356 symbols). Retry a few
  // times before reporting the list as unavailable. Still no fail-open.
  const delays = [0, 3_000, 8_000];
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const result = await fetchUpcomingUnlocksOnce();
    if (result !== null) return result;
  }
  const now = Date.now();
  if (_cache !== null && now - _cacheAt <= SNAPSHOT_MAX_AGE_MS) {
    return rehydrateUnlocks([..._cache], now);
  }
  return loadSnapshot(now);
}

async function fetchUpcomingUnlocksOnce(): Promise<Map<
  string,
  UnlockInfo
> | null> {
  const now = Date.now();
  if (_cache !== null && now - _cacheAt < CACHE_TTL_MS) return _cache;

  const emptyOnError = null;

  const key = getNextCgKey();
  if (!key) {
    logger.warn(
      "CoinGlass coin-unlock-list: no API key available — unlock data unavailable",
    );
    return emptyOnError;
  }

  try {
    // The old path /api/coin-unlock-list answers 404; the v4 endpoint is
    // /api/coin/unlock-list (100 rows per page by default, 1000 returns all).
    const url =
      "https://open-api-v4.coinglass.com/api/coin/unlock-list?per_page=1000";
    const resp = await cgTimedFetch(url, {
      headers: { "CG-API-KEY": key },
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        "CoinGlass coin-unlock-list: non-2xx — unlock data unavailable",
      );
      return emptyOnError;
    }

    const json = (await resp.json()) as {
      code?: string;
      msg?: string;
      data?: CgUnlockRow[] | { list?: CgUnlockRow[] };
    };

    // Handle both flat array and nested {list: [...]} structures
    let rows: CgUnlockRow[] | undefined;
    if (Array.isArray(json.data)) {
      rows = json.data;
    } else if (
      json.data &&
      typeof json.data === "object" &&
      Array.isArray((json.data as { list?: CgUnlockRow[] }).list)
    ) {
      rows = (json.data as { list: CgUnlockRow[] }).list;
    }

    if (!rows) {
      logger.warn(
        { code: json.code },
        "CoinGlass coin-unlock-list: unexpected structure — unlock data unavailable",
      );
      return emptyOnError;
    }

    const result = new Map<string, UnlockInfo>();
    for (const row of rows) {
      const parsed = parseRow(row, now);
      if (!parsed) continue;
      // Keep the soonest upcoming unlock if multiple events exist for one token
      const existing = result.get(parsed.baseSymbol);
      if (!existing || parsed.info.daysUntil < existing.daysUntil) {
        result.set(parsed.baseSymbol, parsed.info);
      }
    }

    _cache = result;
    _cacheAt = now;
    void persistSnapshot(result, now);
    logger.info(
      { total: rows.length, withUnlock: result.size },
      "CoinGlass coin-unlock-list: fetched OK",
    );
    return result;
  } catch (err) {
    logger.warn(
      { err },
      "CoinGlass coin-unlock-list: fetch error — unlock data unavailable",
    );
    return emptyOnError;
  }
}

/** Force-clears the cache (for admin refresh). */
export function clearUnlockCache(): void {
  _cache = null;
  _cacheAt = 0;
}
