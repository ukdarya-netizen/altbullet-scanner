export const STATUS_LABELS = {
  active: "ACTIVE",
  in_run: "IN RUN",
  profit: "PROFIT",
  stop_loss: "STOP LOSS",
  bu_stop: "BE STOP",
  expired: "EXPIRED",
  cancelled: "CANCELLED",
  reclassified: "RECLASSIFIED",
} as const;

export const STATUS_ICONS = {
  active: "🟡",
  in_run: "🚀",
  profit: "✅",
  stop_loss: "❌",
  bu_stop: "🎯",
  expired: "⌛",
  cancelled: "🚫",
  reclassified: "↪️",
} as const;

export type TrackedStatus = keyof typeof STATUS_LABELS;

export const OPEN_USER_STATUS_KEYS = [
  "active",
  "in_run",
] as const satisfies readonly TrackedStatus[];

export const CLOSED_USER_STATUS_KEYS = [
  "profit",
  "bu_stop",
  "expired",
  "stop_loss",
  "cancelled",
] as const satisfies readonly TrackedStatus[];

export const USER_STATUS_KEYS = [
  ...OPEN_USER_STATUS_KEYS,
  ...CLOSED_USER_STATUS_KEYS,
] as const;

export function getStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return (
    STATUS_LABELS[status as TrackedStatus] ??
    status.replaceAll("_", " ").toUpperCase()
  );
}

export function getStatusIcon(status: string | null | undefined): string {
  return STATUS_ICONS[status as TrackedStatus] ?? "";
}
