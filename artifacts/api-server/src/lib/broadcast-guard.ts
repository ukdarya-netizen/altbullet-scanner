/**
 * Atomic broadcast dedup guard for the settings table.
 *
 * Production runs 2 worker processes simultaneously. Without a guard, both
 * workers can fire the same scheduled broadcast (digest, report, notification)
 * within milliseconds of each other → duplicate Telegram messages.
 *
 * Pattern: atomic UPDATE ... WHERE (col IS NULL OR col < cutoff) ... RETURNING
 * Only the first process to UPDATE gets a non-empty RETURNING row → it sends.
 * The second process sees 0 rows → skips silently.
 *
 * Usage:
 *   const claimed = await claimSettingsBroadcast({
 *     column: "lastWeeklyDigestAt",
 *     windowMs: 10 * 60_000,
 *     label: "Weekly digest",
 *   });
 *   if (!claimed) return;
 *   // ... send the message
 *
 * For broadcasts that need retry on DB error (pool stress at startup):
 *   const claimed = await claimSettingsBroadcast({
 *     column: "lastRestartNotifiedAt",
 *     windowMs: 5 * 60_000,
 *     label: "Restart notification",
 *     retries: 4,
 *     retryDelayMs: 60_000,
 *   });
 */

import { db, settingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export async function claimSettingsBroadcast({
  column,
  windowMs,
  label,
  retries = 0,
  retryDelayMs = 30_000,
}: {
  /**
   * camelCase key of the settings table timestamp column used as the dedup guard.
   * Must be a nullable timestamp column in settingsTable (see schema/signals.ts).
   * e.g. "lastDailyReportAt", "lastWeeklyDigestAt", "lastRestartNotifiedAt"
   */
  column: string;
  /** How long (ms) before the same broadcast may fire again. */
  windowMs: number;
  /** Short label for log messages. */
  label: string;
  /** Extra DB-error retry attempts (0 = try once, no retry). */
  retries?: number;
  /** Delay between retries in ms. */
  retryDelayMs?: number;
}): Promise<boolean> {
  const snakeCol = camelToSnake(column);
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const now = new Date();
      const cutoff = new Date(Date.now() - windowMs);

      const rows = await db
        .update(settingsTable)
        .set({ [column]: now } as any)
        .where(
          sql`id = (SELECT id FROM settings LIMIT 1) AND (${sql.raw(snakeCol)} IS NULL OR ${sql.raw(snakeCol)} < ${cutoff})`,
        )
        .returning({ id: settingsTable.id });

      if (rows.length === 0) {
        logger.info(`${label}: уже отправлен другим процессом — пропускаем`);
        return false;
      }
      return true;
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(
          { err, label, attempt, maxAttempts },
          `${label}: DB claim error — retry in ${retryDelayMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        logger.error(
          { err, label, maxAttempts },
          `${label}: DB claim failed после ${maxAttempts} попыток — broadcast отменён`,
        );
        return false;
      }
    }
  }
  return false;
}
