import type { TelegramApiCallResult } from "./telegram-api.js";
import { shouldFallbackToTextAfterPhotoFailure } from "./photo-delivery-policy.js";
import { isTelegramHtmlParseError } from "./telegram-html.js";

const CAPTION_MAX_LEN = 1_000;
const MESSAGE_MAX_LEN = 4_000;
const CONTINUATION_BODY_MAX_LEN = 3_850;
export const TELEGRAM_DELIVERY_POLICY_VERSION = 4;
export const TELEGRAM_MAX_DELIVERY_ATTEMPTS = 6;

export type TelegramPhotoDeliveryPhase = "photo" | "fallback" | "continuation";

export interface TelegramPhotoDeliveryContent {
  caption: string;
  fallbackText: string;
  continuationTexts: string[];
}

export interface TelegramPhotoDeliveryDraft extends TelegramPhotoDeliveryContent {
  dedupKey: string;
  target: string;
  photoPath: string;
  status: string;
  phase: TelegramPhotoDeliveryPhase;
  nextPartIndex: number;
  nextAttemptAt: Date;
  attempts: number;
  photoAttempts: number;
  plainText: boolean;
  deliveryPolicyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramPhotoDeliveryTransition {
  status: "delivered" | "retry" | "ambiguous" | "processing";
  phase: TelegramPhotoDeliveryPhase;
}

function splitAtBoundary(
  text: string,
  maxLen: number,
): { head: string; rest: string } {
  if (text.length <= maxLen) {
    return { head: text, rest: "" };
  }
  const newline = text.lastIndexOf("\n", maxLen);
  const cutAt = newline > 0 ? newline : maxLen;
  return {
    head: text.slice(0, cutAt),
    rest: text.slice(cutAt).replace(/^\n/, ""),
  };
}

export function splitTelegramText(
  text: string,
  maxLen = MESSAGE_MAX_LEN,
): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining) {
    const { head, rest } = splitAtBoundary(remaining, maxLen);
    if (head) chunks.push(head);
    remaining = rest;
  }
  return chunks;
}

export function buildTelegramPhotoDeliveryContent(
  text: string,
): TelegramPhotoDeliveryContent {
  const { head: caption, rest } = splitAtBoundary(text, CAPTION_MAX_LEN);
  const rawContinuations = rest
    ? splitTelegramText(rest, CONTINUATION_BODY_MAX_LEN)
    : [];
  const continuationTexts = rawContinuations.map((chunk, index) =>
    index === 0
      ? chunk
      : `📊 <b>Продолжение (${index + 2}/${rawContinuations.length + 1}):</b>\n\n${chunk}`,
  );
  return {
    caption,
    fallbackText: text,
    continuationTexts,
  };
}

