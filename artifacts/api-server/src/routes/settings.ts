import { Router } from "express";
import { db, settingsTable } from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { setChannelIdCache } from "../lib/telegram.js";
import { requireAdminToken } from "../middleware/adminAuth.js";

const router = Router();

async function getOrCreateSettings() {
  const rows = await db.select().from(settingsTable).limit(1);
  if (rows.length === 0) {
    const inserted = await db
      .insert(settingsTable)
      .values({
        volumeMultiplier: 3,
        oiChangePercent: 10,
        fundingRateThreshold: 0.0005,
        scanIntervalMs: 300000,
        telegramEnabled: true,
        maxSymbols: 200,
      })
      .returning();
    return inserted[0];
  }
  return rows[0];
}

router.get("/settings", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json({
      volumeMultiplier: settings.volumeMultiplier,
      oiChangePercent: settings.oiChangePercent,
      fundingRateThreshold: settings.fundingRateThreshold,
      scanIntervalMs: settings.scanIntervalMs,
      telegramEnabled: settings.telegramEnabled,
      maxSymbols: settings.maxSymbols,
      channelId: settings.channelId ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Failed to get settings" });
  }
});

router.put("/settings", requireAdminToken, async (req, res) => {
  try {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid settings data" });
      return;
    }

    await getOrCreateSettings();
    const updates = parsed.data;

    // Auto-prepend @ to channel usernames that look like text handles
    if (updates.channelId && typeof updates.channelId === "string") {
      const ch = updates.channelId.trim();
      if (
        ch &&
        !ch.startsWith("@") &&
        !ch.startsWith("-") &&
        isNaN(Number(ch))
      ) {
        updates.channelId = `@${ch}`;
      }
    }

    const [updated] = await db
      .update(settingsTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Settings not found" });
      return;
    }

    // Обновляем in-memory кэш channelId — используется как fallback при DB timeout в getTargets()
    setChannelIdCache(updated.channelId ?? null);

    res.json({
      volumeMultiplier: updated.volumeMultiplier,
      oiChangePercent: updated.oiChangePercent,
      fundingRateThreshold: updated.fundingRateThreshold,
      scanIntervalMs: updated.scanIntervalMs,
      telegramEnabled: updated.telegramEnabled,
      maxSymbols: updated.maxSymbols,
      channelId: updated.channelId ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
