/**
 * Observed adverse excursion for a tracked signal.
 *
 * This is a mutable summary: FastCycle atomically keeps the lowest observed
 * direction-aware PnL and the exact observation that produced it. It is
 * intentionally separate from signal_trajectory_log, whose interval rows are
 * immutable calibration snapshots.
 */
export declare const signalDrawdownExtremaTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "signal_drawdown_extrema";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "signal_drawdown_extrema";
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
            tableName: "signal_drawdown_extrema";
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
            tableName: "signal_drawdown_extrema";
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
            tableName: "signal_drawdown_extrema";
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
        minPctFromEntry: import("drizzle-orm/pg-core").PgColumn<{
            name: "min_pct_from_entry";
            tableName: "signal_drawdown_extrema";
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
        priceAtMin: import("drizzle-orm/pg-core").PgColumn<{
            name: "price_at_min";
            tableName: "signal_drawdown_extrema";
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
        minObservedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "min_observed_at";
            tableName: "signal_drawdown_extrema";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
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
        minElapsedMs: import("drizzle-orm/pg-core").PgColumn<{
            name: "min_elapsed_ms";
            tableName: "signal_drawdown_extrema";
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
        source: import("drizzle-orm/pg-core").PgColumn<{
            name: "source";
            tableName: "signal_drawdown_extrema";
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
        statusAtMin: import("drizzle-orm/pg-core").PgColumn<{
            name: "status_at_min";
            tableName: "signal_drawdown_extrema";
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
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "signal_drawdown_extrema";
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
    };
    dialect: "pg";
}>;
export type SignalDrawdownExtrema = typeof signalDrawdownExtremaTable.$inferSelect;
//# sourceMappingURL=signalDrawdownExtrema.d.ts.map