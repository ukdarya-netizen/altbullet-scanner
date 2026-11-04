import { Router } from "express";
import { db } from "@workspace/db";
import { dashboardUsersTable, subscribersTable } from "@workspace/db";
import { and, eq, asc, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  canResubmitExpiredDashboardAccount,
  getDashboardAccessStatus,
  shouldRestoreExpiredDashboardAccount,
} from "../lib/dashboard-access-policy.js";
import type { DashboardAccessStatus } from "../lib/dashboard-access-policy.js";
import {
  getDashboardLinkedBotAccessStatus,
  getMemberAccessStatus,
  getMemberBotAccessStatus,
} from "../lib/member-access-status.js";
import {
  shouldNotifySubscriptionStarted,
  shouldNotifySubscriptionRenewed,
} from "../lib/subscription-start-notification.js";
import {
  dispatchPasswordResetNotification,
  parseChatId,
} from "../lib/password-reset-notification.js";
import { validateNewPassword } from "../lib/admin-user-validation.js";
import {
  requireAuthenticatedDashboardAccess,
  requireDashboardAccess,
} from "../middleware/dashboardAccess.js";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "dev-fallback-secret";
const ADMIN_PIN = process.env["ADMIN_DASHBOARD_PIN"] ?? "";
const OWNER_CHAT_ID = Number(
  process.env["OWNER_CHAT_ID"] ?? process.env["TELEGRAM_CHAT_ID"] ?? "0",
);
const OWNER_EMAIL = (process.env["OWNER_EMAIL"] ?? "").toLowerCase().trim();

function signUserToken(
  userId: number,
  email: string,
  name: string,
  role: "owner" | "user",
): string {
  return jwt.sign({ userId, email, name, role }, JWT_SECRET, {
    expiresIn: "7d",
  });
}

function signAdminToken(): string {
  return jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "8h" });
}

function verifyAdminToken(token: string): boolean {
  try {
    const p = jwt.verify(token, JWT_SECRET) as { admin?: boolean };
    return p.admin === true;
  } catch {
    return false;
  }
}

function requireAdmin(req: any, res: any, next: any) {
  const h = req.headers.authorization as string | undefined;
  if (!h?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }
  const token = h.slice(7);
  // Accept PIN-based admin token (legacy)
  if (verifyAdminToken(token)) return next();
  // Accept dashboard JWT with role=owner
  try {
    const p = jwt.verify(token, JWT_SECRET) as { role?: string };
    if (p.role === "owner") return next();
  } catch {
    // invalid/expired JWT
  }
  return res.status(401).json({ error: "Требуется авторизация" });
}

