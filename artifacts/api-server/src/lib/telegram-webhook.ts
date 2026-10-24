import {
  db,
  dashboardUsersTable,
  signalsTable,
  subscribersTable,
  telegramUpdatesTable,
  trackedSignalsTable,
} from "@workspace/db";
import { randomInt, randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  ACTIVATION_TEXT,
  ALREADY_SUBSCRIBED_TEXT,
  PRICES_TEXT,
  SUBSCRIBER_MENU_KEYBOARD,
  SUBSCRIPTION_STATUS_KEYBOARD,
  WELCOME_PHOTO_CAPTION,
  WELCOME_TEXT,
  activateSubscriber,
  answerCallbackQueryResult,
  buildSubscriptionStatusText,
  editMessageTextResult,
  loadSubscriptionStatus,
  sendMessageResult,
  sendMessageWithKeyboardResult,
  sendPhotoByFileId,
  sendPhotoCaptionResult,
  WELCOME_IMG,
  sendSubscriptionRenewedNotification,
  sendSubscriptionStartedNotification,
  type TelegramApiCallResult,
} from "./telegram.js";
import { shouldRetryCallbackAcknowledgement } from "./telegram-api.js";
import {
  checkTelegramCommandAccess,
  canReclaimTelegramUpdate,
  findTelegramCommand,
  getTelegramUpdateId,
  isPublicSetupCommand,
  isTelegramCallback,
  parseTelegramCommand,
  WELCOME_KEYBOARD,
  type TelegramChatType,
  type TelegramInlineKeyboard,
} from "./telegram-inbound.js";
import {
  buildDailyReport,
  buildMonthlyDigest,
  buildWeeklyReport,
} from "./positionsReport.js";
import { logger } from "./logger.js";

