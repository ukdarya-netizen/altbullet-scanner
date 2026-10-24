import assert from "node:assert/strict";
import test from "node:test";
import {
  SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS,
  SCANNER_BOOTSTRAP_RETRY_MS,
  SCANNER_CONTROL_PLANE_LIVENESS_GRACE_MS,
  getScannerBootstrapRecoveryPlan,
  resolveScannerLiveness,
} from "../src/lib/scanner-startup-recovery.js";

test("scanner bootstrap retries promptly after an initial lease loss", () => {
  const error = new Error("Market-cycle lease for scanner was lost");
  error.name = "SchedulerLeaseLostError";

  assert.deepEqual(getScannerBootstrapRecoveryPlan(error), {
    retryInMs: SCANNER_BOOTSTRAP_RETRY_MS,
    reason: "market-cycle lease was lost during scanner startup",
  });
});

test("scanner bootstrap treats database timeouts as recoverable", () => {
  const error = new Error("Connection terminated due to connection timeout");

  assert.deepEqual(getScannerBootstrapRecoveryPlan(error), {
    retryInMs: SCANNER_BOOTSTRAP_RETRY_MS,
    reason: "database connection timed out during scanner startup",
  });
});

test("reports a scanner that never bootstrapped after the bounded grace", () => {
  const failedAt = new Date(1_000_000);

  assert.deepEqual(
    resolveScannerLiveness(
      {
        failureReason: "startup_db_or_transport_error",
        failureAt: failedAt,
        lastSuccessfulScanAt: null,
        controlPlaneUnavailableSince: null,
      },
      failedAt.getTime() + SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS,
    ),
    {
      healthy: false,
      reason: "scanner_bootstrap_failed",
      failedSince: failedAt,
    },
  );
});

test("keeps a retryable bootstrap error healthy during its grace period", () => {
  const failedAt = new Date(1_000_000);

  assert.deepEqual(
    resolveScannerLiveness(
      {
        failureReason: "startup_db_or_transport_error",
        failureAt: failedAt,
        lastSuccessfulScanAt: null,
        controlPlaneUnavailableSince: null,
      },
      failedAt.getTime() + SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS - 1,
    ),
    { healthy: true, reason: null, failedSince: null },
  );
});

test("keeps the deployment readiness probe healthy through the VM promote window", () => {
  const failedAt = new Date(1_000_000);

  assert.deepEqual(
    resolveScannerLiveness(
      {
        failureReason: "scheduled_scan_error",
        failureAt: failedAt,
        lastSuccessfulScanAt: null,
        controlPlaneUnavailableSince: null,
      },
      failedAt.getTime() + 8 * 60 * 1000,
    ),
    { healthy: true, reason: null, failedSince: null },
  );
});

test("does not restart a scanner with a completed cycle after a transient failure", () => {
  const failedAt = new Date(1_000_000);

  assert.deepEqual(
    resolveScannerLiveness(
      {
        failureReason: "scheduled_scan_error",
        failureAt: failedAt,
        lastSuccessfulScanAt: new Date(900_000),
        controlPlaneUnavailableSince: null,
      },
      failedAt.getTime() + SCANNER_BOOTSTRAP_FAILURE_LIVENESS_GRACE_MS,
    ),
    { healthy: true, reason: null, failedSince: null },
  );
});

test("retains the longer control-plane grace before reporting degraded", () => {
  const failedAt = new Date(1_000_000);

  assert.deepEqual(
    resolveScannerLiveness(
      {
        failureReason: "lease_control_plane_unavailable",
        failureAt: failedAt,
        lastSuccessfulScanAt: null,
        controlPlaneUnavailableSince: failedAt,
      },
      failedAt.getTime() + SCANNER_CONTROL_PLANE_LIVENESS_GRACE_MS,
    ),
    {
      healthy: false,
      reason: "lease_control_plane_unavailable",
      failedSince: failedAt,
    },
  );
});
