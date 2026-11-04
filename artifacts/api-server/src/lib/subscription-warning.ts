import type { TelegramApiCallResult } from "./telegram-api.js";

const HOUR_MS = 60 * 60_000;

export const SUBSCRIPTION_WARNING_KIND = "expiry_3h";
export const SUBSCRIPTION_WARNING_LEASE_MS = 10 * 60_000;

/**
 * The persisted `active` flag is reconciled hourly, while the end date is
 * authoritative immediately. Use this for any UI/API representation of access.
 */
export function isSubscriptionActive(
  active: boolean,
  subscribedUntil: Date | null,
  now = new Date(),
): boolean {
  return active && (subscribedUntil === null || subscribedUntil > now);
}

export interface SubscriptionWarningRecipient {
  chatId: number;
  subscribedUntil: Date;
  source: "subscriber" | "dashboard";
}

export type SubscriptionWarningSendOutcome =
  | { kind: "delivered" }
  | { kind: "confirmed_failure"; description: string }
  | { kind: "ambiguous"; description: string };

/**
 * A transport error or timeout has no HTTP response, so Telegram may already
 * have accepted the photo. Retrying that outcome can duplicate the warning.
 * Explicit HTTP/API rejections and local preflight failures are safe to retry.
 */
export function classifySubscriptionWarningSendResult(
  result: TelegramApiCallResult,
): SubscriptionWarningSendOutcome {
  if (result.ok) return { kind: "delivered" };
  const description = result.description ?? "Telegram sendPhoto failed";
  if (result.status !== null || !result.retryable) {
    return { kind: "confirmed_failure", description };
  }
  return { kind: "ambiguous", description };
}

export function buildSubscriptionWarningText(): string {
  return [
    `⏳ <b>Ваша подписка заканчивается примерно через 3 часа</b>`,
    ``,
    `Продлите доступ, чтобы не пропустить сигналы.`,
    `Для продления — @The_Lucy_x`,
  ].join("\n");
}

export function isThreeHourWarningWindow(
  subscribedUntil: Date,
  nowMs: number,
): boolean {
  const msUntilExpiry = subscribedUntil.getTime() - nowMs;
  return msUntilExpiry > 2 * HOUR_MS && msUntilExpiry < 4 * HOUR_MS;
}

export function canReclaimSubscriptionWarning(
  status: string | undefined,
  _leaseUntil: Date | null | undefined,
  _now: Date,
): boolean {
  return status === "failed";
}

/**
 * Dashboard is the authoritative source when the same Chat ID exists in both
 * tables. Exact Chat ID matching is deliberate; usernames and names can change.
 */
export function mergeSubscriptionWarningRecipients(
  subscriberRecipients: SubscriptionWarningRecipient[],
  dashboardRecipients: SubscriptionWarningRecipient[],
): Map<number, SubscriptionWarningRecipient> {
  const recipients = new Map<number, SubscriptionWarningRecipient>();
  for (const recipient of subscriberRecipients) {
    recipients.set(recipient.chatId, recipient);
  }
  for (const recipient of dashboardRecipients) {
    recipients.set(recipient.chatId, recipient);
  }
  return recipients;
}
