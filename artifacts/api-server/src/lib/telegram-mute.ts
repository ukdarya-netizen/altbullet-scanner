/**
 * Owner 2026-11-03: every Telegram message from the bot is temporarily stopped
 * (signals, positions, restart notice, replies, reports). Only watchdog alerts
 * (event key "watchdog:...") still go out. Set to false when the owner asks to
 * resume.
 */
export const TELEGRAM_MUTED = true;

const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendMediaGroup",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
]);

export function isTelegramMuted(eventKey?: string | null): boolean {
  return TELEGRAM_MUTED && !(eventKey ?? "").startsWith("watchdog:");
}

export function isMutedTelegramMethod(
  method: string,
  eventKey?: string | null,
): boolean {
  return SEND_METHODS.has(method) && isTelegramMuted(eventKey);
}
