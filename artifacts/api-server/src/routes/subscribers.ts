import { Router } from "express";
import {
  dashboardUsersTable,
  db,
  settingsTable,
  subscribersTable,
} from "@workspace/db";
import { and, eq, gt, gte, isNull, or, sql } from "drizzle-orm";
import { sendMessage } from "../lib/telegram.js";
import { handleTelegramWebhookUpdate } from "../lib/telegram-webhook.js";
import { verifyTelegramWebhookSecret } from "../lib/telegram-api.js";
import { requireAdminToken } from "../middleware/adminAuth.js";
import { isSubscriptionActive } from "../lib/subscription-warning.js";
import {
  shouldNotifySubscriptionStarted,
  shouldNotifySubscriptionRenewed,
} from "../lib/subscription-start-notification.js";

const router = Router();

router.post("/telegram/webhook", async (req, res) => {
  const receivedSecret = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (!verifyTelegramWebhookSecret(receivedSecret)) {
    req.log.warn("Rejected Telegram webhook with invalid secret");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const result = await handleTelegramWebhookUpdate(req.body);
    return res.json({
      ok: result.outcome !== "permanent_failure",
      ...result,
    });
  } catch (err) {
    req.log.error({ err }, "Webhook processing error");
    return res.status(503).json({
      ok: false,
      retryable: true,
      error: "Telegram update processing failed",
    });
  }
});

