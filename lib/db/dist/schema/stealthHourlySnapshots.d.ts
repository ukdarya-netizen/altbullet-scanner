/**
 * stealth_hourly_snapshots — one immutable row per (tracked signal, hour since
 * detection) for open Stealth Breakout positions. Observation only: nothing
 * here feeds a trading decision. `metrics` holds aggregated CoinGlass values
 * (OI, futures taker, spot CVD, spot volume); a missing value is stored as
 * null, never reconstructed.
 */
export declare const stealthHourlySnapshotsTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "stealth_hourly_snapshots";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "stealth_hourly_snapshots";
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
        trackedSignalId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tracked_signal_id";
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
        hourIndex: import("drizzle-orm/pg-core").PgColumn<{
            name: "hour_index";
            tableName: "stealth_hourly_snapshots";
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
        snapshotAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "snapshot_at";
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
            tableName: "stealth_hourly_snapshots";
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
        metrics: import("drizzle-orm/pg-core").PgColumn<{
            name: "metrics";
            tableName: "stealth_hourly_snapshots";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
            driverParam: unknown;
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
    };
    dialect: "pg";
}>;
//# sourceMappingURL=stealthHourlySnapshots.d.ts.map