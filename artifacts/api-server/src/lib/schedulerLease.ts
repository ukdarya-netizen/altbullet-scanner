import { randomUUID } from "node:crypto";
import {
  getSchedulerPoolSnapshot,
  schedulerDb,
  schedulerLeasesTable,
} from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  marketCycleLeaseContext,
  type MarketCycleLeaseContext,
} from "./marketCycleContext.js";

export type { MarketCycleLeaseContext } from "./marketCycleContext.js";

export const MARKET_CYCLE_LEASE = "market-cycle";
/** Dedicated ownership row for new-signal discovery. Background jobs never use it. */
export const DISCOVERY_SCANNER_LEASE = "discovery-scanner";

// A lease nobody renews must free itself within minutes, never an hour: the
// heartbeat renews every 30 s and no caller may ask for more than MAX_TTL_MS.
const DEFAULT_TTL_MS = 3 * 60_000;
const MAX_TTL_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
/** Pauses between inline release attempts (so 3 attempts in total). */
const RELEASE_RETRY_DELAYS_MS = [500, 1_500];
/** Cadence of the background release retry after inline attempts fail. */
const RELEASE_BACKGROUND_RETRY_MS = 5_000;
const HEARTBEAT_RECONNECT_RETRY_MS = 750;
const HEARTBEAT_FAILURE_RETRY_MS = 2_000;
const LEASE_BUSY_CACHE_MS = 5_000;
let leaseBusyCache: { value: boolean; expiresAt: number } | null = null;

export class SchedulerLeaseLostError extends Error {
  constructor(
    job: string,
    action?: string,
    readonly leaseName = MARKET_CYCLE_LEASE,
  ) {
    super(
      action
        ? `Scheduler lease ${leaseName} for ${job} was lost; refusing stale ${action}`
        : `Scheduler lease ${leaseName} for ${job} was lost`,
    );
    this.name = "SchedulerLeaseLostError";
  }
}

/**
 * The control-plane pool already applies a server-side query deadline. This
 * error distinguishes a missing lease (another worker owns it) from a failed
 * attempt to contact PostgreSQL at all.
 */
export class SchedulerLeaseAcquireError extends Error {
  constructor(
    readonly leaseName: string,
    cause?: unknown,
  ) {
    super(
      `Scheduler lease ${leaseName} could not be acquired because the control-plane database is unavailable`,
      { cause },
    );
    this.name = "SchedulerLeaseAcquireError";
  }
}

export type SchedulerLeaseLossDetails = {
  job: string;
  leaseName: string;
  ownerToken: string;
  reason:
    | "ownership_changed"
    | "heartbeat_failed"
    | "ttl_elapsed"
    | "caller_cancelled";
};

/**
 * The market work may have completed, but it is unsafe to report the cycle as
 * complete while its shared lease could still prevent the next worker from
 * starting. The row self-recovers at expectedExpiryAt.
 */
export class SchedulerLeaseReleaseError extends Error {
  readonly expectedExpiryAt: Date;
  /** The market work error, if release also failed while it was unwinding. */
  readonly workError: unknown;

  constructor(
    readonly job: string,
    expectedExpiryAt: Date,
    readonly ownerToken: string,
    cause?: unknown,
    workError?: unknown,
    readonly leaseName = MARKET_CYCLE_LEASE,
  ) {
    super(
      `Scheduler lease ${leaseName} for ${job} could not be released; retry after ${expectedExpiryAt.toISOString()}`,
      { cause },
    );
    this.name = "SchedulerLeaseReleaseError";
    this.expectedExpiryAt = expectedExpiryAt;
    this.workError = workError;
  }
}

/**
 * Reject a scheduler-side write or external delivery after the lease heartbeat
 * knows it is no longer the owner. Calls outside a market-cycle lease are
 * intentionally unaffected (webhooks and outbox delivery have their own
 * ownership mechanisms).
 */
export function assertMarketCycleLeaseOwnership(action?: string): void {
  marketCycleLeaseContext.getStore()?.throwIfLost(action);
}