function toTelegramChatId(chatId: string | null): number | null {
  if (!chatId) return null;
  const parsed = Number(chatId);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function queuePasswordResetNotification(
  req: { log: { warn: (obj: object, message: string) => void } },
  chatId: string | null,
): void {
  const telegramChatId = parseChatId(chatId);
  if (!telegramChatId) return;

  void import("../lib/telegram.js")
    .then(({ sendMessage }) =>
      dispatchPasswordResetNotification(
        (target, text) =>
          sendMessage(target, text, {
            requireActiveSubscription: false,
            auditSource: "auth.queuePasswordResetNotification",
            auditDeliveryPath: "service-bypass",
          }),
        chatId,
      ),
    )
    .then((delivered) => {
      if (!delivered) {
        req.log.warn(
          { chatId: telegramChatId },
          "Password reset notification was not delivered",
        );
      }
    })
    .catch((err) =>
      req.log.warn(
        { err, chatId: telegramChatId },
        "Password reset notification failed unexpectedly",
      ),
    );
}

function queueBlockedNotification(
  req: { log: { warn: (obj: object, message: string) => void } },
  chatId: string | null,
): void {
  const telegramChatId = toTelegramChatId(chatId);
  if (!telegramChatId) return;

  void import("../lib/telegram.js")
    .then(({ sendBlockedNotification }) =>
      sendBlockedNotification(telegramChatId),
    )
    .catch((err) =>
      req.log.warn(
        { err, chatId: telegramChatId },
        "Block notification failed",
      ),
    );
}

function queueSubscriptionRenewedNotification(
  req: { log: { warn: (obj: object, message: string) => void } },
  chatId: string | null,
  subscriptionEnd: Date | null = null,
): void {
  const telegramChatId = toTelegramChatId(chatId);
  if (!telegramChatId) return;

  void import("../lib/telegram.js")
    .then(({ sendSubscriptionRenewedNotification }) =>
      sendSubscriptionRenewedNotification(telegramChatId, subscriptionEnd),
    )
    .then((result) => {
      if (!result.ok) {
        req.log.warn(
          {
            chatId: telegramChatId,
            status: result.status,
            description: result.description,
          },
          "Subscription renewal notification was not delivered",
        );
      }
    })
    .catch((err) =>
      req.log.warn(
        { err, chatId: telegramChatId },
        "Subscription renewal notification failed unexpectedly",
      ),
    );
}

function queueDeactivatedNotification(
  req: { log: { warn: (obj: object, message: string) => void } },
  chatId: string | null,
): void {
  const telegramChatId = toTelegramChatId(chatId);
  if (!telegramChatId) return;

  void import("../lib/telegram.js")
    .then(({ sendDeactivatedNotification }) =>
      sendDeactivatedNotification(telegramChatId),
    )
    .catch((err) =>
      req.log.warn(
        { err, chatId: telegramChatId },
        "Deactivate notification failed",
      ),
    );
}

function queueSubscriptionStartNotification(
  req: { log: { warn: (obj: object, message: string) => void } },
  chatId: string | null,
  subscriptionEnd: Date | null = null,
): void {
  const telegramChatId = toTelegramChatId(chatId);
  if (!telegramChatId) return;

  void import("../lib/telegram.js")
    .then(({ sendSubscriptionStartedNotification }) =>
      sendSubscriptionStartedNotification(telegramChatId, subscriptionEnd),
    )
    .then((result) => {
      if (!result.ok) {
        req.log.warn(
          {
            chatId: telegramChatId,
            status: result.status,
            description: result.description,
          },
          "Subscription start notification was not delivered",
        );
      }
    })
    .catch((err) =>
      req.log.warn(
        { err, chatId: telegramChatId },
        "Subscription start notification failed unexpectedly",
      ),
    );
}

async function syncDashboardUserToSubscriber(
  chatId: string | null,
  {
    subscribedUntil,
    status,
  }: {
    subscribedUntil?: Date | null;
    status?: "approved" | "blocked" | "pending" | "expired";
  },
): Promise<void> {
  const telegramChatId = toTelegramChatId(chatId);
  if (!telegramChatId) return;

  const update: {
    subscribedUntil?: Date | null;
    active?: boolean;
    unsubscribedAt?: Date | null;
  } = {};
  if (subscribedUntil !== undefined) update.subscribedUntil = subscribedUntil;
  if (status !== undefined) {
    update.active = status === "approved";
    update.unsubscribedAt = status === "approved" ? null : new Date();
  }
  if (Object.keys(update).length === 0) return;

  await db
    .update(subscribersTable)
    .set(update)
    .where(eq(subscribersTable.chatId, telegramChatId));
}

// POST /api/auth/register
router.post("/auth/register", async (req, res) => {
  try {
    const { email, password, name, chatId, telegramUsername } =
      req.body as Record<string, string>;
    if (!email || !password || !name || !chatId) {
      return res.status(400).json({ error: "Заполните все обязательные поля" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Пароль: минимум 6 символов" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedChatId = chatId.trim();
    const normalizedUsername = telegramUsername
      ? telegramUsername.trim().replace(/^@/, "")
      : null;
    const isOwner = OWNER_EMAIL !== "" && normalizedEmail === OWNER_EMAIL;

    // Check email uniqueness
    const existing = await db
      .select({
        id: dashboardUsersTable.id,
        status: dashboardUsersTable.status,
        chatId: dashboardUsersTable.chatId,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.email, normalizedEmail))
      .limit(1);

    const existingUser = existing[0];
    const canResubmitExpiredAccount =
      existingUser != null &&
      canResubmitExpiredDashboardAccount({
        isOwner,
        status: existingUser.status,
        subscribedUntil: existingUser.subscribedUntil,
        now: new Date(),
      });
    const canResubmitBlockedAccount =
      existingUser != null && existingUser.status === "blocked";

    if (existingUser) {
      if (!canResubmitExpiredAccount && !canResubmitBlockedAccount) {
        return res
          .status(409)
          .json({ error: "Этот email уже зарегистрирован" });
      }
    }

    // Check chatId uniqueness
    const existingChatId = await db
      .select({ id: dashboardUsersTable.id })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.chatId, normalizedChatId))
      .limit(1);

    if (
      existingChatId.length > 0 &&
      existingChatId[0].id !== existingUser?.id
    ) {
      return res
        .status(409)
        .json({ error: "Этот Telegram Chat ID уже зарегистрирован" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    if (
      existingUser &&
      (canResubmitExpiredAccount || canResubmitBlockedAccount)
    ) {
      await db
        .update(dashboardUsersTable)
        .set({
          passwordHash,
          name: name.trim(),
          chatId: normalizedChatId,
          telegramUsername: normalizedUsername,
          status: "pending",
          approvedAt: null,
        })
        .where(eq(dashboardUsersTable.id, existingUser.id));
      await syncDashboardUserToSubscriber(normalizedChatId, {
        status: "pending",
      });

      if (!isOwner && OWNER_CHAT_ID) {
        const { sendMessage } = await import("../lib/telegram.js");
        const tgLine = normalizedUsername
          ? `@${normalizedUsername} · ID: <code>${normalizedChatId}</code>`
          : `ID: <code>${normalizedChatId}</code>`;
        const reason = canResubmitBlockedAccount
          ? `Аккаунт был заблокирован — пользователь повторно запросил доступ: Dashboard → Пользователи`
          : `Подписка истекла — проверь и одобри повторный доступ: Dashboard → Пользователи`;
        await sendMessage(
          OWNER_CHAT_ID,
          [
            `🔐 <b>Повторный запрос доступа к Dashboard</b>`,
            ``,
            `👤 <b>${name.trim()}</b>`,
            `📧 <code>${normalizedEmail}</code>`,
            `💬 ${tgLine}`,
            ``,
            reason,
          ].join("\n"),
        ).catch(() => {});
      }

      return res.json({ ok: true, autoApproved: false, resubmitted: true });
    }

    const [inserted] = await db
      .insert(dashboardUsersTable)
      .values({
        email: normalizedEmail,
        passwordHash,
        name: name.trim(),
        chatId: normalizedChatId,
        telegramUsername: normalizedUsername,
        status: isOwner ? "approved" : "pending",
        approvedAt: isOwner ? new Date() : null,
      })
      .returning({ id: dashboardUsersTable.id });

    // Ping owner in Telegram with approve/block buttons (skip if this IS the owner registering)
    if (!isOwner && OWNER_CHAT_ID && inserted) {
      const { sendMessageWithKeyboard } = await import("../lib/telegram.js");
      const tgLine = normalizedUsername
        ? `@${normalizedUsername} · ID: <code>${normalizedChatId}</code>`
        : normalizedChatId
          ? `ID: <code>${normalizedChatId}</code>`
          : `Telegram не указан`;
      await sendMessageWithKeyboard(
        OWNER_CHAT_ID,
        [
          `🔐 <b>Новый запрос доступа к Dashboard</b>`,
          ``,
          `👤 <b>${name.trim()}</b>`,
          `📧 <code>${normalizedEmail}</code>`,
          `💬 ${tgLine}`,
        ].join("\n"),
        [
          [
            {
              text: "✅ Одобрить",
              callback_data: `approve_user:${inserted.id}`,
            },
            {
              text: "❌ Заблокировать",
              callback_data: `block_user:${inserted.id}`,
            },
          ],
        ],
      ).catch(() => {});
    }

    return res.json({ ok: true, autoApproved: isOwner });
  } catch (err) {
    req.log.error({ err }, "auth/register error");
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/login
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body as Record<string, string>;
    if (!email || !password) {
      return res.status(400).json({ error: "Введите email и пароль" });
    }

    const rows = await db
      .select()
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.email, email.toLowerCase().trim()))
      .limit(1);

    if (
      rows.length === 0 ||
      !(await bcrypt.compare(password, rows[0].passwordHash))
    ) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const user = rows[0];
    if (user.status === "blocked") {
      return res.status(403).json({ error: "Доступ заблокирован" });
    }
    if (user.status === "expired") {
      return res.status(403).json({
        error: "Подписка истекла. Свяжитесь с администратором для продления.",
        code: "subscription_expired",
      });
    }
    if (user.status === "pending") {
      return res.status(403).json({ error: "Запрос ожидает одобрения" });
    }

    // Проверка даты подписки (owner освобождён от проверки)
    const isOwnerLogin = OWNER_EMAIL && user.email === OWNER_EMAIL;
    if (
      !isOwnerLogin &&
      user.subscribedUntil &&
      user.subscribedUntil < new Date()
    ) {
      return res.status(403).json({
        error: "Подписка истекла. Свяжитесь с администратором для продления.",
        code: "subscription_expired",
      });
    }

    await db
      .update(dashboardUsersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(dashboardUsersTable.id, user.id));

    const role = OWNER_EMAIL && user.email === OWNER_EMAIL ? "owner" : "user";
    const token = signUserToken(user.id, user.email, user.name, role);
    return res.json({
      ok: true,
      token,
      name: user.name,
      email: user.email,
      role,
    });
  } catch (err) {
    req.log.error({ err }, "auth/login error");
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// GET /api/auth/me
router.get("/auth/me", requireDashboardAccess, async (req, res) => {
  const h = req.headers.authorization as string | undefined;
  if (!h?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Не авторизован" });
  }
  try {
    const p = jwt.verify(h.slice(7), JWT_SECRET) as {
      userId: number;
      email: string;
      name: string;
    };
    const [user] = await db
      .select({
        email: dashboardUsersTable.email,
        name: dashboardUsersTable.name,
        status: dashboardUsersTable.status,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(
        and(
          eq(dashboardUsersTable.id, p.userId),
          eq(dashboardUsersTable.email, p.email),
        ),
      )
      .limit(1);
    if (!user) return res.status(401).json({ error: "Пользователь не найден" });

    const accessStatus = getDashboardAccessStatus({
      isOwner: OWNER_EMAIL !== "" && user.email === OWNER_EMAIL,
      status: user.status,
      subscribedUntil: user.subscribedUntil,
      now: new Date(),
    });
    if (accessStatus === "expired") {
      return res.status(403).json({
        error: "Подписка истекла. Свяжитесь с администратором для продления.",
        code: "subscription_expired",
      });
    }
    if (accessStatus !== "approved") {
      return res.status(403).json({ error: "Доступ недоступен" });
    }

    return res.json({ userId: p.userId, email: user.email, name: user.name });
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: "Токен недействителен" });
    }
    req.log.error({ err }, "auth/me error");
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// POST /api/auth/heartbeat
// Presence is intentionally based on an active, visible dashboard tab—not on
// Telegram's unavailable online/offline status.
router.post(
  "/auth/heartbeat",
  requireAuthenticatedDashboardAccess,
  async (req, res) => {
    const h = req.headers.authorization as string | undefined;
    if (!h?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Не авторизован" });
    }
    try {
      const p = jwt.verify(h.slice(7), JWT_SECRET) as {
        userId: number;
        email: string;
      };
      const [updated] = await db
        .update(dashboardUsersTable)
        .set({ lastActivityAt: new Date() })
        .where(
          and(
            eq(dashboardUsersTable.id, p.userId),
            eq(dashboardUsersTable.email, p.email),
          ),
        )
        .returning({ id: dashboardUsersTable.id });
      if (!updated) {
        return res.status(401).json({ error: "Пользователь не найден" });
      }
      return res.status(204).end();
    } catch (err) {
      if (err instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({ error: "Токен недействителен" });
      }
      req.log.warn({ err }, "dashboard presence heartbeat failed");
      return res.status(503).json({ error: "Статус активности недоступен" });
    }
  },
);

function dashboardAccessStatusForResponse(params: {
  email: string;
  status: string;
  subscribedUntil: Date | null;
}): DashboardAccessStatus {
  return getDashboardAccessStatus({
    ...params,
    isOwner: OWNER_EMAIL !== "" && params.email === OWNER_EMAIL,
    now: new Date(),
  });
}

// POST /api/admin/verify-pin
router.post("/admin/verify-pin", (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!ADMIN_PIN) {
    return res
      .status(503)
      .json({ error: "ADMIN_DASHBOARD_PIN не настроен на сервере" });
  }
  if (!pin || pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "Неверный PIN" });
  }
  return res.json({ ok: true, token: signAdminToken() });
});

// GET /api/admin/users
router.get("/admin/users/pending-count", requireAdmin, async (req, res) => {
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.status, "pending"));
    return res.json({ count: row?.count ?? 0 });
  } catch (err) {
    req.log.error({ err }, "admin/users/pending-count GET error");
    return res.status(500).json({ error: "Ошибка при загрузке" });
  }
});

router.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await db
      .select({
        id: dashboardUsersTable.id,
        email: dashboardUsersTable.email,
        name: dashboardUsersTable.name,
        chatId: dashboardUsersTable.chatId,
        telegramUsername: dashboardUsersTable.telegramUsername,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
        status: dashboardUsersTable.status,
        createdAt: dashboardUsersTable.createdAt,
        approvedAt: dashboardUsersTable.approvedAt,
        lastLoginAt: dashboardUsersTable.lastLoginAt,
      })
      .from(dashboardUsersTable)
      .orderBy(asc(dashboardUsersTable.createdAt));
    return res.json(
      users.map((user) => ({
        ...user,
        status: dashboardAccessStatusForResponse(user),
      })),
    );
  } catch (err) {
    req.log.error({ err }, "admin/users GET error");
    return res.status(500).json({ error: "Ошибка при загрузке" });
  }
});

