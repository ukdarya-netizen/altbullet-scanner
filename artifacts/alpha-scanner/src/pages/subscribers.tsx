import { useState, useEffect } from "react";
import {
  useGetSubscribers,
  useGetSubscriberStats,
  getGetSubscribersQueryKey,
  getGetSubscriberStatsQueryKey,
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Users,
  UserCheck,
  UserX,
  TrendingUp,
  Send,
  Check,
  Loader2,
  Search,
  X,
  Trash2,
} from "lucide-react";

// ── helpers ───────────────────────────────────────────────────────────────────

const SUBSCRIPTION_TIME_ZONE = "Asia/Dubai";

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("authToken") ?? "";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

function toDateInput(s: string | null | undefined): string {
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

// ── Subscription date cell ────────────────────────────────────────────────────

function SubUntilCell({
  chatId,
  subscribedUntil,
  onSaved,
}: {
  chatId: number;
  subscribedUntil: string | null | undefined;
  onSaved: () => void;
}) {
  const [val, setVal] = useState(toDateInput(subscribedUntil));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setVal(toDateInput(subscribedUntil));
  }, [subscribedUntil]);

  const save = async (newVal: string) => {
    setSaving(true);
    try {
      await fetch(`/api/admin/subscribers/${chatId}`, {
        method: "PATCH",
        headers: getAuthHeader(),
        body: JSON.stringify({
          subscribedUntil: newVal ? `${newVal}T00:00:00+04:00` : null,
        }),
      });
      onSaved();
    } catch {
      /* ignore */
    }
    setSaving(false);
  };

  const isExpired = subscribedUntil && new Date(subscribedUntil) < new Date();

  return (
    <td className="px-4 py-3">
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={(e) => save(e.target.value)}
          className={`text-xs h-6 px-1.5 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring font-mono
            ${isExpired ? "border-red-500/50 text-red-400" : val ? "border-green-500/40 text-green-400" : "border-border text-muted-foreground"}`}
        />
        {saving && (
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
        )}
        {val && !saving && (
          <button
            className="text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => {
              setVal("");
              void save("");
            }}
            title="Очистить"
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {isExpired && <p className="text-xs text-red-400 mt-0.5">истекла</p>}
    </td>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Subscribers() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetSubscribers({
    query: { queryKey: getGetSubscribersQueryKey(), refetchInterval: 30000 },
  });
  const { data: stats } = useGetSubscriberStats({
    query: {
      queryKey: getGetSubscriberStatsQueryKey(),
      refetchInterval: 30000,
    },
  });
  const { data: settings } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });
  const { mutateAsync: updateSettings } = useUpdateSettings();

  const [channelInput, setChannelInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => {
    if (settings?.channelId != null) {
      setChannelInput(settings.channelId);
    }
  }, [settings?.channelId]);

  const handleSaveChannel = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateSettings({
        data: { channelId: channelInput.trim() || null },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetSettingsQueryKey(),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (chatId: number) => {
    if (!window.confirm(`Удалить подписчика ${chatId}?`)) return;
    setDeletingId(chatId);
    try {
      await fetch(`/api/admin/subscribers/${chatId}`, {
        method: "DELETE",
        headers: getAuthHeader(),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetSubscribersQueryKey(),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetSubscriberStatsQueryKey(),
      });
    } finally {
      setDeletingId(null);
    }
  };

  const refetchSubscribers = () => {
    void queryClient.invalidateQueries({
      queryKey: getGetSubscribersQueryKey(),
    });
  };

  const q = search.trim().toLowerCase().replace(/^@/, "");
  const filteredSubs = (data?.subscribers ?? []).filter((sub) => {
    if (!q) return true;
    return (
      String(sub.chatId).includes(q) ||
      (sub.username ?? "").toLowerCase().includes(q) ||
      (sub.firstName ?? "").toLowerCase().includes(q) ||
      (sub.lastName ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold tracking-wider">
          TELEGRAM SUBSCRIBERS
        </h2>
        <p className="text-xs text-muted-foreground">
          People who sent /start to your bot
        </p>
      </div>

      {/* Channel Settings */}
      <Card className="border-border bg-card">
        <CardHeader className="border-b border-border py-4">
          <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground flex items-center gap-2">
            <Send className="w-4 h-4" />
            CHANNEL BROADCAST
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground mb-3">
            Канал куда бот дублирует все сигналы. Введи @username или числовой
            chat_id.
          </p>
          <div className="flex gap-2 items-center">
            <Input
              className="font-mono text-sm max-w-xs"
              placeholder="@cryptoaltsbullet"
              value={channelInput}
              onChange={(e) => {
                setChannelInput(e.target.value);
                setSaved(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && handleSaveChannel()}
            />
            <Button
              size="sm"
              variant="outline"
              className="font-mono tracking-wider"
              onClick={handleSaveChannel}
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                <>
                  <Check className="w-4 h-4 text-green-500 mr-1" />
                  SAVED
                </>
              ) : (
                "SAVE"
              )}
            </Button>
          </div>
          {settings?.channelId && (
            <p className="text-xs text-muted-foreground mt-2">
              Текущий:{" "}
              <span className="text-foreground font-mono">
                {settings.channelId}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">
                  TOTAL
                </p>
                <p className="text-3xl font-bold mt-2">{stats?.total ?? 0}</p>
              </div>
              <div className="p-2 bg-muted text-primary">
                <Users className="w-5 h-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">
                  ACTIVE
                </p>
                <p className="text-3xl font-bold mt-2 text-green-500">
                  {stats?.active ?? 0}
                </p>
              </div>
              <div className="p-2 bg-muted text-green-500">
                <UserCheck className="w-5 h-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">
                  NEW TODAY
                </p>
                <p className="text-3xl font-bold mt-2 text-violet-400">
                  {stats?.newToday ?? 0}
                </p>
              </div>
              <div className="p-2 bg-muted text-violet-400">
                <TrendingUp className="w-5 h-5" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-border bg-card">
          <CardContent className="p-6">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-xs text-muted-foreground tracking-wider">
                  UNSUBSCRIBED
                </p>
                <p className="text-3xl font-bold mt-2 text-muted-foreground">
                  {stats?.inactive ?? 0}
                </p>
              </div>
              <div className="p-2 bg-muted text-muted-foreground">
                <UserX className="w-5 h-5" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          className="pl-8 h-8 text-sm"
          placeholder="Поиск по Chat ID, @ник или имени…"
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

      <Card className="border-border bg-card">
        <CardHeader className="border-b border-border py-4">
          <CardTitle className="text-lg font-medium">
            SUBSCRIBER LIST
            {q && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — {filteredSubs.length} из {data?.subscribers.length ?? 0}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              LOADING...
            </div>
          ) : filteredSubs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground space-y-2">
              <Users className="w-8 h-8 opacity-30" />
              {q ? (
                <p className="text-sm">Ничего не найдено</p>
              ) : (
                <>
                  <p className="text-sm">No subscribers yet.</p>
                  <p className="text-xs">
                    Share your bot link so people can subscribe.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b border-border">
                  <tr className="text-muted-foreground text-left">
                    <th className="px-4 py-3 font-medium">CHAT ID</th>
                    <th className="px-4 py-3 font-medium">USERNAME</th>
                    <th className="px-4 py-3 font-medium">NAME</th>
                    <th className="px-4 py-3 font-medium">STATUS</th>
                    <th className="px-4 py-3 font-medium">
                      SUBSCRIBED (Дубай)
                    </th>
                    <th className="px-4 py-3 font-medium">
                      ПОДПИСКА ДО (Дубай)
                    </th>
                    <th className="px-4 py-3 font-medium w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSubs.map((sub) =>
                    (() => {
                      const isExpired =
                        sub.subscribedUntil != null &&
                        new Date(sub.subscribedUntil) <= new Date();
                      return (
                        <tr
                          key={sub.chatId}
                          className="border-b border-border/50 hover:bg-muted/30 transition-colors"
                        >
                          <td className="px-4 py-3 font-mono text-muted-foreground">
                            {sub.chatId}
                          </td>
                          <td className="px-4 py-3 font-medium">
                            {sub.username ? (
                              `@${sub.username}`
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {[sub.firstName, sub.lastName]
                              .filter(Boolean)
                              .join(" ") || (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {isExpired ? (
                              <Badge
                                variant="outline"
                                className="bg-amber-500/10 text-amber-500 border-amber-500/20 font-mono rounded-none text-xs"
                              >
                                EXPIRED
                              </Badge>
                            ) : sub.active ? (
                              <Badge
                                variant="outline"
                                className="bg-green-500/10 text-green-500 border-green-500/20 font-mono rounded-none text-xs"
                              >
                                ACTIVE
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="bg-red-500/10 text-red-500 border-red-500/20 font-mono rounded-none text-xs"
                              >
                                STOPPED
                              </Badge>
                            )}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                            {new Date(sub.subscribedAt).toLocaleDateString(
                              "ru-RU",
                              {
                                timeZone: SUBSCRIPTION_TIME_ZONE,
                              },
                            )}
                          </td>
                          <SubUntilCell
                            chatId={sub.chatId}
                            subscribedUntil={sub.subscribedUntil}
                            onSaved={refetchSubscribers}
                          />
                          <td className="px-2 py-3">
                            <button
                              onClick={() => void handleDelete(sub.chatId)}
                              disabled={deletingId === sub.chatId}
                              className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                              title="Удалить подписчика"
                            >
                              {deletingId === sub.chatId ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })(),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
