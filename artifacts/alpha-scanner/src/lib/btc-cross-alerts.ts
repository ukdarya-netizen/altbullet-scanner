export interface BtcCrossAlert {
  id: number;
  day: string;
  direction: string;
  btcPrice: number;
  btcDominance: number;
  readAt: string | null;
}

export interface BtcCrossAlertsResponse {
  unreadCount: number;
  events: BtcCrossAlert[];
}

export const BTC_CROSS_ALERTS_UPDATED_EVENT = "btc-cross-alerts-updated";
const BTC_CROSS_ALERTS_STORAGE_KEY = "btcCrossAlertsUpdatedAt";

export async function getBtcCrossAlerts(): Promise<BtcCrossAlertsResponse> {
  const token = localStorage.getItem("authToken");
  const response = await fetch("/api/btc-cross-alerts", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(
      `Не удалось загрузить уведомления BTC (${response.status})`,
    );
  }
  const result = (await response.json()) as BtcCrossAlertsResponse;
  if (!Number.isFinite(result.unreadCount) || !Array.isArray(result.events)) {
    throw new Error("Сервер вернул некорректный ответ уведомлений BTC");
  }
  return result;
}

export async function markBtcCrossAlertRead(id: number): Promise<void> {
  const token = localStorage.getItem("authToken");
  const response = await fetch(
    `/api/btc-cross-alerts/${encodeURIComponent(String(id))}/read`,
    {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );
  const result = (await response.json()) as { success?: boolean };
  if (!response.ok || result.success !== true) {
    throw new Error(`Не удалось отметить уведомление BTC (${response.status})`);
  }
}

export function notifyBtcCrossAlertsUpdated(): void {
  window.dispatchEvent(new Event(BTC_CROSS_ALERTS_UPDATED_EVENT));
  try {
    localStorage.setItem(BTC_CROSS_ALERTS_STORAGE_KEY, String(Date.now()));
  } catch {
    // Same-tab listeners still refresh if storage is unavailable.
  }
}

export function isBtcCrossAlertsStorageEvent(event: StorageEvent): boolean {
  return event.key === BTC_CROSS_ALERTS_STORAGE_KEY;
}
