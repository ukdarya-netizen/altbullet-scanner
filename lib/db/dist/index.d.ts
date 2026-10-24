import * as schema from "./schema";
export declare const pool: import("pg").Pool;
/**
 * Scheduler ownership is a control plane, not ordinary application traffic.
 * Keep it on one independent connection so a burst of telemetry/backfill work
 * cannot prevent the scanner from acquiring, renewing, or releasing its lease.
 *
 * Both client and PostgreSQL enforce a short deadline. This is deliberately
 * separate from caller-side Promise.race timeouts: a server-side cancellation
 * releases the connection instead of leaving an orphan query in the pool.
 */
export declare const schedulerPool: import("pg").Pool;
export type DbPoolSnapshot = {
    total: number;
    idle: number;
    waiting: number;
    max: number;
    underPressure: boolean;
};
export declare function getDbPoolSnapshot(): DbPoolSnapshot;
export declare function getSchedulerPoolSnapshot(): DbPoolSnapshot;
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
export declare const schedulerDb: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
export * from "./schema";
//# sourceMappingURL=index.d.ts.map