// POST /api/auth/reset-confirm — сброс пароля по коду из Telegram-бота
router.post("/auth/reset-confirm", async (req, res) => {
  try {
    const { email, code, newPassword } = req.body as Record<string, string>;
    if (!email || !code || !newPassword) {
      return res
        .status(400)
        .json({ error: "Обязательные поля: email, code, newPassword" });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Пароль должен быть не менее 6 символов" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const users = await db
      .select({ id: dashboardUsersTable.id })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.email, normalizedEmail))
      .limit(1);

    if (!users[0]) {
      // Одинаковый ответ при неверном email или коде — чтобы не раскрывать существование email
      return res.status(400).json({ error: "Неверный email или код" });
    }

    const userId = users[0].id;
    const resets = await db.execute(sql`
      SELECT id FROM dashboard_password_resets
      WHERE user_id = ${userId}
        AND code    = ${code.trim()}
        AND used    = FALSE
        AND expires_at > NOW()
      LIMIT 1
    `);

    if (!resets.rows[0]) {
      return res.status(400).json({ error: "Неверный или устаревший код" });
    }

    const resetId = (resets.rows[0] as { id: number }).id;
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await Promise.all([
      db
        .update(dashboardUsersTable)
        .set({ passwordHash })
        .where(eq(dashboardUsersTable.id, userId)),
      db.execute(
        sql`UPDATE dashboard_password_resets SET used = TRUE WHERE id = ${resetId}`,
      ),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "auth/reset-confirm error");
    return res.status(500).json({ error: "Ошибка при сбросе пароля" });
  }
});

