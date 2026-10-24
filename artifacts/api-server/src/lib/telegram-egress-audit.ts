import { createHash, randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import type { TelegramApiCallResult } from "./telegram-api.js";

const MAX_AUDIT_CONTENT_LENGTH = 4_096;

export interface TelegramEgressAuditContext {
  source: string;
  chatId?: number | string | null;
  content?: string | null;
  contentKind?: "text" | "caption" | "callback" | "none";
  deliveryPath?: "outbox" | "direct" | "service-bypass" | "telegram-control";
  eventKey?: string | null;
}

export interface TelegramEgressAuditState {
  requestId: string;
  startedAt: number;
  method: string;
  chatId: number | string | null;
  source: string;
  content: string | null;
  contentKind: TelegramEgressAuditContext["contentKind"];
  contentSha256: string | null;
  contentTruncated: boolean;
  deliveryPath: TelegramEgressAuditContext["deliveryPath"];
  eventKey: string | null;
  callStack: string[];
}

function redactResetCode(content: string): string {
  if (
    !content.includes("Код сброса пароля") &&
    !content.includes("password reset")
  ) {
    return content;
  }
  return content
    .replace(/(<code>)\s*\d{4,10}\s*(<\/code>)/gi, "$1[REDACTED]$2")
    .replace(/\b\d{4,10}\b/g, "[REDACTED]");
}

export function sanitizeTelegramAuditContent(content: string): {
  content: string;
  sha256: string;
  truncated: boolean;
} {
  const redacted = redactResetCode(content);
  const truncated = redacted.length > MAX_AUDIT_CONTENT_LENGTH;
  return {
    content: truncated ? redacted.slice(0, MAX_AUDIT_CONTENT_LENGTH) : redacted,
    sha256: createHash("sha256").update(redacted).digest("hex"),
    truncated,
  };
}

function bodyValue(
  body: Record<string, unknown> | undefined,
  key: string,
): unknown {
  return body?.[key];
}

export function resolveTelegramEgressAuditContext(
  method: string,
  body: Record<string, unknown> | undefined,
  audit?: Partial<TelegramEgressAuditContext>,
): TelegramEgressAuditContext {
  const bodyChatId = bodyValue(body, "chat_id");
  const bodyText = bodyValue(body, "text");
  const bodyCaption = bodyValue(body, "caption");
  const content =
    audit?.content ??
    (typeof bodyText === "string"
      ? bodyText
      : typeof bodyCaption === "string"
        ? bodyCaption
        : null);
  const contentKind =
    audit?.contentKind ??
    (typeof bodyText === "string"
      ? "text"
      : typeof bodyCaption === "string"
        ? "caption"
        : method === "answerCallbackQuery"
          ? "callback"
          : "none");

  return {
    source: audit?.source ?? "telegram-api.callTelegramApi",
    chatId:
      audit?.chatId ??
      (typeof bodyChatId === "string" || typeof bodyChatId === "number"
        ? bodyChatId
        : null),
    content,
    contentKind,
    deliveryPath: audit?.deliveryPath ?? "telegram-control",
    eventKey: audit?.eventKey ?? null,
  };
}

export function beginTelegramEgressAudit(
  method: string,
  context: TelegramEgressAuditContext,
): TelegramEgressAuditState {
  const sanitized =
    context.content == null
      ? null
      : sanitizeTelegramAuditContent(context.content);
  const state: TelegramEgressAuditState = {
    requestId: randomUUID(),
    startedAt: Date.now(),
    method,
    chatId: context.chatId ?? null,
    source: context.source,
    content: sanitized?.content ?? null,
    contentKind: context.contentKind ?? "none",
    contentSha256: sanitized?.sha256 ?? null,
    contentTruncated: sanitized?.truncated ?? false,
    deliveryPath: context.deliveryPath ?? "direct",
    eventKey: context.eventKey ?? null,
    callStack:
      new Error("Telegram egress call site").stack
        ?.split("\n")
        .slice(2, 8)
        .map((line) => line.trim()) ?? [],
  };
  logger.info(
    {
      telegramEgress: true,
      phase: "request_started",
      requestId: state.requestId,
      method: state.method,
      chatId: state.chatId,
      source: state.source,
      deliveryPath: state.deliveryPath,
      eventKey: state.eventKey,
      contentKind: state.contentKind,
      content: state.content,
      contentSha256: state.contentSha256,
      contentTruncated: state.contentTruncated,
      callStack: state.callStack,
    },
    "Telegram egress request started",
  );
  return state;
}

export function finishTelegramEgressAudit(
  state: TelegramEgressAuditState,
  result: TelegramApiCallResult,
): void {
  logger.info(
    {
      telegramEgress: true,
      phase: "request_finished",
      requestId: state.requestId,
      method: state.method,
      chatId: state.chatId,
      source: state.source,
      deliveryPath: state.deliveryPath,
      eventKey: state.eventKey,
      contentKind: state.contentKind,
      content: state.content,
      contentSha256: state.contentSha256,
      contentTruncated: state.contentTruncated,
      durationMs: Math.max(0, Date.now() - state.startedAt),
      ok: result.ok,
      status: result.status,
      retryable: result.retryable,
      description: result.description,
      callStack: state.callStack,
    },
    "Telegram egress request finished",
  );
}
