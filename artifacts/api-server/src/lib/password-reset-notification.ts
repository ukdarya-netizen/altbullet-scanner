/**
 * Pure, dependency-injectable helper for the admin password-reset Telegram alert.
 *
 * Keeping the logic separate from auth.ts makes the critical dispatch path
 * testable without a real Telegram token or database connection.
 */

/**
 * Signature of `sendMessage` from telegram.ts.
 * Returns `true` when Telegram acknowledged the message, `false` on any
 * delivery failure (network error, bot blocked, 403, etc.).
 */
export type SendMessageFn = (chatId: number, text: string) => Promise<boolean>;

export const PASSWORD_RESET_TELEGRAM_TEXT =
  "🔑 <b>Пароль изменён</b>\n\nВаш пароль был сброшен администратором. Если это были не вы — обратитесь к администратору.";

/**
 * Parse and validate a raw chat-ID string.
 *
 * Returns `null` for anything that is not a safe positive integer so that
 * callers never accidentally send to chatId 0 or a garbage value.
 */
export function parseChatId(chatId: string | null): number | null {
  if (!chatId) return null;
  const parsed = Number(chatId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Send the password-reset notification via the supplied `sendMessage`
 * implementation.
 *
 * Returns `false` when `chatId` is absent/invalid (no-op, no send attempted)
 * or when Telegram reports a delivery failure.  Returns `true` when Telegram
 * acknowledged the message.  Never throws — delivery errors propagate only
 * through the return value so that callers can decide how to handle them.
 */
export async function dispatchPasswordResetNotification(
  sendMessage: SendMessageFn,
  chatId: string | null,
): Promise<boolean> {
  const telegramChatId = parseChatId(chatId);
  if (!telegramChatId) return false;
  return sendMessage(telegramChatId, PASSWORD_RESET_TELEGRAM_TEXT);
}
