import assert from "node:assert/strict";
import test from "node:test";
import {
  liqCascadeObservationBucket,
  liqCascadeObservationEventKey,
} from "../src/lib/liq-cascade-observation-identity.js";

test("LC rejected observation remains one business outcome for the watch", () => {
  const first = new Date("2026-09-06T10:01:10.000Z");
  const repeated = new Date("2026-09-06T10:14:59.999Z");

  assert.equal(
    liqCascadeObservationBucket(first).toISOString(),
    "2026-09-06T10:00:00.000Z",
  );
  assert.equal(
    liqCascadeObservationEventKey({
      watchId: 42,
      stage: "rejected",
      reason: "spot_taker_negative",
      observedAt: first,
    }),
    liqCascadeObservationEventKey({
      watchId: 42,
      stage: "rejected",
      reason: "spot_taker_negative",
      observedAt: repeated,
    }),
  );
});

test("LC rejected observation identity keeps watches separate but collapses reasons and buckets", () => {
  const observedAt = new Date("2026-09-06T10:01:10.000Z");
  const base = {
    watchId: 42,
    stage: "rejected" as const,
    reason: "spot_taker_negative",
    observedAt,
  };

  assert.notEqual(
    liqCascadeObservationEventKey(base),
    liqCascadeObservationEventKey({ ...base, watchId: 43 }),
  );
  assert.equal(
    liqCascadeObservationEventKey(base),
    liqCascadeObservationEventKey({
      ...base,
      reason: "oi30m_below_0.3",
    }),
  );
  assert.equal(
    liqCascadeObservationEventKey(base),
    liqCascadeObservationEventKey({
      ...base,
      observedAt: new Date("2026-09-06T10:15:00.000Z"),
    }),
  );
});

test("LC recovery-gate rejection survives an earlier rejection for the same watch", () => {
  const base = {
    watchId: 42,
    stage: "rejected" as const,
    observedAt: new Date("2026-09-06T10:01:10.000Z"),
  };
  const first = liqCascadeObservationEventKey({
    ...base,
    reason: "liq_not_exhausted",
  });
  const held = liqCascadeObservationEventKey({
    ...base,
    reason: "weak_liq_continued_decline",
  });
  assert.notEqual(first, held);
  assert.equal(
    held,
    liqCascadeObservationEventKey({
      ...base,
      reason: "weak_liq_continued_decline",
      observedAt: new Date("2026-09-06T11:01:10.000Z"),
    }),
  );
});

test("LC terminal observation remains singular across reconciliation reasons", () => {
  const first = liqCascadeObservationEventKey({
    watchId: 42,
    stage: "fired",
    reason: "signal_tracked",
    observedAt: new Date("2026-09-06T10:01:10.000Z"),
  });
  const reconciled = liqCascadeObservationEventKey({
    watchId: 42,
    stage: "fired",
    reason: "tracked_signal_linked",
    observedAt: new Date("2026-09-06T10:20:00.000Z"),
  });

  assert.equal(first, reconciled);
});
