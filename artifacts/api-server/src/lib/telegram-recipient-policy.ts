export function normalizeTelegramRecipientId(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value !== 0 ? value : null;
  }

  const parsed = Number(value?.trim());
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

export function isOperationalTelegramRecipient(
  value: number | string | null | undefined,
  operationalChatId: number,
): boolean {
  return normalizeTelegramRecipientId(value) === operationalChatId;
}

export function mergeTelegramPersonalRecipients(params: {
  subscriberChatIds: number[];
  dashboardChatIds: Array<string | null>;
}): number[] {
  const ids = new Set<number>();
  for (const chatId of params.subscriberChatIds) {
    const normalized = normalizeTelegramRecipientId(chatId);
    if (normalized !== null) ids.add(normalized);
  }
  for (const chatId of params.dashboardChatIds) {
    const normalized = normalizeTelegramRecipientId(chatId);
    if (normalized !== null) ids.add(normalized);
  }
  return [...ids];
}

/**
 * The operator must receive critical bot and trading notifications even when
 * their personal dashboard subscription is intentionally absent or expired.
 * OWNER_CHAT_ID is preferred so a deployment can override the historical
 * operator chat without changing code.
 */
export const DEFAULT_OPERATIONAL_TELEGRAM_CHAT_ID = 7818695412;

export function resolveOperationalTelegramRecipientId(
  configuredValue: string | number | null | undefined,
): number {
  return (
    normalizeTelegramRecipientId(configuredValue) ??
    DEFAULT_OPERATIONAL_TELEGRAM_CHAT_ID
  );
}

export function resolveTelegramPersonalRecipientSnapshot(params: {
  subscriberLookupOk: boolean;
  subscriberChatIds: number[];
  dashboardLookupOk: boolean;
  dashboardChatIds: Array<string | null>;
  strict: boolean;
}): { value: number[]; resolved: boolean } {
  if (params.subscriberLookupOk && params.dashboardLookupOk) {
    return {
      value: mergeTelegramPersonalRecipients({
        subscriberChatIds: params.subscriberChatIds,
        dashboardChatIds: params.dashboardChatIds,
      }),
      resolved: true,
    };
  }

  throw new Error("Active Telegram recipient lookup failed");
}
