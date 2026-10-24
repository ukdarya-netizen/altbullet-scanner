import { useQuery } from "@tanstack/react-query";
import { Eye, TrendingUp, TrendingDown } from "lucide-react";
import { TokenChartLink } from "@/components/token-chart-link";
import { cn } from "@/lib/utils";
import { getPatternTgLabel } from "@/lib/pattern-labels";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

interface HealthEvent {
  id: number;
  signal_id: number;
  symbol: string;
  sentiment_key: string;
  message_type: "hold" | "exit" | "follow";
  pnl_at_send: number | null;
  oi_30m: number | null;
  turnover: number | null;
  cvd_15m: boolean | null;
  cvd_30m: boolean | null;
  cvd_1h: boolean | null;
  price_at_send: number | null;
  entry_price: number | null;
  sent_at: string;
  price_4h_pct: number | null;
  price_8h_pct: number | null;
  price_24h_pct: number | null;
}

interface HealthAccuracy {
  message_type: "hold" | "exit" | "follow";
  n: number;
  signal_count: number;
  event_count: number;
  observed: number;
  observed_24h: number;
  mature_4h: number;
  mature_24h: number;
  avg_4h_pct: number | null;
  avg_8h_pct: number | null;
  avg_24h_pct: number | null;
  correct: number | null;
  accuracy_pct: number | null;
  sample_status: "insufficient_data" | "preliminary" | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  hold: {
    label: "💪 ДЕРЖИ",
    color: "text-green-400",
    bg: "bg-green-500/10 border-green-500/30",
    filter: "hold",
  },
  exit: {
    label: "⚠️ ВЫХОД",
    color: "text-red-400",
    bg: "bg-red-500/10 border-red-500/30",
    filter: "exit",
  },
  follow: {
    label: "👀 СЛЕДИ",
    color: "text-yellow-400",
    bg: "bg-yellow-500/10 border-yellow-500/30",
    filter: "follow",
  },
} as const;

