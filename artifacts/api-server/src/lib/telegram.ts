import { logger } from "./logger.js";
import { withPrimarySignalTiming } from "./telegram-signal-timing.js";
import type { CgAskBidsResult } from "./coinglass_orderbook.js";
import type { OrderBookAnalysis } from "./bingx.js";
import { getFundingRate } from "./bingx.js";
import type { Signal } from "@workspace/db";
import {
  dashboardUsersTable,
  db,
  pool,
  settingsTable,
  signalsTable,
  trackedSignalsTable,
  subscribersTable,
} from "@workspace/db";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { getPatternTgLabel } from "./pattern-labels.js";
import {
  PRICE_LED_MOMENTUM_TELEGRAM_NAME,
  NEON_SUPPORT_BOUNCE_TELEGRAM_NAME,
  IMPULSE_BUY_TELEGRAM_NAME,
  STEALTH_BREAKOUT_TELEGRAM_NAME,
} from "./telegram-pattern-text.js";
import {
  fmtImpulseRunnerPolicyLine,
  tickerTag,
  patternTag,
} from "./watcher-formatters.js";
import { IMPULSE_RUNNER_POLICY_VERSION } from "./impulse-runner-policy.js";
import { isBingxExclusive, isBinanceSpotListed } from "./coinglass_listings.js";
import { getWhaleIndexLine, getTokenWhaleIndex } from "./whale_index.js";
import { getGlobalAccountRatio } from "./coinglass_global_ratio.js";
import { getTakerFlowCached } from "./coinglass_taker.js";
import { getSpotTakerFlow } from "./coinglass_spot_taker.js";
import { getSpotCvdMtf } from "./coinglass_spot_cvd.js";
import {
  getBuStopMilestone,
  hasNoProfitStopPromotion,
  getExitProfile,
  getPatternMaxStop,
  STOP_LOSS,
  SINGLE_ENTRY_POLICY_VERSION,
} from "./watcher-config.js";
import { getSpotNetflowEntry } from "./spot-netflow-cache.js";
import {
  TELEGRAM_API,
  TELEGRAM_PHOTO_UPLOAD_TIMEOUT_MS,
  callTelegramApi,
  type TelegramPhotoMessage,
  type TelegramApiCallResult,
} from "./telegram-api.js";
import {
  beginTelegramEgressAudit,
  finishTelegramEgressAudit,
} from "./telegram-egress-audit.js";
import {
  canonicalizeMilestoneTargets,
  type CanonicalTelegramTargetSnapshot,
} from "./milestone-delivery.js";
import {
  shouldFallbackToTextAfterPhotoFailure,
  shouldRetryExplicitPhotoFailure,
} from "./photo-delivery-policy.js";
import { resolveTelegramRecipientSource } from "./telegram-photo-outbox-policy.js";
import {
  canRecoverPrimaryAlert,
  createSingleFlight,
  PRIMARY_ALERT_RECOVERY_MAX_AGE_MS,
  RECONCILE_ADVISORY_LOCK_KEY,
} from "./telegram-reconcile-policy.js";
import { assertMarketCycleLeaseOwnership } from "./schedulerLease.js";
import { dbReadWithRetry } from "./dbReadWithRetry.js";
import {
  normalizeTelegramRecipientId,
  resolveOperationalTelegramRecipientId,
  resolveTelegramPersonalRecipientSnapshot,
} from "./telegram-recipient-policy.js";
import { loadTelegramRecipientEligibility } from "./telegram-recipient-eligibility.js";
import {
  appendTradingViewLinks,
  formatMarketLinks,
  withoutTradingViewLinks,
} from "./telegram-chart-link.js";
import {
  escapeTelegramHtmlText,
  telegramHtml,
  telegramHtmlToPlainTextWithLinkEntities,
} from "./telegram-html.js";

type ReconcileLockClient = {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
};
import {
  ALT_BULLET_WEBSITE_URL,
  type TelegramInlineKeyboard,
} from "./telegram-inbound.js";
export {
  SUBSCRIBER_MENU_KEYBOARD,
  SUBSCRIPTION_STATUS_KEYBOARD,
  WELCOME_KEYBOARD,
  type TelegramInlineKeyboard,
} from "./telegram-inbound.js";

export {
  registerBotCommands,
  setWebhook,
  type TelegramApiCallResult,
} from "./telegram-api.js";

export function buildSignalManagementLine(
  sentimentKey: string,
  symbol: string,
  freshHigh?: { stealthDetectionMethod?: string | null; stopPct?: number | null },
): string {
  const isBitcoin = symbol === "BTC-USDT" || symbol === "BTCUSDT";
  if (
    sentimentKey === "stealth_breakout" &&
    (freshHigh?.stealthDetectionMethod === "fresh_24h_high_breakout" ||
      freshHigh?.stealthDetectionMethod === "range_4h_breakout" ||
      freshHigh?.stealthDetectionMethod === "range_1h_breakout") &&
    freshHigh.stopPct != null &&
    freshHigh.stopPct > 0
  ) {
    const r = Math.abs(freshHigh.stopPct).toFixed(1);
    const level =
      freshHigh.stealthDetectionMethod === "range_4h_breakout"
        ? "под пробитым верхом 4H-ренджа −1%"
        : freshHigh.stealthDetectionMethod === "range_1h_breakout"
        ? "под пробитым верхом ренджа −1%"
        : "под пробитым 24ч-хаем −1%";
    return `🛡 <b>Сопровождение (🧪 эксперимент, 1R = ${r}%):</b> стоп ${level} · при +1R (+${r}%) стоп в Б/У · дальше трейлинг на 1R (${r} п.п.) ниже пика · максимум 72ч`;
  }
  const beActivation =
    sentimentKey === "impulse_buy"
      ? 5
      : getBuStopMilestone(sentimentKey, symbol);
  const exitProfile = getExitProfile(sentimentKey, symbol);

  if (isBitcoin) {
    return `🛡 <b>Сопровождение BTC:</b> Б/У после +1% · трейлинг только с +2% от входа, отступ от пика 1 п.п. · после активации каждый новый +1% пика подтягивает стоп на +1 п.п.`;
  }

  const protectionPlan = hasNoProfitStopPromotion(sentimentKey)
    ? `БУ с +${beActivation}%`
    : beActivation === 10
      ? "БУ с +10% · при +10% стоп в прибыль +5%"
      : `БУ с +${beActivation}% · при +10% стоп в прибыль +5%`;
  return `🛡 <b>Сопровождение:</b> ${protectionPlan} ${sentimentKey === "impulse_buy" ? ` · цель +${exitProfile.firstTarget}%: вручную зафиксируй 20–25% (не автоисполнение)` : ""} · трейлинг +${exitProfile.trailingActivation}%`;
}

// ── Channel ID in-memory cache ────────────────────────────────────────────────
// Греется при старте, обновляется при изменении settings.channelId.
// Используется как fallback в getTargets() когда DB недоступна.
let _channelIdCache: string | null = null;

export function getOperationalTelegramRecipientId(): number {
  return resolveOperationalTelegramRecipientId(process.env.OWNER_CHAT_ID);
}

async function rejectIneligibleBroadcastRecipient(
  chatId: number | string,
): Promise<TelegramApiCallResult<never> | null> {
  const eligibility = await loadTelegramRecipientEligibility(chatId);
  if (eligibility.kind === "eligible") return null;
  if (eligibility.kind === "unavailable") {
    logger.warn(
      { err: eligibility.error, chatId },
      "Telegram broadcast deferred because recipient eligibility is unavailable",
    );
    return {
      ok: false,
      status: null,
      retryable: true,
      description: "recipient eligibility unavailable",
    };
  }
  logger.info(
    { chatId },
    "Telegram broadcast suppressed after subscription expiry",
  );
  return {
    ok: false,
    status: null,
    retryable: false,
    description: "recipient subscription expired",
  };
}

export function setChannelIdCache(id: string | null) {
  _channelIdCache = id?.trim() || null;
}

export async function warmChannelIdCache(): Promise<void> {
  try {
    const rows = await db
      .select({ channelId: settingsTable.channelId })
      .from(settingsTable)
      .limit(1);
    _channelIdCache = rows[0]?.channelId?.trim() || null;
    if (_channelIdCache)
      logger.info({ channelId: _channelIdCache }, "Channel ID cache warmed");
  } catch (err) {
    logger.warn({ err }, "warmChannelIdCache: DB недоступна — кэш не прогрет");
  }
}

// ── Картинки для паттернов (отправляются вместо текста при одиночном сигнале) ──
const _assetUrl = (name: string) =>
  new URL(`../assets/${name}`, import.meta.url).pathname;
export const SUBSCRIPTION_STARTED_IMG = _assetUrl("subscription_started.png");
export const SUBSCRIPTION_RENEWED_IMG = _assetUrl("subscription_renewed.png");
export const SUBSCRIPTION_DEACTIVATED_IMG = _assetUrl(
  "subscription_deactivated.png",
);
export const BLOCKED_IMG = _assetUrl("blocked.png");
export const WELCOME_IMG = _assetUrl("welcome.png");
export const PATTERN_SIGNAL_IMGS: Record<string, string> = {
  // ── OI / накопление ────────────────────────────────────────────────────────
  liquidation_cascade: _assetUrl("pattern_liquidation_cascade.png"),
  whale_watch: _assetUrl("pattern_whale_watch.png"),
  balanced_grind: _assetUrl("pattern_balanced_grind.png"),
  // ── Stealth ─────────────────────────────────────────────────────────────────
  stealth_breakout: _assetUrl("pattern_stealth_breakout.png"),
  neon_support_bounce: _assetUrl("pattern_neon_support_bounce.png"),
  // ── Price Led Momentum ───────────────────────────────────────────────────────
  price_led_momentum: _assetUrl("pattern_price_led_momentum.png"),
  impulse_buy: _assetUrl("pattern_impulse_buy.png"),
};
const DEFAULT_SIGNAL_IMG = _assetUrl("pattern_accum_breakout.png");

export async function sendMessage(
  chatId: number | string,
  text: string,
  options: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<boolean> {
  return (await sendMessageResult(chatId, text, options)).ok;
}

async function markSubscriberBotBlocked(
  chatId: number | string,
  description: string | undefined,
): Promise<void> {
  const numericChatId = Number(chatId);
  if (!Number.isSafeInteger(numericChatId)) return;
  const blockedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      const blockedReason =
        description?.slice(0, 500) ?? "Telegram HTTP 403 Forbidden";
      await tx
        .insert(subscribersTable)
        .values({
          chatId: numericChatId,
          active: false,
          subscribedAt: blockedAt,
          unsubscribedAt: blockedAt,
          botBlockedAt: blockedAt,
          botBlockedReason: blockedReason,
        })
        .onConflictDoUpdate({
          target: subscribersTable.chatId,
          set: {
            active: false,
            unsubscribedAt: blockedAt,
            botBlockedAt: blockedAt,
            botBlockedReason: blockedReason,
          },
        });
      await tx
        .update(dashboardUsersTable)
        .set({
          status: "blocked",
          lastActivityAt: null,
        })
        .where(eq(dashboardUsersTable.chatId, String(numericChatId)));
    });
  } catch (err) {
    logger.warn(
      { err, chatId: numericChatId },
      "Failed to persist Telegram bot-blocked status and revoke Dashboard access",
    );
  }
}

export async function sendMessageResult(
  chatId: number | string,
  text: string,
  {
    appendChartLinks = true,
    parseMode: _parseMode = "HTML",
    requireActiveSubscription = true,
    auditSource = "telegram.sendMessageResult",
    auditEventKey,
    auditDeliveryPath = requireActiveSubscription ? "direct" : "service-bypass",
  }: {
    appendChartLinks?: boolean;
    parseMode?: "HTML" | null;
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<TelegramApiCallResult> {
  assertMarketCycleLeaseOwnership("Telegram message delivery");
  if (requireActiveSubscription) {
    const rejection = await rejectIneligibleBroadcastRecipient(chatId);
    if (rejection) return rejection;
  }
  if (process.env.NODE_ENV === "development") {
    logger.debug(
      { chatId, preview: text.slice(0, 80) },
      "DEV: Telegram suppressed",
    );
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed in development",
    };
  }

  const preparedText = telegramHtmlToPlainTextWithLinkEntities(
    appendChartLinks
      ? appendTradingViewLinks(text, 4_000)
      : appendTradingViewLinks(withoutTradingViewLinks(text), 4_000),
  );
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: preparedText.text,
    ...(preparedText.entities.length > 0
      ? { entities: preparedText.entities }
      : {}),
    disable_web_page_preview: false,
    protect_content: false,
  };
  const result = await callTelegramApi("sendMessage", {
    body,
    audit: {
      source: auditSource,
      deliveryPath: auditDeliveryPath,
      eventKey: auditEventKey,
    },
  });
  if (!result.ok && result.status === 403) {
    await markSubscriberBotBlocked(chatId, result.description);
  }
  return result;
}
export async function sendMessageWithKeyboard(
  chatId: number | string,
  text: string,
  inlineKeyboard: TelegramInlineKeyboard,
  options: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<boolean> {
  return (
    await sendMessageWithKeyboardResult(chatId, text, inlineKeyboard, options)
  ).ok;
}

export async function sendMessageWithKeyboardResult(
  chatId: number | string,
  text: string,
  inlineKeyboard: TelegramInlineKeyboard,
  {
    requireActiveSubscription = true,
    auditSource = "telegram.sendMessageWithKeyboardResult",
    auditEventKey,
    auditDeliveryPath = requireActiveSubscription ? "direct" : "service-bypass",
  }: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<TelegramApiCallResult> {
  assertMarketCycleLeaseOwnership("Telegram keyboard delivery");
  if (requireActiveSubscription) {
    const rejection = await rejectIneligibleBroadcastRecipient(chatId);
    if (rejection) return rejection;
  }
  if (process.env.NODE_ENV === "development") {
    logger.debug(
      { chatId, preview: text.slice(0, 80) },
      "DEV: Telegram suppressed",
    );
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed in development",
    };
  }
  const preparedText = telegramHtmlToPlainTextWithLinkEntities(
    appendTradingViewLinks(text, 4_000),
  );
  const result = await callTelegramApi("sendMessage", {
    body: {
      chat_id: chatId,
      text: preparedText.text,
      ...(preparedText.entities.length > 0
        ? { entities: preparedText.entities }
        : {}),
      disable_web_page_preview: true,
      protect_content: false,
      reply_markup: { inline_keyboard: inlineKeyboard },
    },
    audit: {
      source: auditSource,
      deliveryPath: auditDeliveryPath,
      eventKey: auditEventKey,
    },
  });
  if (!result.ok && result.status === 403) {
    await markSubscriberBotBlocked(chatId, result.description);
  }
  return result;
}
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  return (await answerCallbackQueryResult(callbackQueryId, text)).ok;
}

