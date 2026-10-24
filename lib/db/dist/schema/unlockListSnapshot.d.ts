/**
 * Last successfully loaded CoinGlass unlock list (single row, id = 1).
 * Also created idempotently by the API server; declared here so the
 * development-to-production publish diff does not treat it as a drop.
 */
export declare const unlockListSnapshotTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "unlock_list_snapshot";
    schema: undefined;
    columns: {
        id: import("drizzle-orm/pg-core").PgColumn<{
            name: "id";
            tableName: "unlock_list_snapshot";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        fetchedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "fetched_at";
            tableName: "unlock_list_snapshot";
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
        payload: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload";
            tableName: "unlock_list_snapshot";
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
//# sourceMappingURL=unlockListSnapshot.d.ts.map