import type { TelegramApiCallResult } from "./telegram-api.js";

export type PendingMilestoneKind =
  | "partial"
  | "pre_target"
  | "intermediate"
  | "first_target"
  | "late_target"
  | "trailing"
  | "milestone";

export type PendingMilestoneStatus = "sending" | "failed";

export type MilestoneDeliveryOutcome =
  | { kind: "delivered"; sentCount: number }
  | { kind: "confirmed_failure"; description: string }
  | { kind: "abandoned"; description: string }
  | { kind: "ambiguous"; description: string };

// Milestone photos are sent to recipients sequentially. Keep the lease longer
// than a full 3-recipient fan-out at the media upload deadline so another
// worker cannot reclaim the same milestone midway through delivery.
export const MILESTONE_DELIVERY_LEASE_MS = 180_000;
export const MILESTONE_RETRY_DELAY_MS = 60_000;

export type CanonicalTelegramTargetSnapshot = {
  targets: number[];
  unresolvedAliases: string[];
};

export async function canonicalizeMilestoneTargets(
  targets: (number | string)[],
  resolveAlias: (alias: string) => Promise<number | null>,
): Promise<CanonicalTelegramTargetSnapshot> {
  const canonical = new Set<number>();
  const unresolved = new Set<string>();

  for (const target of targets) {
    if (typeof target === "number" && Number.isSafeInteger(target)) {
      canonical.add(target);
      continue;
    }

    const value = String(target).trim();
    const numericTarget = Number(value);
    if (value && Number.isSafeInteger(numericTarget) && numericTarget !== 0) {
      canonical.add(numericTarget);
      continue;
    }

    if (value.startsWith("@")) {
      const resolved = await resolveAlias(value);
      if (resolved !== null && Number.isSafeInteger(resolved)) {
        canonical.add(resolved);
      } else {
        unresolved.add(value.toLowerCase());
      }
    }
  }

  return {
    targets: [...canonical],
    unresolvedAliases: [...unresolved],
  };
}

export function classifyMilestoneSendResult(
  result: TelegramApiCallResult,
): MilestoneDeliveryOutcome {
  if (result.ok) return { kind: "delivered", sentCount: 1 };
  const description = result.description ?? "Telegram delivery failed";
  const normalizedDescription = description.toLowerCase();
  if (
    result.status === 403 ||
    (result.status === 400 &&
      /chat not found|user is deactivated|bot was blocked|user not found/.test(
        normalizedDescription,
      ))
  ) {
    return { kind: "abandoned", description };
  }
  // A 5xx can come from Telegram or an intermediary after the send was
  // accepted. Only an explicit Telegram 4xx rejection is safe to retry.
  if (
    (result.status !== null && result.status >= 400 && result.status < 500) ||
    (result.status === null && !result.retryable)
  ) {
    return { kind: "confirmed_failure", description };
  }
  return { kind: "ambiguous", description };
}

export function shouldFallbackMilestonePhotoToText(
  outcome: MilestoneDeliveryOutcome,
): boolean {
  return outcome.kind === "confirmed_failure";
}

export function selectRemovedMilestoneRecipients(
  rows: Array<{ target: string; status: string }>,
  configuredTargets: number[],
  unresolvedAliases: string[],
): string[] {
  // A failed alias resolution means the current target list is incomplete;
  // never abandon a durable recipient based on that partial snapshot.
  if (unresolvedAliases.length > 0) return [];

  const configured = new Set(configuredTargets.map(String));
  return rows
    .filter(
      (row) =>
        (row.status === "ready" || row.status === "failed") &&
        !configured.has(row.target),
    )
    .map((row) => row.target);
}

export function selectMilestoneRecipientsDueForDispatch(
  rows: Array<{
    target: string;
    status: string;
    leaseUntil: Date | null;
  }>,
  configuredTargets: number[],
  now: Date,
): number[] {
  const existingByTarget = new Map(rows.map((row) => [row.target, row]));

  return configuredTargets.filter((target) => {
    const row = existingByTarget.get(String(target));
    if (!row || row.status === "ready") return true;
    if (
      row.status === "failed" &&
      (!row.leaseUntil || row.leaseUntil.getTime() <= now.getTime())
    ) {
      return true;
    }

    // Telegram does not offer an idempotency key or a way to inspect history
    // after a timeout. Channel and direct recipients therefore share the same
    // at-most-once policy: an unknown outcome is audited, never resent.
    return false;
  });
}

export function combineMilestoneDeliveryOutcomes(
  outcomes: MilestoneDeliveryOutcome[],
): MilestoneDeliveryOutcome {
  const ambiguous = outcomes.find((outcome) => outcome.kind === "ambiguous");
  if (ambiguous?.kind === "ambiguous") return ambiguous;

  const sentCount = outcomes.reduce(
    (total, outcome) =>
      total + (outcome.kind === "delivered" ? outcome.sentCount : 0),
    0,
  );
  if (sentCount > 0) return { kind: "delivered", sentCount };

  const failure = outcomes.find(
    (outcome) => outcome.kind === "confirmed_failure",
  );
  if (!failure) {
    const abandoned = outcomes.find((outcome) => outcome.kind === "abandoned");
    if (abandoned?.kind === "abandoned") return abandoned;
  }
  return {
    kind: "confirmed_failure",
    description:
      failure?.kind === "confirmed_failure"
        ? failure.description
        : "No Telegram recipients available",
  };
}

export function summarizeMilestoneRecipientStatuses(
  statuses: string[],
): MilestoneDeliveryOutcome {
  if (statuses.some((status) => status === "failed" || status === "ready")) {
    return {
      kind: "confirmed_failure",
      description: "One or more Telegram recipients failed",
    };
  }
  if (
    statuses.some((status) => status === "processing" || status === "ambiguous")
  ) {
    return {
      kind: "ambiguous",
      description: "One or more Telegram recipient outcomes are ambiguous",
    };
  }
  const sentCount = statuses.filter((status) => status === "delivered").length;
  if (sentCount > 0) return { kind: "delivered", sentCount };
  if (
    statuses.length > 0 &&
    statuses.every((status) => status === "abandoned")
  ) {
    return {
      kind: "abandoned",
      description: "All Telegram recipients are unavailable",
    };
  }
  return {
    kind: "confirmed_failure",
    description: "No Telegram recipient was delivered",
  };
}

export function buildPendingMilestoneState(
  kind: PendingMilestoneKind,
  milestone: number,
  price: number,
  trailingStop: number,
  nowMs = Date.now(),
) {
  return {
    pendingMilestone: milestone,
    pendingMilestoneKind: kind,
    pendingMilestonePrice: price,
    pendingMilestoneTrailingStop: trailingStop,
    pendingMilestoneStatus: "sending" as const,
    pendingMilestoneLeaseUntil: new Date(nowMs + MILESTONE_DELIVERY_LEASE_MS),
  };
}

export function canRetryPendingMilestone(
  status: string | null | undefined,
  leaseUntil: Date | null | undefined,
  now: Date,
): boolean {
  return (
    status === "failed" &&
    (!leaseUntil || leaseUntil.getTime() <= now.getTime())
  );
}
