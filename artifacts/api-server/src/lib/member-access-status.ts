import type { DashboardAccessStatus } from "./dashboard-access-policy.js";

export type MemberSource = "both" | "dashboard" | "bot";
export type MemberBotAccessStatus =
  | "active"
  | "expired"
  | "inactive"
  | "blocked";
export type MemberAccessStatus =
  | "active"
  | "expired"
  | "inactive"
  | "pending"
  | "blocked";

export function getMemberBotAccessStatus(
  subscriber:
    | {
        active: boolean;
        subscribedUntil: Date | null;
        botBlockedAt?: Date | null;
      }
    | undefined,
  now: Date,
): MemberBotAccessStatus | null {
  if (!subscriber) return null;
  if (subscriber.botBlockedAt != null) return "blocked";
  if (
    subscriber.subscribedUntil !== null &&
    subscriber.subscribedUntil <= now
  ) {
    return "expired";
  }
  return subscriber.active ? "active" : "inactive";
}

export function getDashboardLinkedBotAccessStatus(
  dashboardStatus: DashboardAccessStatus,
  hasTelegramChatId: boolean,
): MemberBotAccessStatus | null {
  if (!hasTelegramChatId) return null;
  if (dashboardStatus === "approved") return "active";
  if (dashboardStatus === "expired") return "expired";
  return "inactive";
}

export function getMemberAccessStatus(params: {
  source: MemberSource;
  dashboardStatus: DashboardAccessStatus | null;
  botAccessStatus: MemberBotAccessStatus | null;
}): MemberAccessStatus {
  if (params.botAccessStatus === "blocked") return "blocked";
  if (params.dashboardStatus !== null) {
    if (params.dashboardStatus === "approved") return "active";
    return params.dashboardStatus;
  }
  if (params.botAccessStatus !== null) return params.botAccessStatus;
  return "inactive";
}
