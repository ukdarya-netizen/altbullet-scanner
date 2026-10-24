import { randomUUID } from "node:crypto";
import { and, eq, lte, or, sql } from "drizzle-orm";
import {
  db,
  prescanHistoryTable,
  prescanTelemetryOutboxTable,
  type InsertPrescanSnapshot,
} from "@workspace/db";
import type {
  DurableTelemetryClaim,
  DurableTelemetryStore,
  TelemetryOutboxId,
} from "./telemetryQueue.js";
import { dbWriteStrict } from "./dbWriteFast.js";

const LEASE_MS = 12 * 60_000;

export type PrescanTelemetryItem =
  | {
      dedupKey: string;
      kind: "history";
      rows: Array<typeof prescanHistoryTable.$inferInsert>;
    }
  | {
      dedupKey: string;
      kind: "snapshots";
      rows: InsertPrescanSnapshot[];
    };

type OutboxRow = typeof prescanTelemetryOutboxTable.$inferSelect;

function deserialize(row: OutboxRow): PrescanTelemetryItem {
  const payload = row.payload as PrescanTelemetryItem;
  if (payload.kind === "history") {
    return {
      ...payload,
      rows: payload.rows.map((item) => ({
        ...item,
        ts: item.ts == null ? item.ts : new Date(item.ts),
      })),
    };
  }
  if (payload.kind === "snapshots") {
    return {
      ...payload,
      rows: payload.rows.map((item) => ({
        ...item,
        cycleAt: item.cycleAt == null ? item.cycleAt : new Date(item.cycleAt),
      })),
    };
  }
  return payload;
}

function serializeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1_000,
  );
}

/**
 * PostgreSQL adapter for immutable prescan telemetry. The outbox's dedup key is
 * the captured cycle timestamp plus kind, so an ambiguous outbox insert retry
 * cannot create a second pending batch.
 */
export const prescanTelemetryOutboxStore: DurableTelemetryStore<PrescanTelemetryItem> =
  {
    async enqueue(payload): Promise<void> {
      await dbWriteStrict(
        "prescanTelemetryOutbox/enqueue",
        () =>
          db
            .insert(prescanTelemetryOutboxTable)
            .values({
              dedupKey: payload.dedupKey,
              kind: payload.kind,
              payload,
              status: "ready",
              nextAttemptAt: new Date(),
            })
            .onConflictDoNothing({
              target: prescanTelemetryOutboxTable.dedupKey,
            }),
        { attempts: 3, perAttemptTimeoutMs: 8_000 },
      );
    },

    async listDueIds(): Promise<TelemetryOutboxId[]> {
      const now = new Date();
      const rows = await db
        .select({ id: prescanTelemetryOutboxTable.id })
        .from(prescanTelemetryOutboxTable)
        .where(
          or(
            and(
              sql`${prescanTelemetryOutboxTable.status} IN ('ready', 'retry')`,
              lte(prescanTelemetryOutboxTable.nextAttemptAt, now),
            ),
            and(
              eq(prescanTelemetryOutboxTable.status, "processing"),
              lte(prescanTelemetryOutboxTable.leaseUntil, now),
            ),
          ),
        )
        .orderBy(
          prescanTelemetryOutboxTable.nextAttemptAt,
          prescanTelemetryOutboxTable.id,
        )
        .limit(100);
      return rows.map((row) => row.id);
    },

    async claim(
      id: TelemetryOutboxId,
    ): Promise<DurableTelemetryClaim<PrescanTelemetryItem> | null> {
      if (typeof id !== "number") return null;
      const now = new Date();
      const claimToken = randomUUID();
      const [claimed] = await db
        .update(prescanTelemetryOutboxTable)
        .set({
          status: "processing",
          attempts: sql`${prescanTelemetryOutboxTable.attempts} + 1`,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          claimToken,
          updatedAt: now,
        })
        .where(
          and(
            eq(prescanTelemetryOutboxTable.id, id),
            or(
              and(
                sql`${prescanTelemetryOutboxTable.status} IN ('ready', 'retry')`,
                lte(prescanTelemetryOutboxTable.nextAttemptAt, now),
              ),
              and(
                eq(prescanTelemetryOutboxTable.status, "processing"),
                lte(prescanTelemetryOutboxTable.leaseUntil, now),
              ),
            ),
          ),
        )
        .returning();
      if (!claimed) return null;
      return {
        id: claimed.id,
        payload: deserialize(claimed),
        attempt: claimed.attempts,
        claimToken,
      };
    },

    async acknowledge(claim): Promise<void> {
      if (typeof claim.id !== "number") {
        throw new Error("Prescan telemetry outbox id must be numeric");
      }
      const deleted = await db
        .delete(prescanTelemetryOutboxTable)
        .where(
          and(
            eq(prescanTelemetryOutboxTable.id, claim.id),
            eq(prescanTelemetryOutboxTable.claimToken, claim.claimToken),
          ),
        )
        .returning({ id: prescanTelemetryOutboxTable.id });
      if (deleted.length === 0) {
        throw new Error(`Prescan telemetry outbox ${claim.id} lost its claim`);
      }
    },

    async retry(claim, params): Promise<void> {
      if (typeof claim.id !== "number") {
        throw new Error("Prescan telemetry outbox id must be numeric");
      }
      const updated = await db
        .update(prescanTelemetryOutboxTable)
        .set({
          status: "retry",
          nextAttemptAt: new Date(Date.now() + params.delayMs),
          leaseUntil: null,
          claimToken: null,
          lastError: serializeError(params.error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(prescanTelemetryOutboxTable.id, claim.id),
            eq(prescanTelemetryOutboxTable.claimToken, claim.claimToken),
          ),
        )
        .returning({ id: prescanTelemetryOutboxTable.id });
      if (updated.length === 0) {
        throw new Error(`Prescan telemetry outbox ${claim.id} lost its claim`);
      }
    },
  };
