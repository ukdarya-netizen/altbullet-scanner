import { isSubscriptionActive } from "./subscription-warning.js";

export interface SubscriptionAccessState {
  active: boolean;
  subscribedUntil: Date | null;
}

/**
 * A subscription is renewed when the end date is pushed further into the future
 * while the user already has an active paid period. Mutually exclusive with
 * shouldNotifySubscriptionStarted.
 */
export function shouldNotifySubscriptionRenewed(params: {
  previous: SubscriptionAccessState;
  next: SubscriptionAccessState;
  now?: Date;
}): boolean {
  const now = params.now ?? new Date();
  const previousWasActive = isSubscriptionActive(
    params.previous.active,
    params.previous.subscribedUntil,
    now,
  );
  const nextIsActive = isSubscriptionActive(
    params.next.active,
    params.next.subscribedUntil,
    now,
  );
  const endDateExtended =
    params.next.subscribedUntil !== null &&
    params.previous.subscribedUntil !== null &&
    params.next.subscribedUntil.getTime() >
      params.previous.subscribedUntil.getTime();

  return previousWasActive && nextIsActive && endDateExtended;
}

/**
 * A paid subscription starts when access is explicitly approved, when a first
 * end date is assigned, or when an expired/inactive subscription is restored.
 * Moving an already-active paid end date must not send the welcome image again.
 */
export function shouldNotifySubscriptionStarted(params: {
  previous: SubscriptionAccessState;
  next: SubscriptionAccessState;
  becameApproved: boolean;
  now?: Date;
}): boolean {
  const now = params.now ?? new Date();
  const nextHasFutureEndDate =
    params.next.subscribedUntil !== null &&
    params.next.subscribedUntil.getTime() > now.getTime();
  const previousHadNoActivePaidPeriod =
    params.previous.subscribedUntil === null ||
    params.previous.subscribedUntil.getTime() <= now.getTime();
  const accessWasRestored =
    !isSubscriptionActive(
      params.previous.active,
      params.previous.subscribedUntil,
      now,
    ) &&
    isSubscriptionActive(params.next.active, params.next.subscribedUntil, now);

  return (
    (params.becameApproved &&
      isSubscriptionActive(
        params.next.active,
        params.next.subscribedUntil,
        now,
      )) ||
    (nextHasFutureEndDate && previousHadNoActivePaidPeriod) ||
    accessWasRestored
  );
}
