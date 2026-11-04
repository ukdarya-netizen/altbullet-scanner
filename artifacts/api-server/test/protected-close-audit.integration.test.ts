import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";

const enabled =
  process.env.RUN_PROTECTED_CLOSE_AUDIT_INTEGRATION_TESTS === "true";
const integrationTest = enabled ? test : test.skip;
if (enabled) {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("TEST_DATABASE_URL required for close audit tests");
  // The DB package reads DATABASE_URL on import; do not import it before this.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

async function loadTestDb() {
  const [{ db, trackedSignalsTable }, { installProtectedCloseAuditSchema }] =
    await Promise.all([
      import("@workspace/db"),
      import("../src/lib/protected-close-audit.js"),
    ]);
  return { db, trackedSignalsTable, installProtectedCloseAuditSchema };
}

integrationTest("captures prior state and preserves it", async () => {
  const { db, trackedSignalsTable, installProtectedCloseAuditSchema } =
    await loadTestDb();
  const rollback = new Error("rollback protected-close audit test");
  await assert.rejects(
    db.transaction(async (tx) => {
      await installProtectedCloseAuditSchema(tx);
      const [created] = await tx
        .insert(trackedSignalsTable)
        .values({
          symbol: "CLOSE-AUDIT-TEST-USDT",
          signalType: "alpha",
          sentimentKey: "liquidation_cascade",
          entryPrice: 100,
          peakPrice: 111,
          lastMilestone: 10,
          status: "active",
        })
        .returning({ id: trackedSignalsTable.id });
      assert.ok(created);
      const [closed] = await tx
        .update(trackedSignalsTable)
        .set({
          status: "bu_stop",
          exitPrice: 100,
          pnlPercent: 0,
          peakPrice: 111,
          closedAt: new Date(),
        })
        .where(eq(trackedSignalsTable.id, created.id))
        .returning({
          evidence: trackedSignalsTable.protectedCloseEvidence,
        });
      assert.equal(closed?.evidence?.priorStatus, "active");
      assert.equal(closed?.evidence?.priorMilestone, 10);
      assert.equal(closed?.evidence?.priorPeakPrice, 111);
      assert.equal(closed?.evidence?.expectedFloorPct, 5);
      assert.equal(closed?.evidence?.exitPrice, 100);
      assert.equal(closed?.evidence?.mismatch, true);

      const [later] = await tx
        .update(trackedSignalsTable)
        .set({
          status: "reclassified",
          lastMilestone: null,
          protectedCloseEvidence: null,
        })
        .where(eq(trackedSignalsTable.id, created.id))
        .returning({
          evidence: trackedSignalsTable.protectedCloseEvidence,
        });
      assert.deepEqual(later?.evidence, closed.evidence);
      throw rollback;
    }),
    (err: unknown) => err === rollback,
  );
});

integrationTest("closing peak is not prior protection", async () => {
  const { db, trackedSignalsTable, installProtectedCloseAuditSchema } =
    await loadTestDb();
  const rollback = new Error("rollback close-time peak test");
  await assert.rejects(
    db.transaction(async (tx) => {
      await installProtectedCloseAuditSchema(tx);
      const [created] = await tx
        .insert(trackedSignalsTable)
        .values({
          symbol: "CLOSE-AUDIT-TEST-USDT",
          signalType: "alpha",
          sentimentKey: "impulse_buy",
          entryPrice: 100,
          peakPrice: 108,
          lastMilestone: 5,
          status: "in_run",
        })
        .returning({ id: trackedSignalsTable.id });
      assert.ok(created);
      const [closed] = await tx
        .update(trackedSignalsTable)
        .set({
          status: "bu_stop",
          exitPrice: 100,
          pnlPercent: 0,
          peakPrice: 111,
          lastMilestone: 10,
          closedAt: new Date(),
        })
        .where(eq(trackedSignalsTable.id, created.id))
        .returning({
          evidence: trackedSignalsTable.protectedCloseEvidence,
        });
      assert.equal(closed?.evidence?.priorMilestone, 5);
      assert.equal(closed?.evidence?.expectedFloorPct, 0);
      assert.equal(closed?.evidence?.mismatch, false);
      assert.equal(closed?.evidence?.closingMilestone, 10);
      assert.ok(Number(closed?.evidence?.closingPeakPct) > 10);
      throw rollback;
    }),
    (err: unknown) => err === rollback,
  );
});

integrationTest("accepts a protected close at +5%", async () => {
  const { db, trackedSignalsTable, installProtectedCloseAuditSchema } =
    await loadTestDb();
  const rollback = new Error("rollback correct protected close test");
  await assert.rejects(
    db.transaction(async (tx) => {
      await installProtectedCloseAuditSchema(tx);
      const [created] = await tx
        .insert(trackedSignalsTable)
        .values({
          symbol: "CLOSE-AUDIT-TEST-USDT",
          signalType: "alpha",
          sentimentKey: "liquidation_cascade",
          entryPrice: 100,
          peakPrice: 111,
          lastMilestone: 10,
          status: "active",
        })
        .returning({ id: trackedSignalsTable.id });
      assert.ok(created);
      const [closed] = await tx
        .update(trackedSignalsTable)
        .set({
          status: "bu_stop",
          exitPrice: 105,
          pnlPercent: 5,
          closedAt: new Date(),
        })
        .where(eq(trackedSignalsTable.id, created.id))
        .returning({
          evidence: trackedSignalsTable.protectedCloseEvidence,
        });
      assert.equal(closed?.evidence?.expectedFloorPct, 5);
      assert.equal(closed?.evidence?.mismatch, false);
      throw rollback;
    }),
    (err: unknown) => err === rollback,
  );
});
