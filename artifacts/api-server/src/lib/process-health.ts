import { monitorEventLoopDelay } from "node:perf_hooks";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { dbWriteBestEffort } from "./dbWriteFast.js";
import { memoStats } from "./coinglass-memo.js";
import { closedVolumeCacheStats } from "./coinglass_taker.js";
import { bingxBarsStoreSize } from "./bingx-bars-store.js";

/**
 * process_health: one row per minute, written by its own timer and independent
 * of the scanner cycle. A stalled process stops producing rows, so a gap in
 * recorded_at is itself evidence of a freeze; the values before the gap show
 * memory and event-loop state leading into it.
 */
const SAMPLE_INTERVAL_MS = 60_000;
const RETENTION_DAYS = 7;
const RETENTION_EVERY_MS = 60 * 60_000;

export type CacheFootprint = { entries: number } & Record<string, number>;
const sources = new Map<string, () => CacheFootprint>();

/** Register an extra cache whose footprint is stored in process_health.caches. */
export function registerProcessHealthSource(
  name: string,
  read: () => CacheFootprint,
): void {
  sources.set(name, read);
}

export type ProcessHealthSample = {
  pid: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  elLagP50Ms: number;
  elLagP99Ms: number;
  elLagMaxMs: number;
  caches: Record<string, CacheFootprint>;
};

const nsToMs = (v: number): number => Math.round((v / 1e6) * 10) / 10;

export function collectCaches(): Record<string, CacheFootprint> {
  const memo = memoStats();
  const closed = closedVolumeCacheStats();
  const bars = bingxBarsStoreSize();
  const out: Record<string, CacheFootprint> = {
    coinglass_memo: { entries: memo.entries, bytes: memo.bytes },
    closed_bar_cache: {
      entries: closed.entries,
      bytes: closed.estBytes,
      bars: closed.bars,
    },
    bingx_bars_store: {
      entries: bars.entries,
      bytes: bars.estBytes,
      klines: bars.klines,
    },
  };
  for (const [name, read] of sources) {
    try {
      out[name] = read();
    } catch {
      // a failing source must not stop the sample
    }
  }
  return out;
}

export function buildProcessHealthSample(
  lag: { p50: number; p99: number; max: number },
  mem: NodeJS.MemoryUsage = process.memoryUsage(),
): ProcessHealthSample {
  return {
    pid: process.pid,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
    elLagP50Ms: nsToMs(lag.p50),
    elLagP99Ms: nsToMs(lag.p99),
    elLagMaxMs: nsToMs(lag.max),
    caches: collectCaches(),
  };
}

let schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS process_health (
      id bigserial PRIMARY KEY,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      pid integer NOT NULL,
      rss_bytes bigint NOT NULL,
      heap_used_bytes bigint NOT NULL,
      heap_total_bytes bigint NOT NULL,
      external_bytes bigint NOT NULL,
      array_buffers_bytes bigint NOT NULL,
      el_lag_p50_ms real NOT NULL,
      el_lag_p99_ms real NOT NULL,
      el_lag_max_ms real NOT NULL,
      caches jsonb NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS process_health_recorded_at_idx
    ON process_health (recorded_at)
  `);
  schemaReady = true;
}

async function writeSample(s: ProcessHealthSample): Promise<void> {
  await ensureSchema();
  await db.execute(sql`
    INSERT INTO process_health (
      pid, rss_bytes, heap_used_bytes, heap_total_bytes, external_bytes,
      array_buffers_bytes, el_lag_p50_ms, el_lag_p99_ms, el_lag_max_ms, caches
    ) VALUES (
      ${s.pid}, ${s.rssBytes}, ${s.heapUsedBytes}, ${s.heapTotalBytes},
      ${s.externalBytes}, ${s.arrayBuffersBytes}, ${s.elLagP50Ms},
      ${s.elLagP99Ms}, ${s.elLagMaxMs}, ${JSON.stringify(s.caches)}::jsonb
    )
  `);
}

async function pruneOld(): Promise<void> {
  await ensureSchema();
  await db.execute(sql`
    DELETE FROM process_health
    WHERE recorded_at < now() - make_interval(days => ${RETENTION_DAYS})
  `);
}

let started = false;

export function startProcessHealthSampler(): void {
  if (started) return;
  started = true;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const sample = (): void => {
    const s = buildProcessHealthSample({
      p50: histogram.percentile(50),
      p99: histogram.percentile(99),
      max: histogram.max,
    });
    histogram.reset();
    void dbWriteBestEffort("process-health/sample", () => writeSample(s)).catch(
      (err) => logger.warn({ err }, "process_health sample failed"),
    );
  };
  setInterval(sample, SAMPLE_INTERVAL_MS).unref();
  setInterval(() => {
    void dbWriteBestEffort("process-health/prune", pruneOld).catch((err) =>
      logger.warn({ err }, "process_health prune failed"),
    );
  }, RETENTION_EVERY_MS).unref();
  logger.info(
    { everyMs: SAMPLE_INTERVAL_MS, retentionDays: RETENTION_DAYS },
    "process_health sampler started",
  );
}
