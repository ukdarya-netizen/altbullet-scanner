export const SCANNER_BOOTSTRAP_RETRY_MS = 60_000;
export const SCANNER_CONTROL_PLANE_LIVENESS_GRACE_MS = 15 * 60 * 1000;
// Publishing waits roughly eight minutes for a new VM to become ready, while a
// cold scanner start can legitimately spend 10–14 minutes restoring state and
// completing its first cycle. Keep the process healthy through that window;
// persistent bootstrap failures still trigger the bounded restart policy.
export const SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS = 15 * 60 * 1000;

export type ScannerRecoveryPlan = {
  retryInMs: number;
  reason: string;
};

export type ScannerLivenessResult = {
  healthy: boolean;
  reason: string | null;
  failedSince: Date | null;
};

type ScannerLivenessInput = {
  failureReason: string | null;
  failureAt: Date | null;
  lastSuccessfulScanAt: Date | null;
  controlPlaneUnavailableSince: Date | null;
};

/**
 * Resolves the deployment probe from local state only. Database reads are
 * intentionally excluded because the probe is also the recovery path when
 * PostgreSQL is the failing dependency.
 */
export function resolveScannerLiveness(
  input: ScannerLivenessInput,
  now = Date.now(),
): ScannerLivenessResult {
  if (
    input.failureReason === "lease_control_plane_unavailable" &&
    input.controlPlaneUnavailableSince !== null &&
    now - input.controlPlaneUnavailableSince.getTime() >=
      SCANNER_CONTROL_PLANE_LIVENESS_GRACE_MS
  ) {
    return {
      healthy: false,
      reason: "lease_control_plane_unavailable",
      failedSince: input.controlPlaneUnavailableSince,
    };
  }

  // A new worker has no in-memory completion cursor yet. If it cannot bootstrap
  // at all, a 200 response would conceal a broken scanner (for example, a
  // missing required settings column) from the deployment supervisor.
  if (
    input.lastSuccessfulScanAt === null &&
    (input.failureReason === "startup_db_or_transport_error" ||
      input.failureReason === "scheduled_scan_error") &&
    input.failureAt !== null &&
    now - input.failureAt.getTime() >=
      SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS
  ) {
    return {
      healthy: false,
      reason: "scanner_bootstrap_failed",
      failedSince: input.failureAt,
    };
  }

  return { healthy: true, reason: null, failedSince: null };
}

/**
 * Keep retry decisions deterministic and free of database/network imports so
 * bootstrap failures can be tested without starting the scanner.
 */
export function getScannerBootstrapRecoveryPlan(
  error: unknown,
): ScannerRecoveryPlan {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (name === "SchedulerLeaseLostError") {
    return {
      retryInMs: SCANNER_BOOTSTRAP_RETRY_MS,
      reason: "market-cycle lease was lost during scanner startup",
    };
  }

  if (
    /connection.*timeout|authentication timed out|timeout acquiring connection|connection terminated/.test(
      message,
    )
  ) {
    return {
      retryInMs: SCANNER_BOOTSTRAP_RETRY_MS,
      reason: "database connection timed out during scanner startup",
    };
  }

  return {
    retryInMs: SCANNER_BOOTSTRAP_RETRY_MS,
    reason: "scanner startup failed before a completed market scan",
  };
}
