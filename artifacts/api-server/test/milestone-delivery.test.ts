import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPendingMilestoneState,
  canRetryPendingMilestone,
  canonicalizeMilestoneTargets,
  classifyMilestoneSendResult,
  combineMilestoneDeliveryOutcomes,
  MILESTONE_DELIVERY_LEASE_MS,
  selectMilestoneRecipientsDueForDispatch,
  selectRemovedMilestoneRecipients,
  shouldFallbackMilestonePhotoToText,
  summarizeMilestoneRecipientStatuses,
  type PendingMilestoneStatus,
} from "../src/lib/milestone-delivery.js";

const NOW_MS = Date.parse("2026-08-19T12:00:00Z");
const NOW = new Date(NOW_MS);

describe("Milestone delivery deduplication", () => {
  test("creates one sending state for every milestone path", () => {
    const cases = [
      ["pre_target", 5],
      ["intermediate", 8],
      ["first_target", 10],
      ["trailing", 15],
      ["milestone", 20],
    ] as const;

    for (const [kind, milestone] of cases) {
      const pending = buildPendingMilestoneState(
        kind,
        milestone,
        1.25,
        1.1,
        NOW_MS,
      );
      assert.equal(pending.pendingMilestoneKind, kind);
      assert.equal(pending.pendingMilestone, milestone);
      assert.equal(pending.pendingMilestoneStatus, "sending");
      assert.equal(
        pending.pendingMilestoneLeaseUntil.getTime(),
        NOW_MS + MILESTONE_DELIVERY_LEASE_MS,
      );
    }
  });

  test("retries explicit Telegram rejection but not timeout or network ambiguity", () => {
    assert.deepEqual(
      classifyMilestoneSendResult({
        ok: false,
        status: 429,
        retryable: true,
        description: "Too Many Requests",
      }),
      {
        kind: "confirmed_failure",
        description: "Too Many Requests",
      },
    );
    assert.deepEqual(
      classifyMilestoneSendResult({
        ok: false,
        status: 503,
        retryable: true,
        description: "temporary outage",
      }),
      {
        kind: "ambiguous",
        description: "temporary outage",
      },
    );
    assert.equal(
      shouldFallbackMilestonePhotoToText(
        classifyMilestoneSendResult({
          ok: false,
          status: 503,
          retryable: true,
          description: "temporary outage",
        }),
      ),
      false,
    );
    assert.deepEqual(
      classifyMilestoneSendResult({
        ok: false,
        status: 403,
        retryable: false,
        description: "Forbidden: bot was blocked by the user",
      }),
      {
        kind: "abandoned",
        description: "Forbidden: bot was blocked by the user",
      },
    );
    assert.equal(
      shouldFallbackMilestonePhotoToText(
        classifyMilestoneSendResult({
          ok: false,
          status: 403,
          retryable: false,
          description: "Forbidden: bot was blocked by the user",
        }),
      ),
      false,
    );
    assert.deepEqual(
      classifyMilestoneSendResult({
        ok: false,
        status: null,
        retryable: true,
        description: "request timed out",
      }),
      {
        kind: "ambiguous",
        description: "request timed out",
      },
    );
    assert.deepEqual(
      classifyMilestoneSendResult({
        ok: true,
        status: 200,
        retryable: false,
      }),
      { kind: "delivered", sentCount: 1 },
    );
  });

  test("an ambiguous recipient prevents a broadcast-level automatic retry", () => {
    assert.deepEqual(
      combineMilestoneDeliveryOutcomes([
        { kind: "delivered", sentCount: 1 },
        { kind: "ambiguous", description: "network error" },
      ]),
      { kind: "ambiguous", description: "network error" },
    );
  });

  test("retries only recipients that explicitly failed in a mixed broadcast", () => {
    assert.deepEqual(
      summarizeMilestoneRecipientStatuses(["delivered", "failed"]),
      {
        kind: "confirmed_failure",
        description: "One or more Telegram recipients failed",
      },
    );
    assert.deepEqual(
      summarizeMilestoneRecipientStatuses(["delivered", "ambiguous"]),
      {
        kind: "ambiguous",
        description: "One or more Telegram recipient outcomes are ambiguous",
      },
    );
  });

  test("retries only the failed recipient after a partial fan-out", () => {
    assert.deepEqual(
      selectMilestoneRecipientsDueForDispatch(
        [
          { target: "101", status: "delivered", leaseUntil: null },
          {
            target: "202",
            status: "failed",
            leaseUntil: new Date(NOW_MS - 1),
          },
          { target: "303", status: "ambiguous", leaseUntil: null },
        ],
        [101, 202, 303],
        NOW,
      ),
      [202],
    );

    assert.deepEqual(
      selectMilestoneRecipientsDueForDispatch(
        [
          {
            target: "202",
            status: "failed",
            leaseUntil: new Date(NOW_MS + 1),
          },
        ],
        [202],
        NOW,
      ),
      [],
    );
  });

  test("does not resend an unknown channel or direct-chat milestone outcome", () => {
    assert.deepEqual(
      selectMilestoneRecipientsDueForDispatch(
        [
          { target: "101", status: "delivered", leaseUntil: null },
          {
            target: "-100202",
            status: "processing",
            leaseUntil: new Date(NOW_MS - 1),
          },
          {
            target: "303",
            status: "ambiguous",
            leaseUntil: new Date(NOW_MS - 1),
          },
        ],
        [101, -100202, 303],
        NOW,
      ),
      [],
    );

    assert.deepEqual(
      selectMilestoneRecipientsDueForDispatch(
        [
          {
            target: "-100202",
            status: "ambiguous",
            leaseUntil: new Date(NOW_MS - 1),
          },
        ],
        [-100202],
        NOW,
      ),
      [],
    );
  });

  test("closes a milestone when a removed recipient is terminally unavailable", () => {
    assert.deepEqual(
      selectRemovedMilestoneRecipients(
        [
          { target: "101", status: "failed" },
          { target: "202", status: "delivered" },
        ],
        [202],
        [],
      ),
      ["101"],
    );
    assert.deepEqual(
      selectRemovedMilestoneRecipients(
        [{ target: "101", status: "failed" }],
        [],
        ["@channel"],
      ),
      [],
    );
    assert.deepEqual(
      summarizeMilestoneRecipientStatuses(["delivered", "abandoned"]),
      { kind: "delivered", sentCount: 1 },
    );
    assert.deepEqual(summarizeMilestoneRecipientStatuses(["abandoned"]), {
      kind: "abandoned",
      description: "All Telegram recipients are unavailable",
    });
  });

  test("never snapshots an unresolved @channel as a durable recipient key", async () => {
    const unresolved = await canonicalizeMilestoneTargets(
      ["@cryptoaltshero", 123],
      async () => null,
    );
    assert.deepEqual(unresolved, {
      targets: [123],
      unresolvedAliases: ["@cryptoaltshero"],
    });

    const resolvedOnRetry = await canonicalizeMilestoneTargets(
      ["@cryptoaltshero", 123],
      async () => -100987654321,
    );
    assert.deepEqual(resolvedOnRetry, {
      targets: [-100987654321, 123],
      unresolvedAliases: [],
    });
  });

  test("a failed completion write cannot make a delivered milestone retryable", () => {
    const stateAfterFailedClear = buildPendingMilestoneState(
      "first_target",
      10,
      1.1,
      1.05,
      NOW_MS,
    );
    const afterLease = new Date(NOW_MS + MILESTONE_DELIVERY_LEASE_MS + 1);

    assert.equal(
      canRetryPendingMilestone(
        stateAfterFailedClear.pendingMilestoneStatus,
        stateAfterFailedClear.pendingMilestoneLeaseUntil,
        afterLease,
      ),
      false,
    );
    assert.equal(canRetryPendingMilestone(null, null, afterLease), false);
  });

  test("only one worker can convert a failed retry into sending", () => {
    const row: {
      status: PendingMilestoneStatus;
      leaseUntil: Date | null;
    } = {
      status: "failed",
      leaseUntil: new Date(NOW_MS - 1),
    };

    const claim = () => {
      if (!canRetryPendingMilestone(row.status, row.leaseUntil, NOW)) {
        return false;
      }
      row.status = "sending";
      row.leaseUntil = new Date(NOW_MS + MILESTONE_DELIVERY_LEASE_MS);
      return true;
    };

    assert.equal(claim(), true);
    assert.equal(claim(), false);
  });
});