export async function answerCallbackQueryResult(
  callbackQueryId: string,
  text?: string,
): Promise<TelegramApiCallResult> {
  if (process.env.NODE_ENV === "development") {
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed in development",
    };
  }
  return callTelegramApi("answerCallbackQuery", {
    body: { callback_query_id: callbackQueryId, text },
    audit: {
      source: "telegram.answerCallbackQueryResult",
      content: text ?? null,
      contentKind: "callback",
      deliveryPath: "direct",
    },
  });
}
export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  inlineKeyboard?: TelegramInlineKeyboard,
): Promise<boolean> {
  return (await editMessageTextResult(chatId, messageId, text, inlineKeyboard))
    .ok;
}

export async function editMessageTextResult(
  chatId: number | string,
  messageId: number,
  text: string,
  inlineKeyboard?: TelegramInlineKeyboard,
): Promise<TelegramApiCallResult> {
  if (process.env.NODE_ENV === "development") {
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed in development",
    };
  }
  const preparedText = telegramHtmlToPlainTextWithLinkEntities(
    appendTradingViewLinks(text, 4_000),
  );
  return callTelegramApi("editMessageText", {
    body: {
      chat_id: chatId,
      message_id: messageId,
      text: preparedText.text,
      ...(preparedText.entities.length > 0
        ? { entities: preparedText.entities }
        : {}),
      ...(inlineKeyboard
        ? { reply_markup: { inline_keyboard: inlineKeyboard } }
        : {}),
    },
    audit: {
      source: "telegram.editMessageTextResult",
      deliveryPath: "direct",
    },
  });
}
export async function sendPhotoCaption(
  chatId: number | string,
  photoPath: string,
  caption: string,
  inlineKeyboard?: TelegramInlineKeyboard,
  options: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<boolean> {
  return (
    await sendPhotoCaptionResult(
      chatId,
      photoPath,
      caption,
      inlineKeyboard,
      options,
    )
  ).ok;
}

export function buildSubscriptionStartedText(
  subscriptionEnd: Date | null,
): string {
  const endLine =
    subscriptionEnd != null
      ? `📅 Подписка активна до: <b>${subscriptionEnd.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</b>`
      : null;
  return [
    `🎉 <b>Ваша подписка активирована!</b>`,
    ``,
    `Доступ к сигналам, аналитике и Dashboard открыт.`,
    `Добро пожаловать в BULLET — пусть прибыль начинается сейчас.`,
    ...(endLine ? [``, endLine] : []),
    ``,
    `Открой меню бота и нажми <b>/start</b>, чтобы увидеть все возможности.`,
    ``,
    `🔑 <b>Забыли пароль от Dashboard?</b>`,
    `Нажми <b>/resetpassword</b> в меню бота — придёт одноразовый код для сброса.`,
  ].join("\n");
}

export function buildSubscriptionRenewedText(
  subscriptionEnd: Date | null,
): string {
  const endLine =
    subscriptionEnd != null
      ? `📅 Действует до: <b>${subscriptionEnd.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}</b>`
      : null;
  return [
    `🔄 <b>Ваша подписка продлена!</b>`,
    ``,
    ...(endLine ? [endLine, ``] : []),
    `Удачной охоты! 🐋🚀`,
  ].join("\n");
}

export async function sendSubscriptionRenewedNotification(
  chatId: number | string,
  subscriptionEnd: Date | null = null,
): Promise<TelegramApiCallResult> {
  return sendPhotoCaptionResult(
    chatId,
    SUBSCRIPTION_RENEWED_IMG,
    buildSubscriptionRenewedText(subscriptionEnd),
    undefined,
    {
      requireActiveSubscription: false,
      auditSource: "telegram.sendSubscriptionRenewedNotification",
      auditDeliveryPath: "service-bypass",
    },
  );
}

export async function sendDeactivatedNotification(
  chatId: number | string,
): Promise<TelegramApiCallResult> {
  return sendPhotoCaptionResult(
    chatId,
    SUBSCRIPTION_DEACTIVATED_IMG,
    `📴 <b>Подписка деактивирована</b>\n\nВаш доступ к AltBullet был деактивирован администратором.\n\nПо вопросам обращайтесь напрямую.`,
    undefined,
    {
      requireActiveSubscription: false,
      auditSource: "telegram.sendDeactivatedNotification",
      auditDeliveryPath: "service-bypass",
    },
  );
}

export async function sendBlockedNotification(
  chatId: number | string,
): Promise<TelegramApiCallResult> {
  return sendPhotoCaptionResult(
    chatId,
    BLOCKED_IMG,
    `🚫 <b>Доступ приостановлен</b>\n\nВаш доступ к дашборду был заблокирован администратором. По вопросам обращайтесь напрямую.`,
    undefined,
    {
      requireActiveSubscription: false,
      auditSource: "telegram.sendBlockedNotification",
      auditDeliveryPath: "service-bypass",
    },
  );
}

export async function sendSubscriptionStartedNotification(
  chatId: number | string,
  subscriptionEnd: Date | null = null,
): Promise<TelegramApiCallResult> {
  return sendPhotoCaptionResult(
    chatId,
    SUBSCRIPTION_STARTED_IMG,
    buildSubscriptionStartedText(subscriptionEnd),
    undefined,
    {
      requireActiveSubscription: false,
      auditSource: "telegram.sendSubscriptionStartedNotification",
      auditDeliveryPath: "service-bypass",
    },
  );
}

export async function sendPhotoCaptionResult(
  chatId: number | string,
  photoPath: string,
  caption: string,
  inlineKeyboard?: TelegramInlineKeyboard,
  {
    appendChartLinks = true,
    requireActiveSubscription = true,
    auditSource = "telegram.sendPhotoCaptionResult",
    auditEventKey,
    auditDeliveryPath = requireActiveSubscription ? "direct" : "service-bypass",
  }: {
    appendChartLinks?: boolean;
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<TelegramApiCallResult<TelegramPhotoMessage>> {
  assertMarketCycleLeaseOwnership("Telegram photo delivery");
  if (requireActiveSubscription) {
    const rejection = await rejectIneligibleBroadcastRecipient(chatId);
    if (rejection) return rejection;
  }
  if (
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  ) {
    logger.debug(
      { chatId, caption: caption.slice(0, 80) },
      "DEV: Telegram photo suppressed",
    );
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed outside production",
    };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not configured");
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "TELEGRAM_BOT_TOKEN not configured",
    };
  }
  let audit: ReturnType<typeof beginTelegramEgressAudit> | null = null;
  try {
    const { readFileSync } = await import("fs");
    const { basename } = await import("path");
    const fileData = readFileSync(photoPath);
    const captionWithLinks = appendChartLinks
      ? appendTradingViewLinks(caption, 1_024)
      : appendTradingViewLinks(withoutTradingViewLinks(caption), 1_024);
    const preparedCaption =
      telegramHtmlToPlainTextWithLinkEntities(captionWithLinks);
    const buildForm = (useHtmlCaption: boolean): FormData => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (useHtmlCaption) {
        // Telegram rejected our computed link-entity offsets for this text.
        // Let Telegram parse the same caption itself rather than lose the photo.
        form.append("caption", captionWithLinks);
        form.append("parse_mode", "HTML");
      } else {
        form.append("caption", preparedCaption.text);
        if (preparedCaption.entities.length > 0) {
          form.append(
            "caption_entities",
            JSON.stringify(preparedCaption.entities),
          );
        }
      }
      form.append("protect_content", "false");
      if (inlineKeyboard) {
        form.append(
          "reply_markup",
          JSON.stringify({ inline_keyboard: inlineKeyboard }),
        );
      }
      form.append(
        "photo",
        new Blob([fileData], { type: "image/png" }),
        basename(photoPath),
      );
      return form;
    };
    audit = beginTelegramEgressAudit("sendPhoto", {
      source: auditSource,
      chatId,
      content: captionWithLinks,
      contentKind: "caption",
      deliveryPath: auditDeliveryPath,
      eventKey: auditEventKey,
    });
    const sendOnce = (useHtmlCaption: boolean) =>
      fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
        method: "POST",
        body: buildForm(useHtmlCaption),
        signal: AbortSignal.timeout(TELEGRAM_PHOTO_UPLOAD_TIMEOUT_MS),
      });
    let res = await sendOnce(false);
    let raw = await res.text();
    if (
      res.status === 400 &&
      /entity begins in a middle of a UTF-16 symbol/i.test(raw)
    ) {
      logger.warn(
        { chatId, description: raw.slice(0, 200) },
        "Telegram rejected caption entity offsets; retrying photo with HTML caption",
      );
      res = await sendOnce(true);
      raw = await res.text();
    }
    let payload: {
      ok?: boolean;
      description?: string;
      result?: TelegramPhotoMessage;
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
    const retryable = res.status === 429 || res.status >= 500;
    if (!ok) {
      logger.warn(
        {
          status: res.status,
          retryable,
          description,
        },
        "Telegram sendPhoto failed",
      );
    }
    const result = {
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
    if (!result.ok && result.status === 403) {
      await markSubscriberBotBlocked(chatId, result.description);
    }
    finishTelegramEgressAudit(audit, result);
    return result;
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    const localFileError =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      ["ENOENT", "EACCES", "EISDIR"].includes(String(err.code));
    logger.error({ err, timedOut, localFileError }, "Telegram sendPhoto error");
    const result: TelegramApiCallResult<TelegramPhotoMessage> = {
      ok: false,
      status: null,
      retryable: !localFileError,
      description: localFileError
        ? "local photo file unavailable"
        : timedOut
          ? "request timed out"
          : "network error",
    };
    if (audit) {
      finishTelegramEgressAudit(audit, result);
    }
    return result;
  }
}