interface TelegramActor {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id?: number;
  chat: {
    id: number;
    type?: TelegramChatType;
    username?: string;
  };
  from?: TelegramActor;
  text?: string;
  caption?: string;
  photo?: { file_id: string; width: number; height: number }[];
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramActor;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export type TelegramWebhookResult =
  | { outcome: "processed"; updateId: number }
  | { outcome: "duplicate"; updateId: number }
  | {
      outcome: "permanent_failure";
      updateId: number;
      reason: string;
    }
  | { outcome: "completion_pending"; updateId: number }
  | { outcome: "ignored"; updateId: number | null; reason: string };

export class TelegramDeliveryError extends Error {
  constructor(
    readonly method: string,
    readonly retryable: boolean,
    description?: string,
  ) {
    super(`Telegram ${method} failed${description ? `: ${description}` : ""}`);
    this.name = "TelegramDeliveryError";
  }
}

export class TelegramUpdateInProgressError extends Error {
  constructor(readonly updateId: number) {
    super(`Telegram update ${updateId} is already being processed`);
    this.name = "TelegramUpdateInProgressError";
  }
}

function assertDelivered(method: string, result: TelegramApiCallResult): void {
  if (!result.ok) {
    throw new TelegramDeliveryError(
      method,
      result.retryable,
      result.description,
    );
  }
}

async function reply(
  chatId: number,
  text: string,
  { appendChartLinks = true }: { appendChartLinks?: boolean } = {},
): Promise<void> {
  assertDelivered(
    "sendMessage",
    await sendMessageResult(chatId, text, {
      appendChartLinks,
      requireActiveSubscription: false,
      auditSource: "telegram-webhook.reply",
      auditDeliveryPath: "service-bypass",
    }),
  );
}

async function replyWithKeyboard(
  chatId: number,
  text: string,
  keyboard: TelegramInlineKeyboard,
): Promise<void> {
  assertDelivered(
    "sendMessage",
    await sendMessageWithKeyboardResult(chatId, text, keyboard, {
      auditSource: "telegram-webhook.replyWithKeyboard",
      auditDeliveryPath: "direct",
    }),
  );
}

async function acknowledgeCallback(
  callbackId: string,
  text?: string,
): Promise<void> {
  const result = await answerCallbackQueryResult(callbackId, text);
  if (shouldRetryCallbackAcknowledgement(result)) {
    assertDelivered("answerCallbackQuery", result);
  }
  if (!result.ok) {
    logger.warn(
      {
        callbackId,
        status: result.status,
        description: result.description,
      },
      "Telegram callback acknowledgement expired or was rejected; continuing update processing",
    );
  }
}

async function editOrReply(
  chatId: number,
  messageId: number | undefined,
  text: string,
  keyboard?: TelegramInlineKeyboard,
): Promise<void> {
  if (messageId != null) {
    const edited = await editMessageTextResult(
      chatId,
      messageId,
      text,
      keyboard,
    );
    if (edited.ok) return;
    logger.warn(
      {
        chatId,
        messageId,
        status: edited.status,
        retryable: edited.retryable,
        description: edited.description,
      },
      "Telegram edit failed; sending fallback message",
    );
  }
  if (keyboard) {
    await replyWithKeyboard(chatId, text, keyboard);
  } else {
    await reply(chatId, text);
  }
}

function ownerUserId(): number | null {
  const raw = process.env.OWNER_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
  if (!raw || raw.trim().startsWith("@")) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isOwner(userId: number): boolean {
  return ownerUserId() === userId;
}

async function isActiveSubscriber(userId: number): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM ${dashboardUsersTable}
        WHERE ${dashboardUsersTable.chatId} = ${String(userId)}
      )
      THEN EXISTS (
        SELECT 1
        FROM ${dashboardUsersTable}
        WHERE ${dashboardUsersTable.chatId} = ${String(userId)}
          AND ${dashboardUsersTable.status} = 'approved'
          AND (
            ${dashboardUsersTable.subscribedUntil} IS NULL
            OR ${dashboardUsersTable.subscribedUntil} > NOW()
          )
      )
      ELSE EXISTS (
        SELECT 1
        FROM ${subscribersTable}
        WHERE ${subscribersTable.chatId} = ${userId}
          AND ${subscribersTable.active} = true
          AND (
            ${subscribersTable.subscribedUntil} IS NULL
            OR ${subscribersTable.subscribedUntil} > NOW()
          )
      )
    END AS active
  `);
  return Boolean((result.rows[0] as { active?: boolean } | undefined)?.active);
}

interface TelegramUpdateClaim {
  outcome: "claimed";
  claimToken: string;
}
async function beginUpdate(
  updateId: number,
): Promise<TelegramUpdateClaim | TelegramDuplicateClaim> {
  const claimToken = randomUUID();
  const [inserted] = await db
    .insert(telegramUpdatesTable)
    .values({
      updateId,
      status: "processing",
      claimToken,
      receivedAt: new Date(),
      completedAt: null,
      lastError: null,
    })
    .onConflictDoNothing({ target: telegramUpdatesTable.updateId })
    .returning({ updateId: telegramUpdatesTable.updateId });
  if (inserted) return { outcome: "claimed", claimToken };

  const [existing] = await db
    .select({
      status: telegramUpdatesTable.status,
      receivedAt: telegramUpdatesTable.receivedAt,
    })
    .from(telegramUpdatesTable)
    .where(eq(telegramUpdatesTable.updateId, updateId))
    .limit(1);
  if (
    existing?.status === "completed" ||
    existing?.status === "completion_pending"
  ) {
    return { outcome: "duplicate" };
  }

  const staleBefore = new Date(Date.now() - 5 * 60_000);
  const reclaimable = canReclaimTelegramUpdate(
    existing?.status,
    existing?.receivedAt,
  );
  if (reclaimable) {
    const conditions =
      existing.status === "failed"
        ? and(
            eq(telegramUpdatesTable.updateId, updateId),
            eq(telegramUpdatesTable.status, "failed"),
          )
        : and(
            eq(telegramUpdatesTable.updateId, updateId),
            eq(telegramUpdatesTable.status, "processing"),
            lt(telegramUpdatesTable.receivedAt, staleBefore),
          );
    const [reclaimed] = await db
      .update(telegramUpdatesTable)
      .set({
        status: "processing",
        claimToken,
        receivedAt: new Date(),
        completedAt: null,
        lastError: null,
      })
      .where(conditions)
      .returning({ updateId: telegramUpdatesTable.updateId });
    if (reclaimed) return { outcome: "claimed", claimToken };
  }

  throw new TelegramUpdateInProgressError(updateId);
}

function ownedClaimConditions(
  updateId: number,
  claimToken: string,
  status: "processing" | "completion_pending",
) {
  return and(
    eq(telegramUpdatesTable.updateId, updateId),
    eq(telegramUpdatesTable.claimToken, claimToken),
    eq(telegramUpdatesTable.status, status),
  );
}
async function markUpdateCompleted(
  updateId: number,
  claimToken: string,
): Promise<void> {
  const [updated] = await db
    .update(telegramUpdatesTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      lastError: null,
    })
    .where(ownedClaimConditions(updateId, claimToken, "completion_pending"))
    .returning({ updateId: telegramUpdatesTable.updateId });
  if (!updated) throw new TelegramClaimLostError(updateId);
}
function persistCompletionInBackground(
  updateId: number,
  claimToken: string,
  stopHeartbeat: () => void,
  completionIsDurable: boolean,
): void {
  let attempt = 0;
  let durable = completionIsDurable;
  if (durable) stopHeartbeat();

  const retry = async (): Promise<void> => {
    attempt++;
    try {
      if (!durable) {
        await markUpdateCompletionPending(updateId, claimToken);
        durable = true;
        stopHeartbeat();
      }
      await markUpdateCompleted(updateId, claimToken);
      stopHeartbeat();
      logger.info(
        { updateId, attempts: attempt },
        "Telegram update completion marker repaired",
      );
    } catch (err) {
      if (err instanceof TelegramClaimLostError) {
        stopHeartbeat();
        logger.warn(
          { updateId, claimToken },
          "Stopped Telegram completion repair after claim ownership changed",
        );
        return;
      }
      logger.error(
        { err, updateId, claimToken, attempt, durable },
        "Telegram update completion marker still pending",
      );
      const timer = setTimeout(retry, Math.min(30_000, attempt * 5_000));
      timer.unref();
    }
  };

  const timer = setTimeout(retry, 5_000);
  timer.unref();
}

async function markUpdatePermanentlyFailed(
  updateId: number,
  claimToken: string,
  err: TelegramDeliveryError,
): Promise<void> {
  const [updated] = await db
    .update(telegramUpdatesTable)
    .set({
      status: "completed",
      completedAt: new Date(),
      lastError: err.message.slice(0, 1_000),
    })
    .where(ownedClaimConditions(updateId, claimToken, "processing"))
    .returning({ updateId: telegramUpdatesTable.updateId });
  if (!updated) throw new TelegramClaimLostError(updateId);
}

async function markUpdateFailed(
  updateId: number,
  claimToken: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const [updated] = await db
    .update(telegramUpdatesTable)
    .set({
      status: "failed",
      completedAt: null,
      lastError: message.slice(0, 1_000),
    })
    .where(ownedClaimConditions(updateId, claimToken, "processing"))
    .returning({ updateId: telegramUpdatesTable.updateId });
  if (!updated) throw new TelegramClaimLostError(updateId);
}

async function withCommandFallback(
  command: string,
  chatId: number,
  fallbackText: string,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof TelegramDeliveryError) throw err;
    logger.error({ err, command, chatId }, "Telegram command failed");
    await reply(chatId, fallbackText);
  }
}

async function dispatchCallback(cq: TelegramCallbackQuery): Promise<void> {
  const data = cq.data ?? "";
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const chatType = cq.message?.chat.type ?? "unknown";

  if (!isTelegramCallback(data)) {
    return;
  }

  if (chatId == null) {
    logger.warn({ callbackId: cq.id, data }, "Callback has no source message");
    return;
  }

  if (data === "subscription_status") {
    await withCommandFallback(
      "/subscription callback",
      chatId,
      `❌ Не удалось получить данные подписки. Попробуй позже.`,
      async () => {
        const subscription = await loadSubscriptionStatus(cq.from.id);
        await replyWithKeyboard(
          chatId,
          buildSubscriptionStatusText(subscription),
          SUBSCRIPTION_STATUS_KEYBOARD,
        );
      },
    );
    return;
  }

  // ── Owner: approve or block a pending dashboard user ─────────────────────
  if (data.startsWith("approve_user:") || data.startsWith("block_user:")) {
    if (!isOwner(cq.from.id)) {
      await reply(chatId, "⛔ Только владелец может выполнять это действие.");
      return;
    }
    const colonIdx = data.indexOf(":");
    const userId = Number(data.slice(colonIdx + 1));
    if (!userId || Number.isNaN(userId)) {
      await reply(chatId, "❌ Некорректный идентификатор пользователя.");
      return;
    }
    const newStatus = data.startsWith("approve_user:") ? "approved" : "blocked";
    const oneMonthLater = new Date();
    oneMonthLater.setMonth(oneMonthLater.getMonth() + 1);
    // Read current state before update to determine activation vs renewal
    const [currentUserState] = await db
      .select({
        active: dashboardUsersTable.status,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.id, userId))
      .limit(1);
    const rows = await db
      .update(dashboardUsersTable)
      .set(
        newStatus === "approved"
          ? {
              status: "approved" as const,
              approvedAt: new Date(),
              subscribedUntil: oneMonthLater,
            }
          : { status: "blocked" as const, approvedAt: null },
      )
      .where(eq(dashboardUsersTable.id, userId))
      .returning({
        id: dashboardUsersTable.id,
        email: dashboardUsersTable.email,
        name: dashboardUsersTable.name,
        chatId: dashboardUsersTable.chatId,
      });
    const user = rows[0];
    if (!user) {
      await editOrReply(chatId, messageId, "❌ Пользователь не найден в базе.");
      return;
    }
    if (newStatus === "approved") {
      await editOrReply(
        chatId,
        messageId,
        [
          `✅ <b>${user.name}</b> одобрен`,
          `📧 <code>${user.email}</code>`,
        ].join("\n"),
      );
      if (user.chatId) {
        const prevSubUntil = currentUserState?.subscribedUntil ?? null;
        const now = new Date();
        const prevWasActive =
          currentUserState?.active === "approved" &&
          prevSubUntil != null &&
          prevSubUntil.getTime() > now.getTime();
        if (prevWasActive) {
          // Subscription extended while still active — send renewal notification
          void sendSubscriptionRenewedNotification(
            Number(user.chatId),
            oneMonthLater,
          ).catch(() => {});
        } else {
          // New activation or restoration — send full welcome notification
          void sendSubscriptionStartedNotification(
            Number(user.chatId),
            oneMonthLater,
          ).catch(() => {});
        }
      }
    } else {
      await editOrReply(
        chatId,
        messageId,
        [
          `❌ <b>${user.name}</b> заблокирован`,
          `📧 <code>${user.email}</code>`,
        ].join("\n"),
      );
    }
    logger.info(
      { userId, newStatus, executor: cq.from.id },
      "Dashboard user status changed via Telegram",
    );
    return;
  }

  if (chatType !== "private") {
    if (chatId != null) {
      await reply(
        chatId,
        `🔒 Управление подпиской доступно только в личном чате с ботом.`,
      );
    }
    return;
  }

  const actorIsOwner = isOwner(cq.from.id);
  const actorIsSubscriber =
    actorIsOwner || (await isActiveSubscriber(cq.from.id));
  const unsubscribeDefinition = findTelegramCommand("/unsubscribe");
  if (!unsubscribeDefinition) {
    throw new Error("Unsubscribe command definition is missing");
  }
  const access = checkTelegramCommandAccess(unsubscribeDefinition, {
    isOwner: actorIsOwner,
    isSubscriber: actorIsSubscriber,
    chatType,
  });
  if (!access.allowed) {
    await reply(
      chatId,
      access.reason === "private_chat"
        ? `🔒 Управление подпиской доступно только в личном чате с ботом.`
        : WELCOME_TEXT,
    );
    return;
  }

  if (data === "unsubscribe_confirm") {
    await editOrReply(
      chatId,
      messageId,
      [
        `❓ <b>Точно хочешь отписаться?</b>`,
        ``,
        `Сигналы перестанут приходить. Снова подключиться — через /start.`,
      ].join("\n"),
      [
        [
          { text: "✅ Да, отписаться", callback_data: "unsubscribe_yes" },
          { text: "❌ Нет, остаться", callback_data: "unsubscribe_no" },
        ],
      ],
    );
    return;
  }

  if (data === "unsubscribe_yes") {
    await db
      .update(subscribersTable)
      .set({ active: false, unsubscribedAt: new Date() })
      .where(eq(subscribersTable.chatId, cq.from.id));
    await editOrReply(
      chatId,
      messageId,
      [
        `❌ <b>Подписка отменена.</b>`,
        ``,
        `Сигналы больше не будут приходить.`,
        `Напиши /start, чтобы узнать об условиях подключения снова.`,
      ].join("\n"),
    );
    logger.info(
      { userId: cq.from.id },
      "Subscriber unsubscribed via inline button",
    );
    return;
  }

  await editOrReply(chatId, messageId, ALREADY_SUBSCRIBED_TEXT, [
    [{ text: "❌ Отписаться", callback_data: "unsubscribe_confirm" }],
  ]);
}

async function acknowledgeCallbackBeforeClaim(
  callback: TelegramCallbackQuery,
): Promise<void> {
  const data = callback.data ?? "";
  const chatType = callback.message?.chat.type ?? "unknown";
  const isPrivateOnlyCallback =
    data === "unsubscribe_confirm" ||
    data === "unsubscribe_yes" ||
    data === "unsubscribe_no";
  const text = !isTelegramCallback(data)
    ? "Эта кнопка больше не поддерживается."
    : isPrivateOnlyCallback && chatType !== "private"
      ? "Открой бота в личном чате."
      : "Обрабатываю…";
  await acknowledgeCallback(callback.id, text);
}

async function broadcastOwnerPhoto(
  message: TelegramMessage,
  chatId: number,
): Promise<void> {
  const largestPhoto = message.photo?.at(-1);
  if (!largestPhoto) return;
  const caption = message.caption ?? "";
  const subscribers = await db
    .select({ chatId: subscribersTable.chatId })
    .from(subscribersTable)
    .where(eq(subscribersTable.active, true));
  let sent = 0;
  for (const subscriber of subscribers) {
    const photoSent = await sendPhotoByFileId(
      subscriber.chatId,
      largestPhoto.file_id,
      caption,
      { requireActiveSubscription: true },
    );
    if (photoSent) {
      sent++;
    } else if (caption) {
      const fallback = await sendMessageResult(subscriber.chatId, caption, {
        requireActiveSubscription: true,
      });
      if (fallback.ok) sent++;
    }
  }
  await reply(
    chatId,
    `✅ Фото отправлено ${sent} подписчикам${caption ? ` с подписью: "${caption.slice(0, 60)}"` : ""}.`,
  );
}

async function handleAddSignal(chatId: number, args: string[]): Promise<void> {
  if (args.length < 3) {
    await reply(
      chatId,
      [
        `📥 <b>/addsignal — ручной импорт сигнала</b>`,
        ``,
        `<b>Формат:</b> <code>/addsignal SYMBOL PRICE STATUS</code>`,
        `<b>STATUS:</b> active | in_run`,
      ].join("\n"),
    );
    return;
  }

  let symbol = args[0].toUpperCase();
  if (!symbol.endsWith("-USDT")) symbol = `${symbol}-USDT`;
  const price = Number(args[1]);
  const status = args[2].toLowerCase() as "active" | "in_run";
  if (!Number.isFinite(price) || price <= 0) {
    await reply(
      chatId,
      `❌ Неверная цена: <code>${args[1]}</code>\nОжидается число > 0.`,
    );
    return;
  }
  if (!["active", "in_run"].includes(status)) {
    await reply(
      chatId,
      `❌ Неверный статус: <code>${args[2]}</code>\nДоступные: active | in_run`,
    );
    return;
  }

  const allOpen = await db
    .select()
    .from(trackedSignalsTable)
    .where(inArray(trackedSignalsTable.status, ["active", "in_run"]));
  const existing = allOpen.find((row) => row.symbol === symbol);
  if (existing) {
    await reply(
      chatId,
      [
        `⚠️ <b>${symbol}</b> уже отслеживается`,
        ``,
        `ID: ${existing.id} | Статус: <b>${existing.status}</b> | Вход: $${existing.entryPrice}`,
        `Создан: ${existing.detectedAt.toLocaleDateString("ru-RU")}`,
      ].join("\n"),
    );
    return;
  }

  const tvSymbol = symbol.replace("-", "");
  const [signal] = await db
    .insert(signalsTable)
    .values({
      symbol,
      type: "alpha",
      value: 0,
      threshold: 0,
      price,
      priceChangePercent: 0,
      volume24h: 0,
      avgVolume: 0,
      tradingViewUrl: `https://www.tradingview.com/chart/?symbol=BINGX:${tvSymbol}`,
      sentiment: "manual",
      sentimentKey: "manual_import",
    })
    .returning();
  const [tracked] = await db
    .insert(trackedSignalsTable)
    .values({
      symbol,
      signalId: signal.id,
      signalType: "alpha",
      sentimentKey: "manual_import",
      entryPrice: price,
      peakPrice: price,
      status,
    })
    .returning();
  await reply(
    chatId,
    [
      `✅ <b>Сигнал добавлен в базу</b>`,
      ``,
      `<b>${symbol}</b> | Вход: <b>$${price}</b> | Статус: <b>${status}</b>`,
      `signal_id: <code>${signal.id}</code> | tracked_id: <code>${tracked.id}</code>`,
      ``,
      `Вотчер подхватит позицию в следующем цикле (~2 мин).`,
    ].join("\n"),
  );
}

