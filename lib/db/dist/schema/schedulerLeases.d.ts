/**
 * Cross-worker ownership for jobs that must never overlap.
 *
 * Schema changes are applied by the normal development/publish schema flow.
 * Runtime code only claims, renews, and releases rows in this table.
 */
export declare const schedulerLeasesTable: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "scheduler_leases";
    schema: undefined;
    columns: {
        leaseName: import("drizzle-orm/pg-core").PgColumn<{
            name: "lease_name";
            tableName: "scheduler_leases";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ownerToken: import("drizzle-orm/pg-core").PgColumn<{
            name: "owner_token";
            tableName: "scheduler_leases";
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
        acquiredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "acquired_at";
            tableName: "scheduler_leases";
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
        heartbeatAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "heartbeat_at";
            tableName: "scheduler_leases";
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
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "scheduler_leases";
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
    };
    dialect: "pg";
}>;
export type SchedulerLease = typeof schedulerLeasesTable.$inferSelect;
//# sourceMappingURL=schedulerLeases.d.ts.map