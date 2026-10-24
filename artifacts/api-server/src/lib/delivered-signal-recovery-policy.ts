export function shouldRecoverDeliveredSignal(
  signalDetectedAt: Date,
  latestTrackerDetectedAt: Date | null,
): boolean {
  return (
    latestTrackerDetectedAt == null ||
    latestTrackerDetectedAt.getTime() <= signalDetectedAt.getTime()
  );
}
