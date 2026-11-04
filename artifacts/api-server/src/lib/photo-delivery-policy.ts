import { randomUUID } from "node:crypto";
import type { TelegramApiCallResult } from "./telegram-api.js";

/**
 * Message content is not a business identity: two different cancellations can
 * legitimately render the same text. Callers provide a stable event key for
 * retry idempotency; unrelated broadcasts receive a fresh identity.
 */
export function getTelegramPhotoDeliveryKey(eventKey?: string): string {
  return eventKey ?? randomUUID();
}

/**
 * A timeout or a broken connection after Telegram received the request is
 * ambiguous: sending the caption as text can duplicate a photo Telegram has
 * already accepted. Only an explicit non-retryable rejection gets a text
 * fallback.
 */
export function shouldFallbackToTextAfterPhotoFailure(
  result: TelegramApiCallResult,
): boolean {
  // A 4xx response (except rate limiting) is Telegram's explicit refusal of
  // the photo. A null status or 5xx can be emitted after request acceptance,
  // even if a transport wrapper classifies it as non-retryable.
  return (
    !result.ok &&
    result.status !== null &&
    result.status >= 400 &&
    result.status < 500 &&
    result.status !== 429
  );
}

/**
 * Telegram explicitly rejects a 429 before it accepts the message. A 5xx can
 * come from an intermediary after the request crossed the acceptance boundary,
 * so it stays ambiguous and must not create a duplicate.
 */
export function shouldRetryExplicitPhotoFailure(
  result: TelegramApiCallResult,
): boolean {
  return !result.ok && result.status === 429;
}

/**
 * A cached Telegram file ID can be discarded only after Telegram explicitly
 * says that this identifier is no longer valid. Other 4xx responses can be
 * recipient-specific, so evicting the shared cache for them would create
 * unnecessary multipart uploads for every other recipient.
 */
export function isExplicitInvalidTelegramPhotoFileId(
  result: TelegramApiCallResult,
): boolean {
  if (result.ok || result.status !== 400) return false;
  return /(?:wrong|invalid)\s+file(?:[_\s-]?id| identifier)|file(?:[_\s-]?id| identifier).*(?:wrong|invalid)|file reference/i.test(
    result.description ?? "",
  );
}
