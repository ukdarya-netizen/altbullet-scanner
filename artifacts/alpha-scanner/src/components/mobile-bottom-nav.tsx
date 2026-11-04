import { useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Target,
  Activity,
  ScanSearch,
  Users,
  BarChart3,
  Bug,
  HeartPulse,
  BookOpen,
  Eye,
  MoreHorizontal,
  X,
  Bitcoin,
  ChartCandlestick,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getStoredUser } from "@/hooks/useAuth";
import { BtcCrossAlertsSidebar } from "@/components/btc-cross-alerts-sidebar";
import type { BtcCrossAlertsResponse } from "@/lib/btc-cross-alerts";

// Fixed items always visible in the bottom bar
const PRIMARY_NAV = [
  { href: "/tracker", label: "Позиции", icon: Target },
  { href: "/overview", label: "Обзор", icon: Activity },
];

// All possible nav items (same list as desktop sidebar)
const ALL_NAV = [
  { href: "/tracker", label: "Открытые позиции", icon: Target },
  { href: "/overview", label: "Обзор", icon: Activity },
  { href: "/candidates", label: "Сканер", icon: ScanSearch },
  { href: "/charts", label: "Графики", icon: ChartCandlestick },
  { href: "/pattern-reference", label: "Справочник", icon: BookOpen },
  {
    href: "/members",
    label: "Подписчики",
    icon: Users,
    ownerOnly: true as const,
  },
  {
    href: "/analytics",
    label: "Аналитика",
    icon: BarChart3,
    ownerOnly: true as const,
  },
  {
    href: "/pattern-debug",
    label: "PDB Агрегат",
    icon: Bug,
    ownerOnly: true as const,
  },
  {
    href: "/bot-health",
    label: "Bot Health",
    icon: HeartPulse,
    ownerOnly: true as const,
  },
  {
    href: "/health-events",
    label: "Health & Outcomes",
    icon: Eye,
    ownerOnly: true as const,
  },
  {
    href: "/btc",
    label: "BTC",
    icon: Bitcoin,
  },
];

export function MobileBottomNav({
  pendingUsersCount = 0,
  btcAlertsUnreadCount = 0,
  btcAlertsError = null,
  btcAlerts = null,
  btcAlertsLoading = false,
  btcAlertMarkError = null,
  markingBtcAlertId = null,
  onMarkBtcAlertRead = () => {},
}: {
  pendingUsersCount?: number;
  btcAlertsUnreadCount?: number;
  btcAlertsError?: string | null;
  btcAlerts?: BtcCrossAlertsResponse | null;
  btcAlertsLoading?: boolean;
  btcAlertMarkError?: string | null;
  markingBtcAlertId?: number | null;
  onMarkBtcAlertRead?: (id: number) => void;
}) {
  const [location] = useLocation();
  const [showMore, setShowMore] = useState(false);
  const user = getStoredUser();

  const visibleNav = ALL_NAV.filter(
    (item) => !item.ownerOnly || user?.role === "owner",
  );

  // Items shown in "more" panel = everything not in the primary bar
  const moreItems = visibleNav.filter(
    (item) => !PRIMARY_NAV.some((p) => p.href === item.href),
  );

  const anyMoreActive = moreItems.some(
    (item) =>
      item.href === location ||
      (item.href === "/charts" && location.startsWith("/charts/")),
  );

  return (
    <>
      {/* More overlay — covers entire screen, tap outside to close */}
      {showMore && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-background/80 backdrop-blur-sm"
          onClick={() => setShowMore(false)}
        >
          <div
            className="absolute bottom-16 left-0 right-0 max-h-[78vh] overflow-y-auto bg-card border-t border-border"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/50">
              <span className="text-xs font-semibold text-muted-foreground tracking-wider">
                ВСЕ РАЗДЕЛЫ
              </span>
              <button
                onClick={() => setShowMore(false)}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Закрыть меню"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="py-1">
              {moreItems.map(({ href, label, icon: Icon }) => {
                const isActive =
                  location === href ||
                  (href === "/charts" && location.startsWith("/charts/"));
                return (
                  <div
                    key={href}
                    className={href === "/btc" ? "w-full" : undefined}
                  >
                    <div className="flex items-center">
                      <Link
                        href={href}
                        onClick={() => setShowMore(false)}
                        className="min-w-0 flex-1"
                      >
                        <div
                          className={cn(
                            "flex items-center gap-3 px-4 py-3 text-sm transition-colors",
                            isActive
                              ? "text-primary bg-primary/10"
                              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                          )}
                        >
                          <Icon className="w-4 h-4 shrink-0" />
                          <span className="flex flex-1 items-center justify-between gap-2">
                            <span className="flex flex-col">
                              <span>{label}</span>
                              {href === "/charts" && (
                                <span className="mt-0.5 text-[10px] font-bold tracking-wide text-[#39ff14]">
                                  Pro Snipers Only
                                </span>
                              )}
                            </span>
                            {href === "/members" && pendingUsersCount > 0 && (
                              <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                                +{pendingUsersCount}
                              </span>
                            )}
                          </span>
                        </div>
                      </Link>
                    </div>
                    {href === "/btc" && user?.role === "owner" && (
                      <BtcCrossAlertsSidebar
                        alerts={btcAlerts}
                        loading={btcAlertsLoading}
                        error={btcAlertsError}
                        markError={btcAlertMarkError}
                        markingId={markingBtcAlertId}
                        onMarkRead={onMarkBtcAlertRead}
                        placement="mobile"
                      />
                    )}
                  </div>
                );
              })}
            </nav>
          </div>
        </div>
      )}

      {/* Bottom navigation bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border"
        style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      >
        <div className="flex">
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const isActive = location === href && !showMore;
            return (
              <Link
                key={href}
                href={href}
                className="flex-1"
                onClick={() => setShowMore(false)}
              >
                <div
                  className={cn(
                    "flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                    isActive ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "w-5 h-5 transition-colors",
                      isActive ? "text-primary" : "text-muted-foreground/70",
                    )}
                  />
                  <span>{label}</span>
                </div>
              </Link>
            );
          })}

          {/* "More" button opens the full section list */}
          <button
            className="relative flex-1"
            onClick={() => setShowMore(!showMore)}
          >
            <div
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium transition-colors",
                showMore || anyMoreActive
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
            >
              <MoreHorizontal
                className={cn(
                  "w-5 h-5 transition-colors",
                  showMore || anyMoreActive
                    ? "text-primary"
                    : "text-muted-foreground/70",
                )}
              />
              <span>Ещё</span>
              {pendingUsersCount +
                (user?.role === "owner" ? btcAlertsUnreadCount : 0) >
                0 && (
                <span className="absolute right-[calc(50%-18px)] top-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white">
                  +
                  {pendingUsersCount +
                    (user?.role === "owner" ? btcAlertsUnreadCount : 0)}
                </span>
              )}
              {user?.role === "owner" &&
                btcAlertsError &&
                pendingUsersCount + btcAlertsUnreadCount === 0 && (
                  <span
                    className="absolute right-[calc(50%-18px)] top-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-[9px] font-bold leading-none text-white"
                    data-testid="badge-mobile-more-btc-alert-error"
                    title={btcAlertsError}
                  >
                    !
                  </span>
                )}
            </div>
          </button>
        </div>
      </nav>
    </>
  );
}
