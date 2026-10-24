import { dashboardUsersTable, db, subscribersTable } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import {
  normalizeTelegramRecipientId,
  resolveOperationalTelegramRecipientId,
} from "./telegram-recipient-policy.js";

export type TelegramRecipientEligibility =
  | { kind: "eligible" }
  | { kind: "expired" }
  | { kind: "unavailable"; error: unknown };

export interface TelegramEligibilityExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

export function isTelegramChannelRecipient(target: number | string): boolean {
  const value = String(target);
  return value.startsWith("@") || value.startsWith("-100");
}

export function isTelegramOperationalRecipient(
  target: number | string,
): boolean {
  return (
    normalizeTelegramRecipientId(target) ===
    resolveOperationalTelegramRecipientId(process.env.OWNER_CHAT_ID)
  );
}

export async function loadTelegramRecipientEligibility(
  target: number | string,
  executor: TelegramEligibilityExecutor = db,
): Promise<TelegramRecipientEligibility> {
  if (
    isTelegramChannelRecipient(target) ||
    isTelegramOperationalRecipient(target)
  ) {
    return { kind: "eligible" };
  }

  const chatId = normalizeTelegramRecipientId(target);
  if (chatId === null || chatId <= 0) return { kind: "expired" };
  const targetText = String(chatId);

  try {
    if (process.env.TELEGRAM_ELIGIBILITY_FORCE_DB_ERROR === "1") {
      throw new Error("forced recipient eligibility database outage");
    }
    const result = await executor.execute(sql`
      SELECT CASE
        WHEN EXISTS (
          SELECT 1
          FROM ${dashboardUsersTable}
          WHERE ${dashboardUsersTable.chatId} = ${targetText}
        )
        THEN EXISTS (
          SELECT 1
          FROM ${dashboardUsersTable}
          WHERE ${dashboardUsersTable.chatId} = ${targetText}
            AND ${dashboardUsersTable.status} = 'approved'
            AND (
              ${dashboardUsersTable.subscribedUntil} IS NULL
              OR ${dashboardUsersTable.subscribedUntil} > NOW()
            )
            AND NOT EXISTS (
              SELECT 1
              FROM ${subscribersTable}
              WHERE ${subscribersTable.chatId} = ${chatId}
                AND (
                  ${subscribersTable.active} = false
                  OR (
                    ${subscribersTable.subscribedUntil} IS NOT NULL
                    AND ${subscribersTable.subscribedUntil} <= NOW()
                  )
                )
            )
        )
        ELSE EXISTS (
          SELECT 1
          FROM ${subscribersTable}
          WHERE ${subscribersTable.chatId} = ${chatId}
            AND ${subscribersTable.active} = true
            AND (
              ${subscribersTable.subscribedUntil} IS NULL
              OR ${subscribersTable.subscribedUntil} > NOW()
            )
        )
      END AS eligible
    `);
    return Boolean(
      (result.rows[0] as { eligible?: boolean } | undefined)?.eligible,
    )
      ? { kind: "eligible" }
      : { kind: "expired" };
  } catch (error) {
    return { kind: "unavailable", error };
  }
}

export async function requireEligibleTelegramRecipients(
  targets: Array<number | string>,
  executor: TelegramEligibilityExecutor = db,
): Promise<Array<number | string>> {
  const unique = [
    ...new Map(targets.map((target) => [String(target), target])).values(),
  ];
  const results = await Promise.all(
    unique.map(async (target) => ({
      target,
      eligibility: await loadTelegramRecipientEligibility(target, executor),
    })),
  );
  const unavailable = results.find(
    ({ eligibility }) => eligibility.kind === "unavailable",
  );
  if (unavailable?.eligibility.kind === "unavailable") {
    throw new Error("Telegram recipient eligibility is unavailable", {
      cause: unavailable.eligibility.error,
    });
  }
  return results
    .filter(({ eligibility }) => eligibility.kind === "eligible")
    .map(({ target }) => target);
}
