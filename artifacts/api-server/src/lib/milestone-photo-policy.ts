import { basename, dirname, join } from "node:path";

/**
 * Preserve the new image choice for milestones queued before the deployment.
 * The old Runner-close image was used only for BTC milestones; milestones over
 * 200% fell back to the generic position-update image.
 */
export function photoPathForQueuedTargetHit(
  eventKey: string,
  photoPath: string,
): string {
  const milestone = /^milestone:v3:[0-9]+:[a-z_]+:([0-9]+)$/.exec(eventKey);
  if (!milestone) return photoPath;

  const oldImage = basename(photoPath);
  if (
    oldImage === "impulse_runner_closed.png" ||
    (Number(milestone[1]) > 200 && oldImage === "position_update.png")
  ) {
    return join(dirname(photoPath), "target_hit.png");
  }
  return photoPath;
}
