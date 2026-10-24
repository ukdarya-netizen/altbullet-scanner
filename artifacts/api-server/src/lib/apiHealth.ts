/**
 * API Health Monitor — отслеживает сбои внешних API и шлёт Telegram-алерт.
 *
 * Логика: ошибки пишутся в лог; админу уходит один алерт на тип при простое
 * дольше 30 минут (не чаще раза в 6 часов), «восстановлен» — только после
 * такого алерта.
 */

import { logger } from "./logger.js";
import { callTelegramApi } from "./telegram-api.js";
import { telegramHtmlToPlainText } from "./telegram-html.js";
import { resolveOperationalTelegramRecipientId } from "./telegram-recipient-policy.js";

export type ApiName =
  | "coinglass"
  | "coinalyze"
  | "bingx"
  | "coingecko"
  | "coinpaprika";

interface HealthState {
  consecutiveFailures: number;
  lastStatus?: number;
  lastFailureAt?: number;
}

const states = new Map<ApiName, HealthState>();

function getState(api: ApiName): HealthState {
  if (!states.has(api)) states.set(api, { consecutiveFailures: 0 });
  return states.get(api)!;
}

// ── Outage alerts ───────────────────────────────────────────────────────────
// Owner policy: the admin gets a Telegram alert only when a data source has
// been unavailable continuously for more than 30 minutes, at most once per
// 6 hours per type. A recovery message is sent only if that alert was sent.
// Everything else (single errors, 429, "N failures in a row") is log-only.
export const OUTAGE_ALERT_AFTER_MS = 30 * 60_000;
export const OUTAGE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
export const OI_COVERAGE_ALERT_CYCLES = 3;

export type OutageType = "unlock" | "coinglass" | "coingecko" | "oi_coverage";

const OUTAGE_LABELS: Record<OutageType, string> = {
  unlock: "Список разлоков токенов",
  coinglass: "CoinGlass",
  coingecko: "CoinGecko",
  oi_coverage: "Агрегированный OI (покрытие вселенной)",
};

interface OutageState {
  downSince: number | null;
  lastAlertAt: number;
  alerted: boolean;
}

const outages = new Map<OutageType, OutageState>();
function outage(type: OutageType): OutageState {
  let s = outages.get(type);
  if (!s) {
    s = { downSince: null, lastAlertAt: 0, alerted: false };
    outages.set(type, s);
  }
  return s;
}

/** Test-only reset. */
export function resetApiHealthForTests(): void {
  states.clear();
  outages.clear();
  coverageLowCycles = 0;
}

/** Marks the source as down (idempotent) and alerts if the policy allows. */
function markOutage(
  type: OutageType,
  now: number,
  detail: string,
  send: (text: string) => Promise<boolean> | void = sendAdminAlert,
): boolean {
  const s = outage(type);
  s.downSince ??= now;
  const downMs = now - s.downSince;
  if (downMs < OUTAGE_ALERT_AFTER_MS) return false;
  if (now - s.lastAlertAt < OUTAGE_ALERT_COOLDOWN_MS) return false;
  s.lastAlertAt = now;
  s.alerted = true;
  void send(
    `⚠️ <b>${OUTAGE_LABELS[type]} недоступен</b>\n\n` +
      `Непрерывно уже ${Math.round(downMs / 60_000)} мин. ${detail}`,
  );
  return true;
}

/** Clears the outage; sends a recovery message only if an alert was sent. */
function clearOutage(
  type: OutageType,
  send: (text: string) => Promise<boolean> | void = sendAdminAlert,
): boolean {
  const s = outage(type);
  const wasAlerted = s.alerted;
  s.downSince = null;
  s.alerted = false;
  if (wasAlerted) {
    void send(`✅ <b>${OUTAGE_LABELS[type]} восстановлен</b>`);
  }
  return wasAlerted;
}

const OUTAGE_API: Partial<Record<ApiName, OutageType>> = {
  coinglass: "coinglass",
  coingecko: "coingecko",
};

