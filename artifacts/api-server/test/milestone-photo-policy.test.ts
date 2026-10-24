import assert from "node:assert/strict";
import { test } from "node:test";
import { photoPathForQueuedTargetHit } from "../src/lib/milestone-photo-policy.js";

test("queued BTC and >200% milestones use the target-hit image", () => {
  assert.equal(
    photoPathForQueuedTargetHit(
      "milestone:v3:12:milestone:3",
      "/app/assets/impulse_runner_closed.png",
    ),
    "/app/assets/target_hit.png",
  );
  assert.equal(
    photoPathForQueuedTargetHit(
      "milestone:v3:42:milestone:250",
      "/app/assets/position_update.png",
    ),
    "/app/assets/target_hit.png",
  );
});

test("the Runner close, 200% milestone, and unrelated notifications keep their images", () => {
  assert.equal(
    photoPathForQueuedTargetHit(
      "position:12:impulse_runner_closed",
      "/app/assets/impulse_runner_closed.png",
    ),
    "/app/assets/impulse_runner_closed.png",
  );
  assert.equal(
    photoPathForQueuedTargetHit(
      "milestone:v3:42:milestone:200",
      "/app/assets/milestone200.png",
    ),
    "/app/assets/milestone200.png",
  );
  assert.equal(
    photoPathForQueuedTargetHit(
      "milestone:v3:42:milestone:100",
      "/app/assets/position_update.png",
    ),
    "/app/assets/position_update.png",
  );
});
