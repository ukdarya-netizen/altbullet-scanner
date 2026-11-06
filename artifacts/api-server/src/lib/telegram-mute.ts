/**
 * Owner 2026-11-03: every Telegram message from the bot is temporarily stopped
 * (signals, positions, restart notice, replies, reports). Only watchdog alerts
 * (event key "watchdog:...") still go out. Set to false when the owner asks to
 * resume.
 *
 * Owner 2026-11-06: Impulse Buy goes out again — its signal and every position message of an IB
 * (milestones, B.U., core close, runner close, cancels), the already open ones included. Everything
 * else stays muted. An event is recognised by the tracker / signal id embedded in its key.
 */
import { and, eq, or } from "drizzle-orm";
import { db, trackedSignalsTable } from "@workspace/db";

export const TELEGRAM_MUTED = true;
export const TELEGRAM_ALLOWED_PATTERNS = ["impulse_buy"] as const;

const SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendVideo",
  "sendAnimation",
  "sendMediaGroup",
  "editMessageText",
  "editMessageCaption",
  "editMessageReplyMarkup",
]);

const TRACKED_KEY = /^(?:position|cancel|watcher:v1|track_signal:v1|milestone:v3|reentry):(\d+)/;
const SIGNAL_KEY = /^signal(?:-resend)?:(\d+)/;
/** id → allowed pattern or not (both cached: a tracker's pattern never changes). */
const trackedAllowed = new Map<number, boolean>();
const signalAllowed = new Map<number, boolean>();

function parseKey(eventKey: string | null | undefined): { kind: "tracked" | "signal"; id: number } | null {
  if (!eventKey) return null;
  const t = TRACKED_KEY.exec(eventKey);
  if (t) return { kind: "tracked", id: Number(t[1]) };
  const s = SIGNAL_KEY.exec(eventKey);
  if (s) return { kind: "signal", id: Number(s[1]) };
  return null;
}

/** Synchronous view: muted unless watchdog or an id already known to belong to an allowed pattern. */
export function isTelegramMuted(eventKey?: string | null): boolean {
  if (!TELEGRAM_MUTED) return false;
  if ((eventKey ?? "").startsWith("watchdog:")) return false;
  const k = parseKey(eventKey);
  if (!k) return true;
  return !((k.kind === "tracked" ? trackedAllowed : signalAllowed).get(k.id) ?? false);
}

/** Same, but looks the pattern up in the database once per id. */
export async function isTelegramMutedAsync(eventKey?: string | null): Promise<boolean> {
  if (!isTelegramMuted(eventKey)) return false;
  const k = parseKey(eventKey);
  if (!k) return true;
  const cache = k.kind === "tracked" ? trackedAllowed : signalAllowed;
  if (cache.has(k.id)) return !cache.get(k.id);
  try {
    const [row] = await db
      .select({ id: trackedSignalsTable.id })
      .from(trackedSignalsTable)
      .where(
        and(
          k.kind === "tracked" ? eq(trackedSignalsTable.id, k.id) : eq(trackedSignalsTable.signalId, k.id),
          or(...TELEGRAM_ALLOWED_PATTERNS.map((p) => eq(trackedSignalsTable.sentimentKey, p))),
        ),
      )
      .limit(1);
    cache.set(k.id, Boolean(row));
    return !row;
  } catch {
    return true; // unknown → stay muted, retried on the next send
  }
}

export function isMutedTelegramMethod(method: string, eventKey?: string | null): boolean {
  return SEND_METHODS.has(method) && isTelegramMuted(eventKey);
}

export async function isMutedTelegramMethodAsync(method: string, eventKey?: string | null): Promise<boolean> {
  return SEND_METHODS.has(method) && (await isTelegramMutedAsync(eventKey));
}
