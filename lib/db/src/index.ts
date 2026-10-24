import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;
const APP_POOL_MAX = 8;
const SCHEDULER_POOL_MAX = 1;
const SCHEDULER_QUERY_TIMEOUT_MS = 3_000;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon serverless: держим малый пул — большое число одновременных соединений
  // вызывает "Authentication timed out" при cold-start и исчерпании слотов.
  max: APP_POOL_MAX,
  // Neon закрывает TCP на своей стороне через ~5 мин; keepAlive помогает
  // удержать соединение активным между запросами и снизить число реконнектов.
  keepAlive: true,
  // Отдаём idle-соединение обратно в пул быстро — чтобы Neon не успел его убить,
  // а пул не пытался переиспользовать мёртвое соединение.
  idleTimeoutMillis: 10_000,
  // Лимит на ожидание свободного слота в пуле.
  connectionTimeoutMillis: 15_000,
  // Unlike a caller-side Promise.race this actively cancels the PostgreSQL
  // query, releases its client, and prevents it from leaking into the next
  // scanner cycle after a transport/Neon degradation.
  statement_timeout: 20_000,
  query_timeout: 20_500,
  allowExitOnIdle: false,
});

/**
 * Scheduler ownership is a control plane, not ordinary application traffic.
 * Keep it on one independent connection so a burst of telemetry/backfill work
 * cannot prevent the scanner from acquiring, renewing, or releasing its lease.
 *
 * Both client and PostgreSQL enforce a short deadline. This is deliberately
 * separate from caller-side Promise.race timeouts: a server-side cancellation
 * releases the connection instead of leaving an orphan query in the pool.
 */
export const schedulerPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: SCHEDULER_POOL_MAX,
  keepAlive: true,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: SCHEDULER_QUERY_TIMEOUT_MS,
  statement_timeout: SCHEDULER_QUERY_TIMEOUT_MS,
  query_timeout: SCHEDULER_QUERY_TIMEOUT_MS + 500,
  allowExitOnIdle: false,
});

export type DbPoolSnapshot = {
  total: number;
  idle: number;
  waiting: number;
  max: number;
  underPressure: boolean;
};

export function getDbPoolSnapshot(): DbPoolSnapshot {
  const total = pool.totalCount;
  const idle = pool.idleCount;
  const waiting = pool.waitingCount;
  return {
    total,
    idle,
    waiting,
    max: APP_POOL_MAX,
    underPressure: waiting > 0 || (total >= APP_POOL_MAX && idle === 0),
  };
}

export function getSchedulerPoolSnapshot(): DbPoolSnapshot {
  const total = schedulerPool.totalCount;
  const idle = schedulerPool.idleCount;
  const waiting = schedulerPool.waitingCount;
  return {
    total,
    idle,
    waiting,
    max: SCHEDULER_POOL_MAX,
    underPressure: waiting > 0 || (total >= SCHEDULER_POOL_MAX && idle === 0),
  };
}

// Ловим ошибки на idle-клиентах (например, Neon закрыл соединение пока оно лежало в pool).
// Без этого Node.js кидает unhandled 'error' event и процесс может упасть.
pool.on("error", (err) => {
  void err;
});
schedulerPool.on("error", (err) => {
  void err;
});

export const db = drizzle(pool, { schema });
export const schedulerDb = drizzle(schedulerPool, { schema });

export * from "./schema";