/** Вызвать когда API ответил успешно */
export function reportApiSuccess(api: ApiName, now: number = Date.now()): void {
  const s = getState(api);
  s.consecutiveFailures = 0;
  const type = OUTAGE_API[api];
  if (type) clearOutage(type);
  void now;
}

/** Вызвать когда API вернул ошибку (только лог; алерт — по непрерывному простою) */
export function reportApiFailure(
  api: ApiName,
  statusCode?: number,
  now: number = Date.now(),
): void {
  const s = getState(api);
  s.consecutiveFailures++;
  s.lastStatus = statusCode;
  s.lastFailureAt = now;
  logger.warn(
    { api, statusCode, consecutiveFailures: s.consecutiveFailures },
    "External API failure",
  );
  // Rate limiting (429) is throttling, not unavailability.
  if (statusCode === 429 && api === "coingecko") return;
  const type = OUTAGE_API[api];
  if (type) {
    markOutage(type, now, "Сигналы работают в ограниченном режиме.");
  }
}

/** Возвращает текущий статус подключения (false = есть последовательные ошибки) */
export function getApiConnected(api: ApiName): boolean {
  return getState(api).consecutiveFailures === 0;
}

/**
 * Admin alerts go to the operational (owner) chat by numeric id. The legacy
 * TELEGRAM_CHAT_ID holds a channel username here, which Telegram answers with
 * "chat not found", so every alert since the unlock outage was lost.
 */
export async function sendAdminAlert(text: string): Promise<boolean> {
  const chatId = resolveOperationalTelegramRecipientId(
    process.env.OWNER_CHAT_ID,
  );

  try {
    const result = await callTelegramApi("sendMessage", {
      body: { chat_id: chatId, text: telegramHtmlToPlainText(text) },
      audit: {
        source: "apiHealth.sendAdminAlert",
        deliveryPath: "direct",
      },
    });
    if (result.ok) {
      logger.info({ api: text.slice(0, 40) }, "API health alert sent to admin");
    } else {
      logger.warn({ api: text.slice(0, 40) }, "API health alert NOT delivered");
    }
    return result.ok === true;
  } catch (err) {
    logger.warn({ err }, "Failed to send API health alert");
    return false;
  }
}

const MIN_AGGREGATED_OI_COVERAGE = 0.5;
let coverageLowCycles = 0;

/**
 * Aggregated (CoinGlass) OI is mandatory for every pattern. Alert only when
 * coverage stays below 50% of the requested universe for 3 cycles in a row.
 */
export function reportAggregatedOiCoverage(
  available: number,
  requested: number,
  now: number = Date.now(),
): boolean {
  if (requested <= 0) return false;
  if (available / requested >= MIN_AGGREGATED_OI_COVERAGE) {
    coverageLowCycles = 0;
    clearOutage("oi_coverage");
    return false;
  }
  coverageLowCycles++;
  logger.warn(
    { available, requested, coverageLowCycles },
    "Aggregated OI coverage below 50% of the universe",
  );
  const s = outage("oi_coverage");
  s.downSince ??= now;
  if (coverageLowCycles < OI_COVERAGE_ALERT_CYCLES) return false;
  return markOutage(
    "oi_coverage",
    // Three consecutive cycles span more than 30 minutes by construction.
    Math.max(now, s.downSince + OUTAGE_ALERT_AFTER_MS),
    `OI получен по ${available} из ${requested} токенов (3 цикла подряд ниже 50%). Токены без данных пропускаются.`,
  );
}

/**
 * The token-unlock list gates every pattern (unavailable = no signals). Log on
 * each failed cycle; alert only after more than 30 minutes of continuous
 * unavailability.
 */
export function reportUnlockListAvailability(
  available: boolean,
  now: number = Date.now(),
): boolean {
  if (available) {
    clearOutage("unlock");
    return false;
  }
  const s = outage("unlock");
  s.downSince ??= now;
  logger.warn(
    { downMinutes: Math.round((now - s.downSince) / 60_000) },
    "Unlock list unavailable — all patterns refuse with unlock_data_unavailable",
  );
  return markOutage(
    "unlock",
    now,
    "Пока список недоступен, все паттерны отказывают (unlock_data_unavailable) — сигналов не будет.",
  );
}
