/**
 * Pure coordination helpers for primary-signal reconciliation.
 *
 * Kept dependency-free so its concurrency contract can be tested without a
 * database or Telegram runtime.
 */

/**
 * Stable PostgreSQL advisory-lock key shared by every worker.
 * Changing it during a rolling deploy would let old and new workers run
 * reconciliation concurrently.
 */
export const RECONCILE_ADVISORY_LOCK_KEY = 0x616c745f7369;

// An alert that was never queued is no longer an actionable NEW SIGNAL after
// this window. Already-queued recipient deliveries retain their own retry policy.
export const PRIMARY_ALERT_RECOVERY_MAX_AGE_MS = 10 * 60 * 1000;

export function canRecoverPrimaryAlert(
  detectedAt: Date,
  trackerStatus: string | null | undefined,
  now: Date,
): boolean {
  const ageMs = now.getTime() - detectedAt.getTime();
  return (
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= PRIMARY_ALERT_RECOVERY_MAX_AGE_MS &&
    (trackerStatus === "active" || trackerStatus === "in_run")
  );
}

export function createSingleFlight<T>(
  work: () => Promise<T>,
  onJoin?: () => void,
): () => Promise<T> {
  let inFlight: Promise<T> | null = null;

  return () => {
    if (inFlight) {
      onJoin?.();
      return inFlight;
    }

    inFlight = work().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
