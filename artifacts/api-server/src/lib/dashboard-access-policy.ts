export type DashboardAccessStatus =
  | "pending"
  | "approved"
  | "blocked"
  | "expired";

export function getDashboardAccessStatus(params: {
  isOwner: boolean;
  status: string;
  subscribedUntil: Date | null;
  now: Date;
}): DashboardAccessStatus {
  if (
    !params.isOwner &&
    params.status === "approved" &&
    params.subscribedUntil !== null &&
    params.subscribedUntil <= params.now
  ) {
    return "expired";
  }

  if (
    params.status === "pending" ||
    params.status === "approved" ||
    params.status === "blocked" ||
    params.status === "expired"
  ) {
    return params.status;
  }

  return "blocked";
}

export function canResubmitExpiredDashboardAccount(params: {
  isOwner: boolean;
  status: string;
  subscribedUntil: Date | null;
  now: Date;
}): boolean {
  return (
    !params.isOwner &&
    (params.status === "expired" || params.status === "approved") &&
    params.subscribedUntil !== null &&
    params.subscribedUntil <= params.now
  );
}

export function shouldRestoreExpiredDashboardAccount(params: {
  status: string;
  subscribedUntil: Date | null;
  now: Date;
}): boolean {
  return (
    params.status === "expired" &&
    (params.subscribedUntil === null || params.subscribedUntil > params.now)
  );
}
