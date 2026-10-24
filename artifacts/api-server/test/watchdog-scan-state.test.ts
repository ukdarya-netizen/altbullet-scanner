import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readWatchdogDiscoveryLeaseStatus,
  resolveWatchdogScanState,
} from "../src/lib/watchdog-scan-state.js";

test("watchdog identifies a real discovery cycle", () => {
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "running" },
      { busy: false, expectedExpiryAt: null },
      null,
    ),
    {
      isScanning: true,
      source: "scanner-running",
      blocker: "discovery scanner выполняет цикл",
      expectedAction: "watchdog ждёт завершения цикла",
    },
  );
});

test("watchdog distinguishes another scanner worker from background work", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: true, expectedExpiryAt: expiry },
      null,
    ),
    {
      isScanning: true,
      source: "scanner-lease-wait",
      blocker: "другой worker удерживает discovery-scanner lease",
      expectedAction: `ждём lease до ${expiry.toISOString()}`,
    },
  );
});

test("watchdog reports an unreleased discovery lease after a database outage", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: false, expectedExpiryAt: null },
      {
        failureReason: "lease_release_failed",
        expectedLeaseExpiryAt: expiry,
      },
    ),
    {
      isScanning: false,
      source: "lease-release-recovery",
      blocker: "discovery lease не подтверждённо освобождён после сбоя БД",
      expectedAction: `повторить discovery после TTL ${expiry.toISOString()}`,
    },
  );
});

test("watchdog identifies an unavailable discovery lease control-plane", () => {
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: false, expectedExpiryAt: null },
      {
        failureReason: "lease_control_plane_unavailable",
        expectedLeaseExpiryAt: null,
      },
    ),
    {
      isScanning: false,
      source: "lease-control-plane-recovery",
      blocker:
        "discovery scanner не может связаться с PostgreSQL control-plane для lease",
      expectedAction:
        "scanner повторяет acquisition с коротким backoff; необязательные DB jobs отложены",
    },
  );
});

test("watchdog keeps reporting control-plane recovery when the status read fails", async () => {
  const result = await readWatchdogDiscoveryLeaseStatus(
    { kind: "idle" },
    null,
    async () => {
      throw new Error("Connection terminated due to connection timeout");
    },
  );
  assert.deepEqual(result, {
    lease: { busy: false, expectedExpiryAt: null },
    controlPlaneUnavailable: true,
  });
});

test("watchdog does not query a known unavailable control-plane again", async () => {
  let statusCalls = 0;
  const result = await readWatchdogDiscoveryLeaseStatus(
    { kind: "idle" },
    {
      failureReason: "lease_control_plane_unavailable",
      expectedLeaseExpiryAt: null,
    },
    async () => {
      statusCalls++;
      return { busy: true, expectedExpiryAt: new Date() };
    },
  );
  assert.equal(statusCalls, 0);
  assert.deepEqual(result, {
    lease: { busy: false, expectedExpiryAt: null },
    controlPlaneUnavailable: false,
  });
});

test("a live discovery lease takes precedence over a historical release failure", () => {
  const expiry = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      { kind: "idle" },
      { busy: true, expectedExpiryAt: expiry },
      {
        failureReason: "lease_release_failed",
        expectedLeaseExpiryAt: expiry,
      },
    ),
    {
      isScanning: true,
      source: "scanner-lease-wait",
      blocker: "другой worker удерживает discovery-scanner lease",
      expectedAction: `ждём lease до ${expiry.toISOString()}`,
    },
  );
});

test("watchdog reports a stuck settlement fence and its restart action", () => {
  const graceExpiresAt = new Date(Date.now() + 60_000);
  assert.deepEqual(
    resolveWatchdogScanState(
      {
        kind: "settlement_fence",
        pendingSince: new Date(),
        graceExpiresAt,
        restartRequested: false,
      },
      { busy: false, expectedExpiryAt: null },
      null,
    ),
    {
      isScanning: false,
      source: "settlement-fence",
      blocker: "предыдущий discovery-цикл не завершил settlement fence",
      expectedAction:
        "ожидаем завершение fence до grace period; затем worker будет перезапущен",
    },
  );
});
