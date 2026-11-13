import assert from "node:assert/strict";
import test from "node:test";
import { photoPathForQueuedCancellationDelivery } from "../src/lib/cancel-notification-photo-policy.js";

test("queued stop-loss cancellation replaces the legacy BE image", () => {
  assert.equal(
    photoPathForQueuedCancellationDelivery(
      "cancel:3711:smart_cancel",
      "/app/assets/breakeven_locked.png",
    ),
    "/app/assets/stoploss.png",
  );
});

test("queued cancelled and unrelated events keep their intended images", () => {
  assert.equal(
    photoPathForQueuedCancellationDelivery(
      "cancel:3712:smart_cancel",
      "/app/assets/cancel.png",
    ),
    "/app/assets/cancel.png",
  );
  assert.equal(
    photoPathForQueuedCancellationDelivery(
      "position:3711:bu_stop:return_to_entry",
      "/app/assets/breakeven_locked.png",
    ),
    "/app/assets/breakeven_locked.png",
  );
  assert.equal(
    photoPathForQueuedCancellationDelivery(
      "cancel:3711:smart_cancel",
      "/app/assets/stoploss.png",
    ),
    "/app/assets/stoploss.png",
  );
});
