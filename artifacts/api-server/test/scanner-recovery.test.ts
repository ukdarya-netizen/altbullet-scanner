import assert from "node:assert/strict";
import test from "node:test";
import {
  ScannerCycleSettlementFence,
  ScannerRecoveryScheduler,
  shouldRetainLeaseReleaseFailure,
} from "../src/lib/scannerRecovery.js";
import { parseBingXLastPriceMessage } from "../src/lib/bingx.js";
import {
  isRealtimeTrailingStopHit,
  RealtimeTrailingMonitorFence,
} from "../src/lib/trailing-stop.js";

class SchedulerLeaseReleaseError extends Error {}
class SchedulerLeaseLostError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("lease-release failure schedules the next scanner attempt without parallel work", async () => {
  const scheduler = new ScannerRecoveryScheduler();
  let activeAttempts = 0;
  let maxActiveAttempts = 0;
  let attempts = 0;
  let releaseFirstAttempt!: () => void;
  const firstAttemptCanFinish = new Promise<void>((resolve) => {
    releaseFirstAttempt = resolve;
  });

  const firstAttempt = scheduler.run(async () => {
    attempts++;
    activeAttempts++;
    maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
    await firstAttemptCanFinish;
    activeAttempts--;
    throw new SchedulerLeaseReleaseError("lease release failed");
  });

  // A duplicate timer cannot begin a second market cycle while recovery work
  // is still unwinding.
  assert.equal(
    await scheduler.run(async () => {
      attempts++;
    }),
    false,
  );
  releaseFirstAttempt();
  await assert.rejects(firstAttempt, SchedulerLeaseReleaseError);

  scheduler.schedule(1, async () => {
    attempts++;
    activeAttempts++;
    maxActiveAttempts = Math.max(maxActiveAttempts, activeAttempts);
    activeAttempts--;
  });
  await sleep(25);

  assert.equal(attempts, 2);
  assert.equal(maxActiveAttempts, 1);
});

test("startup lease-loss error leaves the scheduler able to retry automatically", async () => {
  const scheduler = new ScannerRecoveryScheduler();
  let attempts = 0;

  await assert.rejects(
    () =>
      scheduler.run(async () => {
        attempts++;
        throw new SchedulerLeaseLostError("startup lease lost");
      }),
    SchedulerLeaseLostError,
  );

  scheduler.schedule(1, async () => {
    attempts++;
  });
  await sleep(25);

  assert.equal(attempts, 2);
});

test("a busy retry keeps the unexpired lease-release failure and expiry", () => {
  const expiry = new Date(Date.now() + 30_000);

  assert.equal(
    shouldRetainLeaseReleaseFailure(
      {
        reason: "lease_release_failed",
        expectedLeaseExpiryAt: expiry,
      },
      "lease_busy",
    ),
    true,
  );
  assert.equal(
    shouldRetainLeaseReleaseFailure(
      {
        reason: "lease_release_failed",
        expectedLeaseExpiryAt: new Date(Date.now() - 1),
      },
      "lease_busy",
    ),
    false,
  );
});

test("a timed-out cycle fence blocks recovery until the old cycle settles", async () => {
  const fence = new ScannerCycleSettlementFence();
  let releaseCycle!: () => void;
  const oldCycle = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  let settledCallbacks = 0;

  fence.hold(oldCycle, () => {
    settledCallbacks++;
  });
  assert.equal(fence.isPending(), true);

  releaseCycle();
  await sleep(1);

  assert.equal(fence.isPending(), false);
  assert.equal(settledCallbacks, 1);
});

test("a restart-style initial attempt is deferred while the timed-out cycle is fenced", async () => {
  const fence = new ScannerCycleSettlementFence();
  let releaseCycle!: () => void;
  const oldCycle = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  let initialScans = 0;
  const startInitialScan = () => {
    if (fence.isPending()) return false;
    initialScans++;
    return true;
  };

  fence.hold(oldCycle, () => undefined);
  assert.equal(startInitialScan(), false);
  assert.equal(initialScans, 0);

  releaseCycle();
  await sleep(1);
  assert.equal(startInitialScan(), true);
  assert.equal(initialScans, 1);
});

test("an unsettled fence requests exactly one process-boundary restart after grace", async () => {
  const fence = new ScannerCycleSettlementFence();
  let releaseCycle!: () => void;
  const oldCycle = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  let restartRequests = 0;
  let requestedState:
    | ReturnType<ScannerCycleSettlementFence["getState"]>
    | undefined;

  fence.hold(oldCycle, () => undefined, {
    graceMs: 10,
    onGraceExpired: (state) => {
      restartRequests++;
      requestedState = state;
    },
  });
  await sleep(30);

  assert.equal(restartRequests, 1);
  assert.equal(requestedState?.pending, true);
  assert.equal(requestedState?.restartRequested, true);
  assert.equal(fence.isPending(), true);

  releaseCycle();
  await sleep(1);
  assert.equal(fence.isPending(), false);
});

test("a live trailing tick closes a short dip but ignores data from before protection armed", () => {
  const armedAt = new Date("2026-08-25T12:00:00.000Z");
  const preActivationLow = new Date("2026-08-25T11:59:59.000Z");
  const dip = new Date("2026-08-25T12:00:02.000Z");
  const recovered = new Date("2026-08-25T12:00:04.000Z");

  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 99,
      trailingStopLevel: 100,
      armedAt,
      observedAt: preActivationLow,
    }),
    false,
  );
  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 99,
      trailingStopLevel: 100,
      armedAt,
      observedAt: dip,
    }),
    true,
  );
  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 103,
      trailingStopLevel: 100,
      armedAt,
      observedAt: recovered,
    }),
    false,
  );
  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 99,
      trailingStopLevel: 100,
      armedAt,
      // A delayed decode must not turn an old exchange frame into a new hit.
      observedAt: new Date("2026-08-25T12:00:05.000Z"),
      exchangeAt: preActivationLow,
    }),
    false,
  );
  const raisedLevelArmedAt = new Date("2026-08-25T12:01:00.000Z");
  assert.equal(
    isRealtimeTrailingStopHit({
      currentPrice: 104,
      trailingStopLevel: 105,
      armedAt: raisedLevelArmedAt,
      // This tick is valid for the old +100 level, but must not close against
      // the higher level that was armed one minute later.
      observedAt: new Date("2026-08-25T12:00:30.000Z"),
      exchangeAt: new Date("2026-08-25T12:00:30.000Z"),
    }),
    false,
  );
});

test("BingX last-price parser preserves the stream symbol and receipt time", () => {
  const receivedAt = new Date("2026-08-25T12:00:02.000Z");
  const update = parseBingXLastPriceMessage(
    {
      dataType: "ALPHA-USDT@lastPrice",
      data: { price: "99.25", E: receivedAt.getTime() },
    },
    receivedAt,
  );

  assert.deepEqual(update, {
    symbol: "ALPHA-USDT",
    price: 99.25,
    observedAt: receivedAt,
    exchangeAt: new Date("2026-08-25T12:00:02.000Z"),
  });
});

test("a stopped realtime monitor cannot resume inside its replacement lifecycle", () => {
  const fence = new RealtimeTrailingMonitorFence();
  const stoppedGeneration = fence.start();
  assert.equal(fence.isCurrent(stoppedGeneration), true);

  fence.stop();
  const replacementGeneration = fence.start();

  assert.equal(fence.isCurrent(stoppedGeneration), false);
  assert.equal(fence.isCurrent(replacementGeneration), true);
});
