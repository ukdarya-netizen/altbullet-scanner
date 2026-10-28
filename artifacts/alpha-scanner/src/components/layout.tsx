import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  Users,
  Target,
  ScanSearch,
  BarChart3,
  Bug,
  HeartPulse,
  BookOpen,
  Eye,
  LogOut,
  Bitcoin,
  ChartCandlestick,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useGetScannerStatus,
  getGetScannerStatusQueryKey,
} from "@workspace/api-client-react";
import { useAuth } from "@/hooks/useAuth";
import { MobileBottomNav } from "@/components/mobile-bottom-nav";
import { useHorizontalWheelScroll } from "@/hooks/use-horizontal-wheel-scroll";
import { BrandLockup, BrandMark } from "@/components/brand";
import { BtcCrossAlertsSidebar } from "@/components/btc-cross-alerts-sidebar";
import {
  BTC_CROSS_ALERTS_UPDATED_EVENT,
  getBtcCrossAlerts,
  isBtcCrossAlertsStorageEvent,
  markBtcCrossAlertRead,
  notifyBtcCrossAlertsUpdated,
} from "@/lib/btc-cross-alerts";
import type { BtcCrossAlertsResponse } from "@/lib/btc-cross-alerts";

export function Layout({ children }: { children: React.ReactNode }) {
  useHorizontalWheelScroll();
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [pendingUsersCount, setPendingUsersCount] = useState(0);
  const [btcAlertsError, setBtcAlertsError] = useState<string | null>(null);
  const [btcAlerts, setBtcAlerts] = useState<BtcCrossAlertsResponse | null>(
    null,
  );
  const btcAlertsRequestVersion = useRef(0);
  const [btcAlertsLoading, setBtcAlertsLoading] = useState(false);
  const [btcAlertMarkError, setBtcAlertMarkError] = useState<string | null>(
    null,
  );
  const [markingBtcAlertId, setMarkingBtcAlertId] = useState<number | null>(
    null,
  );
  const { data: apiStatus } = useGetScannerStatus({
    query: { queryKey: getGetScannerStatusQueryKey(), refetchInterval: 30_000 },
  });

  useEffect(() => {
    if (!user) return;

    const heartbeat = () => {
      if (document.visibilityState !== "visible") return;
      const token = localStorage.getItem("authToken");
      if (!token) return;
      void fetch("/api/auth/heartbeat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {
        // Presence is informative; a temporary failure must not interrupt work.
      });
    };

    heartbeat();
    const interval = window.setInterval(heartbeat, 30_000);
    document.addEventListener("visibilitychange", heartbeat);
    window.addEventListener("focus", heartbeat);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", heartbeat);
      window.removeEventListener("focus", heartbeat);
    };
  }, [user]);

  useEffect(() => {
    if (user?.role !== "owner") {
      setPendingUsersCount(0);
      return;
    }

    const refreshPendingUsers = async () => {
      if (document.visibilityState !== "visible") return;
      const token = localStorage.getItem("authToken");
      if (!token) return;
      try {
        const response = await fetch("/api/admin/users/pending-count", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const data = (await response.json()) as { count?: number };
        setPendingUsersCount(
          Number.isFinite(data.count) ? Math.max(0, Number(data.count)) : 0,
        );
      } catch {
        // Keep the last known badge during a temporary network failure.
      }
    };

    void refreshPendingUsers();
    const interval = window.setInterval(refreshPendingUsers, 15_000);
    document.addEventListener("visibilitychange", refreshPendingUsers);
    window.addEventListener("focus", refreshPendingUsers);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshPendingUsers);
      window.removeEventListener("focus", refreshPendingUsers);
    };
  }, [user?.role, location]);

  useEffect(() => {
    if (user?.role !== "owner") {
      btcAlertsRequestVersion.current += 1;
      setBtcAlertsError(null);
      setBtcAlerts(null);
      setBtcAlertsLoading(false);
      setBtcAlertMarkError(null);
      return;
    }

    setBtcAlertsError(null);
    setBtcAlerts(null);
    setBtcAlertsLoading(true);
    const refreshBtcAlerts = async () => {
      if (document.visibilityState !== "visible") return;
      const requestVersion = ++btcAlertsRequestVersion.current;
      try {
        const response = await getBtcCrossAlerts();
        if (requestVersion !== btcAlertsRequestVersion.current) return;
        setBtcAlerts(response);
        setBtcAlertsError(null);
      } catch (cause) {
        if (requestVersion !== btcAlertsRequestVersion.current) return;
        setBtcAlertsError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить уведомления BTC",
        );
        // Preserve the last successful count during temporary API failures.
      } finally {
        if (requestVersion === btcAlertsRequestVersion.current) {
          setBtcAlertsLoading(false);
        }
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (isBtcCrossAlertsStorageEvent(event)) void refreshBtcAlerts();
    };

    void refreshBtcAlerts();
    const interval = window.setInterval(() => void refreshBtcAlerts(), 15_000);
    document.addEventListener("visibilitychange", refreshBtcAlerts);
    window.addEventListener("focus", refreshBtcAlerts);
    window.addEventListener(BTC_CROSS_ALERTS_UPDATED_EVENT, refreshBtcAlerts);
    window.addEventListener("storage", onStorage);
    return () => {
      btcAlertsRequestVersion.current += 1;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshBtcAlerts);
      window.removeEventListener("focus", refreshBtcAlerts);
      window.removeEventListener(
        BTC_CROSS_ALERTS_UPDATED_EVENT,
        refreshBtcAlerts,
      );
      window.removeEventListener("storage", onStorage);
    };
  }, [user?.role, user?.userId]);

  const markBtcAlertRead = async (id: number) => {
    setMarkingBtcAlertId(id);
    setBtcAlertMarkError(null);
    try {
      await markBtcCrossAlertRead(id);
      const readAt = new Date().toISOString();
      setBtcAlerts((current) =>
        current
          ? (() => {
              const event = current.events.find((item) => item.id === id);
              if (!event || event.readAt != null) return current;
              return {
                ...current,
                unreadCount: Math.max(0, current.unreadCount - 1),
                events: current.events.map((item) =>
                  item.id === id ? { ...item, readAt } : item,
                ),
              };
            })()
          : current,
      );
      notifyBtcCrossAlertsUpdated();
      const requestVersion = ++btcAlertsRequestVersion.current;
      try {
        const response = await getBtcCrossAlerts();
        if (requestVersion === btcAlertsRequestVersion.current) {
          setBtcAlerts(response);
          setBtcAlertsError(null);
        }
      } catch (cause) {
        if (requestVersion === btcAlertsRequestVersion.current) {
          const message =
            cause instanceof Error
              ? cause.message
              : "не удалось загрузить список уведомлений BTC";
          setBtcAlertsError(
            `Уведомление отмечено, но список не обновился: ${message}`,
          );
        }
        // Keep the optimistic read state; a later poll will retry.
      }
    } catch (cause) {
      setBtcAlertMarkError(
        cause instanceof Error
          ? cause.message
          : "Не удалось отметить уведомление BTC прочитанным",
      );
    } finally {
      setMarkingBtcAlertId(null);
    }
  };

  const navItems = [
    {
      href: "/tracker",
      label: "Открытые позиции",
      sub: "мониторинг ТП / стопов",
      icon: Target,
    },
    {
      href: "/",
      label: "Обзор",
      sub: "общая статистика",
      icon: Activity,
    },
    {
      href: "/candidates",
      label: "Сканер",
      sub: "кандидаты текущего цикла",
      icon: ScanSearch,
    },
    {
      href: "/charts",
      label: "Графики",
      sub: "свечи · Range · индикаторы",
      icon: ChartCandlestick,
    },
    {
      href: "/members",
      label: "Подписчики",
      sub: "дашборд + Telegram-бот",
      icon: Users,
      ownerOnly: true,
    },
    {
      href: "/analytics",
      label: "Аналитика",
      sub: "Лидеры роста, перегретые, история сигналов",
      icon: BarChart3,
      ownerOnly: true,
    },
    {
      href: "/pattern-debug",
      label: "PDB Агрегат",
      sub: "паттерны · checked / passed",
      icon: Bug,
      ownerOnly: true,
    },
    {
      href: "/bot-health",
      label: "Bot Health",
      sub: "статус джобов · CG · БД",
      icon: HeartPulse,
      ownerOnly: true,
    },
    {
      href: "/pattern-reference",
      label: "Справочник",
      sub: "идеи · назначение",
      icon: BookOpen,
    },
    {
      href: "/health-events",
      label: "Health & Outcomes",
      sub: "события · исходы отмен",
      icon: Eye,
      ownerOnly: true,
    },
    {
      href: "/btc",
      label: "BTC",
      sub: "контекст рынка · наблюдение",
      icon: Bitcoin,
    },
  ];

  const isDev = import.meta.env.DEV;

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground overflow-hidden">
      {isDev && (
        <div className="w-full bg-red-600 text-white text-sm font-medium text-center py-1.5 px-4 shrink-0 z-50">
          ⚠️ DEV среда — данные не реальные. Используй задеплоенный URL для
          реальных данных.
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — hidden on mobile, visible on md+ */}
        <aside className="hidden md:flex md:flex-col w-64 border-r border-border bg-sidebar/90 backdrop-blur">
          <div className="h-16 flex items-center px-5 border-b neon-edge bg-[linear-gradient(110deg,hsl(var(--neon-violet)/0.16),hsl(var(--neon-cyan)/0.05)_55%,transparent_80%)]">
            <BrandLockup />
          </div>

          <nav className="flex-1 py-4 px-3 space-y-0.5">
            {navItems
              .filter((item) => !item.ownerOnly || user?.role === "owner")
              .map((item) => {
                const isActive =
                  location === item.href ||
                  (item.href === "/charts" && location.startsWith("/charts/"));
                const Icon = item.icon;

                return (
                  <div
                    key={item.href}
                    className="relative flex items-center gap-1"
                  >
                    <Link href={item.href} className="block min-w-0 flex-1">
                      <div
                        className={cn(
                          "flex items-start px-3 py-2.5 text-sm font-medium transition-colors border border-transparent",
                          isActive
                            ? "rounded-md border-[hsl(var(--neon-violet)/0.45)] bg-[linear-gradient(100deg,hsl(var(--neon-violet)/0.20),hsl(var(--neon-cyan)/0.08))] text-foreground shadow-[0_0_12px_hsl(var(--neon-violet)/0.25)]"
                            : "rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="w-4 h-4 mr-3 mt-0.5 shrink-0" />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center justify-between gap-2">
                            <span>{item.label}</span>
                            {item.href === "/members" &&
                              pendingUsersCount > 0 && (
                                <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                                  +{pendingUsersCount}
                                </span>
                              )}
                          </span>
                          <span
                            className={cn(
                              "text-xs font-normal",
                              isActive
                                ? "text-[hsl(var(--neon-cyan)/0.8)]"
                                : "text-muted-foreground/60",
                            )}
                          >
                            {item.sub}
                          </span>
                          {(item.href === "/candidates" ||
                            item.href === "/charts") && (
                            <span className="mt-0.5 text-[11px] font-bold tracking-wide text-[#39ff14]">
                              {item.href === "/charts"
                                ? "Pro Snipers Only"
                                : "Pro Snipers ONLY"}
                            </span>
                          )}
                        </div>
                      </div>
                    </Link>
                    {item.href === "/btc" && user?.role === "owner" && (
                      <BtcCrossAlertsSidebar
                        alerts={btcAlerts}
                        loading={btcAlertsLoading}
                        error={btcAlertsError}
                        markError={btcAlertMarkError}
                        markingId={markingBtcAlertId}
                        onMarkRead={markBtcAlertRead}
                        placement="desktop"
                      />
                    )}
                  </div>
                );
              })}
          </nav>

          {/* User info + logout */}
          {user && (
            <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground truncate">
                  {user.name}
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  {user.email}
                </p>
              </div>
              <button
                onClick={logout}
                title="Выйти"
                className="shrink-0 p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="p-4 border-t border-border text-xs text-muted-foreground space-y-1.5">
            {(() => {
              const scannerRunning = apiStatus?.running;
              return (
                [
                  {
                    label: "BingX",
                    ok:
                      scannerRunning == null
                        ? undefined
                        : scannerRunning
                          ? apiStatus?.bingxConnected
                          : null,
                  },
                  {
                    label: "Telegram",
                    ok:
                      scannerRunning == null
                        ? undefined
                        : scannerRunning
                          ? apiStatus?.telegramConnected
                          : null,
                  },
                  { label: "CoinGlass", ok: apiStatus?.coinglassConnected },
                  { label: "Coinalyze", ok: apiStatus?.coinalyzeConnected },
                  { label: "CoinGecko", ok: apiStatus?.coinGeckoConnected },
                  { label: "CoinPaprika", ok: apiStatus?.coinPaprikaConnected },
                ] as { label: string; ok: boolean | null | undefined }[]
              ).map(({ label, ok }) => (
                <div key={label} className="flex items-center justify-between">
                  <span>{label}</span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${ok == null ? "bg-zinc-600" : ok ? "bg-green-500" : "bg-red-500"}`}
                    />
                    <span
                      className={
                        ok == null
                          ? "text-zinc-500"
                          : ok
                            ? "text-green-400"
                            : "text-red-400"
                      }
                    >
                      {ok == null
                        ? ok === undefined
                          ? "..."
                          : "—"
                        : ok
                          ? "OK"
                          : "ERR"}
                    </span>
                  </span>
                </div>
              ));
            })()}
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col h-full overflow-hidden">
          <header className="h-12 md:h-16 flex items-center justify-between px-4 md:px-8 border-b border-border bg-card/50">
            <div className="flex items-center gap-2.5 min-w-0">
              <BrandMark className="size-7 md:hidden" />
              <div className="min-w-0">
                <span className="block md:hidden text-[9px] uppercase tracking-[0.16em] text-muted-foreground">
                  Crypto Alt Bullet
                </span>
                <h1 className="truncate text-base md:text-xl font-semibold">
                  {navItems.find(
                    (item) =>
                      item.href === location ||
                      (item.href === "/charts" &&
                        location.startsWith("/charts/")),
                  )?.label || "Обзор"}
                </h1>
              </div>
            </div>
            <div className="hidden md:flex text-xs text-muted-foreground items-center space-x-4">
              <span>
                SYS_TIME: {new Date().toISOString().split("T")[1].split(".")[0]}{" "}
                UTC
              </span>
            </div>
          </header>

          <div className="flex-1 overflow-auto p-4 pb-20 md:p-8 bg-background">
            {children}
          </div>
        </main>
      </div>
      <MobileBottomNav
        pendingUsersCount={pendingUsersCount}
        btcAlertsUnreadCount={btcAlerts?.unreadCount ?? 0}
        btcAlertsError={btcAlertsError}
        btcAlerts={btcAlerts}
        btcAlertsLoading={btcAlertsLoading}
        btcAlertMarkError={btcAlertMarkError}
        markingBtcAlertId={markingBtcAlertId}
        onMarkBtcAlertRead={markBtcAlertRead}
      />
    </div>
  );
}