/** Current scheduler job, if the call is running under a market-cycle lease. */
export function getMarketCycleJob(): string | undefined {
  return marketCycleLeaseContext.getStore()?.job;
}

/**
 * Lets HTTP clients compose their normal timeout with the owning cycle's abort
 * signal.  This is intentionally read-only: only the lease owner may abort.
 */
export function getMarketCycleAbortSignal(): AbortSignal | undefined {
  return marketCycleLeaseContext.getStore()?.signal;
}

/**
 * Cross-process guard for low-priority timers.  It is deliberately cached for
 * only a few seconds: avoiding a burst of identical reads matters, but scanner
 * start must not be delayed behind stale "idle" state.
 */
export async function isMarketCycleLeaseBusy(): Promise<boolean> {
  if (leaseBusyCache && leaseBusyCache.expiresAt > Date.now()) {
    return leaseBusyCache.value;
  }
  const rows = await schedulerDb
    .select({ leaseName: schedulerLeasesTable.leaseName })
    .from(schedulerLeasesTable)
    .where(
      and(
        eq(schedulerLeasesTable.leaseName, MARKET_CYCLE_LEASE),
        gte(schedulerLeasesTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const value = rows.length > 0;
  leaseBusyCache = { value, expiresAt: Date.now() + LEASE_BUSY_CACHE_MS };
  return value;
}

export type SchedulerLeaseStatus = {
  busy: boolean;
  expectedExpiryAt: Date | null;
  ownerToken: string | null;
  acquiredAt: Date | null;
  heartbeatAt: Date | null;
  pool: ReturnType<typeof getSchedulerPoolSnapshot>;
};

/** Reads one named lease without conflating scanner ownership with backgrounds. */
export async function getSchedulerLeaseStatus(
  leaseName: string,
): Promise<SchedulerLeaseStatus> {
  const [row] = await schedulerDb
    .select({
      expiresAt: schedulerLeasesTable.expiresAt,
      ownerToken: schedulerLeasesTable.ownerToken,
      acquiredAt: schedulerLeasesTable.acquiredAt,
      heartbeatAt: schedulerLeasesTable.heartbeatAt,
    })
    .from(schedulerLeasesTable)
    .where(
      and(
        eq(schedulerLeasesTable.leaseName, leaseName),
        gte(schedulerLeasesTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return {
    busy: Boolean(row),
    expectedExpiryAt: row?.expiresAt ?? null,
    ownerToken: row?.ownerToken ?? null,
    acquiredAt: row?.acquiredAt ?? null,
    heartbeatAt: row?.heartbeatAt ?? null,
    pool: getSchedulerPoolSnapshot(),
  };
}

/** Run durable work that owns its own claim independently of a scan lease. */
export function runOutsideMarketCycleLease<T>(work: () => T): T {
  return marketCycleLeaseContext.run(undefined, work);
}

type LeaseHandle = {
  ownerToken: string;
  expiresAt: Date;
};

function asLeaseRow(
  rows: unknown[],
): { ownerToken: string; expiresAt: Date | string } | null {
  const row = rows[0] as
    | { owner_token?: string; expires_at?: Date | string }
    | undefined;
  if (!row?.owner_token || !row.expires_at) return null;
  return { ownerToken: row.owner_token, expiresAt: row.expires_at };
}

export async function assertSchedulerLeaseSchema(): Promise<void> {
  const result = await schedulerDb.execute<{ column_name: string }>(
    sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'scheduler_leases'
        AND column_name IN ('lease_name', 'owner_token', 'acquired_at', 'heartbeat_at', 'expires_at')
    `,
  );
  const requiredColumns = [
    "lease_name",
    "owner_token",
    "acquired_at",
    "heartbeat_at",
    "expires_at",
  ];
  const presentColumns = new Set(result.rows.map((row) => row.column_name));
  const missingColumns = requiredColumns.filter(
    (column) => !presentColumns.has(column),
  );
  if (missingColumns.length > 0) {
    throw new Error(
      `scheduler_leases schema is incomplete (${missingColumns.join(", ")}); apply the normal schema migration before starting schedulers`,
    );
  }
}
async function tryAcquire(
  leaseName: string,
  ttlMs: number,
): Promise<LeaseHandle | null> {
  const ownerToken = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  let result;
  try {
    result = await schedulerDb.execute(sql`
      INSERT INTO scheduler_leases (
        lease_name, owner_token, acquired_at, heartbeat_at, expires_at
      )
      VALUES (${leaseName}, ${ownerToken}, NOW(), NOW(), ${expiresAt})
      ON CONFLICT (lease_name) DO UPDATE
        SET owner_token = EXCLUDED.owner_token,
            acquired_at = NOW(),
            heartbeat_at = NOW(),
            expires_at = EXCLUDED.expires_at
        WHERE scheduler_leases.expires_at <= NOW()
      RETURNING owner_token, expires_at
    `);
  } catch (err) {
    throw new SchedulerLeaseAcquireError(leaseName, err);
  }
  const row = asLeaseRow(result.rows);
  if (!row || row.ownerToken !== ownerToken) return null;
  return {
    ownerToken,
    expiresAt: new Date(row.expiresAt),
  };
}

/**
 * A terminated PostgreSQL socket is removed by pg-pool. Retrying one
 * heartbeat after a short delay therefore uses a freshly connected scheduler
 * client instead of treating one transport hiccup as permanent lease loss.
 */
export async function retrySchedulerLeaseHeartbeat<T>(
  renewOperation: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  try {
    return await renewOperation();
  } catch (firstError) {
    logger.warn(
      { err: firstError, retryInMs: HEARTBEAT_RECONNECT_RETRY_MS },
      "Scheduler lease heartbeat transport failure; retrying once on a fresh control-plane connection",
    );
    await wait(HEARTBEAT_RECONNECT_RETRY_MS);
    return renewOperation();
  }
}

/** A failed heartbeat cancels work only once the persisted TTL has elapsed. */
export function isLeaseTtlElapsed(nowMs: number, deadlineMs: number): boolean {
  return nowMs >= deadlineMs;
}

async function renew(
  leaseName: string,
  ownerToken: string,
  ttlMs: number,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const result = await schedulerDb
    .update(schedulerLeasesTable)
    .set({ heartbeatAt: new Date(), expiresAt })
    .where(
      and(
        eq(schedulerLeasesTable.leaseName, leaseName),
        eq(schedulerLeasesTable.ownerToken, ownerToken),
        gte(schedulerLeasesTable.expiresAt, new Date()),
      ),
    )
    .returning({ ownerToken: schedulerLeasesTable.ownerToken });
  return result.length === 1;
}

async function release(leaseName: string, ownerToken: string): Promise<void> {
  await schedulerDb
    .delete(schedulerLeasesTable)
    .where(
      and(
        eq(schedulerLeasesTable.leaseName, leaseName),
        eq(schedulerLeasesTable.ownerToken, ownerToken),
      ),
    );
  if (leaseName === MARKET_CYCLE_LEASE) leaseBusyCache = null;
}

/**
 * Deleting by owner token is idempotent, so a failed or timed-out release can
 * be repeated safely. Inline retries cover a transient socket failure; the
 * background loop keeps trying until the persisted TTL would free the row.
 */
async function releaseWithRetry(
  leaseName: string,
  ownerToken: string,
  timeoutMs: number,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RELEASE_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await releaseWithinDeadline(leaseName, ownerToken, timeoutMs);
      if (attempt > 0) {
        logger.info(
          { leaseName, attempt: attempt + 1 },
          "Scheduler lease released after retry",
        );
      }
      return;
    } catch (err) {
      lastError = err;
      logger.warn(
        { err, leaseName, attempt: attempt + 1 },
        "Scheduler lease release attempt failed",
      );
      const delay = RELEASE_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

function retryReleaseInBackground(
  leaseName: string,
  ownerToken: string,
  timeoutMs: number,
  giveUpAtMs: number,
): void {
  const tick = () => {
    if (Date.now() >= giveUpAtMs) return;
    releaseWithinDeadline(leaseName, ownerToken, timeoutMs).then(
      () =>
        logger.info(
          { leaseName },
          "Scheduler lease released by background retry",
        ),
      () => {
        const timer = setTimeout(tick, RELEASE_BACKGROUND_RETRY_MS);
        timer.unref?.();
      },
    );
  };
  const timer = setTimeout(tick, RELEASE_BACKGROUND_RETRY_MS);
  timer.unref?.();
}

async function releaseWithinDeadline(
  leaseName: string,
  ownerToken: string,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      release(leaseName, ownerToken),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `Scheduler lease ${leaseName} release timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Best-effort cross-worker serialization for market jobs without holding a
 * database connection open. A process crash self-recovers when the persisted
 * TTL expires. Jobs must keep writes idempotent: a DB outage or event-loop
 * stall that outlives the TTL can allow a new owner before old work unwinds.
 */
export async function withSchedulerLease<T>(
  leaseName: string,
  job: string,
  work: (lease: MarketCycleLeaseContext) => Promise<T>,
  options: {
    ttlMs?: number;
    heartbeatMs?: number;
    /** Cancels the owned work when its caller has reached a hard deadline. */
    signal?: AbortSignal;
    /** Bounds an uncertain release so scheduler recovery can continue. */
    releaseTimeoutMs?: number;
    /** Scanner uses this to terminate an old process before its lease expires. */
    onLeaseLost?: (details: SchedulerLeaseLossDetails) => void;
  } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const ttlMs = Math.min(options.ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS);
  const heartbeatMs = Math.min(
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    ttlMs / 2,
  );
  const handle = await tryAcquire(leaseName, ttlMs);
  if (!handle) {
    logger.info(
      { job, leaseName },
      "Scheduler job skipped because another worker owns its lease",
    );
    return { acquired: false };
  }
  if (leaseName === MARKET_CYCLE_LEASE) {
    leaseBusyCache = {
      value: true,
      expiresAt: Date.now() + LEASE_BUSY_CACHE_MS,
    };
  }

  const controller = new AbortController();
  let leaseDeadlineMs = handle.expiresAt.getTime();
  let leaseLost = false;
  const loseLease = (
    reason:
      | "ownership_changed"
      | "heartbeat_failed"
      | "ttl_elapsed"
      | "caller_cancelled",
    err?: unknown,
  ) => {
    if (leaseLost) return;
    leaseLost = true;
    const error = new SchedulerLeaseLostError(job, undefined, leaseName);
    controller.abort(error);
    logger.error(
      { err, job, leaseName, ownerToken: handle.ownerToken, reason },
      reason === "ownership_changed"
        ? "Scheduler lease was lost; cancelling stale work before side effects"
        : reason === "heartbeat_failed"
          ? "Scheduler lease heartbeat failed; cancelling work conservatively before the TTL can become stale"
          : reason === "caller_cancelled"
            ? "Scheduler lease caller deadline reached; cancelling stale work before the next cycle"
            : "Scheduler lease reached its local TTL; cancelling work before stale side effects",
    );
    if (reason !== "caller_cancelled") {
      try {
        options.onLeaseLost?.({
          job,
          leaseName,
          ownerToken: handle.ownerToken,
          reason,
        });
      } catch (callbackError) {
        logger.error(
          { err: callbackError, job, leaseName, reason },
          "Scheduler lease-loss callback failed",
        );
      }
    }
  };
  const onCallerAbort = () =>
    loseLease("caller_cancelled", options.signal?.reason);
  if (options.signal?.aborted) onCallerAbort();
  else options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const lease: MarketCycleLeaseContext = {
    job,
    ownerToken: handle.ownerToken,
    signal: controller.signal,
    throwIfLost(action?: string) {
      if (!controller.signal.aborted && Date.now() >= leaseDeadlineMs) {
        loseLease("ttl_elapsed");
      }
      if (controller.signal.aborted) {
        throw new SchedulerLeaseLostError(job, action, leaseName);
      }
    },
  };

  // A failed heartbeat is not lease loss: the persisted TTL is still valid until
  // leaseDeadlineMs (measured from the start of the last confirmed renewal).
  // Keep retrying on a short cadence and cancel only when the TTL really lapses
  // or another owner is confirmed. Fencing still applies via throwIfLost().
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatStopped = false;
  const armDeadline = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (heartbeatStopped) return;
    deadlineTimer = setTimeout(
      () => !heartbeatStopped && loseLease("ttl_elapsed"),
      Math.max(0, leaseDeadlineMs - Date.now()),
    );
  };
  const scheduleHeartbeat = (delayMs: number) => {
    if (heartbeatStopped || leaseLost) return;
    heartbeatTimer = setTimeout(runHeartbeat, delayMs);
  };
  const runHeartbeat = () => {
    if (heartbeatStopped || leaseLost) return;
    const startedAt = Date.now();
    void retrySchedulerLeaseHeartbeat(() =>
      renew(leaseName, handle.ownerToken, ttlMs),
    )
      .then((renewed) => {
        if (heartbeatStopped) return;
        if (!renewed) {
          loseLease("ownership_changed");
          return;
        }
        // The stored expiry is computed from the request time, not completion.
        leaseDeadlineMs = startedAt + ttlMs;
        armDeadline();
        scheduleHeartbeat(heartbeatMs);
      })
      .catch((err) => {
        if (heartbeatStopped) return;
        if (isLeaseTtlElapsed(Date.now(), leaseDeadlineMs)) {
          loseLease("heartbeat_failed", err);
          return;
        }
        logger.warn(
          {
            err,
            job,
            leaseName,
            remainingTtlMs: leaseDeadlineMs - Date.now(),
          },
          "Scheduler lease heartbeat failed; TTL still valid, retrying",
        );
        scheduleHeartbeat(HEARTBEAT_FAILURE_RETRY_MS);
      });
  };
  armDeadline();
  scheduleHeartbeat(heartbeatMs);

  let workCompleted = false;
  let workError: unknown;
  try {
    const value = await marketCycleLeaseContext.run(lease, () => work(lease));
    lease.throwIfLost("market job completion");
    workCompleted = true;
    return { acquired: true, value };
  } catch (err) {
    workError = err;
    throw err;
  } finally {
    heartbeatStopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (!controller.signal.aborted) {
      controller.abort(
        new SchedulerLeaseLostError(job, "post-release work", leaseName),
      );
    }
    try {
      const releaseTimeoutMs =
        options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
      await releaseWithRetry(leaseName, handle.ownerToken, releaseTimeoutMs);
    } catch (err) {
      const releaseTimeoutForRetry =
        options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
      retryReleaseInBackground(
        leaseName,
        handle.ownerToken,
        releaseTimeoutForRetry,
        leaseDeadlineMs,
      );
      // A timed-out delete may still reach PostgreSQL later. Until the last
      // confirmed heartbeat expiry, conservatively report the lease as busy.
      if (leaseName === MARKET_CYCLE_LEASE) {
        leaseBusyCache = {
          value: true,
          expiresAt: Math.max(
            leaseDeadlineMs,
            Date.now() + LEASE_BUSY_CACHE_MS,
          ),
        };
      }
      logger.warn(
        {
          err,
          job,
          leaseName,
          ownerToken: handle.ownerToken,
          expectedExpiryAt: new Date(leaseDeadlineMs),
        },
        "Scheduler lease release failed; owner recovery must wait for TTL",
      );
      // The uncertain lease is operationally more important than the work
      // exception: recovery needs its expiry to avoid starting a parallel
      // market cycle. Keep the original work failure attached for diagnostics.
      throw new SchedulerLeaseReleaseError(
        job,
        new Date(leaseDeadlineMs),
        handle.ownerToken,
        err,
        workCompleted ? undefined : workError,
        leaseName,
      );
    }
  }
}

/** Compatibility wrapper for watcher and every non-discovery market job. */
export function withMarketCycleLease<T>(
  job: string,
  work: (lease: MarketCycleLeaseContext) => Promise<T>,
  options: {
    ttlMs?: number;
    heartbeatMs?: number;
    signal?: AbortSignal;
    releaseTimeoutMs?: number;
    onLeaseLost?: (details: SchedulerLeaseLossDetails) => void;
  } = {},
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  return withSchedulerLease(MARKET_CYCLE_LEASE, job, work, options);
}
