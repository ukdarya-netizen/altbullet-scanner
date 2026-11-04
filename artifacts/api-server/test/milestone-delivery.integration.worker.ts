import { appendFile } from "node:fs/promises";
import {
  claimMilestoneRecipient,
  recordMilestoneRecipientOutcome,
} from "../src/lib/milestone-delivery-db.js";
import { db, milestoneNotificationDeliveriesTable, pool } from "@workspace/db";
import { eq } from "drizzle-orm";

const role = process.env.MILESTONE_WORKER_ROLE;
const barrierKey = process.env.MILESTONE_WORKER_BARRIER_KEY;
const deliveryId = Number(process.env.MILESTONE_WORKER_DELIVERY_ID);
const resultFile = process.env.MILESTONE_WORKER_RESULT_FILE;

if (
  (role !== "stale" && role !== "newer") ||
  !barrierKey ||
  !Number.isSafeInteger(deliveryId) ||
  !resultFile
) {
  throw new Error("milestone delivery worker environment is incomplete");
}
const workerResultFile = resultFile;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBarrierColumn(
  column: "stale_claimed" | "newer_claimed",
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT ${column} FROM milestone_test_barriers WHERE barrier_key = $1`,
      [barrierKey],
    );
    if (result.rows[0]?.[column] === true) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${column}`);
}

async function signalBarrier(column: "stale_claimed" | "newer_claimed") {
  await pool.query(
    `UPDATE milestone_test_barriers SET ${column} = true WHERE barrier_key = $1`,
    [barrierKey],
  );
}

async function writeResult(result: Record<string, unknown>): Promise<void> {
  await appendFile(workerResultFile, `${JSON.stringify(result)}\n`, "utf8");
}

const claimParams = {
  trackedSignalId: 42,
  milestone: 10,
  milestoneKind: "first_target",
  target: "-100987654321",
};

try {
  if (role === "stale") {
    const claim = await claimMilestoneRecipient(db, {
      ...claimParams,
      leaseMs: 75,
    });
    if (!claim) throw new Error("stale worker did not claim the channel row");
    await signalBarrier("stale_claimed");
    await waitForBarrierColumn("newer_claimed");

    const staleWrite = await recordMilestoneRecipientOutcome(db, {
      id: claim.id,
      claimToken: claim.claimToken,
      state: {
        status: "ambiguous",
        leaseUntil: new Date(Date.now() + 60_000),
        deliveredAt: null,
        lastError: "stale worker result",
      },
    });
    await writeResult({
      role,
      claimToken: claim.claimToken,
      staleWrite,
    });
  } else {
    await waitForBarrierColumn("stale_claimed");
    await db
      .update(milestoneNotificationDeliveriesTable)
      .set({ leaseUntil: new Date(Date.now() - 1) })
      .where(eq(milestoneNotificationDeliveriesTable.id, deliveryId));

    const claim = await claimMilestoneRecipient(db, claimParams);
    if (!claim) throw new Error("newer worker did not reclaim the channel row");
    await signalBarrier("newer_claimed");

    const delivered = await recordMilestoneRecipientOutcome(db, {
      id: claim.id,
      claimToken: claim.claimToken,
      state: {
        status: "delivered",
        leaseUntil: null,
        deliveredAt: new Date(),
        lastError: null,
      },
    });
    await writeResult({
      role,
      claimToken: claim.claimToken,
      delivered,
    });
  }
} finally {
  await pool.end();
}