export async function sendPhotoByFileId(
  chatId: number | string,
  fileId: string,
  caption: string,
  options: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<boolean> {
  return (await sendPhotoByFileIdResult(chatId, fileId, caption, options)).ok;
}

export async function sendPhotoByFileIdResult(
  chatId: number | string,
  fileId: string,
  caption: string,
  {
    requireActiveSubscription = true,
    auditSource = "telegram.sendPhotoByFileIdResult",
    auditEventKey,
    auditDeliveryPath = requireActiveSubscription ? "direct" : "service-bypass",
  }: {
    requireActiveSubscription?: boolean;
    auditSource?: string;
    auditEventKey?: string;
    auditDeliveryPath?: "outbox" | "direct" | "service-bypass";
  } = {},
): Promise<TelegramApiCallResult> {
  assertMarketCycleLeaseOwnership("Telegram cached-photo delivery");
  if (requireActiveSubscription) {
    const rejection = await rejectIneligibleBroadcastRecipient(chatId);
    if (rejection) return rejection;
  }
  if (
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test"
  ) {
    logger.debug(
      { chatId, fileId, caption: caption.slice(0, 80) },
      "DEV: Telegram photo(fileId) suppressed",
    );
    return {
      ok: false,
      status: null,
      retryable: false,
      description: "suppressed outside production",
    };
  }

  const preparedCaption = telegramHtmlToPlainTextWithLinkEntities(
    appendTradingViewLinks(caption, 1_024),
  );
  const result = await callTelegramApi("sendPhoto", {
    body: {
      chat_id: chatId,
      photo: fileId,
      caption: preparedCaption.text,
      ...(preparedCaption.entities.length > 0
        ? { caption_entities: preparedCaption.entities }
        : {}),
      protect_content: false,
    },
    audit: {
      source: auditSource,
      deliveryPath: auditDeliveryPath,
      eventKey: auditEventKey,
    },
  });
  if (!result.ok && result.status === 403) {
    await markSubscriberBotBlocked(chatId, result.description);
  }
  return result;
}

export async function testConnection(): Promise<boolean> {
  return (
    await callTelegramApi("getMe", {
      httpMethod: "GET",
    })
  ).ok;
}

export async function getBotInfo(): Promise<{
  username?: string;
  firstName?: string;
} | null> {
  const data = await callTelegramApi<{
    username?: string;
    first_name?: string;
  }>("getMe", { httpMethod: "GET" });
  if (data.ok && data.result) {
    return {
      username: data.result.username,
      firstName: data.result.first_name,
    };
  }
  return null;
}
export interface AlphaResult {
  symbol: string;
  grade: "alpha" | "super_alpha";
  price: number;
  priceChange30m: number;
  currentVolume: number;
  avgVolume: number;
  volumeMultiplier: number;
  oiChangePercent: number;
  openInterest: number | null;
  cmcRank: number | null;
  cmcSource: string | null;
  cmcAvailable: boolean;
  liquidationsUsd: number | null;
  liquidationsMultiple: number | null;
  coinglassAvailable: boolean;
  globalOiChange?: number | null;
  globalOiConfirmed?: boolean;
  isExhaustedSqueeze?: boolean;
  isNewListing?: boolean;
  pumpFromOpen?: number | null;
  candleCount?: number;
  sentiment: string;
  sentimentKey: string;
  traderAction: string;
  alphaScore: number;
  isContinuing: boolean;
  cumulativeOiChange: number;
  tradingViewUrl: string;
  bingxUrl: string;
  /** Какой ТФ OI сработал: "30m", "1h" или комбинация */
  oiTriggerTf?: string;
  /** Значение 1h OI изменения */
  oiChange1h?: number | null;
  /** Значение 4h OI изменения */
  oiChange4h?: number | null;
  /** Значение 24h OI изменения */
  oiChange24h?: number | null;
  /** Проскальзывание цены с момента kline до fresh price (%) */
  klineSlippage?: number;
  /** Символ уже встречался в сигналах за последние 24ч */
  isRepeatSignal?: boolean;
  /** Stealth re-entry after a Range-return cancel (owner 2026-10-21). */
  stealthReentry?: boolean;
  /** Provenance of the frozen Stealth Breakout level used by this signal. */
  stealthLevelSource?:
    | "auto_range_4h"
    | "auto_range_1h"
    | "stealth_legacy"
    | "continuation_shelf"
    | null;
  /** How a Stealth Range signal qualified: 30m hold or the >=10x volume fast path. */
  stealthEntryPath?: string | null;
  stealthVolumeUnconfirmed?: boolean;
  neonSupportBounceEvent?: { confluence?: string | null };
  stealthRangeConfirmingVenues?: string[] | null;
  stealthBingxOnly?: boolean;
  /** Фандинг рейт в процентах (напр. -0.04 = -0.04% за 8ч; источник: CoinGlass aggregate) */
  fundingRate?: number | null;
  /** Mark price (перп) */
  markPrice?: number | null;
  /** Index price (спотовый агрегат) */
  indexPrice?: number | null;
  /** Насколько цена уже выросла с момента обнаружения до момента выстрела (%) */
  priceConfirmPct?: number | null;
  /** Анализ стакана (CoinGlass/Binance): bidAskRatio, bias, scoreBonus */
  obImbalance?: CgAskBidsResult | null;
  /** MTF Spot CVD: 1h/4h таймфреймы не подтверждают — только скальп */
  isScalpOnly?: boolean;
  /** Spot CVD знак по ТФ (CoinGlass aggregated): true = +, false = −, null = нет данных. */
  spotCvdTf?: {
    m15: boolean | null;
    m30: boolean | null;
    h1: boolean | null;
    h4: boolean | null;
  } | null;
  /** BingX spot market 24h volume (USDT) — ориентир для сравнения с futures */
  spotVol24h?: number | null;
  /** SpotCVD/спот-история gate note (для диагностики) */
  spotGateNote?: string | null;
  /** Market cap токена (CoinGecko, USD) — для расчёта % оборачиваемости */
  marketCapUsd?: number | null;
  // ── Индивидуальный стоп/тейки по Liquidation Heatmap (CoinGlass) ───────────
  /** Уровень стопа: кластер лонг-ликвидаций ниже входа − 2% (null = стандарт) */
  liqStopPrice?: number | null;
  /** Глубина стопа в % от входа (положительное число) */
  liqStopPct?: number | null;
  /** Источник стопа: heatmap кластер / паттерн-стоп / стандартный */
  liqStopSource?: "liq_heatmap" | "pattern" | "standard";
  /** Цели: кластеры шорт-ликвидаций выше входа (ближняя первой) */
  liqTakes?: { price: number; pctFromEntry: number; liqUsd: number }[] | null;
  /** Ближайший кластер лонг-ликвидаций ниже входа: % дистанция (отрицательное число, напр. -3.2) */
  liqClusterBelowPct?: number | null;
  /** USD объём ближайшего кластера лонг-ликвидаций ниже входа */
  liqClusterBelowUsd?: number | null;
  /** Предстоящий разлок токена (CoinGlass): daysUntil = дней до разлока, pctSupply = % supply */
  upcomingUnlock?: { daysUntil: number; pctSupply: number } | null;
  /** Свежий мувер: <3 циклов в прескане + цена уже ≥5% за 24ч на момент обнаружения.
   *  Статистика 30д: 43% отмен в этом сегменте (growth-leader анализ 2026-07-15). */
  freshMoverRisk?: { cycles: number; price24h: number } | null;
  /** Пер-токенный Whale Index (CoinGlass, Binance 4h) — обогащается в broadcastBatchAlert.
   *  null = данных нет (BingX-эксклюзив и т.п.), undefined = ещё не тянули. */
  tokenWhaleIndex?: number | null;
  /** % всех аккаунтов в лонге, только Binance (CoinGlass). */
  globalLongPct?: number | null;
  /** Liquidation Max Pain (CoinGlass batch, 24h) — только для крупных монет.
   *  longPct/shortPct = % дистанция max-pain цены от входа. null = не покрыто. */
  maxPain?: {
    longPrice: number;
    shortPrice: number;
    longPct: number; // ((longMaxPainPrice - entry) / entry) * 100
    shortPct: number; // ((shortMaxPainPrice - entry) / entry) * 100
  } | null;
  /** Через какой OI Watch путь прошёл сигнал (A = price gate, B = vol/CVD gate).
   *  Undefined = прямой сигнал без OI Watch. Тег #path_a/#path_b в Telegram. */
  _oiWatchPath?: "A" | "B";
  /** BingX orderbook snapshot в момент выстрела сигнала (top-20 уровней).
   *  Снимается в trackSignal для всех паттернов. null = не удалось получить (fail-open). */
  entryOb?: OrderBookAnalysis | null;
  /** Краткая расшифровка Bullet Score для Telegram: OI/Vol/CVD/Taker/FR/ctx компоненты */
  scoreBreakdown?: string;
  /** Immutable 3h price change evaluated at decision time. */
  decisionPrice3h?: number | null;
  /** Immutable 1h price change evaluated at decision time. */
  price1hChange?: number | null;
  /** Impulse Buy decision payload retained until the canonical tracker snapshot is written. */
  impulseDecision?: {
    score: number;
    maxScore: number;
    candleBodyPct: number | null;
    volumeMultiplier: number | null;
    closeStrength: number | null;
    components: {
      bullish_impulse: boolean | null;
      confirmed_volume: boolean | null;
      strong_close: boolean | null;
    };
  };
  impulseFundingRate?: number | null;
  impulseSpotVolumeMultiplier?: number | null;
  impulseOi30m?: number | null;
  impulseCandleClosedAt?: Date | null;
  futTakerNetBuyPct?: number | null;
  /** Spot taker net buy % (CoinGlass aggregated, последняя 15m свеча). */
  spotTakerNetBuyPct?: number | null;
  /** Exact rule that assigned alpha/super_alpha at decision time. */
  gradeReason?: "alpha" | "score_8_plus_oi_2tf" | "oi30m_positive_15";
  /** Spot NetFlow 1h/4h/24h: % чистого покупательского давления (positive = net buying).
   *  Источник: CoinGlass batch-кэш (spot-netflow-cache). Обогащается в broadcastBatchAlert. */
  snf1h?: number | null;
  snf4h?: number | null;
  snf24h?: number | null;
  /** Internal DB signal ID for tracking and duplicate diagnostics.
   *  Заполняется после INSERT в signals при каждом новом сигнале. */
  signalId?: number | null;
  /** Immutable detector provenance; null means legacy/unknown. */
  stealthDetectionMethod?:
    | "quiet_zone_breakout"
    | "abneon_support_bounce"
    | "fresh_24h_high_breakout"
    | "range_4h_breakout"
    | "range_1h_breakout"
    | null;
}

export type PrimarySignalPolicyContext = {
  /** undefined = fresh signal (single-entry policy); null = legacy tracker */
  entryPolicyVersion?: string | null;
  splitLimitPrice?: number | null;
  policyVersion?: string | null;
  entryPrice?: number | null;
  originalEntryPrice?: number | null;
  stopLossPct?: number | null;
  stopLossPrice?: number | null;
};

export type PersistedPrimarySignalPolicy = Pick<
  PrimarySignalPolicyContext,
  | "entryPolicyVersion"
  | "splitLimitPrice"
  | "policyVersion"
  | "entryPrice"
  | "originalEntryPrice"
  | "stopLossPct"
  | "stopLossPrice"
>;

/**
 * The tracker is the only authority for an actionable signal's entry/exit
 * policy.  In particular, null means a known legacy row; it must never be
 * substituted for a missing tracker row.
 */
export function resolvePrimarySignalPolicyContext(
  tracker: PersistedPrimarySignalPolicy | null | undefined,
): PrimarySignalPolicyContext | null {
  if (!tracker) return null;
  return {
    entryPolicyVersion: tracker.entryPolicyVersion ?? null,
    splitLimitPrice: tracker.splitLimitPrice ?? null,
    policyVersion: tracker.policyVersion ?? null,
    entryPrice: tracker.entryPrice ?? null,
    originalEntryPrice: tracker.originalEntryPrice ?? null,
    stopLossPct: tracker.stopLossPct ?? null,
    stopLossPrice: tracker.stopLossPrice ?? null,
  };
}

function telegramScoreBreakdown(
  scoreBreakdown: string | null | undefined,
): string {
  if (!scoreBreakdown) return "";
  return scoreBreakdown
    .split(" · ")
    .filter((part) => !/^Impulse\s+\d+\/\d+(?:\s+\[|$)/i.test(part.trim()))
    .join(" · ")
    .trim();
}

/** Bullet Score is hidden where the old score is random (AUC ~0.5) until a new one exists. */
function isBulletScoreHidden(sentimentKey: string): boolean {
  return (
    sentimentKey === "price_led_momentum" ||
    sentimentKey === "impulse_buy" ||
    sentimentKey === "neon_support_bounce"
  );
}

function telegramNeonConfluence(s: AlphaResult): string {
  return s.sentimentKey === "neon_support_bounce" &&
    s.neonSupportBounceEvent?.confluence
    ? ` · 🧲 совпадение ${s.neonSupportBounceEvent.confluence}`
    : "";
}

function telegramReentryLabel(s: AlphaResult): string {
  return s.sentimentKey === "stealth_breakout" && s.stealthReentry === true
    ? " · 🔁 повторный вход"
    : "";
}

function telegramStealthSourceLabel(
  sentimentKey: string,
  levelSource: AlphaResult["stealthLevelSource"],
  detectionMethod?: AlphaResult["stealthDetectionMethod"],
): string | null {
  if (sentimentKey !== "stealth_breakout") return null;
  if (detectionMethod === "fresh_24h_high_breakout")
    return "🧪 ЭКСПЕРИМЕНТ · пробой 24ч-хая (1H)";
  if (detectionMethod === "range_4h_breakout")
    return "🧪 ЭКСПЕРИМЕНТ · пробой 4H-ренджа с объёмом";
  if (detectionMethod === "range_1h_breakout")
    return "🧪 ЭКСПЕРИМЕНТ · пробой узкого ренджа (1H)";
  if (levelSource === "auto_range_1h") return "🔵 Range Breakout 1H";
  if (levelSource === "auto_range_4h") return "🔵 Range Breakout 4H";
  if (levelSource === "stealth_legacy" || levelSource === "continuation_shelf")
    return "▫️ Resistance Breakout";
  return null;
}

function telegramEntryPathLabel(
  sentimentKey: string,
  entryPath: string | null | undefined,
): string | null {
  if (sentimentKey !== "stealth_breakout") return null;
  if (entryPath === "fast_volume") return "⚡ Быстрый путь: объём ≥10×";
  if (entryPath === "hold_30m") return "🕐 Путь: удержание 30m";
  return null;
}

function telegramRangeVenueLabel(
  sentimentKey: string,
  levelSource: AlphaResult["stealthLevelSource"],
  venues: AlphaResult["stealthRangeConfirmingVenues"],
): string | null {
  if (
    sentimentKey !== "stealth_breakout" ||
    levelSource !== "auto_range_4h" ||
    !venues?.length
  ) {
    return null;
  }
  const labels: Record<string, string> = {
    bingx: "BingX",
    binance: "Binance",
    okx: "OKX",
    bybit: "Bybit",
    gate: "Gate.io",
    kucoin: "KuCoin",
    mexc: "MEXC",
    bitget: "Bitget",
    htx: "HTX",
    kraken: "Kraken",
  };
  const exchanges = [
    ...new Set(venues.map((venue) => labels[venue]).filter(Boolean)),
  ];
  return exchanges.length ? `подтвердили: ${exchanges.join(", ")}` : null;
}

export function formatAlphaSignal(
  s: AlphaResult,
  policy: PrimarySignalPolicyContext = {},
): string {
  // Метка скорости: сколько ждать движения (короткая фраза)
  const speedLabel = (() => {
    const key = s.sentimentKey;
    if (key === "bullish_accumulation" && s.oiTriggerTf === "4h_early")
      return `🕯 Движение за 4ч+`;
    if (key === "bullish_accumulation") return `🕯 Движение за 4ч+`;
    return null;
  })();

  // Score breakdown line (под scoreLine): компактная расшифровка компонентов
  const telegramBreakdown = telegramScoreBreakdown(s.scoreBreakdown);
  const breakdownLine =
    telegramBreakdown && !isBulletScoreHidden(s.sentimentKey)
      ? `↳ ${escapeTelegramHtmlText(telegramBreakdown)}`
      : "";

  // Funding rate (текущий, 8ч период) — BingX lastFundingRate × 100 → %.
  // Обогащается в broadcastBatchAlert для всех сигналов.
  // Пороги для текущей 8ч ставки (типичный нейтральный ≈ ±0.01%):
  //   ≤ -0.05%  шорты в ловушке | ≤ -0.01%  шорты платят | -0.01..+0.02%  нейтральный
  //   ≥ +0.02%  лонги платят    | ≥ +0.10%  лонги перегреты | ≥ +0.15%  экстремальный
  let fundingLine = "";
  if (s.fundingRate != null) {
    const fr = s.fundingRate;
    const frPct = fr.toFixed(3);
    const frSign = fr >= 0 ? "+" : "";
    let frLabel: string;
    if (fr <= -0.05) {
      frLabel = `💰 Фандинг (8ч): ${frSign}${frPct}% — шорты в ловушке, сквиз-давление`;
    } else if (fr <= -0.01) {
      frLabel = `💰 Фандинг (8ч): ${frSign}${frPct}% — шорты платят, позитивно`;
    } else if (fr >= 0.1) {
      frLabel = `⚠️ Фандинг (8ч): ${frSign}${frPct}% — лонги перегреты`;
    } else if (fr >= 0.02) {
      frLabel = `📈 Фандинг (8ч): ${frSign}${frPct}% — лонги платят`;
    } else {
      frLabel = `⚖️ Фандинг (8ч): ${frSign}${frPct}%`;
    }
    fundingLine = frLabel;
  }

  // Экстремальный фандинг — отдельная строка-предупреждение (≥ +0.15% за 8ч)
  let extremeFundingLine = "";
  if (s.fundingRate != null && s.fundingRate >= 0.15) {
    extremeFundingLine = `⚠️ <b>ВНИМАНИЕ: Экстремальный фандинг</b> — лонги критически перегреты, риск каскадных ликвидаций`;
  }

  // Scalp Only: спот CVD 1h/4h не подтверждён — риск разворота на старших ТФ
  const scalpOnlyLine = "";

  // Alpha Score bar: filled blocks out of 10
  const filled = Math.round(s.alphaScore);
  const scoreBar = "█".repeat(filled) + "░".repeat(10 - filled);
  const scoreLine = isBulletScoreHidden(s.sentimentKey)
    ? ""
    : `🎯 <b>Bullet Score: ${s.alphaScore}/10</b>  <code>${scoreBar}</code>`;

  // Russian pattern names (полные описания для Telegram)
  const is4hEarly = s.oiTriggerTf === "4h_early";
  const patternRuName: Record<string, string> = {
    dip_accumulation: "💎 Накопление на дипе — умные деньги откупают падение",
    bullish_accumulation: is4hEarly
      ? "📊🕯 Накопление (4h Grind) — OI + цена, SpotCVD 4h за 4ч+"
      : "📊 Бычье накопление — OI + цена растут, стандартный паттерн",
    liquidation_cascade:
      "💥🔄 Каскад ликвидаций → разворот — long-ликвидации выдохлись, OI стабилизировался",
    whale_watch: s.sentiment?.includes("Smart Money OB-отскок")
      ? `🐋 Whale Futures — Smart Money OB-отскок (${
          s.sentiment.includes("(1D)") ? "1D" : "4H"
        }) — отскок от бычьего ордерблока LuxAlgo`
      : "🐋 Whale Futures",
    stealth_breakout: STEALTH_BREAKOUT_TELEGRAM_NAME,
    neon_support_bounce: NEON_SUPPORT_BOUNCE_TELEGRAM_NAME,
    price_led_momentum: PRICE_LED_MOMENTUM_TELEGRAM_NAME,
    impulse_buy: IMPULSE_BUY_TELEGRAM_NAME,
  };

  // Длительность отработки (от → до; LC — реальные данные n=44; остальные — оценка)
  const _PATTERN_DURATION: Record<string, string> = {
    stealth_breakout: "от 2ч до 10ч",
    price_led_momentum: "от 3ч до 14ч",
    impulse_buy: "от 2ч до 12ч",
    balanced_grind: "от 5ч до 18ч",
    bullish_accumulation: "от 4ч до 16ч",
    liquidation_cascade: "от 10ч до 4д",
    whale_watch: "от 4ч до 4д",
  };
  const _dur = _PATTERN_DURATION[s.sentimentKey];
  const durationLine = _dur ? `⏱ <i>${_dur}</i>` : "";

  const _pEmoji = getPatternTgLabel(s.sentimentKey).split(" ")[0] ?? "🔹";
  const _coverageBadge = isBingxExclusive(s.symbol)
    ? "[BingX]"
    : isBinanceSpotListed(s.symbol)
      ? "[Spot]"
      : "[Multi]";
  const patternName =
    patternRuName[s.sentimentKey] ?? getPatternTgLabel(s.sentimentKey);
  const patternLine = telegramHtml`🏷 <b>Паттерн:</b> ${patternName} · ${_coverageBadge}${telegramNeonConfluence(s)}`;
  const stealthSourceLabel = telegramStealthSourceLabel(
    s.sentimentKey,
    s.stealthLevelSource,
    s.stealthDetectionMethod,
  );
  const stealthVenueLabel = telegramRangeVenueLabel(
    s.sentimentKey,
    s.stealthLevelSource,
    s.stealthRangeConfirmingVenues,
  );
  const stealthSourceLine = stealthSourceLabel
    ? `🏷 <b>Источник уровня:</b> ${stealthSourceLabel}${stealthVenueLabel ? ` · ${stealthVenueLabel}` : ""}${telegramEntryPathLabel(s.sentimentKey, s.stealthEntryPath) ? ` · ${telegramEntryPathLabel(s.sentimentKey, s.stealthEntryPath)}` : ""}${telegramReentryLabel(s)}`
    : "";
  const stealthVolumeNote = s.stealthVolumeUnconfirmed
    ? "⚠️ <b>Объём не подтверждён</b> (нет данных CoinGlass)"
    : "";
  const highHitRateLine =
    s.sentimentKey === "bullish_accumulation" ||
    s.sentimentKey === "liquidation_cascade"
      ? `⭐ <b>ВЫСОКИЙ ПРОЦЕНТ ОТРАБОТКИ</b>`
      : "";
  const continuingLine = s.isContinuing
    ? `📡 <i>Продолжает движение (OI ${s.cumulativeOiChange >= 0 ? "+" : ""}${s.cumulativeOiChange.toFixed(1)}% суммарно)</i>`
    : "";

  // Ценовое подтверждение — показываем насколько цена уже прошла до выстрела
  const confirmLine =
    s.priceConfirmPct != null && s.priceConfirmPct >= 1
      ? `✅ <b>Подтверждён:</b> цена уже +${s.priceConfirmPct.toFixed(1)}% с момента обнаружения`
      : "";

  // Повторный сигнал — символ уже был в сигналах за последние 24ч
  const repeatLine = s.isRepeatSignal
    ? `🔁 <i>Повторный сигнал за 24ч — тезис подтвердился снова, вход ещё актуален</i>`
    : "";

  // HighRisk warning — BingX Exclusive: нет кросс-биржевых данных

  // Exhaustion warning — SHORT_SQUEEZE с CoinGlass OI < -20%
  const exhaustionLine = s.isExhaustedSqueeze
    ? `⚠️ <b>ВНИМАНИЕ:</b> Global OI ${s.globalOiChange != null ? s.globalOiChange.toFixed(0) : ""}% — шорты уже выдавлены, вход может быть поздним`
    : "";

  // Slippage warning — цена успела уйти пока шёл CoinGlass batch
  const slippageLine =
    s.klineSlippage != null && Math.abs(s.klineSlippage) >= 5
      ? `⚠️ <b>ПОЗДНИЙ ВХОД:</b> цена ушла на ${s.klineSlippage >= 0 ? "+" : ""}${s.klineSlippage.toFixed(1)}% пока шёл анализ`
      : "";

  // ── Стоп лосс ────────────────────────────────────────────────────────────────
  // Источники стопа (liqStopSource):
  //   liq_heatmap — кластер лонг-ликвидаций (возможно клампирован до паттерн-лимита)
  //   pattern     — паттерн-стоп (heatmap недоступен, но у паттерна есть задокументированный стоп)
  //   standard    — глобальный STOP_LOSS (10%), у паттерна нет специального стопа
  const fmtPrice = (p: number) =>
    p < 1 ? p.toFixed(6) : p < 100 ? p.toFixed(4) : p.toFixed(2);
  const hasPersistedStop =
    policy.stopLossPrice != null &&
    Number.isFinite(policy.stopLossPrice) &&
    policy.stopLossPct != null &&
    Number.isFinite(policy.stopLossPct) &&
    policy.stopLossPct > 0;
  const hasLiqStop =
    s.liqStopPrice != null && s.liqStopPct != null && s.liqStopPct > 0;
  const _patternStopPct = getPatternMaxStop(s.sentimentKey);
  let stopLine: string;
  if (hasPersistedStop) {
    stopLine = `🛑 <b>Стоп:</b> $${fmtPrice(policy.stopLossPrice!)} (−${policy.stopLossPct!.toFixed(1)}%)`;
  } else if (hasLiqStop) {
    stopLine = `🛑 <b>Стоп:</b> $${fmtPrice(s.liqStopPrice!)} (−${s.liqStopPct!.toFixed(1)}%)`;
  } else {
    stopLine = `🛑 <b>Стоп:</b> $${fmtPrice(s.price * (1 - _patternStopPct / 100))} (−${_patternStopPct}%)`;
  }
  const managementLine = buildSignalManagementLine(s.sentimentKey, s.symbol, {
    stealthDetectionMethod: s.stealthDetectionMethod,
    stopPct: hasPersistedStop ? policy.stopLossPct : null,
  });
  const impulseRunnerLine = fmtImpulseRunnerPolicyLine({
    sentimentKey: s.sentimentKey,
    policyVersion:
      s.sentimentKey === "impulse_buy"
        ? s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT"
          ? null
          : policy.policyVersion === undefined
            ? policy.entryPolicyVersion === null
              ? null
              : IMPULSE_RUNNER_POLICY_VERSION
            : policy.policyVersion
        : null,
    entryPolicyVersion:
      s.sentimentKey === "impulse_buy"
        ? (policy.entryPolicyVersion ?? SINGLE_ENTRY_POLICY_VERSION)
        : null,
  });

  const splitLine =
    policy.entryPolicyVersion === null
      ? `📥 <b>Вход:</b> 50% по рынку $${fmtPrice(policy.originalEntryPrice ?? s.price)} · 50% лимиткой $${fmtPrice(policy.splitLimitPrice ?? s.price * 0.95)} (−5%)${policy.entryPrice != null && policy.originalEntryPrice != null && policy.entryPrice !== policy.originalEntryPrice ? ` · средняя $${fmtPrice(policy.entryPrice)}` : ""}`
      : `📥 <b>Вход:</b> $${fmtPrice(s.price)}`;

  const entryBlock = [splitLine, stopLine, managementLine, impulseRunnerLine]
    .filter(Boolean)
    .join("\n");

  const priceFormatted = fmtPrice(s.price);
  const linksLine = formatMarketLinks(s.symbol);
  const marketPriceLine = `💵 $${priceFormatted}`;
  const pathTag =
    s._oiWatchPath === "A"
      ? "#path_a"
      : s._oiWatchPath === "B"
        ? "#path_b"
        : null;
  const tagsLine = [tickerTag(s.symbol), patternTag(s.sentimentKey), pathTag]
    .filter(Boolean)
    .join(" ");

  // Whale Index (BTC, 4h) — рыночный контекст в каждом алерте; null = нет данных, строка пропускается
  const _rawWhaleIndexLine = getWhaleIndexLine();
  const whaleIndexLine = _rawWhaleIndexLine != null ? _rawWhaleIndexLine : "";

  // ── Компактная строка метрик входа: WI · OB ─────────────────────────────────
  // Показываем значения в одной строке когда данные есть.
  // Отсутствующие значения опускаются — строка не показывается если все три null.
  const _compactParts: string[] = [];

  // WI (пер-токенный Whale Index, CoinGlass Binance 4h)
  if (s.tokenWhaleIndex != null) {
    const _wiSign = s.tokenWhaleIndex >= 0 ? "+" : "";
    const _wiMood =
      s.tokenWhaleIndex >= 10 ? "🟢" : s.tokenWhaleIndex <= -10 ? "🔴" : "⚪";
    _compactParts.push(
      `WI ${_wiSign}${s.tokenWhaleIndex.toFixed(0)}${_wiMood}`,
    );
  }

  // Толпа: % аккаунтов в лонге, только Binance
  if (s.globalLongPct != null) {
    _compactParts.push(`Толпа ${s.globalLongPct.toFixed(0)}% лонг (Binance)`);
  }

  // OB ratio (BingX стакан при детекте; CoinGlass если доступен)
  const _obData = s.obImbalance ?? s.entryOb;
  if (_obData != null && _obData.bidAskRatio > 0) {
    const _obEmoji =
      _obData.bidAskRatio >= 1.5
        ? "🟢"
        : _obData.bidAskRatio <= 0.7
          ? "🔴"
          : "⚪";
    _compactParts.push(`OB ${_obData.bidAskRatio.toFixed(2)}x${_obEmoji}`);
  }

  const compactMetricsLine =
    _compactParts.length > 0 ? `📊 ${_compactParts.join(" · ")}` : "";

  // SNF (Spot NetFlow): net buying pressure 1h/4h/24h
  // Показываем когда есть хотя бы одно значение. Emoji по 1h как главному сигналу.
  let snfLine = "";
  if (s.snf1h != null || s.snf4h != null || s.snf24h != null) {
    const fmtV = (v: number | null | undefined) => {
      if (v == null) return "—";
      return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    };
    const snfEmoji =
      s.snf1h == null
        ? ""
        : s.snf1h >= 3
          ? "🟢"
          : s.snf1h >= 1
            ? "🔵"
            : s.snf1h <= -3
              ? "🔴"
              : s.snf1h <= -1
                ? "🟠"
                : "⚪";
    snfLine = `🌊 SNF: 1h ${fmtV(s.snf1h)}${snfEmoji} · 4h ${fmtV(s.snf4h)} · 24h ${fmtV(s.snf24h)}`;
  }

  // Unlock warning — разлок токена в течение 4-7 дней
  const unlockLine =
    s.upcomingUnlock != null
      ? `⚠️ <b>Разлок через ${s.upcomingUnlock.daysUntil} дн:</b> ${s.upcomingUnlock.pctSupply.toFixed(1)}% supply — риск дампа после разлока`
      : "";

  return [
    patternLine,
    stealthSourceLine,
    stealthVolumeNote,
    durationLine,
    highHitRateLine,
    speedLabel,
    unlockLine,
    confirmLine,
    scalpOnlyLine,
    scoreLine,
    breakdownLine,
    ``,
    entryBlock,
    ``,
    whaleIndexLine,
    compactMetricsLine,
    snfLine,
    fundingLine,
    extremeFundingLine,
    repeatLine,
    exhaustionLine,
    slippageLine,
    continuingLine,
    marketPriceLine,
    linksLine,
    ``,
    tagsLine,
  ]
    .filter((l) => l !== undefined && l !== null && l !== "")
    .join("\n");
}

export const TELEGRAM_SIGNAL_BODY_MAX_LEN = 880;

function _formatCompactPrice(price: number): string {
  return price < 1
    ? price.toFixed(6)
    : price < 100
      ? price.toFixed(4)
      : price.toFixed(2);
}

/**
 * Compact primary-signal body for Telegram photo captions.
 * Trading levels and all three chart links are mandatory; secondary evidence
 * is appended only while the body remains inside its fixed caption budget.
 */
export function formatCompactAlphaSignal(
  s: AlphaResult,
  policy: PrimarySignalPolicyContext = {},
): string {
  const stealthSourceLabel = telegramStealthSourceLabel(
    s.sentimentKey,
    s.stealthLevelSource,
    s.stealthDetectionMethod,
  );
  const stealthVenueLabel = telegramRangeVenueLabel(
    s.sentimentKey,
    s.stealthLevelSource,
    s.stealthRangeConfirmingVenues,
  );
  // Owner 2026-10-23: the pattern name is not shown (the hashtag carries it);
  // only the qualifying details remain.
  const patternDetails = [
    stealthSourceLabel,
    stealthVenueLabel,
    telegramEntryPathLabel(s.sentimentKey, s.stealthEntryPath),
    telegramReentryLabel(s).replace(/^ · /, ""),
    telegramNeonConfluence(s).replace(/^ · /, ""),
  ].filter(Boolean);
  const patternLine =
    patternDetails.length > 0
      ? telegramHtml`🏷 <b>${patternDetails.join(" · ")}</b>`
      : "";
  const telegramBreakdown = telegramScoreBreakdown(s.scoreBreakdown);
  const scoreLine = isBulletScoreHidden(s.sentimentKey)
    ? ""
    : `🎯 <b>${s.alphaScore}/10</b> <code>${"█".repeat(Math.min(10, Math.max(0, Math.round(s.alphaScore))))}${"░".repeat(10 - Math.min(10, Math.max(0, Math.round(s.alphaScore))))}</code>${telegramBreakdown ? ` · ${escapeTelegramHtmlText(telegramBreakdown.slice(0, 100))}` : ""}`;

  const entryLine = `📥 <b>Вход:</b> $${_formatCompactPrice(s.price)}`;

  const stopPct =
    policy.stopLossPct != null &&
    Number.isFinite(policy.stopLossPct) &&
    policy.stopLossPct > 0
      ? policy.stopLossPct
      : s.liqStopPct != null && Number.isFinite(s.liqStopPct)
        ? s.liqStopPct
        : getPatternMaxStop(s.sentimentKey);
  const stopPrice =
    policy.stopLossPrice != null &&
    Number.isFinite(policy.stopLossPrice) &&
    policy.stopLossPrice > 0
      ? policy.stopLossPrice
      : s.liqStopPrice != null && Number.isFinite(s.liqStopPrice)
        ? s.liqStopPrice
        : s.price * (1 - stopPct / 100);
  const protectionLine = `🛑 <b>Стоп:</b> $${_formatCompactPrice(stopPrice)} (−${Math.abs(stopPct).toFixed(1)}%)`;
  const managementLine = buildSignalManagementLine(s.sentimentKey, s.symbol, {
    stealthDetectionMethod: s.stealthDetectionMethod,
    stopPct,
  });
  const impulseRunnerLine = fmtImpulseRunnerPolicyLine({
    sentimentKey: s.sentimentKey,
    policyVersion:
      s.sentimentKey === "impulse_buy"
        ? s.symbol === "BTC-USDT" || s.symbol === "BTCUSDT"
          ? null
          : policy.policyVersion === undefined
            ? policy.entryPolicyVersion === null
              ? null
              : IMPULSE_RUNNER_POLICY_VERSION
            : policy.policyVersion
        : null,
    entryPolicyVersion:
      s.sentimentKey === "impulse_buy"
        ? (policy.entryPolicyVersion ?? SINGLE_ENTRY_POLICY_VERSION)
        : null,
  });

  const linksLine = formatMarketLinks(s.symbol);
  const tagsLine = `${tickerTag(s.symbol)} ${patternTag(s.sentimentKey)}`;
  const mandatory = [
    patternLine,
    scoreLine,
    policy.entryPolicyVersion === null
      ? `📥 <b>Вход:</b> 50% рынок $${_formatCompactPrice(policy.originalEntryPrice ?? s.price)} · 50% лимит $${_formatCompactPrice(policy.splitLimitPrice ?? s.price * 0.95)} (−5%)${policy.entryPrice != null && policy.originalEntryPrice != null && policy.entryPrice !== policy.originalEntryPrice ? ` · средняя $${_formatCompactPrice(policy.entryPrice)}` : ""}`
      : entryLine,
    protectionLine,
    managementLine,
    impulseRunnerLine,
    linksLine,
    tagsLine,
  ];

  const riskParts = [
    s.upcomingUnlock
      ? `⚠️ разлок ${s.upcomingUnlock.daysUntil}д/${s.upcomingUnlock.pctSupply.toFixed(1)}%`
      : null,
    s.isExhaustedSqueeze
      ? `⚠️ шорты выжаты${s.globalOiChange != null ? ` OI ${s.globalOiChange >= 0 ? "+" : ""}${s.globalOiChange.toFixed(0)}%` : ""}`
      : null,
    s.fundingRate != null && s.fundingRate >= 0.15
      ? `⚠️ экстрем. funding ${s.fundingRate >= 0 ? "+" : ""}${s.fundingRate.toFixed(3)}%`
      : null,
    formatSpotCvdTf(s.spotCvdTf),
    s.klineSlippage != null && Math.abs(s.klineSlippage) >= 5
      ? `⚠️ slippage ${s.klineSlippage >= 0 ? "+" : ""}${s.klineSlippage.toFixed(1)}%`
      : null,
    s.isContinuing
      ? `📈 OI продолжает +${s.cumulativeOiChange.toFixed(1)}%`
      : null,
  ].filter((part): part is string => Boolean(part));
  const riskLine = riskParts.length > 0 ? riskParts.join(" · ") : null;

  const compactOb = s.obImbalance ?? s.entryOb;
  const metricParts = [
    s.tokenWhaleIndex != null
      ? `WI ${s.tokenWhaleIndex >= 0 ? "+" : ""}${s.tokenWhaleIndex.toFixed(1)}${s.tokenWhaleIndex >= 10 ? "🟢" : s.tokenWhaleIndex <= -10 ? "🔴" : "⚪"}`
      : null,
    s.globalLongPct != null
      ? `Толпа ${s.globalLongPct.toFixed(0)}% лонг (Binance)`
      : null,
    compactOb != null && compactOb.bidAskRatio > 0
      ? `OB ${compactOb.bidAskRatio.toFixed(2)}x${compactOb.bidAskRatio >= 1.5 ? "🟢" : compactOb.bidAskRatio <= 0.7 ? "🔴" : "⚪"}`
      : null,
    s.snf1h != null
      ? `SNF ${s.snf1h >= 0 ? "+" : ""}${s.snf1h.toFixed(1)}%/1ч${s.snf1h >= 3 ? "🟢" : s.snf1h >= 1 ? "🔵" : s.snf1h <= -3 ? "🔴" : s.snf1h <= -1 ? "🟠" : "⚪"}`
      : null,
    s.futTakerNetBuyPct != null
      ? `FutTaker ${s.futTakerNetBuyPct >= 0 ? "+" : ""}${s.futTakerNetBuyPct.toFixed(1)}%${s.futTakerNetBuyPct >= 5 ? "🟢" : s.futTakerNetBuyPct <= -5 ? "🔴" : "⚪"}`
      : null,
    s.spotTakerNetBuyPct != null
      ? `SpotTaker ${s.spotTakerNetBuyPct >= 0 ? "+" : ""}${s.spotTakerNetBuyPct.toFixed(1)}%${s.spotTakerNetBuyPct >= 5 ? "🟢" : s.spotTakerNetBuyPct <= -5 ? "🔴" : "⚪"}`
      : null,
    s.fundingRate != null
      ? `FR ${s.fundingRate >= 0 ? "+" : ""}${s.fundingRate.toFixed(3)}%${s.fundingRate <= -0.01 ? "🟢" : s.fundingRate >= 0.02 ? "🔴" : "⚪"}`
      : null,
  ].filter((part): part is string => Boolean(part));
  // Entry, stop, management, and (when applicable) runner are mandatory.
  // Links/tags remain mandatory as the final two lines; only secondary
  // evidence is dropped when the caption budget is tight.
  const result = [
    patternLine,
    scoreLine,
    mandatory[2],
    protectionLine,
    managementLine,
    impulseRunnerLine,
  ].filter((line): line is string => Boolean(line));
  if (
    riskLine &&
    [...result, riskLine, linksLine, tagsLine].join("\n").length <=
      TELEGRAM_SIGNAL_BODY_MAX_LEN
  ) {
    result.push(riskLine);
  }
  // A long metrics row should not hide all indicators when only some fit.
  const visibleMetrics: string[] = [];
  for (const metric of metricParts) {
    const next = `📊 ${[...visibleMetrics, metric].join(" · ")}`;
    if (
      [...result, next, linksLine, tagsLine].join("\n").length <=
      TELEGRAM_SIGNAL_BODY_MAX_LEN
    ) {
      visibleMetrics.push(metric);
    }
  }
  if (visibleMetrics.length > 0)
    result.push(`📊 ${visibleMetrics.join(" · ")}`);
  result.push(linksLine, tagsLine);
  return result.join("\n");
}

// Cache: @username → numeric chat ID (resolved once via Telegram API, persists for process lifetime)
const _chatIdCache = new Map<string, number>();

async function resolveToNumericId(chatId: string): Promise<number | null> {
  const key = chatId.toLowerCase();
  if (_chatIdCache.has(key)) return _chatIdCache.get(key)!;
  try {
    const response = await callTelegramApi<{ id: number }>("getChat", {
      body: { chat_id: chatId },
      audit: {
        source: "telegram.resolveToNumericId",
        deliveryPath: "telegram-control",
      },
    });
    if (response.ok && response.result?.id) {
      _chatIdCache.set(key, response.result.id);
      return response.result.id;
    }
  } catch {
    /* ignore — fall back to string dedup */
  }
  return null;
}

export async function getTargets(options?: {
  strict?: boolean;
}): Promise<(number | string)[]> {
  const seenNumeric = new Set<number>();
  const seenString = new Set<string>();
  const targets: (number | string)[] = [];

  // Dedup by numeric ID when possible (prevents duplicate sends when TELEGRAM_CHAT_ID
  // is a numeric chat ID and settings.channelId is the same channel as @username)
  const addTarget = async (id: number | string) => {
    if (typeof id === "number") {
      if (!seenNumeric.has(id)) {
        seenNumeric.add(id);
        targets.push(id);
      }
    } else if (id.startsWith("@")) {
      const numId = await resolveToNumericId(id);
      if (numId !== null) {
        if (!seenNumeric.has(numId)) {
          seenNumeric.add(numId);
          targets.push(numId);
        }
      } else {
        const key = id.toLowerCase();
        if (!seenString.has(key)) {
          seenString.add(key);
          targets.push(id);
        }
      }
    } else {
      const key = id.toLowerCase();
      if (!seenString.has(key)) {
        seenString.add(key);
        targets.push(id);
      }
    }
  };

  // The operational owner is a separate, perpetual recipient. Keep this
  // outside the paid personal snapshot so an expired subscriber can never
  // inherit the owner bypass, while the owner still receives every broadcast.
  const operationalRecipientId = getOperationalTelegramRecipientId();
  await addTarget(operationalRecipientId);

  // TELEGRAM_CHAT_ID is a legacy alert target. Channel IDs are added here;
  // positive personal IDs are resolved from subscription tables below.
  const envId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (envId) {
    if (envId.startsWith("@") || envId.startsWith("-100")) {
      await addTarget(envId);
    }
    // Positive personal IDs are resolved from subscription tables below.
  }

  // State-changing durable broadcasts use strict=true so a failed lookup cannot
  // commit a partial recipient snapshot. Informational broadcasts retain the
  // historical fail-open channel/env behavior.
  const [subscriberRead, dashboardUserRead] = await Promise.all([
    dbReadWithRetry(
      "Telegram subscriber recipients",
      () =>
        db
          .select({ chatId: subscribersTable.chatId })
          .from(subscribersTable)
          .where(
            and(
              eq(subscribersTable.active, true),
              or(
                isNull(subscribersTable.subscribedUntil),
                gt(subscribersTable.subscribedUntil, new Date()),
              ),
              sql`NOT EXISTS (
                SELECT 1
                FROM ${dashboardUsersTable}
                WHERE ${dashboardUsersTable.chatId} = CAST(${subscribersTable.chatId} AS text)
              )`,
            ),
          ),
      2,
      500,
    ),
    dbReadWithRetry(
      "Telegram Dashboard recipients",
      () =>
        db
          .select({ chatId: dashboardUsersTable.chatId })
          .from(dashboardUsersTable)
          .where(
            and(
              eq(dashboardUsersTable.status, "approved"),
              isNotNull(dashboardUsersTable.chatId),
              or(
                isNull(dashboardUsersTable.subscribedUntil),
                gt(dashboardUsersTable.subscribedUntil, new Date()),
              ),
            ),
          ),
      2,
      500,
    ),
  ]);
  const personalRecipientSource = resolveTelegramPersonalRecipientSnapshot({
    subscriberLookupOk: subscriberRead.ok,
    subscriberChatIds: subscriberRead.ok
      ? subscriberRead.value.map((row) => row.chatId)
      : [],
    dashboardLookupOk: dashboardUserRead.ok,
    dashboardChatIds: dashboardUserRead.ok
      ? dashboardUserRead.value.map((row) => row.chatId)
      : [],
    strict: options?.strict === true,
  });
  for (const chatId of personalRecipientSource.value) {
    await addTarget(chatId);
  }

  // Always add channelId from settings so the channel receives every message.
  // Primary: DB query; Fallback: in-memory cache (populated at startup, updated on settings change).
  const channelSource = await resolveTelegramRecipientSource({
    source: "Telegram channel settings",
    strict: options?.strict === true,
    load: async () => {
      const rows = await db
        .select({ channelId: settingsTable.channelId })
        .from(settingsTable)
        .limit(1);
      return rows[0]?.channelId?.trim() || null;
    },
    fallback: () => _channelIdCache,
  });
  const channelIdResolved = channelSource.value;
  if (channelSource.resolved) {
    if (channelIdResolved) _channelIdCache = channelIdResolved;
  } else {
    if (channelIdResolved) {
      logger.warn(
        { channelId: channelIdResolved },
        "getTargets: DB недоступна — используем кэш channelId",
      );
    } else {
      logger.error(
        "getTargets: DB недоступна и кэш channelId пуст — канал пропущен",
      );
    }
  }
  if (channelIdResolved) await addTarget(channelIdResolved);
  logger.info(
    {
      recipients: targets.length,
      personalRecipients: personalRecipientSource.value.length,
      personalRecipientSource: personalRecipientSource.resolved
        ? "database"
        : "cache",
      hasOperationalRecipient: targets.some(
        (target) =>
          normalizeTelegramRecipientId(target) ===
          getOperationalTelegramRecipientId(),
      ),
      hasChannel: Boolean(channelIdResolved),
    },
    "getTargets: resolved Telegram broadcast recipients",
  );

  return targets;
}

/**
 * Strict recipient snapshot for durable milestone delivery. An unresolved
 * @channel is deliberately not sent to: it remains an explicit retryable
 * failure until a stable numeric chat ID is available.
 */
export async function getCanonicalMilestoneTargets(): Promise<CanonicalTelegramTargetSnapshot> {
  return canonicalizeMilestoneTargets(
    await getTargets({ strict: true }),
    resolveToNumericId,
  );
}

/** Убирает HTML-теги из строки — для безопасного обрезания caption до 1024 символов. */
function _stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

const ALERT_PHOTO_BROADCAST_CONCURRENCY = 4;
const ALERT_PHOTO_RETRY_DELAY_MS = 1_000;

async function _sendPatternPhotoWithSafeRetry(
  chatId: number | string,
  photoPath: string,
  text: string,
): Promise<TelegramApiCallResult> {
  let result = await sendPhotoCaptionResult(
    chatId,
    photoPath,
    text,
    undefined,
    {
      requireActiveSubscription: true,
    },
  );
  if (shouldRetryExplicitPhotoFailure(result)) {
    await new Promise((resolve) =>
      setTimeout(resolve, ALERT_PHOTO_RETRY_DELAY_MS),
    );
    result = await sendPhotoCaptionResult(chatId, photoPath, text, undefined, {
      requireActiveSubscription: true,
    });
  }
  return result;
}

async function _sendPatternAlertToTarget(
  chatId: number | string,
  patternImg: string | undefined,
  text: string,
): Promise<boolean> {
  if (!patternImg) {
    return (
      await sendMessageResult(chatId, text, {
        requireActiveSubscription: true,
      })
    ).ok;
  }

  const photoResult = await _sendPatternPhotoWithSafeRetry(
    chatId,
    patternImg,
    text,
  );
  if (photoResult.ok) return true;

  if (!shouldFallbackToTextAfterPhotoFailure(photoResult)) {
    logger.warn(
      {
        chatId,
        status: photoResult.status,
        description: photoResult.description,
      },
      "Pattern photo delivery uncertain — text fallback skipped to prevent duplicate",
    );
    return false;
  }

  return (
    await sendMessageResult(chatId, text, {
      requireActiveSubscription: true,
    })
  ).ok;
}

async function _sendPatternAlertToTargets(
  targets: (number | string)[],
  deliver: (target: number | string) => Promise<boolean>,
): Promise<boolean[]> {
  const results: boolean[] = [];
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= targets.length) return;
      results[index] = await deliver(targets[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(ALERT_PHOTO_BROADCAST_CONCURRENCY, targets.length) },
      worker,
    ),
  );
  return results;
}

