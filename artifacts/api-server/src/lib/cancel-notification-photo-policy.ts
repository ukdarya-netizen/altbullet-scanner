import { basename, dirname, join } from "node:path";

/**
 * Older cancellation outbox rows used the BE-locked image for closes that the
 * tracker classified as stop_loss. Repair those queued rows at dispatch time;
 * the photo path is persisted before the Telegram worker sends it.
 */
export function photoPathForQueuedCancellationDelivery(
  eventKey: string,
  photoPath: string,
): string {
  if (
    /^cancel:[0-9]+:(?:max_age|stale|smart_cancel)$/.test(eventKey) &&
    basename(photoPath) === "breakeven_locked.png"
  ) {
    return join(dirname(photoPath), "stoploss.png");
  }
  return photoPath;
}