// PATCH /api/admin/users/:id — status | subscribedUntil | chatId | newPassword
router.patch("/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    const { status, subscribedUntil, chatId, newPassword } = req.body as {
      status?: string;
      subscribedUntil?: string | null;
      chatId?: string | null;
      newPassword?: string;
    };

    const pwValidation = validateNewPassword(newPassword);
    if (!pwValidation.valid) {
      return res.status(400).json({ error: pwValidation.error });
    }

    const expiryDate =
      subscribedUntil !== undefined
        ? subscribedUntil
          ? new Date(subscribedUntil)
          : null
        : undefined;
    const normalizedChatId =
      chatId !== undefined ? chatId?.trim() || null : undefined;

    if (
      normalizedChatId !== undefined &&
      normalizedChatId !== null &&
      (!/^\d+$/.test(normalizedChatId) ||
        !Number.isSafeInteger(Number(normalizedChatId)) ||
        Number(normalizedChatId) <= 0)
    ) {
      return res.status(400).json({ error: "Неверный Telegram Chat ID" });
    }

    if (
      status !== undefined &&
      !["approved", "blocked", "pending", "expired"].includes(status)
    ) {
      return res.status(400).json({ error: "Неверный статус" });
    }

    if (normalizedChatId !== undefined && normalizedChatId !== null) {
      const [existingUser] = await db
        .select({ id: dashboardUsersTable.id })
        .from(dashboardUsersTable)
        .where(eq(dashboardUsersTable.chatId, normalizedChatId))
        .limit(1);
      if (existingUser && existingUser.id !== id) {
        return res.status(409).json({
          error: "Этот Telegram Chat ID уже связан с другим пользователем",
        });
      }
    }

    if (
      status === undefined &&
      subscribedUntil === undefined &&
      normalizedChatId === undefined &&
      newPassword === undefined
    ) {
      return res.status(400).json({ error: "Нет данных для обновления" });
    }

    const [currentUser] = await db
      .select({
        email: dashboardUsersTable.email,
        status: dashboardUsersTable.status,
        chatId: dashboardUsersTable.chatId,
        subscribedUntil: dashboardUsersTable.subscribedUntil,
      })
      .from(dashboardUsersTable)
      .where(eq(dashboardUsersTable.id, id))
      .limit(1);
    if (!currentUser) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const now = new Date();
    const isOwnerAccount =
      OWNER_EMAIL !== "" && currentUser.email === OWNER_EMAIL;
    const expiryEndsAccess =
      !isOwnerAccount &&
      expiryDate !== undefined &&
      expiryDate !== null &&
      expiryDate.getTime() <= now.getTime();
    const renewalRestoresExpired =
      subscribedUntil !== undefined &&
      shouldRestoreExpiredDashboardAccount({
        status: currentUser.status,
        subscribedUntil: expiryDate ?? null,
        now,
      });
    const nextStatus =
      status ??
      (expiryEndsAccess
        ? "expired"
        : renewalRestoresExpired
          ? "approved"
          : undefined);
    const nextSubscribedUntil =
      expiryDate !== undefined ? expiryDate : currentUser.subscribedUntil;
    const userBecameBlocked =
      currentUser.status !== "blocked" && nextStatus === "blocked";
    const accessBecameApproved =
      currentUser.status !== "approved" && nextStatus === "approved";
    const prevState = {
      active: currentUser.status === "approved",
      subscribedUntil: currentUser.subscribedUntil,
    };
    const nextState = {
      active: (nextStatus ?? currentUser.status) === "approved",
      subscribedUntil: nextSubscribedUntil,
    };
    const shouldSendStartNotification = shouldNotifySubscriptionStarted({
      previous: prevState,
      next: nextState,
      becameApproved: accessBecameApproved,
    });
    const shouldSendRenewalNotification =
      !shouldSendStartNotification &&
      shouldNotifySubscriptionRenewed({ previous: prevState, next: nextState });

    const passwordHash =
      newPassword !== undefined
        ? await bcrypt.hash(newPassword, 10)
        : undefined;

    const [updatedUser] = await db
      .update(dashboardUsersTable)
      .set({
        ...(nextStatus !== undefined
          ? {
              status: nextStatus,
              approvedAt: nextStatus === "approved" ? new Date() : undefined,
              lastActivityAt: nextStatus === "approved" ? undefined : null,
            }
          : {}),
        ...(expiryDate !== undefined ? { subscribedUntil: expiryDate } : {}),
        ...(normalizedChatId !== undefined ? { chatId: normalizedChatId } : {}),
        ...(passwordHash !== undefined ? { passwordHash } : {}),
      })
      .where(eq(dashboardUsersTable.id, id))
      .returning({ chatId: dashboardUsersTable.chatId });
    await syncDashboardUserToSubscriber(updatedUser?.chatId ?? null, {
      ...(expiryDate !== undefined ? { subscribedUntil: expiryDate } : {}),
      ...(nextStatus !== undefined
        ? { status: nextStatus as "approved" | "blocked" | "pending" }
        : {}),
    });
    if (shouldSendStartNotification) {
      queueSubscriptionStartNotification(
        req,
        updatedUser?.chatId ?? null,
        nextSubscribedUntil ?? null,
      );
    } else if (shouldSendRenewalNotification) {
      queueSubscriptionRenewedNotification(
        req,
        updatedUser?.chatId ?? null,
        nextSubscribedUntil ?? null,
      );
    }
    if (userBecameBlocked) {
      queueBlockedNotification(req, updatedUser?.chatId ?? null);
    }
    if (passwordHash !== undefined) {
      queuePasswordResetNotification(req, updatedUser?.chatId ?? null);
    }
    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "admin/users PATCH error");
    return res.status(500).json({ error: "Ошибка при обновлении" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params["id"]);
    await db.delete(dashboardUsersTable).where(eq(dashboardUsersTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "admin/users DELETE error");
    return res.status(500).json({ error: "Ошибка при удалении" });
  }
});