function formatSpotCvdTf(c: AlphaResult["spotCvdTf"]): string | null {
  if (!c) return null;
  const sign = (v: boolean | null) => (v === null ? "?" : v ? "+" : "−");
  if (c.m15 === null && c.m30 === null && c.h1 === null && c.h4 === null)
    return null;
  return `CVD 15m${sign(c.m15)} 30m${sign(c.m30)} 1h${sign(c.h1)} 4h${sign(c.h4)}`;
}

export async function broadcastBatchAlert(
  signals: AlphaResult[],
  options: {
    eventKey?: string;
    policy?: PrimarySignalPolicyContext;
  } = {},
): Promise<number> {
  if (signals.length === 0) return 0;

  const signalIds = signals
    .map((signal) => signal.signalId)
    .filter((id): id is number => Number.isInteger(id));
  if (options.eventKey && signalIds.length !== signals.length) {
    throw new Error("primary alert requires a persisted signal ID");
  }
  const detectionRows =
    signalIds.length > 0
      ? await db
          .select({ id: signalsTable.id, detectedAt: signalsTable.detectedAt })
          .from(signalsTable)
          .where(inArray(signalsTable.id, signalIds))
      : [];
  const detectedById = new Map(
    detectionRows.map((row) => [row.id, row.detectedAt]),
  );
  if (
    options.eventKey &&
    signals.some((signal) => !detectedById.has(signal.signalId!))
  ) {
    throw new Error("primary alert requires signals.detected_at");
  }

  // Durable primary alerts must be tied to an authoritative tracker. This
  // lookup covers every scanner/watcher caller and prevents a missing row from
  // silently becoming the legacy (entryPolicyVersion=null) policy.
  const policyBySignalId = new Map<number, PrimarySignalPolicyContext>();
  if (options.eventKey && !options.policy) {
    const signalIds = signals
      .map((signal) => signal.signalId)
      .filter((id): id is number => Number.isInteger(id));
    if (signalIds.length !== signals.length) {
      throw new Error(
        "primary alert requires signalId and authoritative tracked position",
      );
    }
    const linkedTrackers = await db
      .select({
        signalId: trackedSignalsTable.signalId,
        entryPolicyVersion: trackedSignalsTable.entryPolicyVersion,
        splitLimitPrice: trackedSignalsTable.splitLimitPrice,
        policyVersion: trackedSignalsTable.policyVersion,
        entryPrice: trackedSignalsTable.entryPrice,
        originalEntryPrice: trackedSignalsTable.originalEntryPrice,
        stopLossPct: trackedSignalsTable.stopLossPct,
        stopLossPrice: trackedSignalsTable.stopLossPrice,
      })
      .from(trackedSignalsTable)
      .where(inArray(trackedSignalsTable.signalId, signalIds));
    for (const tracker of linkedTrackers) {
      if (tracker.signalId == null) continue;
      const policy = resolvePrimarySignalPolicyContext(tracker);
      if (policy) policyBySignalId.set(tracker.signalId, policy);
    }
    for (const signal of signals) {
      if (!policyBySignalId.has(signal.signalId!)) {
        throw new Error(
          `authoritative tracker missing for signal ${signal.signalId}; primary alert skipped`,
        );
      }
    }
  }
  const policyFor = (signal: AlphaResult) =>
    options.policy ??
    (signal.signalId == null
      ? undefined
      : policyBySignalId.get(signal.signalId));

  // A caller with a stable business event key is asking for durable delivery.
  // Do not acknowledge that event from a partial subscriber/channel snapshot.
  const targets = await getTargets({ strict: options.eventKey !== undefined });
  if (targets.length === 0) {
    logger.warn("No Telegram targets to send to");
    return 0;
  }

  // ── Обогащение: персональный стоп/тейки по Liquidation Heatmap ────────────
  // trackSignal() уже вызвал getLiqLevels перед INSERT — результат в кэше (10 мин),
  // повторный вызов здесь бесплатный.
  // Логика: стоп клампируется паттерн-лимитом (getPatternMaxStop).
  // Если heatmap недоступен и у паттерна есть документированный стоп (<10%) — используем его.
  await Promise.all(
    signals.map(async (s) => {
      if (s.liqStopPrice !== undefined) return; // уже обогащён вызывающим кодом
      const patternMax = getPatternMaxStop(s.sentimentKey);
      // Liquidation heatmap removed (owner 2026-10-23): pattern stop only.
      if (patternMax < STOP_LOSS) {
        s.liqStopPrice = s.price > 0 ? s.price * (1 - patternMax / 100) : null;
        s.liqStopPct = patternMax;
        s.liqStopSource = "pattern";
      } else {
        s.liqStopPrice = null;
        s.liqStopPct = null;
        s.liqStopSource = "standard";
      }
      s.liqClusterBelowPct = null;
    }),
  );

  // ── Обогащение: пер-токенный Whale Index (CoinGlass, Binance 4h) ──────────
  // trackSignal() уже тянул его перед INSERT — результат в кэше (10 мин),
  // повторный вызов бесплатный. Fail-open: нет данных → строка не показывается.
  await Promise.all(
    signals.map(async (s) => {
      if (s.tokenWhaleIndex !== undefined) return; // уже обогащён вызывающим кодом
      try {
        s.tokenWhaleIndex = await getTokenWhaleIndex(s.symbol);
      } catch {
        s.tokenWhaleIndex = null;
      }
    }),
  );

  // Толпа (global account ratio, Binance only), кэш 10 мин.
  await Promise.all(
    signals.map(async (s) => {
      if (s.globalLongPct !== undefined) return;
      try {
        s.globalLongPct =
          (await getGlobalAccountRatio(s.symbol))?.longPct ?? null;
      } catch {
        s.globalLongPct = null;
      }
    }),
  );

  // Max pain (heatmap family) removed 2026-10-23.
  for (const s of signals) if (s.maxPain === undefined) s.maxPain = null;

  // ── Обогащение: Spot CVD по ТФ (знак), CoinGlass aggregated ─────────────────
  await Promise.all(
    signals.map(async (s) => {
      if (s.spotCvdTf != null) return;
      try {
        const c = await getSpotCvdMtf(s.symbol);
        s.spotCvdTf = c?.available
          ? { m15: c.cvd15m, m30: c.cvd30m, h1: c.cvd1h, h4: c.cvd4h }
          : null;
      } catch {
        s.spotCvdTf = null;
      }
    }),
  );

  // ── Обогащение: Taker net buy (фьючерсы + спот, CoinGlass aggregated) ───────
  await Promise.all(
    signals.map(async (s) => {
      if (s.futTakerNetBuyPct == null) {
        try {
          const ft = await getTakerFlowCached(s.symbol);
          s.futTakerNetBuyPct = ft?.available ? (ft.netBuyPct ?? null) : null;
        } catch {
          s.futTakerNetBuyPct = null;
        }
      }
      if (s.spotTakerNetBuyPct == null) {
        try {
          const st = await getSpotTakerFlow(s.symbol, 4);
          s.spotTakerNetBuyPct = st?.available ? (st.netBuyPct ?? null) : null;
        } catch {
          s.spotTakerNetBuyPct = null;
        }
      }
    }),
  );

  // ── Обогащение: текущий фандинг рейт (BingX, последний 8ч период) ────────
  // Перезаписываем для ВСЕХ сигналов — текущая ставка актуальнее 7d-накопленной.
  // BingX lastFundingRate — raw decimal (0.0001 = 0.01% за 8ч) → умножаем на 100 для %.
  // Fail-open: если BingX недоступен → fundingRate = null → строка не показывается.
  await Promise.all(
    signals.map(async (s) => {
      try {
        const fr = await getFundingRate(s.symbol);
        if (fr?.lastFundingRate != null) {
          const val = parseFloat(fr.lastFundingRate) * 100; // raw → %
          s.fundingRate = Number.isFinite(val) ? val : null;
        } else {
          s.fundingRate = null;
        }
      } catch {
        /* fail-open — фандинг не критичен */
        s.fundingRate = s.fundingRate ?? null;
      }
    }),
  );

  // ── Обогащение: SNF (Spot NetFlow 1h/4h/24h, CoinGlass batch-кэш) ──────────
  // getSpotNetflowEntry — синхронный in-memory кэш; без API-вызова, без задержки.
  // Fail-open: null → строка не показывается в formatAlphaSignal.
  for (const s of signals) {
    if (s.snf1h !== undefined) continue; // уже обогащён вызывающим кодом
    const snf = getSpotNetflowEntry(s.symbol);
    s.snf1h = snf?.netPct1h ?? null;
    s.snf4h = snf?.netPct4h ?? null;
    s.snf24h = snf?.netPct24h ?? null;
  }

  if (signals.length === 0) return 0;

  // Sort: SUPER ALPHA first, then ALPHA
  const sorted = [...signals].sort((a, b) => {
    if (a.grade === "super_alpha" && b.grade !== "super_alpha") return -1;
    if (b.grade === "super_alpha" && a.grade !== "super_alpha") return 1;
    return 0;
  });

  const superCount = sorted.filter((s) => s.grade === "super_alpha").length;
  const alphaCount = sorted.filter((s) => s.grade === "alpha").length;

  const headerParts: string[] = [];
  if (superCount > 0) headerParts.push(`${superCount} SUPER BULLET`);
  if (alphaCount > 0) headerParts.push(`${alphaCount} BULLET`);
  // Owner 2026-10-23: signal messages carry no "NEW SIGNAL / BULLET DETECTED"
  // title; the message starts with the symbol line.
  const getGradeHeader = (sig: AlphaResult) =>
    telegramHtml`🪙 <b>${sig.symbol.replace("-USDT", "")}</b>`;

  const singleSym = escapeTelegramHtmlText(
    sorted[0]!.symbol.replace("-USDT", ""),
  );
  const singleHeader = `🪙 <b>${singleSym}</b>`;

  const timedBody = (signal: AlphaResult) => {
    const body = formatCompactAlphaSignal(signal, policyFor(signal));
    const detectedAt = detectedById.get(signal.signalId!);
    return detectedAt
      ? withPrimarySignalTiming(body, detectedAt, new Date())
      : body;
  };
  const text =
    signals.length === 1
      ? (() => {
          const signal = sorted[0]!;
          const body = `${singleHeader}\n${formatCompactAlphaSignal(signal, policyFor(signal))}`;
          const detectedAt = detectedById.get(signal.signalId!);
          return detectedAt
            ? withPrimarySignalTiming(body, detectedAt, new Date(), 1_000)
            : body;
        })()
      : sorted.map((s) => `${getGradeHeader(s)}\n${timedBody(s)}`).join("\n\n");

  logger.info(
    { count: signals.length, targets: targets.length },
    "Broadcasting alpha batch alert",
  );

  const patternImg =
    signals.length === 1
      ? PATTERN_SIGNAL_IMGS[sorted[0]!.sentimentKey]
      : undefined;
  if (options.eventKey) {
    try {
      // Dynamic import avoids a module initialization cycle: the durable outbox
      // calls Telegram send APIs only while it drains a persisted delivery row.
      const { enqueueTelegramPhotoBroadcast } =
        await import("./telegram-photo-outbox.js");
      const queued = await enqueueTelegramPhotoBroadcast({
        photoPath: patternImg ?? DEFAULT_SIGNAL_IMG,
        text,
        targets,
        eventKey: options.eventKey,
      });
      logger.info(
        {
          eventKey: options.eventKey,
          symbols: signals.map((signal) => signal.symbol),
          recipients: targets.length,
          queued,
        },
        "Alpha batch alert queued in durable outbox",
      );
      return queued;
    } catch (err) {
      logger.error(
        {
          err,
          eventKey: options.eventKey,
          symbols: signals.map((signal) => signal.symbol),
        },
        "Alpha batch alert could not be queued in durable outbox",
      );
      throw err;
    }
  }
  const targetResults = await _sendPatternAlertToTargets(
    targets,
    async (chatId) => {
      const sent = await _sendPatternAlertToTarget(chatId, patternImg, text);
      if (!sent) {
        logger.warn(
          { chatId, symbols: signals.map((s) => s.symbol) },
          "broadcastBatchAlert: отправка провалилась для таргета",
        );
      }
      return sent;
    },
  );
  const totalSent = targetResults.filter(Boolean).length;

  if (totalSent === 0 && targets.length > 0) {
    logger.error(
      { symbols: signals.map((s) => s.symbol), targets: targets.length },
      "broadcastBatchAlert: ВСЕ ОТПРАВКИ ПРОВАЛИЛИСЬ — TG сообщение не доставлено ни одному таргету",
    );
  }

  return totalSent;
}