async function dispatchMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id ?? chatId;
  const actorIsOwner = isOwner(userId);
  const parsed = parseTelegramCommand(message.text);

  if (!parsed) {
    if (message.photo?.length && actorIsOwner) {
      await withCommandFallback(
        "owner_photo",
        chatId,
        `❌ Не удалось разослать фото. Попробуй позже.`,
        () => broadcastOwnerPhoto(message, chatId),
      );
    }
    return;
  }

  const definition = findTelegramCommand(parsed.command);
  if (!definition) {
    await reply(
      chatId,
      `❓ Команда не поддерживается. Используй /menu, чтобы увидеть доступные команды.`,
    );
    return;
  }

  // Public setup commands deliberately complete without any subscription query.
  if (definition.command === "/myid") {
    // protect_content отключён — пользователь должен иметь возможность скопировать Chat ID
    assertDelivered(
      "sendMessage",
      await sendMessageResult(
        chatId,
        [
          `🆔 <b>Твой Telegram Chat ID:</b> <code>${chatId}</code>`,
          `👤 <b>User ID:</b> <code>${userId}</code>`,
          ``,
          `Передай Chat ID администратору для привязки dashboard-аккаунта.`,
        ].join("\n"),
        {
          requireActiveSubscription: false,
          auditSource: "telegram-webhook./myid",
          auditDeliveryPath: "service-bypass",
        },
      ),
    );
    return;
  }
  if (definition.command === "/start") {
    assertDelivered(
      "sendPhoto",
      await sendPhotoCaptionResult(
        chatId,
        WELCOME_IMG,
        WELCOME_PHOTO_CAPTION,
        WELCOME_KEYBOARD,
        {
          requireActiveSubscription: false,
          auditSource: "telegram-webhook./start",
          auditDeliveryPath: "service-bypass",
        },
      ),
    );
    return;
  }
  if (definition.command === "/prices") {
    await reply(chatId, PRICES_TEXT);
    return;
  }

  if (definition.command === "/resetpassword") {
    if (message.chat.type !== "private") {
      await reply(
        chatId,
        `🔒 Используй эту команду только в личном чате с ботом.`,
      );
      return;
    }
    await withCommandFallback(
      "/resetpassword",
      chatId,
      `❌ Не удалось создать код сброса пароля. Попробуй ещё раз позже.`,
      async () => {
        const users = await db
          .select({
            id: dashboardUsersTable.id,
            email: dashboardUsersTable.email,
          })
          .from(dashboardUsersTable)
          .where(eq(dashboardUsersTable.chatId, String(chatId)))
          .limit(1);
        if (!users[0]) {
          await reply(
            chatId,
            [
              `❌ Аккаунт с этим Telegram Chat ID не найден.`,
              ``,
              `Зарегистрируйся на сайте и привяжи свой Chat ID.`,
            ].join("\n"),
          );
          return;
        }
        const user = users[0];
        const code = String(randomInt(100000, 999999));
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        // Удаляем старые коды, вставляем новый
        await db.execute(
          sql`DELETE FROM dashboard_password_resets WHERE user_id = ${user.id}`,
        );
        await db.execute(
          sql`INSERT INTO dashboard_password_resets (user_id, code, expires_at)
              VALUES (${user.id}, ${code}, ${expiresAt}::timestamp)`,
        );
        await reply(
          chatId,
          [
            `🔑 <b>Код сброса пароля:</b> <code>${code}</code>`,
            ``,
            `⏱ Действителен 15 минут.`,
            ``,
            `Перейди на сайт → страница входа → <b>«Забыли пароль?»</b> и введи email, этот код и новый пароль.`,
          ].join("\n"),
        );
      },
    );
    return;
  }

  const actorIsSubscriber =
    definition.access === "subscriber" && !actorIsOwner
      ? await isActiveSubscriber(userId)
      : false;
  const access = checkTelegramCommandAccess(definition, {
    isOwner: actorIsOwner,
    isSubscriber: actorIsSubscriber,
    chatType: message.chat.type ?? "unknown",
  });
  if (!access.allowed) {
    if (access.reason === "private_chat") {
      await reply(
        chatId,
        `🔒 Эта команда изменяет подписку и доступна только в личном чате с ботом.`,
      );
    } else if (access.reason === "owner") {
      await reply(chatId, `❌ Команда доступна только владельцу бота.`);
    } else {
      await reply(chatId, WELCOME_TEXT);
    }
    return;
  }

  switch (definition.command) {
    case "/menu":
      await replyWithKeyboard(
        chatId,
        [
          `📋 <b>Доступные команды</b>`,
          ``,
          `/daily — Дневной отчёт`,
          `/weekly — Недельный отчёт`,
          `/monthly — Месячный дайджест`,
          `/subscription — Начало и окончание подписки`,
          `/prices — Тарифы`,
          `/unsubscribe — Отписаться`,
        ].join("\n"),
        SUBSCRIBER_MENU_KEYBOARD,
      );
      return;
    case "/subscription":
      await withCommandFallback(
        "/subscription",
        chatId,
        `❌ Не удалось получить данные подписки. Попробуй позже.`,
        async () => {
          const subscription = await loadSubscriptionStatus(userId);
          await replyWithKeyboard(
            chatId,
            buildSubscriptionStatusText(subscription),
            SUBSCRIPTION_STATUS_KEYBOARD,
          );
        },
      );
      return;
    case "/unsubscribe":
      await replyWithKeyboard(
        chatId,
        [
          `❓ <b>Точно хочешь отписаться?</b>`,
          ``,
          `Сигналы перестанут приходить. Снова подключиться — через /start.`,
        ].join("\n"),
        [
          [
            { text: "✅ Да, отписаться", callback_data: "unsubscribe_yes" },
            { text: "❌ Нет, остаться", callback_data: "unsubscribe_no" },
          ],
        ],
      );
      return;
    case "/daily":
      await reply(chatId, `📊 Формирую дневной отчёт...`);
      await withCommandFallback(
        "/daily",
        chatId,
        `❌ Ошибка при формировании отчёта. Попробуй позже.`,
        async () =>
          reply(chatId, await buildDailyReport(), { appendChartLinks: false }),
      );
      return;
    case "/weekly":
      await reply(chatId, `📊 Формирую недельный отчёт...`);
      await withCommandFallback(
        "/weekly",
        chatId,
        `❌ Ошибка при формировании отчёта. Попробуй позже.`,
        async () =>
          reply(chatId, await buildWeeklyReport(), {
            appendChartLinks: false,
          }),
      );
      return;
    case "/monthly":
      await reply(chatId, `📊 Формирую месячный дайджест...`);
      await withCommandFallback(
        "/monthly",
        chatId,
        `❌ Ошибка при формировании дайджеста. Попробуй позже.`,
        async () =>
          reply(chatId, await buildMonthlyDigest(), {
            appendChartLinks: false,
          }),
      );
      return;
    case "/activate_test":
      await withCommandFallback(
        "/activate_test",
        chatId,
        `❌ Ошибка активации. Попробуй позже.`,
        async () => {
          await activateSubscriber(
            userId,
            message.from?.username ?? null,
            message.from?.first_name ?? null,
            message.from?.last_name ?? null,
          );
          await reply(chatId, ACTIVATION_TEXT);
        },
      );
      return;
    case "/addsub":
      await withCommandFallback(
        "/addsub",
        chatId,
        `❌ Ошибка добавления подписчика. Попробуй позже.`,
        async () => {
          const targetId = Number(parsed.args[0]);
          if (!parsed.args[0] || !Number.isFinite(targetId) || targetId === 0) {
            await reply(
              chatId,
              `❌ Использование: /addsub &lt;chat_id&gt; [username] [firstname]`,
            );
            return;
          }
          const username = parsed.args[1]?.replace(/^@/, "") ?? null;
          const firstName = parsed.args[2] ?? null;
          await activateSubscriber(targetId, username, firstName, null);
          await reply(
            chatId,
            `✅ Подписчик <code>${targetId}</code>${username ? ` (@${username})` : ""} добавлен в базу.`,
          );
        },
      );
      return;
    case "/removesub":
      await withCommandFallback(
        "/removesub",
        chatId,
        `❌ Ошибка удаления подписчика. Попробуй позже.`,
        async () => {
          const targetId = Number(parsed.args[0]);
          if (!parsed.args[0] || !Number.isFinite(targetId) || targetId === 0) {
            await reply(chatId, `❌ Использование: /removesub &lt;chat_id&gt;`);
            return;
          }
          await db
            .update(subscribersTable)
            .set({ active: false, unsubscribedAt: new Date() })
            .where(eq(subscribersTable.chatId, targetId));
          await reply(
            chatId,
            `✅ Подписчик <code>${targetId}</code> деактивирован.`,
          );
        },
      );
      return;
    case "/listsubs":
      await withCommandFallback(
        "/listsubs",
        chatId,
        `❌ Ошибка загрузки подписчиков. Попробуй позже.`,
        async () => {
          const subscribers = await db
            .select()
            .from(subscribersTable)
            .where(eq(subscribersTable.active, true));
          const text =
            subscribers.length === 0
              ? `📋 Активных подписчиков нет.`
              : `📋 <b>Активные подписчики (${subscribers.length}):</b>\n\n${subscribers
                  .map(
                    (subscriber) =>
                      `• <code>${subscriber.chatId}</code>${subscriber.username ? ` @${subscriber.username}` : ""}${subscriber.firstName ? ` ${subscriber.firstName}` : ""}`,
                  )
                  .join("\n")}`;
          await reply(chatId, text);
        },
      );
      return;
    case "/addsignal":
      await withCommandFallback(
        "/addsignal",
        chatId,
        `❌ Ошибка при добавлении сигнала. Детали в логах сервера.`,
        () => handleAddSignal(chatId, parsed.args),
      );
      return;
  }
}