// ── Members (merged view: dashboard_users + subscribers) ─────────────────────

router.get("/admin/members", requireAdmin, async (req, res) => {
  try {
    const [dashboardUsers, allSubs] = await Promise.all([
      db
        .select()
        .from(dashboardUsersTable)
        .orderBy(asc(dashboardUsersTable.createdAt)),
      db.select().from(subscribersTable),
    ]);

    // subscribers.chatId is bigint (number); dashboard_users.chatId is text
    const subByChatId = new Map(allSubs.map((s) => [String(s.chatId), s]));
    const usedChatIds = new Set<string>();
    const members: object[] = [];
    const onlineAfter = Date.now() - 90_000;
    const now = new Date();

    for (const u of dashboardUsers) {
      const telegramChatId = toTelegramChatId(u.chatId);
      const hasTelegramChatId = telegramChatId !== null;
      const sub = hasTelegramChatId
        ? subByChatId.get(String(telegramChatId))
        : undefined;
      if (hasTelegramChatId) usedChatIds.add(String(telegramChatId));
      const dashboardStatus = dashboardAccessStatusForResponse(u);
      const botAccessStatus = sub
        ? getMemberBotAccessStatus(sub, now)
        : getDashboardLinkedBotAccessStatus(dashboardStatus, hasTelegramChatId);
      const source = hasTelegramChatId ? "both" : "dashboard";
      members.push({
        source,
        dashboardId: u.id,
        chatId: telegramChatId,
        name: u.name,
        email: u.email,
        dashboardStatus,
        botAccessStatus,
        accessStatus: getMemberAccessStatus({
          source,
          dashboardStatus,
          botAccessStatus,
        }),
        telegramUsername: u.telegramUsername ?? sub?.username ?? null,
        lastLoginAt: u.lastLoginAt,
        lastActivityAt: u.lastActivityAt,
        dashboardOnline:
          dashboardStatus === "approved" &&
          u.lastActivityAt != null &&
          u.lastActivityAt.getTime() >= onlineAfter,
        createdAt: u.createdAt,
        approvedAt: u.approvedAt,
        botActive:
          botAccessStatus === null ? null : botAccessStatus === "active",
        botBlockedAt: sub?.botBlockedAt ?? null,
        botBlockedReason: sub?.botBlockedReason ?? null,
        subscribedAt: sub?.subscribedAt ?? null,
        firstName: sub?.firstName ?? null,
        lastName: sub?.lastName ?? null,
        subscribedUntil: u.subscribedUntil ?? sub?.subscribedUntil ?? null,
        dashboardSubscribedUntil: u.subscribedUntil ?? null,
        botSubscribedUntil: hasTelegramChatId
          ? (u.subscribedUntil ?? null)
          : null,
      });
    }

    for (const sub of allSubs) {
      if (!usedChatIds.has(String(sub.chatId))) {
        const source = "bot" as const;
        const botAccessStatus = getMemberBotAccessStatus(sub, now);
        members.push({
          source,
          dashboardId: null,
          chatId: sub.chatId,
          name: [sub.firstName, sub.lastName].filter(Boolean).join(" ") || null,
          email: null,
          dashboardStatus: null,
          botAccessStatus,
          accessStatus: getMemberAccessStatus({
            source,
            dashboardStatus: null,
            botAccessStatus,
          }),
          telegramUsername: sub.username,
          lastLoginAt: null,
          lastActivityAt: null,
          dashboardOnline: false,
          createdAt: sub.subscribedAt,
          approvedAt: null,
          botActive: sub.active,
          botBlockedAt: sub.botBlockedAt,
          botBlockedReason: sub.botBlockedReason,
          subscribedAt: sub.subscribedAt,
          firstName: sub.firstName,
          lastName: sub.lastName,
          subscribedUntil: sub.subscribedUntil,
          dashboardSubscribedUntil: null,
          botSubscribedUntil: sub.subscribedUntil,
        });
      }
    }

    return res.json(members);
  } catch (err) {
    req.log.error({ err }, "admin/members GET error");
    return res.status(500).json({ error: "Ошибка при загрузке" });
  }
});

