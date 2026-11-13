/**
 * Telegram delivery is muted globally. System restart notices, watchdog photo
 * alerts and scoped events from all active patterns may bypass it. LC bypass
 * applies only to fresh primary signals; other LC lifecycle events stay muted.
 */
export const TELEGRAM_MUTED = true;
export const ABNEON_PRIMARY_ALERT_MAX_AGE_MS = 10 * 60_000;
export const STEALTH_PRIMARY_ALERT_MAX_AGE_MS = 10 * 60_000;
export const LIQUIDATION_CASCADE_PRIMARY_ALERT_MAX_AGE_MS = 10 * 60_000;
const RECENT_TERMINAL_ABNEON_ALERT_MS = 15 * 60_000;
const RECENT_TERMINAL_STEALTH_ALERT_MS = 15 * 60_000;
const RECENT_TERMINAL_LIQUIDATION_CASCADE_ALERT_MS = 15 * 60_000;

export function isAbneonPrimarySignalEventKey(
  eventKey?: string | null,
): boolean {
  return /^signal:\d+$/.test(eventKey ?? "");
}

export function isAbneonTrackedLifecycleEventKey(
  eventKey?: string | null,
): boolean {
  return /^(?:position|cancel|watcher:v1|track_signal:v1|milestone:v3):\d+(?::|$)/.test(
    eventKey ?? "",
  );
}

export function isStealthPrimarySignalEventKey(
  eventKey?: string | null,
): boolean {
  return /^signal(?:-resend)?:\d+(?::|$)/.test(eventKey ?? "");
}

export function isLiquidationCascadePrimarySignalEventKey(
  eventKey?: string | null,
): boolean {
  return /^signal:\d+$/.test(eventKey ?? "");
}

export function isStealthTrackedLifecycleEventKey(
  eventKey?: string | null,
): boolean {
  return /^(?:position|cancel|watcher:v1|track_signal:v1|milestone:v3):\d+(?::|$)/.test(
    eventKey ?? "",
  );
}

export function isEligibleStealthPrimaryTelegramEvent(input: {
  eventKey?: string | null;
  sentimentKey: string;
  status: string;
  detectedAt: Date;
  updatedAt: Date;
  nowMs?: number;
}): boolean {
  if (
    !isStealthPrimarySignalEventKey(input.eventKey) ||
    input.sentimentKey !== "stealth_breakout"
  ) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const detectedAgeMs = nowMs - input.detectedAt.getTime();
  if (
    detectedAgeMs < -5_000 ||
    detectedAgeMs > STEALTH_PRIMARY_ALERT_MAX_AGE_MS
  ) {
    return false;
  }
  if (input.status === "reclassified" || input.status === "cancelled") {
    return false;
  }
  if (input.status === "active" || input.status === "in_run") return true;

  const terminalAgeMs = nowMs - input.updatedAt.getTime();
  return (
    terminalAgeMs >= 0 && terminalAgeMs <= RECENT_TERMINAL_STEALTH_ALERT_MS
  );
}

export function isEligibleAbneonPrimaryTelegramEvent(input: {
  eventKey?: string | null;
  sentimentKey: string;
  status: string;
  detectedAt: Date;
  updatedAt: Date;
  nowMs?: number;
}): boolean {
  if (
    !isAbneonPrimarySignalEventKey(input.eventKey) ||
    input.sentimentKey !== "neon_support_bounce"
  ) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const detectedAgeMs = nowMs - input.detectedAt.getTime();
  if (
    detectedAgeMs < -5_000 ||
    detectedAgeMs > ABNEON_PRIMARY_ALERT_MAX_AGE_MS
  ) {
    return false;
  }
  if (input.status === "reclassified" || input.status === "cancelled") {
    return false;
  }
  if (input.status === "active" || input.status === "in_run") return true;

  const terminalAgeMs = nowMs - input.updatedAt.getTime();
  return terminalAgeMs >= 0 && terminalAgeMs <= RECENT_TERMINAL_ABNEON_ALERT_MS;
}

export function isEligibleLiquidationCascadePrimaryTelegramEvent(input: {
  eventKey?: string | null;
  sentimentKey: string;
  status: string;
  detectedAt: Date;
  updatedAt: Date;
  nowMs?: number;
}): boolean {
  if (
    !isLiquidationCascadePrimarySignalEventKey(input.eventKey) ||
    input.sentimentKey !== "liquidation_cascade"
  ) {
    return false;
  }

  const nowMs = input.nowMs ?? Date.now();
  const detectedAgeMs = nowMs - input.detectedAt.getTime();
  if (
    detectedAgeMs < -5_000 ||
    detectedAgeMs > LIQUIDATION_CASCADE_PRIMARY_ALERT_MAX_AGE_MS
  ) {
    return false;
  }
  if (input.status === "reclassified" || input.status === "cancelled") {
    return false;
  }
  if (input.status === "active" || input.status === "in_run") return true;

  const terminalAgeMs = nowMs - input.updatedAt.getTime();
  return (
    terminalAgeMs >= 0 &&
    terminalAgeMs <= RECENT_TERMINAL_LIQUIDATION_CASCADE_ALERT_MS
  );
}

function isSystemRestartEvent(eventKey?: string | null): boolean {
  return (
    eventKey === "restart-notice" ||
    (eventKey ?? "").startsWith("restart-notification:")
  );
}

export function isWatchdogTelegramPhotoEvent(
  eventKey?: string | null,
): boolean {
  const key = eventKey ?? "";
  return (
    key.startsWith("watchdog:") ||
    key.startsWith("watchdog-restart:") ||
    key.startsWith("watchdog-restart-limit:")
  );
}

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

export function isTelegramMuted(eventKey?: string | null): boolean {
  return TELEGRAM_MUTED && !isSystemRestartEvent(eventKey);
}

export function isMutedTelegramMethod(
  method: string,
  eventKey?: string | null,
  allowImpulseBuyWhileMuted = false,
  allowAbneonPrimaryWhileMuted = false,
  allowAbneonTrackedLifecycleWhileMuted = false,
  allowStealthPrimaryWhileMuted = false,
  allowStealthTrackedLifecycleWhileMuted = false,
  allowLiquidationCascadePrimaryWhileMuted = false,
): boolean {
  return (
    SEND_METHODS.has(method) &&
    isTelegramMuted(eventKey) &&
    !allowImpulseBuyWhileMuted &&
    !(
      allowAbneonPrimaryWhileMuted && isAbneonPrimarySignalEventKey(eventKey)
    ) &&
    !(
      allowAbneonTrackedLifecycleWhileMuted &&
      isAbneonTrackedLifecycleEventKey(eventKey)
    ) &&
    !(
      allowStealthPrimaryWhileMuted && isStealthPrimarySignalEventKey(eventKey)
    ) &&
    !(
      allowStealthTrackedLifecycleWhileMuted &&
      isStealthTrackedLifecycleEventKey(eventKey)
    ) &&
    !(
      allowLiquidationCascadePrimaryWhileMuted &&
      isLiquidationCascadePrimarySignalEventKey(eventKey)
    ) &&
    !(method === "sendPhoto" && isWatchdogTelegramPhotoEvent(eventKey))
  );
}
