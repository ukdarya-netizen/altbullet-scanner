import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getFutureTicker } from "./bingx.js";
import { logger } from "./logger.js";

export const BTC_REGIME_LEASE = "btc-regime-observation";

function utcBucket(date = new Date()): Date {
  return new Date(Math.floor(date.getTime() / (30 * 60_000)) * (30 * 60_000));
}

export async function collectBtcRegimeObservation(): Promise<void> {
  const bucketAt = utcBucket();
  const ticker = await getFutureTicker("BTC-USDT").catch(() => null);
  const price =
    ticker && Number.isFinite(Number(ticker.lastPrice))
      ? Number(ticker.lastPrice)
      : null;
  const fetchStatus = price != null ? "complete" : "partial";
  await db.execute(sql`
    INSERT INTO btc_regime_observations
      (bucket_at, observed_at, price, fetch_status)
    VALUES
      (${bucketAt}, now(), ${price}, ${fetchStatus})
    ON CONFLICT (bucket_at) DO NOTHING
  `);
  logger.debug({ bucketAt, fetchStatus }, "BTC price observation completed");
}
