import { useState } from "react";
import { Bell, Check } from "lucide-react";
import type {
  BtcCrossAlert,
  BtcCrossAlertsResponse,
} from "@/lib/btc-cross-alerts";

export function BtcCrossAlertsSidebar({
  alerts,
  loading,
  error,
  markError,
  markingId,
  onMarkRead,
  placement,
}: {
  alerts: BtcCrossAlertsResponse | null;
  loading: boolean;
  error: string | null;
  markError: string | null;
  markingId: number | null;
  onMarkRead: (id: number) => void;
  placement: "desktop" | "mobile";
}) {
  const [open, setOpen] = useState(false);
  const unreadCount = alerts?.unreadCount ?? 0;

  return (
    <div
      className={
        placement === "desktop"
          ? "relative shrink-0"
          : "border-t border-border/40 px-3 py-2"
      }
    >
      <button
        type="button"
        data-testid={`button-toggle-btc-alerts-${placement}`}
        aria-label={
          error && unreadCount === 0
            ? `Ошибка уведомлений BTC: ${error}`
            : `${unreadCount} непрочитанных BTC-уведомлений`
        }
        aria-expanded={open}
        aria-controls={`btc-alerts-${placement}`}
        title={error ?? "Уведомления о пересечении BTC"}
        onClick={() => setOpen((previous) => !previous)}
        className={
          placement === "desktop"
            ? "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            : "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        }
      >
        <Bell className="h-4 w-4 shrink-0" />
        {placement === "mobile" && <span>Уведомления BTC</span>}
        {unreadCount > 0 ? (
          <span
            className={
              placement === "desktop"
                ? "absolute -right-1 -top-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                : "ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
            }
            data-testid={`badge-${placement}-btc-cross-alerts`}
          >
            {unreadCount}
          </span>
        ) : error ? (
          <span
            className={
              placement === "desktop"
                ? "absolute -right-1 -top-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                : "ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
            }
            data-testid={`badge-${placement}-btc-alert-error`}
          >
            !
          </span>
        ) : null}
      </button>

      {open && (
        <section
          id={`btc-alerts-${placement}`}
          role="region"
          aria-label="Уведомления о пересечении BTC"
          data-testid={`panel-${placement}-btc-alerts`}
          className={
            placement === "desktop"
              ? "absolute left-full top-0 z-50 ml-2 max-h-[70vh] w-[min(22rem,calc(100vw-18rem))] overflow-y-auto rounded-md border border-border bg-card p-3 shadow-xl"
              : "mt-2 max-h-[42vh] overflow-y-auto rounded-md bg-background/50 p-2"
          }
        >
          {error && (
            <p
              className="mb-2 text-xs text-red-400"
              data-testid="status-btc-alerts-error"
            >
              {error}
            </p>
          )}
          {markError && (
            <p
              className="mb-2 text-xs text-red-400"
              data-testid="status-btc-alert-mark-error"
            >
              {markError}
            </p>
          )}
          {loading && !alerts && (
            <p className="py-2 text-xs text-muted-foreground">
              Загрузка уведомлений…
            </p>
          )}
          {alerts && alerts.events.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              Уведомлений о пересечении пока нет.
            </p>
          )}
          {alerts?.events.map((alert: BtcCrossAlert) => (
            <div
              key={alert.id}
              className="flex items-start justify-between gap-3 border-b border-border/50 py-2 last:border-b-0"
              data-testid={`row-sidebar-btc-alert-${alert.id}`}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-red-300">
                  {alert.direction === "btc_outperformed"
                    ? "BTC опередил BTC.D"
                    : alert.direction === "dominance_outperformed"
                      ? "BTC.D опередила BTC"
                      : alert.direction}
                  {" · "}
                  {alert.day} (Dubai)
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  BTC{" "}
                  {alert.btcPrice == null
                    ? "—"
                    : `$${alert.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                  {" · "}
                  BTC.D{" "}
                  {alert.btcDominance == null
                    ? "—"
                    : `${alert.btcDominance.toFixed(2)}%`}
                </p>
              </div>
              {alert.readAt == null ? (
                <button
                  type="button"
                  data-testid={`button-mark-btc-alert-read-${placement}-${alert.id}`}
                  disabled={markingId === alert.id}
                  onClick={() => onMarkRead(alert.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-red-500/30 px-2 py-1 text-[10px] text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check className="h-3 w-3" />
                  {markingId === alert.id ? "…" : "Отметить"}
                </button>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                  <Check className="h-3 w-3" />
                  Прочитано
                </span>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