function PctCell({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground/40">—</span>;
  const pos = value > 0;
  const neg = value < 0;
  return (
    <span
      className={cn(
        "font-mono text-xs font-medium",
        pos && "text-green-400",
        neg && "text-red-400",
        !pos && !neg && "text-muted-foreground",
      )}
    >
      {pos ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

function CvdBadge({ v }: { v: boolean | null }) {
  if (v == null) return <span className="text-muted-foreground/30">·</span>;
  return v ? (
    <TrendingUp className="w-3 h-3 text-green-400 inline" />
  ) : (
    <TrendingDown className="w-3 h-3 text-red-400 inline" />
  );
}

function avg(events: HealthEvent[], key: keyof HealthEvent): number | null {
  const vals = events
    .map((e) => e[key] as number | null)
    .filter((v): v is number => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmtAvg(v: number | null) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({
  type,
  events,
  accuracy,
}: {
  type: "hold" | "exit" | "follow";
  events: HealthEvent[];
  accuracy: HealthAccuracy | undefined;
}) {
  const cfg = TYPE_CONFIG[type];
  const filtered = events.filter((e) => e.message_type === type);
  const avg4h = accuracy?.avg_4h_pct ?? avg(filtered, "price_4h_pct");
  const avg24h = accuracy?.avg_24h_pct ?? avg(filtered, "price_24h_pct");
  const observed4h =
    accuracy?.observed ?? filtered.filter((e) => e.price_4h_pct != null).length;
  const observed24h =
    accuracy?.observed_24h ??
    filtered.filter((e) => e.price_24h_pct != null).length;
  const signalCount = accuracy?.signal_count ?? filtered.length;
  const eventCount = accuracy?.event_count ?? filtered.length;
  const isInsufficient = accuracy?.sample_status === "insufficient_data";

  return (
    <div className={cn("border rounded-lg p-4", cfg.bg)}>
      <div className={cn("text-sm font-semibold mb-3", cfg.color)}>
        {cfg.label}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Сигналов</span>
        <span className="font-mono">{signalCount}</span>

        <span className="text-muted-foreground">Сообщений</span>
        <span className="font-mono text-muted-foreground">{eventCount}</span>

        <span className="text-muted-foreground">Ср. +4ч</span>
        <span
          className={cn(
            "font-mono",
            avg4h != null && avg4h > 0 && "text-green-400",
            avg4h != null && avg4h < 0 && "text-red-400",
          )}
        >
          {fmtAvg(avg4h)}
          {observed4h > 0 && (
            <span className="text-muted-foreground/50"> n={observed4h}</span>
          )}
        </span>

        <span className="text-muted-foreground">Ср. +24ч</span>
        <span
          className={cn(
            "font-mono",
            avg24h != null && avg24h > 0 && "text-green-400",
            avg24h != null && avg24h < 0 && "text-red-400",
          )}
        >
          {fmtAvg(avg24h)}
          {observed24h > 0 && (
            <span className="text-muted-foreground/50"> n={observed24h}</span>
          )}
        </span>

        {accuracy?.correct != null && observed4h > 0 && (
          <>
            <span className="text-muted-foreground">Точность 4ч</span>
            <span className="font-mono">
              {accuracy.accuracy_pct?.toFixed(1) ?? "—"}%{" "}
              <span className="text-muted-foreground/50">
                ({accuracy.correct}/{observed4h})
              </span>
            </span>
          </>
        )}

        <span className="text-muted-foreground">Покрытие 4ч</span>
        <span className="font-mono text-muted-foreground">
          {observed4h}/{signalCount}
        </span>
      </div>
      <div
        className={cn(
          "mt-3 pt-2 border-t text-[11px]",
          isInsufficient ? "text-amber-300" : "text-muted-foreground",
        )}
      >
        {isInsufficient
          ? `Недостаточно данных для вывода: ${observed4h}/20 зрелых исходов`
          : type === "follow"
            ? "Наблюдательная метрика: строгой точности нет"
            : "Предварительная оценка по первой отправке на сигнал"}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type FilterType = "all" | "hold" | "exit" | "follow";

export function HealthEventsPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const [filter, setFilter] = React.useState<FilterType>("all");

  const { data, isLoading, error } = useQuery<{
    events: HealthEvent[];
    accuracy: HealthAccuracy[];
  }>({
    queryKey: ["health-events"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/scanner/health-events`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        events: HealthEvent[];
        accuracy: HealthAccuracy[];
      }>;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });

  const events = data?.events ?? [];
  const accuracyByType = new Map(
    (data?.accuracy ?? []).map((row) => [row.message_type, row]),
  );
  const visible =
    filter === "all" ? events : events.filter((e) => e.message_type === filter);

  return (
    <div className="space-y-6 max-w-7xl">
      {showHeader && (
        <div className="flex items-center gap-3">
          <Eye className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Health Events</h2>
            <p className="text-xs text-muted-foreground">
              Исходы предупреждений СЛЕДИ / ДЕРЖИ / РАССМОТРИ ВЫХОД — цена через
              +4ч, +8ч, +24ч
            </p>
          </div>
        </div>
      )}

      {/* Summary cards */}
      {events.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SummaryCard
            type="hold"
            events={events}
            accuracy={accuracyByType.get("hold")}
          />
          <SummaryCard
            type="exit"
            events={events}
            accuracy={accuracyByType.get("exit")}
          />
          <SummaryCard
            type="follow"
            events={events}
            accuracy={accuracyByType.get("follow")}
          />
        </div>
      )}

      {/* Filter buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        {(["all", "hold", "exit", "follow"] as FilterType[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-medium border transition-colors",
              filter === f
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
            )}
          >
            {f === "all"
              ? `Все (${events.length})`
              : f === "hold"
                ? `💪 ДЕРЖИ (${events.filter((e) => e.message_type === "hold").length})`
                : f === "exit"
                  ? `⚠️ ВЫХОД (${events.filter((e) => e.message_type === "exit").length})`
                  : `👀 СЛЕДИ (${events.filter((e) => e.message_type === "follow").length})`}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-2">
          {events.length === 0 && !isLoading
            ? "Данных пока нет — события появятся после первых срабатываний"
            : `Показано: ${visible.length}`}
        </span>
      </div>

      {/* State */}
      {isLoading && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Загрузка…
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 py-4">
          Ошибка загрузки: {String(error)}
        </div>
      )}

      {/* Table */}
      {!isLoading && visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-muted-foreground">
                <th className="text-left px-3 py-2.5 font-medium">Время</th>
                <th className="text-left px-3 py-2.5 font-medium">Монета</th>
                <th className="text-left px-3 py-2.5 font-medium">Паттерн</th>
                <th className="text-left px-3 py-2.5 font-medium">Тип</th>
                <th className="text-right px-3 py-2.5 font-medium">PnL</th>
                <th className="text-right px-3 py-2.5 font-medium">OI 30m</th>
                <th className="text-right px-3 py-2.5 font-medium">Оборот</th>
                <th className="text-center px-3 py-2.5 font-medium">
                  CVD 15/30/1h
                </th>
                <th className="text-right px-3 py-2.5 font-medium">+4ч</th>
                <th className="text-right px-3 py-2.5 font-medium">+8ч</th>
                <th className="text-right px-3 py-2.5 font-medium">+24ч</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((ev) => {
                const cfg = TYPE_CONFIG[ev.message_type];
                return (
                  <tr
                    key={ev.id}
                    className="hover:bg-muted/20 transition-colors"
                  >
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                      {fmtTime(ev.sent_at)}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <TokenChartLink symbol={ev.symbol} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {getPatternTgLabel(ev.sentiment_key) ?? ev.sentiment_key}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded border text-xs",
                          cfg.bg,
                          cfg.color,
                        )}
                      >
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={ev.pnl_at_send} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {ev.oi_30m != null ? (
                        <span
                          className={cn(
                            ev.oi_30m > 0 ? "text-green-400" : "text-red-400",
                          )}
                        >
                          {ev.oi_30m > 0 ? "+" : ""}
                          {ev.oi_30m.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {ev.turnover != null
                        ? `${(ev.turnover * 100).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="inline-flex gap-1.5 items-center">
                        <CvdBadge v={ev.cvd_15m} />
                        <CvdBadge v={ev.cvd_30m} />
                        <CvdBadge v={ev.cvd_1h} />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={ev.price_4h_pct} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={ev.price_8h_pct} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={ev.price_24h_pct} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state — no events yet */}
      {!isLoading && !error && events.length === 0 && (
        <div className="text-center py-16 text-muted-foreground space-y-2">
          <Eye className="w-8 h-8 mx-auto opacity-30" />
          <p className="text-sm">Событий пока нет</p>
          <p className="text-xs max-w-sm mx-auto">
            Записи появятся автоматически когда бот отправит первое сообщение
            «СЛЕДИ», «ДЕРЖИ» или «РАССМОТРИ ВЫХОД» после деплоя.
          </p>
        </div>
      )}
    </div>
  );
}

// React import needed for useState
import React from "react";

export default HealthEventsPanel;