/** Broadcast a raw pre-formatted text message to all configured Telegram targets */
export async function broadcastRawAlert(text: string): Promise<void> {
  const targets = await getTargets();
  if (targets.length === 0) {
    logger.warn("broadcastRawAlert: нет получателей");
    return;
  }
  for (const target of targets) {
    try {
      await sendMessageResult(target, text, {
        requireActiveSubscription: true,
      });
      await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      logger.error(
        { err, target },
        "broadcastRawAlert: не удалось отправить сообщение",
      );
    }
  }
}

// Single-signal broadcast wrapper
export async function broadcastSignalAlert(
  signal: Omit<Signal, "id"> | Signal,
  options: { eventKey?: string; policy?: PrimarySignalPolicyContext } = {},
): Promise<number> {
  const data: AlphaResult = {
    symbol: signal.symbol,
    grade: (signal.type === "super_alpha" ? "super_alpha" : "alpha") as
      | "alpha"
      | "super_alpha",
    price: signal.price,
    priceChange30m: signal.priceChangePercent,
    currentVolume: signal.volume24h,
    avgVolume: signal.avgVolume,
    volumeMultiplier: signal.value,
    oiChangePercent: signal.oiChangePercent ?? 0,
    openInterest: signal.openInterest ?? 0,
    cmcRank: null,
    cmcSource: null,
    cmcAvailable: false,
    liquidationsUsd: null,
    liquidationsMultiple: null,
    coinglassAvailable: false,
    sentiment: (signal as any).sentiment ?? "Аномальная активность",
    sentimentKey: (signal as any).sentimentKey ?? "unknown",
    traderAction: "Наблюдение",
    alphaScore: (signal as any).alphaScore ?? 5,
    isContinuing: false,
    cumulativeOiChange: signal.oiChangePercent ?? 0,
    tradingViewUrl: signal.tradingViewUrl,
    bingxUrl: `https://bingx.com/en/trade/${signal.symbol.replace("-", "")}/`,
    signalId: "id" in signal ? signal.id : undefined,
    stealthLevelSource:
      (signal as any).sentimentKey === "stealth_breakout" &&
      signal.broadcastWindowKey?.startsWith("reentry:")
        ? "auto_range_1h"
        : undefined,
    stealthReentry: signal.broadcastWindowKey?.startsWith("reentry:")
      ? true
      : undefined,
  };
  return broadcastBatchAlert([data], options);
}

