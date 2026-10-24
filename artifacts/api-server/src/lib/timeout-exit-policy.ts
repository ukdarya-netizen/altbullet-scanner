import { basename, dirname, join } from "node:path";

/** Classify a lifetime close without inventing a fill at a trailing stop. */
export function classifyTimeoutExit(input: {
  pnlPercent: number;
  protectedBe: boolean;
  trailingActive: boolean;
}): "bu_stop" | "profit" | "stop_loss" | "expired" {
  if (input.trailingActive) return "profit";
  if (input.protectedBe) return "bu_stop";
  if (input.pnlPercent < 0) return "stop_loss";
  if (input.pnlPercent >= 5) return "profit";
  return "expired";
}

/** The image describes why the lifetime ended, not whether the P&L is positive. */
export function timeoutExitPhotoKind(
  status: ReturnType<typeof classifyTimeoutExit>,
): "bu_stop" | "stop_loss" | "expired" {
  if (status === "bu_stop") return "bu_stop";
  if (status === "stop_loss") return "stop_loss";
  return "expired";
}

/** A queued photo can outlive the deployment that chose it. Repair only this legacy mismatch. */
export function photoPathForTimeoutDelivery(
  eventKey: string,
  photoPath: string,
): string {
  if (
    /^position:[0-9]+:timeout:profit$/.test(eventKey) &&
    basename(photoPath) === "position_exit.png"
  ) {
    return join(dirname(photoPath), "position_expired.png");
  }
  return photoPath;
}
