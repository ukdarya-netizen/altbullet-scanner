import React from "react";
import { useQuery } from "@tanstack/react-query";
import { XCircle, TrendingUp, AlertTriangle } from "lucide-react";
import { TokenChartLink } from "@/components/token-chart-link";
import { cn } from "@/lib/utils";
import { getPatternTgLabel } from "@/lib/pattern-labels";

// ── Weekly snapshot type ───────────────────────────────────────────────────────

interface WeeklySnapshot {
  snapshot_week: string; // ISO date string (Monday)
  cancel_reason: string;
  total: number;
  observed: number;
  false_cancels: number;
  false_cancel_rate: number | null;
  avg_pnl: number | null;
  avg_p24h: number | null;
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ─────────────────────────────────────────────────────────────────────

interface AggregateRow {
  cancel_reason: string;
  sentiment_key: string;
  total_cancels: number;
  observed_24h: number;
  false_cancels: number;
  false_cancel_rate: number | null;
  avg_pnl_at_cancel: number | null;
  avg_price_24h_pct: number | null;
}

interface CancelOutcome {
  id: number;
  signal_id: number;
  symbol: string;
  sentiment_key: string;
  cancel_reason: string;
  pnl_at_cancel: number | null;
  price_at_cancel: number | null;
  entry_price: number | null;
  sent_at: string;
  price_4h_pct: number | null;
  price_8h_pct: number | null;
  price_24h_pct: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Cancel was "correct" if the token did NOT pump after cancellation (rose < 3%). */
function isCancelCorrect(pct: number | null): boolean {
  return pct != null && pct < 3;
}

function reasonLabel(reason: string): string {
  const map: Record<string, string> = {
    stale_cancel: "⏱ Stale",
    stale_cancel_oi: "⏱ Stale OI",
    stale_oi_vol: "⏱ Stale OI/Vol",
    smart_cancel: "🚫 Smart",
    smart_cancel_oi4h: "🚫 Smart OI4h",
    no_price_30m: "❓ No Price",
    max_age: "🕐 Max Age",
    stop_loss: "🔴 Stop Loss",
  };
  return map[reason] ?? reason;
}

function reasonColor(reason: string): string {
  if (reason.startsWith("smart")) return "text-orange-400";
  if (reason.startsWith("stale")) return "text-yellow-400";
  if (reason === "no_price_30m") return "text-zinc-400";
  if (reason === "max_age") return "text-purple-400";
  if (reason === "stop_loss") return "text-red-400";
  return "text-muted-foreground";
}

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

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function avg(items: CancelOutcome[], key: keyof CancelOutcome): number | null {
  const vals = items
    .map((e) => e[key] as number | null)
    .filter((v): v is number => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmtAvg(v: number | null) {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function PatternReasonBreakdownTable({ rows }: { rows: AggregateRow[] }) {
  const [open, setOpen] = React.useState(true);

  // Filter to ≥5 observed, sort by false_cancel_rate DESC (nulls last)
  const filtered = React.useMemo(
    () =>
      rows
        .filter((r) => r.observed_24h >= 5)
        .slice()
        .sort(
          (a, b) => (b.false_cancel_rate ?? -1) - (a.false_cancel_rate ?? -1),
        ),
    [rows],
  );

  if (filtered.length === 0) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Collapsible header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-sm font-semibold">
          Разбивка: паттерн × причина отмены
        </span>
        <span className="text-xs text-muted-foreground select-none">
          {filtered.length} пар · {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-muted/20 text-muted-foreground">
                <th className="text-left px-3 py-2.5 font-medium">Паттерн</th>
                <th className="text-left px-3 py-2.5 font-medium">Причина</th>
                <th className="text-right px-3 py-2.5 font-medium">Отмен</th>
                <th className="text-right px-3 py-2.5 font-medium">
                  Наблюд. 24ч
                </th>
                <th className="text-right px-3 py-2.5 font-medium">Ложных %</th>
                <th className="text-right px-3 py-2.5 font-medium">Ср. +24ч</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => {
                const isHot =
                  r.false_cancel_rate != null && r.false_cancel_rate > 30;
                return (
                  <tr
                    key={`${r.sentiment_key}-${r.cancel_reason}`}
                    className={cn(
                      "transition-colors",
                      isHot
                        ? "bg-red-500/8 hover:bg-red-500/15"
                        : "hover:bg-muted/20",
                    )}
                  >
                    <td className="px-3 py-2 font-medium whitespace-nowrap">
                      {getPatternTgLabel(r.sentiment_key) ?? r.sentiment_key}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className={cn(
                          "font-medium",
                          reasonColor(r.cancel_reason),
                        )}
                      >
                        {reasonLabel(r.cancel_reason)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {r.total_cancels}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {r.observed_24h}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold">
                      {r.false_cancel_rate != null ? (
                        <span
                          className={cn(
                            isHot
                              ? "text-red-400"
                              : r.false_cancel_rate > 15
                                ? "text-amber-400"
                                : "text-green-400",
                          )}
                        >
                          {r.false_cancel_rate.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={r.avg_price_24h_pct} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border bg-muted/10">
            Показаны пары с ≥5 наблюдаемыми результатами за 24ч ·{" "}
            <span className="text-red-400">Красный</span> = ложных отмен &gt;30%
          </div>
        </div>
      )}
    </div>
  );
}

// ── 4-Week Trend Sparkline ────────────────────────────────────────────────────

/** Simple inline SVG sparkline for a series of rate values (0–100). */
function Sparkline({ values }: { values: (number | null)[] }) {
  const W = 80;
  const H = 28;
  const pts = values
    .map((v, i) => (v != null ? { x: i, y: v } : null))
    .filter((p): p is { x: number; y: number } => p != null);
  if (pts.length < 2)
    return (
      <span className="text-xs text-muted-foreground/40 font-mono">—</span>
    );

  const maxY = Math.max(...pts.map((p) => p.y), 5);
  const n = values.length - 1 || 1;
  const toSvg = (p: { x: number; y: number }) => ({
    sx: (p.x / n) * W,
    sy: H - (p.y / maxY) * H,
  });
  const svgPts = pts.map(toSvg);
  const polyline = svgPts
    .map((p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`)
    .join(" ");

  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const rising = last.y > first.y + 2;
  const falling = last.y < first.y - 2;
  const strokeColor = rising ? "#f87171" : falling ? "#4ade80" : "#a1a1aa";

  const lastSvg = toSvg(last);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="overflow-visible"
    >
      <polyline
        points={polyline}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastSvg.sx} cy={lastSvg.sy} r="2.5" fill={strokeColor} />
    </svg>
  );
}

function WeeklyTrendCard({ snapshots }: { snapshots: WeeklySnapshot[] }) {
  // Get the 4 most recent distinct weeks
  const allWeeks = [...new Set(snapshots.map((s) => s.snapshot_week))].sort();
  const recentWeeks = allWeeks.slice(-4);

  if (recentWeeks.length === 0) return null;

  // Get all reasons that appear in recent weeks
  const reasons = [
    ...new Set(
      snapshots
        .filter((s) => recentWeeks.includes(s.snapshot_week))
        .map((s) => s.cancel_reason),
    ),
  ].sort();

  // Build a lookup: week → reason → snapshot
  const byWeekReason = new Map<string, Map<string, WeeklySnapshot>>();
  for (const s of snapshots) {
    if (!byWeekReason.has(s.snapshot_week)) {
      byWeekReason.set(s.snapshot_week, new Map());
    }
    byWeekReason.get(s.snapshot_week)!.set(s.cancel_reason, s);
  }

  // Format week label: "Aug 12"
  function fmtWeek(iso: string) {
    return new Date(iso).toLocaleDateString("ru-RU", {
      month: "short",
      day: "numeric",
    });
  }

  return (
    <div className="border border-border rounded-lg p-4 bg-muted/10">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">
          Тренд ложных отмен — последние {recentWeeks.length} нед.
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {recentWeeks.map(fmtWeek).join(" · ")}
        </span>
      </div>

      <div className="space-y-3">
        {reasons.map((reason) => {
          const values = recentWeeks.map((w) => {
            const s = byWeekReason.get(w)?.get(reason);
            return s?.false_cancel_rate ?? null;
          });
          const latest = values[values.length - 1];
          const latestTotal =
            byWeekReason.get(recentWeeks[recentWeeks.length - 1])?.get(reason)
              ?.total ?? 0;
          const prev = values.slice(0, -1).findLast((v) => v != null) ?? null;
          const delta = latest != null && prev != null ? latest - prev : null;

          return (
            <div key={reason} className="flex items-center gap-3 text-xs">
              <span
                className={cn("w-28 shrink-0 truncate", reasonColor(reason))}
              >
                {reasonLabel(reason)}
              </span>

              {/* Sparkline */}
              <Sparkline values={values} />

              {/* Latest rate */}
              <span
                className={cn(
                  "font-mono w-14 text-right shrink-0",
                  latest != null && latest > 30
                    ? "text-red-400"
                    : latest != null && latest > 15
                      ? "text-amber-400"
                      : "text-green-400",
                )}
              >
                {latest != null ? `${latest.toFixed(0)}%` : "—"}
              </span>

              {/* Week-over-week delta */}
              <span
                className={cn(
                  "font-mono w-14 text-right text-muted-foreground shrink-0",
                  delta != null && delta > 2 && "text-red-400",
                  delta != null && delta < -2 && "text-green-400",
                )}
              >
                {delta != null
                  ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`
                  : "—"}
              </span>

              {/* Count */}
              <span className="text-muted-foreground/60 font-mono shrink-0">
                {latestTotal > 0 ? `n=${latestTotal}` : ""}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 text-xs text-muted-foreground flex gap-4">
        <span>
          <span className="text-green-400">↘ падение</span> — улучшение
        </span>
        <span>
          <span className="text-red-400">↗ рост</span> — ухудшение
        </span>
      </div>
    </div>
  );
}

// ── Worst-Offender Aggregate Card ─────────────────────────────────────────────

function WorstOffenderCard({ rows }: { rows: AggregateRow[] }) {
  // Group by cancel_reason: sum totals, pick worst false_cancel_rate
  const byReason = React.useMemo(() => {
    const map = new Map<
      string,
      {
        total: number;
        observed: number;
        false_c: number;
        pnlSum: number;
        pnlN: number;
        p24Sum: number;
        p24N: number;
      }
    >();
    for (const r of rows) {
      const prev = map.get(r.cancel_reason) ?? {
        total: 0,
        observed: 0,
        false_c: 0,
        pnlSum: 0,
        pnlN: 0,
        p24Sum: 0,
        p24N: 0,
      };
      prev.total += r.total_cancels;
      prev.observed += r.observed_24h;
      prev.false_c += r.false_cancels;
      if (r.avg_pnl_at_cancel != null) {
        prev.pnlSum += r.avg_pnl_at_cancel * r.total_cancels;
        prev.pnlN += r.total_cancels;
      }
      if (r.avg_price_24h_pct != null) {
        prev.p24Sum += r.avg_price_24h_pct * r.observed_24h;
        prev.p24N += r.observed_24h;
      }
      map.set(r.cancel_reason, prev);
    }
    return [...map.entries()]
      .map(([reason, v]) => ({
        reason,
        total: v.total,
        observed: v.observed,
        false_c: v.false_c,
        false_rate: v.observed > 0 ? (v.false_c / v.observed) * 100 : null,
        avg_pnl: v.pnlN > 0 ? v.pnlSum / v.pnlN : null,
        avg_p24: v.p24N > 0 ? v.p24Sum / v.p24N : null,
      }))
      .sort((a, b) => (b.false_rate ?? -1) - (a.false_rate ?? -1));
  }, [rows]);

  if (byReason.length === 0) return null;

  const worst = byReason[0];
  const totalEvents = rows.reduce((s, r) => s + r.total_cancels, 0);
  const totalObserved = rows.reduce((s, r) => s + r.observed_24h, 0);
  const totalFalse = rows.reduce((s, r) => s + r.false_cancels, 0);
  const overallFalseRate =
    totalObserved > 0 ? (totalFalse / totalObserved) * 100 : null;

  return (
    <div className="border border-amber-500/30 rounded-lg p-4 bg-amber-500/5">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-semibold text-amber-400">
          Автодетектор ложных отмен — 30 дней
        </span>
      </div>

      {/* Overall stats */}
      <div className="grid grid-cols-3 gap-3 mb-4 text-xs">
        <div className="text-center">
          <div className="text-lg font-mono font-bold text-foreground">
            {totalEvents}
          </div>
          <div className="text-muted-foreground">Всего отмен</div>
        </div>
        <div className="text-center">
          <div
            className={cn(
              "text-lg font-mono font-bold",
              overallFalseRate != null && overallFalseRate > 30
                ? "text-red-400"
                : overallFalseRate != null && overallFalseRate > 15
                  ? "text-amber-400"
                  : "text-green-400",
            )}
          >
            {overallFalseRate != null ? `${overallFalseRate.toFixed(0)}%` : "—"}
          </div>
          <div className="text-muted-foreground">Ложных отмен</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-mono font-bold text-red-400">
            {totalFalse}
          </div>
          <div className="text-muted-foreground">
            из {totalObserved} с данными
          </div>
        </div>
      </div>

      {/* Worst offender */}
      <div className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
        Главный нарушитель
      </div>
      <div className="bg-muted/30 rounded px-3 py-2.5 space-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className={cn("font-semibold", reasonColor(worst.reason))}>
            {reasonLabel(worst.reason)}
          </span>
          <span
            className={cn(
              "font-mono font-bold",
              worst.false_rate != null && worst.false_rate > 30
                ? "text-red-400"
                : worst.false_rate != null && worst.false_rate > 15
                  ? "text-amber-400"
                  : "text-green-400",
            )}
          >
            {worst.false_rate != null
              ? `${worst.false_rate.toFixed(1)}% ложных`
              : "—"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-muted-foreground">
          <span>Отмен</span>
          <span className="font-mono text-foreground">
            {worst.total} (наблюд.: {worst.observed})
          </span>
          <span>Ср. PnL при отмене</span>
          <span
            className={cn(
              "font-mono",
              worst.avg_pnl != null && worst.avg_pnl > 0
                ? "text-green-400"
                : worst.avg_pnl != null && worst.avg_pnl < 0
                  ? "text-red-400"
                  : "text-foreground",
            )}
          >
            {worst.avg_pnl != null
              ? `${worst.avg_pnl > 0 ? "+" : ""}${worst.avg_pnl.toFixed(1)}%`
              : "—"}
          </span>
          <span>Ср. +24ч после</span>
          <span
            className={cn(
              "font-mono",
              worst.avg_p24 != null && worst.avg_p24 > 0
                ? "text-green-400"
                : worst.avg_p24 != null && worst.avg_p24 < 0
                  ? "text-red-400"
                  : "text-foreground",
            )}
          >
            {worst.avg_p24 != null
              ? `${worst.avg_p24 > 0 ? "+" : ""}${worst.avg_p24.toFixed(1)}%`
              : "—"}
          </span>
        </div>
      </div>

      {/* All reasons ranked */}
      {byReason.length > 1 && (
        <div className="mt-3 space-y-1">
          <div className="text-xs text-muted-foreground mb-1.5">
            Рейтинг по ложным отменам:
          </div>
          {byReason.map((item, idx) => (
            <div key={item.reason} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground/60 w-4 text-right">
                {idx + 1}.
              </span>
              <span className={cn("flex-1", reasonColor(item.reason))}>
                {reasonLabel(item.reason)}
              </span>
              <span className="font-mono text-muted-foreground">
                {item.total} отм.
              </span>
              <span
                className={cn(
                  "font-mono w-16 text-right",
                  item.false_rate != null && item.false_rate > 30
                    ? "text-red-400"
                    : item.false_rate != null && item.false_rate > 15
                      ? "text-amber-400"
                      : "text-green-400",
                )}
              >
                {item.false_rate != null
                  ? `${item.false_rate.toFixed(0)}% лж.`
                  : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({
  reason,
  items,
}: {
  reason: string;
  items: CancelOutcome[];
}) {
  const avg4h = avg(items, "price_4h_pct");
  const avg24h = avg(items, "price_24h_pct");
  const obs4h = items.filter((e) => e.price_4h_pct != null).length;
  const correct4h = items.filter((e) => isCancelCorrect(e.price_4h_pct)).length;

  const color = reasonColor(reason);

  return (
    <div className="border border-border rounded-lg p-4 bg-muted/20">
      <div className={cn("text-sm font-semibold mb-3", color)}>
        {reasonLabel(reason)}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Событий</span>
        <span className="font-mono">{items.length}</span>

        <span className="text-muted-foreground">Ср. +4ч</span>
        <span
          className={cn(
            "font-mono",
            avg4h != null && avg4h > 0 && "text-green-400",
            avg4h != null && avg4h < 0 && "text-red-400",
          )}
        >
          {fmtAvg(avg4h)}
          {obs4h > 0 && (
            <span className="text-muted-foreground/50"> n={obs4h}</span>
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
        </span>

        {obs4h > 0 && (
          <>
            <span className="text-muted-foreground">Точность 4ч</span>
            <span className="font-mono">
              {Math.round((correct4h / obs4h) * 100)}%{" "}
              <span className="text-muted-foreground/50">
                ({correct4h}/{obs4h})
              </span>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function CancelOutcomesPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const [filter, setFilter] = React.useState<string>("all");

  const authHeader = {
    Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
  };

  const { data, isLoading, error } = useQuery<{ outcomes: CancelOutcome[] }>({
    queryKey: ["cancel-outcomes"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/scanner/cancel-outcomes`, {
        headers: authHeader,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ outcomes: CancelOutcome[] }>;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });

  const { data: aggData } = useQuery<{ rows: AggregateRow[] }>({
    queryKey: ["cancel-outcomes-aggregate"],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/scanner/cancel-outcomes/aggregate`,
        { headers: authHeader },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ rows: AggregateRow[] }>;
    },
    refetchInterval: 10 * 60_000,
    staleTime: 5 * 60_000,
  });

  const { data: weeklyData } = useQuery<{ snapshots: WeeklySnapshot[] }>({
    queryKey: ["cancel-outcomes-weekly"],
    queryFn: async () => {
      const res = await fetch(
        `${API_BASE}/api/scanner/cancel-outcomes/weekly-snapshots`,
        { headers: authHeader },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ snapshots: WeeklySnapshot[] }>;
    },
    refetchInterval: 60 * 60_000,
    staleTime: 30 * 60_000,
  });

  const outcomes = data?.outcomes ?? [];
  const aggRows = aggData?.rows ?? [];
  const weeklySnapshots = weeklyData?.snapshots ?? [];

  // Unique cancel reasons for filter buttons (sorted by frequency)
  const reasons = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of outcomes) {
      counts.set(o.cancel_reason, (counts.get(o.cancel_reason) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }, [outcomes]);

  // Top 3 reasons for summary cards (most frequent)
  const topReasons = reasons.slice(0, 3);

  const visible =
    filter === "all"
      ? outcomes
      : outcomes.filter((o) => o.cancel_reason === filter);

  return (
    <div className="space-y-6 max-w-7xl">
      {showHeader && (
        <div className="flex items-center gap-3">
          <XCircle className="w-5 h-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Cancel Outcomes</h2>
            <p className="text-xs text-muted-foreground">
              Что случилось с монетой после отмены сигнала — цена через +4ч,
              +8ч, +24ч
            </p>
          </div>
        </div>
      )}

      {/* Aggregate worst-offender card */}
      {aggRows.length > 0 && <WorstOffenderCard rows={aggRows} />}

      {/* Pattern × reason breakdown table */}
      {aggRows.length > 0 && <PatternReasonBreakdownTable rows={aggRows} />}

      {/* 4-week trend sparkline */}
      {weeklySnapshots.length > 0 && (
        <WeeklyTrendCard snapshots={weeklySnapshots} />
      )}

      {/* Summary cards — top 3 cancel reasons */}
      {outcomes.length > 0 && topReasons.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {topReasons.map((reason) => (
            <SummaryCard
              key={reason}
              reason={reason}
              items={outcomes.filter((o) => o.cancel_reason === reason)}
            />
          ))}
        </div>
      )}

      {/* Legend */}
      {outcomes.length > 0 && (
        <div className="text-xs text-muted-foreground bg-muted/20 border border-border rounded px-3 py-2">
          <span className="font-medium text-foreground">Точность</span> —
          процент отмен где цена выросла &lt;3% за 4ч (т.е. отмена была верной и
          сигнал не упустил движение).{" "}
          <span className="text-green-400">+4ч &lt;3%</span> = отмена корректна
          · <span className="text-red-400">+4ч &gt;3%</span> = потенциальная
          ошибка
        </div>
      )}

      {/* Filter buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setFilter("all")}
          className={cn(
            "px-3 py-1.5 rounded text-xs font-medium border transition-colors",
            filter === "all"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
          )}
        >
          Все ({outcomes.length})
        </button>
        {reasons.map((r) => (
          <button
            key={r}
            onClick={() => setFilter(r)}
            className={cn(
              "px-3 py-1.5 rounded text-xs font-medium border transition-colors",
              filter === r
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30",
            )}
          >
            {reasonLabel(r)} (
            {outcomes.filter((o) => o.cancel_reason === r).length})
          </button>
        ))}
        {outcomes.length > 0 && (
          <span className="text-xs text-muted-foreground ml-2">
            Показано: {visible.length}
          </span>
        )}
      </div>

      {/* Loading / error */}
      {isLoading && (
        <div className="text-sm text-muted-foreground py-8 text-center">
          Загрузка…
        </div>
      )}
      {error && (
        <div className="text-sm text-red-400 py-4">Ошибка: {String(error)}</div>
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
                <th className="text-left px-3 py-2.5 font-medium">Причина</th>
                <th className="text-right px-3 py-2.5 font-medium">
                  PnL при отмене
                </th>
                <th className="text-right px-3 py-2.5 font-medium">+4ч</th>
                <th className="text-right px-3 py-2.5 font-medium">+8ч</th>
                <th className="text-right px-3 py-2.5 font-medium">+24ч</th>
                <th className="text-center px-3 py-2.5 font-medium">Верно?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((ev) => {
                const correct =
                  ev.price_4h_pct != null
                    ? isCancelCorrect(ev.price_4h_pct)
                    : null;
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
                          "text-xs font-medium",
                          reasonColor(ev.cancel_reason),
                        )}
                      >
                        {reasonLabel(ev.cancel_reason)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PctCell value={ev.pnl_at_cancel} />
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
                    <td className="px-3 py-2 text-center">
                      {correct === null ? (
                        <span className="text-muted-foreground/40">—</span>
                      ) : correct ? (
                        <span className="text-green-400 font-medium">✓</span>
                      ) : (
                        <span className="text-red-400 font-medium">✗</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !error && outcomes.length === 0 && (
        <div className="text-center py-16 text-muted-foreground space-y-2">
          <XCircle className="w-8 h-8 mx-auto opacity-30" />
          <p className="text-sm">Записей пока нет</p>
          <p className="text-xs max-w-sm mx-auto">
            Данные появятся автоматически при первой отмене сигнала после деплоя
            — stale_cancel, smart_cancel или no_price_30m.
          </p>
        </div>
      )}

      {/* Unused imports suppressor */}
      {false && <TrendingUp />}
    </div>
  );
}

export default CancelOutcomesPanel;
