import { useState, useEffect, useCallback, type ElementType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  useGetSubscriberStats,
  getGetSubscriberStatsQueryKey,
} from "@workspace/api-client-react";
import {
  Users,
  UserCheck,
  Clock,
  Ban,
  Search,
  X,
  Loader2,
  Check,
  Trash2,
  Bot,
  Monitor,
  KeyRound,
  Eye,
  EyeOff,
  PowerOff,
  ArrowUpDown,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type MemberSource = "both" | "dashboard" | "bot";
type MemberAccessStatus =
  | "active"
  | "expired"
  | "inactive"
  | "pending"
  | "blocked";
type MemberBotAccessStatus = "active" | "expired" | "inactive" | "blocked";

interface Member {
  source: MemberSource;
  dashboardId: number | null;
  chatId: string | number | null;
  name: string | null;
  email: string | null;
  dashboardStatus: "pending" | "approved" | "expired" | "blocked" | null;
  botAccessStatus: MemberBotAccessStatus | null;
  accessStatus: MemberAccessStatus;
  telegramUsername: string | null;
  lastLoginAt: string | null;
  lastActivityAt: string | null;
  dashboardOnline: boolean;
  createdAt: string | null;
  approvedAt: string | null;
  botActive: boolean | null;
  botBlockedAt: string | null;
  botBlockedReason: string | null;
  subscribedAt: string | null;
  firstName: string | null;
  lastName: string | null;
  subscribedUntil: string | null;
  dashboardSubscribedUntil: string | null;
  botSubscribedUntil: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SUBSCRIPTION_TIME_ZONE = "Asia/Dubai";

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("authToken") ?? "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: SUBSCRIPTION_TIME_ZONE,
  });
}

