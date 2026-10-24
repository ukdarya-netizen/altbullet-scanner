import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Ban,
  Check,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  X,
} from "lucide-react";

interface DashboardUser {
  id: number;
  email: string;
  name: string;
  chatId: string | null;
  telegramUsername: string | null;
  subscribedUntil: string | null;
  status: "pending" | "approved" | "expired" | "blocked";
  createdAt: string;
  approvedAt: string | null;
  lastLoginAt: string | null;
}

type FilterTab = "all" | "pending" | "approved" | "expired" | "blocked";

// ── helpers ───────────────────────────────────────────────────────────────────

const SUBSCRIPTION_TIME_ZONE = "Asia/Dubai";

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("authToken") ?? "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    timeZone: SUBSCRIPTION_TIME_ZONE,
  });
}

/** ISO date string → "YYYY-MM-DD" for <input type="date"> */
function toDateInput(s: string | null): string {
  if (!s) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SUBSCRIPTION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date(s))
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// ── User Row ──────────────────────────────────────────────────────────────────

function UserRow({
  user,
  onRefresh,
}: {
  user: DashboardUser;
  onRefresh: () => void;
}) {
  const [loading, setLoading] = useState<string | null>(null);
  const [dateVal, setDateVal] = useState(toDateInput(user.subscribedUntil));
  const [dateSaving, setDateSaving] = useState(false);
  const [chatIdVal, setChatIdVal] = useState(user.chatId ?? "");
  const [chatIdSaving, setChatIdSaving] = useState(false);
  const [chatIdError, setChatIdError] = useState("");

  // keep in sync if parent re-fetches
  useEffect(() => {
    setDateVal(toDateInput(user.subscribedUntil));
  }, [user.subscribedUntil]);

  useEffect(() => {
    setChatIdVal(user.chatId ?? "");
    setChatIdError("");
  }, [user.chatId]);

  const act = async (action: "approve" | "block" | "delete") => {
    setLoading(action);
    try {
      if (action === "delete") {
        await fetch(`/api/admin/users/${user.id}`, {
          method: "DELETE",
          headers: getAuthHeader(),
        });
      } else {
        await fetch(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          headers: getAuthHeader(),
          body: JSON.stringify({
            status: action === "approve" ? "approved" : "blocked",
          }),
        });
      }
      onRefresh();
    } catch {
      /* ignore */
    }
    setLoading(null);
  };

  const saveDate = async (val: string) => {
    setDateSaving(true);
    try {
      await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: getAuthHeader(),
        body: JSON.stringify({
          subscribedUntil: val ? `${val}T00:00:00+04:00` : null,
        }),
      });
      onRefresh();
    } catch {
      /* ignore */
    }
    setDateSaving(false);
  };

  const saveChatId = async (value: string) => {
    const normalized = value.trim();
    if (normalized === (user.chatId ?? "")) return;
    setChatIdSaving(true);
    setChatIdError("");
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: getAuthHeader(),
        body: JSON.stringify({ chatId: normalized || null }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setChatIdError(data.error ?? "Не удалось сохранить Chat ID");
        setChatIdVal(user.chatId ?? "");
        return;
      }
      onRefresh();
    } catch {
      setChatIdError("Не удалось сохранить Chat ID");
      setChatIdVal(user.chatId ?? "");
    } finally {
      setChatIdSaving(false);
    }
  };

  const isExpired = Boolean(
    user.subscribedUntil && new Date(user.subscribedUntil) < new Date(),
  );
  const effectiveStatus =
    user.status === "approved" && isExpired ? "expired" : user.status;

  const statusBadge = {
    pending: (
      <Badge
        variant="outline"
        className="text-amber-500 border-amber-500/30 bg-amber-500/10 gap-1"
      >
        <Clock className="w-3 h-3" />
        Ожидает
      </Badge>
    ),
    approved: (
      <Badge
        variant="outline"
        className="text-green-500 border-green-500/30 bg-green-500/10 gap-1"
      >
        <UserCheck className="w-3 h-3" />
        Активен
      </Badge>
    ),
    expired: (
      <Badge
        variant="outline"
        className="text-red-400 border-red-500/30 bg-red-500/10 gap-1"
      >
        <Clock className="w-3 h-3" />
        Подписка истекла
      </Badge>
    ),
    blocked: (
      <Badge
        variant="outline"
        className="text-red-500 border-red-500/30 bg-red-500/10 gap-1"
      >
        <Ban className="w-3 h-3" />
        Заблок.
      </Badge>
    ),
  }[effectiveStatus];

  const tgLine = [
    user.telegramUsername ? `@${user.telegramUsername}` : null,
    user.chatId ? `ID ${user.chatId}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="py-3 px-4 hover:bg-muted/40 transition-colors">
      <div className="flex items-center gap-3">
        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{user.name}</p>
          <p className="text-xs text-muted-foreground truncate">{user.email}</p>
          {tgLine && (
            <p className="text-xs text-muted-foreground/70 truncate font-mono">
              {tgLine}
            </p>
          )}
        </div>

        {/* Dates (hidden on mobile) */}
        <div className="hidden sm:flex flex-col items-end text-xs text-muted-foreground gap-0.5 shrink-0">
          <span>Запрос: {fmtDate(user.createdAt)}</span>
          {user.lastLoginAt && <span>Вход: {fmtDate(user.lastLoginAt)}</span>}
        </div>

        {/* Status */}
        <div className="shrink-0">{statusBadge}</div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {effectiveStatus !== "approved" && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-green-500 hover:text-green-400 hover:bg-green-500/10"
              onClick={() => act("approve")}
              disabled={!!loading}
              title="Одобрить"
            >
              {loading === "approve" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          {effectiveStatus !== "blocked" && (
            <Button
              size="icon"
              variant="ghost"
              className="w-7 h-7 text-amber-500 hover:text-amber-400 hover:bg-amber-500/10"
              onClick={() => act("block")}
              disabled={!!loading}
              title="Заблокировать"
            >
              {loading === "block" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="w-7 h-7 text-red-500 hover:text-red-400 hover:bg-red-500/10"
            onClick={() => act("delete")}
            disabled={!!loading}
            title="Удалить"
          >
            {loading === "delete" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Subscription date row */}
      <div className="flex items-center gap-2 mt-1.5 pl-0">
        <span className="text-xs text-muted-foreground shrink-0">
          Подписка до (Дубай):
        </span>
        <input
          type="date"
          value={dateVal}
          onChange={(e) => setDateVal(e.target.value)}
          onBlur={(e) => saveDate(e.target.value)}
          className={`text-xs h-6 px-1.5 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring
            ${isExpired ? "border-red-500/50 text-red-400" : "border-border text-foreground"}`}
        />
        {dateSaving && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        )}
        {dateVal && (
          <button
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={() => {
              setDateVal("");
              void saveDate("");
            }}
            title="Очистить"
          >
            <X className="w-3 h-3" />
          </button>
        )}
        {user.subscribedUntil && !isExpired && (
          <span className="text-xs text-green-500">✓ активна</span>
        )}
        {isExpired && <span className="text-xs text-red-400">истекла</span>}
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <span className="text-xs text-muted-foreground shrink-0">
          Telegram Chat ID:
        </span>
        <Input
          inputMode="numeric"
          pattern="[0-9]*"
          value={chatIdVal}
          onChange={(e) => {
            setChatIdVal(e.target.value);
            setChatIdError("");
          }}
          onBlur={(e) => void saveChatId(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className="h-6 max-w-48 px-1.5 text-xs font-mono"
          placeholder="Например, 6964248629"
          aria-label={`Telegram Chat ID для ${user.name}`}
        />
        {chatIdSaving && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        )}
        {chatIdError && (
          <span className="text-xs text-destructive">{chatIdError}</span>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Users() {
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [filter, setFilter] = useState<FilterTab>("pending");
  const [search, setSearch] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch("/api/admin/users", {
        headers: getAuthHeader(),
      });
      const data = (await res.json()) as DashboardUser[];
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
    setLoadingUsers(false);
  }, []);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  const counts: Record<FilterTab, number> = {
    all: users.length,
    pending: users.filter((u) => u.status === "pending").length,
    approved: users.filter(
      (u) =>
        u.status === "approved" &&
        !(u.subscribedUntil && new Date(u.subscribedUntil) < new Date()),
    ).length,
    expired: users.filter(
      (u) =>
        u.status === "expired" ||
        (u.status === "approved" &&
          Boolean(
            u.subscribedUntil && new Date(u.subscribedUntil) < new Date(),
          )),
    ).length,
    blocked: users.filter((u) => u.status === "blocked").length,
  };

  const q = search.trim().toLowerCase().replace(/^@/, "");

  const displayed = (
    filter === "all"
      ? users
      : users.filter((u) => {
          const expired =
            u.status === "expired" ||
            (u.status === "approved" &&
              Boolean(
                u.subscribedUntil && new Date(u.subscribedUntil) < new Date(),
              ));
          return filter === "expired"
            ? expired
            : u.status === filter && !expired;
        })
  ).filter((u) => {
    if (!q) return true;
    return (
      u.email.toLowerCase().includes(q) ||
      (u.chatId ?? "").includes(q) ||
      (u.telegramUsername ?? "").toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q)
    );
  });

  const tabs: { key: FilterTab; label: string }[] = [
    {
      key: "pending",
      label: `Ожидают${counts.pending > 0 ? ` (${counts.pending})` : ""}`,
    },
    { key: "approved", label: "Активные" },
    {
      key: "expired",
      label: `EXPIRED${counts.expired > 0 ? ` (${counts.expired})` : ""}`,
    },
    { key: "blocked", label: "Заблок." },
    { key: "all", label: `Все (${counts.all})` },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            Пользователи
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {counts.all} всего · {counts.pending} ожидают · {counts.approved}{" "}
            активных
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => fetchUsers()}
          disabled={loadingUsers}
          title="Обновить"
        >
          <RefreshCw
            className={`w-4 h-4 ${loadingUsers ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {tabs.map(({ key, label }) => (
          <Button
            key={key}
            variant={filter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(key)}
            className="h-7 text-xs"
          >
            {label}
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          className="pl-8 h-8 text-sm"
          placeholder="Поиск по email, Chat ID, @ник или имени…"
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

      {/* List */}
      <Card className="border-border/50">
        <CardContent className="p-0">
          {loadingUsers ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : displayed.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              {search
                ? "Ничего не найдено"
                : filter === "pending"
                  ? "Нет новых запросов"
                  : "Нет пользователей"}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {displayed.map((user) => (
                <UserRow
                  key={user.id}
                  user={user}
                  onRefresh={() => fetchUsers()}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
