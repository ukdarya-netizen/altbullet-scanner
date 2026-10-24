import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildFirstTargetMilestoneTransition,
  buildStartupFirstTargetRecovery,
} from "../src/lib/milestone-transition.js";

describe("first-target milestone transition", () => {
  test("uses the reached +10% target for image and durable state after a prior +5% update", () => {
    const transition = buildFirstTargetMilestoneTransition(10);

    assert.deepEqual(transition, {
      milestone: 10,
      imageMilestone: 10,
      lastMilestone: 10,
    });
  });

  test("keeps the +10% recovery image and outbox identity stable for a second worker", () => {
    const firstWorker = buildStartupFirstTargetRecovery(4200, 10);
    const secondWorker = buildStartupFirstTargetRecovery(4200, 10);
    const committedEventKeys = new Set<string>();

    const enqueueIfNew = (eventKey: string) => {
      if (committedEventKeys.has(eventKey)) return false;
      committedEventKeys.add(eventKey);
      return true;
    };

    assert.equal(firstWorker.imageMilestone, 10);
    assert.equal(firstWorker.lastMilestone, 10);
    assert.equal(firstWorker.eventKey, "position:4200:startup:first_target");
    assert.equal(enqueueIfNew(firstWorker.eventKey), true);
    assert.equal(secondWorker.eventKey, firstWorker.eventKey);
    assert.equal(enqueueIfNew(secondWorker.eventKey), false);
  });

  test("preserves a pattern-specific first target across the visual and durable state", () => {
    const transition = buildFirstTargetMilestoneTransition(8);

    assert.deepEqual(transition, {
      milestone: 8,
      imageMilestone: 8,
      lastMilestone: 8,
    });
  });

  test("rejects an invalid first target instead of silently choosing a fallback image", () => {
    assert.throws(
      () => buildFirstTargetMilestoneTransition(0),
      /positive finite percentage/,
    );
  });
});
