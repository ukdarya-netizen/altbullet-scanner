import {
  db as workspaceDb,
  milestoneNotificationDeliveriesTable,
} from "@workspace/db";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { MILESTONE_DELIVERY_LEASE_MS } from "./milestone-delivery.js";

type MilestoneDatabase = typeof workspaceDb;

export type MilestoneRecipientClaim = {
  id: number;
  claimToken: string;
};

export type MilestoneRecipientOutcomeState = {
  status: "delivered" | "failed" | "ambiguous" | "abandoned";
  leaseUntil: Date | null;
  deliveredAt: Date | null;
  lastError: string | null;
};

export async function claimMilestoneRecipient(
  database: MilestoneDatabase,
  params: {
    trackedSignalId: number;
    milestone: number;
    milestoneKind: string;
    target: string;
    now?: Date;
    leaseMs?: number;
  },
): Promise<MilestoneRecipientClaim | null> {
  const now = params.now ?? new Date();
  const claimToken = randomUUID();
  const [claimed] = await database
    .update(milestoneNotificationDeliveriesTable)
    .set({
      status: "processing",
      leaseUntil: new Date(
        now.getTime() + (params.leaseMs ?? MILESTONE_DELIVERY_LEASE_MS),
      ),
      attempts: sql`${milestoneNotificationDeliveriesTable.attempts} + 1`,
      claimToken,
      lastError: null,
    })
    .where(
      and(
        eq(
          milestoneNotificationDeliveriesTable.trackedSignalId,
          params.trackedSignalId,
        ),
        eq(milestoneNotificationDeliveriesTable.milestone, params.milestone),
        eq(
          milestoneNotificationDeliveriesTable.milestoneKind,
          params.milestoneKind,
        ),
        eq(milestoneNotificationDeliveriesTable.target, params.target),
        or(
          eq(milestoneNotificationDeliveriesTable.status, "ready"),
          and(
            eq(milestoneNotificationDeliveriesTable.status, "failed"),
            or(
              isNull(milestoneNotificationDeliveriesTable.leaseUntil),
              lte(milestoneNotificationDeliveriesTable.leaseUntil, now),
            ),
          ),
        ),
      ),
    )
    .returning({ id: milestoneNotificationDeliveriesTable.id });

  return claimed ? { id: claimed.id, claimToken } : null;
}

/**
 * Milestone rows predate the photo outbox's explicit pre-send fence. An expired
 * in-flight row therefore has an unknown Telegram outcome and is terminally
 * quarantined for audit rather than reclaimed by another worker.
 */
export async function quarantineExpiredMilestoneRecipients(
  database: MilestoneDatabase,
  now = new Date(),
): Promise<number> {
  const quarantined = await database
    .update(milestoneNotificationDeliveriesTable)
    .set({
      status: "ambiguous",
      leaseUntil: null,
      claimToken: null,
      lastError: sql`COALESCE(${milestoneNotificationDeliveriesTable.lastError}, 'Telegram outcome unknown after expired milestone claim')`,
    })
    .where(
      and(
        eq(milestoneNotificationDeliveriesTable.status, "processing"),
        lte(milestoneNotificationDeliveriesTable.leaseUntil, now),
      ),
    )
    .returning({ id: milestoneNotificationDeliveriesTable.id });
  return quarantined.length;
}

export async function recordMilestoneRecipientOutcome(
  database: MilestoneDatabase,
  params: {
    id: number;
    claimToken: string;
    state: MilestoneRecipientOutcomeState;
  },
): Promise<boolean> {
  const updated = await database
    .update(milestoneNotificationDeliveriesTable)
    .set({ ...params.state, claimToken: null })
    .where(
      and(
        eq(milestoneNotificationDeliveriesTable.id, params.id),
        eq(milestoneNotificationDeliveriesTable.status, "processing"),
        eq(milestoneNotificationDeliveriesTable.claimToken, params.claimToken),
      ),
    )
    .returning({ id: milestoneNotificationDeliveriesTable.id });

  return updated.length > 0;
}
