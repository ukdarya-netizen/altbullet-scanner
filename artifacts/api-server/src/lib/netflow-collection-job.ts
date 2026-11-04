/**
 * Netflow Collection Job — Part 2.3 (forward accumulation).
 *
 * Запускается каждые 15 мин. Сохраняет снапшот /api/futures/netflow-list
 * (100 символов, все временные окна 5m→90d) в cg_netflow_snapshot.
 *
 * Данные используются для:
 * - Паттерна "Netflow Breakout": taker_buy - taker_sell резко растёт
 *   за последние 1h/4h при нейтральном 24h (разворот от шортового flow)
 * - Фильтрации сигналов по net_flow_usd_1h (отрицательный = давление шортов)
 *
 * Endpoint: GET /api/futures/netflow-list (без параметров)
 * Возвращает 100 символов с multi-TF taker buy/sell/net за 5m...120d.
 *
 * Таблица cg_netflow_snapshot создаётся в runStartupMigration.
 */

import { logger } from "./logger.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getNextCgKey } from "./coinglass_keys.js";
import { cgTimedFetch } from "./cg_latency.js";
import {
  type MarketCycleLeaseContext,
  SchedulerLeaseLostError,
} from "./schedulerLease.js";

const _JOB_NAME = "netflow_collection";
const INTERVAL_MS = 15 * 60 * 1000; // 15 мин

interface NetflowRow {
  symbol: string;
  taker_buy_volume_usd_1h: number;
  taker_sell_volume_usd_1h: number;
  net_flow_usd_1h: number;
  taker_buy_volume_usd_4h: number;
  taker_sell_volume_usd_4h: number;
  net_flow_usd_4h: number;
  taker_buy_volume_usd_24h: number;
  taker_sell_volume_usd_24h: number;
  net_flow_usd_24h: number;
  market_cap: number;
}

let _lastRunAt = 0;

async function runNetflowCollectionJobUnlocked(
  lease: MarketCycleLeaseContext,
): Promise<void> {
  lease.throwIfLost("netflow collection start");
  const now = Date.now();
  if (now - _lastRunAt < INTERVAL_MS - 60_000) return; // debounce
  _lastRunAt = now;

  try {
    const apiKey = getNextCgKey();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers["CG-API-KEY"] = apiKey;
    const res = await cgTimedFetch(
      "https://open-api-v4.coinglass.com/api/futures/netflow-list",
      {
        headers,
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      logger.warn({ status: res.status }, "NetflowCollectionJob: HTTP error");
      return;
    }

    const d = (await res.json()) as { code: string; data?: NetflowRow[] };
    if (d.code !== "0" || !d.data?.length) {
      logger.warn({ code: d.code }, "NetflowCollectionJob: bad response");
      return;
    }

    const snapshotAt = new Date(
      Math.floor(now / (15 * 60_000)) * (15 * 60_000),
    ); // 15-min bucket

    let written = 0;
    for (const row of d.data) {
      lease.throwIfLost("netflow snapshot insert");
      const netBuyPct1h = row.taker_buy_volume_usd_1h
        ? (row.net_flow_usd_1h /
            (row.taker_buy_volume_usd_1h + row.taker_sell_volume_usd_1h)) *
          100
        : null;
      const netBuyPct4h = row.taker_buy_volume_usd_4h
        ? (row.net_flow_usd_4h /
            (row.taker_buy_volume_usd_4h + row.taker_sell_volume_usd_4h)) *
          100
        : null;

      await db
        .execute(
          sql`
        INSERT INTO cg_netflow_snapshot
          (symbol, snapshot_at,
           buy_1h, sell_1h, net_1h, net_pct_1h,
           buy_4h, sell_4h, net_4h, net_pct_4h,
           buy_24h, sell_24h, net_24h,
           market_cap_usd)
        VALUES
          (${row.symbol}, ${snapshotAt},
           ${row.taker_buy_volume_usd_1h}, ${row.taker_sell_volume_usd_1h}, ${row.net_flow_usd_1h}, ${netBuyPct1h},
           ${row.taker_buy_volume_usd_4h}, ${row.taker_sell_volume_usd_4h}, ${row.net_flow_usd_4h}, ${netBuyPct4h},
           ${row.taker_buy_volume_usd_24h}, ${row.taker_sell_volume_usd_24h}, ${row.net_flow_usd_24h},
           ${row.market_cap})
        ON CONFLICT (symbol, snapshot_at) DO NOTHING
      `,
        )
        .catch(() => {});
      written++;
    }

    logger.info({ written, snapshotAt }, "NetflowCollectionJob: done");
  } catch (err) {
    if (err instanceof SchedulerLeaseLostError) throw err;
    logger.warn({ err }, "NetflowCollectionJob: error");
  }
}

/**
 * Runs without the market-cycle lease: the scanner cycle is nearly continuous
 * (~17-20 min), so a lease/idle-gated job never ran after 2026-10-20 and the
 * snapshot history stopped. One bounded request every 15 min, own debounce.
 */
export async function runNetflowCollectionJob(): Promise<void> {
  await runNetflowCollectionJobUnlocked({
    throwIfLost: () => {},
  } as unknown as MarketCycleLeaseContext);
}