/**
 * Replays only signals that were durably marked as needing a primary alert.
 * The same signal:<id> event key makes a successful outbox insert idempotent
 * if the acknowledgement write failed just after the queue was created.
 *
 * Reliability guarantees:
 *  • Single-flight (in-process): overlapping timer ticks are collapsed —
 *    the second caller awaits the already-running promise and both receive
 *    the same result without doing double work.
 *  • Cross-worker coordination: a non-blocking `pg_try_advisory_lock` is
 *    acquired on a dedicated pool connection. If another worker already holds
 *    it, the current worker skips this tick and logs at debug level.
 *  • Ambiguous-timeout policy: a timeout error is NOT converted to a
 *    fallback-text delivery.  The signal remains queued (telegramAlertQueued
 *    stays false) and will be retried on the next reconciliation cycle.
 *  • Observability: logs backlog size, duration ms, and recovered count on
 *    every run so dashboards / alerts can track delivery health.
 */
const runReconcilePendingSignalAlerts = async (): Promise<number> => {
  const startedAt = Date.now();
  let lockClient: ReconcileLockClient | null = null;

  // ── Cross-worker advisory lock (non-blocking) ──────────────────────────
  // pg_try_advisory_lock returns immediately: true if acquired, false if
  // another session holds it. The same dedicated connection stays checked
  // out until we explicitly unlock, so the session-level lock is real.
  let lockAcquired = false;
  try {
    lockClient = (await pool.connect()) as ReconcileLockClient;
    const lockResult = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [RECONCILE_ADVISORY_LOCK_KEY],
    );
    lockAcquired = lockResult.rows[0]?.acquired ?? false;
  } catch (lockErr) {
    // If the DB is temporarily unavailable we let this tick through without
    // the cross-worker guard rather than silently dropping the reconcile.
    logger.warn(
      { err: lockErr },
      "reconcilePendingSignalAlerts: advisory lock check failed — proceeding without cross-worker guard",
    );
    lockAcquired = true; // treat as acquired to allow the run
  }

  if (!lockAcquired) {
    logger.debug(
      "reconcilePendingSignalAlerts: skipping tick — advisory lock held by another worker",
    );
    return 0;
  }

  try {
    // ── Fetch backlog ──────────────────────────────────────────────────────
    const pending = await db
      .select()
      .from(signalsTable)
      .where(
        and(
          eq(signalsTable.telegramAlertQueued, false),
          // Never turn a days-old, unqueued signal into a fresh-looking alert.
          // Existing outbox deliveries have a separate bounded retry policy.
          sql`${signalsTable.detectedAt} >= ${new Date(Date.now() - PRIMARY_ALERT_RECOVERY_MAX_AGE_MS)}`,
          // A primary Telegram alert is a trading event, not a raw signals-row
          // notification. Never recover it after its position was neutralized.
          // Never recover it until the durable position exists, either.
          // This closes the race where trackSignal failed and the follow-up
          // telegramAlertQueued=true acknowledgement had not committed yet.
          sql`EXISTS (
            SELECT 1
            FROM tracked_signals ts
            WHERE ts.signal_id = ${signalsTable.id}
              AND ts.status IN ('active', 'in_run')
          )`,
        ),
      )
      .orderBy(asc(signalsTable.detectedAt))
      .limit(50);

    const backlog = pending.length;
    if (backlog === 0) {
      logger.debug(
        { durationMs: Date.now() - startedAt },
        "reconcilePendingSignalAlerts: backlog empty",
      );
      return 0;
    }

    logger.info(
      { backlog },
      "reconcilePendingSignalAlerts: processing backlog",
    );

    let recovered = 0;
    for (const signal of pending) {
      try {
        // The tracker is authoritative for policy: a pending alert may belong
        // to a legacy split position even though its sentiment is still active
        // under the new single-entry policy.
        const linkedTracker = await db
          .select({
            status: trackedSignalsTable.status,
            entryPolicyVersion: trackedSignalsTable.entryPolicyVersion,
            splitLimitPrice: trackedSignalsTable.splitLimitPrice,
            policyVersion: trackedSignalsTable.policyVersion,
            entryPrice: trackedSignalsTable.entryPrice,
            originalEntryPrice: trackedSignalsTable.originalEntryPrice,
            stopLossPct: trackedSignalsTable.stopLossPct,
            stopLossPrice: trackedSignalsTable.stopLossPrice,
          })
          .from(trackedSignalsTable)
          .where(eq(trackedSignalsTable.signalId, signal.id))
          .limit(1);
        // The position can close (or the recovery window can elapse) while
        // the backlog is being processed; recheck just before queueing.
        if (
          !canRecoverPrimaryAlert(
            signal.detectedAt,
            linkedTracker[0]?.status,
            new Date(),
          )
        ) {
          continue;
        }
        const trackerPolicy = resolvePrimarySignalPolicyContext(
          linkedTracker[0],
        );
        if (!trackerPolicy) {
          throw new Error(
            `authoritative tracker missing for signal ${signal.id}; primary alert skipped`,
          );
        }
        await broadcastSignalAlert(signal, {
          eventKey: `signal:${signal.id}`,
          policy: trackerPolicy,
        });
        await db
          .update(signalsTable)
          .set({ telegramAlertQueued: true })
          .where(
            and(
              eq(signalsTable.id, signal.id),
              eq(signalsTable.telegramAlertQueued, false),
            ),
          );
        recovered++;
      } catch (err) {
        // Ambiguous-timeout: do NOT convert to fallback text.
        // Leave telegramAlertQueued=false so the next cycle retries.
        logger.warn(
          { err, signalId: signal.id, symbol: signal.symbol },
          "Primary signal alert remains pending for durable outbox reconciliation",
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    if (recovered > 0) {
      logger.info(
        { recovered, backlog, durationMs },
        "reconcilePendingSignalAlerts: primary signal alerts reconciled",
      );
    } else {
      logger.debug(
        { recovered, backlog, durationMs },
        "reconcilePendingSignalAlerts: run complete, none newly recovered",
      );
    }
    return recovered;
  } finally {
    // Release the session-level advisory lock regardless of outcome.
    if (lockClient) {
      try {
        if (lockAcquired) {
          await lockClient.query("SELECT pg_advisory_unlock($1)", [
            RECONCILE_ADVISORY_LOCK_KEY,
          ]);
        }
      } catch {
        // Releasing the checked-out session is the backstop if unlock fails.
      } finally {
        lockClient.release();
      }
    }
  }
};

export const reconcilePendingSignalAlerts = createSingleFlight(
  runReconcilePendingSignalAlerts,
  () =>
    logger.debug(
      "reconcilePendingSignalAlerts: skipping tick — previous run still in flight",
    ),
);

// ── Whale Accumulation Signal ──────────────────────────────────────────────────

// ── Тексты бота ──────────────────────────────────────────────────────────────

export const WELCOME_TEXT = [
  `🚀 <b>AltBullet — Твой радар в океане крипты</b>`,
  ``,
  `Хватит заходить в монеты, когда они уже «улетели». AltBullet находит следы крупных игроков (Whales) ДО начала основного движения.`,
  ``,
  `📊 <b>Win Rate выше 80%</b> на реальных сигналах.`,
  ``,
  `<b>Что ты получаешь внутри:</b>`,
  ``,
  `✅ <b>5 рабочих паттернов</b> — только те, что прошли проверку на реальных данных.`,
  `✅ <b>Whale Watch</b> — уникальный алгоритм, который видит скрытое накопление китов на споте за дни и недели до движения.`,
  `✅ <b>Анализ реальных денег</b> — Spot CVD, открытый интерес (OI) и ликвидации.`,
  `✅ <b>Умное сопровождение</b> — бот сам ведёт сделку, уведомляет о целях и даёт сигнал на выход, если кит начал разгружаться.`,
  ``,
  `📱 <b>Доступ через Mini App прямо в Telegram</b>`,
  `Регистрация, история сигналов, трекер позиций — всё открывается прямо внутри Telegram. Десктоп не нужен. Нажми кнопку <b>«📱 Открыть AltBullet»</b> ниже.`,
  ``,
  `🌐 Сайт: <a href="${ALT_BULLET_WEBSITE_URL}">${ALT_BULLET_WEBSITE_URL}</a>`,
  ``,
  `💎 <b>Доступ ограничен</b>`,
  `Бот работает в закрытом режиме для сохранения эффективности сигналов.`,
  ``,
  `🆔 <b>Как узнать Chat ID</b>`,
  `Нажми кнопку «Показать Chat ID» в меню бота — бот отправит твой Chat ID.`,
  ``,
  `💰 <b>Подключение — 100 USDT / месяц</b>`,
  `По вопросам оплаты и доступа — @The_Lucy_x`,
  ``,
  `Стань тем, кто покупает у китов, а не об кого они закрываются. Удачной охоты! 🐋🚀`,
].join("\n");

export const WELCOME_PHOTO_CAPTION = [
  `🚀 <b>AltBullet — твой радар в океане крипты</b>`,
  ``,
  `Находим следы крупных игроков ДО начала основного движения.`,
  ``,
  `📊 <b>Win Rate выше 80%</b> на реальных сигналах`,
  `✅ 5 рабочих паттернов`,
  `🐋 Whale Watch и анализ реальных денег`,
  `🤖 Умное сопровождение сделок`,
  ``,
  `📱 Открой Mini App прямо в Telegram кнопкой ниже.`,
  `🌐 Сайт: <a href="${ALT_BULLET_WEBSITE_URL}">${ALT_BULLET_WEBSITE_URL}</a>`,
  `💰 Подключение — <b>100 USDT / месяц</b>`,
  ``,
  `По вопросам оплаты и доступа — @The_Lucy_x`,
].join("\n");

export const PRICES_TEXT = [
  `💎 <b>AltBullet — Тарифы</b>`,
  ``,
  `💰 <b>1 месяц</b> — <b>100 USDT</b>`,
  ``,
  `<b>Что входит:</b>`,
  `• Сигналы 24/7 по 500+ фьючерсным парам`,
  `• 5 рабочих паттернов`,
  `• Win Rate выше 80% на реальных данных`,
  ``,
  `Для оплаты или вопросов — @The_Lucy_x`,
].join("\n");

export const ALREADY_SUBSCRIBED_TEXT = [
  `✅ <b>У тебя уже есть доступ!</b>`,
  ``,
  `Сигналы приходят автоматически. Используй /menu для дайджеста.`,
].join("\n");

interface SubscriptionStatus {
  active: boolean;
  subscribedAt: Date;
  subscribedUntil: Date | null;
}

const SUBSCRIPTION_TIME_ZONE = "Asia/Dubai";

/**
 * Subscription dates can be managed in either the bot-subscriber or dashboard
 * member view. Read them as one logical subscription so Telegram always shows
 * the same end date as the dashboard for a linked Chat ID.
 */
export async function loadSubscriptionStatus(
  chatId: number,
): Promise<SubscriptionStatus | undefined> {
  const [[subscriber], [dashboardUser]] = await Promise.all([
    db
      .select({
        active: subscribersTable.active,
        subscribedAt: subscribersTable.subscribedAt,
        subscribedUntil: subscribersTable.subscribedUntil,
      })
      .from(subscribersTable)
      .where(eq(subscribersTable.chatId, chatId))
      .limit(1),
    db
      .select({
        status: dashboardUsersTable.status,
        createdAt: dashboardUsersTable.createdAt,
        approvedAt: dashboardUsersTable.approvedAt,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.chatId, String(chatId)))
      .limit(1),
  ]);

  if (!subscriber && !dashboardUser) return undefined;

  const dashboardIsActive =
    !dashboardUser || dashboardUser.status === "approved";
  const active =
    (subscriber ? subscriber.active : dashboardUser?.status === "approved") &&
    dashboardIsActive;

  return {
    active,
    subscribedAt:
      subscriber?.subscribedAt ??
      dashboardUser?.approvedAt ??
      dashboardUser!.createdAt,
    subscribedUntil:
      dashboardUser?.subscribedUntil ?? subscriber?.subscribedUntil ?? null,
  };
}

function formatSubscriptionDate(date: Date): string {
  return (
    date.toLocaleString("ru-RU", {
      timeZone: SUBSCRIPTION_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }) + " Дубай"
  );
}

function formatSubscriptionRemaining(until: Date): string {
  const remainingMs = until.getTime() - Date.now();
  if (remainingMs <= 0) return "срок уже истёк";
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  return days > 0 ? `${days} дн. ${hours} ч.` : `${hours} ч.`;
}

export function buildSubscriptionStatusText(
  subscription: SubscriptionStatus | undefined,
): string {
  if (!subscription) {
    return [
      `📅 <b>Статус подписки</b>`,
      ``,
      `Подписка для этого Telegram-аккаунта не найдена.`,
      `По вопросам доступа — @The_Lucy_x`,
    ].join("\n");
  }

  const start = formatSubscriptionDate(subscription.subscribedAt);
  const end = subscription.subscribedUntil
    ? formatSubscriptionDate(subscription.subscribedUntil)
    : "не установлена";
  const expired =
    subscription.subscribedUntil != null &&
    subscription.subscribedUntil.getTime() <= Date.now();
  const active = subscription.active && !expired;

  return [
    `${active ? "✅" : "❌"} <b>Подписка ${active ? "активна" : "неактивна"}</b>`,
    ``,
    `🟢 <b>Начало:</b> ${start}`,
    `🏁 <b>Окончание:</b> ${end}`,
    subscription.subscribedUntil
      ? `⏳ <b>Осталось:</b> ${formatSubscriptionRemaining(subscription.subscribedUntil)}`
      : `⏳ <b>Срок:</b> не ограничен`,
  ].join("\n");
}

export const ACTIVATION_TEXT = [
  `✅ <b>Оплата получена — доступ открыт!</b>`,
  ``,
  `🚀 <b>AltBullet: Полное руководство для подписчиков</b>`,
  ``,
  `Добро пожаловать в AltBullet — профессиональный инструмент для поиска аномальной активности на крипторынке. Этот бот анализирует тысячи данных в секунду, чтобы найти следы «умных денег» (Whales) до того, как монета улетит в космос.`,
  ``,
  `🔍 <b>1. Список паттернов: Что они значат?</b>`,
  ``,
  `🔴 <b>Short Squeeze</b> — Шортисты набились, цена пошла против. Ликвидации толкают цену вверх. Скальп-лонг.`,
  `🟡 <b>Hidden Accumulation</b> — Кит тихо выкупает лимитками, OI растет, цена стоит. Мощное движение через 6–24ч.`,
  `🟠 <b>Bear Trap</b> — Цена падает, заманивая шортов, киты выкупают. Резкий разворот вверх.`,
  `🔥 <b>Aggressive Breakout</b> — Агрессивные покупатели, объём и цена растут одновременно. Вход по рынку.`,
  `🟢 <b>Bullish Accumulation</b> — Устойчивый рост, подтверждённый набором позиций. Удержание по тренду.`,
  `⚡ <b>Sharp Impulse</b> — Взрывная свеча на огромном объёме. Быстрый вход, короткий стоп.`,
  `🐋 <b>Whale Watch</b> — Серия крупных покупок на споте за дни/недели. Инвестиционный лонг.`,
  ``,
  `🛠 <b>2. Как торговать сигналы?</b>`,
  ``,
  `<b>Вход:</b> Никогда не заходите на всю котлету по рынку. Сетка: 30% по текущей / 40% чуть ниже / 30% у стопа.`,
  ``,
  `<b>Сопровождение сигналов в AltBullet (не биржевые ордера):</b>`,
  `• <b>BTC:</b> после пика +1% — стоп в Б/У на цене входа; с пика +2% — трейлинг на 1 п.п. ниже максимума (+2% → стоп +1%, +3% → стоп +2%).`,
  `• <b>Альткоины:</b> пороги защиты и трейлинга зависят от паттерна и указаны в конкретном сигнале.`,
  `• Достигнутые уровни — уведомления о сопровождении, а не подтверждение частичной сделки на бирже.`,
  `• <b>Smart Cancel</b> может предупредить о досрочном выходе, если условия паттерна ухудшились.`,
  ``,
  `📊 <b>3. Ежедневные отчёты (11:00 МСК)</b>`,
  `Sentiment рынка · Top Gainers · Open Positions`,
  ``,
  `<b>Хэштеги для поиска:</b> #in_run · #moonshot · #BTC · #ETH`,
  ``,
  `💡 <b>Важно:</b> Фиксируйте части прибыли на целях. Слушайте Smart Cancel — бот видит выход денег раньше вас. Whale Watch отрабатывает дольше, но приносит максимальный профит.`,
  ``,
  `AltBullet — твой радар в океане крипты. Удачной охоты! 🐋🚀`,
].join("\n");

// ── Вспомогательная функция активации подписчика ─────────────────────────────

export async function activateSubscriber(
  chatId: number,
  username: string | null,
  firstName: string | null,
  lastName: string | null,
): Promise<void> {
  await db
    .insert(subscribersTable)
    .values({
      chatId,
      username,
      firstName,
      lastName,
      active: true,
      subscribedAt: new Date(),
      unsubscribedAt: null,
      botBlockedAt: null,
      botBlockedReason: null,
    })
    .onConflictDoUpdate({
      target: subscribersTable.chatId,
      set: {
        active: true,
        username,
        firstName,
        lastName,
        unsubscribedAt: null,
        botBlockedAt: null,
        botBlockedReason: null,
      },
    });
}