router.get("/subscribers", requireAdminToken, async (req, res) => {
  try {
    const subscribers = await db
      .select()
      .from(subscribersTable)
      .orderBy(subscribersTable.subscribedAt);

    const now = new Date();
    const activeCount = subscribers.filter((subscriber) =>
      isSubscriptionActive(subscriber.active, subscriber.subscribedUntil, now),
    ).length;

    res.json({
      subscribers: subscribers.map((s) => ({
        chatId: s.chatId,
        username: s.username,
        firstName: s.firstName,
        lastName: s.lastName,
        // A delayed expiry job must not make the dashboard report an expired
        // subscription as active. This is the effective access status.
        active: isSubscriptionActive(s.active, s.subscribedUntil, now),
        subscribedAt: s.subscribedAt.toISOString(),
        subscribedUntil: s.subscribedUntil?.toISOString() ?? null,
        unsubscribedAt: s.unsubscribedAt?.toISOString() ?? null,
        botBlockedAt: s.botBlockedAt?.toISOString() ?? null,
        botBlockedReason: s.botBlockedReason,
      })),
      total: subscribers.length,
      active: activeCount,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get subscribers");
    res.status(500).json({ error: "Failed to get subscribers" });
  }
});

// PATCH /api/admin/subscribers/:chatId — set subscribedUntil
router.patch(
  "/admin/subscribers/:chatId",
  requireAdminToken,
  async (req, res) => {
    try {
      const chatId = Number(req.params.chatId);
      if (isNaN(chatId)) {
        res.status(400).json({ error: "Invalid chatId" });
        return;
      }
      const { subscribedUntil } = req.body as {
        subscribedUntil?: string | null;
      };
      if (subscribedUntil === undefined) {
        return res.status(400).json({ error: "subscribedUntil is required" });
      }
      const expiryDate = subscribedUntil ? new Date(subscribedUntil) : null;
      if (expiryDate && Number.isNaN(expiryDate.getTime())) {
        return res.status(400).json({ error: "Invalid subscribedUntil" });
      }
      const [currentSubscriber] = await db
        .select({
          active: subscribersTable.active,
          subscribedUntil: subscribersTable.subscribedUntil,
        })
        .from(subscribersTable)
        .where(eq(subscribersTable.chatId, chatId))
        .limit(1);
      if (!currentSubscriber) {
        return res.status(404).json({ error: "Subscriber not found" });
      }
      const now = new Date();
      const renewsAccess =
        expiryDate === null || expiryDate.getTime() > now.getTime();
      const nextSubState = {
        active: renewsAccess ? true : currentSubscriber.active,
        subscribedUntil: expiryDate,
      };
      const shouldSendStartNotification = shouldNotifySubscriptionStarted({
        previous: currentSubscriber,
        next: nextSubState,
        becameApproved: false,
        now,
      });
      const shouldSendRenewalNotification =
        !shouldSendStartNotification &&
        shouldNotifySubscriptionRenewed({
          previous: currentSubscriber,
          next: nextSubState,
          now,
        });
      await db
        .update(subscribersTable)
        .set({
          subscribedUntil: expiryDate,
          active: renewsAccess,
          unsubscribedAt: renewsAccess ? null : now,
        })
        .where(eq(subscribersTable.chatId, chatId));
      const [linkedDashboardUser] = await db
        .select({
          status: dashboardUsersTable.status,
          email: dashboardUsersTable.email,
        })
        .from(dashboardUsersTable)
        .where(eq(dashboardUsersTable.chatId, String(chatId)))
        .limit(1);
      if (linkedDashboardUser) {
        const ownerEmail = (process.env["OWNER_EMAIL"] ?? "")
          .toLowerCase()
          .trim();
        const isOwner =
          ownerEmail !== "" &&
          linkedDashboardUser.email.toLowerCase() === ownerEmail;
        const nextDashboardStatus = isOwner
          ? linkedDashboardUser.status
          : renewsAccess
            ? linkedDashboardUser.status === "expired"
              ? "approved"
              : linkedDashboardUser.status
            : "expired";
        await db
          .update(dashboardUsersTable)
          .set({
            subscribedUntil: expiryDate,
            status: nextDashboardStatus,
            ...(nextDashboardStatus === "approved" ? { approvedAt: now } : {}),
          })
          .where(eq(dashboardUsersTable.chatId, String(chatId)));
      }
      if (shouldSendStartNotification) {
        void import("../lib/telegram.js")
          .then(({ sendSubscriptionStartedNotification }) =>
            sendSubscriptionStartedNotification(chatId, expiryDate),
          )
          .then((result) => {
            if (!result.ok) {
              req.log.warn(
                {
                  chatId,
                  status: result.status,
                  description: result.description,
                },
                "Subscription start notification was not delivered",
              );
            }
          })
          .catch((err) =>
            req.log.warn(
              { err, chatId },
              "Subscription start notification failed unexpectedly",
            ),
          );
      } else if (shouldSendRenewalNotification) {
        void import("../lib/telegram.js")
          .then(({ sendSubscriptionRenewedNotification }) =>
            sendSubscriptionRenewedNotification(chatId, expiryDate),
          )
          .then((result) => {
            if (!result.ok) {
              req.log.warn(
                {
                  chatId,
                  status: result.status,
                  description: result.description,
                },
                "Subscription renewal notification was not delivered",
              );
            }
          })
          .catch((err) =>
            req.log.warn(
              { err, chatId },
              "Subscription renewal notification failed unexpectedly",
            ),
          );
      }
      return res.json({ ok: true });
    } catch (err) {
      req.log.error({ err }, "Failed to update subscriber subscribedUntil");
      return res.status(500).json({ error: "Failed to update" });
    }
  },
);

router.delete("/subscribers/:chatId", requireAdminToken, async (req, res) => {
  try {
    const chatId = Number(req.params.chatId);
    if (isNaN(chatId)) {
      res.status(400).json({ error: "Invalid chatId" });
      return;
    }
    await db
      .update(subscribersTable)
      .set({ active: false, unsubscribedAt: new Date() })
      .where(eq(subscribersTable.chatId, chatId));
    req.log.info({ chatId }, "Subscriber removed via admin API");
    res.json({ ok: true, chatId });
  } catch (err) {
    req.log.error({ err }, "Failed to remove subscriber");
    res.status(500).json({ error: "Failed to remove subscriber" });
  }
});

router.get("/subscribers/stats", requireAdminToken, async (req, res) => {
  try {
    const [totalResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(subscribersTable);
    const [activeResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(subscribersTable)
      .where(
        and(
          eq(subscribersTable.active, true),
          or(
            isNull(subscribersTable.subscribedUntil),
            gt(subscribersTable.subscribedUntil, new Date()),
          ),
        ),
      );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todayResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(subscribersTable)
      .where(gte(subscribersTable.subscribedAt, today));

    const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000);
    const [weekResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(subscribersTable)
      .where(gte(subscribersTable.subscribedAt, weekAgo));

    const total = Number(totalResult.count);
    const active = Number(activeResult.count);

    res.json({
      total,
      active,
      inactive: total - active,
      newToday: Number(todayResult.count),
      newThisWeek: Number(weekResult.count),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get subscriber stats");
    res.status(500).json({ error: "Failed to get subscriber stats" });
  }
});

// ── Channel test ─────────────────────────────────────────────────────────────
router.post("/telegram/test-channel", requireAdminToken, async (req, res) => {
  try {
    const rows = await db
      .select({ channelId: settingsTable.channelId })
      .from(settingsTable)
      .limit(1);
    const channelId = rows[0]?.channelId ?? null;

    if (!channelId) {
      res.json({
        success: false,
        message: "Channel ID не настроен в Settings",
      });
      return;
    }

    const testText = [
      `✅ <b>Тест канала BingX AltBullet</b>`,
      ``,
      `Канал: <code>${channelId}</code>`,
      `Время: ${new Date().toUTCString()}`,
      ``,
      `Если видишь это — бот корректно пересылает сигналы в этот канал.`,
    ].join("\n");

    const ok = await sendMessage(channelId, testText);

    if (ok) {
      res.json({
        success: true,
        message: `Тестовое сообщение отправлено в ${channelId}`,
      });
    } else {
      res.json({
        success: false,
        message:
          "Не удалось отправить. Проверь: бот добавлен в канал как Admin с правом 'Post Messages'",
      });
    }
  } catch (err) {
    req.log.error({ err }, "Channel test error");
    res.status(500).json({ success: false, message: "Ошибка сервера" });
  }
});

export default router;
