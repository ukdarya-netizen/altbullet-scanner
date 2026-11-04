import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateBuStopMovePct,
  getBuStopFollowupHour,
  isBuStopFollowupObservationEligible,
} from "../src/lib/bu-stop-followup.js";
import {
  buildPostCloseFollowupSnapshot,
  POST_CLOSE_TERMINAL_STATUSES,
} from "../src/lib/post-close-followup.js";

test("bu-stop follow-up maps elapsed time to an hourly sample", () => {
  const closedAt = new Date("2026-08-20T00:00:00.000Z");
  assert.equal(
    getBuStopFollowupHour(closedAt, new Date("2026-08-20T00:59:59.999Z")),
    null,
  );
  assert.equal(
    getBuStopFollowupHour(closedAt, new Date("2026-08-20T05:30:00.000Z")),
    5,
  );
  assert.equal(
    getBuStopFollowupHour(closedAt, new Date("2026-08-24T00:00:00.000Z")),
    72,
  );
  assert.equal(
    getBuStopFollowupHour(closedAt, new Date("2026-08-23T00:05:00.000Z")),
    72,
  );
  assert.equal(
    isBuStopFollowupObservationEligible(
      closedAt,
      new Date("2026-08-23T00:05:00.000Z"),
    ),
    true,
  );
  assert.equal(
    isBuStopFollowupObservationEligible(
      closedAt,
      new Date("2026-08-24T00:01:00.000Z"),
    ),
    false,
  );
});

test("bu-stop follow-up calculates direction-aware movement", () => {
  assert.equal(calculateBuStopMovePct(100, 112, false), 12);
  assert.equal(calculateBuStopMovePct(100, 88, true), 12);
  assert.equal(calculateBuStopMovePct(0, 88, false), null);
});

test("post-close follow-up accepts every terminal outcome", () => {
  const closedAt = new Date("2026-08-20T00:00:00.000Z");
  const observedAt = new Date("2026-08-20T05:30:00.000Z");
  for (const status of POST_CLOSE_TERMINAL_STATUSES) {
    const snapshot = buildPostCloseFollowupSnapshot(
      {
        id: 7,
        symbol: "TEST-USDT",
        status,
        closedAt,
        exitPrice: 100,
        isShort: false,
      },
      112,
      observedAt,
    );
    assert.equal(snapshot?.status, status);
    assert.equal(snapshot?.hourAfterClose, 5);
    assert.equal(snapshot?.movePct, 12);
    assert.equal(snapshot?.closedAt, closedAt);
    assert.equal(snapshot?.exitPrice, 100);
  }
});

test("post-close follow-up rejects live states and invalid market prices", () => {
  const base = {
    id: 8,
    symbol: "TEST-USDT",
    closedAt: new Date("2026-08-20T00:00:00.000Z"),
    exitPrice: 100,
    isShort: false,
  };
  const observedAt = new Date("2026-08-20T02:00:00.000Z");
  assert.equal(
    buildPostCloseFollowupSnapshot(
      { ...base, status: "active" },
      110,
      observedAt,
    ),
    null,
  );
  assert.equal(
    buildPostCloseFollowupSnapshot(
      { ...base, status: "expired" },
      0,
      observedAt,
    ),
    null,
  );
});

test("post-close follow-up keeps short direction and exact hour 72", () => {
  const closedAt = new Date("2026-08-20T00:00:00.000Z");
  const snapshot = buildPostCloseFollowupSnapshot(
    {
      id: 9,
      symbol: "SHORT-USDT",
      status: "stop_loss",
      closedAt,
      exitPrice: 100,
      isShort: true,
    },
    88,
    new Date("2026-08-23T00:00:00.000Z"),
  );
  assert.equal(snapshot?.hourAfterClose, 72);
  assert.equal(snapshot?.movePct, 12);
  assert.equal(snapshot?.isShort, true);
});
