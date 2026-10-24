/**
 * The active → in_run transition is one business event: the configured first
 * target becomes both the durable last milestone and the image label. Keeping
 * these values together prevents startup recovery from pairing a +10% message
 * with an older +5% card.
 */
export function buildFirstTargetMilestoneTransition(firstTarget: number) {
  if (!Number.isFinite(firstTarget) || firstTarget <= 0) {
    throw new Error("First target must be a positive finite percentage");
  }

  return {
    milestone: firstTarget,
    imageMilestone: firstTarget,
    lastMilestone: firstTarget,
  };
}

export function buildStartupFirstTargetRecovery(
  trackedSignalId: number,
  firstTarget: number,
) {
  if (!Number.isSafeInteger(trackedSignalId) || trackedSignalId <= 0) {
    throw new Error("Tracked signal ID must be a positive integer");
  }

  return {
    ...buildFirstTargetMilestoneTransition(firstTarget),
    eventKey: `position:${trackedSignalId}:startup:first_target`,
  };
}
