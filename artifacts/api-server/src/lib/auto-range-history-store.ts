import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { BingXKline } from "./bingx.js";

/**
 * Durable copy of the Auto Range history cache. Without it every restart or
 * publish empties the in-memory cache and symbols wait hours for warmup
 * (range_*_insufficient_history_queued_never_fetched).
 */
export const AUTO_RANGE_HISTORY_MAX_AGE_MS = 7 * 24 * 3_600_000;
const RESAVE_AFTER_MS = 12 * 3_600_000;
const savedAt = new Map<string, number>();

export async function ensureAutoRangeHistoryStoreSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS auto_range_history_cache (
      cache_key text PRIMARY KEY,
      last_fetch_at bigint NOT NULL,
      candle_count integer NOT NULL,
      candles text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

type Row = [number, number, number, number, number, number];

function pack(candles: readonly BingXKline[]): string {
  const rows: Row[] = candles.map((c) => [
    c.time,
    Number(c.open),
    Number(c.high),
    Number(c.low),
    Number(c.close),
    Number(c.volume),
  ]);
  return JSON.stringify(rows);
}

function unpack(text: string): BingXKline[] {
  return (JSON.parse(text) as Row[]).map((r) => ({
    time: r[0],
    open: String(r[1]),
    high: String(r[2]),
    low: String(r[3]),
    close: String(r[4]),
    volume: String(r[5]),
  }));
}

export async function saveAutoRangeHistory(
  key: string,
  candles: readonly BingXKline[],
  lastFetchAt: number,
): Promise<void> {
  if (candles.length === 0 || lastFetchAt <= 0) return;
  await db.execute(sql`
    INSERT INTO auto_range_history_cache
      (cache_key, last_fetch_at, candle_count, candles, updated_at)
    VALUES (${key}, ${lastFetchAt}, ${candles.length}, ${pack(candles)}, now())
    ON CONFLICT (cache_key) DO UPDATE SET
      last_fetch_at = EXCLUDED.last_fetch_at,
      candle_count = EXCLUDED.candle_count,
      candles = EXCLUDED.candles,
      updated_at = now()
  `);
  savedAt.set(key, Date.now());
}

/** True when this key has not been persisted recently (for periodic refresh). */
export function needsResave(key: string, now = Date.now()): boolean {
  return now - (savedAt.get(key) ?? 0) > RESAVE_AFTER_MS;
}

/** Loads rows in small pages so startup memory stays bounded. */
export async function loadAutoRangeHistory(
  onRow: (key: string, candles: BingXKline[], lastFetchAt: number) => void,
  now = Date.now(),
): Promise<{ loaded: number; skippedStale: number }> {
  const keys = await db.execute(sql`
    SELECT cache_key, last_fetch_at FROM auto_range_history_cache
  `);
  let loaded = 0;
  let skippedStale = 0;
  const fresh: string[] = [];
  for (const r of keys.rows as Array<{
    cache_key: string;
    last_fetch_at: string | number;
  }>) {
    if (now - Number(r.last_fetch_at) > AUTO_RANGE_HISTORY_MAX_AGE_MS) {
      skippedStale++;
    } else fresh.push(r.cache_key);
  }
  for (let i = 0; i < fresh.length; i += 25) {
    const page = fresh.slice(i, i + 25);
    const res = await db.execute(sql`
      SELECT cache_key, last_fetch_at, candles FROM auto_range_history_cache
      WHERE cache_key IN (${sql.join(
        page.map((k) => sql`${k}`),
        sql`, `,
      )})
    `);
    for (const r of res.rows as Array<{
      cache_key: string;
      last_fetch_at: string | number;
      candles: string;
    }>) {
      onRow(r.cache_key, unpack(r.candles), Number(r.last_fetch_at));
      savedAt.set(r.cache_key, Date.now());
      loaded++;
    }
  }
  return { loaded, skippedStale };
}
