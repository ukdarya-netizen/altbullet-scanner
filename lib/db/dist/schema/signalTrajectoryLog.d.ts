/**
 * signal_trajectory_log — trajectory snapshots for every fired signal.
 *
 * One row per (signal_id, interval_label). Snapshots are written by
 * FastCycle (every 2 min) once elapsed time since detectedAt crosses
 * the interval threshold. ON CONFLICT DO NOTHING makes writes idempotent.
 *
 * Intervals: 15m / 30m / 1h / 2h / 4h / 8h / 24h / 48h / 72h
 *
 * Purpose: pattern calibration — entry conditions → time-bucketed outcomes.
 */
export declare const signalTrajectoryLogTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "signal_trajectory_log";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgSerial";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        signalId: import("drizzle-orm/pg-core").PgColumn<{
            name: "signal_id";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        symbol: import("drizzle-orm/pg-core").PgColumn<{
            name: "symbol";
            tableName: "signal_trajectory_log";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sentimentKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "sentiment_key";
            tableName: "signal_trajectory_log";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        intervalLabel: import("drizzle-orm/pg-core").PgColumn<{
            name: "interval_label";
            tableName: "signal_trajectory_log";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        snapshotAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "snapshot_at";
            tableName: "signal_trajectory_log";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        elapsedMs: import("drizzle-orm/pg-core").PgColumn<{
            name: "elapsed_ms";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgBigInt53";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        priceAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "price_at";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pctFromEntry: import("drizzle-orm/pg-core").PgColumn<{
            name: "pct_from_entry";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        peakPct: import("drizzle-orm/pg-core").PgColumn<{
            name: "peak_pct";
            tableName: "signal_trajectory_log";
            dataType: "number";
            columnType: "PgReal";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "signal_trajectory_log";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
//# sourceMappingURL=signalTrajectoryLog.d.ts.map