// PATCH /api/admin/members/:chatId — update both tables by chatId
router.patch("/admin/members/:chatId", requireAdmin, async (req, res) => {
  try {
    const chatId = Number(req.params["chatId"]);
    if (isNaN(chatId)) return res.status(400).json({ error: "Invalid chatId" });

    const { action, subscribedUntil } = req.body as {
      action?: string;
      subscribedUntil?: string | null;
    };

    const chatIdStr = String(chatId);
    const [[currentSubscriber], [currentDashboardUser]] = await Promise.all([
      db
        .select({
          active: subscribersTable.active,
          subscribedUntil: subscribersTable.subscribedUntil,
        })
        .from(subscribersTable)
        .where(eq(subscribersTable.chatId, chatId))
        .limit(1),
      db
        .select({
          status: dashboardUsersTable.status,
          subscribedUntil: dashboardUsersTable.subscribedUntil,
          email: dashboardUsersTable.email,
        })
        .from(dashboardUsersTable)
        .where(eq(dashboardUsersTable.chatId, chatIdStr))
        .limit(1),
    ]);
    const now = new Date();
    const isOwnerAccount =
      (OWNER_CHAT_ID > 0 && chatId === OWNER_CHAT_ID) ||
      (OWNER_EMAIL !== "" &&
        currentDashboardUser?.email.toLowerCase() === OWNER_EMAIL);
    const expiryDate =
      subscribedUntil !== undefined
        ? subscribedUntil
          ? new Date(subscribedUntil)
          : null
        : undefined;
    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
      return res.status(400).json({ error: "Invalid subscribedUntil" });
    }
    const expiresAccess =
      !isOwnerAccount &&
      expiryDate !== undefined &&
      expiryDate !== null &&
      expiryDate.getTime() <= now.getTime();
    const renewsAccess =
      expiryDate !== undefined &&
      (isOwnerAccount ||
        expiryDate === null ||
        expiryDate.getTime() > now.getTime());
    const nextDashboardStatus =
      action === "approve"
        ? "approved"
        : expiresAccess
          ? "expired"
          : renewsAccess && currentDashboardUser?.status === "expired"
            ? "approved"
            : currentDashboardUser?.status;
    const nextSubscribedUntil =
      expiryDate !== undefined
        ? expiryDate
        : (currentSubscriber?.subscribedUntil ??
          currentDashboardUser?.subscribedUntil ??
          null);
    const prevState2 = {
      active:
        currentSubscriber?.active ??
        currentDashboardUser?.status === "approved",
      subscribedUntil:
        currentSubscriber?.subscribedUntil ??
        currentDashboardUser?.subscribedUntil ??
        null,
    };
    const nextState2 = {
      active:
        action === "block" || action === "deactivate" || expiresAccess
          ? false
          : action === "approve" || renewsAccess
            ? true
            : (currentSubscriber?.active ??
              currentDashboardUser?.status === "approved"),
      subscribedUntil: nextSubscribedUntil,
    };
    const shouldSendStartNotification = shouldNotifySubscriptionStarted({
      previous: prevState2,
      next: nextState2,
      becameApproved:
        currentDashboardUser?.status !== "approved" &&
        nextDashboardStatus === "approved",
      now,
    });
    const shouldSendRenewalNotification2 =
      !shouldSendStartNotification &&
      shouldNotifySubscriptionRenewed({
        previous: prevState2,
        next: nextState2,
        now,
      });

    if (subscribedUntil !== undefined) {
      await db.transaction(async (tx) => {
        await tx
          .update(subscribersTable)
          .set({
            subscribedUntil: expiryDate,
            ...(renewsAccess
              ? { active: true, unsubscribedAt: null }
              : expiresAccess
                ? { active: false, unsubscribedAt: now }
                : {}),
          })
          .where(eq(subscribersTable.chatId, chatId));
        await tx
          .update(dashboardUsersTable)
          .set({
            subscribedUntil: expiryDate,
            ...(expiresAccess
              ? { status: "expired", lastActivityAt: null }
              : renewsAccess && currentDashboardUser?.status === "expired"
                ? { status: "approved", approvedAt: now }
                : {}),
          })
          .where(eq(dashboardUsersTable.chatId, chatIdStr));
      });
    }

    if (action === "approve") {
      await Promise.all([
        db
          .update(subscribersTable)
          .set({ active: true })
          .where(eq(subscribersTable.chatId, chatId)),
        db
          .update(dashboardUsersTable)
          .set({ status: "approved", approvedAt: new Date() })
          .where(eq(dashboardUsersTable.chatId, chatIdStr)),
      ]);
    }

    if (action === "block") {
      const wasPreviouslyBlocked =
        currentDashboardUser?.status === "blocked" &&
        currentSubscriber?.active === false;
      await Promise.all([
        db
          .update(subscribersTable)
          .set({ active: false })
          .where(eq(subscribersTable.chatId, chatId)),
        db
          .update(dashboardUsersTable)
          .set({ status: "blocked", lastActivityAt: null })
          .where(eq(dashboardUsersTable.chatId, chatIdStr)),
      ]);
      if (!wasPreviouslyBlocked) {
        queueBlockedNotification(req, chatIdStr);
      }
    }

    if (action === "deactivate" && !isOwnerAccount) {
      const wasAlreadyExpired =
        currentDashboardUser?.status === "expired" &&
        currentSubscriber?.active === false;
      await db.transaction(async (tx) => {
        await tx
          .update(subscribersTable)
          .set({
            active: false,
            unsubscribedAt: now,
            subscribedUntil: now,
          })
          .where(eq(subscribersTable.chatId, chatId));
        await tx
          .update(dashboardUsersTable)
          .set({
            status: "expired",
            subscribedUntil: now,
            lastActivityAt: null,
          })
          .where(eq(dashboardUsersTable.chatId, chatIdStr));
      });
      if (!wasAlreadyExpired) {
        queueDeactivatedNotification(req, chatIdStr);
      }
    }

    if (shouldSendStartNotification) {
      queueSubscriptionStartNotification(
        req,
        chatIdStr,
        nextSubscribedUntil ?? null,
      );
    } else if (shouldSendRenewalNotification2) {
      queueSubscriptionRenewedNotification(
        req,
        chatIdStr,
        nextSubscribedUntil ?? null,
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "admin/members PATCH error");
    return res.status(500).json({ error: "Ошибка при обновлении" });
  }
});

// DELETE /api/admin/members/:chatId — hard-delete from dashboard_users + subscribers
router.delete("/admin/members/:chatId", requireAdmin, async (req, res) => {
  try {
    const chatId = Number(req.params["chatId"]);
    if (isNaN(chatId)) return res.status(400).json({ error: "Invalid chatId" });

    await Promise.all([
      // Hard-delete subscriber so they don't resurface as a "bot" member on next load
      db.delete(subscribersTable).where(eq(subscribersTable.chatId, chatId)),
      db
        .delete(dashboardUsersTable)
        .where(eq(dashboardUsersTable.chatId, String(chatId))),
    ]);

    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "admin/members DELETE error");
    return res.status(500).json({ error: "Ошибка при удалении" });
  }
});

export default router;