function fmtLastActivity(s: string | null): string {
  if (!s) return "ещё не входил(а)";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(s).getTime()) / 1000),
  );
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин. назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч. назад`;
  return fmtDateTime(s);
}

function fmtTimeLeft(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = new Date(s).getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function getSubscriptionMonths(member: Member): number {
  if (!member.subscribedUntil) return 0;
  const start = member.subscribedAt ?? member.approvedAt ?? member.createdAt;
  if (!start) return 0;

  const durationMs =
    new Date(member.subscribedUntil).getTime() - new Date(start).getTime();
  return Math.max(0, durationMs / (365.2425 / 12) / 24 / 60 / 60 / 1000);
}

function fmtSubscriptionMonths(member: Member): string {
  const months = getSubscriptionMonths(member);
  if (months <= 0) return "не задан";
  return `${(Math.round(months * 10) / 10).toLocaleString("ru-RU", {
    maximumFractionDigits: 1,
  })} мес.`;
}

function toDateTimeInput(s: string | null | undefined): string {
  if (!s) return "";
  const date = new Date(s);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SUBSCRIPTION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Stable display name for a member
function memberName(m: Member): string {
  if (m.name) return m.name;
  const parts = [m.firstName, m.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (m.telegramUsername) return `@${m.telegramUsername}`;
  return `Chat ID ${m.chatId ?? m.dashboardId ?? "?"}`;
}

function getSourceStatusLabel(member: Member): string {
  if (member.source === "dashboard") {
    if (member.dashboardStatus === "pending")
      return "Только Dashboard · ожидает";
    if (member.dashboardStatus === "blocked")
      return "Только Dashboard · заблокирован";
    if (member.dashboardStatus === "expired")
      return "Только Dashboard · подписка истекла";
    return "Только Dashboard · подписка активна";
  }

  if (member.source === "bot") {
    if (member.botAccessStatus === "blocked")
      return "Только бот · пользователь заблокировал бота";
    if (member.botAccessStatus === "expired")
      return "Только бот · подписка истекла";
    if (member.botAccessStatus === "inactive") return "Только бот · отключён";
    return "Только бот · подписка активна";
  }

  if (member.botAccessStatus === "blocked")
    return "Dashboard активен · бот заблокирован пользователем";
  if (member.dashboardStatus === "blocked")
    return "Dashboard + бот · доступ заблокирован";
  if (member.dashboardStatus === "pending")
    return "Dashboard + бот · ожидает одобрения";
  if (member.dashboardStatus === "approved")
    return "Dashboard + бот · подписка активна";
  if (member.dashboardStatus === "expired")
    return "Dashboard + бот · подписка истекла";
  return "Dashboard + бот · доступ неактивен";
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

function MemberRow({
  member,
  onRefresh,
}: {
  member: Member;
  onRefresh: () => void;
}) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [dateVal, setDateVal] = useState(
    toDateTimeInput(member.subscribedUntil),
  );
  const [dateSaving, setDateSaving] = useState(false);

  // ── reset password dialog ──────────────────────────────────────────────────
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPw, setResetPw] = useState("");
  const [resetPwConfirm, setResetPwConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [showPwConfirm, setShowPwConfirm] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSaving, setResetSaving] = useState(false);

  const openResetDialog = () => {
    setResetPw("");
    setResetPwConfirm("");
    setResetError(null);
    setShowPw(false);
    setShowPwConfirm(false);
    setResetOpen(true);
  };

  const doResetPassword = async () => {
    if (resetPw.length < 6) {
      setResetError("Минимум 6 символов");
      return;
    }
    if (resetPw !== resetPwConfirm) {
      setResetError("Пароли не совпадают");
      return;
    }
    setResetError(null);
    setResetSaving(true);
    try {
      const res = await fetch(`/api/admin/users/${member.dashboardId}`, {
        method: "PATCH",
        headers: getAuthHeader(),
        body: JSON.stringify({ newPassword: resetPw }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setResetError(data.error ?? "Ошибка сервера");
      } else {
        setResetOpen(false);
      }
    } catch {
      setResetError("Ошибка сети");
    }
    setResetSaving(false);
  };

  useEffect(() => {
    setDateVal(toDateTimeInput(member.subscribedUntil));
  }, [member.subscribedUntil]);

  const isExpired =
    member.dashboardStatus === "expired" ||
    (member.dashboardStatus === null && member.botAccessStatus === "expired");

  // ── action: approve / block / deactivate / delete ────────────────────────

  const doAction = async (
    action: "approve" | "block" | "deactivate" | "delete",
  ) => {
    setActionLoading(action);
    try {
      // Default subscription period: 1 calendar month from now
      const oneMonthLater =
        action === "approve"
          ? (() => {
              const d = new Date();
              d.setMonth(d.getMonth() + 1);
              return d.toISOString();
            })()
          : undefined;

      let res: Response | null = null;

      if (member.chatId) {
        // Unified endpoint — affects both tables
        const method = action === "delete" ? "DELETE" : "PATCH";
        res = await fetch(`/api/admin/members/${member.chatId}`, {
          method,
          headers: getAuthHeader(),
          ...(action !== "delete"
            ? {
                body: JSON.stringify({
                  action,
                  ...(oneMonthLater ? { subscribedUntil: oneMonthLater } : {}),
                }),
              }
            : {}),
        });
      } else if (member.dashboardId) {
        // Dashboard-only member
        if (action === "delete") {
          res = await fetch(`/api/admin/users/${member.dashboardId}`, {
            method: "DELETE",
            headers: getAuthHeader(),
          });
        } else {
          const dashStatus =
            action === "approve"
              ? "approved"
              : action === "deactivate"
                ? "expired"
                : "blocked";
          res = await fetch(`/api/admin/users/${member.dashboardId}`, {
            method: "PATCH",
            headers: getAuthHeader(),
            body: JSON.stringify({
              status: dashStatus,
              ...(oneMonthLater ? { subscribedUntil: oneMonthLater } : {}),
            }),
          });
        }
      }

      if (res && !res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(
          `Ошибка (${res.status}): ${(body as { error?: string }).error ?? "неизвестная ошибка"}`,
        );
        setActionLoading(null);
        return;
      }

      onRefresh();
    } catch (err) {
      alert(`Сетевая ошибка: ${String(err)}`);
    }
    setActionLoading(null);
  };

  // ── subscription date save ─────────────────────────────────────────────────

  const saveDate = async (val: string) => {
    setDateSaving(true);
    try {
      const parsed = val ? new Date(`${val}:00+04:00`) : null;
      const serialized =
        parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
      if (member.chatId) {
        await fetch(`/api/admin/members/${member.chatId}`, {
          method: "PATCH",
          headers: getAuthHeader(),
          body: JSON.stringify({ subscribedUntil: serialized }),
        });
      } else if (member.dashboardId) {
        await fetch(`/api/admin/users/${member.dashboardId}`, {
          method: "PATCH",
          headers: getAuthHeader(),
          body: JSON.stringify({ subscribedUntil: serialized }),
        });
      }
      onRefresh();
    } catch {
      /* ignore */
    }
    setDateSaving(false);
  };

  // ── source badges ──────────────────────────────────────────────────────────

  const dashboardIsExpired = member.dashboardStatus === "expired";

  const dashboardBadge = dashboardIsExpired ? (
    <Badge
      variant="outline"
      className="text-red-400 border-red-500/30 bg-red-500/10 gap-1 text-xs"
    >
      <Clock className="w-3 h-3" /> Dashboard: подписка истекла
    </Badge>
  ) : member.dashboardStatus === "approved" ? (
    <Badge
      variant="outline"
      className="text-green-500 border-green-500/30 bg-green-500/10 gap-1 text-xs"
    >
      <Monitor className="w-3 h-3" /> Dashboard: активен
    </Badge>
  ) : member.dashboardStatus === "pending" ? (
    <Badge
      variant="outline"
      className="text-amber-500 border-amber-500/30 bg-amber-500/10 gap-1 text-xs"
    >
      <Clock className="w-3 h-3" /> Dashboard: ожидает
    </Badge>
  ) : member.dashboardStatus === "blocked" ? (
    <Badge
      variant="outline"
      className="text-red-500 border-red-500/30 bg-red-500/10 gap-1 text-xs"
    >
      <Ban className="w-3 h-3" /> Dashboard: заблокирован
    </Badge>
  ) : null;

  const botBadge =
    member.botAccessStatus === "blocked" ? (
      <Badge
        variant="outline"
        className="text-red-500 border-red-500/40 bg-red-500/10 gap-1 text-xs"
        title={[
          member.botBlockedReason,
          member.botBlockedAt
            ? `Зафиксировано: ${fmtDateTime(member.botBlockedAt)}`
            : null,
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <Ban className="w-3 h-3" /> Пользователь заблокировал бота — Dashboard
        остановлен
      </Badge>
    ) : member.botAccessStatus === "active" ? (
      <Badge
        variant="outline"
        className="text-blue-400 border-blue-400/30 bg-blue-400/10 gap-1 text-xs"
      >
        <Bot className="w-3 h-3" /> Бот: подписка активна
      </Badge>
    ) : member.botAccessStatus === "expired" ? (
      <Badge
        variant="outline"
        className="text-red-400 border-red-500/30 bg-red-500/10 gap-1 text-xs"
      >
        <Clock className="w-3 h-3" /> Бот: подписка истекла
      </Badge>
    ) : member.botAccessStatus === "inactive" ? (
      <Badge
        variant="outline"
        className="text-muted-foreground border-border gap-1 text-xs"
      >
        <Bot className="w-3 h-3" /> Бот: отключён
      </Badge>
    ) : null;

  const presenceBadge =
    member.dashboardId == null ? (
      <Badge
        variant="outline"
        className="text-muted-foreground border-border gap-1 text-xs"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
        Нет dashboard
      </Badge>
    ) : member.dashboardOnline ? (
      <Badge
        variant="outline"
        className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10 gap-1 text-xs"
        title={`Активность: ${fmtDateTime(member.lastActivityAt)}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Онлайн
      </Badge>
    ) : (
      <Badge
        variant="outline"
        className="text-muted-foreground border-border gap-1 text-xs"
        title={
          member.lastActivityAt
            ? `Активность: ${fmtDateTime(member.lastActivityAt)}`
            : "Пользователь ещё не открывал dashboard"
        }
      >
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
        Не в сети
      </Badge>
    );

  const canApprove =
    dashboardIsExpired ||
    member.dashboardStatus !== "approved" ||
    member.botActive === false;
  const canBlock =
    member.dashboardStatus !== "blocked" || member.botActive === true;
  const canDeactivate =
    member.dashboardStatus === "approved" || member.botActive === true;

  return (
    <div className="py-3 px-4 hover:bg-muted/40 transition-colors">
      <div className="flex items-start gap-3">
        {/* Info block */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{memberName(member)}</p>
          {member.email && (
            <p className="text-xs text-muted-foreground truncate">
              {member.email}
            </p>
          )}
          <p className="text-xs text-muted-foreground/70 font-mono truncate">
            {[
              member.telegramUsername ? `@${member.telegramUsername}` : null,
              member.chatId ? `ID ${member.chatId}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </p>
        </div>

        {/* Dates (hidden on mobile) */}
        <div className="hidden sm:flex flex-col items-end text-xs text-muted-foreground gap-0.5 shrink-0">
          <span>Регистрация: {fmtDateTime(member.createdAt)}</span>
          <span
            className={
              member.lastLoginAt
                ? "text-foreground/80"
                : "text-muted-foreground"
            }
          >
            Последний вход:{" "}
            {member.lastLoginAt
              ? fmtDateTime(member.lastLoginAt)
              : member.dashboardId == null
                ? "нет входа в Dashboard"
                : "ещё не входил(а)"}
          </span>
          {member.dashboardId != null && (
            <span>Активность: {fmtLastActivity(member.lastActivityAt)}</span>
          )}
        </div>

        {/* Status badges */}
        <div className="flex flex-col gap-1 shrink-0 items-end">
          {dashboardBadge}
          {presenceBadge}
          {botBadge}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {canApprove && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-green-500 hover:text-green-400 hover:bg-green-500/10"
              onClick={() => doAction("approve")}
              disabled={!!actionLoading}
              title="Одобрить"
            >
              {actionLoading === "approve" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          {canBlock && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-amber-500 hover:text-amber-400 hover:bg-amber-500/10"
              onClick={() => doAction("block")}
              disabled={!!actionLoading}
              title="Заблокировать"
            >
              {actionLoading === "block" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          {member.dashboardId != null && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-sky-400 hover:text-sky-300 hover:bg-sky-500/10"
              onClick={openResetDialog}
              disabled={!!actionLoading}
              title="Сбросить пароль"
            >
              <KeyRound className="w-3.5 h-3.5" />
            </Button>
          )}
          {canDeactivate && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-orange-500 hover:text-orange-400 hover:bg-orange-500/10"
              onClick={() => {
                if (
                  window.confirm(
                    `Деактивировать «${memberName(member)}»?\nДоступ будет закрыт, но пользователь сможет повторно запросить его.`,
                  )
                )
                  void doAction("deactivate");
              }}
              disabled={!!actionLoading}
              title="Деактивировать"
            >
              {actionLoading === "deactivate" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <PowerOff className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="w-7 h-7 text-red-500 hover:text-red-400 hover:bg-red-500/10"
            onClick={() => {
              if (
                window.confirm(
                  `Удалить «${memberName(member)}» из Dashboard?\nЭто действие нельзя отменить.`,
                )
              )
                void doAction("delete");
            }}
            disabled={!!actionLoading}
            title="Удалить из Dashboard"
          >
            {actionLoading === "delete" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Subscription date row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
        <span className="text-xs text-foreground/80 font-mono shrink-0">
          Срок: {fmtSubscriptionMonths(member)}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">
          Подписка (Дубай): с{" "}
          <span className="text-foreground/80">
            {fmtDateTime(
              member.subscribedAt ?? member.approvedAt ?? member.createdAt,
            )}
          </span>
          {" · "}до:
        </span>
        <input
          type="datetime-local"
          value={dateVal}
          onChange={(e) => setDateVal(e.target.value)}
          onBlur={(e) => void saveDate(e.target.value)}
          className={`text-xs h-7 px-1.5 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring font-mono
            ${isExpired ? "border-red-500/50 text-red-400" : dateVal ? "border-green-500/40 text-green-400" : "border-border text-muted-foreground"}`}
        />
        {dateSaving && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        )}
        {dateVal && !dateSaving && (
          <button
            className="text-muted-foreground hover:text-destructive"
            onClick={() => {
              setDateVal("");
              void saveDate("");
            }}
            title="Очистить"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        {dateVal && !isExpired && !dateSaving && (
          <span className="text-xs text-green-500">
            ✓ активна
            {(() => {
              const left = fmtTimeLeft(member.subscribedUntil);
              return left ? (
                <span className="text-muted-foreground ml-1">· ещё {left}</span>
              ) : null;
            })()}
          </span>
        )}
        {isExpired && <span className="text-xs text-red-400">истекла</span>}
        {/* Source tags */}
        <span
          className={[
            "ml-auto text-xs",
            member.accessStatus === "active"
              ? "text-green-400"
              : member.accessStatus === "expired"
                ? "text-red-400"
                : member.accessStatus === "blocked"
                  ? "text-red-500"
                  : member.accessStatus === "pending"
                    ? "text-amber-400"
                    : "text-muted-foreground",
          ].join(" ")}
        >
          {getSourceStatusLabel(member)}
        </span>
      </div>

      {/* Reset password dialog */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-sky-400" />
              Сброс пароля
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Пользователь:{" "}
            <span className="text-foreground font-medium">
              {memberName(member)}
            </span>
          </p>
          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor={`pw-${member.dashboardId}`}>Новый пароль</Label>
              <div className="relative">
                <Input
                  id={`pw-${member.dashboardId}`}
                  type={showPw ? "text" : "password"}
                  value={resetPw}
                  onChange={(e) => {
                    setResetPw(e.target.value);
                    setResetError(null);
                  }}
                  placeholder="Минимум 6 символов"
                  className="pr-9"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPw((v) => !v)}
                  tabIndex={-1}
                >
                  {showPw ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`pw2-${member.dashboardId}`}>
                Повторите пароль
              </Label>
              <div className="relative">
                <Input
                  id={`pw2-${member.dashboardId}`}
                  type={showPwConfirm ? "text" : "password"}
                  value={resetPwConfirm}
                  onChange={(e) => {
                    setResetPwConfirm(e.target.value);
                    setResetError(null);
                  }}
                  placeholder="Повторите пароль"
                  className="pr-9"
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void doResetPassword();
                  }}
                />
                <button
                  type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPwConfirm((v) => !v)}
                  tabIndex={-1}
                >
                  {showPwConfirm ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
            {resetError && (
              <p className="text-xs text-destructive">{resetError}</p>
            )}
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetOpen(false)}
              disabled={resetSaving}
            >
              Отмена
            </Button>
            <Button
              size="sm"
              onClick={() => void doResetPassword()}
              disabled={resetSaving || !resetPw || !resetPwConfirm}
            >
              {resetSaving ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                <KeyRound className="w-3.5 h-3.5 mr-1.5" />
              )}
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Members() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<
    "newest" | "oldest" | "months-desc" | "months-asc"
  >("newest");
  const [statusFilter, setStatusFilter] = useState<"all" | MemberAccessStatus>(
    "all",
  );
  const { data: subscriberStats } = useGetSubscriberStats({
    query: {
      queryKey: getGetSubscriberStatsQueryKey(),
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    },
  });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/members", {
        headers: getAuthHeader(),
      });
      if (res.ok) setMembers(await res.json());
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const q = search.trim().toLowerCase().replace(/^@/, "");
  const filtered = members
    .filter((m) => {
      if (statusFilter !== "all" && m.accessStatus !== statusFilter)
        return false;
      if (!q) return true;
      return (
        (m.chatId && String(m.chatId).includes(q)) ||
        (m.email ?? "").toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q) ||
        (m.telegramUsername ?? "").toLowerCase().includes(q) ||
        (m.firstName ?? "").toLowerCase().includes(q) ||
        (m.lastName ?? "").toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (sortMode === "newest") return tb - ta;
      if (sortMode === "oldest") return ta - tb;
      const monthDelta = getSubscriptionMonths(a) - getSubscriptionMonths(b);
      if (monthDelta !== 0) {
        return sortMode === "months-desc" ? -monthDelta : monthDelta;
      }
      return tb - ta;
    });

  const total = members.length;
  const _botActive = members.filter((m) => m.botActive === true).length;
  const active = members.filter((m) => m.accessStatus === "active").length;
  const pending = members.filter((m) => m.accessStatus === "pending").length;
  const expired = members.filter((m) => m.accessStatus === "expired").length;
  const inactive = members.filter((m) => m.accessStatus === "inactive").length;
  const blocked = members.filter((m) => m.accessStatus === "blocked").length;
  const _onlineNow = members.filter((m) => m.dashboardOnline).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold tracking-wider">УЧАСТНИКИ</h2>
        <p className="text-xs text-muted-foreground">
          Единый список — дашборд + Telegram-бот
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(
          [
            {
              filter: "all" as const,
              label: "Всего",
              value: total,
              icon: Users,
              color: "text-foreground",
              ring: "ring-foreground/30",
            },
            {
              filter: "active" as const,
              label: "Доступ активен",
              value: active,
              icon: UserCheck,
              color: "text-green-500",
              ring: "ring-green-500/40",
            },
            {
              filter: "expired" as const,
              label: "Подписка истекла",
              value: expired,
              icon: Clock,
              color: "text-orange-400",
              ring: "ring-orange-400/40",
            },
            {
              filter: "inactive" as const,
              label: "Неактивны",
              value: inactive,
              icon: PowerOff,
              color: "text-muted-foreground",
              ring: "ring-muted-foreground/40",
            },
            {
              filter: "blocked" as const,
              label: "Заблокированные",
              value: blocked,
              icon: Ban,
              color: "text-red-500",
              ring: "ring-red-500/40",
            },
          ] as {
            filter: typeof statusFilter;
            label: string;
            value: number;
            icon: ElementType;
            color: string;
            ring: string;
          }[]
        ).map(({ filter, label, value, icon: Icon, color, ring }) => {
          const isActive = statusFilter === filter;
          return (
            <button
              key={label}
              onClick={() => setStatusFilter(filter)}
              className={[
                "bg-card border p-4 text-left transition-all",
                isActive
                  ? `border-transparent ring-1 ${ring}`
                  : "border-border hover:border-border/80",
              ].join(" ")}
            >
              <div className={`flex items-center gap-2 ${color} mb-1`}>
                <Icon className="w-4 h-4" />
                <span className="text-xs font-mono uppercase">{label}</span>
              </div>
              <p className="text-2xl font-bold">{value}</p>
            </button>
          );
        })}
        <Card className="border-violet-500/20 bg-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-violet-400 mb-1">
              <Users className="w-4 h-4" />
              <span className="text-xs font-mono uppercase">Подписчиков</span>
            </div>
            <p className="text-2xl font-bold">{subscriberStats?.active ?? 0}</p>
            {subscriberStats && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                +{subscriberStats.newToday} сегодня
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Search + status filter */}
      <div className="space-y-3">
        <div className="relative max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Email, Chat ID, @ник или имя…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch("")}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Status filter pills */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { key: "all", label: "Все", count: total },
              {
                key: "active",
                label: "Доступ активен",
                count: active,
                activeClass:
                  "bg-green-500/15 text-green-400 border-green-500/40",
              },
              {
                key: "expired",
                label: "EXPIRED",
                count: expired,
                activeClass: "bg-red-500/15 text-red-400 border-red-500/40",
              },
              {
                key: "inactive",
                label: "Неактивны",
                count: inactive,
                activeClass:
                  "bg-foreground/10 text-foreground border-foreground/30",
              },
              {
                key: "blocked",
                label: "Заблок.",
                count: blocked,
                activeClass: "bg-red-700/15 text-red-500 border-red-700/40",
              },
              {
                key: "pending",
                label: "Ожидают",
                count: pending,
                activeClass:
                  "bg-amber-500/15 text-amber-400 border-amber-500/40",
              },
            ] as {
              key: typeof statusFilter;
              label: string;
              count: number;
              activeClass?: string;
            }[]
          ).map(({ key, label, count, activeClass }) => {
            const isActive = statusFilter === key;
            return (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={[
                  "flex items-center gap-1.5 px-3 py-1 text-xs border transition-colors rounded-sm font-mono",
                  isActive
                    ? (activeClass ??
                      "bg-foreground/10 text-foreground border-foreground/30")
                    : "text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
                ].join(" ")}
              >
                {label}
                <span
                  className={[
                    "text-[10px] font-bold tabular-nums",
                    isActive ? "" : "opacity-60",
                  ].join(" ")}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* List */}
      <div className="border border-border bg-card">
        <div className="border-b border-border px-4 py-3 flex items-center justify-between">
          <span className="text-sm font-medium tracking-wider">
            СПИСОК УЧАСТНИКОВ
          </span>
          <div className="flex items-center gap-3">
            {(q || statusFilter !== "all") && (
              <span className="text-xs text-muted-foreground">
                {filtered.length} из {total}
              </span>
            )}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowUpDown className="w-3 h-3" />
              <select
                aria-label="Сортировка участников"
                value={sortMode}
                onChange={(event) =>
                  setSortMode(
                    event.target.value as
                      | "newest"
                      | "oldest"
                      | "months-desc"
                      | "months-asc",
                  )
                }
                className="h-7 bg-transparent text-xs text-foreground outline-none"
              >
                <option value="newest">Новые первыми</option>
                <option value="oldest">Старые первыми</option>
                <option value="months-desc">Больше месяцев подписки</option>
                <option value="months-asc">Меньше месяцев подписки</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> ЗАГРУЗКА...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground space-y-2">
            <Users className="w-8 h-8 opacity-30" />
            <p className="text-sm">
              {q || statusFilter !== "all"
                ? "Ничего не найдено"
                : "Нет участников"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {filtered.map((m, i) => (
              <MemberRow
                key={m.chatId ?? m.dashboardId ?? i}
                member={m}
                onRefresh={load}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