export function buildTelegramPhotoDeliveryRows(
  params: {
    photoPath: string;
    text: string;
    targets: Array<number | string>;
  },
  dedupKey: string,
  now = new Date(),
): TelegramPhotoDeliveryDraft[] {
  const content = buildTelegramPhotoDeliveryContent(params.text);
  return params.targets.map((target) => ({
    dedupKey,
    target: String(target),
    photoPath: params.photoPath,
    caption: content.caption,
    fallbackText: content.fallbackText,
    continuationTexts: content.continuationTexts,
    status: "ready",
    phase: "photo",
    nextPartIndex: 0,
    nextAttemptAt: now,
    attempts: 0,
    photoAttempts: 0,
    plainText: false,
    deliveryPolicyVersion: TELEGRAM_DELIVERY_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * Text-only critical events use the same durable recipient outbox as photo
 * events. `photoPath` is deliberately empty because the worker starts directly
 * in the text phase and never resolves or uploads media for these rows.
 */
export function buildTelegramTextDeliveryRows(
  params: {
    text: string;
    targets: Array<number | string>;
  },
  dedupKey: string,
  now = new Date(),
): TelegramPhotoDeliveryDraft[] {
  return params.targets.map((target) => ({
    dedupKey,
    target: String(target),
    photoPath: "",
    caption: "",
    fallbackText: params.text,
    continuationTexts: [],
    status: "ready",
    phase: "fallback",
    nextPartIndex: 0,
    nextAttemptAt: now,
    attempts: 0,
    photoAttempts: 0,
    plainText: false,
    deliveryPolicyVersion: TELEGRAM_DELIVERY_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  }));
}

export function getTelegramPhotoResultTransition(
  result: TelegramApiCallResult,
  hasContinuations: boolean,
): TelegramPhotoDeliveryTransition {
  if (result.ok) {
    return hasContinuations
      ? { status: "processing", phase: "continuation" }
      : { status: "delivered", phase: "photo" };
  }
  if (shouldFallbackToTextAfterPhotoFailure(result)) {
    return { status: "processing", phase: "fallback" };
  }
  return result.status === 429
    ? { status: "retry", phase: "photo" }
    : { status: "ambiguous", phase: "photo" };
}

export function getTelegramTextResultStatus(
  result: TelegramApiCallResult,
): "delivered" | "retry" | "ambiguous" | "abandoned" {
  if (result.ok) return "delivered";
  if (result.status === 429) return "retry";
  if (
    result.status === null ||
    result.status >= 500 ||
    (result.status >= 200 && result.status < 300)
  ) {
    return "ambiguous";
  }
  return "abandoned";
}

export type TelegramAttemptClassification =
  | "accepted"
  | "rate_limited"
  | "html_parse_error"
  | "client_error"
  | "server_error"
  | "timeout"
  | "network_error"
  | "ambiguous_response";

export function classifyTelegramAttempt(
  result: TelegramApiCallResult,
): TelegramAttemptClassification {
  if (result.ok) return "accepted";
  if (result.status === 429) return "rate_limited";
  if (isTelegramHtmlParseError(result.description)) return "html_parse_error";
  if (result.status !== null && result.status >= 400 && result.status < 500) {
    return "client_error";
  }
  if (result.status !== null && result.status >= 500) return "server_error";
  if (/timed out/i.test(result.description ?? "")) return "timeout";
  if (/network/i.test(result.description ?? "")) return "network_error";
  return "ambiguous_response";
}

export function shouldRetryTelegramAttempt(
  result: TelegramApiCallResult,
): boolean {
  const classification = classifyTelegramAttempt(result);
  return (
    classification === "rate_limited" ||
    classification === "server_error" ||
    classification === "timeout" ||
    classification === "network_error" ||
    classification === "ambiguous_response"
  );
}

export function getTelegramRetryDelayMs(
  result: TelegramApiCallResult,
  attempt: number,
  random = Math.random,
): number {
  if (result.status === 429 && result.retryAfterSeconds != null) {
    return Math.max(1_000, result.retryAfterSeconds * 1_000);
  }
  const base = Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
  const jitterMultiplier = 0.8 + random() * 0.4;
  return Math.round(base * jitterMultiplier);
}

export function getPendingTelegramTextParts(
  content: Pick<
    TelegramPhotoDeliveryContent,
    "fallbackText" | "continuationTexts"
  >,
  phase: Exclude<TelegramPhotoDeliveryPhase, "photo">,
  nextPartIndex: number,
): string[] {
  const allParts =
    phase === "fallback"
      ? splitTelegramText(content.fallbackText)
      : content.continuationTexts;
  return allParts.slice(nextPartIndex);
}

export async function runTelegramPhotoClaimTransaction<
  TTransaction,
  TRow,
>(params: {
  transaction: TTransaction;
  rows: TRow[];
  forceInsertAfterClaim?: boolean;
  claim: (transaction: TTransaction) => Promise<boolean>;
  insert: (transaction: TTransaction, rows: TRow[]) => Promise<number>;
}): Promise<{ claimed: boolean; queued: number }> {
  if (!(await params.claim(params.transaction))) {
    return { claimed: false, queued: 0 };
  }
  if (params.rows.length === 0 && !params.forceInsertAfterClaim) {
    return { claimed: true, queued: 0 };
  }
  return {
    claimed: true,
    queued: await params.insert(params.transaction, params.rows),
  };
}

export async function runTelegramPhotoAfterRecipientResolution<
  TTarget,
  TResult,
>(params: {
  resolveTargets: () => Promise<TTarget[]>;
  enqueueAfterClaim: (targets: TTarget[]) => Promise<TResult>;
  enqueueAfterResolutionFailure?: (cause: unknown) => Promise<TResult>;
}): Promise<TResult> {
  try {
    const targets = await params.resolveTargets();
    return params.enqueueAfterClaim(targets);
  } catch (cause) {
    if (!params.enqueueAfterResolutionFailure) throw cause;
    return params.enqueueAfterResolutionFailure(cause);
  }
}

export async function resolveTelegramRecipientSource<T>(params: {
  source: string;
  strict: boolean;
  load: () => Promise<T>;
  fallback: () => T;
}): Promise<{ value: T; resolved: boolean }> {
  try {
    return { value: await params.load(), resolved: true };
  } catch (cause) {
    if (params.strict) {
      throw new Error(`${params.source} lookup failed`, { cause });
    }
    return { value: params.fallback(), resolved: false };
  }
}
