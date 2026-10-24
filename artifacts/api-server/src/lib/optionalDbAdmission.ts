import { getDbPoolSnapshot, type DbPoolSnapshot } from "@workspace/db";

export type OptionalDbJobDeferral =
  | "scanner-priority"
  | "pool-pressure"
  | "another-maintenance-job"
  | "priority-maintenance-waiting";

export type OptionalDbJobAdmission =
  | { acquired: true; release: () => void }
  | { acquired: false; reason: OptionalDbJobDeferral };

/**
 * One process may run many maintenance timers. Keep at most one of them
 * admitted at a time, and never admit it while scanner recovery has declared
 * priority or the shared application pool already has waiters.
 */
export function createOptionalDbAdmission(
  getPoolSnapshot: () => DbPoolSnapshot,
) {
  let activeMaintenanceJob: string | null = null;
  const priorityWaiters = new Set<string>();

  return {
    tryAcquire(
      job: string,
      scannerHasPriority: boolean,
      priority = false,
    ): OptionalDbJobAdmission {
      if (scannerHasPriority) {
        if (priority) priorityWaiters.add(job);
        return { acquired: false, reason: "scanner-priority" };
      }
      if (getPoolSnapshot().underPressure) {
        if (priority) priorityWaiters.add(job);
        return { acquired: false, reason: "pool-pressure" };
      }
      if (activeMaintenanceJob !== null) {
        if (priority) priorityWaiters.add(job);
        return { acquired: false, reason: "another-maintenance-job" };
      }
      if (!priority && priorityWaiters.size > 0) {
        return { acquired: false, reason: "priority-maintenance-waiting" };
      }
      priorityWaiters.delete(job);
      activeMaintenanceJob = job;
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          activeMaintenanceJob = null;
        },
      };
    },
  };
}

export const optionalDbAdmission = createOptionalDbAdmission(getDbPoolSnapshot);

export async function runOptionalDbJob<T>(
  job: string,
  scannerHasPriority: boolean,
  work: () => Promise<T>,
  options: { priority?: boolean } = {},
): Promise<
  { ran: true; value: T } | { ran: false; reason: OptionalDbJobDeferral }
> {
  const admission = optionalDbAdmission.tryAcquire(
    job,
    scannerHasPriority,
    options.priority ?? false,
  );
  if (!admission.acquired) {
    return { ran: false, reason: admission.reason };
  }
  try {
    return { ran: true, value: await work() };
  } finally {
    admission.release();
  }
}
