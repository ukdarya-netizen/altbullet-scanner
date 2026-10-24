import { createHash, timingSafeEqual } from "node:crypto";
import { logger } from "./logger.js";
import { TELEGRAM_BOT_MENU } from "./telegram-inbound.js";
import {
  beginTelegramEgressAudit,
  finishTelegramEgressAudit,
  resolveTelegramEgressAuditContext,
  type TelegramEgressAuditContext,
} from "./telegram-egress-audit.js";

export const TELEGRAM_API = "https://api.telegram.org";
// Critical delivery runs through a durable queue, so waiting a little longer
// is preferable to converting normal provider latency into an unknown outcome.
export const TELEGRAM_API_TIMEOUT_MS = 20_000;
// Photo uploads include reading the local image and multipart transfer. They
// need a longer deadline than small JSON calls such as webhook acknowledgements.
export const TELEGRAM_PHOTO_UPLOAD_TIMEOUT_MS = 45_000;

export interface TelegramApiCallResult<T = unknown> {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  retryAfterSeconds?: number;
  description?: string;
  result?: T;
}

export type TelegramPhotoMessage = {
  photo?: Array<{ file_id?: string }>;
};

export function getTelegramPhotoFileId(
  result: TelegramApiCallResult<TelegramPhotoMessage>,
): string | null {
  const sizes = result.result?.photo;
  if (!sizes?.length) return null;
  return sizes.at(-1)?.file_id?.trim() || null;
}

export function shouldRetryCallbackAcknowledgement(
  result: TelegramApiCallResult,
): boolean {
  return !result.ok && result.retryable;
}

export function getTelegramWebhookSecret(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return createHash("sha256")
    .update(`altbullet-telegram-webhook:${token}`)
    .digest("hex");
}

export function verifyTelegramWebhookSecret(
  receivedSecret: string | undefined,
): boolean {
  const expectedSecret = getTelegramWebhookSecret();
  if (!expectedSecret || !receivedSecret) return false;
  const expected = Buffer.from(expectedSecret);
  const received = Buffer.from(receivedSecret);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}

export async function callTelegramApi<T = unknown>(
  method: string,
  options: {
    httpMethod?: "GET" | "POST";
    body?: Record<string, unknown>;
    audit?: Partial<TelegramEgressAuditContext>;
  } = {},
): Promise<TelegramApiCallResult<T>> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn({ method }, "Telegram API unavailable: token not configured");
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "TELEGRAM_BOT_TOKEN not configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);
  const audit = beginTelegramEgressAudit(
    method,
    resolveTelegramEgressAuditContext(method, options.body, options.audit),
  );
  try {
    const httpMethod = options.httpMethod ?? "POST";
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: httpMethod,
      headers:
        httpMethod === "POST"
          ? { "Content-Type": "application/json" }
          : undefined,
      body:
        httpMethod === "POST" && options.body
          ? JSON.stringify(options.body)
          : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let payload: {
      ok?: boolean;
      description?: string;
      result?: T;
      parameters?: { retry_after?: number };
    } = {};
    if (raw) {
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        payload = { description: raw.slice(0, 500) };
      }
    }
    const ok = res.ok && payload.ok === true;
    const description =
      payload.description ??
      (res.ok && !ok
        ? "Telegram API response did not explicitly accept the request"
        : undefined);
    const retryable =
      res.status === 429 || res.status >= 500 || payload.parameters != null;
    if (!ok) {
      logger.warn(
        {
          method,
          status: res.status,
          retryable,
          description,
        },
        "Telegram API call failed",
      );
    }
    const result: TelegramApiCallResult<T> = {
      ok,
      status: res.status,
      retryable,
      retryAfterSeconds:
        typeof payload.parameters?.retry_after === "number"
          ? Math.max(0, payload.parameters.retry_after)
          : undefined,
      description,
      result: payload.result,
    };
    finishTelegramEgressAudit(audit, result);
    return result;
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    logger.error({ err, method, timedOut }, "Telegram API request error");
    const result: TelegramApiCallResult<T> = {
      ok: false,
      status: null,
      retryable: true,
      description: timedOut ? "request timed out" : "network error",
    };
    finishTelegramEgressAudit(audit, result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function registerBotCommands(): Promise<boolean> {
  const result = await callTelegramApi("setMyCommands", {
    body: { commands: TELEGRAM_BOT_MENU },
  });
  if (result.ok) {
    logger.info(
      { commands: TELEGRAM_BOT_MENU.map((item) => item.command) },
      "Bot commands registered with Telegram",
    );
  }
  return result.ok;
}

export async function setWebhook(webhookUrl: string): Promise<boolean> {
  const secretToken = getTelegramWebhookSecret();
  if (!secretToken) {
    logger.error("Cannot register Telegram webhook without bot token");
    return false;
  }
  const requiredUpdates = ["message", "callback_query"];
  const configured = await callTelegramApi("setWebhook", {
    body: {
      url: webhookUrl,
      allowed_updates: requiredUpdates,
      drop_pending_updates: false,
      secret_token: secretToken,
    },
  });
  if (!configured.ok) return false;

  const verification = await callTelegramApi<{
    url?: string;
    allowed_updates?: string[];
    last_error_message?: string;
  }>("getWebhookInfo", { httpMethod: "GET" });
  const acceptedUpdates = verification.result?.allowed_updates ?? [];
  const verified =
    verification.ok &&
    verification.result?.url === webhookUrl &&
    requiredUpdates.every((updateType) => acceptedUpdates.includes(updateType));
  if (!verified) {
    logger.error(
      {
        webhookUrl,
        acceptedUrl: verification.result?.url,
        acceptedUpdates,
        lastError: verification.result?.last_error_message,
      },
      "Telegram webhook verification failed",
    );
    return false;
  }
  logger.info(
    { webhookUrl, allowedUpdates: acceptedUpdates },
    "Telegram webhook registered and verified",
  );
  return true;
}