async function dispatchUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await dispatchCallback(update.callback_query);
    return;
  }
  const message = update.message ?? update.channel_post;
  if (message) await dispatchMessage(message);
}

const completedBootstrapUpdates = new Map<number, number>();

function rememberBootstrapUpdate(updateId: number): void {
  completedBootstrapUpdates.set(updateId, Date.now());
  if (completedBootstrapUpdates.size <= 5_000) return;
  const oldest = completedBootstrapUpdates.keys().next().value as
    | number
    | undefined;
  if (oldest != null) completedBootstrapUpdates.delete(oldest);
}

function startUpdateHeartbeat(
  updateId: number,
  claimToken: string,
): () => void {
  const timer = setInterval(() => {
    void db
      .update(telegramUpdatesTable)
      .set({ receivedAt: new Date() })
      .where(
        and(
          eq(telegramUpdatesTable.updateId, updateId),
          eq(telegramUpdatesTable.claimToken, claimToken),
          eq(telegramUpdatesTable.status, "processing"),
        ),
      )
      .catch((err) => {
        logger.warn({ err, updateId }, "Telegram update heartbeat failed");
      });
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function handleTelegramWebhookUpdate(
  rawUpdate: unknown,
): Promise<TelegramWebhookResult> {
  const update = rawUpdate as TelegramUpdate;
  const updateId = getTelegramUpdateId(rawUpdate);
  if (updateId == null) {
    logger.warn("Ignoring malformed Telegram update without update_id");
    return {
      outcome: "ignored",
      updateId: null,
      reason: "missing_update_id",
    };
  }

  if (update.callback_query) {
    try {
      // Stop Telegram's button spinner before any database claim or lookup.
      await acknowledgeCallbackBeforeClaim(update.callback_query);
    } catch (err) {
      logger.error(
        { err, updateId },
        "Telegram callback acknowledgement failed",
      );
      if (err instanceof TelegramDeliveryError && !err.retryable) {
        return {
          outcome: "permanent_failure",
          updateId,
          reason: err.message,
        };
      }
      throw err;
    }
  }

  const bootstrapMessage = update.message ?? update.channel_post;
  if (bootstrapMessage && isPublicSetupCommand(bootstrapMessage.text)) {
    if (completedBootstrapUpdates.has(updateId)) {
      return { outcome: "duplicate", updateId };
    }
    try {
      await dispatchMessage(bootstrapMessage);
      rememberBootstrapUpdate(updateId);
      return { outcome: "processed", updateId };
    } catch (err) {
      logger.error({ err, updateId }, "Telegram bootstrap command failed");
      if (err instanceof TelegramDeliveryError && !err.retryable) {
        return {
          outcome: "permanent_failure",
          updateId,
          reason: err.message,
        };
      }
      throw err;
    }
  }

  const claim = await beginUpdate(updateId);
  if (claim.outcome === "duplicate") {
    logger.info({ updateId }, "Telegram update already completed");
    return { outcome: "duplicate", updateId };
  }

  const { claimToken } = claim;
  const stopHeartbeat = startUpdateHeartbeat(updateId, claimToken);
  let heartbeatOwnedByRequest = true;
  let dispatchCompleted = false;
  try {
    await dispatchUpdate(update);
    dispatchCompleted = true;
    await markUpdateCompletionPending(updateId, claimToken);
    try {
      await markUpdateCompleted(updateId, claimToken);
    } catch (err) {
      logger.error(
        { err, updateId, claimToken },
        "Telegram completion is durable but final status update failed",
      );
      heartbeatOwnedByRequest = false;
      persistCompletionInBackground(updateId, claimToken, stopHeartbeat, true);
      return { outcome: "completion_pending", updateId };
    }
    return { outcome: "processed", updateId };
  } catch (err) {
    logger.error({ err, updateId }, "Telegram webhook processing failed");
    if (err instanceof TelegramDeliveryError && !err.retryable) {
      await markUpdatePermanentlyFailed(updateId, claimToken, err);
      return {
        outcome: "permanent_failure",
        updateId,
        reason: err.message,
      };
    }
    if (dispatchCompleted) {
      logger.error(
        { updateId },
        "Telegram update completed but completion marker failed; repairing asynchronously",
      );
      heartbeatOwnedByRequest = false;
      persistCompletionInBackground(updateId, claimToken, stopHeartbeat, false);
      return { outcome: "completion_pending", updateId };
    }
    try {
      await markUpdateFailed(updateId, claimToken, err);
    } catch (markErr) {
      logger.error(
        { err: markErr, updateId },
        "Failed to persist Telegram update failure",
      );
    }
    throw err;
  } finally {
    if (heartbeatOwnedByRequest) stopHeartbeat();
  }
}

interface TelegramDuplicateClaim {
  outcome: "duplicate";
}

async function markUpdateCompletionPending(
  updateId: number,
  claimToken: string,
): Promise<void> {
  const [updated] = await db
    .update(telegramUpdatesTable)
    .set({
      status: "completion_pending",
      lastError: null,
    })
    .where(ownedClaimConditions(updateId, claimToken, "processing"))
    .returning({ updateId: telegramUpdatesTable.updateId });
  if (!updated) throw new TelegramClaimLostError(updateId);
}

class TelegramClaimLostError extends Error {
  constructor(readonly updateId: number) {
    super(`Telegram update ${updateId} claim is no longer owned`);
    this.name = "TelegramClaimLostError";
  }
}
